import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDeliveryStatus,
  buildPriorFailureNote,
  sanitizeErrorMessage,
  mergePendingFailures,
  reconcilePendingFailures,
  mergeAcks,
  generateLegacyId,
  generateFailureFingerprint
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

test("sanitize remove credenciais com espacos e aspas", () => {
  const msg = 'password: "valor com espaços", Authorization: Basic abcdef, token=\'segredo\'';
  const sanitized = sanitizeErrorMessage(msg);
  assert.match(sanitized, /password=\[redacted\]/);
  assert.match(sanitized, /Authorization=\[redacted\]/);
  assert.match(sanitized, /token=\[redacted\]/);
  assert.doesNotMatch(sanitized, /valor com espaços|abcdef|segredo/);
});

test("sanitize limita tamanho da mensagem", () => {
  const longMsg = "a".repeat(1200);
  const sanitized = sanitizeErrorMessage(longMsg);
  assert.equal(sanitized.length, 1000);
  assert.ok(sanitized.endsWith("…"));
});

test("mergePendingFailures incrementa contagem e atualiza last_seen_at para falha repetida", () => {
  const prior = [
    { id: "id-1", channel: "email", first_seen_at: "2026-06-26T10:00:00.000Z", last_seen_at: "2026-06-26T10:00:00.000Z", error: "Auth error", count: 1 }
  ];
  const newFailures = [
    { channel: "email", error: "Auth error" }
  ];

  const merged = mergePendingFailures(prior, newFailures, "2026-06-26T12:00:00.000Z");
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "id-1");
  assert.equal(merged[0].first_seen_at, "2026-06-26T10:00:00.000Z");
  assert.equal(merged[0].last_seen_at, "2026-06-26T12:00:00.000Z");
  assert.equal(merged[0].count, 2);
});

test("mergePendingFailures limita fila ao maxPending", () => {
  const list = [];
  for (let i = 0; i < 25; i++) {
    list.push({ channel: "whatsapp", error: `Error ${i}` });
  }
  const merged = mergePendingFailures([], list, NOW.toISOString(), 20);
  assert.equal(merged.length, 20);
});

test("reconcilePendingFailures mescla local e CI e filtra os que estao em acknowledged_failure_ids", () => {
  const localStatus = {
    pending_failures: [
      { id: "id-1", channel: "email", error: "Auth error" },
      { id: "id-2", channel: "whatsapp", error: "Timeout" }
    ],
    acknowledged_failure_ids: ["id-1"]
  };
  const ciStatus = {
    pending_failures: [
      { id: "id-2", channel: "whatsapp", error: "Timeout" },
      { id: "id-3", channel: "email", error: "SMTP error" }
    ],
    acknowledged_failure_ids: ["id-3"]
  };

  const reconciled = reconcilePendingFailures(localStatus, ciStatus);
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].id, "id-2");
});

test("nota de falha anterior exibe canais afetados", () => {
  assert.equal(buildPriorFailureNote(null), null);
  assert.equal(buildPriorFailureNote([]), null);

  const pending = [
    { channel: "email", last_seen_at: "2026-06-26T16:00:00.000Z", error: "Auth failed" }
  ];
  const note = buildPriorFailureNote(pending);
  assert.match(note, /e-mail/);
  assert.match(note, /⚠️/);
});

test("nota de falha anterior com múltiplos episódios mostra contagem", () => {
  const pending = [
    { channel: "email", error: "SMTP error" },
    { channel: "email", error: "SMTP error 2" }
  ];
  const note = buildPriorFailureNote(pending);
  assert.match(note, /e-mail.*2.*episódios|2.*episódios.*e-mail/);
});

test("mergeAcks limita quantidade de IDs acks", () => {
  const acks1 = Array.from({ length: 60 }, (_, i) => `id-${i}`);
  const acks2 = Array.from({ length: 60 }, (_, i) => `id-${i + 50}`);
  const merged = mergeAcks(acks1, acks2, 100);
  assert.equal(merged.length, 100);
});

test("cenario: email failed + WhatsApp sent na mesma rodada deixa a falha de e-mail pendente", () => {
  const priorPending = [];
  const priorIdsInMessage = priorPending.map(f => f.id);
  const delivered = true;

  const newAcks = delivered ? priorIdsInMessage : [];
  const finalAcks = mergeAcks([], newAcks);

  const workingPending = priorPending.filter(f => !finalAcks.includes(f.id));
  const newFailures = [{ channel: "email", error: "SMTP error" }];

  const finalPending = mergePendingFailures(workingPending, newFailures, NOW.toISOString());
  assert.equal(finalPending.length, 1);
  assert.equal(finalPending[0].channel, "email");
});

test("cenario: falha anterior incluída na nota + WhatsApp sent remove exatamente aquela falha, falha nova permanece", () => {
  const priorPending = [
    { id: "id-1", channel: "email", error: "Auth error" }
  ];
  const priorIdsInMessage = priorPending.map(f => f.id);
  const delivered = true;

  const newAcks = delivered ? priorIdsInMessage : [];
  const finalAcks = mergeAcks([], newAcks);

  const workingPending = priorPending.filter(f => !finalAcks.includes(f.id));
  const newFailures = [{ channel: "email", error: "Auth error" }];
  const finalPending = mergePendingFailures(workingPending, newFailures, NOW.toISOString());

  assert.equal(finalPending.length, 1);
  assert.notEqual(finalPending[0].id, "id-1");
  assert.deepEqual(finalAcks, ["id-1"]);
});

test("cenario: sucesso local que não conhecia falha do CI não apaga a falha do CI", () => {
  const localStatus = { pending_failures: [], acknowledged_failure_ids: [] };
  const ciStatus = { pending_failures: [{ id: "id-ci", channel: "email", error: "CI error" }], acknowledged_failure_ids: [] };

  const reconciled = reconcilePendingFailures(localStatus, ciStatus);
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].id, "id-ci");
});

test("cenario: e-mail skipped + WhatsApp failed mantém pendências", () => {
  const priorPending = [{ id: "id-1", channel: "email", error: "Auth error" }];
  const priorIdsInMessage = priorPending.map(f => f.id);
  const delivered = false;

  const newAcks = delivered ? priorIdsInMessage : [];
  const finalAcks = mergeAcks([], newAcks);

  const workingPending = priorPending.filter(f => !finalAcks.includes(f.id));
  assert.equal(workingPending.length, 1);
  assert.equal(workingPending[0].id, "id-1");
});

test("cenario: acknowledgements de um ambiente impedem ressurreição por arquivo obsoleto do outro", () => {
  const localStatus = { pending_failures: [], acknowledged_failure_ids: ["id-1"] };
  const ciStatus = { pending_failures: [{ id: "id-1", channel: "email", error: "Auth error" }], acknowledged_failure_ids: [] };

  const reconciled = reconcilePendingFailures(localStatus, ciStatus);
  assert.equal(reconciled.length, 0);
});

test("cenario: repetição da mesma falha incrementa count sem crescer indefinidamente", () => {
  const prior = [{ id: "id-1", channel: "email", error: "Auth error", count: 5 }];
  const newFailures = [{ channel: "email", error: "Auth error" }];
  const merged = mergePendingFailures(prior, newFailures, NOW.toISOString());
  assert.equal(merged.length, 1);
  assert.equal(merged[0].count, 6);
  assert.equal(merged[0].id, "id-1");
});

test("cenario: local pending ID A e CI pending ID B com mesmo channel/error", () => {
  const localStatus = {
    pending_failures: [{ id: "A", channel: "email", error: "SMTP error" }]
  };
  const ciStatus = {
    pending_failures: [{ id: "B", channel: "email", error: "SMTP error" }]
  };
  const reconciled = reconcilePendingFailures(localStatus, ciStatus);
  assert.equal(reconciled.length, 2);
  assert.ok(reconciled.some(f => f.id === "A"));
  assert.ok(reconciled.some(f => f.id === "B"));
});

test("cenario: somente B reconhecido: B some e A permanece", () => {
  const localStatus = {
    pending_failures: [{ id: "A", channel: "email", error: "SMTP error" }],
    acknowledged_failure_ids: ["B"]
  };
  const ciStatus = {
    pending_failures: [{ id: "B", channel: "email", error: "SMTP error" }]
  };
  const reconciled = reconcilePendingFailures(localStatus, ciStatus);
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].id, "A");
});

test("cenario: ambos reconhecidos: ambos somem", () => {
  const localStatus = {
    pending_failures: [{ id: "A", channel: "email", error: "SMTP error" }],
    acknowledged_failure_ids: ["A", "B"]
  };
  const ciStatus = {
    pending_failures: [{ id: "B", channel: "email", error: "SMTP error" }]
  };
  const reconciled = reconcilePendingFailures(localStatus, ciStatus);
  assert.equal(reconciled.length, 0);
});

test("cenario: entrada legada produz o mesmo ID em duas chamadas", () => {
  const legacyStatus1 = {
    generated_at: "2026-06-26T10:00:00.000Z",
    source: "local",
    email: "failed",
    email_error: "Auth error"
  };
  const legacyStatus2 = {
    generated_at: "2026-06-26T10:00:00.000Z",
    source: "local",
    email: "failed",
    email_error: "Auth error"
  };
  const reconciled1 = reconcilePendingFailures(legacyStatus1, null);
  const reconciled2 = reconcilePendingFailures(legacyStatus2, null);
  assert.equal(reconciled1.length, 1);
  assert.equal(reconciled2.length, 1);
  assert.equal(reconciled1[0].id, reconciled2[0].id);
});

// ── Fingerprint ────────────────────────────────────────────────────────────────

test("fingerprint: mesmo canal + mesmo erro produz mesmo fingerprint", () => {
  const fp1 = generateFailureFingerprint("email", "SMTP authentication failed");
  const fp2 = generateFailureFingerprint("email", "SMTP authentication failed");
  assert.equal(fp1, fp2);
});

test("fingerprint: canal diferente + mesmo erro produz fingerprint diferente", () => {
  const fpEmail = generateFailureFingerprint("email", "Auth error");
  const fpWA = generateFailureFingerprint("whatsapp", "Auth error");
  assert.notEqual(fpEmail, fpWA);
});

test("fingerprint: secrets com valores diferentes mas sanitização equivalente produz mesmo fingerprint e não expõe segredos", () => {
  const fp1 = generateFailureFingerprint("email", "apikey=SECRET_A");
  const fp2 = generateFailureFingerprint("email", "apikey=SECRET_B");
  // Após sanitização, ambos ficam "apikey=[redacted]" → mesmo fingerprint
  assert.equal(fp1, fp2);
  // O fingerprint em si não contém os valores secretos
  assert.doesNotMatch(fp1, /SECRET_A|SECRET_B/);
});

test("fingerprint: não muda entre chamadas (determinístico)", () => {
  const fp1 = generateFailureFingerprint("whatsapp", "Timeout error");
  const fp2 = generateFailureFingerprint("whatsapp", "Timeout error");
  const fp3 = generateFailureFingerprint("whatsapp", "Timeout error");
  assert.equal(fp1, fp2);
  assert.equal(fp2, fp3);
});

test("fingerprint: começa com prefixo fp- e tem comprimento fixo", () => {
  const fp = generateFailureFingerprint("email", "some error");
  assert.match(fp, /^fp-[0-9a-f]{24}$/);
});

// ── Episódios com fingerprint ──────────────────────────────────────────────────

test("falha nova recebe UUID e fingerprint", () => {
  const merged = mergePendingFailures([], [{ channel: "email", error: "SMTP error" }], NOW.toISOString());
  assert.equal(merged.length, 1);
  assert.ok(merged[0].id, "deve ter id");
  assert.match(merged[0].id, /^[0-9a-f-]{36}$/); // UUID
  assert.ok(merged[0].fingerprint, "deve ter fingerprint");
  assert.match(merged[0].fingerprint, /^fp-/);
});

test("repetição pendente mantém UUID, fingerprint e incrementa count", () => {
  const prior = [{ id: "ep-uuid", channel: "email", error: "SMTP error", count: 1 }];
  const merged = mergePendingFailures(prior, [{ channel: "email", error: "SMTP error" }], NOW.toISOString());
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "ep-uuid");
  assert.equal(merged[0].count, 2);
  assert.match(merged[0].fingerprint, /^fp-/);
});

test("falha reconhecida + removida: nova falha igual recebe novo UUID, mesmo fingerprint, count 1", () => {
  // Episódio original
  const prior = [{ id: "ep-old", channel: "email", error: "SMTP error", count: 3 }];
  const fpOld = generateFailureFingerprint("email", "SMTP error");

  // Ack remove o episódio
  const acked = prior.filter(f => f.id !== "ep-old");
  assert.equal(acked.length, 0);

  // Nova falha do mesmo tipo
  const merged = mergePendingFailures(acked, [{ channel: "email", error: "SMTP error" }], NOW.toISOString());
  assert.equal(merged.length, 1);
  assert.notEqual(merged[0].id, "ep-old"); // novo UUID
  assert.equal(merged[0].fingerprint, fpOld); // mesmo fingerprint
  assert.equal(merged[0].count, 1); // reinicia
});

// ── Local e CI com fingerprint ─────────────────────────────────────────────────

test("local ID A e CI ID B, mesmo channel/error: dois registros, mesmo fingerprint", () => {
  const local = { pending_failures: [{ id: "A", channel: "email", error: "SMTP error" }] };
  const ci = { pending_failures: [{ id: "B", channel: "email", error: "SMTP error" }] };
  const reconciled = reconcilePendingFailures(local, ci);
  assert.equal(reconciled.length, 2);
  const fpA = reconciled.find(f => f.id === "A").fingerprint;
  const fpB = reconciled.find(f => f.id === "B").fingerprint;
  assert.equal(fpA, fpB);
  assert.match(fpA, /^fp-/);
});

test("somente B acknowledged: B some, A permanece (fingerprint iguais não se eliminam)", () => {
  const local = {
    pending_failures: [{ id: "A", channel: "email", error: "SMTP error" }],
    acknowledged_failure_ids: ["B"]
  };
  const ci = {
    pending_failures: [{ id: "B", channel: "email", error: "SMTP error" }]
  };
  const reconciled = reconcilePendingFailures(local, ci);
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].id, "A");
});

test("ambos acknowledged: nenhum permanece mesmo que fingerprint seja o mesmo", () => {
  const local = {
    pending_failures: [{ id: "A", channel: "email", error: "SMTP error" }],
    acknowledged_failure_ids: ["A", "B"]
  };
  const ci = {
    pending_failures: [{ id: "B", channel: "email", error: "SMTP error" }]
  };
  const reconciled = reconcilePendingFailures(local, ci);
  assert.equal(reconciled.length, 0);
});

// ── Compatibilidade ────────────────────────────────────────────────────────────

test("registro antigo sem fingerprint recebe fingerprint ao ser normalizado", () => {
  const prior = [{ id: "old-id", channel: "email", error: "Old error" }];
  const merged = mergePendingFailures(prior, [], NOW.toISOString());
  assert.ok(merged[0].fingerprint, "deve receber fingerprint");
  assert.match(merged[0].fingerprint, /^fp-/);
});

test("registro legado ganha fingerprint via reconcile", () => {
  const legacyStatus = {
    generated_at: "2026-06-26T10:00:00.000Z",
    source: "local",
    email: "failed",
    email_error: "Auth error"
  };
  const reconciled = reconcilePendingFailures(legacyStatus, null);
  assert.equal(reconciled.length, 1);
  assert.ok(reconciled[0].fingerprint, "deve ter fingerprint");
  assert.match(reconciled[0].fingerprint, /^fp-/);
  // ID legado é determinístico (hash sha256 sem prefixo)
  assert.doesNotMatch(reconciled[0].id, /^fp-/);
});

// ── Semântica dos acknowledgements ────────────────────────────────────────────

test("prior ID A + incoming ID B, mesmo canal/erro → dois registros distintos", () => {
  const prior = [{ id: "A", channel: "email", error: "SMTP error", count: 1 }];
  const incoming = [{ id: "B", channel: "email", error: "SMTP error" }];
  const merged = mergePendingFailures(prior, incoming, NOW.toISOString());
  assert.equal(merged.length, 2);
  assert.ok(merged.some(f => f.id === "A"));
  assert.ok(merged.some(f => f.id === "B"));
});

test("prior ID A + incoming sem ID, mesmo canal/erro → um registro, ID A preservado e count incrementado", () => {
  const prior = [{ id: "A", channel: "email", error: "SMTP error", count: 1 }];
  const incoming = [{ channel: "email", error: "SMTP error" }];
  const merged = mergePendingFailures(prior, incoming, NOW.toISOString());
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "A");
  assert.equal(merged[0].count, 2);
});

test("acknowledged_failure_ids contém apenas UUIDs/IDs de episódios, nunca fingerprints", () => {
  const priorFailure = { id: "ep-uuid-123", channel: "email", error: "SMTP error", count: 1 };
  const fp = generateFailureFingerprint(priorFailure.channel, priorFailure.error);
  priorFailure.fingerprint = fp;

  // Simula: falha foi notificada e acked
  const ackedIds = [priorFailure.id];
  const status = buildDeliveryStatus({
    now: NOW,
    sendingEmail: true,
    email: { ok: true },
    whatsapp: { ok: true },
    pendingFailures: [],
    acknowledgedFailureIds: ackedIds
  });

  assert.ok(status.acknowledged_failure_ids.includes(priorFailure.id));
  assert.ok(!status.acknowledged_failure_ids.includes(priorFailure.fingerprint));
});
