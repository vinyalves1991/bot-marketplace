import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import child_process from "node:child_process";
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

  test.beforeEach(() => {
    originalExitCode = process.exitCode;
    originalGithubActions = process.env.GITHUB_ACTIONS;
    originalGmailUser = process.env.GMAIL_USER;
    originalGmailAppPass = process.env.GMAIL_APP_PASSWORD;
    originalCallmebotPhone = process.env.CALLMEBOT_PHONE;
    originalCallmebotApikey = process.env.CALLMEBOT_APIKEY;

    process.exitCode = undefined;

    // Garante credenciais para não rejeitar por validação de ausência de secrets
    process.env.GMAIL_USER = "test@gmail.com";
    process.env.GMAIL_APP_PASSWORD = "xxxx xxxx xxxx xxxx";
    process.env.CALLMEBOT_PHONE = "5541999999999";
    process.env.CALLMEBOT_APIKEY = "123456";
  });

  test.afterEach(() => {
    process.exitCode = originalExitCode;
    process.env.GITHUB_ACTIONS = originalGithubActions;
    process.env.GMAIL_USER = originalGmailUser;
    process.env.GMAIL_APP_PASSWORD = originalGmailAppPass;
    process.env.CALLMEBOT_PHONE = originalCallmebotPhone;
    process.env.CALLMEBOT_APIKEY = originalCallmebotApikey;
  });

  test("um processo filho retornando exit code 1 faz o orquestrador sinalizar erro e persistir status", async (t) => {
    // 1. Simula child_process.spawn falhando para um monitor (ex: enjoei-notebooks)
    t.mock.method(child_process, "spawn", (command, args) => {
      return {
        on: (event, cb) => {
          if (event === "close") {
            // Se for o enjoei-notebooks, falha com exit code 1
            if (args && args.some(arg => arg.includes("monitor-enjoei-notebooks.mjs"))) {
              return setTimeout(() => cb(1), 10);
            }
            // Outros completam com sucesso
            return setTimeout(() => cb(0), 10);
          }
        },
        onKey: () => {}
      };
    });

    // 2. Mock do filesystem para ler/escrever status
    const statusWrites = [];
    t.mock.method(fs, "readFile", async (filePath) => {
      // Retorna vazio para não ter relatórios ou status anteriores
      if (filePath.endsWith(".json")) return "{}";
      return "";
    });
    t.mock.method(fs, "writeFile", async (filePath, content) => {
      if (filePath.endsWith(".json")) {
        statusWrites.push({ path: filePath, json: JSON.parse(content) });
      }
    });
    t.mock.method(fs, "readdir", async () => []);

    // 3. Mock do global fetch (WhatsApp) e global mail sending
    t.mock.method(globalThis, "fetch", async () => {
      return { ok: true, status: 200 };
    });

    // 4. Configura ambiente CI e roda o orquestrador
    process.env.GITHUB_ACTIONS = "true";
    await main();

    // 5. Assegura que o status foi gravado em latest-ci.json
    const ciWrite = statusWrites.find(w => w.path.endsWith("latest-ci.json"));
    assert.ok(ciWrite, "Devia ter gravado o status de CI");
    assert.equal(ciWrite.json.source, "ci");

    // 6. Assegura que o orquestrador sinalizou erro no process.exitCode
    assert.equal(process.exitCode, 1, "Devia propagar exit code 1 do monitor falho");
  });

  test("ambiente local grava em latest-local.json", async (t) => {
    t.mock.method(child_process, "spawn", () => ({ on: (event, cb) => event === "close" && setTimeout(() => cb(0), 10) }));
    
    const statusWrites = [];
    t.mock.method(fs, "readFile", async () => "{}");
    t.mock.method(fs, "writeFile", async (filePath, content) => {
      if (filePath.endsWith(".json")) statusWrites.push({ path: filePath, json: JSON.parse(content) });
    });
    t.mock.method(fs, "readdir", async () => []);
    t.mock.method(globalThis, "fetch", async () => ({ ok: true }));

    process.env.GITHUB_ACTIONS = "false";
    await main();

    const localWrite = statusWrites.find(w => w.path.endsWith("latest-local.json"));
    assert.ok(localWrite, "Devia ter gravado o status local");
    assert.equal(localWrite.json.source, "local");
    assert.equal(process.exitCode, undefined, "Sem falhas, exitCode deve ficar limpo");
  });

  test("erros de notificacao sao enfileirados em pending_failures e sanitizados", async (t) => {
    t.mock.method(child_process, "spawn", () => ({ on: (event, cb) => event === "close" && setTimeout(() => cb(0), 10) }));

    const statusWrites = [];
    t.mock.method(fs, "readFile", async () => "{}");
    t.mock.method(fs, "writeFile", async (filePath, content) => {
      if (filePath.endsWith(".json")) statusWrites.push({ path: filePath, json: JSON.parse(content) });
    });
    t.mock.method(fs, "readdir", async () => []);

    // Simula falha no WhatsApp/CallMeBot injetando chave sensível na URL de erro
    t.mock.method(globalThis, "fetch", async () => {
      throw new Error("CallMeBot falhou na URL https://api.callmebot.com/whatsapp.php?phone=55419999&apikey=SECRET_KEY");
    });

    process.env.GITHUB_ACTIONS = "true";
    await main();

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
});
