import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import child_process from "node:child_process";
import nodemailer from "nodemailer";
import { fileURLToPath } from "node:url";

import { main } from "../scripts/run-monitors-and-notify.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test.describe("Orquestrador - Integração e Propagação de Erros", () => {
  let originalExitCode;
  let originalGithubActions;
  let originalGmailUser;
  let originalGmailAppPass;
  let originalCallmebotPhone;
  let originalCallmebotApikey;
  let originalFetch;
  let originalArgv;

  test.beforeEach((t) => {
    originalExitCode = process.exitCode;
    originalGithubActions = process.env.GITHUB_ACTIONS;
    originalGmailUser = process.env.GMAIL_USER;
    originalGmailAppPass = process.env.GMAIL_APP_PASSWORD;
    originalCallmebotPhone = process.env.CALLMEBOT_PHONE;
    originalCallmebotApikey = process.env.CALLMEBOT_APIKEY;
    originalFetch = globalThis.fetch;
    originalArgv = process.argv;

    process.exitCode = undefined;

    // Garante credenciais para não rejeitar por validação de ausência de secrets
    process.env.GMAIL_USER = "test@gmail.com";
    process.env.GMAIL_APP_PASSWORD = "xxxx xxxx xxxx xxxx";
    process.env.CALLMEBOT_PHONE = "5541999999999";
    process.env.CALLMEBOT_APIKEY = "123456";

    // Garante que qualquer tentativa de usar recursos reais falha imediatamente
    t.mock.method(child_process, "spawn", () => {
      throw new Error("Real child_process.spawn should not be called in tests");
    });
    t.mock.method(nodemailer, "createTransport", () => {
      throw new Error("Real nodemailer.createTransport should not be called in tests");
    });
    globalThis.fetch = () => {
      throw new Error("Real globalThis.fetch should not be called in tests");
    };
  });

  test.afterEach(() => {
    process.exitCode = originalExitCode;

    if (originalGithubActions === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = originalGithubActions;

    if (originalGmailUser === undefined) delete process.env.GMAIL_USER;
    else process.env.GMAIL_USER = originalGmailUser;

    if (originalGmailAppPass === undefined) delete process.env.GMAIL_APP_PASSWORD;
    else process.env.GMAIL_APP_PASSWORD = originalGmailAppPass;

    if (originalCallmebotPhone === undefined) delete process.env.CALLMEBOT_PHONE;
    else process.env.CALLMEBOT_PHONE = originalCallmebotPhone;

    if (originalCallmebotApikey === undefined) delete process.env.CALLMEBOT_APIKEY;
    else process.env.CALLMEBOT_APIKEY = originalCallmebotApikey;

    globalThis.fetch = originalFetch;
    process.argv = originalArgv;
  });

  test("um processo filho retornando exit code 1 faz o orquestrador sinalizar erro e persistir status", async (t) => {
    // 1. Simula falha do monitor enjoei-notebooks via stub injetado
    const runCommandFn = t.mock.fn(async (cmd, args) => {
      if (args && args.some(arg => arg.includes("monitor-enjoei-notebooks.mjs"))) {
        throw new Error("Saiu com código 1");
      }
      return Promise.resolve();
    });

    const sendEmailFn = t.mock.fn(async () => Promise.resolve());
    const sendWhatsAppFn = t.mock.fn(async () => Promise.resolve());

    // 2. Mock do filesystem para ler/escrever status
    const statusWrites = [];
    const fsApi = {
      readFile: t.mock.fn(async (filePath) => {
        if (filePath.endsWith(".json")) return "{}";
        return "";
      }),
      writeFile: t.mock.fn(async (filePath, content) => {
        if (filePath.endsWith(".json")) {
          statusWrites.push({ path: filePath, json: JSON.parse(content) });
        }
      }),
      mkdir: t.mock.fn(async () => {}),
      readdir: t.mock.fn(async () => [])
    };

    // 3. Configura ambiente CI e roda o orquestrador com dependências injetadas
    process.env.GITHUB_ACTIONS = "true";
    await main({ runCommandFn, sendEmailFn, sendWhatsAppFn, fsApi });

    // 4. Assegura que o status foi gravado em latest-ci.json
    const ciWrite = statusWrites.find(w => w.path.endsWith("latest-ci.json"));
    assert.ok(ciWrite, "Devia ter gravado o status de CI");
    assert.equal(ciWrite.json.source, "ci");

    // 5. Assegura que o orquestrador sinalizou erro no process.exitCode
    assert.equal(process.exitCode, 1, "Devia propagar exit code 1 do monitor falho");
  });

  test("ambiente local grava em latest-local.json", async (t) => {
    const runCommandFn = t.mock.fn(async () => Promise.resolve());
    const sendEmailFn = t.mock.fn(async () => Promise.resolve());
    const sendWhatsAppFn = t.mock.fn(async () => Promise.resolve());

    const statusWrites = [];
    const fsApi = {
      readFile: t.mock.fn(async () => "{}"),
      writeFile: t.mock.fn(async (filePath, content) => {
        if (filePath.endsWith(".json")) statusWrites.push({ path: filePath, json: JSON.parse(content) });
      }),
      mkdir: t.mock.fn(async () => {}),
      readdir: t.mock.fn(async () => [])
    };

    process.env.GITHUB_ACTIONS = "false";
    await main({ runCommandFn, sendEmailFn, sendWhatsAppFn, fsApi });

    const localWrite = statusWrites.find(w => w.path.endsWith("latest-local.json"));
    assert.ok(localWrite, "Devia ter gravado o status local");
    assert.equal(localWrite.json.source, "local");
    assert.equal(process.exitCode, undefined, "Sem falhas, exitCode deve ficar limpo");
  });

  test("erros de notificacao sao enfileirados em pending_failures e sanitizados", async (t) => {
    const runCommandFn = t.mock.fn(async () => Promise.resolve());
    const sendEmailFn = t.mock.fn(async () => Promise.resolve());
    const sendWhatsAppFn = t.mock.fn(async () => {
      throw new Error("CallMeBot falhou na URL https://api.callmebot.com/whatsapp.php?phone=55419999&apikey=SECRET_KEY");
    });

    const statusWrites = [];
    const fsApi = {
      readFile: t.mock.fn(async () => "{}"),
      writeFile: t.mock.fn(async (filePath, content) => {
        if (filePath.endsWith(".json")) statusWrites.push({ path: filePath, json: JSON.parse(content) });
      }),
      mkdir: t.mock.fn(async () => {}),
      readdir: t.mock.fn(async () => [])
    };

    process.env.GITHUB_ACTIONS = "true";
    await main({ runCommandFn, sendEmailFn, sendWhatsAppFn, fsApi });

    const ciWrite = statusWrites.find(w => w.path.endsWith("latest-ci.json"));
    assert.ok(ciWrite);

    // O erro no WhatsApp deve estar na lista de pending_failures
    const pending = ciWrite.json.pending_failures;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].channel, "whatsapp");

    // O erro deve ter sido sanitizado (sem telefone nem chave sensível de API)
    assert.doesNotMatch(pending[0].error, /SECRET_KEY/);
    assert.doesNotMatch(pending[0].error, /55419999/);
    assert.match(pending[0].error, /\[redacted\]/);
  });

  test("se houver falha de monitor, dry-run define exitCode = 1 sem fazer I/O", async (t) => {
    const runCommandFn = t.mock.fn(async (cmd, args) => {
      throw new Error("Monitor falhou");
    });
    const sendEmailFn = t.mock.fn(async () => Promise.resolve());
    const sendWhatsAppFn = t.mock.fn(async () => Promise.resolve());

    const fsApi = {
      readFile: t.mock.fn(async () => "{}"),
      writeFile: t.mock.fn(async () => Promise.resolve()),
      mkdir: t.mock.fn(async () => Promise.resolve()),
      readdir: t.mock.fn(async () => [])
    };

    await main({ runCommandFn, sendEmailFn, sendWhatsAppFn, fsApi, args: ["--dry-run"] });

    assert.equal(process.exitCode, 1, "Exit code deve ser 1 em dry-run se monitores falharem");
    assert.equal(sendEmailFn.mock.calls.length, 0, "sendEmailFn não deve ser chamado em dry-run");
    assert.equal(sendWhatsAppFn.mock.calls.length, 0, "sendWhatsAppFn não deve ser chamado em dry-run");
    assert.equal(fsApi.writeFile.mock.calls.length, 0, "fsApi.writeFile não deve ser chamado em dry-run");
  });
});

test("Validação do Workflow do GitHub Actions", async () => {
  const workflowPath = path.join(root, ".github", "workflows", "monitor.yml");
  const yamlContent = await fs.readFile(workflowPath, "utf8");

  // Verifica se o job monitor depende do job test
  assert.match(yamlContent, /monitor:\s*[\s\S]*?needs:\s*test/);

  // Verifica se a etapa de rodar monitores tem continue-on-error e id
  assert.match(yamlContent, /Rodar monitores e notificar/);
  assert.match(yamlContent, /id:\s*monitor_run/);
  assert.match(yamlContent, /continue-on-error:\s*true/);

  // Verifica se a etapa de salvar snapshots e publicar dashboard tem if: always()
  assert.match(yamlContent, /Salvar snapshots e publicar dashboard/);
  assert.match(yamlContent, /if:\s*always\(\)/);

  // Verifica se existe a etapa de sinalizar falhas
  assert.match(yamlContent, /Sinalizar falha dos monitores/);
  assert.match(yamlContent, /if:\s*steps\.monitor_run\.outcome\s*==\s*['"]failure['"]/);
  assert.match(yamlContent, /run:\s*exit\s*1/);

  // Verifica a ordem sequencial das etapas: monitor_run < publicação < Sinalizar falha
  const monitorRunIdx = yamlContent.indexOf("id: monitor_run");
  const publishIdx = yamlContent.indexOf("Salvar snapshots e publicar dashboard");
  const failSignalIdx = yamlContent.indexOf("Sinalizar falha dos monitores");

  assert.ok(monitorRunIdx !== -1, "Passo de execução do orquestrador não encontrado");
  assert.ok(publishIdx !== -1, "Passo de publicação não encontrado");
  assert.ok(failSignalIdx !== -1, "Passo de sinalização de falha não encontrado");

  assert.ok(monitorRunIdx < publishIdx, "Execução do orquestrador deve ocorrer antes da publicação");
  assert.ok(publishIdx < failSignalIdx, "Publicação deve ocorrer antes de sinalizar a falha");
});
