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
const DOCKSTATIONS_DIR     = def("DOCKSTATIONS_DATA_DIR",     "monitor-dockstations");
const FITBIT_DIR           = def("FITBIT_DATA_DIR",           "monitor-fitbit");
const LIFEFACTORY_DIR      = def("LIFEFACTORY_DATA_DIR",      "monitor-lifefactory");
const TELA_BOOK3_DIR       = def("TELA_GALAXYBOOK3_DATA_DIR", "monitor-tela-galaxybook3");

const GMAIL_USER         = process.env.GMAIL_USER ?? "docrash@gmail.com";
// App passwords do Gmail são 16 caracteres sem espaços. O Google exibe a senha
// no formato "xxxx xxxx xxxx xxxx"; se ela for colada com os espaços, o AUTH do
// SMTP rejeita com "535-5.7.8 Username and Password not accepted" (a regra de
// "espaços são ignorados" só vale no login web, não no SMTP). Remover qualquer
// espaço em branco torna a leitura robusta independentemente de como foi salva.
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, "");
const NOTIFY_TO          = process.env.NOTIFY_EMAIL_TO ?? GMAIL_USER;
const CALLMEBOT_PHONE    = process.env.CALLMEBOT_PHONE ?? "554196968789";
const CALLMEBOT_APIKEY   = process.env.CALLMEBOT_APIKEY ?? "2696242";
const forceEmail         = process.argv.includes("--force-email");
const skipMonitors       = process.argv.includes("--skip-monitors");
const dryRun             = process.argv.includes("--dry-run"); // imprime mensagens e NÃO envia nada
const onlyOlx            = process.argv.includes("--only-olx");
const skipOlx            = process.argv.includes("--skip-olx") || process.env.SKIP_OLX === "1";
const skipEnjoei         = process.argv.includes("--skip-enjoei") || process.env.SKIP_ENJOEI === "1";
const skipDockstations   = process.argv.includes("--skip-dockstations") || process.env.SKIP_DOCKSTATIONS === "1";
const skipFitbit         = process.argv.includes("--skip-fitbit") || process.env.SKIP_FITBIT === "1";
const skipLifefactory    = process.argv.includes("--skip-lifefactory") || process.env.SKIP_LIFEFACTORY === "1";
const skipTelaBook3      = process.argv.includes("--skip-tela-book3") || process.env.SKIP_TELA_BOOK3 === "1";
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
    // Dockstations combina OLX (Playwright) + Enjoei (API) num único script e
    // trata falhas de cada fonte internamente, então roda independente dos flags
    // only-olx/skip-enjoei (assim funciona tanto no Task Scheduler local quanto no CI).
    if (!skipDockstations) jobs.push(["dockstations", runScript("monitor-dockstations.mjs", [])]);
    if (!skipFitbit) jobs.push(["fitbit", runScript("monitor-fitbit.mjs", [])]);
    if (!skipLifefactory) jobs.push(["lifefactory", runScript("monitor-lifefactory.mjs", [])]);
    if (!skipTelaBook3) jobs.push(["tela-book3", runScript("monitor-tela-galaxybook3.mjs", [])]);

    const results = await Promise.allSettled(jobs.map(([, promise]) => promise));
    for (let i = 0; i < jobs.length; i += 1) {
      const [name] = jobs[i];
      const result = results[i];
      if (result.status !== "rejected") continue;
      if (name === "olx") { console.error(`OLX falhou: ${result.reason.message}`); errors.push(`OLX: ${result.reason.message}`); }
      if (name === "enjoei-tenis") { console.error(`Enjoei tênis falhou: ${result.reason.message}`); errors.push(`Enjoei tênis: ${result.reason.message}`); }
      if (name === "enjoei-notebooks") { console.error(`Enjoei NB falhou: ${result.reason.message}`); errors.push(`Enjoei NB: ${result.reason.message}`); }
      if (name === "dockstations") { console.error(`Dockstations falhou: ${result.reason.message}`); errors.push(`Dockstations: ${result.reason.message}`); }
      if (name === "fitbit") { console.error(`Fitbit falhou: ${result.reason.message}`); errors.push(`Fitbit: ${result.reason.message}`); }
      if (name === "lifefactory") { console.error(`Lifefactory falhou: ${result.reason.message}`); errors.push(`Lifefactory: ${result.reason.message}`); }
      if (name === "tela-book3") { console.error(`Tela Book3 falhou: ${result.reason.message}`); errors.push(`Tela Book3: ${result.reason.message}`); }
    }
  }

  const enjoeiOn = !onlyOlx && !skipEnjoei;
  const [olxStd, enjoeiReport, enjoeiNbStd, dockReport, fitbitReport, lifefactoryReport, telaBook3Report] = await Promise.all([
    skipOlx          ? null : readLatestReport(OLX_DIR).catch(() => null),
    enjoeiOn         ? readLatestReport(ENJOEI_DIR).catch(() => null) : null,
    enjoeiOn         ? readLatestReport(ENJOEI_NOTEBOOKS_DIR).catch(() => null) : null,
    skipDockstations ? null : readLatestReport(DOCKSTATIONS_DIR).catch(() => null),
    skipFitbit       ? null : readLatestReport(FITBIT_DIR).catch(() => null),
    skipLifefactory  ? null : readLatestReport(LIFEFACTORY_DIR).catch(() => null),
    skipTelaBook3    ? null : readLatestReport(TELA_BOOK3_DIR).catch(() => null),
  ]);

  // Cada fonte conta itens NOVOS e ALTERAÇÕES DE PREÇO (antes só contava novos do range padrão).
  const sources = [
    { label: "OLX Notebooks",    report: olxStd,      newRe: /Novos an[úu]ncios v[aá]lidos[^:]*:\s*\*\*(\d+)\*\*/, newSec: "## Novos anúncios", priceSec: "## Mudanças de preço" },
    { label: "Enjoei Notebooks", report: enjoeiNbStd, newRe: /Novos notebooks[^:]*:\s*\*\*(\d+)\*\*/,              newSec: "## Novos notebooks", priceSec: "## Mudanças de preço" },
    { label: "Enjoei Tênis",     report: enjoeiReport, newRe: /Novos produtos:\s*\*\*(\d+)\*\*/,                    newSec: "## Novos produtos",  priceSec: "## Mudancas de preco" },
    { label: "Dockstations",     report: dockReport,   newRe: /Novos produtos:\s*\*\*(\d+)\*\*/,                    newSec: "## Novos produtos",  priceSec: "## Mudanças de preço" },
    { label: "Fitbit Air",       report: fitbitReport, newRe: /Novos produtos:\s*\*\*(\d+)\*\*/,                    newSec: "## Novos produtos",  priceSec: "## Mudanças de preço" },
    { label: "Lifefactory",      report: lifefactoryReport, newRe: /Novos produtos:\s*\*\*(\d+)\*\*/,               newSec: "## Novos produtos",  priceSec: "## Mudanças de preço" },
    { label: "Tela Book3",       report: telaBook3Report, newRe: /Novos produtos:\s*\*\*(\d+)\*\*/,                 newSec: "## Novos produtos",  priceSec: "## Mudanças de preço" },
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
  return `[Monitor] ${parts.join(" | ")} — ${new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}`;
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
  // Fixa o fuso em BRT: o monitor Enjoei roda no GitHub Actions (UTC), entao
  // sem timeZone o horario saia 3h adiantado (ex.: 16:01 BRT aparecia "19:01").
  const date = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" });
  const time = new Date().toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
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
