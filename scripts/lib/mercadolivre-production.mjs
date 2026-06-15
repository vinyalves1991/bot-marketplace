import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import {
  buildSearchUrl,
  collectSearchResults,
  detectPageState,
  extractMercadoLivreId,
  extractMercadoLivreNotebookSpecs,
  latestMercadoLivreSnapshotPath,
  pageStateMessage,
  textMatchesTerm,
} from "./mercadolivre-monitor.mjs";
import {
  buildMonitorChanges,
  mergeMonitorSnapshot,
  normalizeMonitorText,
} from "./monitor-core.mjs";

const NAVIGATION_TIMEOUT_MS = 45_000;
const LOCK_STALE_MS = 6 * 60 * 60 * 1000;

export async function runMercadoLivreBatch({
  id,
  label,
  dataDir,
  profileDir,
  terms,
  allTerms = terms,
  minPrice,
  maxPrice,
  displayMinPrice = minPrice,
  displayMaxPrice = maxPrice,
  searchOptions = {},
  excludeTerms = [],
  itemFilter = null,
  termMatcher = textMatchesTerm,
  kind = "product",
  relevantDetails = [],
}) {
  const args = process.argv.slice(2);
  const headless = args.includes("--headless");
  // Por padrão a janela roda FORA DA TELA (não atrapalha o trabalho), mantendo o
  // Chrome "real" (menos detectável que headless). --visible mostra a janela
  // (útil para login/desafios); --headless roda sem janela (mais leve, porém
  // mais sujeito a bloqueio do Mercado Livre).
  const visible = args.includes("--visible");
  const loadAssets = args.includes("--load-assets"); // não bloqueia imagens/mídia/fontes (diagnóstico)
  const maxItemsPerTerm = positiveNumber(option(args, "--max-items"), 20);
  const maxDetails = nonNegativeNumber(option(args, "--max-details"), kind === "notebook" ? 8 : 4);
  const delayMinMs = positiveNumber(option(args, "--delay-min-ms"), 12_000);
  const delayMaxMs = Math.max(delayMinMs, positiveNumber(option(args, "--delay-max-ms"), 22_000));
  const detailDelayMinMs = positiveNumber(option(args, "--detail-delay-min-ms"), 12_000);
  const detailDelayMaxMs = Math.max(detailDelayMinMs, positiveNumber(option(args, "--detail-delay-max-ms"), 22_000));
  const previousPath = await latestMercadoLivreSnapshotPath(dataDir);
  const previous = previousPath ? await readJson(previousPath) : null;
  const previousById = new Map((previous?.items ?? []).map((item) => [item.id, item]));
  const lock = await acquireMercadoLivreLock(profileDir);
  const startedAt = new Date();
  const successfulTerms = [];
  const failedTerms = [];
  const collected = [];
  let consolidated = [];
  let aborted = false;
  let context;

  console.log(`Mercado Livre: ${label}`);
  console.log(`${terms.length} busca(s), coleta R$ ${formatNumber(minPrice)}-${formatNumber(maxPrice)}`);
  console.log(`Pausa entre acessos: ${delayMinMs}-${delayMaxMs} ms`);

  try {
    const launchArgs = headless
      ? []
      : visible
        ? ["--start-maximized"]
        // Fora da tela + sem throttling de janela em segundo plano, para a
        // coleta seguir normal mesmo sem aparecer.
        : ["--window-position=-32000,-32000", "--window-size=1280,900", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"];
    context = await chromium.launchPersistentContext(profileDir, {
      channel: "chrome",
      headless,
      viewport: null,
      locale: "pt-BR",
      args: launchArgs,
    });
    // Economia de dados/eficiência: não baixa imagens, mídia nem fontes — o
    // scraper só lê texto (título, preço, ficha). Mantém CSS/JS (SPA do ML).
    // --load-assets desativa (diagnóstico/se o ML degradar a página sem imagens).
    if (!loadAssets) {
      await context.route("**/*", (route) => {
        const type = route.request().resourceType();
        if (["image", "media", "font"].includes(type)) return route.abort();
        return route.continue();
      }).catch(() => {});
    }
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

    for (let index = 0; index < terms.length; index += 1) {
      const task = normalizeTask(terms[index]);
      if (index > 0) await sleep(randomBetween(delayMinMs, delayMaxMs));
      console.log(`[${index + 1}/${terms.length}] ${task.query}`);
      try {
        await page.goto(buildSearchUrl(task.query, {
          minPrice,
          maxPrice,
          ...searchOptions,
          ...(task.searchOptions ?? {}),
        }), { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
        await sleep(randomBetween(delayMinMs, delayMaxMs));
        const state = await detectPageState(page);
        if (state !== "results") {
          const error = new Error(pageStateMessage(state));
          error.pageState = state;
          throw error;
        }
        const raw = await collectSearchResults(page);
        if (raw.length === 0) throw new Error("Nenhum card reconhecido; possivel mudanca de layout.");
        const exclusions = excludeTerms.map(normalizeText);
        const accepted = raw
          .filter((item) => item.price_brl >= minPrice && item.price_brl <= maxPrice)
          .filter((item) => termMatcher(item.title, task.matchTerm))
          .filter((item) => !exclusions.some((term) => normalizeText(item.title).includes(term)))
          .filter((item) => !itemFilter || itemFilter(item))
          .slice(0, maxItemsPerTerm)
          .map((item) => ({
            ...item,
            id: extractMercadoLivreId(item.url) ?? item.id ?? item.url,
            source: "Mercado Livre",
            terms: [task.matchTerm],
            status: "active",
          }));
        collected.push(...accepted);
        successfulTerms.push(task.matchTerm);
        console.log(`  ${accepted.length} item(ns) aceito(s)`);
      } catch (error) {
        failedTerms.push({ term: task.matchTerm, error: error.message });
        console.warn(`  Falhou com seguranca: ${error.message}`);
        if (["challenge", "limited", "logged_out"].includes(error.pageState)) {
          aborted = true;
          console.warn("Fila interrompida para evitar acessos adicionais.");
          break;
        }
      }
    }

    const deduped = dedupeMercadoLivreItems(collected);
    consolidated = deduped;
    const detailCandidates = deduped
      .filter((item) => needsMercadoLivreDetail(item, previousById.get(item.id), kind, relevantDetails))
      .slice(0, maxDetails);
    for (let index = 0; index < detailCandidates.length; index += 1) {
      const item = detailCandidates[index];
      if (index > 0) await sleep(randomBetween(detailDelayMinMs, detailDelayMaxMs));
      try {
        const details = await collectProductDetails(page, item.url);
        Object.assign(item, details, { details_checked_at: new Date().toISOString() });
        console.log(`  Ficha ${index + 1}/${detailCandidates.length}: ${item.title.slice(0, 65)}`);
      } catch (error) {
        item.detail_error = error.message;
        console.warn(`  Ficha nao coletada: ${error.message}`);
        if (/verificacao|limitou|sessao expirada/i.test(error.message)) {
          aborted = true;
          break;
        }
      }
    }
  } finally {
    await context?.close().catch(() => {});
    await lock.release();
  }

  const completedAt = new Date();
  const snapshot = mergeMercadoLivreBatch({
    previous,
    collected: consolidated,
    successfulTerms,
    failedTerms: failedTerms.map((failure) => failure.term),
    scheduledTerms: terms.map((term) => normalizeTask(term).matchTerm),
    allTerms: allTerms.map((term) => normalizeTask(term).matchTerm),
    now: completedAt,
    minPrice,
    maxPrice,
    displayMinPrice,
    displayMaxPrice,
    run: {
      id,
      label,
      started_at: startedAt.toISOString(),
      completed_at: completedAt.toISOString(),
      partial: failedTerms.length > 0 || aborted,
      aborted,
      successful_terms: successfulTerms,
      scheduled_terms: terms.map((term) => normalizeTask(term).matchTerm),
      configured_terms: allTerms.map((term) => normalizeTask(term).matchTerm),
      failed_terms: failedTerms,
    },
  });
  const changes = buildMercadoLivreChanges(previous, snapshot, { displayMinPrice, displayMaxPrice });
  const runId = completedAt.toISOString().replace(/[:.]/g, "-");
  await fs.mkdir(dataDir, { recursive: true });
  const snapshotPath = path.join(dataDir, `snapshot-${runId}.json`);
  const reportPath = path.join(dataDir, `report-${runId}.md`);
  await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");
  await fs.writeFile(reportPath, renderMercadoLivreReport(snapshot, changes), "utf8");
  console.log(`Snapshot: ${snapshotPath}`);
  console.log(`Relatorio: ${reportPath}`);
  return { snapshot, changes, snapshotPath, reportPath };
}

export function dedupeMercadoLivreItems(items) {
  const byId = new Map();
  for (const raw of items ?? []) {
    const id = extractMercadoLivreId(raw.url) ?? raw.id ?? raw.url;
    const item = { ...raw, id, terms: [...new Set(raw.terms ?? (raw.term ? [raw.term] : []))] };
    const current = byId.get(id);
    if (!current) {
      byId.set(id, item);
      continue;
    }
    const preferred = preferItem(current, item);
    byId.set(id, {
      ...current,
      ...preferred,
      terms: [...new Set([...(current.terms ?? []), ...(item.terms ?? [])])],
    });
  }
  return [...byId.values()];
}

export function mergeMercadoLivreBatch({
  previous,
  collected,
  successfulTerms,
  failedTerms,
  scheduledTerms = [...successfulTerms, ...failedTerms],
  allTerms = scheduledTerms,
  now = new Date(),
  minPrice,
  maxPrice,
  displayMinPrice,
  displayMaxPrice,
  run,
}) {
  return mergeMonitorSnapshot({
    previousSnapshot: previous,
    collected,
    now,
    run,
    scheduledCoverage: scheduledTerms,
    successfulCoverage: successfulTerms,
    failedCoverage: failedTerms,
    configuredCoverage: allTerms,
    itemCoverage: (item) => item.terms ?? (item.term ? [item.term] : []),
    dedupe: dedupeMercadoLivreItems,
    filters: {
      collection_price_brl: { min: minPrice, max: maxPrice },
      display_price_brl: { min: displayMinPrice, max: displayMaxPrice },
    },
  });
}

export function buildMercadoLivreChanges(previous, current, { displayMinPrice, displayMaxPrice }) {
  const visible = (item) => item.status === "active"
    && Number(item.price_brl) >= displayMinPrice
    && Number(item.price_brl) <= displayMaxPrice;
  const { newItems, priceChanges } = buildMonitorChanges(previous, current, {
    include: visible,
    reactivationIsNew: false,
  });
  const enteredDisplayRange = priceChanges.filter((item) => Number(item.previous_price_brl) > displayMaxPrice);
  return { newItems, priceChanges, enteredDisplayRange };
}

export async function acquireMercadoLivreLock(profileDir, { staleMs = LOCK_STALE_MS } = {}) {
  const lockPath = `${profileDir}.monitor.lock`;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  try {
    const handle = await fs.open(lockPath, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    await handle.close();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const stat = await fs.stat(lockPath).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > staleMs) {
      await fs.unlink(lockPath).catch(() => {});
      return acquireMercadoLivreLock(profileDir, { staleMs });
    }
    throw new Error("Ja existe uma coleta do Mercado Livre em andamento.");
  }
  return {
    path: lockPath,
    release: () => fs.unlink(lockPath).catch(() => {}),
  };
}

async function collectProductDetails(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
  await sleep(randomBetween(8_000, 14_000));
  const state = await detectProductPageState(page);
  if (state !== "product") throw new Error(pageStateMessage(state));
  return page.evaluate(() => {
    const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    const title = clean(document.querySelector("h1")?.textContent);
    const bodyText = clean(document.body?.innerText);
    const condition = bodyText.match(/(?:^|\s)(Novo|Usado|Recondicionado)(?:\s|$)/i)?.[1] ?? null;
    const specs = [];
    const seen = new Set();
    for (const row of document.querySelectorAll("tr, .andes-table__row, li")) {
      const cells = [...row.querySelectorAll("th, td, .andes-table__header, .andes-table__column")]
        .map((cell) => clean(cell.textContent))
        .filter(Boolean);
      let value = cells.length >= 2 ? `${cells[0]}: ${cells.slice(1).join(" ")}` : clean(row.textContent);
      if (!value || value.length > 220 || seen.has(value)) continue;
      if (!/(processador|memoria|memória|ssd|placa grafica|placa gráfica|modelo|marca|capacidade|voltagem|tamanho|condicao|condição|compatibilidade|portas?)/i.test(value)) continue;
      seen.add(value);
      specs.push(value);
    }
    const description = clean(document.querySelector(".ui-pdp-description__content, [data-testid='description-content']")?.textContent);
    return { title: title || undefined, condition, specs: specs.slice(0, 80), description: description || null };
  });
}

async function detectProductPageState(page) {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const body = await page.locator("body").innerText().catch(() => "");
  const text = normalizeText(`${title}\n${body}`);
  if (/login|registration|auth/.test(new URL(url).pathname)) return "logged_out";
  if (/captcha|verifique que voce e humano|nao sou um robo/.test(text)) return "challenge";
  if (/muitas solicitacoes|temporariamente indisponivel/.test(text)) return "limited";
  if (await page.locator("h1").count() > 0) return "product";
  return "unknown";
}

export function needsMercadoLivreDetail(item, old, kind, relevantDetails) {
  if (!old?.details_checked_at) return true;
  if (kind === "notebook") {
    const specs = extractMercadoLivreNotebookSpecs(old.specs);
    return !specs.cpuModel || !specs.ram || !specs.storage || !specs.gpu || !old.condition;
  }
  const detailsText = normalizeText(`${old.title} ${old.description} ${(old.specs ?? []).join(" ")}`);
  return relevantDetails.some((detail) => {
    const normalizedDetail = normalizeText(detail);
    if (normalizedDetail === "condicao") return !old.condition;
    return !detailsText.includes(normalizedDetail);
  });
}

function renderMercadoLivreReport(snapshot, changes) {
  const { run } = snapshot;
  const lines = [
    `# Mercado Livre - ${run.label}`,
    "",
    `Data: ${snapshot.generated_at.slice(0, 10)}`,
    `Cobertura parcial: **${run.partial ? "sim" : "nao"}**`,
    `Termos concluidos: **${run.successful_terms.length}**`,
    `Termos com falha: **${run.failed_terms.length}**`,
    `Novos produtos: **${changes.newItems.length}**`,
    `Alteracoes de preco: **${changes.priceChanges.length}**`,
    `Entraram na faixa do monitor: **${changes.enteredDisplayRange.length}**`,
    "",
    "## Novos produtos",
    ...reportItems(changes.newItems),
    "",
    "## Mudancas de preco",
    ...reportItems(changes.priceChanges, true),
    "",
    "## Entraram na faixa do monitor",
    ...reportItems(changes.enteredDisplayRange, true),
  ];
  if (run.failed_terms.length) {
    lines.push("", "## Falhas parciais", ...run.failed_terms.map((item) => `- ${item.term}: ${item.error}`));
  }
  return `${lines.join("\n")}\n`;
}

function reportItems(items, changed = false) {
  if (!items.length) return ["- Nenhum."];
  return items.map((item) => changed
    ? `- R$ ${formatNumber(item.previous_price_brl)} -> R$ ${formatNumber(item.price_brl)} - ${item.title} - ${item.url}`
    : `- R$ ${formatNumber(item.price_brl)} - ${item.title} - ${item.url}`);
}

function normalizeTask(term) {
  return typeof term === "string"
    ? { query: term, matchTerm: term }
    : { query: term.query, matchTerm: term.matchTerm ?? term.query, searchOptions: term.searchOptions };
}

function preferItem(left, right) {
  const leftDirect = /produto\.mercadolivre\.com\.br|\/p\/MLB/i.test(left.url);
  const rightDirect = /produto\.mercadolivre\.com\.br|\/p\/MLB/i.test(right.url);
  if (rightDirect && !leftDirect) return right;
  if (Number(right.price_brl) < Number(left.price_brl)) return right;
  return left;
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function nonNegativeNumber(value, fallback) {
  // value ausente (null/undefined/"") = "não informado" → usa o fallback.
  // Sem isto, Number(null) === 0 e (0 >= 0) devolvia 0, zerando maxDetails e
  // desligando a fase de ficha em toda execução sem --max-details explícito.
  if (value == null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizeText(value) {
  return normalizeMonitorText(value);
}

function formatNumber(value) {
  return Number(value).toLocaleString("pt-BR", { maximumFractionDigits: 2 });
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}
