import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractGpuLabel, extractRamGb, parseBrlPrice, textContainsCpuTerm } from "./lib/parsers.mjs";
import { extractMercadoLivreNotebookSpecs } from "./lib/mercadolivre-monitor.mjs";
import { isMercadoLivreNotebookDisplayPrice } from "./lib/mercadolivre-notebook-ranges.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OLX_DIR              = process.env.OLX_DATA_DIR              ?? path.join(ROOT, "data", "olx");
const ENJOEI_DIR           = process.env.ENJOEI_DATA_DIR           ?? path.join(ROOT, "data", "enjoei");
const ENJOEI_NOTEBOOKS_DIR = process.env.ENJOEI_NOTEBOOKS_DATA_DIR ?? path.join(ROOT, "data", "enjoei-notebooks");
const DOCKSTATIONS_DIR     = process.env.DOCKSTATIONS_DATA_DIR     ?? path.join(ROOT, "data", "dockstations");
const FITBIT_DIR           = process.env.FITBIT_DATA_DIR           ?? path.join(ROOT, "data", "fitbit");
const LIFEFACTORY_DIR      = process.env.LIFEFACTORY_DATA_DIR      ?? path.join(ROOT, "data", "lifefactory");
const TELA_BOOK3_DIR       = process.env.TELA_GALAXYBOOK3_DATA_DIR ?? path.join(ROOT, "data", "tela-galaxybook3");
const MELANGER_DIR         = process.env.MELANGER_DATA_DIR         ?? path.join(ROOT, "data", "melanger");
const BUDS4PRO_DIR         = process.env.GALAXY_BUDS4_PRO_DATA_DIR ?? path.join(ROOT, "data", "galaxy-buds4-pro");
const MERCADOLIVRE_NOTEBOOKS_DIR = process.env.MERCADOLIVRE_NOTEBOOKS_DATA_DIR ?? path.join(ROOT, "data", "mercadolivre-notebooks");
const MERCADOLIVRE_WATCHLISTS = [
  ["Galaxy Buds4 Pro", "Mercado Livre Galaxy Buds4 Pro", "R$ 500 - R$ 1.000", "mercadolivre-galaxy-buds4-pro"],
  ["Dockstations", "Mercado Livre Dockstations", "até R$ 500", "mercadolivre-dockstations"],
  ["Fitbit Air", "Mercado Livre Fitbit Air", "R$ 300 - R$ 600", "mercadolivre-fitbit-air"],
  ["Lifefactory", "Mercado Livre Lifefactory", "500 ml-1 L · R$ 25 - R$ 75", "mercadolivre-lifefactory"],
  ["Tela Book3", "Mercado Livre Tela Galaxy Book3", "BA96-08462A · até R$ 1.000", "mercadolivre-tela-galaxybook3"],
  ["Melanger", "Mercado Livre Melanger", "110/127V · R$ 1.000 - R$ 5.000", "mercadolivre-melanger"],
  ["Tênis 42", "Mercado Livre Tênis 42", "masculino · tamanho 42 · até R$ 500", "mercadolivre-tenis-42"],
];
const OUTPUT = path.join(ROOT, "index.html");
const REPO = "almeida3339/olx-daily";
const BLOB = `https://github.com/${REPO}/blob/main`;
const MAX = 5;
// Teto de preço para itens exibidos (espelha o filtro de mudanças de preço do
// monitor OLX). Aplicado aqui também para valer retroativamente em relatórios
// antigos, que foram gerados antes do filtro existir. Itens acima disso (ex.:
// notebooks > R$ 10 mil) não aparecem no dashboard.
const PRICE_CAP_BRL = 10000;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}

export { parseReport, formatRunLabelFromFile, summarizeMachine };

async function main() {
  const olxDetails = await latestSnapshotDetails(OLX_DIR);
  const enjoeiNbDetails = await latestSnapshotDetails(ENJOEI_NOTEBOOKS_DIR);
  const mercadoLivre = {
    reports: await gather(MERCADOLIVRE_NOTEBOOKS_DIR, "report-", null, await latestSnapshotDetails(MERCADOLIVRE_NOTEBOOKS_DIR)),
    updated: await latestRunLabel(MERCADOLIVRE_NOTEBOOKS_DIR),
  };
  if (!mercadoLivre.reports.length) {
    const current = await currentMercadoLivreSnapshotReport(MERCADOLIVRE_NOTEBOOKS_DIR, 8000);
    if (current) mercadoLivre.reports = [current];
  }
  const mercadoLivreWatchlists = await Promise.all(MERCADOLIVRE_WATCHLISTS.map(async ([chip, title, sub, folder]) => {
    const dir = path.join(ROOT, "data", folder);
    const reports = await gather(dir, "report-", null, await latestSnapshotDetails(dir));
    if (!reports.length) {
      const current = await currentMercadoLivreSnapshotReport(dir);
      if (current) reports.push(current);
    }
    return {
      chip, title, sub, dpath: `data/${folder}`,
      reports,
      updated: await latestRunLabel(dir),
    };
  }));
  const [olx, enjoeiNb, enjoei, dock, fitbit, lifefactory, telaBook3, melanger, buds4Pro] = await Promise.all([
    gather(OLX_DIR, "report-", "report-premium-", olxDetails),
    gather(ENJOEI_NOTEBOOKS_DIR, "report-", "report-premium-", enjoeiNbDetails),
    gather(ENJOEI_DIR, "report-", null),
    gather(DOCKSTATIONS_DIR, "report-", null),
    gather(FITBIT_DIR, "report-", null),
    gather(LIFEFACTORY_DIR, "report-", null),
    gather(TELA_BOOK3_DIR, "report-", null),
    gather(MELANGER_DIR, "report-", null),
    gather(BUDS4PRO_DIR, "report-", null),
  ]);
  const [olxUpdated, enjoeiNbUpdated, enjoeiTenisUpdated, dockUpdated, fitbitUpdated, lifefactoryUpdated, telaBook3Updated, melangerUpdated, buds4ProUpdated] = await Promise.all([
    latestRunLabel(OLX_DIR),
    latestRunLabel(ENJOEI_NOTEBOOKS_DIR),
    latestRunLabel(ENJOEI_DIR),
    latestRunLabel(DOCKSTATIONS_DIR),
    latestRunLabel(FITBIT_DIR),
    latestRunLabel(LIFEFACTORY_DIR),
    latestRunLabel(TELA_BOOK3_DIR),
    latestRunLabel(MELANGER_DIR),
    latestRunLabel(BUDS4PRO_DIR),
  ]);
  await fs.writeFile(
    OUTPUT,
    buildHtml({ olx, enjoeiNb, mercadoLivre, mercadoLivreWatchlists, enjoei, dock, fitbit, lifefactory, telaBook3, melanger, buds4Pro, olxUpdated, enjoeiNbUpdated, enjoeiTenisUpdated, dockUpdated, fitbitUpdated, lifefactoryUpdated, telaBook3Updated, melangerUpdated, buds4ProUpdated }),
    "utf8"
  );
  console.log(`Dashboard gerado: ${OUTPUT}`);
}

// ── coleta ──────────────────────────────────────────────────────────────────

async function latestSnapshotDetails(dir) {
  const all = await fs.readdir(dir).catch(() => []);
  const file = all.filter((n) => n.startsWith("snapshot-") && n.endsWith(".json")).sort().reverse()[0];
  if (!file) return new Map();
  const raw = await fs.readFile(path.join(dir, file), "utf8").catch(() => null);
  if (!raw) return new Map();
  try {
    const snapshot = JSON.parse(raw);
    return new Map((snapshot.items ?? []).filter((item) => item.url).map((item) => {
      const notebook = extractMercadoLivreNotebookSpecs(item.specs);
      return [item.url, {
        ...item,
        cpu: notebook.cpuModel ?? item.cpu,
        ram_gb: notebook.ram ?? item.ram_gb,
        storage_gb: notebook.storage ?? item.storage_gb,
        gpu: notebook.gpu ?? item.gpu,
      }];
    }));
  } catch {
    return new Map();
  }
}

async function gather(dir, prefix, excludePrefix, detailsByUrl = new Map()) {
  const all = await fs.readdir(dir).catch(() => []);
  const files = all
    .filter((n) => n.startsWith(prefix) && (!excludePrefix || !n.startsWith(excludePrefix)) && n.endsWith(".md"))
    .sort()
    .reverse();
  const out = [];
  const seenNewItems = new Set();
  for (const file of files) {
    if (out.length >= MAX) break;
    const txt = await fs.readFile(path.join(dir, file), "utf8").catch(() => null);
    if (!txt) continue;
    const p = parseReport(txt, detailsByUrl);
    p.newItems = p.newItems.filter((item) => {
      const key = item.url ?? `${item.fullTitle}|${item.price}`;
      if (seenNewItems.has(key)) return false;
      seenNewItems.add(key);
      return true;
    });
    p.newCount = p.newItems.length;
    if (p.newCount > 0 || p.priceCount > 0) out.push({ file, ...p, runLabel: formatRunLabelFromFile(file, p.date) });
  }
  return out;
}

// Rotulo BRT da rodada mais recente de uma fonte, independente de ter tido
// novidades (o gather so retorna cards com mudanca, entao nao serve para isso).
// Usa o report comum (nao-premium), que toda rodada gera, para que a ordenacao
// lexicografica por nome reflita a ordem cronologica real.
async function latestRunLabel(dir) {
  const all = await fs.readdir(dir).catch(() => []);
  const file = all
    .filter((n) => n.startsWith("report-") && !n.startsWith("report-premium-") && n.endsWith(".md"))
    .sort()
    .reverse()[0];
  if (!file) return { label: null, fresh: false, ts: null };
  const ts = runTimestampFromFile(file);
  // "fresh" = última coleta há menos de 24h (destaque no dashboard).
  const fresh = ts != null && (Date.now() - ts.getTime()) < 24 * 60 * 60 * 1000;
  return { label: formatRunLabelFromFile(file, null), fresh, ts: ts ? ts.getTime() : null };
}

// Extrai o instante (UTC) do nome do arquivo de relatório, ou null se não casar.
function runTimestampFromFile(file) {
  const m = file.match(/report(?:-premium)?-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.md$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, ms] = m;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

// ── parser ───────────────────────────────────────────────────────────────────

function parseReport(txt, detailsByUrl = new Map()) {
  const dateM = txt.match(/Data:\s*(\d{4}-\d{2}-\d{2})/) ?? txt.match(/[—\-]\s*(\d{4}-\d{2}-\d{2})/);
  const date = dateM ? dateM[1] : null;

  // Contagem e itens derivam das próprias seções (já filtradas pelo teto de
  // preço), em vez do resumo. Assim o badge bate com as linhas exibidas e
  // relatórios cujos únicos itens estão acima do teto somem do dashboard.
  const withinCap = (item) => {
    const p = parseBrlPrice(item.priceTo ?? item.price);
    return p == null || p <= PRICE_CAP_BRL;
  };
  const newItems = extractItems(txt, /^## Novos (an[úu]ncios|produtos|notebooks)/m, detailsByUrl).filter(withinCap);
  const priceItems = extractItems(txt, /^## Mudan[cç]as? de pre[cç]o/m, detailsByUrl).filter(withinCap);

  return {
    newCount: newItems.length,
    priceCount: priceItems.length,
    date,
    newItems: newItems.slice(0, MAX),
    priceItems: priceItems.slice(0, MAX),
    partial: /Cobertura parcial:\s*\*\*sim\*\*/i.test(txt),
  };
}

function extractItems(txt, sectionRe, detailsByUrl = new Map()) {
  const m = txt.match(sectionRe);
  if (!m) return [];
  const rest = txt.slice(m.index);
  const nextSec = rest.slice(1).search(/^## /m);
  const block = nextSec === -1 ? rest : rest.slice(0, nextSec + 1);
  return block
    .split("\n")
    .filter((l) => l.startsWith("- ") && !/Nenhum|Observa[cç]|CPUs? exclu/i.test(l))
    .map((line) => parseLine(line, detailsByUrl));
}

function parseLine(line, detailsByUrl = new Map()) {
  const raw = line.slice(2).trim();
  const urlM = raw.match(/https?:\/\/\S+/);
  const url = urlM ? urlM[0].replace(/[.,)]+$/, "") : null;
  const changeM = raw.match(/(R\$\s*[\d.,]+)\s*(?:→|->)\s*(R\$\s*[\d.,]+)/);
  const priceM = raw.match(/R\$\s*[\d.,]+/);
  const priceFrom = changeM ? changeM[1].trim() : null;
  const priceTo = changeM ? changeM[2].trim() : null;
  const price = priceM ? priceM[0] : null;
  let title = raw;
  if (url) title = title.replace(url, "");
  if (changeM) title = title.replace(changeM[0], "");
  else if (priceM) title = title.replace(priceM[0], "");
  title = title.replace(/^\s*[—–\-,\s]+/, "").replace(/[—–\-,\s]+$/, "");
  const fullTitle = title || "—";
  const shortTitle = fullTitle.length > 72 ? fullTitle.slice(0, 72) + "…" : fullTitle;
  return { title: shortTitle, fullTitle, price, url, priceFrom, priceTo, machine: summarizeMachine(fullTitle, url ? detailsByUrl.get(url) : null) };
}

function summarizeMachine(text, details = null) {
  const [rawTitle, ...metaParts] = (text ?? "").split(/\s+[—–]\s+/).map((part) => part.trim()).filter(Boolean);
  const title = rawTitle || text || "";
  const meta = metaParts.join(" — ");
  const detailMeta = details ? formatSnapshotSpecs(details) : "";
  const all = `${title} ${meta} ${detailMeta}`;
  const brand = extractBrand(title);
  const cpu = extractCpu(title) ?? extractCpu(meta) ?? extractCpu(detailMeta) ?? details?.cpu ?? extractCpuFromMeta(meta);
  const ram = extractRam(all);
  const ssd = extractSsd(all);
  const gpu = extractGpu(title) ?? extractGpu(meta) ?? extractGpu(detailMeta);
  const model = cleanModel(title, brand, cpu, gpu, ram, ssd);
  return { brand, model, cpu, ram, ssd, gpu };
}

function formatSnapshotSpecs(item) {
  const cpuLabel =
    item.cpu ??
    item.cpu_term ??
    (Array.isArray(item.cpu_terms) && item.cpu_terms.length ? item.cpu_terms.join(", ") : null);
  return [
    cpuLabel ? `cpu: ${cpuLabel}` : "",
    item.ram_gb ? `${item.ram_gb} GB RAM` : "",
    item.storage_gb ? `${item.storage_gb} GB SSD` : "",
    item.gpu ? `GPU ${item.gpu}` : "",
  ].filter(Boolean).join(" / ");
}

function extractBrand(text) {
  const brands = [
    ["Alienware", /\balienware\b/i],
    ["Lenovo", /\blenovo\b/i],
    ["Lenovo", /\bloq\b|\blegion\b|\bideapad\b|\bthinkpad\b/i],
    ["Acer", /\bacer\b/i],
    ["Acer", /\baspire\b|\bpredator\b|\bnitro\b/i],
    ["Dell", /\bdell\b/i],
    ["Dell", /\binspiron\b|\bxps\b/i],
    ["Asus", /\basus\b|\brog\b|\btuf\b/i],
    ["HP", /\bhp\b|\belitebook\b|\bomen\b/i],
    ["Samsung", /\bsamsung\b|\bgalaxy book\b/i],
    ["Vaio", /\bvaio\b/i],
    ["MSI", /\bmsi\b|\btitan\b|\bkatana\b|\braider\b|\bstealth\b/i],
    ["Gigabyte", /\bgigabyte\b|\baorus\b/i],
    ["Avell", /\bavell\b/i],
    ["Nave", /\bnave\b/i],
    ["GPD", /\bgpd\b/i],
  ];
  return brands.find(([, re]) => re.test(text))?.[0] ?? "n/d";
}

function extractCpu(text) {
  const patterns = [
    /\b(?:intel\s+)?core\s+ultra\s+i?([579])[\s-]*(\d{3})(h|hx)?\b/i,
    /\bultra\s+i?([579])[\s-]*(\d{3})(h|hx)?\b/i,
    /\bryzen\s+ai\s+max\+?\s*(?:pro\s+)?(\d{3})\b/i,
    /\bryzen\s+ai\s+([3579])[\s-]*(\d{3})\b/i,
    /\bai\s*([3579])[\s-]*(\d{3})\b/i,
    /\bai([3579])(\d{3})\b/i,
    /\b(?:intel\s+)?core\s+([3579])[\s-]*(\d{4,5})([a-z]{0,2})\b/i,
    /\b(?:intel\s+)?(?:core\s+)?(i[3579])[\s-]*(\d{4,5})([a-z]{0,2})\b/i,
    /\bryzen\s+(?:ai\s+)?([3579])[\s-]*(\d{4})([a-z]{1,3})\b/i,
    /\bhx\s*(370|470)\b/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    if (/\bai\s+max/i.test(m[0])) return `Ryzen AI Max ${m[1]}`;
    if (/\bhx\s*\d{3}/i.test(m[0])) return `HX ${m[1]}`;
    if (/ultra/i.test(m[0])) return `Ultra ${m[1]} ${m[2]}${(m[3] ?? "h").toUpperCase()}`;
    if (/\b(?:ryzen\s+)?ai/i.test(m[0])) return `Ryzen AI ${m[1]} ${m[2]}`;
    if (/\bcore\s+[3579]\b/i.test(m[0])) return `Core ${m[1]} ${m[2]}${(m[3] ?? "").toUpperCase()}`;
    if (/ryzen/i.test(m[0])) return `Ryzen ${m[1]} ${m[2]}${(m[3] ?? "").toUpperCase()}`;
    return `${m[1].toUpperCase()}-${m[2]}${(m[3] ?? "").toUpperCase()}`;
  }
  return null;
}

function extractCpuFromMeta(text) {
  const m = text.match(/\bcpu:\s*([^—]+)/i);
  if (!m) return "n/d";
  return m[1]
    .split(",")
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 2)
    .join(", ") || "n/d";
}

// Reusa o extrator de RAM canônico (parsers.mjs), que também resolve "16gb"
// sem qualificador quando há armazenamento separado ("1tb ssd"). Evita manter
// dois parsers divergentes — era por isso que o card ML mostrava RAM n/d.
function extractRam(text) {
  const gb = extractRamGb(text ?? "");
  return gb != null ? `${gb} GB` : "n/d";
}

function extractSsd(text) {
  const mTb = text.match(/\b(\d+(?:[\.,]\d+)?)\s*tb\b/i);
  if (mTb) {
    const value = Number(mTb[1].replace(",", "."));
    return Number.isFinite(value) ? `${value.toLocaleString("pt-BR")} TB` : "n/d";
  }
  const mGb = text.match(/\b(\d{2,5})\s*(?:gb)?\s*(?:ssd|nvme|m\.2)\b/i)
    ?? text.match(/\bssd\s*(?:de\s*)?(\d{2,5})\s*gb\b/i)
    ?? text.match(/\/\s*(\d{2,5})\s*GB\b/i)
    ?? text.match(/\b(128|256|512|1024|2048|4096)\s*gb\b/i);
  return mGb ? `${Number(mGb[1]).toLocaleString("pt-BR")} GB` : "n/d";
}

function extractGpu(text) {
  return extractGpuLabel(text);
}

function cleanModel(text, brand, cpu, gpu, ram, ssd) {
  let s = (text ?? "").toString().toLowerCase();
  s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  s = s
    .replace(/\bnotebook\b|\blaptop\b|\bgamer\b|\bpremium\b|\btop de linha\b|\btop\b|\bautentico\b|\bnovo em folha\b|\bnovinho em folha\b|\bnovo\b|\bfolha\b|\bpouco uso\b|\bbrindes?\b|\blacrado\b|\bbarato\b|\bestado de novo\b|\bcaixa original\b|\boriginal\b/gi, " ")
    .replace(/\bryzen\s+[3579]\b/gi, " ")
    .replace(/\bryzen\s+ai\s+[3579]\s*\d{3}\b|\bai\s*[3579]\s*\d{3}\b|\bai[3579]\d{3}\b/gi, " ")
    .replace(/\b(?:core\s+)?ultra\s+i?[579]\s*-?\s*\d{3}(?:h|hx)?\b/gi, " ")
    .replace(/\bintel\b|\bcore\b|\bultra\b|\bamd\b|\bryzen\b/gi, " ")
    .replace(/\b(i[3579])[\s-]*(\d{4,5})([a-z]{0,2})\b/gi, " ")
    .replace(/\b[3579][\s-]*\d{4,5}(?:h|hx|hs)?\b/gi, " ")
    .replace(/\b[3579][\s-]*\d{3}(?:h|hx)\b/gi, " ")
    .replace(/\bai\s+[3579]\b/gi, " ")
    .replace(/\b\d{3}hx\b/gi, " ")
    .replace(/\b\d{3}h\b/gi, " ")
    .replace(/\bhx\s*370\b|\bai\b/gi, " ")
    .replace(/\b\d{4,5}(?:h|hx|hs)\b/gi, " ")
    .replace(/\bddr\d?\b/gi, " ")
    .replace(/\b\d{1,3}\s*(?:gb|gbs)\s*(?:de\s*)?(?:ram|memoria|ddr\d?)\b/gi, " ")
    .replace(/\b(?:ram|memoria)\s*:?\s*\d{1,3}\s*(?:gb|gbs)\b/gi, " ")
    .replace(/\b(?:4|6|8|12|16|24|32|64)\s*(?:gb|gbs)\b/gi, " ")
    .replace(/\b\d+(?:[\.,]\d+)?\s*tb\b/gi, " ")
    .replace(/\b\d{2,5}\s*(?:gb)?\s*(?:ssd|nvme|m\.2)\b/gi, " ")
    .replace(/\b(128|256|512|1024|2048|4096)\s*gb\b/gi, " ")
    .replace(/\bssd\s*(?:de\s*)?\d+(?:[\.,]\d+)?\s*tb\b/gi, " ")
    .replace(/\bssd\s*(?:de\s*)?\d{2,5}\s*gb\b/gi, " ")
    .replace(/\brtx\s*\d{4}(?:\s*(?:ti|super))?\b|\bgtx\s*\d{4}(?:\s*(?:ti|super))?\b|\bradeon\s*(?:rx\s*)?\d{4}[a-z]{0,2}\b|\barc\s*[a-z]\d{3}\b/gi, " ")
    .replace(/\bssd\b|\bnvme\b|\bm\.2\b|\boled\b|\bram\b|\brtx\b|\bgtx\b|\braro\b|\b\d{4,5}gb\b|\b\d+(?:[,.]\d+)?k\b|\b\d{2,5}\s*mhz\b|\b\d{2,3}\s*hz\b/gi, " ")
    .replace(/\btela\b|\btouch screen\b|\bwindows\b|\bwin\s*11\b|\bw11\b|\bfhd\b|\bips\b|\bfull hd\b|\bquad hd\b|\bquadhd\b|\bnebula\b|\bcaixa\b|\bcinza[-\s\w]*/gi, " ")
    .replace(/\b\d{2}(?:[,.]\d)?\s*(?:\"|p|pol|polegadas)/gi, " ");
  s = s.replace(/\bdell\b|\balienware\b|\blenovo\b|\bacer\b|\basus\b|\bhp\b|\bsamsung\b|\bgalaxy book\b|\bvaio\b|\bmsi\b|\bgigabyte\b|\bavell\b|\bnave\b|\bgpd\b/gi, " ");
  s = s.replace(/\s*[|/(),:;.+*\-]\s*/g, " ").replace(/\s+/g, " ").trim();
  const stopwords = new Set(["de", "do", "da", "com", "e", "em", "para", "na", "no", "a", "br"]);
  const words = s.split(" ").filter((word) => word && !stopwords.has(word)).slice(0, 5);
  return toTitleCase(words.join(" ")) || "n/d";
}

function toTitleCase(text) {
  return text.replace(/\b([a-zà-ú0-9]+)\b/gi, (word) => {
    const upperWords = new Set(["g15", "loq", "rog", "tuf", "ssd", "oled", "g11", "g16", "f15", "v15", "m16"]);
    if (/^ux\d+$/i.test(word)) return word.toUpperCase();
    return upperWords.has(word.toLowerCase()) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1);
  });
}

function formatRunLabelFromFile(file, fallbackDate) {
  const m = file.match(/report(?:-premium)?-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.md$/);
  if (!m) return fallbackDate ?? "—";

  const [, year, month, day, hour, minute, second, ms] = m;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}.${ms}Z`);
  if (Number.isNaN(date.getTime())) return fallbackDate ?? "—";

  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

async function currentMercadoLivreSnapshotReport(dir, displayMax = Infinity) {
  const all = await fs.readdir(dir).catch(() => []);
  const file = all.filter((name) => name.startsWith("snapshot-") && name.endsWith(".json")).sort().reverse()[0];
  if (!file) return null;
  const raw = await fs.readFile(path.join(dir, file), "utf8").catch(() => null);
  if (!raw) return null;
  const snapshot = JSON.parse(raw);
  const items = (snapshot.items ?? [])
    .filter((item) => item.status === "active" && Number(item.price_brl) <= displayMax)
    .slice(0, MAX)
    .map((item) => ({
      title: item.title,
      fullTitle: item.title,
      price: `R$ ${Number(item.price_brl).toLocaleString("pt-BR")}`,
      url: item.url,
      machine: summarizeMachine(item.title, {
        ...item,
        ...(() => {
          const specs = extractMercadoLivreNotebookSpecs(item.specs);
          return {
            cpu: specs.cpuModel,
            ram_gb: specs.ram,
            storage_gb: specs.storage,
            gpu: specs.gpu,
          };
        })(),
      }),
    }));
  if (!items.length) return null;
  return {
    file,
    runLabel: snapshot.generated_at ? formatDateTimeBrt(new Date(snapshot.generated_at)) : null,
    date: snapshot.generated_at?.slice(0, 10),
    newCount: items.length,
    priceCount: 0,
    newItems: items,
    priceItems: [],
    partial: Boolean(snapshot.run?.partial),
    current: true,
  };
}

function formatDateTimeBrt(date) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

// ── HTML ─────────────────────────────────────────────────────────────────────

function e(s) {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildHtml({ olx, enjoeiNb, mercadoLivre, mercadoLivreWatchlists, enjoei, dock, fitbit, lifefactory, telaBook3, melanger, buds4Pro, olxUpdated, enjoeiNbUpdated, enjoeiTenisUpdated, dockUpdated, fitbitUpdated, lifefactoryUpdated, telaBook3Updated, melangerUpdated, buds4ProUpdated }) {
  // Ordenação em dois níveis: primeiro as fontes COM achados recentes (cards com
  // conteúdo), depois as vazias ("Nenhum run com novidades") — sempre no fundo,
  // mesmo que tenham rodado há pouco. Dentro de cada grupo, mais recente primeiro.
  // Tanto os chips quanto os cards seguem esta ordem.
  const sources = [
    { chip: "Mercado Livre", title: "Mercado Livre Notebooks", sub: "R$ 2.000 - R$ 8.000", data: mercadoLivre.reports, dpath: "data/mercadolivre-notebooks", upd: mercadoLivre.updated },
    ...mercadoLivreWatchlists.map((source) => ({
      chip: source.chip,
      title: source.title,
      sub: source.sub,
      data: source.reports,
      dpath: source.dpath,
      upd: source.updated,
    })),
    { chip: "OLX",              title: "OLX Notebooks",     sub: "R$ 2.000 – R$ 8.000",                          data: olx,         dpath: "data/olx",              upd: olxUpdated },
    { chip: "Enjoei Notebooks", title: "Enjoei Notebooks",  sub: "R$ 1.500 – R$ 8.000",                          data: enjoeiNb,    dpath: "data/enjoei-notebooks", upd: enjoeiNbUpdated },
    { chip: "Enjoei Tênis",     title: "Enjoei Tênis 42",   sub: "até R$ 500,00",                                data: enjoei,      dpath: "data/enjoei",           upd: enjoeiTenisUpdated },
    { chip: "Dockstations",     title: "Dockstations",      sub: "OLX + Enjoei · até R$ 500,00",                 data: dock,        dpath: "data/dockstations",     upd: dockUpdated },
    { chip: "Fitbit Air",       title: "Fitbit Air",        sub: "OLX + Enjoei · R$ 300 – R$ 600",               data: fitbit,      dpath: "data/fitbit",           upd: fitbitUpdated },
    { chip: "Lifefactory",      title: "Lifefactory",       sub: "OLX + Enjoei · 500ml–1L · R$ 25 – R$ 75",      data: lifefactory, dpath: "data/lifefactory",      upd: lifefactoryUpdated },
    { chip: "Tela Book3",       title: "Tela Galaxy Book3", sub: "BA96-08462A · OLX + Enjoei · até R$ 1.000",    data: telaBook3,   dpath: "data/tela-galaxybook3", upd: telaBook3Updated },
    { chip: "Melanger",         title: "Melanger",          sub: "110V · OLX + Enjoei · R$ 1.000 – R$ 5.000",    data: melanger,    dpath: "data/melanger",         upd: melangerUpdated },
    { chip: "Galaxy Buds4 Pro", title: "Galaxy Buds4 Pro",  sub: "OLX + Enjoei · R$ 500 – R$ 1.000",             data: buds4Pro,    dpath: "data/galaxy-buds4-pro", upd: buds4ProUpdated },
  ];

  // Ordenação e data do card vêm do ÚLTIMO ACHADO (report com novidade), não da
  // última coleta. data[0] é o achado mais recente (gather ordena desc). Fontes
  // sem achado vão para o fim, com a última coleta apenas como desempate.
  const DAY = 24 * 60 * 60 * 1000;
  for (const s of sources) {
    const top = s.data[0];
    const findTs = top ? (runTimestampFromFile(top.file)?.getTime() ?? null) : null;
    s.hasFind = top != null;
    s.sortTs = findTs ?? s.upd.ts ?? null;
    s.stampLabel = top ? (top.runLabel ?? top.date) : s.upd.label;
    s.stampFresh = s.sortTs != null && (Date.now() - s.sortTs) < DAY;
  }
  sources.sort((a, b) => {
    if (a.hasFind !== b.hasFind) return (b.hasFind ? 1 : 0) - (a.hasFind ? 1 : 0);  // com achados primeiro
    return (b.sortTs ?? -Infinity) - (a.sortTs ?? -Infinity);                       // depois pelo último achado
  });

  // Topo: apenas dois chips por plataforma (OLX, Enjoei), cada um agregando a
  // coleta mais recente entre todas as buscas daquela plataforma. As watchlists
  // combinadas (Dockstations, Fitbit, etc.) contam para as duas. O timestamp de
  // cada busca específica vai dentro do próprio card (renderSection).
  const platformChip = (label, platform) => {
    const members = sources.filter((s) => platformsOf(s.dpath).includes(platform) && s.upd.ts != null);
    if (!members.length) return `<span class="u"><b>${e(label)}</b> <time>—</time></span>`;
    const latest = members.reduce((a, b) => (b.upd.ts > a.upd.ts ? b : a));
    return `<span class="u${latest.upd.fresh ? " fresh" : ""}"><b>${e(label)}</b> <time>${e(latest.upd.label)}</time></span>`;
  };
  const chipsHtml = [
    platformChip("OLX", "olx"),
    platformChip("Enjoei", "enjoei"),
    platformChip("Mercado Livre", "mercadolivre"),
  ].join("\n");
  const cardsHtml = sources
    .map((s) => renderSection(s.title, s.sub, s.data, s.dpath, { label: s.stampLabel, fresh: s.stampFresh }))
    .join("\n");

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Monitor</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;padding:28px 24px;max-width:1680px;margin:0 auto}
h1{font-size:1.3rem;color:#f0f6fc;margin-bottom:5px}
.meta{color:#8b949e;font-size:.8rem;margin-bottom:8px}
.updates{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:.8rem;margin-bottom:26px}
.updates .u{color:#8b949e;background:#161b22;border:1px solid #30363d;border-radius:6px;padding:3px 9px}
.updates .u b{color:#c9d1d9;font-weight:600}
.updates .u time{color:#58a6ff;font-variant-numeric:tabular-nums}
.updates .u.fresh{color:#3fb950;background:#0f2417;border-color:#238636}
.updates .u.fresh b{color:#56d364}
.updates .u.fresh time{color:#56d364}
.updates .u.fresh::before{content:"●";color:#3fb950;font-size:8px;margin-right:6px;vertical-align:middle}
.meta a{color:#58a6ff;text-decoration:none}
.meta a:hover{text-decoration:underline}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:18px;align-items:start}
.sec{background:#161b22;border:1px solid #30363d;border-radius:8px;overflow:hidden}
.sh{padding:14px 16px 10px;border-bottom:1px solid #21262d}
.sh .shr{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.sh h2{font-size:.9rem;font-weight:600;color:#f0f6fc}
.sh small{font-size:.72rem;color:#8b949e}
.sd{font-size:.72rem;color:#8b949e;font-variant-numeric:tabular-nums;white-space:nowrap}
.sd.fresh{color:#3fb950}
.sb{padding:12px 14px}
.empty{color:#8b949e;font-size:.8rem;padding:4px 0}
.card{border:1px solid #21262d;border-radius:6px;margin-bottom:10px;overflow:hidden}
.card:last-child{margin-bottom:0}
.ch{display:flex;justify-content:space-between;align-items:center;padding:7px 10px;background:#0d1117;gap:8px}
.cd{font-size:.73rem;color:#8b949e;white-space:nowrap}
.rl{color:#58a6ff;text-decoration:none;font-size:.7rem;margin-left:7px}
.rl:hover{text-decoration:underline}
.badges{display:flex;gap:5px;flex-shrink:0}
.badge{font-size:.68rem;font-weight:700;padding:2px 8px;border-radius:10px;white-space:nowrap}
.bn{background:#1a4a2e;color:#3fb950;border:1px solid #238636}
.bp{background:#3d2b00;color:#e3b341;border:1px solid #9e6a03}
.bw{background:#4b1f24;color:#ff7b72;border:1px solid #da3633}
.ci{padding:5px 10px 8px}
.item{padding:7px 0;border-bottom:1px solid #21262d;font-size:.78rem}
.item:last-child{border-bottom:none}
.legacy-item{display:flex;align-items:center;gap:8px}
.machine-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:5px}
.machine-title{color:#c9d1d9;font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.machine-title a{color:#c9d1d9;text-decoration:none}
.machine-title a:hover{color:#58a6ff;text-decoration:underline}
.specs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:3px 10px;color:#8b949e}
.spec{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.spec b{color:#c9d1d9;font-weight:600}
.it{color:#c9d1d9;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.it a{color:#c9d1d9;text-decoration:none}
.it a:hover{color:#58a6ff;text-decoration:underline}
.ip{color:#58a6ff;font-weight:700;white-space:nowrap;font-size:.78rem}
.pf{color:#8b949e;text-decoration:line-through;font-size:.75rem}
.pt{color:#e3b341;font-weight:700;font-size:.75rem}
.price-change{display:inline-flex;flex-direction:column;align-items:flex-end;gap:1px}
.delta{font-size:.7rem;font-weight:700;line-height:1.1}
.delta.up{color:#f85149}
.delta.down{color:#3fb950}
</style>
</head>
<body>
<h1>Monitor</h1>
<p class="meta">Última atualização por fonte (BRT) &nbsp;·&nbsp; <a href="https://github.com/${REPO}" target="_blank" rel="noopener noreferrer">ver repositório ↗</a></p>
<div class="updates">
${chipsHtml}
</div>
<div class="grid">
${cardsHtml}
</div>
</body>
</html>`;
}

// Quais plataformas cada busca usa (para os chips agregados do topo).
// Combinadas (dockstations/fitbit/lifefactory/tela/melanger) contam para as duas.
function platformsOf(dpath) {
  if (dpath === "data/olx") return ["olx"];
  if (dpath === "data/enjoei" || dpath === "data/enjoei-notebooks") return ["enjoei"];
  if (dpath.startsWith("data/mercadolivre-")) return ["mercadolivre"];
  return ["olx", "enjoei"];
}

function renderSection(title, sub, reports, dpath, stampInfo) {
  const showSpecs = dpath === "data/olx" || dpath === "data/enjoei-notebooks" || dpath === "data/mercadolivre-notebooks";
  const body = reports.length === 0
    ? `<p class="empty">Nenhum run com novidades recentes.</p>`
    : reports.map((r) => renderCard(r, dpath, showSpecs)).join("\n");
  // Data/hora do último achado desta busca, dentro do card (verde se < 24h).
  const stamp = stampInfo && stampInfo.label
    ? `<time class="sd${stampInfo.fresh ? " fresh" : ""}">${e(stampInfo.label)}</time>`
    : "";
  return `<div class="sec">
  <div class="sh"><div class="shr"><h2>${e(title)}</h2>${stamp}</div><small>${e(sub)} &nbsp;·&nbsp; últimos ${reports.length} com novidades</small></div>
  <div class="sb">${body}</div>
</div>`;
}

function renderCard(r, dpath, showSpecs) {
  const url = `${BLOB}/${dpath}/${r.file}`;
  const bn = r.newCount > 0
    ? `<span class="badge bn">${r.current ? "" : "+"}${r.newCount} ${r.current ? "ativo" : "novo"}${r.newCount > 1 ? "s" : ""}</span>`
    : "";
  const bp = r.priceCount > 0 ? `<span class="badge bp">${r.priceCount} preço${r.priceCount > 1 ? "s" : ""}</span>` : "";
  const bw = r.partial ? `<span class="badge bw">parcial</span>` : "";
  const rows = [
    ...r.newItems.map((i) => renderRow(i, false, showSpecs)),
    ...r.priceItems.map((i) => renderRow(i, true, showSpecs)),
  ].join("\n");
  return `<div class="card">
  <div class="ch">
    <span class="cd">${e(r.runLabel ?? r.date ?? "—")}<a class="rl" href="${e(url)}" target="_blank" rel="noopener noreferrer">ver completo ↗</a></span>
    <div class="badges">${bw}${bn}${bp}</div>
  </div>
  ${rows ? `<div class="ci">${rows}</div>` : ""}
</div>`;
}

// Diferenca de preco (perspectiva de comprador): subiu = "+ R$ X" vermelho
// (ruim), desceu = "- R$ X" verde (bom). Retorna "" se nao der pra comparar
// ou se o valor nao mudou.
function priceDelta(priceFrom, priceTo) {
  const from = parseBrlPrice(priceFrom);
  const to = parseBrlPrice(priceTo);
  if (from == null || to == null || from === to) return "";
  const up = to > from;
  const abs = Math.abs(to - from).toLocaleString("pt-BR");
  return `<span class="delta ${up ? "up" : "down"}" title="${up ? "subiu" : "desceu"}">${up ? "+" : "-"} R$ ${abs}</span>`;
}

// Bloco de preco para uma mudanca: linha "de → para" com a diferenca embaixo.
function priceChangeHtml(item) {
  return `<span class="price-change"><span><span class="pf">${e(item.priceFrom)}</span> → <span class="pt">${e(item.priceTo)}</span></span>${priceDelta(item.priceFrom, item.priceTo)}</span>`;
}

function renderRow(item, isPrice, showSpecs) {
  if (showSpecs && item.machine) return renderMachineRow(item, isPrice);
  const titleHtml = item.url
    ? `<a href="${e(item.url)}" target="_blank" rel="noopener noreferrer">${e(item.title)}</a>`
    : e(item.title);
  if (isPrice && item.priceFrom && item.priceTo) {
    return `<div class="item legacy-item"><span class="it">${titleHtml}</span>${priceChangeHtml(item)}</div>`;
  }
  return `<div class="item legacy-item"><span class="it">${titleHtml}</span>${item.price ? `<span class="ip">${e(item.price)}</span>` : ""}</div>`;
}

function renderMachineRow(item, isPrice) {
  const m = item.machine;
  const title = [m.brand, m.model].filter((x) => x && x !== "n/d").join(" ") || m.model || "n/d";
  const titleHtml = item.url
    ? `<a href="${e(item.url)}" target="_blank" rel="noopener noreferrer">${e(title)}</a>`
    : e(title);
  const gpu = m.gpu ?? "integrada/n/d";
  const priceHtml = isPrice && item.priceFrom && item.priceTo
    ? priceChangeHtml(item)
    : item.price ? `<span class="ip">${e(item.price)}</span>` : "";
  return `<div class="item">
  <div class="machine-head"><span class="machine-title">${titleHtml}</span>${priceHtml}</div>
  <div class="specs">
    <span class="spec">CPU <b>${e(m.cpu)}</b></span>
    <span class="spec">RAM <b>${e(m.ram)}</b></span>
    <span class="spec">SSD <b>${e(m.ssd)}</b></span>
    <span class="spec">GPU <b>${e(gpu)}</b></span>
  </div>
</div>`;
}
