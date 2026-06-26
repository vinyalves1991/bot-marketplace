// Monitor genérico de "watchlist": busca termos específicos em OLX (Playwright)
// e Enjoei (API GraphQL) dentro de uma faixa de preço, faz merge com o snapshot
// anterior e gera relatório. Usado por monitores finos (dockstations, fitbit…)
// que só fornecem a configuração (termos, faixa, pasta, rótulo).
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { parseBrlPrice, extractOlxId } from "./parsers.mjs";
import {
  buildMonitorChanges,
  dedupeMonitorItems,
  mergeMonitorSnapshot,
  normalizeMonitorCode,
  normalizeMonitorText,
} from "./monitor-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "..", "..");
const OLX_BASE_URL = "https://www.olx.com.br/brasil";
const ENJOEI_SEARCH_ENDPOINT = "https://enjusearch.enjoei.com.br/graphql-search-x";
const ENJOEI_SITE_ORIGIN = "https://www.enjoei.com.br";
const NAVIGATION_TIMEOUT_MS = 30_000;

/**
 * @param {object} config
 * @param {string} config.label        Rótulo curto (ex.: "Dockstations", "Fitbit Air").
 * @param {string} config.dataDir      Pasta onde gravar snapshots/relatórios.
 * @param {string} config.profileDir   Nome da pasta de perfil do Chrome (isolada por watchlist).
 * @param {string[]} config.terms      Termos/modelos a buscar.
 * @param {number} [config.minPrice=0] Preço mínimo (inclusivo).
 * @param {number} config.maxPrice     Preço máximo (inclusivo).
 * @param {number} [config.minSizeMl]  Capacidade mínima em ml (opcional).
 * @param {number} [config.maxSizeMl]  Capacidade máxima em ml (opcional).
 * @param {string[]} [config.excludeTerms] Termos que, se presentes no título, descartam o item.
 * @param {string[]} [config.keepTerms] Override: se algum aparecer, o item é mantido mesmo
 *        que case um excludeTerm (ex.: manter "bivolt"/"110v" apesar de conter "220v").
 * @param {string[]} [config.olxCategoryUrls] URLs de categoria do OLX onde buscar
 *        (cada uma recebe `?q=<termo>`). Default: a busca geral em /brasil.
 */
export async function runWatchlistMonitor(config) {
  const args = process.argv.slice(2);
  const headless = args.includes("--headless");
  const visible = args.includes("--visible"); // mostra a janela do Chrome (padrão: fora da tela)
  const skipOlx = args.includes("--skip-olx") || process.env.SKIP_OLX === "1";
  const skipEnjoei = args.includes("--skip-enjoei") || process.env.SKIP_ENJOEI === "1";

  const label = config.label;
  const slug = label.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const dataDir = config.dataDir;
  const userDataDir = path.isAbsolute(config.profileDir)
    ? config.profileDir
    : path.join(workspaceRoot, config.profileDir);

  const minPrice = Number(getOptionValue(args, "--min-price") ?? config.minPrice ?? 0);
  const maxPrice = Number(getOptionValue(args, "--max-price") ?? config.maxPrice);
  const termsArg = getOptionValue(args, "--terms") ?? getOptionValue(args, "--models");
  const terms = termsArg
    ? termsArg.split(",").map((s) => s.trim()).filter(Boolean)
    : config.terms;
  const configuredTerms = config.terms;

  const minSizeMl = config.minSizeMl ?? null;
  const maxSizeMl = config.maxSizeMl ?? null;

  const inRange = (price) => price != null && price >= minPrice && price <= maxPrice;
  // Filtro de capacidade (opcional): exclui apenas itens cujo título declara um
  // tamanho FORA da faixa. Itens sem capacidade detectável são mantidos — melhor
  // mostrar e deixar o usuário avaliar do que descartar por falta de info.
  const sizeOk = (text) => {
    if (minSizeMl == null && maxSizeMl == null) return true;
    const ml = extractCapacityMl(text);
    if (ml == null) return true;
    if (minSizeMl != null && ml < minSizeMl) return false;
    if (maxSizeMl != null && ml > maxSizeMl) return false;
    return true;
  };
  // Descarta itens cujo título contém algum termo de exclusão (ex.: "mamadeira"
  // numa busca por garrafas). Comparação tolerante a acentos e caixa.
  const excludeTerms = (config.excludeTerms ?? []).map((t) => normalizeText(t));
  const keepTerms = (config.keepTerms ?? []).map((t) => normalizeText(t));
  const notExcluded = (text) => {
    if (excludeTerms.length === 0) return true;
    const n = normalizeText(text);
    // keepTerms vencem a exclusão: ex.: "110/220V bivolt" contém "220v" mas
    // serve em 110V, então é mantido.
    if (keepTerms.some((k) => n.includes(k))) return true;
    return !excludeTerms.some((t) => n.includes(t));
  };
  const matchesAnyTerm = (item, candidateTerms = terms) => {
    const recorded = item.term ?? item.model;
    if (recorded && candidateTerms.some((t) => normalizeCode(t) === normalizeCode(recorded))) return true;
    return candidateTerms.some((t) => textMatchesTerm(item.title ?? "", t));
  };
  // Filtro arbitrário por item (recebe { title, price_brl }) — para regras que
  // dependem de múltiplos atributos juntos, ex.: faixa de preço condicional à cor
  // ou tamanho declarado no título. Default: aceita tudo.
  const itemFilter = config.itemFilter ?? (() => true);

  const now = new Date();
  const runDate = now.toISOString().slice(0, 10);
  const runId = now.toISOString().replace(/[:.]/g, "-");

  const previousSnapshotPath = await getLatestSnapshotPath(dataDir);
  const previousSnapshot = previousSnapshotPath ? await readJsonSafe(previousSnapshotPath) : null;

  const sizeLabel = (minSizeMl != null || maxSizeMl != null)
    ? ` | ${minSizeMl ?? 0}–${maxSizeMl ?? "∞"} ml`
    : "";
  console.log(`Execução ${label}: ${now.toISOString()}`);
  console.log(`Termos: ${terms.join(", ")} | R$ ${minPrice}–R$ ${maxPrice}${sizeLabel}`);
  console.log(`Snapshot anterior: ${previousSnapshotPath ?? "(nenhum)"}\n`);

  const collected = [];
  const errors = [];
  // "source:term" que falharam nesta rodada (cobertura incompleta). Usado para
  // NÃO rebaixar a not_seen os itens correspondentes do snapshot anterior.
  const failedSourceTerms = new Set();

  if (!skipEnjoei) {
    try {
      const { items, failedTerms } = await collectEnjoei({ terms, slug, inRange, sizeOk, notExcluded, itemFilter });
      collected.push(...items);
      for (const t of failedTerms) { failedSourceTerms.add(`Enjoei:${t}`); errors.push(`Enjoei termo "${t}" falhou`); }
    } catch (error) {
      console.warn(`Aviso: coleta Enjoei falhou — ${error.message}`);
      errors.push(`Enjoei: ${error.message}`);
      for (const t of terms) failedSourceTerms.add(`Enjoei:${t}`); // coleta inteira falhou
    }
  }

  if (!skipOlx) {
    try {
      const categoryUrls = (config.olxCategoryUrls && config.olxCategoryUrls.length)
        ? config.olxCategoryUrls
        : [OLX_BASE_URL];
      const { items, failedTerms } = await collectOlx({ terms, categoryUrls, userDataDir, headless, visible, inRange, sizeOk, notExcluded, itemFilter });
      collected.push(...items);
      for (const t of failedTerms) { failedSourceTerms.add(`OLX:${t}`); errors.push(`OLX termo "${t}" falhou`); }
    } catch (error) {
      console.warn(`Aviso: coleta OLX falhou — ${error.message}`);
      errors.push(`OLX: ${error.message}`);
      for (const t of terms) failedSourceTerms.add(`OLX:${t}`); // coleta inteira falhou
    }
  }

  const deduped = dedupeMonitorItems(collected);

  const previousItemsInScope = (previousSnapshot?.items ?? []).filter(
    (i) => (i.price_brl == null || inRange(i.price_brl))
      && sizeOk(i.title ?? "")
      && notExcluded(i.title ?? "")
      && itemFilter({ title: i.title ?? "", price_brl: i.price_brl })
  );
  const configuredSources = ["Enjoei", "OLX"];
  const scheduledSources = configuredSources.filter((source) =>
    (source === "Enjoei" && !skipEnjoei) || (source === "OLX" && !skipOlx)
  );
  const configuredCoverage = configuredSources.flatMap((source) =>
    configuredTerms.map((term) => `${source}:${term}`)
  );
  const scheduledCoverage = scheduledSources.flatMap((source) =>
    terms.map((term) => `${source}:${term}`)
  );
  const successfulCoverage = scheduledCoverage.filter((key) => !failedSourceTerms.has(key));
  const snapshot = mergeMonitorSnapshot({
    collected: deduped,
    previousSnapshot: previousSnapshot ? { ...previousSnapshot, items: previousItemsInScope } : null,
    now,
    run: {
      id: slug,
      label,
      partial: errors.length > 0 || scheduledCoverage.length < configuredCoverage.length,
      errors,
    },
    filters: {
      price_brl: { min: minPrice, max: maxPrice },
      size_ml: { min: minSizeMl, max: maxSizeMl },
    },
    configuredCoverage,
    scheduledCoverage,
    successfulCoverage,
    failedCoverage: [...failedSourceTerms],
    itemCoverage: (item) => item.source && item.term ? [`${item.source}:${item.term}`] : [],
  });
  snapshot.price_range_brl = { min: minPrice, max: maxPrice };

  await fs.mkdir(dataDir, { recursive: true });
  const snapshotPath = path.join(dataDir, `snapshot-${runId}.json`);
  await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");

  const report = buildReport({ label, runDate, snapshot, previousItems: previousItemsInScope, errors, terms, minPrice, maxPrice });
  const reportPath = path.join(dataDir, `report-${runId}.md`);
  await fs.writeFile(reportPath, report, "utf8");

  console.log(`\nColetados: ${deduped.length} | Snapshot: ${snapshotPath}`);
  console.log(`Relatório: ${reportPath}`);
  if (errors.length) process.exitCode = 1;
}

// ── Enjoei (API GraphQL) ───────────────────────────────────────────────────────

async function collectEnjoei({ terms, slug, inRange, sizeOk, notExcluded, itemFilter }) {
  const out = [];
  const failedTerms = new Set();
  for (let i = 0; i < terms.length; i += 1) {
    const term = terms[i];
    if (i > 0) await sleep(400);
    console.log(`Enjoei termo: ${term}`);
    // try/catch por termo: a falha de um termo não pode abortar os demais nem
    // (via merge) marcar como "not_seen" itens que apenas não foram coletados.
    try {
      const response = await fetchWithRetry(buildEnjoeiApiUrl(term, slug), {
        headers: {
          accept: "application/json",
          origin: ENJOEI_SITE_ORIGIN,
          referer: `${ENJOEI_SITE_ORIGIN}/${encodeURIComponent(term)}/s?q=${encodeURIComponent(term)}`,
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
        if (!Number.isFinite(price) || !inRange(price)) continue;
        if (!textMatchesTerm(`${title} ${brand}`, term)) continue;
        if (!sizeOk(`${title} ${brand}`)) continue;
        if (!notExcluded(`${title} ${brand}`)) continue;
        if (!itemFilter({ title: `${title} ${brand}`, price_brl: price })) continue;
        out.push({
          id: `enjoei-${node.id}`,
          url: `${ENJOEI_SITE_ORIGIN}/p/${node.path}`,
          title,
          source: "Enjoei",
          term,
          price_brl: price,
          store_name: node.store?.displayable?.name ?? null,
          status: "active",
          first_seen: null,
          last_seen: null,
        });
      }
    } catch (error) {
      console.warn(`  Aviso: termo Enjoei "${term}" falhou — ${error.message}`);
      failedTerms.add(term);
    }
  }
  return { items: out, failedTerms };
}

function buildEnjoeiApiUrl(term, slug) {
  const url = new URL(ENJOEI_SEARCH_ENDPOINT);
  const ts = Date.now();
  url.searchParams.set("browser_id", `codex-${slug}-${ts}`);
  url.searchParams.set("experienced_seller", "true");
  url.searchParams.set("first", "30");
  url.searchParams.set("operation_name", "searchProducts");
  url.searchParams.set("query_id", "c5faa5f85fb47bf0beaa97b67d8a9189");
  url.searchParams.set("search_context", "products_search");
  url.searchParams.set("search_id", `codex-${slug}-search-${ts}`);
  url.searchParams.set("shipping_range", "same_country");
  url.searchParams.set("term", term);
  return url;
}

// ── OLX (Playwright) ───────────────────────────────────────────────────────────

async function collectOlx({ terms, categoryUrls, userDataDir, headless, visible, inRange, sizeOk, notExcluded, itemFilter }) {
  const isCI = Boolean(process.env.CI);
  // Local, por padrão a janela roda FORA DA TELA (não atrapalha o trabalho).
  // --visible mostra maximizada (útil para depurar/resolver Cloudflare).
  const localArgs = visible
    ? ["--start-maximized", "--disable-blink-features=AutomationControlled"]
    : ["--window-position=-32000,-32000", "--window-size=1280,900", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-blink-features=AutomationControlled"];
  const launchOptions = {
    headless: headless || isCI,
    viewport: null,
    locale: "pt-BR",
    args: isCI
      ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--window-size=1280,900", "--disable-blink-features=AutomationControlled"]
      : localArgs,
  };
  if (!isCI) launchOptions.channel = "chrome";
  if (isCI) {
    launchOptions.userAgent =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  }

  const context = await chromium.launchPersistentContext(userDataDir, launchOptions);
  await context.addInitScript(() => {
    try { delete Object.getPrototypeOf(navigator).webdriver; } catch (_) {}
  });
  await context.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (["image", "media", "font"].includes(type)) return route.abort();
    return route.continue();
  }).catch(() => {});

  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(60_000);

  const out = [];
  const failedTerms = new Set();
  try {
    for (const categoryUrl of categoryUrls) {
      for (const term of terms) {
        const url = `${categoryUrl}?q=${encodeURIComponent(term)}`;
        console.log(`OLX termo: ${term} -> ${url}`);
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
          await waitOutCloudflare(page, headless);
          const hasCards = await waitForListing(page);
          if (!hasCards) {
            console.log("  Nenhum card.");
            continue;
          }
          const cards = await collectCards(page);
          for (const card of cards) {
            if (!inRange(card.price_brl)) continue;
            if (!textMatchesTerm(card.title, term)) continue;
            if (!sizeOk(card.title)) continue;
            if (!notExcluded(card.title)) continue;
            if (!itemFilter({ title: card.title, price_brl: card.price_brl })) continue;
            out.push({
              id: extractOlxId(card.url) ?? card.url,
              url: card.url,
              title: card.title,
              source: "OLX",
              term,
              price_brl: card.price_brl,
              location: card.location ?? null,
              status: "active",
              first_seen: null,
              last_seen: null,
            });
          }
        } catch (error) {
          console.warn(`  Aviso: termo "${term}" em ${categoryUrl} falhou — ${error.message}`);
          failedTerms.add(term);
        }
      }
    }
  } finally {
    await context.close().catch(() => {});
  }
  return { items: out, failedTerms };
}

async function waitOutCloudflare(page, headless) {
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

// Compara termos ignorando caixa, acentos e separadores (espaço, hífen, ponto):
// "SD25 TB4" casa "SD25TB4"; "Fitbit Air" casa "fitbit-air".
function normalizeCode(text) {
  return normalizeMonitorCode(text);
}

function textMatchesTerm(text, term) {
  return normalizeCode(text).includes(normalizeCode(term));
}

// Normaliza preservando espaços (lowercase, sem acentos) — para casar termos de
// exclusão por palavra, ex.: "mamadeira" em "mamadeira de vidro".
function normalizeText(text) {
  return normalizeMonitorText(text);
}

// Extrai a capacidade declarada no texto em ml. Aceita "500ml", "500 ml",
// "1l", "1,5 litros", "0,5L". Retorna null quando não há indicação.
export function extractCapacityMl(text) {
  const t = (text ?? "").toString().toLowerCase();
  const ml = t.match(/(\d{2,4})\s*ml\b/);
  if (ml) return Number(ml[1]);
  const lit = t.match(/(\d+(?:[.,]\d+)?)\s*(?:l\b|lt\b|litros?\b)/);
  if (lit) {
    const v = Number(lit[1].replace(",", "."));
    if (Number.isFinite(v)) return Math.round(v * 1000);
  }
  return null;
}

// ── relatório ───────────────────────────────────────────────────────────────────

function buildReport({ label, runDate, snapshot, previousItems, errors, terms, minPrice, maxPrice }) {
  const currentItems = snapshot.items.filter((i) => i.status === "active");
  const previousById = new Map(previousItems.map((i) => [i.id ?? i.url, i]));
  const currentById = new Map(currentItems.map((i) => [i.id ?? i.url, i]));

  const { newItems, priceChanges: sharedPriceChanges } = buildMonitorChanges(
    { items: previousItems },
    snapshot,
    { reactivationIsNew: false },
  );
  const stillActive = currentItems.filter((i) => previousById.has(i.id ?? i.url));
  const notSeen = previousItems
    .filter((i) => i.status === "active")
    .filter((i) => !currentById.has(i.id ?? i.url));

  const priceChanges = sharedPriceChanges.map((item) => ({
    item,
    from: item.previous_price_brl,
    to: item.price_brl,
  }));

  const range = minPrice > 0 ? `R$ ${fmtBrl(minPrice)}–R$ ${fmtBrl(maxPrice)}` : `até R$ ${fmtBrl(maxPrice)}`;
  const lines = [];
  lines.push(`# Monitor ${label} ${range} — ${runDate}`);
  lines.push("");
  lines.push("## Resumo executivo");
  lines.push(`- Novos produtos: **${newItems.length}**`);
  lines.push(`- Já vistos e ativos: **${stillActive.length}**`);
  lines.push(`- Não vistos nesta rodada: **${notSeen.length}**`);
  lines.push(`- Alterações de preço: **${priceChanges.length}**`);
  lines.push(`- Termos: ${terms.join(", ")}`);
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
  const term = item.term ?? item.model;
  const termLabel = term ? ` (${term})` : "";
  const loc = item.location ? ` — ${item.location}` : "";
  return `- R$ ${fmtBrl(item.price_brl)} — ${src} ${item.title}${termLabel}${loc} — ${item.url}`;
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
