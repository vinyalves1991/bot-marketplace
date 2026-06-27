import crypto from "node:crypto";

// Estado de entrega das notificações (e-mail/WhatsApp), persistido entre rodadas
// para que uma rodada seguinte bem-sucedida possa mencionar a falha da anterior.
// Tudo aqui é função PURA (sem rede/I/O) para ser testável.

// Remove segredos (telefone, apikey, token, etc.) e querystrings de URLs de mensagens de erro
// antes de gravá-las em disco (o repositório é público).
export function sanitizeErrorMessage(message) {
  let out = String(message ?? "").trim();

  // 1. Redige Bearer token credentials
  out = out.replace(/bearer\s+[a-zA-Z0-9\-._~+/]+=*/gi, "Bearer [redacted]");

  // 2. Redige querystring inteira de qualquer URL (tudo após ?)
  out = out.replace(/(https?:\/\/[^\s"'?]+)\?[^\s"']*/gi, "$1?[redacted]");

  // 3. Redige chaves sensíveis: apikey, api_key, token, password, secret, authorization, phone
  const keysToRedact = ["apikey", "api_key", "token", "password", "secret", "authorization", "phone"];
  for (const key of keysToRedact) {
    // 3a. Authorization com Bearer/Basic: "Authorization: Basic abcdef"
    const reAuth = new RegExp(`(${key})\\s*[:=]\\s*(bearer|basic)\\s+[^\\s&,;"]+`, "gi");
    out = out.replace(reAuth, "$1=[redacted]");

    // 3b. Valores entre aspas duplas: password: "valor com espaços"
    const reDoubleQuote = new RegExp(`(${key})\\s*[:=]\\s*"[^"]*"`, "gi");
    out = out.replace(reDoubleQuote, "$1=[redacted]");

    // 3c. Valores entre aspas simples: token='segredo'
    const reSingleQuote = new RegExp(`(${key})\\s*[:=]\\s*'[^']*'`, "gi");
    out = out.replace(reSingleQuote, "$1=[redacted]");

    // 3d. Valores comuns sem aspas: api_key: secret123
    const reUnquoted = new RegExp(`(${key})\\s*[:=]\\s*[^\\s&,;"]+`, "gi");
    out = out.replace(reUnquoted, "$1=[redacted]");
  }

  // 4. Limita o tamanho máximo do erro armazenado
  if (out.length > 1000) {
    out = out.slice(0, 999) + "…";
  }

  return out;
}

// Fingerprint determinístico de uma falha: depende apenas de canal + erro sanitizado.
// Serve para agrupamento visual e deduplicação dentro de uma mesma fila pendente.
// NUNCA armazenar em acknowledged_failure_ids — acknowledgements usam id/UUID por episódio.
export function generateFailureFingerprint(channel, error) {
  const sanitized = sanitizeErrorMessage(error || "unknown");
  const hash = crypto
    .createHash("sha256")
    .update(`${channel || ""}\0${sanitized}`)
    .digest("hex");
  return `fp-${hash.slice(0, 24)}`;
}

// Auxiliar para gerar ID determinístico para status legados
export function generateLegacyId(source, channel, generatedAt, error) {
  const cleanErr = sanitizeErrorMessage(error || "failed");
  const input = `${source || "unknown"}:${channel || ""}:${generatedAt || ""}:${cleanErr}`;
  return crypto.createHash("sha256").update(input).digest("hex");
}

// Normaliza um registro de falha garantindo presença de fingerprint.
function normalizeFailure(f, nowIso) {
  const channel = f.channel || "";
  const error = f.error || "unknown";
  return {
    id: f.id || crypto.randomUUID(),
    fingerprint: f.fingerprint || generateFailureFingerprint(channel, error),
    channel,
    first_seen_at: f.first_seen_at || f.at || nowIso,
    last_seen_at: f.last_seen_at || f.at || nowIso,
    error,
    count: f.count || 1
  };
}

// Junta falhas anteriores com as novas.
// Deduplicação por episódio: usa id quando disponível, senão fingerprint (mesma sessão pendente).
// Acknowledgements continuam operando exclusivamente por id.
export function mergePendingFailures(priorPending = [], newFailures = [], nowIso = new Date().toISOString(), maxPending = 20) {
  const merged = priorPending.map(f => normalizeFailure(f, nowIso));

  for (const nf of newFailures) {
    if (!nf || !nf.channel) continue;
    const fp = generateFailureFingerprint(nf.channel, nf.error || "unknown");

    const existing = nf.id
      ? merged.find(f => f.id === nf.id)
      : merged.find(f => f.fingerprint === fp);

    if (existing) {
      existing.last_seen_at = nf.last_seen_at || nf.at || nowIso;
      existing.count += 1;
    } else {
      merged.push({
        id: nf.id || crypto.randomUUID(),
        fingerprint: fp,
        channel: nf.channel,
        first_seen_at: nf.first_seen_at || nf.at || nowIso,
        last_seen_at: nf.last_seen_at || nf.at || nowIso,
        error: nf.error || "unknown",
        count: nf.count || 1
      });
    }
  }

  merged.sort((a, b) => Date.parse(a.last_seen_at) - Date.parse(b.last_seen_at));

  if (merged.length > maxPending) {
    return merged.slice(merged.length - maxPending);
  }
  return merged;
}

// Auxiliar para converter status legado para formato de fila de pendências
function convertLegacyStatusToPending(status, defaultSource) {
  const pending = [];
  const source = status.source || defaultSource;
  const genAt = status.generated_at || "";

  if (status.email === "failed") {
    const error = status.email_error || "failed";
    pending.push({
      id: generateLegacyId(source, "email", genAt, error),
      fingerprint: generateFailureFingerprint("email", error),
      channel: "email",
      first_seen_at: genAt,
      last_seen_at: genAt,
      error: sanitizeErrorMessage(error),
      count: 1
    });
  }
  if (status.whatsapp === "failed") {
    const error = status.whatsapp_error || "failed";
    pending.push({
      id: generateLegacyId(source, "whatsapp", genAt, error),
      fingerprint: generateFailureFingerprint("whatsapp", error),
      channel: "whatsapp",
      first_seen_at: genAt,
      last_seen_at: genAt,
      error: sanitizeErrorMessage(error),
      count: 1
    });
  }
  return pending;
}

// Junta acks removendo duplicatas e limitando ao maxAcks
export function mergeAcks(localAcks = [], ciAcks = [], maxAcks = 100) {
  const merged = Array.from(new Set([...localAcks, ...ciAcks]));
  if (merged.length > maxAcks) {
    return merged.slice(merged.length - maxAcks);
  }
  return merged;
}

// Reconcilia as filas de pendência dos status local e CI.
// Filtragem por id apenas — fingerprint não é usado para acknowledgement.
// Registros sem fingerprint são normalizados durante a fusão.
export function reconcilePendingFailures(localStatus, ciStatus) {
  const localPending = localStatus?.pending_failures || (localStatus && !localStatus.pending_failures ? convertLegacyStatusToPending(localStatus, "local") : []);
  const ciPending = ciStatus?.pending_failures || (ciStatus && !ciStatus.pending_failures ? convertLegacyStatusToPending(ciStatus, "ci") : []);

  const nowIso = new Date().toISOString();
  const mergedPending = [];
  const allPending = [...localPending, ...ciPending];
  for (const f of allPending) {
    if (!f || !f.channel) continue;
    const norm = normalizeFailure(f, nowIso);
    // Dedup por id (mesmo episódio vindo dos dois arquivos)
    const existing = mergedPending.find(x => x.id === norm.id);
    if (existing) {
      existing.fingerprint = existing.fingerprint || norm.fingerprint;
      existing.first_seen_at = new Date(Math.min(Date.parse(existing.first_seen_at), Date.parse(norm.first_seen_at))).toISOString();
      existing.last_seen_at = new Date(Math.max(Date.parse(existing.last_seen_at), Date.parse(norm.last_seen_at))).toISOString();
      existing.count = Math.max(existing.count, norm.count);
    } else {
      mergedPending.push(norm);
    }
  }

  // Merge acknowledged lists (apenas ids de episódios, nunca fingerprints)
  const localAcks = localStatus?.acknowledged_failure_ids || [];
  const ciAcks = ciStatus?.acknowledged_failure_ids || [];
  const allAcks = mergeAcks(localAcks, ciAcks);

  return mergedPending.filter(f => !allAcks.includes(f.id));
}

// Constrói o registro de entrega desta rodada.
export function buildDeliveryStatus({ now = new Date(), sendingEmail, email, whatsapp, pendingFailures = [], acknowledgedFailureIds = [], source } = {}) {
  const status = {
    generated_at: now.toISOString(),
    source: source || (process.env.GITHUB_ACTIONS === "true" ? "ci" : "local")
  };

  const delivery = {};

  if (!sendingEmail) {
    delivery.email = "skipped";
  } else if (email?.ok) {
    delivery.email = "sent";
  } else {
    delivery.email = "failed";
    if (email?.error) delivery.email_error = sanitizeErrorMessage(email.error);
  }

  if (whatsapp?.ok) {
    delivery.whatsapp = "sent";
  } else {
    delivery.whatsapp = "failed";
    if (whatsapp?.error) delivery.whatsapp_error = sanitizeErrorMessage(whatsapp.error);
  }

  status.delivery = delivery;
  status.pending_failures = pendingFailures;
  status.acknowledged_failure_ids = acknowledgedFailureIds;

  // Flattened for backward compatibility
  status.email = delivery.email;
  if (delivery.email_error) status.email_error = delivery.email_error;
  status.whatsapp = delivery.whatsapp;
  if (delivery.whatsapp_error) status.whatsapp_error = delivery.whatsapp_error;

  return status;
}

// Nota a incluir na PRÓXIMA notificação quando a rodada anterior falhou em algum
// canal. Retorna string curta ou null (quando não houve falha anterior).
export function buildPriorFailureNote(input) {
  if (!input) return null;
  let pending = [];
  if (Array.isArray(input)) {
    pending = input;
  } else if (input.pending_failures) {
    pending = input.pending_failures;
  } else {
    // Old status format backward compatibility
    const source = input.source || "unknown";
    const genAt = input.generated_at || "";
    if (input.email === "failed") {
      const error = input.email_error || "failed";
      pending.push({ id: generateLegacyId(source, "email", genAt, error), channel: "email", first_seen_at: genAt, last_seen_at: genAt });
    }
    if (input.whatsapp === "failed") {
      const error = input.whatsapp_error || "failed";
      pending.push({ id: generateLegacyId(source, "whatsapp", genAt, error), channel: "whatsapp", first_seen_at: genAt, last_seen_at: genAt });
    }
  }

  if (pending.length === 0) return null;

  const emailEpisodes = pending.filter(f => f.channel === "email");
  const whatsappEpisodes = pending.filter(f => f.channel === "whatsapp");

  const parts = [];
  if (emailEpisodes.length > 0) {
    parts.push(emailEpisodes.length > 1 ? `e-mail (${emailEpisodes.length} episódios)` : "e-mail");
  }
  if (whatsappEpisodes.length > 0) {
    parts.push(whatsappEpisodes.length > 1 ? `WhatsApp (${whatsappEpisodes.length} episódios)` : "WhatsApp");
  }

  return `⚠️ Falhas anteriores de notificação: ${parts.join(" e ")}.`;
}
