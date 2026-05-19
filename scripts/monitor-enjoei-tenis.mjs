import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const automationRoot = process.env.ENJOEI_DATA_DIR ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".codex", "automations", "monitor-enjoei-tenis-42");

const SEARCH_ENDPOINT = "https://enjusearch.enjoei.com.br/graphql-search-x";
const SITE_ORIGIN = "https://www.enjoei.com.br";
const DEFAULT_TERMS = ["barefoot", "feet of tomorrow", "fot", "vita", "vivobarefoot", "xero", "vibram", "merrell", "lems"];

const args = process.argv.slice(2);
const terms = getTerms();
const department = getOptionValue(args, "--department") ?? "masculino";
const shoeSize = getOptionValue(args, "--shoe-size") ?? "42";
const shippingRange = getOptionValue(args, "--shipping-range") ?? "same_country";
const state = getOptionValue(args, "--state") ?? "pr";
const city = getOptionValue(args, "--city") ?? "curitiba";
const first = Number(getOptionValue(args, "--first") ?? 30);
const maxPriceBrl = Number(getOptionValue(args, "--max-price") ?? 500);

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
  console.log(`Filtro: tenis ${shoeSize}, ${department}, ${shippingRange}, ate R$ ${maxPriceBrl}`);
  console.log(`Snapshot anterior: ${previousSnapshotPath ?? "(nenhum)"}`);
  console.log("");

  const collected = await collectProducts();
  const snapshot = mergeWithPreviousSnapshot({ runDate, collected, previousSnapshot });

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

  if (failedTerms.length > 0) {
    console.warn(`\nTermos que falharam: ${failedTerms.join(", ")}`);
  }

  return Array.from(byId.values());
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
  url.searchParams.set("size_types.shoes", shoeSize);
  url.searchParams.set("state", state);
  url.searchParams.set("term", searchTerm);

  return url;
}

function buildSearchPageUrl(searchTerm) {
  const url = new URL(`${SITE_ORIGIN}/${encodeURIComponent(searchTerm)}/s`);
  url.searchParams.set("ref", "products_search");
  url.searchParams.set("q", searchTerm);
  url.searchParams.set("d", department);
  url.searchParams.set("st[ss]", shoeSize);
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
    size: node.size?.name ?? shoeSize,
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

function mergeWithPreviousSnapshot({ runDate, collected, previousSnapshot }) {
  const previousItems = (previousSnapshot?.items ?? []).filter(
    (item) => (item.price_brl == null || item.price_brl <= maxPriceBrl) && itemMatchesAnySearchTerm(item)
  );
  const previousById = new Map(previousItems.map((item) => [item.id ?? item.url, item]));

  const items = [];
  for (const item of collected) {
    const key = item.id ?? item.url;
    const previous = previousById.get(key);
    items.push({
      ...item,
      first_seen: previous?.first_seen ?? runDate,
      last_seen: runDate,
    });
  }

  const currentKeys = new Set(items.map((item) => item.id ?? item.url));
  for (const previous of previousItems) {
    const key = previous.id ?? previous.url;
    if (!currentKeys.has(key)) {
      items.push({
        ...previous,
        status: "not_seen",
        last_seen: runDate,
      });
    }
  }

  return {
    run: { date: runDate, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    search: {
      terms,
      department,
      shoe_size: shoeSize,
      shipping_range: shippingRange,
      max_price_brl: maxPriceBrl,
      source_urls: terms.map((searchTerm) => buildSearchPageUrl(searchTerm)),
    },
    items,
  };
}

function buildReport({ runDate, snapshot, previousSnapshot }) {
  const currentItems = snapshot.items.filter((item) => item.status === "active");
  const previousComparableItems = (previousSnapshot?.items ?? []).filter(
    (item) => (item.price_brl == null || item.price_brl <= maxPriceBrl) && itemMatchesAnySearchTerm(item)
  );
  const previousById = new Map(previousComparableItems.map((item) => [item.id ?? item.url, item]));
  const currentById = new Map(currentItems.map((item) => [item.id ?? item.url, item]));

  const newItems = currentItems.filter((item) => !previousById.has(item.id ?? item.url));
  const stillActive = currentItems.filter((item) => previousById.has(item.id ?? item.url));
  const notSeenThisRun = previousComparableItems
    .filter((item) => item.status === "active")
    .filter((item) => !currentById.has(item.id ?? item.url));

  const priceChanges = [];
  for (const item of currentItems) {
    const previous = previousById.get(item.id ?? item.url);
    if (!previous) continue;
    if (previous.price_brl != null && item.price_brl != null && previous.price_brl !== item.price_brl) {
      priceChanges.push({ item, from: previous.price_brl, to: item.price_brl });
    }
  }

  const lines = [];
  lines.push(`# Monitor Enjoei tenis ${shoeSize} ate R$ ${formatBrl(maxPriceBrl)} - ${runDate}`);
  lines.push("");
  lines.push("## Resumo executivo");
  lines.push(`- Novos produtos: **${newItems.length}**`);
  lines.push(`- Produtos ainda ativos ja vistos: **${stillActive.length}**`);
  lines.push(`- Nao vistos nesta rodada: **${notSeenThisRun.length}**`);
  lines.push(`- Alteracoes de preco: **${priceChanges.length}**`);
  lines.push(`- Termos: ${snapshot.search.terms.join(", ")}`);
  lines.push(`- Preco maximo: R$ ${formatBrl(snapshot.search.max_price_brl)}`);
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
  return `- R$ ${formatBrl(item.price_brl)} - ${item.title}${brand} - tam. ${item.size}${store}${shipping}${matchedTerms} - ${item.url}`;
}

function sortByPrice(items) {
  return items.slice().sort((a, b) => (a.price_brl ?? Infinity) - (b.price_brl ?? Infinity));
}

function itemMatchesAnySearchTerm(item) {
  return terms.some((searchTerm) => itemMatchesSearchTerm(item, searchTerm));
}

function itemMatchesSearchTerm(item, searchTerm) {
  const normalizedText = normalizeComparableText(`${item.title ?? ""} ${item.brand ?? ""}`);
  const normalizedTerm = normalizeComparableText(searchTerm);

  if (normalizedTerm === "fot") {
    return hasWord(normalizedText, "fot") || normalizedText.includes("feet of tomorrow");
  }

  if (normalizedTerm === "feet of tomorrow") {
    return normalizedText.includes("feet of tomorrow");
  }

  if (normalizedTerm === "vita") {
    return hasWord(normalizedText, "vita");
  }

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
