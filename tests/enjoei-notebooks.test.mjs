import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeEnjoeiNotebookSnapshot,
  enrichMissingDetails,
  isTruncatedPage,
} from "../scripts/monitor-enjoei-notebooks.mjs";

const RANGE = { priceMin: 1500, priceMax: 8000 };
const prevItem = (over) => ({
  id: "x", title: "Notebook", price_brl: 5000, status: "active",
  first_seen: "2026-06-10", last_seen: "2026-06-20", cpu_terms: ["ryzen 7 8845h"],
  ...over,
});
const byId = (snapshot, id) => snapshot.items.find((i) => i.id === id);

// ── Cobertura por termo (merge) ───────────────────────────────────────────────

test("item de termo que FALHOU permanece active e mantém last_seen", () => {
  const snapshot = mergeEnjoeiNotebookSnapshot({
    runDate: "2026-06-26",
    collected: [],
    previousSnapshot: { items: [prevItem({ id: "A" })] },
    scheduledTerms: ["ryzen 7 8845h"],
    successfulTerms: [],
    failedTerms: ["ryzen 7 8845h"],
    incompleteTerms: [],
    ...RANGE,
  });
  const a = byId(snapshot, "A");
  assert.equal(a.status, "active");
  assert.equal(a.last_seen, "2026-06-20");
  assert.equal(snapshot.run.partial, true);
  assert.equal(snapshot.run.failed_term_count, 1);
  assert.equal(snapshot.run.successful_term_count, 0);
});

test("item ausente de termo CONCLUÍDO vira not_seen", () => {
  const snapshot = mergeEnjoeiNotebookSnapshot({
    runDate: "2026-06-26",
    collected: [],
    previousSnapshot: { items: [prevItem({ id: "B" })] },
    scheduledTerms: ["ryzen 7 8845h"],
    successfulTerms: ["ryzen 7 8845h"],
    failedTerms: [],
    incompleteTerms: [],
    ...RANGE,
  });
  assert.equal(byId(snapshot, "B").status, "not_seen");
  assert.equal(snapshot.run.partial, false);
});

test("item com dois termos (um concluído, um falho) é preservado active", () => {
  const snapshot = mergeEnjoeiNotebookSnapshot({
    runDate: "2026-06-26",
    collected: [],
    previousSnapshot: { items: [prevItem({ id: "C", cpu_terms: ["a", "b"] })] },
    scheduledTerms: ["a", "b"],
    successfulTerms: ["a"],
    failedTerms: ["b"],
    incompleteTerms: [],
    ...RANGE,
  });
  const c = byId(snapshot, "C");
  assert.equal(c.status, "active");
  assert.equal(c.last_seen, "2026-06-20");
});

test("arrays de cobertura e contagens são gravados corretamente", () => {
  const snapshot = mergeEnjoeiNotebookSnapshot({
    runDate: "2026-06-26",
    collected: [],
    previousSnapshot: { items: [] },
    scheduledTerms: ["a", "b", "c"],
    successfulTerms: ["a"],
    failedTerms: ["b"],
    incompleteTerms: ["c"],
    ...RANGE,
  });
  assert.deepEqual(snapshot.run.scheduled_coverage, ["a", "b", "c"]);
  assert.deepEqual(snapshot.run.successful_coverage, ["a"]);
  assert.deepEqual(snapshot.run.failed_coverage, ["b", "c"]); // falha ∪ truncado
  assert.deepEqual(snapshot.run.incomplete_coverage, ["c"]);
  assert.equal(snapshot.run.partial, true);
  assert.equal(snapshot.run.successful_term_count, 1);
  assert.equal(snapshot.run.failed_term_count, 1);
  assert.equal(snapshot.run.incomplete_term_count, 1);
});

// ── Falso desaparecimento por falha de enriquecimento (enrichMissingDetails) ──

test("falha no endpoint de detalhes NÃO descarta item já confirmado antes", async () => {
  const items = [{ id: "1", title: "Notebook usado barato", brand: "", cpu_terms: ["ryzen 7 8845h"], price_brl: 4000 }];
  const previousSnapshot = { items: [{ id: "1", cpu_terms: ["ryzen 7 8845h"], cpu: null }] };
  const out = await enrichMissingDetails(items, previousSnapshot, {
    fetchDetails: async () => { throw new Error("HTTP 500"); },
    detailMax: 5,
    cpuTerms: ["ryzen 7 8845h"],
  });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].cpu_terms, ["ryzen 7 8845h"]);
});

test("detailMax esgotado preserva confirmado e descarta item novo não confirmável", async () => {
  const items = [
    { id: "1", title: "Notebook generico", brand: "", cpu_terms: ["ryzen 7 8845h"], price_brl: 4000 },
    { id: "2", title: "Notebook generico", brand: "", cpu_terms: ["ryzen 7 8845h"], price_brl: 4000 },
  ];
  const previousSnapshot = { items: [{ id: "1", cpu_terms: ["ryzen 7 8845h"], cpu: null }] };
  const out = await enrichMissingDetails(items, previousSnapshot, {
    fetchDetails: async () => { throw new Error("não deveria ser chamado"); },
    detailMax: 0,
    cpuTerms: ["ryzen 7 8845h"],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "1");
});

test("mismatch CONCLUSIVO (descrição obtida e nada confere) descarta o item", async () => {
  const items = [{ id: "3", title: "Notebook qualquer", brand: "", cpu_terms: ["ryzen 7 8845h"], price_brl: 4000 }];
  const out = await enrichMissingDetails(items, null, {
    fetchDetails: async () => ({ cpu: null, ram_gb: 8, storage_gb: 256, gpu: null, text: "descricao sem cpu nenhum" }),
    detailMax: 5,
    cpuTerms: ["ryzen 7 8845h"],
  });
  assert.equal(out.length, 0);
});

// ── Cobertura truncada ────────────────────────────────────────────────────────

test("página com exatamente `first` itens é tratada como truncada", () => {
  assert.equal(isTruncatedPage({ edges: [1, 2, 3] }, 3), true);
  assert.equal(isTruncatedPage({ edges: [1, 2] }, 3), false);
  assert.equal(isTruncatedPage({ edges: [1], pageInfo: { hasNextPage: true } }, 30), true);
});
