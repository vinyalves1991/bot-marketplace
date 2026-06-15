/**
 * Unit tests for pure utility functions.
 * Run with: node --test tests/parsers.test.mjs
 * (or via: npm test)
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  parseBrlPrice,
  extractRamGb,
  extractStorageGb,
  extractGpuLabel,
  extractCpuLabel,
  textContainsCpuTerm,
  has32GbRam,
  isNotebookCategoryUrl,
  extractOlxId,
} from "../scripts/lib/parsers.mjs";

import { mergeWithPreviousSnapshot } from "../scripts/lib/snapshot.mjs";
import { formatRunLabelFromFile, parseReport, summarizeMachine } from "../scripts/generate-dashboard.mjs";

// ── parseBrlPrice ─────────────────────────────────────────────────────────────

describe("parseBrlPrice", () => {
  test("formato padrão com centavos", () => assert.equal(parseBrlPrice("R$ 3.500,00"), 3500));
  test("sem centavos", () => assert.equal(parseBrlPrice("R$ 3.500"), 3500));
  test("sem espaço e sem separador de milhar", () => assert.equal(parseBrlPrice("R$3500"), 3500));
  test("valor alto com dois separadores", () => assert.equal(parseBrlPrice("R$ 15.899,00"), 15899));
  test("string vazia retorna null", () => assert.equal(parseBrlPrice(""), null));
  test("sem símbolo retorna null", () => assert.equal(parseBrlPrice("3500"), null));
  test("null retorna null", () => assert.equal(parseBrlPrice(null), null));
  test("texto sem preço retorna null", () => assert.equal(parseBrlPrice("sem preço"), null));
});

describe("summarizeMachine", () => {
  test("remove termos genericos e mantem a configuracao principal", () => {
    assert.deepEqual(
      summarizeMachine("notebook lenovo ideapad slim 3 i5-13420h 16gb ddr5 4800mhz 512 ssd nvme — 16 GB RAM / 512 GB — cpu: 13620h"),
      {
        brand: "Lenovo",
        model: "Ideapad Slim 3",
        cpu: "I5-13420H",
        ram: "16 GB",
        ssd: "512 GB",
        gpu: null,
      },
    );
  });

  test("identifica linhas gamer sem deixar palavras promocionais no modelo", () => {
    assert.deepEqual(
      summarizeMachine("notebook gamer loq essential - 16 gb ram - rtx 3050 - intel core i5-12450hx — 16 GB RAM / armazenamento n/d — cpu: 13450hx"),
      {
        brand: "Lenovo",
        model: "LOQ Essential",
        cpu: "I5-12450HX",
        ram: "16 GB",
        ssd: "n/d",
        gpu: "RTX 3050",
      },
    );
  });

  test("infere SSD solto e placa de video dedicada", () => {
    assert.deepEqual(
      summarizeMachine("notebook dell g15 5530 i5-13450h rtx3050 512gb cinza-grafite — RAM n/d / armazenamento n/d — cpu: 13450hx"),
      {
        brand: "Dell",
        model: "G15 5530",
        cpu: "I5-13450H",
        ram: "n/d",
        ssd: "512 GB",
        gpu: "RTX 3050",
      },
    );
  });

  test("mantem desconhecido quando marca ou GPU nao aparecem", () => {
    assert.deepEqual(
      summarizeMachine("notebook premium de 14\" com tela oled 3.2k ultra 7 255h, 32gb de ram e 1tb de ssd — 32 GB RAM / 1024 GB — cpu: 255hx"),
      {
        brand: "n/d",
        model: "n/d",
        cpu: "Ultra 7 255H",
        ram: "32 GB",
        ssd: "1 TB",
        gpu: null,
      },
    );
  });
});

// ── extractRamGb ──────────────────────────────────────────────────────────────

test("summarizeMachine identifica Ryzen AI 7 350 sem deixar CPU no modelo", () => {
  assert.deepEqual(
    summarizeMachine("ASUS Zenbook 14 OLED - 32GB RAM - Touch - Ryzen AI 7 350 (ai7350) — 32 GB RAM / 1024 GB / GPU n/d"),
    {
      brand: "Asus",
      model: "Zenbook 14 Touch",
      cpu: "Ryzen AI 7 350",
      ram: "32 GB",
      ssd: "1.024 GB",
      gpu: null,
    },
  );
});

test("summarizeMachine identifica Core Ultra i7 no titulo e Intel Arc no detalhe", () => {
  assert.deepEqual(
    summarizeMachine(
      'Notebook Asus ZenBook 14, Intel Core Ultra i7-155H, 16GB/1TB SSD, Tela 14", Win11 - UX3405 — 16 GB RAM / 1024 GB / GPU Intel Arc integrada — https://sc.olx.com.br/notebooks/asus-1',
    ),
    {
      brand: "Asus",
      model: "Zenbook 14 UX3405",
      cpu: "Ultra 7 155H",
      ram: "16 GB",
      ssd: "1 TB",
      gpu: "Intel Arc integrada",
    },
  );
});

describe("extractGpuLabel", () => {
  test("Intel Arc Graphics integrada", () =>
    assert.equal(extractGpuLabel("Graficos: Intel Arc Graphics integrada"), "Intel Arc integrada"));
  test("GeForce RTX com prefixo", () =>
    assert.equal(extractGpuLabel("Placa de video NVIDIA GeForce RTX 3050 6GB"), "RTX 3050"));
  test("sem GPU retorna null", () => assert.equal(extractGpuLabel("Notebook com video integrado"), null));
});

describe("extractRamGb", () => {
  test("16gb RAM", () => assert.equal(extractRamGb("Notebook 16gb RAM 512GB SSD"), 16));
  test("32 GB DDR5", () => assert.equal(extractRamGb("32 GB DDR5 2TB SSD"), 32));
  test("RAM: 8 GB", () => assert.equal(extractRamGb("RAM: 8 GB, i7-13620H"), 8));
  test("detalhe OLX em linhas separadas", () => assert.equal(extractRamGb("Memoria RAM\n16 Gb"), 16));
  test("memória 8 GB de memória", () => assert.equal(extractRamGb("8 GB de memória"), 8));
  test("prefixo memória", () => assert.equal(extractRamGb("memória 16gb"), 16));
  test("descrição Enjoei 8gb de ram", () => assert.equal(extractRamGb("processador i5-13450hx, 8gb de ram e rtx 3050"), 8));
  test("título Enjoei 16gb antes de 512gb ssd", () => assert.equal(extractRamGb("i5-12450hx 16gb 512gb ssd rtx 3050"), 16));
  test("título ML 16gb antes de 1tb ssd (armazenamento em TB)", () => assert.equal(extractRamGb("Notebook Dell Alienware M16 i9-13900hx 16gb 1tb ssd rtx4060"), 16));
  test("256gb + 1tb não vira RAM (SSD + HD)", () => assert.equal(extractRamGb("256gb 1tb hd"), null));
  test("SSD sozinho não é RAM", () => assert.equal(extractRamGb("512GB SSD"), null));
  test("string vazia retorna null", () => assert.equal(extractRamGb(""), null));
  test("null retorna null", () => assert.equal(extractRamGb(null), null));
  test("1 GB está fora do intervalo", () => assert.equal(extractRamGb("1gb RAM"), null));
});

// ── extractStorageGb ──────────────────────────────────────────────────────────

describe("extractStorageGb", () => {
  test("512GB SSD", () => assert.equal(extractStorageGb("512GB SSD"), 512));
  test("1 TB", () => assert.equal(extractStorageGb("1 TB"), 1024));
  test("2TB", () => assert.equal(extractStorageGb("2TB SSD"), 2048));
  test("1,5 TB com vírgula", () => assert.equal(extractStorageGb("1,5 TB"), Math.round(1.5 * 1024)));
  test("256 GB nvme", () => assert.equal(extractStorageGb("256 GB nvme"), 256));
  test("512 SSD sem unidade explícita", () => assert.equal(extractStorageGb("Notebook 512 SSD"), 512));
  test("SSD 512 GB (ordem invertida)", () => assert.equal(extractStorageGb("SSD 512 GB"), 512));
  test("armazenamento OLX em linhas separadas", () => assert.equal(extractStorageGb("Armazenamento\n480 Gb"), 480));
  test("477gb de armazenamento (descrição Enjoei)", () =>
    assert.equal(extractStorageGb("16gb de ram e 477gb de armazenamento"), 477));
  test("RAM sozinha não é storage", () => assert.equal(extractStorageGb("16GB RAM"), null));
  test("string vazia retorna null", () => assert.equal(extractStorageGb(""), null));
  test("null retorna null", () => assert.equal(extractStorageGb(null), null));
});

// ── extractCpuLabel ───────────────────────────────────────────────────────────

describe("extractCpuLabel", () => {
  test("Core Ultra 7 155H em descrição", () =>
    assert.equal(
      extractCpuLabel("notebook samsung galaxy book4 pro, com processador intel core ultra 7 155h"),
      "Ultra 7 155H"
    ));
  test("i5-13420H", () => assert.equal(extractCpuLabel("Notebook Dell i5-13420H"), "I5-13420H"));
  test("Ryzen AI 7 350", () => assert.equal(extractCpuLabel("Asus Ryzen AI 7 350"), "Ryzen AI 7 350"));
  test("Ryzen AI Max+ 395", () => assert.equal(extractCpuLabel("ROG Flow Z13 Ryzen AI Max+ 395"), "Ryzen AI Max 395"));
  test("Ryzen AI Max PRO 390", () => assert.equal(extractCpuLabel("Notebook Ryzen AI Max PRO 390"), "Ryzen AI Max 390"));
  test("HX 470", () => assert.equal(extractCpuLabel("Notebook Ryzen AI 9 HX 470"), "HX 470"));
  test("sem CPU retorna null", () => assert.equal(extractCpuLabel("notebook samsung galaxy book4 pro"), null));
  test("null retorna null", () => assert.equal(extractCpuLabel(null), null));
});

// ── textContainsCpuTerm ───────────────────────────────────────────────────────

describe("textContainsCpuTerm", () => {
  test("termo exato com hífen no texto", () =>
    assert.equal(textContainsCpuTerm("Intel Core i7-13620H notebook", "13620h"), true));
  test("espaço entre sufixo normalizado", () =>
    assert.equal(textContainsCpuTerm("Intel Core i7 14650 HX laptop", "14650hx"), true));
  test("termo ausente", () =>
    assert.equal(textContainsCpuTerm("Intel Core i7-13620H notebook", "13650hx"), false));
  test("aimax395 — Ryzen AI Max+ 395", () =>
    assert.equal(textContainsCpuTerm("ROG Flow Z13 Ryzen AI Max+ 395 32GB", "aimax395"), true));
  test("aimax395 — variante PRO casa no mesmo termo", () =>
    assert.equal(textContainsCpuTerm("HP ZBook Ultra Ryzen AI Max+ PRO 395", "aimax395"), true));
  test("aimax390 — Ryzen AI Max PRO 390", () =>
    assert.equal(textContainsCpuTerm("Notebook Ryzen AI Max PRO 390", "aimax390"), true));
  test("aimax395 NÃO casa com 390", () =>
    assert.equal(textContainsCpuTerm("Ryzen AI Max PRO 390 notebook", "aimax395"), false));
  test("hx470 — Ryzen AI 9 HX 470", () =>
    assert.equal(textContainsCpuTerm("Notebook Ryzen AI 9 HX 470 16GB", "hx470"), true));
  test("8845hs case-insensitive", () =>
    assert.equal(textContainsCpuTerm("Ryzen 9 8845HS gaming", "8845hs"), true));
  test("string vazia retorna false", () =>
    assert.equal(textContainsCpuTerm("", "13620h"), false));
  // regressões de falsos positivos
  test("165hz NÃO deve casar com CPU 165h", () =>
    assert.equal(textContainsCpuTerm("monitor gamer pichau centauri quad hd 165hz freesync", "165h"), false));
  test("165H em notebook deve casar com CPU 165h", () =>
    assert.equal(textContainsCpuTerm("Notebook MSI Intel Core Ultra 5 165H 16GB", "165h"), true));
  test("7945hx3d NÃO deve casar com termo 7945hx", () =>
    assert.equal(textContainsCpuTerm("AMD Ryzen 9 7945HX3D notebook", "7945hx"), false));
  test("7945hx sem sufixo deve casar com termo 7945hx", () =>
    assert.equal(textContainsCpuTerm("Asus ROG 7945HX 32GB gaming", "7945hx"), true));
  // regressões de falso positivo do Enjoei (CPU próxima, mas diferente)
  test("13420H NÃO deve casar com termo 13620h", () =>
    assert.equal(textContainsCpuTerm("notebook lenovo ideapad slim 3 i5-13420h 16gb", "13620h"), false));
  test("12450HX NÃO deve casar com termo 13450hx", () =>
    assert.equal(textContainsCpuTerm("notebook acer loq i5-12450hx rtx 3050", "13450hx"), false));
  test("12500H NÃO deve casar com termo 12700h", () =>
    assert.equal(textContainsCpuTerm("notebook dell g15 i5 12500h rtx 3050", "12700h"), false));
  test("275HX NÃO deve casar com termo 255hx (modelo diferente)", () =>
    assert.equal(textContainsCpuTerm("rog strix scar 16 ultra 9-275hx 32gb", "255hx"), false));
  // Intel Ultra HX: sufixo opcional (política "pegar tudo, inclusive variante H")
  test("Ultra 9 285 (sem sufixo) casa com 285hx", () =>
    assert.equal(textContainsCpuTerm("notebook pro max intel core ultra 9 285 64gb", "285hx"), true));
  test("Ultra 9 285H casa com 285hx (variante H aceita)", () =>
    assert.equal(textContainsCpuTerm("notebook ultra 9 285h 32gb", "285hx"), true));
  test("Ultra 9 285HX casa com 285hx", () =>
    assert.equal(textContainsCpuTerm("notebook ultra 9 285hx", "285hx"), true));
  test("Ultra 7 255H casa com 255hx (variante H aceita)", () =>
    assert.equal(textContainsCpuTerm("notebook ultra 7 255h 32gb 1tb", "255hx"), true));
  test("285 solto SEM 'ultra' NÃO casa com 285hx", () =>
    assert.equal(textContainsCpuTerm("notebook gamer por R$ 285 modelo 285", "285hx"), false));
});

// ── has32GbRam ────────────────────────────────────────────────────────────────

describe("has32GbRam", () => {
  test("ram_gb = 32", () => assert.equal(has32GbRam({ ram_gb: 32 }), true));
  test("ram_gb = 64", () => assert.equal(has32GbRam({ ram_gb: 64 }), true));
  test("ram_gb = 16", () => assert.equal(has32GbRam({ ram_gb: 16 }), false));
  test("ram_gb null, título tem 32GB", () =>
    assert.equal(has32GbRam({ ram_gb: null, title: "Notebook 32GB RAM DDR5" }), true));
  test("ram_gb null, título tem 16GB", () =>
    assert.equal(has32GbRam({ ram_gb: null, title: "Notebook 16GB RAM" }), false));
  test("ram_gb null, sem título", () =>
    assert.equal(has32GbRam({ ram_gb: null, title: "" }), false));
});

// ── isNotebookCategoryUrl ─────────────────────────────────────────────────────

describe("isNotebookCategoryUrl", () => {
  test("URL de notebook OLX", () =>
    assert.equal(
      isNotebookCategoryUrl("https://sp.olx.com.br/sao-paulo/informatica/notebooks/lenovo-1504621695"),
      true,
    ));
  test("URL de tablet OLX", () =>
    assert.equal(
      isNotebookCategoryUrl("https://sp.olx.com.br/eletronicos/tablets/tablet-123"),
      false,
    ));
  test("string inválida retorna false", () => assert.equal(isNotebookCategoryUrl("not-a-url"), false));
  test("string vazia retorna false", () => assert.equal(isNotebookCategoryUrl(""), false));
});

// ── extractOlxId ─────────────────────────────────────────────────────────────

describe("extractOlxId", () => {
  test("ID de 10 dígitos no final da URL", () =>
    assert.equal(extractOlxId("https://sp.olx.com.br/notebooks/lenovo-1504621695"), "1504621695"));
  test("ID seguido de query string", () =>
    assert.equal(extractOlxId("https://sp.olx.com.br/notebooks/lenovo-1504621695?pos=1"), "1504621695"));
  test("número curto (< 8 dígitos) retorna null", () =>
    assert.equal(extractOlxId("https://sp.olx.com.br/notebooks/lenovo-123"), null));
  test("string vazia retorna null", () => assert.equal(extractOlxId(""), null));
});

// ── mergeWithPreviousSnapshot ─────────────────────────────────────────────────

describe("mergeWithPreviousSnapshot", () => {
  const base = { id: "aaa111222333", url: "https://olx.com/aaa111222333", title: "NB Test", price_brl: 3000, status: "active" };

  test("sem snapshot anterior — first_seen = runDate", () => {
    const { items } = mergeWithPreviousSnapshot({
      runDate: "2026-05-25",
      collected: [base],
      previousSnapshot: null,
    });
    assert.equal(items[0].first_seen, "2026-05-25");
    assert.equal(items[0].last_seen, "2026-05-25");
  });

  test("item já visto — preserva first_seen, atualiza last_seen", () => {
    const prev = { ...base, first_seen: "2026-05-20", last_seen: "2026-05-24" };
    const { items } = mergeWithPreviousSnapshot({
      runDate: "2026-05-25",
      collected: [base],
      previousSnapshot: { items: [prev] },
    });
    assert.equal(items[0].first_seen, "2026-05-20");
    assert.equal(items[0].last_seen, "2026-05-25");
    assert.equal(items[0].status, "active");
  });

  test("item ausente nesta rodada — status = not_seen, last_seen preservado", () => {
    const prev = { ...base, first_seen: "2026-05-20", last_seen: "2026-05-24" };
    const { items } = mergeWithPreviousSnapshot({
      runDate: "2026-05-25",
      collected: [],
      previousSnapshot: { items: [prev] },
    });
    assert.equal(items[0].status, "not_seen");
    // last_seen NÃO é sobrescrito: continua sendo a última vez REALMENTE visto.
    assert.equal(items[0].last_seen, "2026-05-24");
  });

  test("item ausente mas com fonte/termo que falhou — carregado intacto (não not_seen)", () => {
    const prev = { ...base, term: "fitbit air", source: "OLX", first_seen: "2026-05-20", last_seen: "2026-05-24", status: "active" };
    const { items } = mergeWithPreviousSnapshot({
      runDate: "2026-05-25",
      collected: [],
      previousSnapshot: { items: [prev] },
      failedKeys: new Set([prev.id]),
    });
    assert.equal(items[0].status, "active");        // não rebaixado
    assert.equal(items[0].last_seen, "2026-05-24"); // intacto
  });

  test("dois itens: um novo, um não visto", () => {
    const prev = { ...base, id: "old111222333", url: "https://olx.com/old111222333", first_seen: "2026-05-20", last_seen: "2026-05-24" };
    const novo = { ...base, id: "new111222333", url: "https://olx.com/new111222333" };
    const { items } = mergeWithPreviousSnapshot({
      runDate: "2026-05-25",
      collected: [novo],
      previousSnapshot: { items: [prev] },
    });
    const novoItem = items.find((i) => i.id === "new111222333");
    const oldItem  = items.find((i) => i.id === "old111222333");
    assert.equal(novoItem.first_seen, "2026-05-25");
    assert.equal(novoItem.status, "active");
    assert.equal(oldItem.status, "not_seen");
  });

  test("priceMin/priceMax presentes no resultado", () => {
    const { price_range_brl } = mergeWithPreviousSnapshot({
      runDate: "2026-05-25",
      collected: [],
      previousSnapshot: null,
      priceMin: 2000,
      priceMax: 4000,
    });
    assert.deepEqual(price_range_brl, { min: 2000, max: 4000 });
  });
});

// ── parseReport (dashboard) ───────────────────────────────────────────────────

describe("parseReport", () => {
  const olxReport = `
# Monitor OLX notebooks por CPU — 2026-05-24

## Resumo executivo
- Novos anúncios válidos (R$ 2.000–R$ 4.000): **3**
- Anúncios ainda ativos (já vistos) no range: **5**
- Não vistos nesta rodada (sumiram da listagem): **1**
- Alterações de preço detectadas: **2**

## Novos anúncios (R$ 2.000–R$ 4.000)
- R$ 3.199 — Notebook Lenovo i7-13620H — 16 GB RAM / 512 GB — https://sp.olx.com.br/notebooks/lenovo-1
- R$ 3.500 — Notebook Dell i7-13650HX — 16 GB RAM / 512 GB — https://sp.olx.com.br/notebooks/dell-2
- R$ 3.800 — Notebook Acer i7-13620H — 16 GB RAM / 512 GB — https://sp.olx.com.br/notebooks/acer-3

## Mudanças de preço
- R$ 3.500 → R$ 3.199 — Notebook Lenovo Core i7 13620H (13620h) — https://sp.olx.com.br/notebooks/lenovo-1
- R$ 4.200 → R$ 3.900 — Notebook Asus i7-14650HX (14650hx) — https://sp.olx.com.br/notebooks/asus-4
`.trim();

  const enjoeiNbReport = `
# Monitor Enjoei notebooks por CPU — 2026-05-24

## Resumo executivo
- Novos notebooks (R$ 1.500–R$ 4.000): **2**
- Já vistos e ativos: **4**
- Não vistos nesta rodada: **0**
- Alterações de preço: **1**

## Novos notebooks
- R$ 2.000 — Notebook Acer i7-13620H — 16 GB RAM / 512 GB — https://www.enjoei.com.br/p/notebook-acer-1
- R$ 3.000 — Notebook Asus Ryzen 7840HS — 32 GB RAM / 1 TB — https://www.enjoei.com.br/p/notebook-asus-2

## Mudanças de preço
- R$ 3.200,00 → R$ 3.000,00 — Notebook Asus Ryzen 7840HS — https://www.enjoei.com.br/p/notebook-asus-2
`.trim();

  test("newCount — OLX report", () => assert.equal(parseReport(olxReport).newCount, 3));
  test("priceCount — OLX report", () => assert.equal(parseReport(olxReport).priceCount, 2));
  test("date — extraído do cabeçalho", () => assert.equal(parseReport(olxReport).date, "2026-05-24"));
  test("runLabel — timestamp do arquivo convertido para BRT", () =>
    assert.equal(formatRunLabelFromFile("report-2026-05-27T19-01-42-123Z.md", "2026-05-27"), "2026-05-27 16:01"));
  test("runLabel — report premium convertido para BRT", () =>
    assert.equal(formatRunLabelFromFile("report-premium-2026-05-27T10-00-00-000Z.md", "2026-05-27"), "2026-05-27 07:00"));
  test("newCount — Enjoei Notebooks report", () => assert.equal(parseReport(enjoeiNbReport).newCount, 2));
  test("priceCount — Enjoei Notebooks report", () => assert.equal(parseReport(enjoeiNbReport).priceCount, 1));
  test("newItems — Enjoei Notebooks report", () => {
    const { newItems } = parseReport(enjoeiNbReport);
    assert.equal(newItems.length, 2);
    assert.equal(newItems[0].price, "R$ 2.000");
    assert.ok(newItems[0].url?.includes("enjoei.com.br"));
  });
  test("relatório vazio retorna zeros", () => {
    const r = parseReport("# Monitor sem dados\n\n## Resumo\n- Sem itens.");
    assert.equal(r.newCount, 0);
    assert.equal(r.priceCount, 0);
  });
  test("newItems extraídos da seção Novos anúncios", () => {
    const { newItems } = parseReport(olxReport);
    assert.equal(newItems.length, 3);
    assert.ok(newItems[0].price?.startsWith("R$"));
    assert.ok(newItems[0].url?.includes("olx.com.br"));
  });
  test("priceItems extraídos da seção Mudanças de preço", () => {
    const { priceItems } = parseReport(olxReport);
    assert.equal(priceItems.length, 2);
    assert.ok(priceItems[0].priceFrom != null);
    assert.ok(priceItems[0].priceTo != null);
  });

  const olxReportAcima10k = `
# Monitor OLX notebooks por CPU — 2026-06-02

## Resumo executivo
- Novos anúncios válidos (R$ 2.000–R$ 8.000): **1**
- Alterações de preço detectadas: **3**

## Novos anúncios (R$ 2.000–R$ 8.000)
- R$ 7.500 — Notebook Asus i9-13980HX — 32 GB RAM / 1 TB — https://sp.olx.com.br/notebooks/asus-ok

## Mudanças de preço
- R$ 8.000 → R$ 8.499 — Asus ROG Strix G16 (13980hx) — https://sp.olx.com.br/notebooks/asus-8499
- R$ 10.899 → R$ 11.999 — Acer Predator Helios (275hx) — https://sp.olx.com.br/notebooks/acer-12k
- R$ 17.450 → R$ 17.300 — Kit Razer Blade 18 (13950hx) — https://sp.olx.com.br/notebooks/razer-17k
`.trim();

  test("itens acima de R$ 10 mil são filtrados (mudanças de preço)", () => {
    const { priceItems, priceCount } = parseReport(olxReportAcima10k);
    assert.equal(priceCount, 1);
    assert.equal(priceItems.length, 1);
    assert.equal(priceItems[0].priceTo, "R$ 8.499");
  });
  test("itens até R$ 10 mil são mantidos (novos)", () => {
    const { newItems, newCount } = parseReport(olxReportAcima10k);
    assert.equal(newCount, 1);
    assert.equal(newItems[0].price, "R$ 7.500");
  });
});
