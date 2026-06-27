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
    const re = new RegExp(`(${key})\\s*[:=]\\s*[^\\s&,;"]+`, "gi");
    out = out.replace(re, "$1=[redacted]");
  }

  // 4. Limita o tamanho máximo do erro armazenado
  if (out.length > 1000) {
    out = out.slice(0, 999) + "…";
  }

  return out;
}

// Junta falhas anteriores com as novas, removendo duplicadas por (channel, error)
// (mantendo a ocorrência mais recente) e limitando o tamanho da fila.
export function mergePendingFailures(priorPending = [], newFailures = [], maxPending = 20) {
  const map = new Map();
  for (const f of priorPending) {
    if (!f || !f.channel) continue;
    const key = `${f.channel}:${f.error}`;
    map.set(key, f);
  }
  for (const f of newFailures) {
    if (!f || !f.channel) continue;
    const key = `${f.channel}:${f.error}`;
    map.set(key, f);
  }
  let merged = Array.from(map.values());
  merged.sort((a, b) => {
    const tA = a.at ? Date.parse(a.at) : 0;
    const tB = b.at ? Date.parse(b.at) : 0;
    return tA - tB;
  });
  if (merged.length > maxPending) {
    merged = merged.slice(merged.length - maxPending);
  }
  return merged;
}

// Auxiliar para converter status legado para formato de fila de pendências
function convertLegacyStatusToPending(status) {
  const pending = [];
  if (status.email === "failed") {
    pending.push({
      channel: "email",
      at: status.generated_at,
      error: status.email_error || "failed"
    });
  }
  if (status.whatsapp === "failed") {
    pending.push({
      channel: "whatsapp",
      at: status.generated_at,
      error: status.whatsapp_error || "failed"
    });
  }
  return pending;
}

// Reconcilia as filas de pendência dos status local e CI.
// Remove pendências que tenham ocorrido em data anterior ou igual à última notificação bem-sucedida de qualquer canal.
export function reconcilePendingFailures(localStatus, ciStatus) {
  const localPending = localStatus?.pending_failures || (localStatus && !localStatus.pending_failures ? convertLegacyStatusToPending(localStatus) : []);
  const ciPending = ciStatus?.pending_failures || (ciStatus && !ciStatus.pending_failures ? convertLegacyStatusToPending(ciStatus) : []);

  const merged = mergePendingFailures(localPending, ciPending);

  let latestSuccessTime = 0;
  if (localStatus) {
    const isSent = localStatus.delivery
      ? (localStatus.delivery.email === "sent" || localStatus.delivery.whatsapp === "sent")
      : (localStatus.email === "sent" || localStatus.whatsapp === "sent");
    if (isSent) {
      const t = Date.parse(localStatus.generated_at);
      if (!isNaN(t)) latestSuccessTime = Math.max(latestSuccessTime, t);
    }
  }
  if (ciStatus) {
    const isSent = ciStatus.delivery
      ? (ciStatus.delivery.email === "sent" || ciStatus.delivery.whatsapp === "sent")
      : (ciStatus.email === "sent" || ciStatus.whatsapp === "sent");
    if (isSent) {
      const t = Date.parse(ciStatus.generated_at);
      if (!isNaN(t)) latestSuccessTime = Math.max(latestSuccessTime, t);
    }
  }

  return merged.filter(f => {
    const t = f.at ? Date.parse(f.at) : 0;
    return isNaN(t) || t > latestSuccessTime;
  });
}

// Constrói o registro de entrega desta rodada.
export function buildDeliveryStatus({ now = new Date(), sendingEmail, email, whatsapp, pendingFailures = [], source } = {}) {
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
    if (input.email === "failed") {
      pending.push({ channel: "email", at: input.generated_at });
    }
    if (input.whatsapp === "failed") {
      pending.push({ channel: "whatsapp", at: input.generated_at });
    }
  }

  if (pending.length === 0) return null;

  const failedChannels = [];
  const hasEmail = pending.some(f => f.channel === "email");
  const hasWhatsapp = pending.some(f => f.channel === "whatsapp");

  if (hasEmail) failedChannels.push("e-mail");
  if (hasWhatsapp) failedChannels.push("WhatsApp");

  const whens = Array.from(new Set(pending.map(f => f.at).filter(Boolean)));
  const whenStr = whens.length === 1 ? ` (${whens[0]})` : "";

  return `⚠️ Rodada anterior${whenStr}: falha ao notificar por ${failedChannels.join(" e ")}.`;
}
