// Estado de entrega das notificações (e-mail/WhatsApp), persistido entre rodadas
// para que uma rodada seguinte bem-sucedida possa mencionar a falha da anterior.
// Tudo aqui é função PURA (sem rede/I/O) para ser testável.

// Remove segredos (telefone, apikey) e querystrings de URLs de mensagens de erro
// antes de gravá-las em disco (o repositório é público).
export function sanitizeErrorMessage(message) {
  let out = String(message ?? "").trim();
  // Querystring inteira de qualquer URL pode conter phone/apikey → redige.
  out = out.replace(/(https?:\/\/[^\s?]+)\?[^\s]*/gi, "$1?[redacted]");
  out = out.replace(/apikey=[^&\s]+/gi, "apikey=[redacted]");
  out = out.replace(/phone=[^&\s]+/gi, "phone=[redacted]");
  return out;
}

// Constrói o registro de entrega desta rodada.
//   sendingEmail: se o e-mail era para ser enviado nesta rodada;
//   email/whatsapp: { ok: boolean, error?: string }.
// Resultado: { generated_at, email: sent|skipped|failed, whatsapp: sent|failed, *_error? }.
export function buildDeliveryStatus({ now = new Date(), sendingEmail, email, whatsapp } = {}) {
  const status = { generated_at: now.toISOString() };

  if (!sendingEmail) {
    status.email = "skipped";
  } else if (email?.ok) {
    status.email = "sent";
  } else {
    status.email = "failed";
    if (email?.error) status.email_error = sanitizeErrorMessage(email.error);
  }

  if (whatsapp?.ok) {
    status.whatsapp = "sent";
  } else {
    status.whatsapp = "failed";
    if (whatsapp?.error) status.whatsapp_error = sanitizeErrorMessage(whatsapp.error);
  }

  return status;
}

// Nota a incluir na PRÓXIMA notificação quando a rodada anterior falhou em algum
// canal. Retorna string curta ou null (quando não houve falha anterior).
export function buildPriorFailureNote(previousStatus) {
  if (!previousStatus) return null;
  const failed = [];
  if (previousStatus.email === "failed") failed.push("e-mail");
  if (previousStatus.whatsapp === "failed") failed.push("WhatsApp");
  if (!failed.length) return null;
  const when = previousStatus.generated_at ? ` (${previousStatus.generated_at})` : "";
  return `⚠️ Rodada anterior${when}: falha ao notificar por ${failed.join(" e ")}.`;
}
