import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "..");
const automationRoot = process.env.OLX_DATA_DIR ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".codex", "automations", "monitor-olx-notebooks-por-cpu");

const USER_DATA_DIR = path.join(workspaceRoot, ".chrome-olx-profile");
const REAL_CHROME_USER_DATA_DIR = path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "User Data");
const DEFAULT_CDP_URL = "http://127.0.0.1:9222";
const BASE_URL = "https://www.olx.com.br/brasil/informatica/notebooks";

const PRICE_MIN_BRL = 2000;
const PRICE_MAX_BRL = 4000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const DETAIL_TIMEOUT_MS = 25_000;
const RAW_SCROLL_DELAY_MS = Number(process.env.OLX_SCROLL_DELAY_MS ?? 350);
const RAW_STABLE_ROUNDS = Number(process.env.OLX_STABLE_ROUNDS ?? 2);

const DEFAULT_CPU_TERMS = [
  "7945hx",
  "255hx",
  "13980hx",
  "8940hx",
  "8945hs",
  "7940hx",
  "13950hx",
  "14900hx",
  "13900hx",
  "7845hx",
  "8840hx",
  "14700hx",
  "14650hx",
  "14500hx",
  "hx370",
  "13700hx",
  "13650hx",
  "13620h",
  "13500hx",
  "13450hx",
  "7745hx",
  "185h",
  "7940hs",
  "7840hs",
  "8845hs",
  "ai7350",
  "12700h",
  "12900h",
  "155h",
  "165h",
  "8745hs",
  "13700h",
];

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
  "não funciona",
  "nao funciona",
  "problema",
  "mini pc",
  "mini-pc",
  "desktop",
  "computador de mesa",
];

const args = process.argv.slice(2);
const headless = args.includes("--headless");
const maxAdsPerCpu = Number(getOptionValue(args, "--max-per-cpu") ?? 20);
const debug = args.includes("--debug");
// Default: do not open individual ads. Keep the run fast and low-risk against OLX defenses.
// Use --open-details only when you explicitly need to validate descriptions / extract RAM from inside the ad.
const openDetails = args.includes("--open-details");
const listingOnly = args.includes("--listing-only") || !openDetails;
const cpuArg = getOptionValue(args, "--cpu");
const cpuTerms = cpuArg ? cpuArg.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : DEFAULT_CPU_TERMS;
const useCurrentChrome = args.includes("--current-chrome");
const useRealProfile = args.includes("--real-profile");
const profileDirectory = getOptionValue(args, "--profile-directory") ?? "Default";
const cdpUrl = getOptionValue(args, "--cdp-url") ?? process.env.CHROME_CDP_URL ?? DEFAULT_CDP_URL;
const blockAssets = !args.includes("--load-assets");

main().catch((error) => {
  console.error(`\nFalha: ${error.stack || error.message}`);
  process.exitCode = 1;
});

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
      ? ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=1280,900"]
      : ["--start-maximized"],
  };
  if (!isCI) launchOptions.channel = "chrome";

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, launchOptions);
  return { page: context.pages()[0] ?? (await context.newPage()), close: () => context.close() };
}

async function launchRealChromeProfile(selectedProfileDirectory, headlessMode) {
  const chromeArgs = ["--start-maximized", `--profile-directory=${selectedProfileDirectory}`];
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
  const query = encodeURIComponent(cpuTerm === "ai7350" ? "ryzen ai 7 350" : cpuTerm);
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
    if (debug) {
      console.log(`  Abrindo candidato ${index + 1}/${toOpen.length}: R$ ${card.price_brl} - ${card.title}`);
    }
    try {
      const reusable = getReusablePreviousEnrichedItem(previousSnapshot, card);
      if (reusable) {
        validated.push(reusable);
        if (validated.length >= maxCards) break;
        continue;
      }
      const enriched = await withTimeout(enrichAd(page, card), DETAIL_TIMEOUT_MS, `timeout ao abrir anúncio ${card.url}`);
      if (!enriched) continue;
      validated.push(enriched);
      if (validated.length >= maxCards) break;
    } catch (error) {
      console.warn(`  Aviso: pulei anúncio por falha (${error.message}): ${card.url}`);
    }
  }

  // If OLX is sorted by lowest price, we can stop early when the cheapest valid is already > 4k and we already captured a few.
  validated.sort((a, b) => (a.price_brl ?? 0) - (b.price_brl ?? 0));
  return validated;
}

async function collectForCpuTermRawCdp(tab, cpuTerm, maxCards, previousSnapshot) {
  const query = encodeURIComponent(cpuTerm === "ai7350" ? "ryzen ai 7 350" : cpuTerm);
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
      if (debug) {
        console.log(`  Abrindo candidato ${index + 1}/${toOpen.length}: R$ ${card.price_brl} - ${card.title}`);
      }
      try {
        const reusable = getReusablePreviousEnrichedItem(previousSnapshot, card);
        if (reusable) {
          validated.push(reusable);
          if (validated.length >= maxCards) break;
          continue;
        }
        const enriched = await enrichAdRawCdp(cdpUrl, card);
        if (enriched) validated.push(enriched);
        if (validated.length >= maxCards) break;
      } catch (error) {
        console.warn(`  Aviso: pulei anúncio por falha (${error.message}): ${card.url}`);
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

    if (hasExcludedKeyword(title) || hasExcludedKeyword(bodyText)) return null;
    if (!textContainsCpuTerm(`${title}\n${bodyText}`, card.cpu_term)) return null;

    return {
      id: extractOlxId(card.url),
      url: card.url,
      title,
      cpu_term: card.cpu_term,
      price_brl: parseBrlPrice(bodyText) ?? card.price_brl,
      ram_gb: extractRamGb(bodyText),
      storage_gb: extractStorageGb(bodyText),
      location: extractLocationFromText(bodyText),
      condition: extractConditionFromText(bodyText),
      status: "active",
      first_seen: null,
      last_seen: null,
      notes: null,
    };
  } finally {
    await tab.closeTab();
  }
}

async function waitForRawBody(tab) {
  const started = Date.now();
  while (Date.now() - started < DETAIL_TIMEOUT_MS) {
    const textLength = await rawEvaluate(tab, "document.body?.innerText?.length || 0").catch(() => 0);
    if (Number(textLength) > 200) return;
    await delay(800);
  }
  throw new Error("não consegui ler o corpo do anúncio");
}

function listingCardToItem(card) {
  return {
    id: extractOlxId(card.url),
    url: card.url,
    title: card.title,
    cpu_term: card.cpu_term,
    price_brl: card.price_brl,
    ram_gb: card.ram_gb ?? extractRamGb(`${card.title}\n${card.text ?? ""}`),
    storage_gb: card.storage_gb ?? extractStorageGb(`${card.title}\n${card.text ?? ""}`),
    location: card.location ?? null,
    condition: null,
    status: "active",
    first_seen: null,
    last_seen: null,
    notes: listingOnly ? "Validado apenas pela página de listagem; descrição do anúncio não foi aberta." : null,
  };
}

function getReusablePreviousEnrichedItem(previousSnapshot, card) {
  const current = listingCardToItem(card);
  const key = current.id ?? current.url;
  const previous = (previousSnapshot?.items ?? []).find((item) => (item.id ?? item.url) === key);
  if (!previous) return null;
  if (previous.status !== "active") return null;
  if (previous.price_brl !== current.price_brl) return null;
  if ((previous.notes ?? "").includes("Validado apenas")) return null;

  return {
    ...previous,
    ...current,
    ram_gb: current.ram_gb ?? previous.ram_gb ?? null,
    storage_gb: current.storage_gb ?? previous.storage_gb ?? null,
    condition: previous.condition ?? current.condition ?? null,
    notes: previous.notes,
    status: "active",
  };
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

function normalizeText(text) {
  return (text ?? "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitOutCloudflareIfNeeded(page) {
  const started = Date.now();
  while (Date.now() - started < 90_000) {
    const title = await page.title().catch(() => "");
    if (!/cloudflare|attention required/i.test(title)) return;
    // Give Cloudflare JS challenge a chance to pass in headed mode.
    await page.waitForTimeout(2500);
  }
  const title = await page.title().catch(() => "");
  if (/cloudflare|attention required/i.test(title)) {
    throw new Error(
      `Cloudflare ainda está bloqueando após 90s. Rode sem --headless e, se aparecer desafio/captcha, resolva uma vez no perfil ${USER_DATA_DIR} para persistir cookies.`
    );
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
      .waitForFunction(() => (document.body?.innerText?.length || 0) > 200 || document.readyState === "complete", null, {
        timeout: 15000,
        polling: 150,
      })
      .catch(() => {});
    const bodyText = await bodyLocator.innerText().catch(() => "");
    const title = card.title;

    if (hasExcludedKeyword(title) || hasExcludedKeyword(bodyText)) {
      return null;
    }

    // Confirm CPU term exists explicitly in title or body.
    if (!textContainsCpuTerm(title + "\n" + bodyText, card.cpu_term)) {
      return null;
    }

    const price_brl = parseBrlPrice(bodyText) ?? card.price_brl;
    const location = extractLocationFromText(bodyText);
    const condition = extractConditionFromText(bodyText);

    const ram_gb = extractRamGb(bodyText);
    const storage_gb = extractStorageGb(bodyText);

    const id = extractOlxId(url);

    return {
      id,
      url,
      title,
      cpu_term: card.cpu_term,
      price_brl,
      ram_gb,
      storage_gb,
      location: location || null,
      condition: condition || null,
      status: "active",
      first_seen: null,
      last_seen: null,
      notes: null,
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
  const aboveRange = currentItems.filter((x) => x.price_brl != null && x.price_brl > priceMax);

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
    if (prev.price_brl != null && item.price_brl != null && prev.price_brl !== item.price_brl) {
      priceChanges.push({ item, from: prev.price_brl, to: item.price_brl });
    }
  }

  const topAbove = aboveRange
    .slice()
    .sort((a, b) => (a.price_brl ?? 0) - (b.price_brl ?? 0))
    .slice(0, 3);

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
      const item = change.item;
      lines.push(`- R$ ${change.from.toLocaleString("pt-BR")} → R$ ${change.to.toLocaleString("pt-BR")} — ${item.title} (${item.cpu_term}) — ${item.url}`);
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

  if (topAbove.length > 0) {
    lines.push("## Opcional — 3 válidos mais baratos acima de R$ " + priceMax.toLocaleString("pt-BR"));
    for (const item of topAbove) {
      lines.push(formatItemLine(item));
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatItemLine(item) {
  const ram = item.ram_gb ? `${item.ram_gb} GB RAM` : "RAM n/d";
  const storage = item.storage_gb ? `${item.storage_gb} GB` : "SSD/HD n/d";
  const location = item.location ? ` — ${item.location}` : "";
  return `- R$ ${item.price_brl.toLocaleString("pt-BR")} — ${item.title} (${item.cpu_term}) — ${ram} / ${storage}${location} — ${item.url}`;
}

function mergeWithPreviousSnapshot({ runDate, collected, previousSnapshot }) {
  const previousItems = previousSnapshot?.items ?? [];
  const previousById = new Map(previousItems.map((x) => [x.id ?? x.url, x]));

  const items = [];
  for (const item of collected) {
    const key = item.id ?? item.url;
    const prev = previousById.get(key);
    items.push({
      ...item,
      first_seen: prev?.first_seen ?? runDate,
      last_seen: runDate,
    });
  }

  const currentKeys = new Set(items.map((x) => x.id ?? x.url));
  for (const prev of previousItems) {
    const key = prev.id ?? prev.url;
    if (!currentKeys.has(key)) {
      items.push({
        ...prev,
        // Important: the crawler is listing-based and capped per CPU term; absence in a run
        // does NOT guarantee the ad is offline. It only means "not seen in this run's results".
        status: "not_seen",
        last_seen: runDate,
      });
    }
  }

  return {
    run: { date: runDate, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    price_range_brl: { min: PRICE_MIN_BRL, max: PRICE_MAX_BRL },
    items,
  };
}

function isNotebookCategoryUrl(url) {
  try {
    const u = new URL(url);
    return /\/informatica\/notebooks\//i.test(u.pathname);
  } catch {
    return false;
  }
}

function hasExcludedKeyword(text) {
  const normalized = (text ?? "").toString().toLowerCase();
  return EXCLUDE_PATTERNS.some((term) => normalized.includes(term));
}

function textContainsCpuTerm(text, cpuTerm) {
  const normalizedText = normalizeCpuText(text);
  const normalizedTerm = normalizeCpuText(cpuTerm);
  if (cpuTerm === "ai7350") {
    // Accept a few variants seen in listings
    return (
      normalizedText.includes("ryzenai7350") ||
      normalizedText.includes("ai7350") ||
      (normalizedText.includes("ryzenai") && normalizedText.includes("350"))
    );
  }
  // Allow 13650hx and 13650 hx variants by normalization.
  return normalizedText.includes(normalizedTerm);
}

function normalizeCpuText(text) {
  return (text ?? "")
    .toString()
    .toLowerCase()
    .replace(/[\s\-_.]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function extractRamGb(text) {
  const normalized = (text ?? "").toString();
  const patterns = [
    /\b(\d{1,3})\s*gb\s*(?:de\s*)?(?:ram|mem[oó]ria)\b/i,
    /\b(?:ram|mem[oó]ria)\s*:?\s*(\d{1,3})\s*gb\b/i,
    /\b(\d{1,3})\s*gb\s*ddr\d\b/i,
  ];
  for (const re of patterns) {
    const m = normalized.match(re);
    if (m) {
      const v = Number(m[1]);
      if (Number.isFinite(v) && v >= 2 && v <= 256) return v;
    }
  }
  return null;
}

function extractStorageGb(text) {
  const t = (text ?? "").toString().toLowerCase();
  const mTb = t.match(/\b(\d+(?:[\.,]\d+)?)\s*tb\b/);
  if (mTb) {
    const tb = Number(mTb[1].replace(",", "."));
    if (Number.isFinite(tb)) return Math.round(tb * 1024);
  }
  const mGb = t.match(/\b(\d{2,5})\s*gb\s*(?:ssd|hd|nvme|m\.2|armazenamento|storage)\b/);
  if (mGb) {
    const gb = Number(mGb[1]);
    if (Number.isFinite(gb) && gb >= 64 && gb <= 8192) return gb;
  }
  const mSsd = t.match(/\bssd\s*(\d{2,5})\s*gb\b/);
  if (mSsd) {
    const gb = Number(mSsd[1]);
    if (Number.isFinite(gb) && gb >= 64 && gb <= 8192) return gb;
  }
  return null;
}

function parseBrlPrice(text) {
  const raw = (text ?? "").toString();
  const m = raw.match(/R\$\s*([\d\.]+)(?:,\d{2})?/);
  if (!m) return null;
  const n = Number(m[1].replace(/\./g, ""));
  return Number.isFinite(n) ? n : null;
}

function extractOlxId(url) {
  const m = (url ?? "").toString().match(/(\d{8,})\/?(?:\?|$)/);
  return m ? m[1] : null;
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
