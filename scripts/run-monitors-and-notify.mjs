import child_process from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";
import {
  buildDeliveryStatus,
  buildPriorFailureNote,
  reconcilePendingFailures,
  mergePendingFailures,
  sanitizeErrorMessage,
  mergeAcks
} from "./lib/notification-status.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "..");
function getStatusFilePath() {
  const source = process.env.GITHUB_ACTIONS === "true" ? "ci" : "local";
  return path.join(workspaceRoot, "data", "status", `latest-${source}.json`);
}

let fsApi = fs;
let runCommandFn = (...args) => runCommand(...args);

const def = (env, fallback) => process.env[env] ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".codex", "automations", fallback);
const OLX_DIR              = def("OLX_DATA_DIR",              "monitor-olx-notebooks-por-cpu");
const ENJOEI_DIR           = def("ENJOEI_DATA_DIR",           "monitor-enjoei-tenis-42");
const ENJOEI_NOTEBOOKS_DIR = def("ENJOEI_NOTEBOOKS_DATA_DIR", "monitor-enjoei-notebooks");
const DOCKSTATIONS_DIR     = def("DOCKSTATIONS_DATA_DIR",     "monitor-dockstations");
const FITBIT_DIR           = def("FITBIT_DATA_DIR",           "monitor-fitbit");
const LIFEFACTORY_DIR      = def("LIFEFACTORY_DATA_DIR",      "monitor-lifefactory");
const TELA_BOOK3_DIR       = def("TELA_GALAXYBOOK3_DATA_DIR", "monitor-tela-galaxybook3");
const MELANGER_DIR         = def("MELANGER_DATA_DIR",         "monitor-melanger");
const BUDS4PRO_DIR         = def("GALAXY_BUDS4_PRO_DATA_DIR", "monitor-galaxy-buds4-pro");
const OURA_DIR             = def("OURA_RING5_DATA_DIR",       "monitor-oura-ring5");
const MERCADOLIVRE_DIRS = [
  ["Mercado Livre Notebooks", path.join(workspaceRoot, "data", "mercadolivre-notebooks")],
  ["ML Galaxy Buds4 Pro", path.join(workspaceRoot, "data", "mercadolivre-galaxy-buds4-pro")],
  ["ML Dockstations", path.join(workspaceRoot, "data", "mercadolivre-dockstations")],
  ["ML Fitbit Air", path.join(workspaceRoot, "data", "mercadolivre-fitbit-air")],
  ["ML Lifefactory", path.join(workspaceRoot, "data", "mercadolivre-lifefactory")],
  ["ML Tela Book3", path.join(workspaceRoot, "data", "mercadolivre-tela-galaxybook3")],
  ["ML Melanger", path.join(workspaceRoot, "data", "mercadolivre-melanger")],
  ["ML Tênis 42", path.join(workspaceRoot, "data", "mercadolivre-tenis-42")],
];

// NUNCA usar defaults hardcoded para credenciais: este repositório é público
// (GitHub Pages) e qualquer valor aqui vaza para o mundo. As variáveis são
// obrigatórias e validadas no ponto de uso (sendEmail/sendWhatsApp).
const GMAIL_USER         = process.env.GMAIL_USER;
// App passwords do Gmail são 16 caracteres sem espaços. O Google exibe a senha
// no formato "xxxx xxxx xxxx xxxx"; se ela for colada com os espaços, o AUTH do
// SMTP rejeita com "535-5.7.8 Username and Password not accepted" (a regra de
// "espaços são ignorados" só vale no login web, não no SMTP). Remover qualquer
// espaço em branco torna a leitura robusta independentemente de como foi salva.
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, "");
const NOTIFY_TO          = process.env.NOTIFY_EMAIL_TO ?? GMAIL_USER;
const CALLMEBOT_PHONE    = process.env.CALLMEBOT_PHONE;
const CALLMEBOT_APIKEY   = process.env.CALLMEBOT_APIKEY;
// As variáveis de linha de comando agora são interpretadas dinamicamente dentro de main()

// Se executado diretamente, roda o main. Caso contrário, exporta para testes.
import { fileURLToPath as urlToPath } from "node:url";
const isMain = process.argv[1] === urlToPath(import.meta.url);
if (isMain) {
  main().catch((err) => { console.error(`Falha geral: ${err.message}`); process.exitCode = 1; });
}

export async function main({
  runCommandFn: runCommandIn = runCommand,
  sendEmailFn = sendEmail,
  sendWhatsAppFn = sendWhatsApp,
  fsApi: fsApiIn = fs,
  nowFn = () => new Date(),
  args = process.argv
} = {}) {
  const prevFsApi = fsApi;
  const prevRunCommandFn = runCommandFn;
  fsApi = fsApiIn;
  runCommandFn = runCommandIn;

  try {
    const forceEmail         = args.includes("--force-email");
    const skipMonitors       = args.includes("--skip-monitors");
    const dryRun             = args.includes("--dry-run");
    const onlyOlx            = args.includes("--only-olx");
    const skipOlx            = args.includes("--skip-olx") || process.env.SKIP_OLX === "1";
    const skipEnjoei         = args.includes("--skip-enjoei") || process.env.SKIP_ENJOEI === "1";
    const skipDockstations   = args.includes("--skip-dockstations") || process.env.SKIP_DOCKSTATIONS === "1";
    const skipFitbit         = args.includes("--skip-fitbit") || process.env.SKIP_FITBIT === "1";
    const skipLifefactory    = args.includes("--skip-lifefactory") || process.env.SKIP_LIFEFACTORY === "1";
    const skipTelaBook3      = args.includes("--skip-tela-book3") || process.env.SKIP_TELA_BOOK3 === "1";
    const skipMelanger       = args.includes("--skip-melanger") || process.env.SKIP_MELANGER === "1";
    const skipBuds4Pro       = args.includes("--skip-buds4-pro") || process.env.SKIP_BUDS4_PRO === "1";
    const skipOura           = args.includes("--skip-oura") || process.env.SKIP_OURA === "1";
    const skipMercadoLivre   = args.includes("--skip-mercadolivre")
      || process.env.SKIP_MERCADOLIVRE === "1"
      || process.env.GITHUB_ACTIONS === "true";
    const olxMaxPerCpu       = getArgValue("--olx-max-per-cpu", args) ?? process.env.OLX_MAX_PER_CPU ?? "12";

    const runNow = nowFn();
    const runStart = runNow.getTime();
  console.log(`Iniciando rodada: ${new Date().toISOString()}`);
  const errors = [];

  if (skipMonitors) {
    console.log("--skip-monitors ativo: usando relatórios existentes.");
  } else {
    console.log("Rodando monitores em paralelo...");
    const jobs = [];
    if (!skipOlx) jobs.push(["olx", runOlxMonitor(olxMaxPerCpu)]);
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
    if (!skipMelanger) jobs.push(["melanger", runScript("monitor-melanger.mjs", [])]);
    if (!skipBuds4Pro) jobs.push(["buds4-pro", runScript("monitor-galaxy-buds4-pro.mjs", [])]);
    if (!skipOura) jobs.push(["oura", runScript("monitor-oura-ring5.mjs", [])]);
    // Mercado Livre NÃO roda aqui: é desacoplado do fluxo do OLX/Enjoei (que
    // espera todos os jobs antes de publicar). O ML é pesado/lento e roda sob
    // demanda via `npm run monitor:mercadolivre` ou o atalho da barra de tarefas
    // (run-mercadolivre-and-publish.ps1), que coleta e publica por conta própria.

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
      if (name === "melanger") { console.error(`Melanger falhou: ${result.reason.message}`); errors.push(`Melanger: ${result.reason.message}`); }
      if (name === "buds4-pro") { console.error(`Galaxy Buds4 Pro falhou: ${result.reason.message}`); errors.push(`Galaxy Buds4 Pro: ${result.reason.message}`); }
      if (name === "oura") { console.error(`Oura Ring 5 falhou: ${result.reason.message}`); errors.push(`Oura Ring 5: ${result.reason.message}`); }
    }
  }

  // Só apresentamos relatórios DESTA rodada. Se um monitor falhou e não escreveu
  // relatório novo, readLatestReport(dir, minTime) devolve null em vez do relatório
  // antigo — evita reapresentar/realertar achados de rodadas anteriores. No modo
  // --skip-monitors (reuso de relatórios para teste), não aplicamos o corte.
  const reportMinTime = skipMonitors ? null : runStart;
  const enjoeiOn = !onlyOlx && !skipEnjoei;
  const [olxStd, enjoeiReport, enjoeiNbStd, dockReport, fitbitReport, lifefactoryReport, telaBook3Report, melangerReport, buds4ProReport, ouraReport] = await Promise.all([
    skipOlx          ? null : readLatestReport(OLX_DIR, reportMinTime).catch(() => null),
    enjoeiOn         ? readLatestReport(ENJOEI_DIR, reportMinTime).catch(() => null) : null,
    enjoeiOn         ? readLatestReport(ENJOEI_NOTEBOOKS_DIR, reportMinTime).catch(() => null) : null,
    skipDockstations ? null : readLatestReport(DOCKSTATIONS_DIR, reportMinTime).catch(() => null),
    skipFitbit       ? null : readLatestReport(FITBIT_DIR, reportMinTime).catch(() => null),
    skipLifefactory  ? null : readLatestReport(LIFEFACTORY_DIR, reportMinTime).catch(() => null),
    skipTelaBook3    ? null : readLatestReport(TELA_BOOK3_DIR, reportMinTime).catch(() => null),
    skipMelanger     ? null : readLatestReport(MELANGER_DIR, reportMinTime).catch(() => null),
    skipBuds4Pro     ? null : readLatestReport(BUDS4PRO_DIR, reportMinTime).catch(() => null),
    skipOura         ? null : readLatestReport(OURA_DIR, reportMinTime).catch(() => null),
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
    { label: "Melanger",         report: melangerReport, newRe: /Novos produtos:\s*\*\*(\d+)\*\*/,                  newSec: "## Novos produtos",  priceSec: "## Mudanças de preço" },
    { label: "Galaxy Buds4 Pro", report: buds4ProReport, newRe: /Novos produtos:\s*\*\*(\d+)\*\*/,                  newSec: "## Novos produtos",  priceSec: "## Mudanças de preço" },
    { label: "Oura Ring 5",      report: ouraReport,   newRe: /Novos produtos:\s*\*\*(\d+)\*\*/,                    newSec: "## Novos produtos",  priceSec: "## Mudanças de preço" },
  ].map((s) => ({
    ...s,
    newCount:   extractNewCount(s.report, s.newRe),
    priceCount: extractNewCount(s.report, PRICE_CHANGE_RE),
  }));
  if (!skipMercadoLivre) {
    const mlReports = await Promise.all(MERCADOLIVRE_DIRS.map(([, dir]) =>
      readLatestReport(dir, reportMinTime).catch(() => null)
    ));
    for (let index = 0; index < MERCADOLIVRE_DIRS.length; index += 1) {
      const [label] = MERCADOLIVRE_DIRS[index];
      const report = mlReports[index];
      sources.push({
        label,
        report,
        newRe: /Novos produtos:\s*\*\*(\d+)\*\*/,
        newSec: "## Novos produtos",
        priceSec: "## Mudancas de preco",
        newCount: extractNewCount(report, /Novos produtos:\s*\*\*(\d+)\*\*/),
        priceCount: extractNewCount(report, PRICE_CHANGE_RE),
      });
    }
  }

  const totalNew   = sources.reduce((sum, s) => sum + s.newCount, 0);
  const totalPrice = sources.reduce((sum, s) => sum + s.priceCount, 0);

  console.log("\nResumo desta rodada:");
  for (const s of sources) {
    if (!s.report) continue;
    console.log(`  ${s.label}: ${s.newCount} novo(s), ${s.priceCount} preço(s)`);
  }

  // Memória entre rodadas: lê status de ambos os ambientes e reconcilia a fila de falhas pendentes.
  const localStatusFile = path.join(workspaceRoot, "data", "status", "latest-local.json");
  const ciStatusFile    = path.join(workspaceRoot, "data", "status", "latest-ci.json");
  const [localStatus, ciStatus] = await Promise.all([
    readStatusFile(localStatusFile),
    readStatusFile(ciStatusFile),
  ]);

  const priorPending = reconcilePendingFailures(localStatus, ciStatus);
  const priorNote    = buildPriorFailureNote(priorPending);

  const subject     = buildSubject(sources, errors);
  const body        = (priorNote ? `> ${priorNote}\n\n` : "") + buildBody(sources, errors);
  const whatsappMsg = (priorNote ? `${priorNote}\n\n` : "") + buildWhatsAppMessage(sources, errors);

  // WhatsApp sempre (heartbeat de execução).
  // Email quando há novos itens, alterações de preço ou erros (evita caixa cheia com confirmações vazias).
  const sendingEmail = totalNew > 0 || totalPrice > 0 || errors.length > 0 || forceEmail;

  if (dryRun) {
    console.log("\n── DRY-RUN (nada enviado) ──");
    console.log(`Enviaria email? ${sendingEmail ? "sim" : "não"}`);
    console.log(`\nSUBJECT: ${subject}`);
    console.log(`\nWHATSAPP:\n${whatsappMsg}`);
    console.log(`\nEMAIL BODY:\n${body || "(vazio)"}`);
    if (errors.length > 0) {
      process.exitCode = 1;
    }
    return;
  }

  const [emailResult, waResult] = await Promise.allSettled([
    sendingEmail ? sendEmailFn(subject, body) : Promise.resolve(null),
    sendWhatsAppFn(whatsappMsg),
  ]);

  const emailActuallySent = sendingEmail && emailResult.status === "fulfilled";
  const whatsappActuallySent = waResult.status === "fulfilled";
  const delivered = emailActuallySent || whatsappActuallySent;

  if (sendingEmail) {
    if (emailResult.status === "fulfilled") console.log(`Email enviado para ${NOTIFY_TO}.`);
    else console.warn(`Email não enviado: ${emailResult.reason?.message}`);
  }
  if (waResult.status === "fulfilled") console.log("WhatsApp enviado.");
  else console.warn(`WhatsApp não enviado: ${waResult.reason?.message}`);

  const priorIdsInMessage = priorPending.map(f => f.id);
  const newAcks = delivered ? priorIdsInMessage : [];
  const priorAcks = mergeAcks(localStatus?.acknowledged_failure_ids || [], ciStatus?.acknowledged_failure_ids || []);
  const finalAcks = mergeAcks(priorAcks, newAcks);

  let workingPending = priorPending.filter(f => !finalAcks.includes(f.id));

  // Adiciona novas falhas desta rodada (com mensagem sanitizada)
  const newFailures = [];
  const runNowStr = runNow.toISOString();
  if (sendingEmail && emailResult.status === "rejected") {
    newFailures.push({
      channel: "email",
      error: sanitizeErrorMessage(emailResult.reason?.message)
    });
  }
  if (waResult.status === "rejected") {
    newFailures.push({
      channel: "whatsapp",
      error: sanitizeErrorMessage(waResult.reason?.message)
    });
  }

  // Merge final das pendências e escrita
  const finalPending = mergePendingFailures(workingPending, newFailures, runNowStr);

  const status = buildDeliveryStatus({
    now: runNow,
    sendingEmail,
    email: sendingEmail
      ? { ok: emailResult.status === "fulfilled", error: emailResult.reason?.message }
      : undefined,
    whatsapp: { ok: waResult.status === "fulfilled", error: waResult.reason?.message },
    pendingFailures: finalPending,
    acknowledgedFailureIds: finalAcks,
    source: process.env.GITHUB_ACTIONS === "true" ? "ci" : "local"
  });

  await writeDeliveryStatus(status);

  // Propagação de erro se algum monitor falhou
  if (errors.length > 0) {
    console.error(`Rodada concluída com ${errors.length} erro(s) de monitoramento.`);
    process.exitCode = 1;
  }
} finally {
  fsApi = prevFsApi;
  runCommandFn = prevRunCommandFn;
}
}

async function readStatusFile(filePath) {
  try { return JSON.parse(await fsApi.readFile(filePath, "utf8")); }
  catch { return null; }
}

async function writeDeliveryStatus(status) {
  try {
    const filePath = getStatusFilePath();
    await fsApi.mkdir(path.dirname(filePath), { recursive: true });
    await fsApi.writeFile(filePath, JSON.stringify(status, null, 2), "utf8");
  } catch (err) {
    console.warn(`Não consegui gravar status de entrega: ${err.message}`);
  }
}

// ── scripts ───────────────────────────────────────────────────────────────────

function runScript(scriptName, extraArgs) {
  const scriptPath = path.join(workspaceRoot, "scripts", scriptName);
  return runCommandFn(process.execPath, [scriptPath, ...extraArgs]);
}

function runOlxMonitor(olxMaxPerCpu) {
  if (process.platform === "win32" && process.env.GITHUB_ACTIONS !== "true") {
    return runCommandFn("powershell.exe", [
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
    const child = child_process.spawn(command, args, { stdio: "inherit", cwd: workspaceRoot });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Saiu com código ${code}`))));
    child.on("error", reject);
  });
}

function getArgValue(name, args = process.argv) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

async function readLatestReport(dir, minTime = null) {
  const entries = await fsApi.readdir(dir).catch(() => []);
  const reports = entries
    .filter((n) => n.startsWith("report-") && !n.startsWith("report-premium-") && n.endsWith(".md"))
    .sort().reverse();
  if (!reports.length) return null;
  // Se o relatório mais recente é de antes desta rodada, a fonte não produziu
  // nada agora (falhou) — não o apresentamos como resultado atual.
  if (minTime != null) {
    const ts = reportFileTime(reports[0]);
    if (ts != null && ts < minTime) return null;
  }
  return fsApi.readFile(path.join(dir, reports[0]), "utf8");
}

// Instante (epoch ms) embutido no nome do arquivo de relatório, ou null.
function reportFileTime(file) {
  const m = file.match(/report-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.md$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, ms] = m;
  const t = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`);
  return Number.isNaN(t) ? null : t;
}

async function readLatestPremiumReport(dir) {
  const entries = await fsApi.readdir(dir).catch(() => []);
  const reports = entries
    .filter((n) => n.startsWith("report-premium-") && n.endsWith(".md"))
    .sort().reverse();
  if (!reports.length) return null;
  return fsApi.readFile(path.join(dir, reports[0]), "utf8");
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
  return capByWholeLines(lines, 1500);
}

// Limita o tamanho da mensagem sem cortar uma linha (e sua URL) no meio: vai
// somando linhas inteiras até o orçamento e descarta o excedente como um todo.
function capByWholeLines(lines, max) {
  const out = [];
  let used = 0;
  for (const line of lines) {
    const add = (out.length ? 1 : 0) + line.length; // +1 do "\n"
    if (used + add > max) break;
    out.push(line);
    used += add;
  }
  return out.join("\n");
}

function extractNewItems(report, sectionHeader) {
  if (!report) return [];
  const start = report.indexOf(sectionHeader);
  if (start === -1) return [];
  const end = report.indexOf("\n##", start + 1);
  const section = end === -1 ? report.slice(start) : report.slice(start, end);
  return section.split("\n")
    .filter((l) => l.startsWith("- ") && !l.includes("Nenhum"))
    .map(shortenKeepingUrl);
}

// Encurta a linha sem mutilar o link: trunca só o trecho ANTES da URL (preço +
// título) e mantém a URL inteira, que é a parte clicável do alerta de WhatsApp.
function shortenKeepingUrl(line, maxPrefix = 150) {
  const idx = line.search(/https?:\/\//);
  if (idx === -1) return line.length > maxPrefix ? line.slice(0, maxPrefix - 1) + "…" : line;
  const prefix = line.slice(0, idx);
  const url = line.slice(idx).trim();
  const head = prefix.length > maxPrefix ? prefix.slice(0, maxPrefix - 1) + "… " : prefix;
  return head + url;
}

// ── email / WhatsApp ──────────────────────────────────────────────────────────

async function sendEmail(subject, body) {
  if (!GMAIL_USER) throw new Error("GMAIL_USER não definida");
  if (!GMAIL_APP_PASSWORD) throw new Error("GMAIL_APP_PASSWORD não definida");
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com", port: 587, secure: false,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
  await transporter.sendMail({ from: `Monitor <${GMAIL_USER}>`, to: NOTIFY_TO, subject, text: body });
}

async function sendWhatsApp(message) {
  if (!CALLMEBOT_PHONE || !CALLMEBOT_APIKEY) throw new Error("CALLMEBOT_PHONE/CALLMEBOT_APIKEY não definidas");
  const url = `https://api.callmebot.com/whatsapp.php?phone=${CALLMEBOT_PHONE}&text=${encodeURIComponent(message)}&apikey=${CALLMEBOT_APIKEY}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`CallMeBot HTTP ${response.status}`);
}
