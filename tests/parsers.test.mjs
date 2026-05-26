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
  textContainsCpuTerm,
  has32GbRam,
  isNotebookCategoryUrl,
  extractOlxId,
} from "../scripts/lib/parsers.mjs";

import { mergeWithPreviousSnapshot } from "../scripts/lib/snapshot.mjs";
import { parseReport } from "../scripts/generate-dashboard.mjs";

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

// ── extractRamGb ──────────────────────────────────────────────────────────────

describe("extractRamGb", () => {
  test("16gb RAM", () => assert.equal(extractRamGb("Notebook 16gb RAM 512GB SSD"), 16));
  test("32 GB DDR5", () => assert.equal(extractRamGb("32 GB DDR5 2TB SSD"), 32));
  test("RAM: 8 GB", () => assert.equal(extractRamGb("RAM: 8 GB, i7-13620H"), 8));
  test("memória 8 GB de memória", () => assert.equal(extractRamGb("8 GB de memória"), 8));
  test("prefixo memória", () => assert.equal(extractRamGb("memória 16gb"), 16));
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
  test("RAM sozinha não é storage", () => assert.equal(extractStorageGb("16GB RAM"), null));
  test("string vazia retorna null", () => assert.equal(extractStorageGb(""), null));
  test("null retorna null", () => assert.equal(extractStorageGb(null), null));
});

// ── textContainsCpuTerm ───────────────────────────────────────────────────────

describe("textContainsCpuTerm", () => {
  test("termo exato com hífen no texto", () =>
    assert.equal(textContainsCpuTerm("Intel Core i7-13620H notebook", "13620h"), true));
  test("espaço entre sufixo normalizado", () =>
    assert.equal(textContainsCpuTerm("Intel Core i7 14650 HX laptop", "14650hx"), true));
  test("termo ausente", () =>
    assert.equal(textContainsCpuTerm("Intel Core i7-13620H notebook", "13650hx"), false));
  test("ai7350 — variante com espaços", () =>
    assert.equal(textContainsCpuTerm("Ryzen AI 7 350 laptop", "ai7350"), true));
  test("ai7350 — variante compacta", () =>
    assert.equal(textContainsCpuTerm("ryzenai7350", "ai7350"), true));
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

  test("item ausente nesta rodada — status = not_seen", () => {
    const prev = { ...base, first_seen: "2026-05-20", last_seen: "2026-05-24" };
    const { items } = mergeWithPreviousSnapshot({
      runDate: "2026-05-25",
      collected: [],
      previousSnapshot: { items: [prev] },
    });
    assert.equal(items[0].status, "not_seen");
    assert.equal(items[0].last_seen, "2026-05-25");
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
`.trim();

  test("newCount — OLX report", () => assert.equal(parseReport(olxReport).newCount, 3));
  test("priceCount — OLX report", () => assert.equal(parseReport(olxReport).priceCount, 2));
  test("date — extraído do cabeçalho", () => assert.equal(parseReport(olxReport).date, "2026-05-24"));
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
});
