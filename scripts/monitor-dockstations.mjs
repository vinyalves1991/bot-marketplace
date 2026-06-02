// Monitor de dockstations (OLX + Enjoei) até um teto de preço.
// Busca modelos específicos (ex.: SD25TB4, WD22TB4, 40AY0090BR) e alerta quando
// aparecem por menos que o preço máximo. OLX é coletado via Playwright (mesma
// estratégia anti-Cloudflare do monitor de notebooks); Enjoei via API GraphQL.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { parseBrlPrice, extractOlxId } from "./lib/parsers.mjs";
import { mergeWithPreviousSnapshot as mergeItems } from "./lib/snapshot.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "..");
const automationRoot =
  process.env.DOCKSTATIONS_DATA_DIR ??
  path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".codex", "automations", "monitor-dockstations");

const DEFAULT_MODELS = ["SD25TB4", "WD22TB4", "40AY0090BR"];
const PRICE_MAX_BRL = 500;

// Perfil de Chrome próprio para não conflitar (lock de userDataDir) com o
// monitor de notebooks, que pode rodar em paralelo no orquestrador.
const USER_DATA_DIR = path.join(workspaceRoot, ".chrome-dockstations-profile");
const OLX_BASE_URL = "https://www.olx.com.br/brasil";
const ENJOEI_SEARCH_ENDPOINT = "https://enjusearch.enjoei.com.br/graphql-search-x";
const ENJOEI_SITE_ORIGIN = "https://www.enjoei.com.br";
const NAVIGATION_TIMEOUT_MS = 30_000;

const args = process.argv.slice(2);
const headless = args.includes("--headless");
const skipOlx = args.includes("--skip-olx") || process.env.SKIP_OLX === "1";
const skipEnjoei = args.includes("--skip-enjoei") || process.env.SKIP_ENJOEI === "1";
const maxPriceBrl = Number(getOptionValue(args, "--max-price") ?? PRICE_MAX_BRL);
const modelsArg = getOptionValue(args, "--models");
const models = modelsArg
  ? modelsArg.split(",").map((s) => s.trim()).filter(Boolean)
  : DEFAULT_MODELS;

main().catch((error) => {
  console.error(`\nFalha: ${error.stack || error.message}`);
  process.exitCode = 1;
});

async function main() {
  const now = new Date();
  const runDate = now.toISOString().slice(0, 10);
  const runId = now.toISOString().replace(/[:.]/g, "-");

  const previousSnapshotPath = await getLatestSnapshotPath(automationRoot);
  const previousSnapshot = previousSnapshotPath ? await readJsonSafe(previousSnapshotPath) : null;

  console.log(`Execução Dockstations: ${now.toISOString()}`);
  console.log(`Modelos: ${models.join(", ")} | até R$ ${maxPriceBrl}`);
  console.log(`Snapshot anterior: ${previousSnapshotPath ?? "(nenhum)"}\n`);

  const collected = [];
  const errors = [];

  if (!skipEnjoei) {
    try {
      const enjoei = await collectEnjoei();
      collected.push(...enjoei);
    } catch (error) {
      console.warn(`Aviso: coleta Enjoei falhou — ${error.message}`);
      errors.push(`Enjoei: ${error.message}`);
    }
  }

  if (!skipOlx) {
    try {
      const olx = await collectOlx();
      collected.push(...olx);
    } catch (error) {
      console.warn(`Aviso: coleta OLX falhou — ${error.message}`);
      errors.push(`OLX: ${error.message}`);
    }
  }

  // Dedup por chave (id ?? url): o mesmo anúncio não deve contar duas vezes.
  const byKey = new Map();
  for (const item of collected) {
    const key = item.id ?? item.url;
    if (!byKey.has(key)) byKey.set(key, item);
  }
  const deduped = [...byKey.values()];

  const snapshot = mergeWithPreviousSnapshot({ runDate, collected: deduped, previousSnapshot });

  await fs.mkdir(automationRoot, { recursive: true });
  const snapshotPath = path.join(automationRoot, `snapshot-${runId}.json`);
  await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");

  const report = buildReport({ runDate, snapshot, previousSnapshot, errors });
  const reportPath = path.join(automationRoot, `report-${runId}.md`);
  await fs.writeFile(reportPath, report, "utf8");

  console.log(`\nColetados: ${deduped.length} | Snapshot: ${snapshotPath}`);
  console.log(`Relatório: ${reportPath}`);
  if (errors.length) process.exitCode = 1;
}

// ── Enjoei (API GraphQL) ───────────────────────────────────────────────────────

async function collectEnjoei() {
  const out = [];
  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    if (i > 0) await sleep(400);
    console.log(`Enjoei termo: ${model}`);
    const response = await fetchWithRetry(buildEnjoeiApiUrl(model), {
      headers: {
        accept: "application/json",
        origin: ENJOEI_SITE_ORIGIN,
        referer: `${ENJOEI_SITE_ORIGIN}/${encodeURIComponent(model)}/s?q=${encodeURIComponent(model)}`,
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const products = payload?.data?.search?.products;
    if (!products) throw new Error("Resposta sem data.search.products");

    for (const edge of products.edges ?? []) {
      const node = edge.node;
      if (!node?.id || !node?.path) continue;
      const price = Number(node.price?.current);
      const title = node.title?.name ?? "";
      const brand = node.brand?.displayable_name ?? "";
      if (!Number.isFinite(price) || price > maxPriceBrl) continue;
      if (!textMatchesModel(`${title} ${brand}`, model)) continue;
      out.push({
        id: `enjoei-${node.id}`,
        url: `${ENJOEI_SITE_ORIGIN}/p/${node.path}`,
        title,
        source: "Enjoei",
        model,
        price_brl: price,
        store_name: node.store?.displayable?.name ?? null,
        status: "active",
        first_seen: null,
        last_seen: null,
      });
    }
  }
  return out;
}

function buildEnjoeiApiUrl(model) {
  const url = new URL(ENJOEI_SEARCH_ENDPOINT);
  const ts = Date.now();
  url.searchParams.set("browser_id", `codex-dock-${ts}`);
  url.searchParams.set("experienced_seller", "true");
  url.searchParams.set("first", "30");
  url.searchParams.set("operation_name", "searchProducts");
  url.searchParams.set("query_id", "c5faa5f85fb47bf0beaa97b67d8a9189");
  url.searchParams.set("search_context", "products_search");
  url.searchParams.set("search_id", `codex-dock-search-${ts}`);
  url.searchParams.set("shipping_range", "same_country");
  url.searchParams.set("term", model);
  return url;
}

// ── OLX (Playwright) ───────────────────────────────────────────────────────────

async function collectOlx() {
  const isCI = Boolean(process.env.CI);
  const launchOptions = {
    headless: headless || isCI,
    viewport: null,
    locale: "pt-BR",
    args: isCI
      ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--window-size=1280,900", "--disable-blink-features=AutomationControlled"]
      : ["--start-maximized", "--disable-blink-features=AutomationControlled"],
  };
  if (!isCI) launchOptions.channel = "chrome";
  if (isCI) {
    launchOptions.userAgent =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  }

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, launchOptions);
  await context.addInitScript(() => {
    try { delete Object.getPrototypeOf(navigator).webdriver; } catch (_) {}
  });
  // Bloqueia mídia/fontes para acelerar.
  await context.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (["image", "media", "font"].includes(type)) return route.abort();
    return route.continue();
  }).catch(() => {});

  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(60_000);

  const out = [];
  try {
    for (const model of models) {
      const url = `${OLX_BASE_URL}?q=${encodeURIComponent(model)}`;
      console.log(`OLX termo: ${model} -> ${url}`);
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
        await waitOutCloudflare(page);
        const hasCards = await waitForListing(page);
        if (!hasCards) {
          console.log("  Nenhum card.");
          continue;
        }
        const cards = await collectCards(page);
        for (const card of cards) {
          if (card.price_brl == null || card.price_brl > maxPriceBrl) continue;
          if (!textMatchesModel(card.title, model)) continue;
          out.push({
            id: extractOlxId(card.url) ?? card.url,
            url: card.url,
            title: card.title,
            source: "OLX",
            model,
            price_brl: card.price_brl,
            location: card.location ?? null,
            status: "active",
            first_seen: null,
            last_seen: null,
          });
        }
      } catch (error) {
        console.warn(`  Aviso: termo "${model}" falhou — ${error.message}`);
      }
    }
  } finally {
    await context.close().catch(() => {});
  }
  return out;
}

async function waitOutCloudflare(page) {
  const maxWait = headless ? 10_000 : 60_000;
  const started = Date.now();
  while (Date.now() - started < maxWait) {
    const title = await page.title().catch(() => "");
    if (!/cloudflare|attention required/i.test(title)) return;
    await page.waitForTimeout(2500);
  }
}

async function waitForListing(page) {
  const outcome = await page
    .waitForFunction(
      () => {
        const count = document.querySelectorAll("section.olx-adcard").length;
        if (count > 0) return "cards";
        const text = (document.body?.innerText || "").toLowerCase();
        if (/0\s+resultados?|nao encontramos|sem resultados|nenhum resultado|não encontramos/i.test(text)) return "empty";
        if (document.readyState === "complete" && performance.now() > 3500) return "empty";
        return false;
      },
      null,
      { timeout: 6000, polling: 150 }
    )
    .then((handle) => handle.jsonValue())
    .catch(() => null);
  return outcome === "cards";
}

async function collectCards(page) {
  const batch = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll("section.olx-adcard"));
    return cards.map((card) => {
      const a = card.querySelector("[data-testid=adcard-link]");
      return {
        title: a?.getAttribute("title") || a?.textContent?.trim() || "",
        url: a?.href || "",
        priceText: card.querySelector("h3.olx-adcard__price")?.textContent?.trim() || "",
        location: card.querySelector(".olx-adcard__location")?.textContent?.trim() || "",
      };
    });
  });
  return batch
    .map((item) => ({
      title: item.title?.trim(),
      url: item.url,
      price_brl: parseBrlPrice(item.priceText),
      location: item.location?.trim() || null,
    }))
    .filter((item) => item.url && item.title && item.price_brl != null);
}

// ── matching ───────────────────────────────────────────────────────────────────

// Compara códigos de modelo ignorando caixa, acentos e separadores (espaço,
// hífen, ponto): "SD25 TB4" e "sd25-tb4" casam com "SD25TB4".
function normalizeCode(text) {
  return (text ?? "")
    .toString()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function textMatchesModel(text, model) {
  return normalizeCode(text).includes(normalizeCode(model));
}

// Um item do snapshot anterior só continua relevante se ainda casa com algum
// modelo da busca atual — seja pelo campo `model` registrado, seja pelo título.
// Assim, ao remover um modelo da lista, seus itens saem do histórico em vez de
// ficarem presos como "não vistos" para sempre.
function itemMatchesAnyModel(item) {
  if (item.model && models.some((m) => normalizeCode(m) === normalizeCode(item.model))) return true;
  return models.some((m) => textMatchesModel(item.title ?? "", m));
}

// ── snapshot + relatório ───────────────────────────────────────────────────────

function mergeWithPreviousSnapshot({ runDate, collected, previousSnapshot }) {
  const previousItems = (previousSnapshot?.items ?? []).filter(
    (i) => (i.price_brl == null || i.price_brl <= maxPriceBrl) && itemMatchesAnyModel(i)
  );
  return mergeItems({
    runDate,
    collected,
    previousSnapshot: previousSnapshot ? { ...previousSnapshot, items: previousItems } : null,
    priceMin: 0,
    priceMax: maxPriceBrl,
  });
}

function buildReport({ runDate, snapshot, previousSnapshot, errors }) {
  const currentItems = snapshot.items.filter((i) => i.status === "active");
  const previousItems = (previousSnapshot?.items ?? []).filter(
    (i) => (i.price_brl == null || i.price_brl <= maxPriceBrl) && itemMatchesAnyModel(i)
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
  lines.push(`# Monitor Dockstations até R$ ${fmtBrl(maxPriceBrl)} — ${runDate}`);
  lines.push("");
  lines.push("## Resumo executivo");
  lines.push(`- Novos produtos: **${newItems.length}**`);
  lines.push(`- Já vistos e ativos: **${stillActive.length}**`);
  lines.push(`- Não vistos nesta rodada: **${notSeen.length}**`);
  lines.push(`- Alterações de preço: **${priceChanges.length}**`);
  lines.push(`- Modelos: ${models.join(", ")}`);
  if (errors.length) lines.push(`- Erros de coleta: ${errors.join("; ")}`);
  lines.push("");

  lines.push("## Novos produtos");
  if (!newItems.length) lines.push("- Nenhum.");
  else for (const item of sortByPrice(newItems)) lines.push(formatLine(item));
  lines.push("");

  if (priceChanges.length) {
    lines.push("## Mudanças de preço");
    for (const c of priceChanges.sort((a, b) => a.to - b.to)) {
      lines.push(`- R$ ${fmtBrl(c.from)} → R$ ${fmtBrl(c.to)} — ${c.item.title} — ${c.item.url}`);
    }
    lines.push("");
  }

  lines.push("## Já vistos e ativos");
  if (!stillActive.length) lines.push("- Nenhum.");
  else for (const item of sortByPrice(stillActive)) lines.push(formatLine(item));
  lines.push("");

  if (notSeen.length) {
    lines.push("## Não vistos nesta rodada");
    lines.push("- Observação: ausência não garante remoção do anúncio.");
    for (const item of sortByPrice(notSeen)) lines.push(formatLine(item));
    lines.push("");
  }

  return lines.join("\n");
}

function formatLine(item) {
  const src = item.source ? `[${item.source}]` : "";
  const model = item.model ? ` (${item.model})` : "";
  const loc = item.location ? ` — ${item.location}` : "";
  return `- R$ ${fmtBrl(item.price_brl)} — ${src} ${item.title}${model}${loc} — ${item.url}`;
}

function sortByPrice(items) {
  return [...items].sort((a, b) => (a.price_brl ?? Infinity) - (b.price_brl ?? Infinity));
}

function fmtBrl(v) {
  if (v == null || !Number.isFinite(Number(v))) return "n/d";
  return Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── utilitários ─────────────────────────────────────────────────────────────────

async function fetchWithRetry(url, options) {
  const maxAttempts = 3;
  let lastError;
  for (let i = 1; i <= maxAttempts; i += 1) {
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getLatestSnapshotPath(root) {
  const entries = await fs.readdir(root).catch(() => []);
  const snapshots = entries
    .filter((n) => /^snapshot-.*\.json$/.test(n))
    .map((n) => path.join(root, n))
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

function getOptionValue(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const value = argv[i + 1];
  if (!value || value.startsWith("--")) return null;
  return value;
}
