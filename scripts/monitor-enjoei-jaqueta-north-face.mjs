// Watchlist do Enjoei (GraphQL) para Jaqueta North Face Masculina, tamanho P,
// na faixa R$ 200–R$ 300. Segue o mesmo padrão do monitor-enjoei-tenis.mjs
// (bespoke, sem OLX): a busca de roupas do Enjoei não expõe um parâmetro de
// tamanho confiável via querystring como o `size_types.shoes` dos tênis, então
// o filtro de tamanho é feito no cliente, usando o campo estruturado
// `node.size.name` quando presente e, como reforço, uma indicação explícita no
// título (ex.: "tam P", "tamanho P"). Itens sem nenhuma indicação de tamanho
// são mantidos (mesma filosofia do restante do projeto: melhor mostrar e
// deixar o usuário avaliar do que descartar por falta de informação).
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildMonitorChanges,
  mergeMonitorSnapshot,
} from "./lib/monitor-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const automationRoot =
  process.env.ENJOEI_JAQUETA_NORTH_FACE_DATA_DIR ??
  path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".codex", "automations", "monitor-enjoei-jaqueta-north-face");

const SEARCH_ENDPOINT = "https://enjusearch.enjoei.com.br/graphql-search-x";
const SITE_ORIGIN = "https://www.enjoei.com.br";
const DEFAULT_TERMS = ["north face"];

const args = process.argv.slice(2);
const terms = getTerms();
const department = getOptionValue(args, "--department") ?? "masculino";
const clothingSize = (getOptionValue(args, "--clothing-size") ?? "P").toUpperCase();
const requireKeyword = getOptionValue(args, "--keyword") ?? "jaqueta";
const shippingRange = getOptionValue(args, "--shipping-range") ?? "same_country";
const state = getOptionValue(args, "--state") ?? "pr";
const city = getOptionValue(args, "--city") ?? "curitiba";
const first = Number(getOptionValue(args, "--first") ?? 30);
const minPriceBrl = Number(getOptionValue(args, "--min-price") ?? 200);
const maxPriceBrl = Number(getOptionValue(args, "--max-price") ?? 300);

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
  console.log(`Filtro: "${requireKeyword}" North Face, tamanho ${clothingSize}, ${department}, R$ ${minPriceBrl}-${maxPriceBrl}`);
  console.log(`Snapshot anterior: ${previousSnapshotPath ?? "(nenhum)"}`);
  console.log("");

  const { items: collected, failedTerms } = await collectProducts();
  const snapshot = mergeWithPreviousSnapshot({ now, collected, failedTerms, previousSnapshot });

  await fs.mkdir(automationRoot, { recursive: true });

  const snapshotPath = path.join(automationRoot, `snapshot-${runId}.json`);
  await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");

  const report = buildReport({ runDate, snapshot, previousSnapshot });
  const reportPath = path.join(automationRoot, `report-${runId}.md`);
  await fs.writeFile(reportPath, report, "utf8");

  console.log(`Produtos coletados: ${collected.length}`);
  console.log(`Snapshot salvo: ${snapshotPath}`);
  console.log(`Relatorio salvo: ${reportPath}`);
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

      if (!response.ok) {
        throw new Error(`Enjoei retornou HTTP ${response.status}`);
      }

      const payload = await response.json();
      const products = payload?.data?.search?.products;
      if (!products) {
        throw new Error(`Resposta nao contem data.search.products`);
      }

      for (const edge of products.edges ?? []) {
        const item = normalizeProduct(edge.node, searchTerm);
        if (!item || item.price_brl == null) continue;
        if (item.price_brl < minPriceBrl || item.price_brl > maxPriceBrl) continue;
        if (!itemMatchesSearchTerm(item, searchTerm)) continue;
        if (!hasWord(normalizeComparableText(item.title), normalizeComparableText(requireKeyword))) continue;
        if (!sizeMatches(item)) continue;

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

  if (failedTerms.length > 0) {
    console.warn(`\nTermos que falharam: ${failedTerms.join(", ")}`);
  }

  return { items: Array.from(byId.values()), failedTerms };
}

async function fetchWithRetry(url, options) {
  const maxAttempts = 3;
  const baseDelayMs = 750;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (attempt > 1) console.log(`  Retry ${attempt}/${maxAttempts}...`);
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) break;
      await sleep(baseDelayMs * attempt);
    }
  }

  const wrapped = new TypeError(`fetch failed apos ${maxAttempts} tentativas (${url})`);
  wrapped.cause = lastError;
  throw wrapped;
}

function buildApiUrl(searchTerm) {
  const url = new URL(SEARCH_ENDPOINT);
  const now = Date.now();
  const browserId = `codex-monitor-${now}`;
  const searchId = `codex-search-${now}`;

  url.searchParams.set("browser_id", browserId);
  url.searchParams.set("city", city);
  url.searchParams.set("experienced_seller", "true");
  url.searchParams.set("first", String(first));
  url.searchParams.set("operation_name", "searchProducts");
  url.searchParams.set("query_id", "c5faa5f85fb47bf0beaa97b67d8a9189");
  url.searchParams.set("recommendation_context.recommendation_department", department);
  url.searchParams.set("search_context", "products_search");
  url.searchParams.set("search_id", searchId);
  url.searchParams.set("shipping_range", shippingRange);
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
    original_price_brl: Number.isFinite(Number(node.price?.original)) ? Number(node.price.original) : null,
    size: node.size?.name ?? null,
    used: Boolean(node.used),
    shipping_free: Boolean(node.shipping?.free),
    store_name: node.store?.displayable?.name ?? null,
    store_path: node.store?.path ? `${SITE_ORIGIN}/${node.store.path}` : null,
    search_terms: [searchTerm],
    status: "active",
    first_seen: null,
    last_seen: null,
  };
}

// Resolve o tamanho declarado do item (campo estruturado `size` ou, na falta
// dele, uma indicação explícita no título como "tam P"/"tamanho P") e compara
// com o tamanho desejado. Sem nenhuma indicação, o item é mantido (não
// descartamos por falta de informação — mesma regra usada para capacidade em
// ml no restante do projeto).
function sizeMatches(item) {
  const desired = normalizeSizeToken(clothingSize);

  const structured = normalizeSizeToken(item.size);
  if (structured) return structured === desired;

  const fromTitle = extractSizeFromTitle(item.title);
  if (fromTitle) return fromTitle === desired;

  return true;
}

function normalizeSizeToken(rawSize) {
  if (!rawSize) return null;
  const text = normalizeComparableText(rawSize).trim();
  if (!text || text === "unico" || text === "único" || text === "one size" || text === "u") return null;
  // Só considera tokens curtos (P, M, G, GG, PP, 38, etc.); descarta frases longas.
  if (text.length > 4) return null;
  return text;
}

function extractSizeFromTitle(title) {
  const text = normalizeComparableText(title);
  const match = text.match(/tam(?:anho)?\.?\s*:?\s*([a-z]{1,2})\b/);
  if (!match) return null;
  return normalizeSizeToken(match[1]);
}

function itemMatchesSearchTerm(item, searchTerm) {
  const normalizedText = normalizeComparableText(`${item.title ?? ""} ${item.brand ?? ""}`);
  const normalizedTerm = normalizeComparableText(searchTerm);
  return hasWord(normalizedText, normalizedTerm) || normalizedText.includes(normalizedTerm);
}

function hasWord(text, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text);
}

function normalizeComparableText(text) {
  return (text ?? "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function mergeWithPreviousSnapshot({ now, collected, failedTerms, previousSnapshot }) {
  const previousItems = (previousSnapshot?.items ?? []).filter(
    (item) =>
      (item.price_brl == null || (item.price_brl >= minPriceBrl && item.price_brl <= maxPriceBrl)) &&
      itemMatchesAnySearchTerm(item) &&
      hasWord(normalizeComparableText(item.title ?? ""), normalizeComparableText(requireKeyword)) &&
      sizeMatches(item)
  );
  const snapshot = mergeMonitorSnapshot({
    previousSnapshot: previousSnapshot ? { ...previousSnapshot, items: previousItems } : null,
    collected,
    now,
    run: {
      id: "enjoei-jaqueta-north-face",
      label: "Enjoei Jaqueta North Face",
      partial: failedTerms.length > 0 || terms.length < DEFAULT_TERMS.length,
    },
    configuredCoverage: DEFAULT_TERMS,
    scheduledCoverage: terms,
    successfulCoverage: terms.filter((term) => !failedTerms.includes(term)),
    failedCoverage: failedTerms,
    itemCoverage: (item) => item.search_terms ?? [],
    filters: {
      price_brl: { min: minPriceBrl, max: maxPriceBrl },
      clothing_size: clothingSize,
      department,
      keyword: requireKeyword,
    },
  });
  snapshot.search = {
    terms,
    department,
    clothing_size: clothingSize,
    keyword: requireKeyword,
    shipping_range: shippingRange,
    min_price_brl: minPriceBrl,
    max_price_brl: maxPriceBrl,
    source_urls: terms.map((searchTerm) => buildSearchPageUrl(searchTerm)),
  };
  return snapshot;
}

function buildReport({ runDate, snapshot, previousSnapshot }) {
  const currentItems = snapshot.items.filter((item) => item.status === "active");
  const previousComparableItems = (previousSnapshot?.items ?? []).filter(
    (item) =>
      (item.price_brl == null || (item.price_brl >= minPriceBrl && item.price_brl <= maxPriceBrl)) &&
      itemMatchesAnySearchTerm(item) &&
      hasWord(normalizeComparableText(item.title ?? ""), normalizeComparableText(requireKeyword)) &&
      sizeMatches(item)
  );
  const previousById = new Map(previousComparableItems.map((item) => [item.id ?? item.url, item]));
  const currentById = new Map(currentItems.map((item) => [item.id ?? item.url, item]));

  const { newItems, priceChanges: sharedPriceChanges } = buildMonitorChanges(
    { items: previousComparableItems },
    snapshot,
    { reactivationIsNew: false },
  );
  const stillActive = currentItems.filter((item) => previousById.has(item.id ?? item.url));
  const notSeenThisRun = previousComparableItems
    .filter((item) => item.status === "active")
    .filter((item) => !currentById.has(item.id ?? item.url));

  const priceChanges = sharedPriceChanges.map((item) => ({
    item,
    from: item.previous_price_brl,
    to: item.price_brl,
  }));

  const lines = [];
  lines.push(`# Monitor Enjoei Jaqueta North Face (tam. ${clothingSize}) R$ ${formatBrl(minPriceBrl)}-R$ ${formatBrl(maxPriceBrl)} - ${runDate}`);
  lines.push("");
  lines.push("## Resumo executivo");
  lines.push(`- Novos produtos: **${newItems.length}**`);
  lines.push(`- Produtos ainda ativos ja vistos: **${stillActive.length}**`);
  lines.push(`- Nao vistos nesta rodada: **${notSeenThisRun.length}**`);
  lines.push(`- Alteracoes de preco: **${priceChanges.length}**`);
  lines.push(`- Termos: ${snapshot.search.terms.join(", ")}`);
  lines.push(`- Faixa de preco: R$ ${formatBrl(snapshot.search.min_price_brl)} - R$ ${formatBrl(snapshot.search.max_price_brl)}`);
  lines.push(`- Tamanho: ${snapshot.search.clothing_size}`);
  lines.push("");

  lines.push("## Novos produtos");
  if (newItems.length === 0) {
    lines.push("- Nenhum.");
  } else {
    for (const item of sortByPrice(newItems)) lines.push(formatItemLine(item));
  }
  lines.push("");

  if (priceChanges.length > 0) {
    lines.push("## Mudancas de preco");
    for (const change of priceChanges.sort((a, b) => a.to - b.to)) {
      lines.push(
        `- R$ ${formatBrl(change.from)} -> R$ ${formatBrl(change.to)} - ${change.item.title} - ${change.item.url}`
      );
    }
    lines.push("");
  }

  lines.push("## Produtos ainda ativos");
  if (stillActive.length === 0) {
    lines.push("- Nenhum.");
  } else {
    for (const item of sortByPrice(stillActive)) lines.push(formatItemLine(item));
  }
  lines.push("");

  if (notSeenThisRun.length > 0) {
    lines.push("## Nao vistos nesta rodada");
    lines.push("- Observacao: ausencia na busca nao garante que o produto foi removido; apenas que nao apareceu nesta coleta.");
    for (const item of sortByPrice(notSeenThisRun)) lines.push(formatItemLine(item));
    lines.push("");
  }

  return lines.join("\n");
}

function formatItemLine(item) {
  const brand = item.brand ? ` - ${item.brand}` : "";
  const store = item.store_name ? ` - vendedor: ${item.store_name}` : "";
  const shipping = item.shipping_free ? " - frete gratis" : "";
  const matchedTerms = item.search_terms?.length ? ` - termos: ${item.search_terms.join(", ")}` : "";
  const size = item.size ? ` - tam. ${item.size}` : "";
  return `- R$ ${formatBrl(item.price_brl)} - ${item.title}${brand}${size}${store}${shipping}${matchedTerms} - ${item.url}`;
}

function sortByPrice(items) {
  return items.slice().sort((a, b) => (a.price_brl ?? Infinity) - (b.price_brl ?? Infinity));
}

function itemMatchesAnySearchTerm(item) {
  return terms.some((searchTerm) => itemMatchesSearchTerm(item, searchTerm));
}

function formatBrl(value) {
  if (value == null || !Number.isFinite(Number(value))) return "n/d";
  return Number(value).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function getLatestSnapshotPath(root) {
  const entries = await fs.readdir(root).catch(() => []);
  const snapshots = entries
    .filter((name) => /^snapshot-.*\.json$/.test(name))
    .map((name) => path.join(root, name))
    .sort();
  return snapshots.at(-1) ?? null;
}

async function readJsonSafe(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function getOptionValue(values, name) {
  const index = values.indexOf(name);
  if (index === -1) return null;
  return values[index + 1] ?? null;
}

function getTerms() {
  const term = getOptionValue(args, "--term");
  const termsArg = getOptionValue(args, "--terms");
  const rawTerms = termsArg ? termsArg.split(",") : term ? [term] : DEFAULT_TERMS;
  return Array.from(new Set(rawTerms.map((value) => value.trim()).filter(Boolean)));
}
