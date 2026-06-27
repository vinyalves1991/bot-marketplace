import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDeliveryStatus,
  buildPriorFailureNote,
  sanitizeErrorMessage,
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

test("nota de falha anterior aparece só quando houve falha", () => {
  assert.equal(buildPriorFailureNote(null), null);
  assert.equal(buildPriorFailureNote({ email: "sent", whatsapp: "sent" }), null);
  const note = buildPriorFailureNote({ email: "sent", whatsapp: "failed", generated_at: "2026-06-26T16:00:00.000Z" });
  assert.match(note, /Rodada anterior/);
  assert.match(note, /WhatsApp/);
  assert.doesNotMatch(note, /e-mail/);
});
