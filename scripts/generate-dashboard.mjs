import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractGpuLabel } from "./lib/parsers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OLX_DIR              = process.env.OLX_DATA_DIR              ?? path.join(ROOT, "data", "olx");
const ENJOEI_DIR           = process.env.ENJOEI_DATA_DIR           ?? path.join(ROOT, "data", "enjoei");
const ENJOEI_NOTEBOOKS_DIR = process.env.ENJOEI_NOTEBOOKS_DATA_DIR ?? path.join(ROOT, "data", "enjoei-notebooks");
const OUTPUT = path.join(ROOT, "index.html");
const REPO = "almeida3339/olx-daily";
const BLOB = `https://github.com/${REPO}/blob/main`;
const MAX = 5;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}

export { parseReport, formatRunLabelFromFile, summarizeMachine };

async function main() {
  const olxDetails = await latestSnapshotDetails(OLX_DIR);
  const enjoeiNbDetails = await latestSnapshotDetails(ENJOEI_NOTEBOOKS_DIR);
  const [olx, premium, enjoeiNb, enjoeiNbPremium, enjoei] = await Promise.all([
    gather(OLX_DIR, "report-", "report-premium-", olxDetails),
    gather(OLX_DIR, "report-premium-", null, olxDetails),
    gather(ENJOEI_NOTEBOOKS_DIR, "report-", "report-premium-", enjoeiNbDetails),
    gather(ENJOEI_NOTEBOOKS_DIR, "report-premium-", null, enjoeiNbDetails),
    gather(ENJOEI_DIR, "report-", null),
  ]);
  const now = new Date().toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "full",
    timeStyle: "short",
  });
  await fs.writeFile(OUTPUT, buildHtml({ olx, premium, enjoeiNb, enjoeiNbPremium, enjoei, now }), "utf8");
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
    return new Map((snapshot.items ?? []).filter((item) => item.url).map((item) => [item.url, item]));
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
  for (const file of files) {
    if (out.length >= MAX) break;
    const txt = await fs.readFile(path.join(dir, file), "utf8").catch(() => null);
    if (!txt) continue;
    const p = parseReport(txt, detailsByUrl);
    if (p.newCount > 0 || p.priceCount > 0) out.push({ file, ...p, runLabel: formatRunLabelFromFile(file, p.date) });
  }
  return out;
}

// ── parser ───────────────────────────────────────────────────────────────────

function parseReport(txt, detailsByUrl = new Map()) {
  const num = (patterns) => {
    for (const r of patterns) { const m = txt.match(r); if (m) return +m[1]; }
    return 0;
  };
  const newCount = num([
    /Novos an[úu]ncios v[aá]lidos[^:]*:\s*\*\*(\d+)\*\*/,
    /Novos an[úu]ncios:\s*\*\*(\d+)\*\*/,
    /Novos produtos:\s*\*\*(\d+)\*\*/,
    /Novos notebooks[^:]*:\s*\*\*(\d+)\*\*/,
  ]);
  const priceCount = num([
    /Altera[cç][oõ]es de pre[cç]o[^:]*:\s*\*\*(\d+)\*\*/,
    /Altera[cç]oes de preco:\s*\*\*(\d+)\*\*/,
  ]);
  const dateM = txt.match(/[—\-]\s*(\d{4}-\d{2}-\d{2})/);
  const date = dateM ? dateM[1] : null;
  const newItems = extractItems(txt, /^## Novos (an[úu]ncios|produtos|notebooks)/m, detailsByUrl);
  const priceItems = extractItems(txt, /^## Mudan[cç]as? de pre[cç]o/m, detailsByUrl);
  return { newCount, priceCount, date, newItems, priceItems };
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
    .slice(0, MAX)
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
  const cpu = extractCpu(title) ?? extractCpu(meta) ?? extractCpu(detailMeta) ?? extractCpuFromMeta(meta);
  const ram = extractRam(all);
  const ssd = extractSsd(all);
  const gpu = extractGpu(title) ?? extractGpu(meta) ?? extractGpu(detailMeta);
  const model = cleanModel(title, brand, cpu, gpu, ram, ssd);
  return { brand, model, cpu, ram, ssd, gpu };
}

function formatSnapshotSpecs(item) {
  return [
    item.cpu_term ? `cpu: ${item.cpu_term}` : "",
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
    /\bryzen\s+ai\s+([3579])[\s-]*(\d{3})\b/i,
    /\bai\s*([3579])[\s-]*(\d{3})\b/i,
    /\bai([3579])(\d{3})\b/i,
    /\b(?:intel\s+)?core\s+([3579])[\s-]*(\d{4,5})([a-z]{0,2})\b/i,
    /\b(?:intel\s+)?(?:core\s+)?(i[3579])[\s-]*(\d{4,5})([a-z]{0,2})\b/i,
    /\bryzen\s+(?:ai\s+)?([3579])[\s-]*(\d{4})([a-z]{1,3})\b/i,
    /\b(hx\s*370)\b/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    if (/hx\s*370/i.test(m[0])) return "HX 370";
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

function extractRam(text) {
  const m = text.match(/\b(\d{1,3})\s*(?:gb|gbs)\s*(?:de\s*)?(?:ram|mem[oó]ria|ddr\d?)\b/i)
    ?? text.match(/\b(?:ram|mem[oó]ria)\s*:?\s*(\d{1,3})\s*(?:gb|gbs)\b/i);
  return m ? `${Number(m[1])} GB` : "n/d";
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

// ── HTML ─────────────────────────────────────────────────────────────────────

function e(s) {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildHtml({ olx, premium, enjoeiNb, enjoeiNbPremium, enjoei, now }) {
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
.meta{color:#8b949e;font-size:.8rem;margin-bottom:28px}
.meta a{color:#58a6ff;text-decoration:none}
.meta a:hover{text-decoration:underline}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:18px;align-items:start}
.sec{background:#161b22;border:1px solid #30363d;border-radius:8px;overflow:hidden}
.sh{padding:14px 16px 10px;border-bottom:1px solid #21262d}
.sh h2{font-size:.9rem;font-weight:600;color:#f0f6fc}
.sh small{font-size:.72rem;color:#8b949e}
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
</style>
</head>
<body>
<h1>Monitor</h1>
<p class="meta">Atualizado: ${e(now)} (BRT) &nbsp;·&nbsp; <a href="https://github.com/${REPO}" target="_blank">ver repositório ↗</a></p>
<div class="grid">
${renderSection("OLX Notebooks", "R$ 2.000 – R$ 4.000", olx, "data/olx")}
${renderSection("OLX Premium", "R$ 4.001 – R$ 8.000", premium, "data/olx")}
${renderSection("Enjoei Notebooks", "R$ 1.500 – R$ 4.000", enjoeiNb, "data/enjoei-notebooks")}
${renderSection("Enjoei NB Premium", "R$ 4.001 – R$ 8.000", enjoeiNbPremium, "data/enjoei-notebooks")}
${renderSection("Enjoei Tênis 42", "até R$ 500,00", enjoei, "data/enjoei")}
</div>
</body>
</html>`;
}

function renderSection(title, sub, reports, dpath) {
  const showSpecs = dpath !== "data/enjoei";
  const body = reports.length === 0
    ? `<p class="empty">Nenhum run com novidades recentes.</p>`
    : reports.map((r) => renderCard(r, dpath, showSpecs)).join("\n");
  return `<div class="sec">
  <div class="sh"><h2>${e(title)}</h2><small>${e(sub)} &nbsp;·&nbsp; últimos ${reports.length} com novidades</small></div>
  <div class="sb">${body}</div>
</div>`;
}

function renderCard(r, dpath, showSpecs) {
  const url = `${BLOB}/${dpath}/${r.file}`;
  const bn = r.newCount > 0 ? `<span class="badge bn">+${r.newCount} novo${r.newCount > 1 ? "s" : ""}</span>` : "";
  const bp = r.priceCount > 0 ? `<span class="badge bp">${r.priceCount} preço${r.priceCount > 1 ? "s" : ""}</span>` : "";
  const rows = [
    ...r.newItems.map((i) => renderRow(i, false, showSpecs)),
    ...r.priceItems.map((i) => renderRow(i, true, showSpecs)),
  ].join("\n");
  return `<div class="card">
  <div class="ch">
    <span class="cd">${e(r.runLabel ?? r.date ?? "—")}<a class="rl" href="${e(url)}" target="_blank">ver completo ↗</a></span>
    <div class="badges">${bn}${bp}</div>
  </div>
  ${rows ? `<div class="ci">${rows}</div>` : ""}
</div>`;
}

function renderRow(item, isPrice, showSpecs) {
  if (showSpecs && item.machine) return renderMachineRow(item, isPrice);
  const titleHtml = item.url
    ? `<a href="${e(item.url)}" target="_blank">${e(item.title)}</a>`
    : e(item.title);
  if (isPrice && item.priceFrom && item.priceTo) {
    return `<div class="item"><span class="it">${titleHtml}</span><span><span class="pf">${e(item.priceFrom)}</span> → <span class="pt">${e(item.priceTo)}</span></span></div>`;
  }
  return `<div class="item"><span class="it">${titleHtml}</span>${item.price ? `<span class="ip">${e(item.price)}</span>` : ""}</div>`;
}

function renderMachineRow(item, isPrice) {
  const m = item.machine;
  const title = [m.brand, m.model].filter((x) => x && x !== "n/d").join(" ") || m.model || "n/d";
  const titleHtml = item.url
    ? `<a href="${e(item.url)}" target="_blank">${e(title)}</a>`
    : e(title);
  const gpu = m.gpu ?? "integrada/n/d";
  const priceHtml = isPrice && item.priceFrom && item.priceTo
    ? `<span><span class="pf">${e(item.priceFrom)}</span> → <span class="pt">${e(item.priceTo)}</span></span>`
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
