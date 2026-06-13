/**
 * Generic snapshot merge — no I/O, no side-effects.
 *
 * Items present in `collected` become active (first_seen preserved when
 * the item was already in the previous snapshot).
 * Items that were in the previous snapshot but absent from `collected`
 * are carried forward with status "not_seen".
 *
 * `failedKeys` (Set of item keys): itens cuja fonte/termo FALHOU nesta rodada.
 * Como a ausência pode ser só uma falha de coleta (não desaparecimento real),
 * eles são carregados adiante intactos — sem virar "not_seen" nem mexer no
 * last_seen.
 *
 * Keys are item.id ?? item.url.
 */
export function mergeWithPreviousSnapshot({
  runDate,
  collected,
  previousSnapshot,
  priceMin,
  priceMax,
  failedKeys = new Set(),
}) {
  const previousItems = previousSnapshot?.items ?? [];
  const previousById = new Map(previousItems.map((x) => [x.id ?? x.url, x]));

  const items = [];
  for (const item of collected) {
    const key = item.id ?? item.url;
    const prev = previousById.get(key);
    items.push({
      ...item,
      first_seen: prev?.first_seen ?? runDate,
      last_seen: runDate,
    });
  }

  const currentKeys = new Set(items.map((x) => x.id ?? x.url));
  for (const prev of previousItems) {
    const key = prev.id ?? prev.url;
    if (currentKeys.has(key)) continue;
    if (failedKeys.has(key)) {
      // Cobertura incompleta nesta rodada (a fonte/termo deste item falhou):
      // não sabemos se sumiu, então carregamos adiante sem alterar nada.
      items.push({ ...prev });
    } else {
      // Realmente ausente: marca not_seen, mas PRESERVA o last_seen original
      // (quando foi visto pela última vez de fato), em vez de sobrescrever.
      items.push({
        ...prev,
        status: "not_seen",
        last_seen: prev.last_seen ?? runDate,
      });
    }
  }

  const result = {
    run: { date: runDate, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    items,
  };
  if (priceMin != null && priceMax != null) {
    result.price_range_brl = { min: priceMin, max: priceMax };
  }
  return result;
}
