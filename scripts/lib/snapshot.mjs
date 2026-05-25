/**
 * Generic snapshot merge — no I/O, no side-effects.
 *
 * Items present in `collected` become active (first_seen preserved when
 * the item was already in the previous snapshot).
 * Items that were in the previous snapshot but absent from `collected`
 * are carried forward with status "not_seen".
 *
 * Keys are item.id ?? item.url.
 */
export function mergeWithPreviousSnapshot({
  runDate,
  collected,
  previousSnapshot,
  priceMin,
  priceMax,
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
    if (!currentKeys.has(key)) {
      items.push({
        ...prev,
        status: "not_seen",
        last_seen: runDate,
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
