import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSearchUrl,
  extractMercadoLivreId,
  extractMercadoLivreNotebookSpecs,
  textMatchesAnyTermVariant,
  textMatchesTerm,
} from "../scripts/lib/mercadolivre-monitor.mjs";
import {
  matchesMercadoLivreWatchlist,
  mercadoLivreWatchlists,
} from "../scripts/lib/mercadolivre-watchlists.mjs";
import {
  ML_NOTEBOOK_COLLECTION_MAX_BRL,
  ML_NOTEBOOK_DISPLAY_MAX_BRL,
  isMercadoLivreNotebookDisplayPrice,
} from "../scripts/lib/mercadolivre-notebook-ranges.mjs";
import {
  buildMercadoLivreChanges,
  dedupeMercadoLivreItems,
  mergeMercadoLivreBatch,
  needsMercadoLivreDetail,
  nonNegativeNumber,
} from "../scripts/lib/mercadolivre-production.mjs";

test("nonNegativeNumber: arg ausente usa o fallback (nao zera maxDetails)", () => {
  assert.equal(nonNegativeNumber(null, 8), 8);
  assert.equal(nonNegativeNumber(undefined, 8), 8);
  assert.equal(nonNegativeNumber("", 8), 8);
  assert.equal(nonNegativeNumber("0", 8), 0);   // 0 explícito é respeitado
  assert.equal(nonNegativeNumber("4", 8), 4);
  assert.equal(nonNegativeNumber("-1", 8), 8);  // negativo inválido → fallback
});

test("buildSearchUrl cria uma unica URL de busca", () => {
  assert.equal(
    buildSearchUrl("galaxy buds4 pro"),
    "https://lista.mercadolivre.com.br/galaxy-buds4-pro",
  );
});

test("buildSearchUrl aplica a faixa de preco no servidor", () => {
  assert.equal(
    buildSearchUrl("galaxy buds4 pro", { minPrice: 500, maxPrice: 1000 }),
    "https://lista.mercadolivre.com.br/galaxy-buds4-pro_PriceRange_500BRL-1000BRL_NoIndex_True",
  );
});

test("buildSearchUrl aplica envio local a qualquer busca", () => {
  assert.equal(
    buildSearchUrl("lifefactory", { minPrice: 25, maxPrice: 75, localShipping: true }),
    "https://lista.mercadolivre.com.br/lifefactory_PriceRange_25BRL-75BRL_NoIndex_True_SHIPPING*ORIGIN_10215068",
  );
});

test("buildSearchUrl aplica categoria masculina e tamanho 42", () => {
  assert.equal(
    buildSearchUrl("vibram", {
      minPrice: 0,
      maxPrice: 500,
      categoryPath: "calcados-roupas-bolsas/calcados/masculino",
      filterSuffixes: ["FILTRABLE*SIZE_12189541_NoIndex_True"],
      localShipping: true,
    }),
    "https://lista.mercadolivre.com.br/calcados-roupas-bolsas/calcados/masculino/vibram_PriceRange_0BRL-500BRL_NoIndex_True_FILTRABLE*SIZE_12189541_NoIndex_True_SHIPPING*ORIGIN_10215068",
  );
});

test("extractMercadoLivreId aceita ID com hifen", () => {
  assert.equal(
    extractMercadoLivreId("https://produto.mercadolivre.com.br/MLB-1234567890-item"),
    "MLB1234567890",
  );
});

test("extractMercadoLivreId retorna null sem ID", () => {
  assert.equal(extractMercadoLivreId("https://www.mercadolivre.com.br/p/ABC123"), null);
});

test("extractMercadoLivreId prefere o ID da oferta ao ID de catalogo", () => {
  assert.equal(
    extractMercadoLivreId("https://www.mercadolivre.com.br/p/MLB12345678?wid=MLB9876543210"),
    "MLB9876543210",
  );
});

test("extractMercadoLivreId reconhece item_id codificado em link patrocinado", () => {
  assert.equal(
    extractMercadoLivreId("https://click1.mercadolivre.com.br/x?pdp_filters=SHIPPING_ORIGIN%3A10215068%7Citem_id%3AMLB5537546944"),
    "MLB5537546944",
  );
});

test("extrai RAM e SSD dos campos nomeados da ficha tecnica", () => {
  assert.deepEqual(
    extractMercadoLivreNotebookSpecs([
      "Linha de placa gráfica dedicadaRTX",
      "Modelo de placa gráfica dedicada4060",
      "Capacidade de disco SSD512 GB",
      "Capacidade total do módulo de memória RAM16 GB",
      "Memória de vídeo8 GB",
      "Modelo do processador12900HX",
    ]),
    { ram: 16, storage: 512, gpu: "RTX 4060", cpuModel: "12900HX" },
  );
});

test("converte SSD em TB e ignora numeros de outros campos", () => {
  assert.deepEqual(
    extractMercadoLivreNotebookSpecs([
      "Capacidade máxima suportada da memória RAM64 GB",
      "Capacidade de disco SSD1 TB",
      "Modelo alfanumérico52224",
    ]),
    { ram: null, storage: 1024, gpu: null, cpuModel: null },
  );
});

test("extrai modelo completo de GPU quando linha e modelo ja vem juntos", () => {
  assert.deepEqual(
    extractMercadoLivreNotebookSpecs([
      "Linha de placa gráfica dedicadaGeForce RTX",
      "Modelo de placa gráfica dedicadaRTX 4070",
    ]),
    { ram: null, storage: null, gpu: "RTX 4070", cpuModel: null },
  );
});

test("combina marca, linha e modelo de GPU integrada", () => {
  assert.deepEqual(
    extractMercadoLivreNotebookSpecs([
      "Marca de placa gráfica integradaintel",
      "Linha de placa gráfica integradaArc",
      "Modelo de placa gráfica integradaGraphics",
    ]),
    { ram: null, storage: null, gpu: "Intel Arc integrada", cpuModel: null },
  );
});

test("matching aceita variacoes de Buds4 Pro", () => {
  const variants = ["galaxy buds4 pro", "buds4 pro", "buds 4 pro", "buds4pro"];
  assert.equal(textMatchesAnyTermVariant("Samsung Galaxy Buds4 Pro preto", variants), true);
  assert.equal(textMatchesAnyTermVariant("Fone Samsung Buds 4 Pro branco", variants), true);
  assert.equal(textMatchesAnyTermVariant("Samsung Buds4Pro original", variants), true);
});

test("matching rejeita modelos proximos", () => {
  const variants = ["galaxy buds4 pro", "buds4 pro", "buds 4 pro", "buds4pro"];
  assert.equal(textMatchesAnyTermVariant("Samsung Galaxy Buds4 preto", variants), false);
  assert.equal(textMatchesAnyTermVariant("Samsung Galaxy Buds3 Pro branco", variants), false);
  assert.equal(textMatchesAnyTermVariant("Samsung Galaxy Buds 2 Pro", variants), false);
});

test("todas as watchlists do Mercado Livre tem faixa e detalhes relevantes", () => {
  assert.ok(mercadoLivreWatchlists.length >= 6);
  for (const watchlist of mercadoLivreWatchlists) {
    assert.ok(watchlist.terms.length > 0);
    assert.ok(Number.isFinite(watchlist.minPrice));
    assert.ok(Number.isFinite(watchlist.maxPrice));
    assert.ok(watchlist.relevantDetails.length > 0);
  }
});

test("Lifefactory respeita capacidade e exclui mamadeira", () => {
  const config = mercadoLivreWatchlists.find((item) => item.id === "lifefactory");
  assert.equal(matchesMercadoLivreWatchlist({ title: "Garrafa Lifefactory 650 ml" }, config), true);
  assert.equal(matchesMercadoLivreWatchlist({ title: "Mamadeira Lifefactory 250 ml" }, config), false);
  assert.equal(matchesMercadoLivreWatchlist({ title: "Garrafa Lifefactory 350 ml" }, config), false);
});

test("Melanger rejeita 220V puro e aceita bivolt", () => {
  const config = mercadoLivreWatchlists.find((item) => item.id === "melanger");
  assert.equal(matchesMercadoLivreWatchlist({ title: "Melanger 5 kg 220V" }, config), false);
  assert.equal(matchesMercadoLivreWatchlist({ title: "Melanger de chocolate 5 kg bivolt 110/220V" }, config), true);
});

test("notebooks coletam ate 10 mil mas o painel mostra ate 8 mil", () => {
  assert.equal(ML_NOTEBOOK_COLLECTION_MAX_BRL, 10000);
  assert.equal(ML_NOTEBOOK_DISPLAY_MAX_BRL, 8000);
  assert.equal(isMercadoLivreNotebookDisplayPrice(8000), true);
  assert.equal(isMercadoLivreNotebookDisplayPrice(8001), false);
  assert.equal(isMercadoLivreNotebookDisplayPrice(10000), false);
});

test("deduplicacao une resultado patrocinado e oferta direta pelo ID", () => {
  const items = dedupeMercadoLivreItems([
    {
      url: "https://click1.mercadolivre.com.br/x?pdp_filters=item_id%3AMLB5537546944",
      title: "Notebook patrocinado",
      price_brl: 7000,
      terms: ["14700hx"],
    },
    {
      url: "https://produto.mercadolivre.com.br/MLB-5537546944-notebook-_JM",
      title: "Notebook direto",
      price_brl: 7000,
      terms: ["14700hx", "i7 14700hx"],
    },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "MLB5537546944");
  assert.match(items[0].url, /produto\.mercadolivre/);
  assert.deepEqual(items[0].terms, ["14700hx", "i7 14700hx"]);
});

test("falha parcial preserva itens do termo que nao foi concluido", () => {
  const previous = {
    items: [{
      id: "MLB1",
      title: "Notebook",
      price_brl: 7000,
      terms: ["14700hx"],
      status: "active",
      first_seen: "2026-06-12",
      last_seen: "2026-06-12",
    }],
  };
  const snapshot = mergeMercadoLivreBatch({
    previous,
    collected: [],
    successfulTerms: [],
    failedTerms: ["14700hx"],
    now: new Date("2026-06-13T12:00:00Z"),
    minPrice: 2000,
    maxPrice: 10000,
    displayMinPrice: 2000,
    displayMaxPrice: 8000,
    run: {},
  });
  assert.equal(snapshot.items[0].status, "active");
  assert.equal(snapshot.items[0].last_seen, "2026-06-12");
});

test("execucao seletiva preserva itens de termos nao programados", () => {
  const previous = {
    items: [{
      id: "MLB-OUTRO",
      title: "Notebook 14900HX",
      price_brl: 9000,
      terms: ["14900hx"],
      status: "active",
      first_seen: "2026-06-12",
      last_seen: "2026-06-12",
    }],
  };
  const snapshot = mergeMercadoLivreBatch({
    previous,
    collected: [],
    successfulTerms: ["14700hx"],
    failedTerms: [],
    scheduledTerms: ["14700hx"],
    allTerms: ["14700hx", "14900hx"],
    now: new Date("2026-06-13T12:00:00Z"),
    minPrice: 2000,
    maxPrice: 10000,
    displayMinPrice: 2000,
    displayMaxPrice: 8000,
    run: {},
  });
  assert.equal(snapshot.items[0].status, "active");
  assert.equal(snapshot.items[0].last_seen, "2026-06-12");
});

test("execucao completa marca como nao visto item ausente de termo concluido", () => {
  const previous = {
    items: [{
      id: "MLB-AUSENTE",
      title: "Notebook 14700HX",
      price_brl: 7000,
      terms: ["14700hx"],
      status: "active",
      first_seen: "2026-06-12",
      last_seen: "2026-06-12",
    }],
  };
  const snapshot = mergeMercadoLivreBatch({
    previous,
    collected: [],
    successfulTerms: ["14700hx"],
    failedTerms: [],
    scheduledTerms: ["14700hx"],
    allTerms: ["14700hx"],
    now: new Date("2026-06-13T12:00:00Z"),
    minPrice: 2000,
    maxPrice: 10000,
    displayMinPrice: 2000,
    displayMaxPrice: 8000,
    run: {},
  });
  assert.equal(snapshot.items[0].status, "not_seen");
});

test("ficha generica volta a abrir quando falta detalhe mesmo com condicao conhecida", () => {
  assert.equal(needsMercadoLivreDetail(
    { id: "MLB-DETALHE" },
    {
      details_checked_at: "2026-06-12T12:00:00Z",
      title: "Melanger usado",
      condition: "Usado",
      specs: ["Marca: Premier"],
      description: "",
    },
    "product",
    ["marca", "capacidade", "voltagem", "condicao"],
  ), true);
});

test("ficha generica completa nao volta a abrir", () => {
  assert.equal(needsMercadoLivreDetail(
    { id: "MLB-COMPLETO" },
    {
      details_checked_at: "2026-06-12T12:00:00Z",
      title: "Melanger usado",
      condition: "Usado",
      specs: ["Marca: Premier", "Capacidade: 5 kg", "Voltagem: 127 V"],
      description: "",
    },
    "product",
    ["marca", "capacidade", "voltagem", "condicao"],
  ), false);
});

test("queda de 8-10 mil para ate 8 mil gera entrada na faixa", () => {
  const previous = {
    items: [{ id: "MLB2", price_brl: 8500, status: "active" }],
  };
  const current = {
    items: [{ id: "MLB2", title: "Notebook", price_brl: 7900, status: "active" }],
  };
  const changes = buildMercadoLivreChanges(previous, current, {
    displayMinPrice: 2000,
    displayMaxPrice: 8000,
  });
  assert.equal(changes.priceChanges.length, 1);
  assert.equal(changes.enteredDisplayRange.length, 1);
  assert.equal(changes.enteredDisplayRange[0].previous_price_brl, 8500);
});

test("reaparecimento no Mercado Livre nao volta a ser novo", () => {
  const changes = buildMercadoLivreChanges(
    { items: [{ id: "MLB-RETORNO", price_brl: 700, status: "not_seen" }] },
    { items: [{ id: "MLB-RETORNO", title: "Buds4 Pro", price_brl: 700, status: "active" }] },
    { displayMinPrice: 500, displayMaxPrice: 1000 },
  );
  assert.equal(changes.newItems.length, 0);
});

test("Galaxy Buds4 Pro faz parte das watchlists oficiais", () => {
  const config = mercadoLivreWatchlists.find((item) => item.id === "galaxy-buds4-pro");
  assert.ok(config);
  assert.deepEqual(config.matchVariants, [
    "galaxy buds4 pro",
    "buds4 pro",
    "buds 4 pro",
    "buds4pro",
  ]);
  assert.equal(config.minPrice, 500);
  assert.equal(config.maxPrice, 1000);
  assert.equal(config.searchOptions.localShipping, true);
});
