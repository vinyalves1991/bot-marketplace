/**
 * Shared pure utility functions — no I/O, no side-effects.
 * Imported by monitor scripts and tested directly.
 */

/**
 * Parse a BRL price string.
 * "R$ 3.500,00" → 3500  |  null/empty → null
 */
export function parseBrlPrice(text) {
  const raw = (text ?? "").toString();
  const m = raw.match(/R\$\s*([\d\.]+)(?:,\d{2})?/);
  if (!m) return null;
  const n = Number(m[1].replace(/\./g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract RAM in GB from free-form text.
 * Accepts: "16 GB RAM", "RAM: 8gb", "32GB DDR5", "8 GB de memória".
 * Returns null when not found or value outside [2, 256].
 */
export function extractRamGb(text) {
  const t = (text ?? "").toString();
  const patterns = [
    /\b(\d{1,3})\s*gb\s*(?:de\s*)?(?:ram|mem[oó]ria)\b/i,
    /\b(?:ram|mem[oó]ria)\s*:?\s*(\d{1,3})\s*gb\b/i,
    /\b(\d{1,3})\s*gb\s*ddr\d\b/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const v = Number(m[1]);
      if (Number.isFinite(v) && v >= 2 && v <= 256) return v;
    }
  }
  return null;
}

/**
 * Extract storage capacity in GB from free-form text.
 * Handles TB conversion. Requires SSD/HD/NVMe/M.2 marker to avoid
 * confusing with RAM capacity.
 * Returns null when not found.
 */
export function extractStorageGb(text) {
  const t = (text ?? "").toString().toLowerCase();
  const mTb = t.match(/\b(\d+(?:[\.,]\d+)?)\s*tb\b/);
  if (mTb) {
    const tb = Number(mTb[1].replace(",", "."));
    if (Number.isFinite(tb)) return Math.round(tb * 1024);
  }
  const mGb = t.match(/\b(\d{2,5})\s*(?:gb\s*)?(?:ssd|hd|nvme|m\.2|armazenamento|storage)\b/);
  if (mGb) {
    const gb = Number(mGb[1]);
    if (Number.isFinite(gb) && gb >= 64 && gb <= 8192) return gb;
  }
  const mSsd = t.match(/\bssd\s*(\d{2,5})\s*gb\b/);
  if (mSsd) {
    const gb = Number(mSsd[1]);
    if (Number.isFinite(gb) && gb >= 64 && gb <= 8192) return gb;
  }
  return null;
}

/**
 * Normalise CPU text for comparison:
 * NFD-normalise, strip diacritics, lowercase, remove spaces/hyphens/dots,
 * keep only [a-z0-9].
 */
export function normalizeCpuText(text) {
  return (text ?? "")
    .toString()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[\s\-_.]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Return true if text contains the CPU term as a whole word.
 *
 * Strategy: \b…\b with optional [\s\-]* inserted at every digit↔letter
 * transition inside the term. This means:
 *   • "14650hx" matches "14650 HX" and "14650-HX"  (split at digit→letter)
 *   • "165h"    does NOT match "165hz"              (\b fails: h→z word char)
 *   • "7945hx"  does NOT match "7945HX3D"           (\b fails: x→3 word char)
 *
 * Special-cases "ai7350" (multi-word brand + model).
 */
export function textContainsCpuTerm(text, cpuTerm) {
  const raw = (text ?? "").toString();

  if (cpuTerm === "ai7350") {
    const n = normalizeCpuText(raw);
    return (
      n.includes("ryzenai7350") ||
      n.includes("ai7350") ||
      (n.includes("ryzenai") && n.includes("350"))
    );
  }

  // Escape special regex chars (CPU terms are alphanumeric, but keep it safe).
  const escaped = cpuTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Insert flexible separator at digit↔letter transitions within the term.
  const pattern = escaped
    .replace(/([0-9])([a-zA-Z])/g, "$1[\\s\\-]*$2")
    .replace(/([a-zA-Z])([0-9])/g, "$1[\\s\\-]*$2");
  return new RegExp(`\\b${pattern}\\b`, "i").test(raw);
}

/**
 * Return true if item.ram_gb ≥ 32 or title mentions "32 GB"/"32GB".
 */
export function has32GbRam(item) {
  if (item.ram_gb != null && item.ram_gb >= 32) return true;
  return /\b32\s*gb\b/i.test(item.title ?? "");
}

/**
 * Return true if the URL belongs to OLX's notebooks category.
 */
export function isNotebookCategoryUrl(url) {
  try {
    return /\/informatica\/notebooks\//i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * Extract OLX numeric ad ID from a URL (≥ 8 digits before end/query).
 * Returns null if not found.
 */
export function extractOlxId(url) {
  const m = (url ?? "").toString().match(/(\d{8,})\/?(?:\?|$)/);
  return m ? m[1] : null;
}

/**
 * Normalise text for loose comparison: NFD, strip diacritics, lowercase.
 */
export function normalizeText(text) {
  return (text ?? "")
    .toString()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}
