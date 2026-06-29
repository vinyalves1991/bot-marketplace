import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  parseBrlPrice,
  extractRamGb,
  extractStorageGb,
  extractGpuLabel,
  normalizeCpuText,
  textContainsCpuTerm,
  has32GbRam,
  isNotebookCategoryUrl,
  extractOlxId,
  normalizeText,
} from "./lib/parsers.mjs";
import { mergeWithPreviousSnapshot as _mergeItems } from "./lib/snapshot.mjs";
import { DEFAULT_CPU_TERMS, cpuSearchQuery } from "./lib/cpu-terms.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "..");
const automationRoot = process.env.OLX_DATA_DIR ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".codex", "automations", "monitor-olx-notebooks-por-cpu");

const USER_DATA_DIR = path.join(workspaceRoot, ".chrome-olx-profile");
const REAL_CHROME_USER_DATA_DIR = path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "User Data");
const DEFAULT_CDP_URL = "http://127.0.0.1:9222";
const BASE_URL = "https://www.olx.com.br/brasil/informatica/notebooks";

const PRICE_MIN_BRL = 2000;
const PRICE_MAX_BRL = 8000;
// Mudanças de preço aparecem para itens até este teto (novos só vão até
// PRICE_MAX_BRL). Acima disso não interessa acompanhar variação.
const PRICE_CHANGE_MAX_BRL = 10000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const DETAIL_TIMEOUT_MS = 25_000;
const RAW_SCROLL_DELAY_MS = Number(process.env.OLX_SCROLL_DELAY_MS ?? 350);
const RAW_STABLE_ROUNDS = Number(process.env.OLX_STABLE_ROUNDS ?? 2);


const EXCLUDE_PATTERNS = [
  "sucata",
  "defeito",
  "avaria",
  "quebrado",
  "quebrada",
  "placa-mãe",
  "placa mae",
  "placa mãe",
  "motherboard",
  "carcaça",
  "carcaca",
  "peças",
  "pecas",
  "reparo",
  "conserto",
  "não liga",
  "nao liga",
  "não ligou",
  "nao ligou",
  "não funciona",
  "nao funciona",
  "surto elétrico",
  "surto eletrico",
  "queimou",
  "queimada",
  "retirada de peças",
  "retirada de pecas",
  "problema",
  "mini pc",
  "mini-pc",
  "desktop",
  "computador de mesa",
];

const args = process.argv.slice(2);
const headless = args.includes("--headless");
const visible = args.includes("--visible"); // mostra a janela (padrão: fora da tela, não atrapalha o trabalho)
const maxAdsPerCpu = Number(getOptionValue(args, "--max-per-cpu") ?? 20);
const debug = args.includes("--debug");
const forceOpenDetails = args.includes("--open-details");
const listingOnly = args.includes("--listing-only");
const cpuArg = getOptionValue(args, "--cpu");
const cpuTerms = cpuArg ? cpuArg.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : DEFAULT_CPU_TERMS;
const useCurrentChrome = args.includes("--current-chrome");
const useRealProfile = args.includes("--real-profile");
const profileDirectory = getOptionValue(args, "--profile-directory") ?? "Default";
const cdpUrl = getOptionValue(args, "--cdp-url") ?? process.env.CHROME_CDP_URL ?? DEFAULT_CDP_URL;
const blockAssets = !args.includes("--load-assets");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`\nFalha: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

async function main() {
  const now = new Date();
  const runDate = now.toISOString().slice(0, 10);
  const runTimestamp = now.toISOString();
  const runId = runTimestamp.replace(/[:.]/g, "-");

  const previousSnapshotPath = await getLatestSnapshotPath(automationRoot);
  const previousSnapshot = previousSnapshotPath ? await readJsonSafe(previousSnapshotPath) : null;

  console.log(`Execução: ${runTimestamp}`);
  console.log(`Snapshot anterior: ${previousSnapshotPath ?? "(nenhum)"}`);
  console.log(`Perfil: ${USER_DATA_DIR}`);
  console.log("");

  if (useCurrentChrome && !args.includes("--playwright-cdp")) {
    await runWithRawCdp({ cdpUrl, runDate, runTimestamp, previousSnapshot });
    return;
  }

  const { page, close } = useCurrentChrome
    ? await connectToCurrentChrome(cdpUrl)
    : useRealProfile
    ? await launchRealChromeProfile(profileDirectory, headless)
    : await launchDedicatedChromeProfile(headless);

  try {
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(60000);
    if (blockAssets) {
      await installPlaywrightRequestBlocking(page.context());
    }

    const collected = [];
    for (const term of cpuTerms) {
      const results = await collectForCpuTerm(page, term, maxAdsPerCpu, previousSnapshot);
      collected.push(...results);
    }

    const snapshot = mergeWithPreviousSnapshot({
      runDate,
      collected,
      previousSnapshot,
    });

    const snapshotPath = path.join(automationRoot, `snapshot-${runId}.json`);
    await fs.mkdir(automationRoot, { recursive: true });
    await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");

    const report = buildReport({
      runDate,
      snapshot,
      previousSnapshot,
      priceMin: PRICE_MIN_BRL,
      priceMax: PRICE_MAX_BRL,
    });

    const reportPath = path.join(automationRoot, `report-${runId}.md`);
    await fs.writeFile(reportPath, report, "utf8");

    console.log(`Snapshot salvo: ${snapshotPath}`);
    console.log(`Relatório salvo: ${reportPath}`);
  } finally {
    await close();
  }
}

async function runWithRawCdp({ cdpUrl, runDate, runTimestamp, previousSnapshot }) {
  const collected = [];
  const tab = await openOrReuseCdpTab(cdpUrl);
  try {
    await tab.send("Page.enable");
    await tab.send("Runtime.enable");
    if (blockAssets) {
      await installRawRequestBlocking(tab);
    }

    for (const term of cpuTerms) {
      const results = await collectForCpuTermRawCdp(tab, term, maxAdsPerCpu, previousSnapshot);
      collected.push(...results);
    }
  } finally {
    await tab.closeTab();
  }

  const snapshot = mergeWithPreviousSnapshot({
    runDate,
    collected,
    previousSnapshot,
  });

  const runId = runTimestamp.replace(/[:.]/g, "-");
  const snapshotPath = path.join(automationRoot, `snapshot-${runId}.json`);
  await fs.mkdir(automationRoot, { recursive: true });
  await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");

  const report = buildReport({
    runDate,
    snapshot,
    previousSnapshot,
    priceMin: PRICE_MIN_BRL,
    priceMax: PRICE_MAX_BRL,
  });

  const reportPath = path.join(automationRoot, `report-${runId}.md`);
  await fs.writeFile(reportPath, report, "utf8");

  console.log(`Snapshot salvo: ${snapshotPath}`);
  console.log(`Relatório salvo: ${reportPath}`);
}

async function launchDedicatedChromeProfile(headlessMode) {
  const isCI = Boolean(process.env.CI);
  const launchOptions = {
    headless: headlessMode,
    viewport: null,
    locale: "pt-BR",
    args: isCI
      ? [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--window-size=1280,900",
          "--disable-blink-features=AutomationControlled",
        ]
      : visible
        ? ["--start-maximized", "--disable-blink-features=AutomationControlled"]
        // Fora da tela por padrão (não atrapalha o trabalho); janela "real" para o Cloudflare.
        : ["--window-position=-32000,-32000", "--window-size=1280,900", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-blink-features=AutomationControlled"],
  };
  if (!isCI) launchOptions.channel = "chrome";
  if (isCI) {
    launchOptions.userAgent =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  }

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, launchOptions);
  // Remove navigator.webdriver to reduce bot-detection signal.
  await context.addInitScript(() => {
    try { delete Object.getPrototypeOf(navigator).webdriver; } catch (_) {}
  });
  return { page: context.pages()[0] ?? (await context.newPage()), close: () => context.close() };
}

async function launchRealChromeProfile(selectedProfileDirectory, headlessMode) {
  const chromeArgs = [
    ...(visible
      ? ["--start-maximized"]
      : ["--window-position=-32000,-32000", "--window-size=1280,900", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"]),
    `--profile-directory=${selectedProfileDirectory}`,
  ];
  const context = await chromium.launchPersistentContext(REAL_CHROME_USER_DATA_DIR, {
    channel: "chrome",
    headless: headlessMode,
    viewport: null,
    locale: "pt-BR",
    args: chromeArgs,
  });
  const page = context.pages()[0] ?? (await context.newPage());
  return { page, close: () => context.close() };
}

async function connectToCurrentChrome(cdpEndpoint) {
  let browser;
  try {
    browser = await chromium.connectOverCDP(cdpEndpoint);
  } catch {
    throw new Error(
      `Não consegui conectar ao Chrome atual em ${cdpEndpoint}. Abra o Chrome com depuração remota (scripts\\\\start-chrome-debug.ps1) e tente novamente com --current-chrome.`
    );
  }

  const context = browser.contexts()[0];
  if (!context) {
    throw new Error("Conectei ao Chrome, mas não encontrei nenhum contexto de navegador.");
  }

  const page = context.pages()[0] ?? (await context.newPage());
  return { page, close: async () => {} };
}

async function collectForCpuTerm(page, cpuTerm, maxCards, previousSnapshot) {
  const query = encodeURIComponent(cpuSearchQuery(cpuTerm));
  const url = `${BASE_URL}?q=${query}&sp=1&opst=2`;
  console.log(`\nCPU: ${cpuTerm} -> ${url}`);

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
  await waitOutCloudflareIfNeeded(page);
  const hasCards = await waitForListingReadinessPlaywright(page);
  if (!hasCards) {
    if (debug) console.log("  Nenhum card encontrado na primeira pagina.");
    return [];
  }

  const cards = await collectCardsFromInfiniteScroll(page, maxCards);
  if (debug) {
    console.log(`  Cards brutos: ${cards.length}`);
  }

  const candidates = [];
  for (const card of cards) {
    if (!card.url || !card.title || card.price_brl == null) continue;
    if (!isNotebookCategoryUrl(card.url)) continue;
    if (hasExcludedKeyword(`${card.title}\n${card.text ?? ""}`)) continue;
    if (!textContainsCpuTerm(`${card.title}\n${card.text ?? ""}`, cpuTerm)) continue;
    candidates.push({ ...card, cpu_term: cpuTerm });
  }

  candidates.sort((a, b) => (a.price_brl ?? 0) - (b.price_brl ?? 0));

  const inRange = candidates.filter((c) => c.price_brl >= PRICE_MIN_BRL && c.price_brl <= PRICE_MAX_BRL);
  const aboveRange = candidates.filter((c) => c.price_brl > PRICE_MAX_BRL);
  const openLimit = Math.min(maxCards, Math.max(inRange.length, 6) + 10);
  const toOpen = [...inRange, ...aboveRange.slice(0, 12)].slice(0, openLimit);

  if (listingOnly) {
    return toOpen.map(listingCardToItem).sort((a, b) => (a.price_brl ?? 0) - (b.price_brl ?? 0));
  }

  const validated = [];
  for (let index = 0; index < toOpen.length; index += 1) {
    const card = toOpen[index];
    const listingItem = listingCardToItem(card);
    const reusable = forceOpenDetails ? null : getReusablePreviousEnrichedItem(previousSnapshot, card);
    if (reusable) {
      validated.push(reusable);
      if (validated.length >= maxCards) break;
      continue;
    }
    // Abre o detalhe também quando o item está na faixa do relatório, mesmo com
    // specs completas, para verificar a descrição contra defeitos (EXCLUDE_PATTERNS).
    // Muitos anúncios só declaram "não liga / defeito / avaria" no corpo, não no
    // título — sem abrir, passariam direto para a notificação.
    const inReportRange = listingItem.price_brl != null && listingItem.price_brl >= PRICE_MIN_BRL && listingItem.price_brl <= PRICE_MAX_BRL;
    const shouldOpen = forceOpenDetails || needsDetailEnrichment(listingItem) || inReportRange;
    if (!shouldOpen) {
      validated.push(listingItem);
      if (validated.length >= maxCards) break;
      continue;
    }
    if (debug) {
      console.log(`  Abrindo candidato ${index + 1}/${toOpen.length}: R$ ${card.price_brl} - ${card.title}`);
    }
    try {
      const enriched = await withTimeout(enrichAd(page, card), DETAIL_TIMEOUT_MS, `timeout ao abrir anúncio ${card.url}`);
      validated.push(enriched ?? listingItem);
      if (validated.length >= maxCards) break;
    } catch (error) {
      console.warn(`  Aviso: pulei anúncio por falha (${error.message}): ${card.url}`);
      validated.push(listingItem);
      if (validated.length >= maxCards) break;
    }
  }

  // If OLX is sorted by lowest price, we can stop early when the cheapest valid is already > 4k and we already captured a few.
  validated.sort((a, b) => (a.price_brl ?? 0) - (b.price_brl ?? 0));
  return validated;
}

async function collectForCpuTermRawCdp(tab, cpuTerm, maxCards, previousSnapshot) {
  const query = encodeURIComponent(cpuSearchQuery(cpuTerm));
  const url = `${BASE_URL}?q=${query}&sp=1&opst=2`;
  console.log(`\nCPU: ${cpuTerm} -> ${url}`);

  await navigateRawCdp(tab, url);
  await waitForRawLocation(tab, url);
    const hasCards = await waitForRawCardsFast(tab);
    if (!hasCards) {
      if (debug) console.log("  Nenhum card encontrado na primeira página.");
      return [];
    }
    const cards = await collectCardsRawCdp(tab, maxCards);
    if (debug) {
      console.log(`  Cards brutos: ${cards.length}`);
    }

    const candidates = cards
      .filter((card) => card.url && card.title && card.price_brl != null)
      .filter((card) => isNotebookCategoryUrl(card.url))
      .filter((card) => !hasExcludedKeyword(`${card.title}\n${card.text ?? ""}`))
      .filter((card) => textContainsCpuTerm(`${card.title}\n${card.text ?? ""}`, cpuTerm))
      .map((card) => ({ ...card, cpu_term: cpuTerm }))
      .sort((a, b) => (a.price_brl ?? 0) - (b.price_brl ?? 0));

    const inRange = candidates.filter((c) => c.price_brl >= PRICE_MIN_BRL && c.price_brl <= PRICE_MAX_BRL);
    const aboveRange = candidates.filter((c) => c.price_brl > PRICE_MAX_BRL);
    const openLimit = Math.min(maxCards, Math.max(inRange.length, 6) + 10);
    const toOpen = [...inRange, ...aboveRange.slice(0, 12)].slice(0, openLimit);

    if (listingOnly) {
      return toOpen.map(listingCardToItem).sort((a, b) => (a.price_brl ?? 0) - (b.price_brl ?? 0));
    }

    const validated = [];
    for (let index = 0; index < toOpen.length; index += 1) {
      const card = toOpen[index];
      const listingItem = listingCardToItem(card);
      const reusable = forceOpenDetails ? null : getReusablePreviousEnrichedItem(previousSnapshot, card);
      if (reusable) {
        validated.push(reusable);
        if (validated.length >= maxCards) break;
        continue;
      }
      // Mesmo motivo da versão Playwright: in-range sempre abre para checar
      // defeitos declarados apenas na descrição.
      const inReportRange = listingItem.price_brl != null && listingItem.price_brl >= PRICE_MIN_BRL && listingItem.price_brl <= PRICE_MAX_BRL;
      const shouldOpen = forceOpenDetails || needsDetailEnrichment(listingItem) || inReportRange;
      if (!shouldOpen) {
        validated.push(listingItem);
        if (validated.length >= maxCards) break;
        continue;
      }
      if (debug) {
        console.log(`  Abrindo candidato ${index + 1}/${toOpen.length}: R$ ${card.price_brl} - ${card.title}`);
      }
      try {
        const enriched = await enrichAdRawCdp(cdpUrl, card);
        validated.push(enriched ?? listingItem);
        if (validated.length >= maxCards) break;
      } catch (error) {
        console.warn(`  Aviso: pulei anúncio por falha (${error.message}): ${card.url}`);
        validated.push(listingItem);
        if (validated.length >= maxCards) break;
      }
    }
    return validated.sort((a, b) => (a.price_brl ?? 0) - (b.price_brl ?? 0));
}

async function openOrReuseCdpTab(cdpEndpoint, url = "about:blank") {
  const origin = cdpOrigin(cdpEndpoint);
  const target = await fetchJson(`${origin}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  return connectRawCdpTarget(target, origin);
}

async function connectRawCdpTarget(target, origin) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject, timer } = pending.get(message.id);
    clearTimeout(timer);
    pending.delete(message.id);
    if (message.error) {
      reject(new Error(message.error.message));
    } else {
      resolve(message);
    }
  };

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout ao conectar no WebSocket CDP")), 10_000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("falha no WebSocket CDP"));
    };
  });

  const send = (method, params = {}, timeoutMs = 15_000) =>
    new Promise((resolve, reject) => {
      const message = { id: ++id, method, params };
      const timer = setTimeout(() => {
        pending.delete(message.id);
        reject(new Error(`timeout CDP em ${method}`));
      }, timeoutMs);
      pending.set(message.id, { resolve, reject, timer });
      ws.send(JSON.stringify(message));
    });

  return {
    target,
    send,
    close: () => {
      ws.close();
    },
    closeTab: async () => {
      ws.close();
      await fetch(`${origin}/json/close/${target.id}`).catch(() => {});
    },
  };
}

async function waitForRawCardsFast(tab) {
  const started = Date.now();
  while (Date.now() - started < 6_000) {
    const title = await rawEvaluate(tab, "document.title").catch(() => "");
    if (/cloudflare|attention required/i.test(title ?? "")) {
      await delay(2500);
      continue;
    }

    const count = await rawEvaluate(tab, "document.querySelectorAll('section.olx-adcard').length").catch(() => 0);
    if (Number(count) > 0) return true;

    const bodyText = await rawEvaluate(tab, "document.body?.innerText?.slice(0, 1500) || ''").catch(() => "");
    if (/0\s+resultados?|nao encontramos|sem resultados|nenhum resultado/i.test(normalizeText(bodyText))) return false;

    const readyState = await rawEvaluate(tab, "document.readyState").catch(() => "");
    if (readyState === "complete" && Date.now() - started > 3_500) return false;

    await delay(700);
  }
  return false;
}

async function collectCardsRawCdp(tab, maxCards) {
  const results = [];
  let stableRounds = 0;
  let lastCount = 0;
  let totalResults = null;

  while (results.length < maxCards && stableRounds < RAW_STABLE_ROUNDS) {
    const payload = await rawEvaluate(
      tab,
      `(()=>{const text=document.body?.innerText||''; const total=(text.match(/\\d+\\s*-\\s*\\d+\\s*de\\s*(\\d+)\\s+resultados?/i)||text.match(/(?:^|\\n)\\s*(\\d+)\\s+resultados?/i)||[])[1]; const items=Array.from(document.querySelectorAll('section.olx-adcard')).map(card=>{const a=card.querySelector('[data-testid=adcard-link]'); return {title:a?.getAttribute('title')||a?.textContent?.trim()||'', url:a?.href||'', priceText:card.querySelector('h3.olx-adcard__price')?.textContent?.trim()||'', location:card.querySelector('.olx-adcard__location')?.textContent?.trim()||'', text:card.innerText||''};}); return {totalResults: total ? Number(total) : null, items};})()`
    );
    const batch = payload?.items ?? [];
    if (Number.isFinite(payload?.totalResults)) {
      totalResults = payload.totalResults;
    }

    const seen = new Set(results.map((item) => item.url));
    for (const item of batch ?? []) {
      const normalized = {
        title: item.title?.trim(),
        url: item.url,
        price_brl: parseBrlPrice(item.priceText),
        location: item.location?.trim() || null,
        text: item.text || "",
        ram_gb: extractRamGb(`${item.title}\n${item.text}`),
        storage_gb: extractStorageGb(`${item.title}\n${item.text}`),
      };
      if (normalized.url && normalized.title && normalized.price_brl != null && !seen.has(normalized.url)) {
        results.push(normalized);
      }
    }

    if (results.length === lastCount) {
      stableRounds += 1;
    } else {
      lastCount = results.length;
      stableRounds = 0;
    }

    if (results.length >= maxCards) break;
    if (totalResults != null && results.length >= totalResults) break;
    if ((batch?.length ?? 0) === 0) break;

    await rawEvaluate(tab, "window.scrollBy(0, 2200); undefined");
    await delay(RAW_SCROLL_DELAY_MS);
  }

  return results.slice(0, maxCards);
}

async function enrichAdRawCdp(cdpEndpoint, card) {
  const tab = await openOrReuseCdpTab(cdpEndpoint);
  try {
    await tab.send("Page.enable");
    await tab.send("Runtime.enable");
    if (blockAssets) {
      await installRawRequestBlocking(tab);
    }
    await navigateRawCdp(tab, card.url);
    await waitForRawBody(tab);
    const bodyText = (await rawEvaluate(tab, "document.body?.innerText || ''")) ?? "";
    const title = card.title;
    const detailText = `${title}\n${bodyText}`;

    if (hasExcludedKeyword(title) || hasExcludedKeyword(bodyText)) return null;
    if (!textContainsCpuTerm(detailText, card.cpu_term)) return null;

    return {
      id: extractOlxId(card.url),
      url: card.url,
      title,
      cpu_term: card.cpu_term,
      price_brl: parseBrlPrice(bodyText) ?? card.price_brl,
      ram_gb: extractRamGb(detailText),
      storage_gb: extractStorageGb(detailText),
      gpu: extractGpuLabel(detailText),
      location: extractLocationFromText(bodyText),
      condition: extractConditionFromText(bodyText),
      status: "active",
      first_seen: null,
      last_seen: null,
      notes: null,
      desc_checked: true,
    };
  } finally {
    await tab.closeTab();
  }
}

async function waitForRawBody(tab) {
  const started = Date.now();
  while (Date.now() - started < DETAIL_TIMEOUT_MS) {
    const textLength = await rawEvaluate(tab, "document.body?.innerText?.length || 0").catch(() => 0);
    if (Number(textLength) > 800) return;
    await delay(800);
  }
  throw new Error("não consegui ler o corpo do anúncio");
}

function listingCardToItem(card) {
  const listingText = `${card.title}\n${card.text ?? ""}`;
  return {
    id: extractOlxId(card.url),
    url: card.url,
    title: card.title,
    cpu_term: card.cpu_term,
    price_brl: card.price_brl,
    ram_gb: card.ram_gb ?? extractRamGb(listingText),
    storage_gb: card.storage_gb ?? extractStorageGb(listingText),
    gpu: card.gpu ?? extractGpuLabel(listingText),
    location: card.location ?? null,
    condition: null,
    status: "active",
    first_seen: null,
    last_seen: null,
    notes: listingOnly ? "Validado apenas pela página de listagem; descrição do anúncio não foi aberta." : null,
  };
}

function needsDetailEnrichment(item) {
  // GPU is opportunistic: capture it from listing or cached details, but do not open an ad only for GPU.
  return item.ram_gb == null || item.storage_gb == null;
}

function getReusablePreviousEnrichedItem(previousSnapshot, card) {
  const current = listingCardToItem(card);
  const key = current.id ?? current.url;
  const previous = (previousSnapshot?.items ?? []).find((item) => (item.id ?? item.url) === key);
  if (!previous) return null;
  if ((previous.notes ?? "").includes("Validado apenas")) return null;

  // Não reusa item da faixa do relatório cuja descrição nunca foi verificada
  // (snapshots antigos, anteriores à checagem de defeito): força reabrir para
  // que EXCLUDE_PATTERNS rode sobre o corpo do anúncio.
  const inReportRange = current.price_brl != null && current.price_brl >= PRICE_MIN_BRL && current.price_brl <= PRICE_MAX_BRL;
  if (inReportRange && !previous.desc_checked) return null;

  const merged = {
    ...previous,
    ...current,
    ram_gb: current.ram_gb ?? previous.ram_gb ?? null,
    storage_gb: current.storage_gb ?? previous.storage_gb ?? null,
    gpu: current.gpu ?? previous.gpu ?? null,
    condition: previous.condition ?? current.condition ?? null,
    notes: previous.notes,
    desc_checked: previous.desc_checked ?? false,
    status: "active",
  };
  return needsDetailEnrichment(merged) ? null : merged;
}

async function rawEvaluate(tab, expression) {
  const response = await tab.send("Runtime.evaluate", { expression, returnByValue: true }, 20_000);
  if (response.result?.exceptionDetails) {
    throw new Error(response.result.exceptionDetails.text || "erro ao avaliar JavaScript na página");
  }
  return response.result?.result?.value;
}

async function navigateRawCdp(tab, url) {
  await tab.send("Page.navigate", { url }, NAVIGATION_TIMEOUT_MS);
}

async function waitForRawLocation(tab, expectedUrl) {
  const expected = new URL(expectedUrl);
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    const href = await rawEvaluate(tab, "location.href").catch(() => "");
    if (href) {
      try {
        const current = new URL(href);
        if (
          current.origin === expected.origin &&
          current.pathname === expected.pathname &&
          current.searchParams.get("q") === expected.searchParams.get("q")
        ) {
          return;
        }
      } catch {
        // Chrome can expose transient URLs while the document is changing.
      }
    }
    await delay(150);
  }
}

async function installRawRequestBlocking(tab) {
  await tab.send("Network.enable").catch(() => {});
  await tab
    .send("Network.setBlockedURLs", {
      urls: [
        "*.png",
        "*.jpg",
        "*.jpeg",
        "*.webp",
        "*.gif",
        "*.svg",
        "*.ico",
        "*.mp4",
        "*.webm",
        "*.woff",
        "*.woff2",
        "*.ttf",
        "*.otf",
        "*googletagmanager.com/*",
        "*google-analytics.com/*",
        "*doubleclick.net/*",
        "*facebook.net/*",
      ],
    })
    .catch(() => {});
}

async function installPlaywrightRequestBlocking(context) {
  await context
    .route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["image", "media", "font"].includes(type)) {
        return route.abort();
      }
      return route.continue();
    })
    .catch(() => {});
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`falha HTTP ${response.status} em ${url}`);
  return response.json();
}

function cdpOrigin(cdpEndpoint) {
  const parsed = new URL(cdpEndpoint);
  return `${parsed.protocol}//${parsed.host}`;
}

function normalizeComparableUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitOutCloudflareIfNeeded(page) {
  // In headless mode (CI) Cloudflare challenges can't be solved interactively.
  // Wait a short time (10s) in case it resolves via JS challenge; in headed mode
  // give the user up to 90s to solve a CAPTCHA manually.
  const maxWait = headless ? 10_000 : 90_000;
  const started = Date.now();
  while (Date.now() - started < maxWait) {
    const title = await page.title().catch(() => "");
    if (!/cloudflare|attention required/i.test(title)) return;
    await page.waitForTimeout(2500);
  }
  const title = await page.title().catch(() => "");
  if (/cloudflare|attention required/i.test(title)) {
    if (headless) {
      throw new Error(
        `Cloudflare bloqueando em modo headless após ${maxWait / 1000}s (IP de datacenter detectado). Sem resultados para este termo.`
      );
    } else {
      throw new Error(
        `Cloudflare ainda está bloqueando após 90s. Rode sem --headless e, se aparecer desafio/captcha, resolva uma vez no perfil ${USER_DATA_DIR} para persistir cookies.`
      );
    }
  }
}

async function waitForListingReadinessPlaywright(page) {
  const outcome = await page
    .waitForFunction(
      () => {
        const count = document.querySelectorAll("section.olx-adcard").length;
        if (count > 0) return "cards";

        const text = (document.body?.innerText || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase();
        if (/0\s+resultados?|nao encontramos|sem resultados|nenhum resultado/i.test(text)) return "empty";
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

async function collectCardsFromInfiniteScroll(page, maxCards) {
  const results = [];
  let lastCount = 0;
  let stableRounds = 0;

  while (results.length < maxCards && stableRounds < RAW_STABLE_ROUNDS) {
    const batch = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll("section.olx-adcard"));
      return cards.map((card) => {
        const a = card.querySelector("[data-testid=adcard-link]");
        const title = a?.getAttribute("title") || a?.textContent?.trim() || "";
        const url = a?.href || "";
        const priceText = card.querySelector("h3.olx-adcard__price")?.textContent?.trim() || "";
        const location = card.querySelector(".olx-adcard__location")?.textContent?.trim() || "";
        const text = card.innerText || "";
        return { title, url, priceText, location, text };
      });
    });

    const normalized = batch
      .map((item) => ({
        title: item.title?.trim(),
        url: item.url,
        price_brl: parseBrlPrice(item.priceText),
        location: item.location?.trim() || null,
        text: item.text || "",
        ram_gb: extractRamGb(`${item.title}\n${item.text}`),
        storage_gb: extractStorageGb(`${item.title}\n${item.text}`),
      }))
      .filter((x) => x.url && x.title && x.price_brl != null);

    const seen = new Set(results.map((r) => r.url));
    for (const item of normalized) {
      if (!seen.has(item.url)) results.push(item);
    }

    const currentCount = results.length;
    if (currentCount === lastCount) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
      lastCount = currentCount;
    }

    await page.mouse.wheel(0, 2200);
    await waitForCardCountChangePlaywright(page, currentCount);
  }

  return results.slice(0, maxCards);
}

async function waitForCardCountChangePlaywright(page, previousCount) {
  await page
    .waitForFunction(
      (count) =>
        document.querySelectorAll("section.olx-adcard").length > count ||
        window.scrollY + window.innerHeight >= document.body.scrollHeight - 20,
      previousCount,
      { timeout: 1400, polling: 100 }
    )
    .catch(() => {});
}

async function enrichAd(listingPage, card) {
  const url = card.url;
  const page = await listingPage.context().newPage();
  try {
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
    const bodyLocator = page.locator("body");
    await bodyLocator.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    await page
      .waitForFunction(() => (document.body?.innerText?.length || 0) > 800, null, {
        timeout: 15000,
        polling: 150,
      })
      .catch(() => {});
    const bodyText = await bodyLocator.innerText().catch(() => "");
    const title = card.title;

    if (hasExcludedKeyword(title) || hasExcludedKeyword(bodyText)) {
      return null;
    }

    const detailText = `${title}\n${bodyText}`;

    // Confirm CPU term exists explicitly in title or body.
    if (!textContainsCpuTerm(detailText, card.cpu_term)) {
      return null;
    }

    const price_brl = parseBrlPrice(bodyText) ?? card.price_brl;
    const location = extractLocationFromText(bodyText);
    const condition = extractConditionFromText(bodyText);

    const ram_gb = extractRamGb(detailText);
    const storage_gb = extractStorageGb(detailText);
    const gpu = extractGpuLabel(detailText);

    const id = extractOlxId(url);

    return {
      id,
      url,
      title,
      cpu_term: card.cpu_term,
      price_brl,
      ram_gb,
      storage_gb,
      gpu,
      location: location || null,
      condition: condition || null,
      status: "active",
      first_seen: null,
      last_seen: null,
      notes: null,
      desc_checked: true,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function extractLocationFromText(text) {
  const t = (text ?? "").toString();
  const m = t.match(/([^\n]{0,80}?,\s*[^\n]{0,80}?\s*-\s*[A-Z]{2})/);
  return m ? m[1].trim() : null;
}

function extractConditionFromText(text) {
  const t = (text ?? "").toString();
  const m = t.match(/\b(Usado\s*-\s*[^\n]{0,40}|Novo)\b/i);
  return m ? m[1].trim() : null;
}

function buildReport({ runDate, snapshot, previousSnapshot, priceMin, priceMax }) {
  const currentItems = snapshot.items.filter((x) => x.status === "active");
  const inRange = currentItems.filter((x) => x.price_brl != null && x.price_brl >= priceMin && x.price_brl <= priceMax);

  const previousById = new Map((previousSnapshot?.items ?? []).map((x) => [x.id ?? x.url, x]));
  const currentById = new Map(currentItems.map((x) => [x.id ?? x.url, x]));

  const newItems = inRange.filter((x) => !previousById.has(x.id ?? x.url));
  const stillActiveSeen = inRange.filter((x) => previousById.has(x.id ?? x.url));

  // Listing-based crawler: absence only means "not seen in this run's listing results" (not necessarily offline).
  const notSeenThisRun = (previousSnapshot?.items ?? [])
    .filter((x) => x.status === "active")
    .filter((x) => !currentById.has(x.id ?? x.url));

  const priceChanges = [];
  for (const item of currentItems) {
    const prev = previousById.get(item.id ?? item.url);
    if (!prev) continue;
    if (item.price_brl != null && item.price_brl > PRICE_CHANGE_MAX_BRL) continue;
    if (prev.price_brl != null && item.price_brl != null && prev.price_brl !== item.price_brl) {
      priceChanges.push({ item, from: prev.price_brl, to: item.price_brl });
    }
  }

  const lines = [];
  lines.push(`# Monitor OLX notebooks por CPU — ${runDate}`);
  lines.push("");
  lines.push("## Resumo executivo");
  lines.push(`- Novos anúncios válidos (R$ ${priceMin.toLocaleString("pt-BR")}–R$ ${priceMax.toLocaleString("pt-BR")}): **${newItems.length}**`);
  lines.push(`- Anúncios ainda ativos (já vistos) no range: **${stillActiveSeen.length}**`);
  lines.push(`- Não vistos nesta rodada (sumiram da listagem): **${notSeenThisRun.length}**`);
  lines.push(`- Alterações de preço detectadas: **${priceChanges.length}**`);
  lines.push("");

  lines.push(`## Novos anúncios (R$ ${priceMin.toLocaleString("pt-BR")}–R$ ${priceMax.toLocaleString("pt-BR")})`);
  if (newItems.length === 0) {
    lines.push("- Nenhum.");
  } else {
    for (const item of newItems.sort((a, b) => (a.price_brl ?? 0) - (b.price_brl ?? 0))) {
      lines.push(formatItemLine(item));
    }
  }
  lines.push("");

  lines.push("## Anúncios ainda ativos (já vistos) no range");
  if (stillActiveSeen.length === 0) {
    lines.push("- Nenhum.");
  } else {
    for (const item of stillActiveSeen.sort((a, b) => (a.price_brl ?? 0) - (b.price_brl ?? 0))) {
      lines.push(formatItemLine(item));
    }
  }
  lines.push("");

  if (priceChanges.length > 0) {
    lines.push("## Mudanças de preço");
    for (const change of priceChanges.sort((a, b) => (a.to ?? 0) - (b.to ?? 0))) {
      lines.push(formatPriceChangeLine(change));
    }
    lines.push("");
  }

  if (notSeenThisRun.length > 0) {
    lines.push("## Não vistos nesta rodada (sumiram da listagem)");
    lines.push("- Observação: como a coleta é por listagem e limitada por CPU, isso **não garante** que o anúncio foi removido da OLX; apenas que não apareceu nos resultados coletados desta execução.");
    for (const item of notSeenThisRun.sort((a, b) => (a.price_brl ?? 0) - (b.price_brl ?? 0))) {
      lines.push(`- ${item.title} (${item.cpu_term}) — ${item.url}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatItemLine(item) {
  return `- R$ ${item.price_brl.toLocaleString("pt-BR")} — ${formatItemDetails(item)}`;
}

function formatPriceChangeLine(change) {
  return `- R$ ${change.from.toLocaleString("pt-BR")} → R$ ${change.to.toLocaleString("pt-BR")} — ${formatItemDetails(change.item)}`;
}

function formatItemDetails(item) {
  const ram = item.ram_gb ? `${item.ram_gb} GB RAM` : "RAM n/d";
  const storage = item.storage_gb ? `${item.storage_gb} GB` : "SSD/HD n/d";
  const gpu = item.gpu ? `GPU ${item.gpu}` : "GPU n/d";
  const location = item.location ? ` — ${item.location}` : "";
  return `${item.title} (${item.cpu_term}) — ${ram} / ${storage} / ${gpu}${location} — ${item.url}`;
}

function mergeWithPreviousSnapshot({ runDate, collected, previousSnapshot }) {
  return _mergeItems({
    runDate,
    collected,
    previousSnapshot,
    priceMin: PRICE_MIN_BRL,
    priceMax: PRICE_MAX_BRL,
  });
}

export { mergeWithPreviousSnapshot, getReusablePreviousEnrichedItem, needsDetailEnrichment };

function hasExcludedKeyword(text) {
  const normalized = (text ?? "").toString().toLowerCase();
  return EXCLUDE_PATTERNS.some((term) => normalized.includes(term));
}



async function getLatestSnapshotPath(root) {
  try {
    const entries = await fs.readdir(root);
    const snapshots = entries
      .filter((name) => /^snapshot-\d{4}-\d{2}-\d{2}/.test(name) && name.endsWith(".json"))
      .sort()
      .reverse();
    if (snapshots.length === 0) return null;
    return path.join(root, snapshots[0]);
  } catch {
    return null;
  }
}

async function readJsonSafe(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getOptionValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) return null;
  return value;
}
