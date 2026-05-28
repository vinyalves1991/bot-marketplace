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

  const [olxReport, enjoeiReport, enjoeiNbReport] = await Promise.all([
    skipOlx ? null : readLatestReport(OLX_DIR).catch(() => null),
    onlyOlx || skipEnjoei ? null : readLatestReport(ENJOEI_DIR).catch(() => null),
    onlyOlx || skipEnjoei ? null : readLatestReport(ENJOEI_NOTEBOOKS_DIR).catch(() => null),
  ]);

  const olxNew      = extractNewCount(olxReport,      /Novos anúncios válidos[^:]*:\s*\*\*(\d+)\*\*/);
  const enjoeiNew   = extractNewCount(enjoeiReport,    /Novos produtos:\s*\*\*(\d+)\*\*/);
  const enjoeiNbNew = extractNewCount(enjoeiNbReport,  /Novos notebooks[^:]*:\s*\*\*(\d+)\*\*/);
  const totalNew    = olxNew + enjoeiNew + enjoeiNbNew;

  console.log(`\nNovos — OLX: ${olxNew} | Enjoei tênis: ${enjoeiNew} | Enjoei NB: ${enjoeiNbNew}`);

  if (totalNew === 0 && errors.length === 0) {
    if (!forceEmail) { console.log("Nenhum item novo. Email não enviado."); return; }
    console.log("Nenhum item novo, mas --force-email ativo.");
  }

  const subject     = buildSubject(olxNew, enjoeiNew, enjoeiNbNew, errors);
  const body        = buildBody(olxReport, enjoeiReport, enjoeiNbReport, olxNew, enjoeiNew, enjoeiNbNew, errors);
  const whatsappMsg = buildWhatsAppMessage(olxReport, enjoeiReport, enjoeiNbReport, olxNew, enjoeiNew, enjoeiNbNew, errors);

  const [emailResult, waResult] = await Promise.allSettled([
    sendEmail(subject, body),
    sendWhatsApp(whatsappMsg),
  ]);

  if (emailResult.status === "fulfilled") console.log(`Email enviado para ${NOTIFY_TO}.`);
  else console.warn(`Email não enviado: ${emailResult.reason.message}`);

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

function extractNewCount(report, regex) {
  if (!report) return 0;
  const m = report.match(regex);
  return m ? Number(m[1]) : 0;
}

// ── mensagens ─────────────────────────────────────────────────────────────────

function buildSubject(olxNew, enjoeiNew, enjoeiNbNew, errors) {
  const parts = [];
  if (olxNew > 0)      parts.push(`${olxNew} novo(s) OLX`);
  if (enjoeiNew > 0)   parts.push(`${enjoeiNew} novo(s) Enjoei tênis`);
  if (enjoeiNbNew > 0) parts.push(`${enjoeiNbNew} novo(s) Enjoei NB`);
  if (errors.length)   parts.push("erros");
  if (!parts.length)   parts.push("TESTE — sem itens novos");
  return `[Monitor] ${parts.join(" | ")} — ${new Date().toLocaleDateString("pt-BR")}`;
}

function buildBody(olxReport, enjoeiReport, enjoeiNbReport, olxNew, enjoeiNew, enjoeiNbNew, errors) {
  const sections = [];
  if (errors.length)    sections.push("## Erros nesta rodada\n" + errors.map((e) => `- ${e}`).join("\n"));
  if (olxNew > 0 && olxReport)           sections.push(olxReport);
  if (enjoeiNew > 0 && enjoeiReport)     sections.push(enjoeiReport);
  if (enjoeiNbNew > 0 && enjoeiNbReport) sections.push(enjoeiNbReport);
  return sections.join("\n\n---\n\n");
}

function buildWhatsAppMessage(olxReport, enjoeiReport, enjoeiNbReport, olxNew, enjoeiNew, enjoeiNbNew, errors) {
  const date = new Date().toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  const time = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const lines = [`Monitor ${date} ${time}`];

  if (errors.length) lines.push(`Erros: ${errors.join(", ")}`);

  if (olxNew === 0 && enjoeiNew === 0 && enjoeiNbNew === 0) {
    if (errors.length === 0) {
      lines.push("Teste - sem itens novos");
      lines.push("(email e whatsapp funcionando)");
    } else {
      lines.push("Sem novos itens nesta rodada.");
    }
    return lines.join("\n");
  }

  if (olxNew > 0) {
    lines.push(`\nOLX: ${olxNew} novo(s)`);
    lines.push(...extractNewItems(olxReport, "## Novos anúncios").slice(0, 3));
  }
  if (enjoeiNbNew > 0) {
    lines.push(`\nEnjoei Notebooks: ${enjoeiNbNew} novo(s)`);
    lines.push(...extractNewItems(enjoeiNbReport, "## Novos notebooks").slice(0, 3));
  }
  if (enjoeiNew > 0) {
    lines.push(`\nEnjoei Tênis: ${enjoeiNew} novo(s)`);
    lines.push(...extractNewItems(enjoeiReport, "## Novos produtos").slice(0, 3));
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
  await transporter.sendMail({ from: `Monitor Notebooks/Tênis <${GMAIL_USER}>`, to: NOTIFY_TO, subject, text: body });
}

async function sendWhatsApp(message) {
  const url = `https://api.callmebot.com/whatsapp.php?phone=${CALLMEBOT_PHONE}&text=${encodeURIComponent(message)}&apikey=${CALLMEBOT_APIKEY}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`CallMeBot HTTP ${response.status}`);
}
