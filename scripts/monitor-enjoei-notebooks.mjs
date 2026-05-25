import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const automationRoot =
  process.env.ENJOEI_NOTEBOOKS_DATA_DIR ??
  path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".codex", "automations", "monitor-enjoei-notebooks");

const SEARCH_ENDPOINT = "https://enjusearch.enjoei.com.br/graphql-search-x";
const SITE_ORIGIN = "https://www.enjoei.com.br";

const DEFAULT_CPU_TERMS = [
  "13620h", "13450hx", "12700h", "13650hx", "13700hx",
  "12900h", "7845hx", "7940hs", "7840hs", "8845hs",
  "155h", "165h", "185h", "hx370", "8940hx",
  "13980hx", "7945hx", "14700hx", "13500hx", "13420h",
  "7640hs", "7540u", "1255u", "1235u", "8265u",
];

const EXCLUDE_PATTERNS = [
  "tênis", "tenis", "sandália", "sandalia", "sapato", "chinelo",
  "camiseta", "camisa", "calça", "bermuda", "vestido", "blusa",
  "jaqueta", "casaco", "mochila", "mala",
  "processador avulso", "placa-mãe", "placa mae", "motherboard",
  "sucata", "defeito", "quebrado", "não liga", "nao liga",
];

const PRICE_MIN_BRL = 1500;
const PRICE_MAX_BRL = 4000;

const args = process.argv.slice(2);
const shippingRange = getOptionValue(args, "--shipping-range") ?? "same_country";
const state = getOptionValue(args, "--state") ?? "pr";
const city = getOptionValue(args, "--city") ?? "curitiba";
const first = Number(getOptionValue(args, "--first") ?? 30);
const maxPriceBrl = Number(getOptionValue(args, "--max-price") ?? PRICE_MAX_BRL);
const minPriceBrl = Number(getOptionValue(args, "--min-price") ?? PRICE_MIN_BRL);
const cpuArg = getOptionValue(args, "--cpu");
const terms = cpuArg
  ? cpuArg.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
  : DEFAULT_CPU_TERMS;

main().catch((error) => {
  console.error(`\nFalha: ${formatError(error)}`);
  process.exitCode = 1;
});

function formatError(error) {
  if (!error) return "Erro desconhecido.";
  const message = error.stack || error.message || String(error);
  const cause = error.cause;
  if (!cause) return message;
  return `${message}\nCausa: ${cause.stack || cause.message || String(cause)}`;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const now = new Date();
  const runDate = now.toISOString().slice(0, 10);
  const runTimestamp = now.toISOString();
  const runId = runTimestamp.replace(/[:.]/g, "-");

  const previousSnapshotPath = await getLatestSnapshotPath(automationRoot);
  const previousSnapshot = previousSnapshotPath ? await readJsonSafe(previousSnapshotPath) : null;

  console.log(`Execução Enjoei Notebooks: ${runTimestamp}`);
  console.log(`Termos: ${terms.join(", ")}`);
  console.log(`Faixa: R$ ${minPriceBrl}–R$ ${maxPriceBrl}`);
  console.log(`Snapshot anterior: ${previousSnapshotPath ?? "(nenhum)"}\n`);

  const collected = await collectProducts();
  const snapshot = mergeWithPreviousSnapshot({ runDate, collected, previousSnapshot });

  await fs.mkdir(automationRoot, { recursive: true });

  const snapshotPath = path.join(automationRoot, `snapshot-${runId}.json`);
  await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");

  const report = buildReport({ runDate, snapshot, previousSnapshot });
  const reportPath = path.join(automationRoot, `report-${runId}.md`);
  await fs.writeFile(reportPath, report, "utf8");

  console.log(`Coletados: ${collected.length} | Snapshot: ${snapshotPath}`);
  console.log(`Relatório: ${reportPath}`);
}

// ── coleta ───────────────────────────────────────────────────────────────────

async function collectProducts() {
  const byId = new Map();
  const failedTerms = [];

  for (let i = 0; i < terms.length; i++) {
    const term = terms[i];
    if (i > 0) await sleep(400);
    console.log(`Termo: ${term}`);

    try {
      const response = await fetchWithRetry(buildApiUrl(term), {
        headers: {
          accept: "application/json",
          origin: SITE_ORIGIN,
          referer: buildSearchPageUrl(term),
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
        },
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const products = payload?.data?.search?.products;
      if (!products) throw new Error("Resposta sem data.search.products");

      for (const edge of products.edges ?? []) {
        const item = normalizeProduct(edge.node, term);
        if (!item) continue;
        if (item.price_brl == null || item.price_brl < minPriceBrl || item.price_brl > maxPriceBrl) continue;
        if (!itemMatchesCpuTerm(item, term)) continue;
        if (hasExcludedKeyword(item.title)) continue;

        const existing = byId.get(item.id);
        if (existing) {
          existing.cpu_terms = Array.from(new Set([...(existing.cpu_terms ?? []), term]));
        } else {
          byId.set(item.id, item);
        }
      }
    } catch (err) {
      console.warn(`  Aviso: falha em "${term}" — ${err.message}`);
      failedTerms.push(term);
    }
  }

  if (failedTerms.length) console.warn(`Termos com falha: ${failedTerms.join(", ")}`);
  return Array.from(byId.values());
}

async function fetchWithRetry(url, options) {
  const maxAttempts = 3;
  let lastError;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      if (i > 1) console.log(`  Retry ${i}/${maxAttempts}...`);
      return await fetch(url, options);
    } catch (err) {
      lastError = err;
      if (i < maxAttempts) await sleep(750 * i);
    }
  }
  const e = new TypeError(`fetch falhou após ${maxAttempts} tentativas`);
  e.cause = lastError;
  throw e;
}

// ── API ──────────────────────────────────────────────────────────────────────

function buildApiUrl(term) {
  const url = new URL(SEARCH_ENDPOINT);
  const ts = Date.now();
  url.searchParams.set("browser_id", `codex-notebooks-${ts}`);
  url.searchParams.set("city", city);
  url.searchParams.set("experienced_seller", "true");
  url.searchParams.set("first", String(first));
  url.searchParams.set("operation_name", "searchProducts");
  url.searchParams.set("query_id", "c5faa5f85fb47bf0beaa97b67d8a9189");
  url.searchParams.set("search_context", "products_search");
  url.searchParams.set("search_id", `codex-search-${ts}`);
  url.searchParams.set("shipping_range", shippingRange);
  url.searchParams.set("state", state);
  url.searchParams.set("term", term);
  // sem size_types.shoes nem department — busca geral
  return url;
}

function buildSearchPageUrl(term) {
  const url = new URL(`${SITE_ORIGIN}/${encodeURIComponent(term)}/s`);
  url.searchParams.set("ref", "products_search");
  url.searchParams.set("q", term);
  return url.toString();
}

// ── normalização ─────────────────────────────────────────────────────────────

function normalizeProduct(node, cpuTerm) {
  if (!node?.id || !node?.path) return null;
  const price = Number(node.price?.current);
  const title = node.title?.name ?? "";
  return {
    id: String(node.id),
    url: `${SITE_ORIGIN}/p/${node.path}`,
    title,
    brand: node.brand?.displayable_name ?? null,
    price_brl: Number.isFinite(price) ? price : null,
    original_price_brl: Number.isFinite(Number(node.price?.original)) ? Number(node.price.original) : null,
    ram_gb: extractRamGb(title),
    storage_gb: extractStorageGb(title),
    used: Boolean(node.used),
    shipping_free: Boolean(node.shipping?.free),
    store_name: node.store?.displayable?.name ?? null,
    cpu_terms: [cpuTerm],
    status: "active",
    first_seen: null,
    last_seen: null,
  };
}

function itemMatchesCpuTerm(item, term) {
  const text = normalizeCpuText(`${item.title} ${item.brand ?? ""}`);
  const t = normalizeCpuText(term);
  return text.includes(t);
}

function normalizeCpuText(text) {
  return (text ?? "").toString().toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[\s\-_.]/g, "").replace(/[^a-z0-9]/g, "");
}

function hasExcludedKeyword(text) {
  const n = (text ?? "").toLowerCase();
  return EXCLUDE_PATTERNS.some((p) => n.includes(p));
}

function extractRamGb(text) {
  const m = (text ?? "").match(/\b(\d{1,3})\s*gb\s*(?:ram|ddr\d?)\b/i)
    ?? (text ?? "").match(/\bram\s*:?\s*(\d{1,3})\s*gb\b/i);
  if (!m) return null;
  const v = Number(m[1]);
  return v >= 2 && v <= 256 ? v : null;
}

function extractStorageGb(text) {
  const t = (text ?? "").toLowerCase();
  const mTb = t.match(/\b(\d+(?:[.,]\d+)?)\s*tb\b/);
  if (mTb) return Math.round(Number(mTb[1].replace(",", ".")) * 1024);
  const mSsd = t.match(/\b(\d{2,4})\s*(?:gb\s*)?(?:ssd|nvme|hd|m\.2)\b/)
    ?? t.match(/\bssd\s*(\d{2,4})\s*gb\b/);
  if (mSsd) { const v = Number(mSsd[1]); if (v >= 64 && v <= 8192) return v; }
  return null;
}

// ── snapshot ─────────────────────────────────────────────────────────────────

function mergeWithPreviousSnapshot({ runDate, collected, previousSnapshot }) {
  const previousItems = (previousSnapshot?.items ?? []).filter(
    (i) => i.price_brl != null && i.price_brl >= minPriceBrl && i.price_brl <= maxPriceBrl
  );
  const previousById = new Map(previousItems.map((i) => [i.id ?? i.url, i]));
  const items = [];

  for (const item of collected) {
    const key = item.id ?? item.url;
    const prev = previousById.get(key);
    items.push({ ...item, first_seen: prev?.first_seen ?? runDate, last_seen: runDate });
  }

  const currentKeys = new Set(items.map((i) => i.id ?? i.url));
  for (const prev of previousItems) {
    if (!currentKeys.has(prev.id ?? prev.url)) {
      items.push({ ...prev, status: "not_seen", last_seen: runDate });
    }
  }

  return {
    run: { date: runDate, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    price_range_brl: { min: minPriceBrl, max: maxPriceBrl },
    items,
  };
}

// ── relatório ─────────────────────────────────────────────────────────────────

function buildReport({ runDate, snapshot, previousSnapshot }) {
  const currentItems = snapshot.items.filter((i) => i.status === "active");
  const previousItems = (previousSnapshot?.items ?? []).filter(
    (i) => i.price_brl != null && i.price_brl >= minPriceBrl && i.price_brl <= maxPriceBrl
  );
  const previousById = new Map(previousItems.map((i) => [i.id ?? i.url, i]));
  const currentById = new Map(currentItems.map((i) => [i.id ?? i.url, i]));

  const newItems = currentItems.filter((i) => !previousById.has(i.id ?? i.url));
  const stillActive = currentItems.filter((i) => previousById.has(i.id ?? i.url));
  const notSeen = previousItems
    .filter((i) => i.status === "active")
    .filter((i) => !currentById.has(i.id ?? i.url));

  const priceChanges = [];
  for (const item of currentItems) {
    const prev = previousById.get(item.id ?? item.url);
    if (prev?.price_brl != null && item.price_brl != null && prev.price_brl !== item.price_brl) {
      priceChanges.push({ item, from: prev.price_brl, to: item.price_brl });
    }
  }

  const lines = [];
  lines.push(`# Monitor Enjoei notebooks por CPU — ${runDate}`);
  lines.push("");
  lines.push("## Resumo executivo");
  lines.push(`- Novos notebooks (R$ ${fmtBrl(minPriceBrl)}–R$ ${fmtBrl(maxPriceBrl)}): **${newItems.length}**`);
  lines.push(`- Já vistos e ativos: **${stillActive.length}**`);
  lines.push(`- Não vistos nesta rodada: **${notSeen.length}**`);
  lines.push(`- Alterações de preço: **${priceChanges.length}**`);
  lines.push(`- Termos: ${terms.join(", ")}`);
  lines.push("");

  lines.push(`## Novos notebooks`);
  if (!newItems.length) {
    lines.push("- Nenhum.");
  } else {
    for (const item of sortByPrice(newItems)) lines.push(formatLine(item));
  }
  lines.push("");

  if (priceChanges.length) {
    lines.push("## Mudanças de preço");
    for (const c of priceChanges.sort((a, b) => a.to - b.to)) {
      lines.push(`- R$ ${fmtBrl(c.from)} → R$ ${fmtBrl(c.to)} — ${c.item.title} — ${c.item.url}`);
    }
    lines.push("");
  }

  lines.push("## Já vistos e ativos");
  if (!stillActive.length) {
    lines.push("- Nenhum.");
  } else {
    for (const item of sortByPrice(stillActive)) lines.push(formatLine(item));
  }
  lines.push("");

  if (notSeen.length) {
    lines.push("## Não vistos nesta rodada");
    lines.push("- Observação: ausência não garante remoção do anúncio.");
    for (const item of sortByPrice(notSeen)) lines.push(`- ${item.title} — ${item.url}`);
    lines.push("");
  }

  return lines.join("\n");
}

function formatLine(item) {
  const ram = item.ram_gb ? `${item.ram_gb} GB RAM` : "RAM n/d";
  const sto = item.storage_gb ? `${item.storage_gb} GB` : "armazenamento n/d";
  const ship = item.shipping_free ? " — frete grátis" : "";
  const terms = item.cpu_terms?.length ? ` — cpu: ${item.cpu_terms.join(", ")}` : "";
  return `- R$ ${fmtBrl(item.price_brl)} — ${item.title} — ${ram} / ${sto}${ship}${terms} — ${item.url}`;
}

function sortByPrice(items) {
  return [...items].sort((a, b) => (a.price_brl ?? Infinity) - (b.price_brl ?? Infinity));
}

function fmtBrl(v) {
  if (v == null || !Number.isFinite(Number(v))) return "n/d";
  return Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── utilitários ───────────────────────────────────────────────────────────────

async function getLatestSnapshotPath(root) {
  const entries = await fs.readdir(root).catch(() => []);
  const snapshots = entries
    .filter((n) => /^snapshot-.*\.json$/.test(n))
    .map((n) => path.join(root, n))
    .sort();
  return snapshots.at(-1) ?? null;
}

async function readJsonSafe(filePath) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); }
  catch { return null; }
}

function getOptionValue(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  return argv[i + 1] ?? null;
}
