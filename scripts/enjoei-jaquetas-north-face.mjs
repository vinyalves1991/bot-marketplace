import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildMonitorChanges,
  mergeMonitorSnapshot,
} from "./lib/monitor-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Alinhado para usar a variável do ambiente e salvar os dados na pasta correta na nuvem
const automationRoot = process.env.JAQUETAS_NORTH_FACE_DATA_DIR ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".codex", "automations", "monitor-enjoei-jaquetas-north-face");

const SEARCH_ENDPOINT = "https://enjusearch.enjoei.com.br/graphql-search-x";
const SITE_ORIGIN = "https://www.enjoei.com.br";

// Termos curtos e diretos para cobrir as variações de buscas de jaquetas North Face
const DEFAULT_TERMS = ["north face p", "jaqueta north face", "the north face p", "north face masculino"];

const args = process.argv.slice(2);
const terms = getTerms();
const department = getOptionValue(args, "--department") ?? "masculino";
const jacketSize = getOptionValue(args, "--size") ?? "P"; // Define o tamanho P por padrão
const shippingRange = getOptionValue(args, "--shipping-range") ?? "same_country";
const state = getOptionValue(args, "--state") ?? "pr";
const city = getOptionValue(args, "--city") ?? "curitiba";
const first = Number(getOptionValue(args, "--first") ?? 30);
const maxPriceBrl = Number(getOptionValue(args, "--max-price") ?? 1200); // Teto de preço ajustado para casacos importados

main().catch((error) => {
  console.error(`\nFalha: ${formatError(error)}`);
  process.exitCode = 1;
});

function formatError(error) {
  if (!error) return "Erro desconhecido (sem detalhes).";
  const message = error.stack || error.message || String(error);
  const cause = error.cause;
  if (!cause) return message;
  const causeMessage = cause.stack || cause.message || String(cause);
  return `${message}\nCausa: ${causeMessage}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const now = new Date();
  const runDate = now.toISOString().slice(0, 10);
  const runTimestamp = now.toISOString();
  const runId = runTimestamp.replace(/[:.]/g, "-");

  const previousSnapshotPath = await getLatestSnapshotPath(automationRoot);
  const previousSnapshot = previousSnapshotPath ? await readJsonSafe(previousSnapshotPath) : null;

  console.log(`Execucao: ${runTimestamp}`);
  console.log(`Buscas: ${terms.join(", ")}`);
  console.log(`Filtro: jaqueta tamanho ${jacketSize}, ${department}, ate R$ ${maxPriceBrl}`);

  const { items: collected, failedTerms } = await collectProducts();
  const snapshot = mergeWithPreviousSnapshot({ now, collected, failedTerms, previousSnapshot });

  await fs.mkdir(automationRoot, { recursive: true });

  const snapshotPath = path.join(automationRoot, `snapshot-${runId}.json`);
  await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");

  const report = buildReport({ runDate, snapshot, previousSnapshot });
  const reportPath = path.join(automationRoot, `report-${runId}.md`);
  await fs.writeFile(reportPath, report, "utf8");

  console.log(`Produtos coletados: ${collected.length}`);
}

async function collectProducts() {
  const byId = new Map();
  const failedTerms = [];

  for (let i = 0; i < terms.length; i += 1) {
    const searchTerm = terms[i];
    if (i > 0) await sleep(350);
    console.log(`Termo: ${searchTerm}`);

    try {
      const response = await fetchWithRetry(buildApiUrl(searchTerm), {
        headers: {
          accept: "application/json",
          origin: SITE_ORIGIN,
          referer: buildSearchPageUrl(searchTerm),
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
        },
      });

      if (!response.ok) throw new Error(`Enjoei retornou HTTP ${response.status}`);

      const payload = await response.json();
      const products = payload?.data?.search?.products;
      if (!products) throw new Error(`Resposta nao contem data.search.products`);

      for (const edge of products.edges ?? []) {
        const item = normalizeProduct(edge.node, searchTerm);
        if (!item || item.price_brl == null || item.price_brl > maxPriceBrl) continue;
        if (!itemMatchesSearchTerm(item, searchTerm)) continue;

        const current = byId.get(item.id);
        if (current) {
          current.search_terms = Array.from(new Set([...(current.search_terms ?? []), searchTerm]));
        } else {
          byId.set(item.id, item);
        }
      }
    } catch (error) {
      console.warn(`  Aviso: falha no termo "${searchTerm}" — ${error.message}. Continuando.`);
      failedTerms.push(searchTerm);
    }
  }

  return { items: Array.from(byId.values()), failedTerms };
}

async function fetchWithRetry(url, options) {
  const maxAttempts = 3;
  const baseDelayMs = 750;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await sleep(baseDelayMs * attempt);
    }
  }
  throw lastError;
}

function buildApiUrl(searchTerm) {
  const url = new URL(SEARCH_ENDPOINT);
  const now = Date.now();
  url.searchParams.set("browser_id", `codex-monitor-${now}`);
  url.searchParams.set("city", city);
  url.searchParams.set("experienced_seller", "true");
  url.searchParams.set("first", String(first));
  url.searchParams.set("operation_name", "searchProducts");
  url.searchParams.set("query_id", "c5faa5f85fb47bf0beaa97b67d8a9189");
  url.searchParams.set("recommendation_context.recommendation_department", department);
  url.searchParams.set("search_context", "products_search");
  url.searchParams.set("search_id", `codex-search-${now}`);
  url.searchParams.set("shipping_range", shippingRange);
  url.searchParams.set("size_types.clothing", jacketSize); // Alterado de "shoes" para "clothing" (Roupas P)
  url.searchParams.set("state", state);
  url.searchParams.set("term", searchTerm);
  return url;
}

function buildSearchPageUrl(searchTerm) {
  const url = new URL(`${SITE_ORIGIN}/${encodeURIComponent(searchTerm)}/s`);
  url.searchParams.set("ref", "products_search");
  url.searchParams.set("q", searchTerm);
  url.searchParams.set("d", department);
  url.searchParams.set("sr", shippingRange);
  return url.toString();
}

function normalizeProduct(node, searchTerm) {
  if (!node?.id || !node?.path) return null;
  const price = Number(node.price?.current);
  return {
    id: String(node.id),
    url: `${SITE_ORIGIN}/p/${node.path}`,
    title: node.title?.name ?? "",
    brand: node.brand?.displayable_name ?? null,
    price_brl: Number.isFinite(price) ? price : null,
    size: node.size?.name ?? jacketSize,
    shipping_free: Boolean(node.shipping?.free),
    store_name: node.store?.displayable?.name ?? null,
    search_terms: [searchTerm],
    status: "active",
    first_seen: null,
    last_seen: null,
  };
}

function mergeWithPreviousSnapshot({ now, collected, failedTerms, previousSnapshot }) {
  const previousItems = (previousSnapshot?.items ?? []).filter(
    (item) => (item.price_brl == null || item.price_brl <= maxPriceBrl) && itemMatchesAnySearchTerm(item)
  );
  return mergeMonitorSnapshot({
    previousSnapshot: previousSnapshot ? { ...previousSnapshot, items: previousItems } : null,
    collected,
    now,
    run: {
      id: "enjoei-jaquetas-north-face",
      label: "Enjoei Jaquetas North Face",
      partial: failedTerms.length > 0 || terms.length < DEFAULT_TERMS.length,
    },
    configuredCoverage: DEFAULT_TERMS,
    scheduledCoverage: terms,
    successfulCoverage: terms.filter((term) => !failedTerms.includes(term)),
    failedCoverage: failedTerms,
    itemCoverage: (item) => item.search_terms ?? [],
    filters: {
      price_brl: { min: 0, max: maxPriceBrl },
      jacket_size: jacketSize,
      department,
    },
  });
}

function buildReport({ runDate, snapshot, previousSnapshot }) {
  const currentItems = snapshot.items.filter((item) => item.status === "active");
  const previousComparableItems = (previousSnapshot?.items ?? []).filter(
    (item) => (item.price_brl == null || item.price_brl <= maxPriceBrl) && itemMatchesAnySearchTerm(item)
  );
  const previousById = new Map(previousComparableItems.map((item) => [item.id ?? item.url, item]));
  const currentById = new Map(currentItems.map((item) => [item.id ?? item.url, item]));

  const { newItems, priceChanges } = buildMonitorChanges(
    { items: previousComparableItems },
    snapshot,
    { reactivationIsNew: false },
  );
  const stillActive = currentItems.filter((item) => previousById.has(item.id ?? item.url));

  const lines = [
    `# Monitor Enjoei Jaquetas North Face P ate R$ ${formatBrl(maxPriceBrl)} - ${runDate}`,
    "",
    "## Resumo executivo",
    `- Novos produtos: **${newItems.length}**`,
    `- Produtos ainda ativos ja vistos: **${stillActive.length}**`,
    `- Termos buscados: ${snapshot.run.configured_coverage.join(", ")}`,
    "",
    "## Novos produtos",
  ];

  if (newItems.length === 0) lines.push("- Nenhum.");
  else for (const item of sortByPrice(newItems)) lines.push(formatItemLine(item));

  lines.push("", "## Produtos ainda ativos");
  if (stillActive.length === 0) lines.push("- Nenhum.");
  else for (const item of sortByPrice(stillActive)) lines.push(formatItemLine(item));

  return lines.join("\n");
}

function formatItemLine(item) {
  const brand = item.brand ? ` - ${item.brand}` : "";
  const store = item.store_name ? ` - vendedor: ${item.store_name}` : "";
  return `- R$ ${formatBrl(item.price_brl)} - ${item.title}${brand} - tam. ${item.size}${store} - ${item.url}`;
}

function sortByPrice(items) {
  return items.slice().sort((a, b) => (a.price_brl ?? Infinity) - (b.price_brl ?? Infinity));
}

function itemMatchesAnySearchTerm(item) {
  return terms.some((searchTerm) => itemMatchesSearchTerm(item, searchTerm));
}

function itemMatchesSearchTerm(item, searchTerm) {
  const text = normalizeComparableText(`${item.title ?? ""} ${item.brand ?? ""}`);
  // Valida se o anúncio realmente menciona North Face para evitar lixo genérico
  return text.includes("north") || text.includes("face");
}

function normalizeComparableText(text) {
  return (text ?? "").toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function formatBrl(value) {
  if (value == null || !Number.isFinite(Number(value))) return "n/d";
  return Number(value).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function getLatestSnapshotPath(root) {
  const entries = await fs.readdir(root).catch(() => []);
  const snapshots = entries.filter((name) => /^snapshot-.*\.json$/.test(name)).sort();
  return snapshots.at(-1) ? path.join(root, snapshots.at(-1)) : null;
}

async function readJsonSafe(filePath) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); } catch { return null; }
}

function getOptionValue(values, name) {
  const index = values.indexOf(name);
  return index === -1 ? null : (values[index + 1] ?? null);
}

function getTerms() {
  return DEFAULT_TERMS;
}