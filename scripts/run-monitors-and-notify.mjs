import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "..");
const OLX_DIR = path.join(process.env.USERPROFILE ?? "", ".codex", "automations", "monitor-olx-notebooks-por-cpu");
const ENJOEI_DIR = path.join(process.env.USERPROFILE ?? "", ".codex", "automations", "monitor-enjoei-tenis-42");

const GMAIL_USER = process.env.GMAIL_USER ?? "docrash@gmail.com";
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const NOTIFY_TO = process.env.NOTIFY_EMAIL_TO ?? GMAIL_USER;
const CALLMEBOT_PHONE = process.env.CALLMEBOT_PHONE ?? "554196968789";
const CALLMEBOT_APIKEY = process.env.CALLMEBOT_APIKEY ?? "2696242";
const forceEmail = process.argv.includes("--force-email");
const skipMonitors = process.argv.includes("--skip-monitors");

main().catch((err) => {
  console.error(`Falha geral: ${err.message}`);
  process.exitCode = 1;
});

async function main() {
  console.log(`Iniciando rodada: ${new Date().toISOString()}`);

  const errors = [];

  if (skipMonitors) {
    console.log("--skip-monitors ativo: usando relatórios existentes.");
  } else {
    console.log("Rodando OLX e Enjoei em paralelo...");
    const [olxResult, enjoeiResult] = await Promise.allSettled([
      runScript("monitor-olx-notebooks-por-cpu.mjs", ["--headless"]),
      runScript("monitor-enjoei-tenis.mjs", []),
    ]);
    if (olxResult.status === "rejected") {
      console.error(`OLX falhou: ${olxResult.reason.message}`);
      errors.push(`OLX: ${olxResult.reason.message}`);
    }
    if (enjoeiResult.status === "rejected") {
      console.error(`Enjoei falhou: ${enjoeiResult.reason.message}`);
      errors.push(`Enjoei: ${enjoeiResult.reason.message}`);
    }
  }

  const [olxReport, enjoeiReport] = await Promise.all([
    readLatestReport(OLX_DIR).catch(() => null),
    readLatestReport(ENJOEI_DIR).catch(() => null),
  ]);

  const olxNew = extractNewCount(olxReport, /Novos anúncios válidos[^:]*:\s*\*\*(\d+)\*\*/);
  const enjoeiNew = extractNewCount(enjoeiReport, /Novos produtos:\s*\*\*(\d+)\*\*/);
  const totalNew = olxNew + enjoeiNew;

  console.log(`\nNovos OLX: ${olxNew} | Novos Enjoei: ${enjoeiNew}`);

  if (totalNew === 0 && errors.length === 0) {
    if (!forceEmail) {
      console.log("Nenhum item novo. Email não enviado.");
      return;
    }
    console.log("Nenhum item novo, mas --force-email ativo. Enviando email de teste.");
  }

  if (!GMAIL_APP_PASSWORD) {
    console.warn("GMAIL_APP_PASSWORD não definida — email não enviado. Configure com: setx GMAIL_APP_PASSWORD \"sua-senha\"");
    return;
  }

  const subject = buildSubject(olxNew, enjoeiNew, errors);
  const body = buildBody(olxReport, enjoeiReport, olxNew, enjoeiNew, errors);
  const whatsappMsg = buildWhatsAppMessage(olxReport, enjoeiReport, olxNew, enjoeiNew, errors);

  const [emailResult, waResult] = await Promise.allSettled([
    GMAIL_APP_PASSWORD
      ? sendEmail(subject, body)
      : Promise.reject(new Error("GMAIL_APP_PASSWORD não definida")),
    sendWhatsApp(whatsappMsg),
  ]);

  if (emailResult.status === "fulfilled") {
    console.log(`Email enviado para ${NOTIFY_TO}.`);
  } else {
    console.warn(`Email não enviado: ${emailResult.reason.message}`);
  }

  if (waResult.status === "fulfilled") {
    console.log("WhatsApp enviado.");
  } else {
    console.warn(`WhatsApp não enviado: ${waResult.reason.message}`);
  }
}

function runScript(scriptName, extraArgs) {
  const scriptPath = path.join(workspaceRoot, "scripts", scriptName);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...extraArgs], {
      stdio: "inherit",
      cwd: workspaceRoot,
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Saiu com código ${code}`));
    });
    child.on("error", reject);
  });
}

async function readLatestReport(dir) {
  const entries = await fs.readdir(dir).catch(() => []);
  const reports = entries.filter((n) => n.startsWith("report-") && n.endsWith(".md")).sort().reverse();
  if (!reports.length) return null;
  return fs.readFile(path.join(dir, reports[0]), "utf8");
}

function extractNewCount(report, regex) {
  if (!report) return 0;
  const m = report.match(regex);
  return m ? Number(m[1]) : 0;
}

function buildSubject(olxNew, enjoeiNew, errors) {
  const parts = [];
  if (olxNew > 0) parts.push(`${olxNew} novo(s) OLX`);
  if (enjoeiNew > 0) parts.push(`${enjoeiNew} novo(s) Enjoei`);
  if (errors.length > 0) parts.push("erros");
  if (parts.length === 0) parts.push("TESTE — sem itens novos");
  return `[Monitor] ${parts.join(" | ")} — ${new Date().toLocaleDateString("pt-BR")}`;
}

function buildBody(olxReport, enjoeiReport, olxNew, enjoeiNew, errors) {
  const sections = [];

  if (errors.length > 0) {
    sections.push("## Erros nesta rodada\n" + errors.map((e) => `- ${e}`).join("\n"));
  }

  if (olxNew > 0 && olxReport) {
    sections.push(olxReport);
  }

  if (enjoeiNew > 0 && enjoeiReport) {
    sections.push(enjoeiReport);
  }

  return sections.join("\n\n---\n\n");
}

async function sendEmail(subject, body) {
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });

  await transporter.sendMail({
    from: `Monitor Notebooks/Tênis <${GMAIL_USER}>`,
    to: NOTIFY_TO,
    subject,
    text: body,
  });
}

async function sendWhatsApp(message) {
  const url = `https://api.callmebot.com/whatsapp.php?phone=${CALLMEBOT_PHONE}&text=${encodeURIComponent(message)}&apikey=${CALLMEBOT_APIKEY}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`CallMeBot retornou HTTP ${response.status}`);
  }
}

function buildWhatsAppMessage(olxReport, enjoeiReport, olxNew, enjoeiNew, errors) {
  const date = new Date().toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  const time = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const lines = [`Monitor ${date} ${time}`];

  if (errors.length > 0) lines.push(`Erros: ${errors.join(", ")}`);

  if (olxNew === 0 && enjoeiNew === 0) {
    lines.push("Teste - sem itens novos");
    lines.push("(email e whatsapp funcionando)");
    return lines.join("\n");
  }

  if (olxNew > 0) {
    lines.push(`\nOLX: ${olxNew} novo(s)`);
    const items = extractNewItems(olxReport, "## Novos anúncios");
    lines.push(...items.slice(0, 3));
  }

  if (enjoeiNew > 0) {
    lines.push(`\nEnjoei: ${enjoeiNew} novo(s)`);
    const items = extractNewItems(enjoeiReport, "## Novos produtos");
    lines.push(...items.slice(0, 3));
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
  return section
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .filter((l) => !l.includes("Nenhum"))
    .map((l) => l.slice(0, 120));
}
