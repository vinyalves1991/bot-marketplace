import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "..");

const def = (env, fallback) => process.env[env] ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".codex", "automations", fallback);
const OLX_DIR              = def("OLX_DATA_DIR",              "monitor-olx-notebooks-por-cpu");
const ENJOEI_DIR           = def("ENJOEI_DATA_DIR",           "monitor-enjoei-tenis-42");
const ENJOEI_NOTEBOOKS_DIR = def("ENJOEI_NOTEBOOKS_DATA_DIR", "monitor-enjoei-notebooks");

const GMAIL_USER         = process.env.GMAIL_USER ?? "docrash@gmail.com";
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const NOTIFY_TO          = process.env.NOTIFY_EMAIL_TO ?? GMAIL_USER;
const CALLMEBOT_PHONE    = process.env.CALLMEBOT_PHONE ?? "554196968789";
const CALLMEBOT_APIKEY   = process.env.CALLMEBOT_APIKEY ?? "2696242";
const forceEmail         = process.argv.includes("--force-email");
const skipMonitors       = process.argv.includes("--skip-monitors");
const dryRun             = process.argv.includes("--dry-run"); // imprime mensagens e NÃO envia nada
const onlyOlx            = process.argv.includes("--only-olx");
const skipOlx            = process.argv.includes("--skip-olx") || process.env.SKIP_OLX === "1";
const skipEnjoei         = process.argv.includes("--skip-enjoei") || process.env.SKIP_ENJOEI === "1";
const olxMaxPerCpu       = getArgValue("--olx-max-per-cpu") ?? process.env.OLX_MAX_PER_CPU ?? "12";

main().catch((err) => { console.error(`Falha geral: ${err.message}`); process.exitCode = 1; });

async function main() {
  console.log(`Iniciando rodada: ${new Date().toISOString()}`);
  const errors = [];

  if (skipMonitors) {
    console.log("--skip-monitors ativo: usando relatórios existentes.");
  } else {
    console.log("Rodando monitores em paralelo...");
    const jobs = [];
    if (!skipOlx) jobs.push(["olx", runOlxMonitor()]);
    else console.log("OLX pulado nesta rodada.");
    if (!onlyOlx && !skipEnjoei) {
      jobs.push(["enjoei-tenis", runScript("monitor-enjoei-tenis.mjs", [])]);
      jobs.push(["enjoei-notebooks", runScript("monitor-enjoei-notebooks.mjs", [])]);
    }

    const results = await Promise.allSettled(jobs.map(([, promise]) => promise));
    for (let i = 0; i < jobs.length; i += 1) {
      const [name] = jobs[i];
      const result = results[i];
      if (result.status !== "rejected") continue;
      if (name === "olx") { console.error(`OLX falhou: ${result.reason.message}`); errors.push(`OLX: ${result.reason.message}`); }
      if (name === "enjoei-tenis") { console.error(`Enjoei tênis falhou: ${result.reason.message}`); errors.push(`Enjoei tênis: ${result.reason.message}`); }
      if (name === "enjoei-notebooks") { console.error(`Enjoei NB falhou: ${result.reason.message}`); errors.push(`Enjoei NB: ${result.reason.message}`); }
    }
  }

  const enjoeiOn = !onlyOlx && !skipEnjoei;
  const [olxStd, olxPrem, enjoeiReport, enjoeiNbStd, enjoeiNbPrem] = await Promise.all([
    skipOlx   ? null : readLatestReport(OLX_DIR).catch(() => null),
    skipOlx   ? null : readLatestPremiumReport(OLX_DIR).catch(() => null),
    enjoeiOn  ? readLatestReport(ENJOEI_DIR).catch(() => null) : null,
    enjoeiOn  ? readLatestReport(ENJOEI_NOTEBOOKS_DIR).catch(() => null) : null,
    enjoeiOn  ? readLatestPremiumReport(ENJOEI_NOTEBOOKS_DIR).catch(() => null) : null,
  ]);

  // Cada fonte conta itens NOVOS e ALTERAÇÕES DE PREÇO (antes só contava novos do range padrão).
  const sources = [
    { label: "OLX Notebooks",     report: olxStd,       newRe: /Novos an[úu]ncios v[aá]lidos[^:]*:\s*\*\*(\d+)\*\*/, newSec: "## Novos anúncios", priceSec: "## Mudanças de preço" },
    { label: "OLX Premium",       report: olxPrem,      newRe: /Novos an[úu]ncios:\s*\*\*(\d+)\*\*/,                 newSec: "## Novos anúncios", priceSec: "## Mudanças de preço" },
    { label: "Enjoei Notebooks",  report: enjoeiNbStd,  newRe: /Novos notebooks[^:]*:\s*\*\*(\d+)\*\*/,              newSec: "## Novos notebooks", priceSec: "## Mudanças de preço" },
    { label: "Enjoei NB Premium", report: enjoeiNbPrem, newRe: /Novos notebooks:\s*\*\*(\d+)\*\*/,                   newSec: "## Novos notebooks", priceSec: "## Mudanças de preço" },
    { label: "Enjoei Tênis",      report: enjoeiReport, newRe: /Novos produtos:\s*\*\*(\d+)\*\*/,                    newSec: "## Novos produtos",  priceSec: "## Mudancas de preco" },
  ].map((s) => ({
    ...s,
    newCount:   extractNewCount(s.report, s.newRe),
    priceCount: extractNewCount(s.report, PRICE_CHANGE_RE),
  }));

  const totalNew   = sources.reduce((sum, s) => sum + s.newCount, 0);
  const totalPrice = sources.reduce((sum, s) => sum + s.priceCount, 0);

  console.log("\nResumo desta rodada:");
  for (const s of sources) {
    if (!s.report) continue;
    console.log(`  ${s.label}: ${s.newCount} novo(s), ${s.priceCount} preço(s)`);
  }

  const subject     = buildSubject(sources, errors);
  const body        = buildBody(sources, errors);
  const whatsappMsg = buildWhatsAppMessage(sources, errors);

  // WhatsApp sempre (heartbeat de execução).
  // Email quando há novos itens, alterações de preço ou erros (evita caixa cheia com confirmações vazias).
  const sendingEmail = totalNew > 0 || totalPrice > 0 || errors.length > 0 || forceEmail;

  if (dryRun) {
    console.log("\n── DRY-RUN (nada enviado) ──");
    console.log(`Enviaria email? ${sendingEmail ? "sim" : "não"}`);
    console.log(`\nSUBJECT: ${subject}`);
    console.log(`\nWHATSAPP:\n${whatsappMsg}`);
    console.log(`\nEMAIL BODY:\n${body || "(vazio)"}`);
    return;
  }

  const [emailResult, waResult] = await Promise.allSettled([
    sendingEmail ? sendEmail(subject, body) : Promise.resolve(null),
    sendWhatsApp(whatsappMsg),
  ]);

  if (sendingEmail) {
    if (emailResult.status === "fulfilled") console.log(`Email enviado para ${NOTIFY_TO}.`);
    else console.warn(`Email não enviado: ${emailResult.reason.message}`);
  }
  if (waResult.status === "fulfilled") console.log("WhatsApp enviado.");
  else console.warn(`WhatsApp não enviado: ${waResult.reason.message}`);
}

// ── scripts ───────────────────────────────────────────────────────────────────

function runScript(scriptName, extraArgs) {
  const scriptPath = path.join(workspaceRoot, "scripts", scriptName);
  return runCommand(process.execPath, [scriptPath, ...extraArgs]);
}

function runOlxMonitor() {
  if (process.platform === "win32" && process.env.GITHUB_ACTIONS !== "true") {
    return runCommand("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(workspaceRoot, "scripts", "run-olx-monitor.ps1"),
      "-MaxPerCpu",
      olxMaxPerCpu,
    ]);
  }
  return runScript("monitor-olx-notebooks-por-cpu.mjs", ["--headless", "--max-per-cpu", olxMaxPerCpu]);
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", cwd: workspaceRoot });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Saiu com código ${code}`))));
    child.on("error", reject);
  });
}

function getArgValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function readLatestReport(dir) {
  const entries = await fs.readdir(dir).catch(() => []);
  const reports = entries
    .filter((n) => n.startsWith("report-") && !n.startsWith("report-premium-") && n.endsWith(".md"))
    .sort().reverse();
  if (!reports.length) return null;
  return fs.readFile(path.join(dir, reports[0]), "utf8");
}

async function readLatestPremiumReport(dir) {
  const entries = await fs.readdir(dir).catch(() => []);
  const reports = entries
    .filter((n) => n.startsWith("report-premium-") && n.endsWith(".md"))
    .sort().reverse();
  if (!reports.length) return null;
  return fs.readFile(path.join(dir, reports[0]), "utf8");
}

// Aceita acento/sem acento: "Alterações de preço detectadas: **4**" e "Alteracoes de preco: **0**".
const PRICE_CHANGE_RE = /Altera[cç][oõ]es de pre[cç]o[^:]*:\s*\*\*(\d+)\*\*/;

function extractNewCount(report, regex) {
  if (!report) return 0;
  const m = report.match(regex);
  return m ? Number(m[1]) : 0;
}

// ── mensagens ─────────────────────────────────────────────────────────────────

function buildSubject(sources, errors) {
  const totalNew   = sources.reduce((sum, s) => sum + s.newCount, 0);
  const totalPrice = sources.reduce((sum, s) => sum + s.priceCount, 0);
  const parts = [];
  if (totalNew > 0)   parts.push(`${totalNew} novo(s)`);
  if (totalPrice > 0) parts.push(`${totalPrice} alteração(ões) de preço`);
  if (errors.length)  parts.push("erros");
  if (!parts.length)  parts.push("sem novidades");
  return `[Monitor] ${parts.join(" | ")} — ${new Date().toLocaleDateString("pt-BR")}`;
}

function buildBody(sources, errors) {
  const sections = [];
  if (errors.length) sections.push("## Erros nesta rodada\n" + errors.map((e) => `- ${e}`).join("\n"));
  for (const s of sources) {
    if ((s.newCount > 0 || s.priceCount > 0) && s.report) sections.push(s.report);
  }
  return sections.join("\n\n---\n\n");
}

function buildWhatsAppMessage(sources, errors) {
  const date = new Date().toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  const time = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const lines = [`Monitor ${date} ${time}`];

  if (errors.length) lines.push(`Erros: ${errors.join(", ")}`);

  const totalNew   = sources.reduce((sum, s) => sum + s.newCount, 0);
  const totalPrice = sources.reduce((sum, s) => sum + s.priceCount, 0);

  if (totalNew === 0 && totalPrice === 0) {
    lines.push("Sem novos itens nem alterações de preço.");
    return lines.join("\n");
  }

  for (const s of sources) {
    if (s.newCount === 0 && s.priceCount === 0) continue;
    const tags = [];
    if (s.newCount > 0)   tags.push(`${s.newCount} novo(s)`);
    if (s.priceCount > 0) tags.push(`${s.priceCount} preço(s)`);
    lines.push(`\n${s.label}: ${tags.join(", ")}`);
    if (s.newCount > 0)   lines.push(...extractNewItems(s.report, s.newSec).slice(0, 2));
    if (s.priceCount > 0) lines.push(...extractNewItems(s.report, s.priceSec).slice(0, 2));
  }

  lines.push("\nDetalhes completos por email.");
  return lines.join("\n").slice(0, 1500);
}

function extractNewItems(report, sectionHeader) {
  if (!report) return [];
  const start = report.indexOf(sectionHeader);
  if (start === -1) return [];
  const end = report.indexOf("\n##", start + 1);
  const section = end === -1 ? report.slice(start) : report.slice(start, end);
  return section.split("\n")
    .filter((l) => l.startsWith("- ") && !l.includes("Nenhum"))
    .map((l) => l.slice(0, 120));
}

// ── email / WhatsApp ──────────────────────────────────────────────────────────

async function sendEmail(subject, body) {
  if (!GMAIL_APP_PASSWORD) throw new Error("GMAIL_APP_PASSWORD não definida");
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com", port: 587, secure: false,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
  await transporter.sendMail({ from: `Monitor <${GMAIL_USER}>`, to: NOTIFY_TO, subject, text: body });
}

async function sendWhatsApp(message) {
  const url = `https://api.callmebot.com/whatsapp.php?phone=${CALLMEBOT_PHONE}&text=${encodeURIComponent(message)}&apikey=${CALLMEBOT_APIKEY}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`CallMeBot HTTP ${response.status}`);
}
