import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDeliveryStatus,
  buildPriorFailureNote,
  sanitizeErrorMessage,
  mergePendingFailures,
  reconcilePendingFailures
} from "../scripts/lib/notification-status.mjs";

const NOW = new Date("2026-06-26T19:00:00Z");

test("status registra email enviado e whatsapp enviado", () => {
  const s = buildDeliveryStatus({ now: NOW, sendingEmail: true, email: { ok: true }, whatsapp: { ok: true } });
  assert.equal(s.email, "sent");
  assert.equal(s.whatsapp, "sent");
  assert.equal(s.generated_at, "2026-06-26T19:00:00.000Z");
});

test("status registra email skipped quando não havia envio", () => {
  const s = buildDeliveryStatus({ now: NOW, sendingEmail: false, whatsapp: { ok: true } });
  assert.equal(s.email, "skipped");
  assert.equal(s.whatsapp, "sent");
});

test("status registra falhas com mensagem sanitizada", () => {
  const s = buildDeliveryStatus({
    now: NOW,
    sendingEmail: true,
    email: { ok: false, error: "GMAIL_APP_PASSWORD não definida" },
    whatsapp: { ok: false, error: "fetch https://api.callmebot.com/whatsapp.php?phone=5541999&apikey=2696242 falhou" },
  });
  assert.equal(s.email, "failed");
  assert.equal(s.email_error, "GMAIL_APP_PASSWORD não definida");
  assert.equal(s.whatsapp, "failed");
  assert.doesNotMatch(s.whatsapp_error, /2696242/);
  assert.doesNotMatch(s.whatsapp_error, /5541999/);
  assert.match(s.whatsapp_error, /\[redacted\]/);
});

test("sanitize remove apikey e phone soltos", () => {
  assert.doesNotMatch(sanitizeErrorMessage("erro apikey=ABC123 phone=5541"), /ABC123|5541/);
});

test("sanitize remove bearer tokens e query strings", () => {
  const msg = "Erro: Bearer abc123xyz em https://api.exemplo.com/route?key=123&phone=555";
  const sanitized = sanitizeErrorMessage(msg);
  assert.match(sanitized, /Bearer \[redacted\]/);
  assert.match(sanitized, /\?\[redacted\]/);
  assert.doesNotMatch(sanitized, /abc123xyz/);
  assert.doesNotMatch(sanitized, /key=123/);
});

test("sanitize remove chaves sensíveis variadas", () => {
  const msg = "api_key: secret123, password=pwd, secret=shh, token: tokval, authorization=authval, phone=12345";
  const sanitized = sanitizeErrorMessage(msg);
  assert.match(sanitized, /api_key=\[redacted\]/);
  assert.match(sanitized, /password=\[redacted\]/);
  assert.match(sanitized, /secret=\[redacted\]/);
  assert.match(sanitized, /token=\[redacted\]/);
  assert.match(sanitized, /authorization=\[redacted\]/);
  assert.match(sanitized, /phone=\[redacted\]/);
  assert.doesNotMatch(sanitized, /secret123|pwd|shh|tokval|authval|12345/);
});

test("sanitize limita tamanho da mensagem", () => {
  const longMsg = "a".repeat(1200);
  const sanitized = sanitizeErrorMessage(longMsg);
  assert.equal(sanitized.length, 1000);
  assert.ok(sanitized.endsWith("…"));
});

test("mergePendingFailures mescla, ordena cronologicamente e limita fila", () => {
  const prior = [
    { channel: "email", at: "2026-06-26T10:00:00.000Z", error: "Auth error" },
    { channel: "whatsapp", at: "2026-06-26T11:00:00.000Z", error: "Timeout" }
  ];
  const newFailures = [
    { channel: "email", at: "2026-06-26T12:00:00.000Z", error: "Auth error" }, // Duplicada, substitui timestamp
    { channel: "whatsapp", at: "2026-06-26T13:00:00.000Z", error: "Conn error" }
  ];

  const merged = mergePendingFailures(prior, newFailures);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].at, "2026-06-26T11:00:00.000Z"); // whatsapp Timeout (antigo mantido)
  assert.equal(merged[1].at, "2026-06-26T12:00:00.000Z"); // email Auth error (novo atualizado)
  assert.equal(merged[2].at, "2026-06-26T13:00:00.000Z"); // whatsapp Conn error (novo)
});

test("mergePendingFailures limita fila ao maxPending", () => {
  const list = [];
  for (let i = 0; i < 25; i++) {
    list.push({ channel: "whatsapp", at: new Date(Date.now() + i * 1000).toISOString(), error: `Error ${i}` });
  }
  const merged = mergePendingFailures(list, [], 20);
  assert.equal(merged.length, 20);
  assert.equal(merged[0].error, "Error 5");
  assert.equal(merged[19].error, "Error 24");
});

test("reconcilePendingFailures remove falhas comunicadas por sucesso", () => {
  // Local falhou em e-mail às 10:00
  const localStatus = {
    generated_at: "2026-06-26T10:00:00.000Z",
    delivery: { email: "failed", whatsapp: "sent" }, // WhatsApp foi entregue (sucesso!)
    pending_failures: [
      { channel: "email", at: "2026-06-26T10:00:00.000Z", error: "Auth error" }
    ]
  };

  // CI falhou em whatsapp às 09:00
  const ciStatus = {
    generated_at: "2026-06-26T09:00:00.000Z",
    delivery: { email: "skipped", whatsapp: "failed" },
    pending_failures: [
      { channel: "whatsapp", at: "2026-06-26T09:00:00.000Z", error: "Timeout" }
    ]
  };

  const reconciled = reconcilePendingFailures(localStatus, ciStatus);
  // O sucesso do localStatus em WhatsApp às 10:00 deve limpar as falhas de at <= 10:00.
  // Como ambas as falhas (09:00 e 10:00) ocorreram em ou antes de 10:00, ambas devem ser limpas!
  assert.equal(reconciled.length, 0);
});

test("reconcilePendingFailures mantem falhas nao comunicadas", () => {
  // Local falhou em e-mail às 10:00, sem sucesso em nenhum canal
  const localStatus = {
    generated_at: "2026-06-26T10:00:00.000Z",
    delivery: { email: "failed", whatsapp: "failed" },
    pending_failures: [
      { channel: "email", at: "2026-06-26T10:00:00.000Z", error: "Auth error" }
    ]
  };

  // CI falhou em whatsapp às 11:00, sem sucesso em nenhum canal
  const ciStatus = {
    generated_at: "2026-06-26T11:00:00.000Z",
    delivery: { email: "skipped", whatsapp: "failed" },
    pending_failures: [
      { channel: "whatsapp", at: "2026-06-26T11:00:00.000Z", error: "Timeout" }
    ]
  };

  const reconciled = reconcilePendingFailures(localStatus, ciStatus);
  assert.equal(reconciled.length, 2);
  assert.equal(reconciled[0].channel, "email");
  assert.equal(reconciled[1].channel, "whatsapp");
});

test("reconcilePendingFailures converte status legados", () => {
  const localStatus = {
    generated_at: "2026-06-26T10:00:00.000Z",
    email: "failed",
    email_error: "Auth error",
    whatsapp: "sent"
  };
  const ciStatus = {
    generated_at: "2026-06-26T09:00:00.000Z",
    email: "skipped",
    whatsapp: "failed",
    whatsapp_error: "Timeout"
  };

  const reconciled = reconcilePendingFailures(localStatus, ciStatus);
  // O sucesso do localStatus em 10:00 deve limpar ambos
  assert.equal(reconciled.length, 0);
});

test("nota de falha anterior aparece só quando houve falha", () => {
  assert.equal(buildPriorFailureNote(null), null);
  assert.equal(buildPriorFailureNote({ email: "sent", whatsapp: "sent" }), null);

  const note = buildPriorFailureNote({ email: "sent", whatsapp: "failed", generated_at: "2026-06-26T16:00:00.000Z" });
  assert.match(note, /Rodada anterior/);
  assert.match(note, /WhatsApp/);
  assert.doesNotMatch(note, /e-mail/);
});

test("nota de falha anterior formata lista de pendencias corretamente", () => {
  const pending = [
    { channel: "email", at: "2026-06-26T16:00:00.000Z", error: "Auth failed" },
    { channel: "whatsapp", at: "2026-06-26T17:00:00.000Z", error: "Timeout" }
  ];
  const note = buildPriorFailureNote(pending);
  assert.match(note, /Rodada anterior/);
  assert.match(note, /e-mail/);
  assert.match(note, /WhatsApp/);
});
