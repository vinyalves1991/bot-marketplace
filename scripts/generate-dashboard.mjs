import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OLX_DIR = process.env.OLX_DATA_DIR ?? path.join(ROOT, "data", "olx");
const ENJOEI_DIR = process.env.ENJOEI_DATA_DIR ?? path.join(ROOT, "data", "enjoei");
const OUTPUT = path.join(ROOT, "index.html");
const REPO = "almeida3339/olx-daily";
const BLOB = `https://github.com/${REPO}/blob/main`;
const MAX = 5;

main().catch((e) => { console.error(e.message); process.exitCode = 1; });

async function main() {
  const [olx, premium, enjoei] = await Promise.all([
    gather(OLX_DIR, "report-", "report-premium-"),
    gather(OLX_DIR, "report-premium-", null),
    gather(ENJOEI_DIR, "report-", null),
  ]);
  const now = new Date().toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "full",
    timeStyle: "short",
  });
  await fs.writeFile(OUTPUT, buildHtml({ olx, premium, enjoei, now }), "utf8");
  console.log(`Dashboard gerado: ${OUTPUT}`);
}

// ── coleta ──────────────────────────────────────────────────────────────────

async function gather(dir, prefix, excludePrefix) {
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
    const p = parseReport(txt);
    if (p.newCount > 0 || p.priceCount > 0) out.push({ file, ...p });
  }
  return out;
}

// ── parser ───────────────────────────────────────────────────────────────────

function parseReport(txt) {
  const num = (patterns) => {
    for (const r of patterns) { const m = txt.match(r); if (m) return +m[1]; }
    return 0;
  };
  const newCount = num([
    /Novos an[úu]ncios v[aá]lidos[^:]*:\s*\*\*(\d+)\*\*/,
    /Novos an[úu]ncios:\s*\*\*(\d+)\*\*/,
    /Novos produtos:\s*\*\*(\d+)\*\*/,
  ]);
  const priceCount = num([
    /Altera[cç][oõ]es de pre[cç]o[^:]*:\s*\*\*(\d+)\*\*/,
    /Altera[cç]oes de preco:\s*\*\*(\d+)\*\*/,
  ]);
  const dateM = txt.match(/[—\-]\s*(\d{4}-\d{2}-\d{2})/);
  const date = dateM ? dateM[1] : null;
  const newItems = extractItems(txt, /^## Novos (an[úu]ncios|produtos)/m);
  const priceItems = extractItems(txt, /^## Mudan[cç]as? de pre[cç]o/m);
  return { newCount, priceCount, date, newItems, priceItems };
}

function extractItems(txt, sectionRe) {
  const m = txt.match(sectionRe);
  if (!m) return [];
  const rest = txt.slice(m.index);
  const nextSec = rest.slice(1).search(/^## /m);
  const block = nextSec === -1 ? rest : rest.slice(0, nextSec + 1);
  return block
    .split("\n")
    .filter((l) => l.startsWith("- ") && !/Nenhum|Observa[cç]|CPUs? exclu/i.test(l))
    .slice(0, MAX)
    .map(parseLine);
}

function parseLine(line) {
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
  if (title.length > 72) title = title.slice(0, 72) + "…";
  return { title: title || "—", price, url, priceFrom, priceTo };
}

// ── HTML ─────────────────────────────────────────────────────────────────────

function e(s) {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildHtml({ olx, premium, enjoei, now }) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Monitor Notebooks &amp; Tênis</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;padding:28px 20px;max-width:1200px;margin:0 auto}
h1{font-size:1.3rem;color:#f0f6fc;margin-bottom:5px}
.meta{color:#8b949e;font-size:.8rem;margin-bottom:28px}
.meta a{color:#58a6ff;text-decoration:none}
.meta a:hover{text-decoration:underline}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:20px;align-items:start}
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
.item{display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:4px 0;border-bottom:1px solid #21262d;font-size:.78rem}
.item:last-child{border-bottom:none}
.it{color:#c9d1d9;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.it a{color:#c9d1d9;text-decoration:none}
.it a:hover{color:#58a6ff;text-decoration:underline}
.ip{color:#58a6ff;font-weight:700;white-space:nowrap;font-size:.78rem}
.pf{color:#8b949e;text-decoration:line-through;font-size:.75rem}
.pt{color:#e3b341;font-weight:700;font-size:.75rem}
</style>
</head>
<body>
<h1>Monitor Notebooks &amp; Tênis</h1>
<p class="meta">Atualizado: ${e(now)} (BRT) &nbsp;·&nbsp; <a href="https://github.com/${REPO}" target="_blank">ver repositório ↗</a></p>
<div class="grid">
${renderSection("OLX Notebooks", "R$ 2.000 – R$ 4.000", olx, "data/olx")}
${renderSection("OLX Premium", "R$ 4.001 – R$ 8.000", premium, "data/olx")}
${renderSection("Enjoei Tênis 42", "até R$ 500,00", enjoei, "data/enjoei")}
</div>
</body>
</html>`;
}

function renderSection(title, sub, reports, dpath) {
  const body = reports.length === 0
    ? `<p class="empty">Nenhum run com novidades recentes.</p>`
    : reports.map((r) => renderCard(r, dpath)).join("\n");
  return `<div class="sec">
  <div class="sh"><h2>${e(title)}</h2><small>${e(sub)} &nbsp;·&nbsp; últimos ${reports.length} com novidades</small></div>
  <div class="sb">${body}</div>
</div>`;
}

function renderCard(r, dpath) {
  const url = `${BLOB}/${dpath}/${r.file}`;
  const bn = r.newCount > 0 ? `<span class="badge bn">+${r.newCount} novo${r.newCount > 1 ? "s" : ""}</span>` : "";
  const bp = r.priceCount > 0 ? `<span class="badge bp">${r.priceCount} preço${r.priceCount > 1 ? "s" : ""}</span>` : "";
  const rows = [
    ...r.newItems.map((i) => renderRow(i, false)),
    ...r.priceItems.map((i) => renderRow(i, true)),
  ].join("\n");
  return `<div class="card">
  <div class="ch">
    <span class="cd">${e(r.date ?? "—")}<a class="rl" href="${e(url)}" target="_blank">ver completo ↗</a></span>
    <div class="badges">${bn}${bp}</div>
  </div>
  ${rows ? `<div class="ci">${rows}</div>` : ""}
</div>`;
}

function renderRow(item, isPrice) {
  const titleHtml = item.url
    ? `<a href="${e(item.url)}" target="_blank">${e(item.title)}</a>`
    : e(item.title);
  if (isPrice && item.priceFrom && item.priceTo) {
    return `<div class="item"><span class="it">${titleHtml}</span><span><span class="pf">${e(item.priceFrom)}</span> → <span class="pt">${e(item.priceTo)}</span></span></div>`;
  }
  return `<div class="item"><span class="it">${titleHtml}</span>${item.price ? `<span class="ip">${e(item.price)}</span>` : ""}</div>`;
}
