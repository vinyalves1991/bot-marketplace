/**
 * Shared pure utility functions — no I/O, no side-effects.
 * Imported by monitor scripts and tested directly.
 */
import { normalizeMonitorText } from "./monitor-core.mjs";

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
    /\b(?:mem[oó]ria\s+ram|ram|mem[oó]ria)\s*[:\r\n-]+\s*(\d{1,3})\s*gb\b/i,
    /\b(\d{1,3})\s*gb\s*ddr\d\b/i,
    // "16gb" sem qualificador é RAM quando há armazenamento SEPARADO depois —
    // seja em GB ("512gb ssd") ou em TB ("1tb ssd"/"1tb"). O disco fica
    // identificado pelo outro token e sobra um valor típico de RAM.
    /\b(4|6|8|12|16|24|32|64|128)\s*gb\b(?=.*(?:\b(?:128|256|512|1024|2048|4096)\s*gb\s*(?:ssd|hd|nvme|m\.2|armazenamento|storage)\b|\b\d+(?:[.,]\d+)?\s*tb\b))/i,
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
  const mGb = t.match(/\b(\d{2,5})\s*(?:gb\s*)?(?:de\s+)?(?:ssd|hd|nvme|m\.2|armazenamento|storage)\b/);
  if (mGb) {
    const gb = Number(mGb[1]);
    if (Number.isFinite(gb) && gb >= 64 && gb <= 8192) return gb;
  }
  const mStorage = t.match(/\b(?:armazenamento|storage|ssd|hd)\s*[:\r\n-]+\s*(\d{2,5})\s*gb\b/);
  if (mStorage) {
    const gb = Number(mStorage[1]);
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
 * Extract a concise GPU label from free-form notebook text.
 * Returns null when there is no useful GPU signal.
 */
export function extractGpuLabel(text) {
  const t = (text ?? "").toString();
  const patterns = [
    /\b(?:nvidia\s+)?(?:geforce\s+)?rtx\s*(\d{4})(?:\s*(ti|super))?\b/i,
    /\b(?:nvidia\s+)?(?:geforce\s+)?gtx\s*(\d{4})(?:\s*(ti|super))?\b/i,
    /\bradeon\s*(?:rx\s*)?(\d{4}[a-z]{0,2})\b/i,
    /\b(?:intel\s+)?arc\s*([a-z]\d{3})\b/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    if (/rtx/i.test(m[0])) return `RTX ${m[1]}${m[2] ? ` ${m[2].toUpperCase()}` : ""}`;
    if (/gtx/i.test(m[0])) return `GTX ${m[1]}${m[2] ? ` ${m[2].toUpperCase()}` : ""}`;
    if (/radeon/i.test(m[0])) return `Radeon ${m[1].toUpperCase()}`;
    return `Arc ${m[1].toUpperCase()}`;
  }

  const normalized = normalizeText(t);
  if (
    /\bintel\s+arc\s+graphics\b/.test(normalized) ||
    /\bintel\s+arc\s+integrada\b/.test(normalized) ||
    /\barc\s+graphics\b/.test(normalized)
  ) {
    return "Intel Arc integrada";
  }
  if (/\biris\s+xe\b/.test(normalized)) {
    return "Iris Xe integrada";
  }
  if (/\buhd\s+graphics\b/.test(normalized)) {
    return "UHD Graphics integrada";
  }
  return null;
}

/**
 * Extract a concise CPU label from free-form notebook text.
 * Mirrors the dashboard's extractCpu so the monitor can persist a CPU
 * label (e.g. from a description) even when the title is uninformative.
 * Returns null when there is no recognisable CPU signal.
 */
export function extractCpuLabel(text) {
  const t = (text ?? "").toString();
  const patterns = [
    /\b(?:intel\s+)?core\s+ultra\s+i?([579])[\s-]*(\d{3})(h|hx)?\b/i,
    /\bultra\s+i?([579])[\s-]*(\d{3})(h|hx)?\b/i,
    /\bryzen\s+ai\s+max\+?\s*(?:pro\s+)?(\d{3})\b/i,
    /\bryzen\s+ai\s+([3579])[\s-]*(\d{3})\b/i,
    /\bai\s*([3579])[\s-]*(\d{3})\b/i,
    /\bai([3579])(\d{3})\b/i,
    /\b(?:intel\s+)?core\s+([3579])[\s-]*(\d{4,5})([a-z]{0,2})\b/i,
    /\b(?:intel\s+)?(?:core\s+)?(i[3579])[\s-]*(\d{4,5})([a-z]{0,2})\b/i,
    /\bryzen\s+(?:ai\s+)?([3579])[\s-]*(\d{4})([a-z]{1,3})\b/i,
    /\bhx\s*(370|470)\b/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    if (/\bai\s+max/i.test(m[0])) return `Ryzen AI Max ${m[1]}`;
    if (/\bhx\s*\d{3}/i.test(m[0])) return `HX ${m[1]}`;
    if (/ultra/i.test(m[0])) return `Ultra ${m[1]} ${m[2]}${(m[3] ?? "h").toUpperCase()}`;
    if (/\b(?:ryzen\s+)?ai/i.test(m[0])) return `Ryzen AI ${m[1]} ${m[2]}`;
    if (/\bcore\s+[3579]\b/i.test(m[0])) return `Core ${m[1]} ${m[2]}${(m[3] ?? "").toUpperCase()}`;
    if (/ryzen/i.test(m[0])) return `Ryzen ${m[1]} ${m[2]}${(m[3] ?? "").toUpperCase()}`;
    return `${m[1].toUpperCase()}-${m[2]}${(m[3] ?? "").toUpperCase()}`;
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
 * Special-cases os AMD "Ryzen AI Max" (aimax395/aimax390), cujo número sozinho
 * é genérico demais — exigem o contexto de marca "AI Max" perto do número.
 */
export function textContainsCpuTerm(text, cpuTerm) {
  const raw = (text ?? "").toString();

  if (cpuTerm === "aimax395" || cpuTerm === "aimax390") {
    const model = cpuTerm.slice(-3); // "395" ou "390"
    const n = normalizeCpuText(raw); // remove espaços/hífens/"+" → ex.: "ryzenaimax395"
    return (
      n.includes(`aimax${model}`) ||
      (n.includes("aimax") && n.includes(model)) ||
      (n.includes("ryzen") && n.includes("max") && n.includes(model))
    );
  }

  // Intel Core Ultra HX (290/285/275 HX e 255 HX): muitos anúncios escrevem só
  // "Ultra 9 285" (sem sufixo) ou "285H". Aceitamos o número do modelo no
  // contexto "Ultra <n>" com sufixo opcional (nenhum/H/HX), exigindo o "Ultra"
  // para não casar números soltos (preço, modelo de chassi etc.). O token
  // compacto "285hx" também casa fora desse contexto.
  if (cpuTerm === "290hx" || cpuTerm === "285hx" || cpuTerm === "275hx" || cpuTerm === "255hx") {
    const model = cpuTerm.slice(0, 3); // "290" | "285" | "275" | "255"
    if (new RegExp(`\\bultra\\s+i?[579][\\s-]*${model}(?:[\\s-]*hx?)?\\b`, "i").test(raw)) return true;
    return new RegExp(`\\b${model}[\\s-]*hx\\b`, "i").test(raw);
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
  return normalizeMonitorText(text);
}
