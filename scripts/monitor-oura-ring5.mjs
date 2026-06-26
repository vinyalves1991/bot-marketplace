// Watchlist da Oura Ring 5 — OLX + Enjoei. Preço CONDICIONAL à cor + tamanho 9–11.
//   Silver / Black                               → R$ 1.800–2.200
//   Stealth / Brushed Silver / Gold / Deep Rose  → R$ 1.850–2.700
//   Cor não identificada                         → união R$ 1.800–2.700 (mostra; você avalia)
//   Tamanho: se o título declarar (tamanho/size/aro N), exige 9–11; senão mantém.
import path from "node:path";
import { runWatchlistMonitor } from "./lib/watchlist-monitor.mjs";

const dataDir =
  process.env.OURA_RING5_DATA_DIR ??
  path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".codex", "automations", "monitor-oura-ring5");

const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const normCode = (s) => norm(s).replace(/[^a-z0-9]/g, "");

// Só Gen 5: exclui itens cujo título indica geração 1–4 explícita (gen3, ring4,
// geração 4, etc.). Itens sem geração no título são MANTIDOS (podem ser gen 5; o
// usuário avalia). "ring 5"/"gen 5" passam normalmente.
function isOlderGen(title) {
  return /(?:ring|gen|geracao)([1-4])(?![0-9])/.test(normCode(title));
}

// Premium (faixa 1850–2700). "Brushed Silver" é premium e pode vir em qualquer
// ordem ("silver brushed"), então é detectado por conter ambos os termos.
const PREMIUM = ["stealth", "gold", "dourado", "deep rose", "rose", "rosa"];
const STANDARD = ["silver", "prata", "black", "preto", "preta"];

function ouraRange(title) {
  const t = norm(title);
  const brushedSilver = t.includes("brushed") && t.includes("silver");
  if (brushedSilver || PREMIUM.some((c) => t.includes(c))) return [1850, 2700];
  if (STANDARD.some((c) => t.includes(c))) return [1800, 2200];
  return [1800, 2700]; // cor indeterminada → união das faixas
}

// Tamanho do anel: só filtra se o título declarar explicitamente
// (tamanho/size/aro/tam/nº N). Sem declaração → mantém (mostra e você avalia).
function ringSizeOk(title) {
  const m = norm(title).match(/\b(?:tamanho|size|aro|tam\.?|n[º°o]\.?)\s*0?(\d{1,2})\b/);
  if (!m) return true;
  const sz = Number(m[1]);
  return sz >= 9 && sz <= 11;
}

runWatchlistMonitor({
  label: "Oura Ring 5",
  dataDir,
  profileDir: ".chrome-oura-ring5-profile",
  terms: ["oura ring"],
  minPrice: 1800, // união; a faixa real (por cor) é aplicada no itemFilter abaixo
  maxPrice: 2700,
  itemFilter: ({ title, price_brl }) => {
    if (isOlderGen(title)) return false; // exclui Oura Ring 1–4 explícitos (quer só Gen 5)
    if (!ringSizeOk(title)) return false;
    const [min, max] = ouraRange(title);
    return price_brl != null && price_brl >= min && price_brl <= max;
  },
}).catch((error) => {
  console.error(`\nFalha: ${error.stack || error.message}`);
  process.exitCode = 1;
});
