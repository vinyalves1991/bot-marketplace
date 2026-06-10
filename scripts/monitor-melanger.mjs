// Watchlist de melanger (moinho de chocolate) — OLX + Enjoei, R$ 1.000–5.000.
// OLX: busca em duas categorias específicas (eletroportáteis e gastronomia).
// Exclui anúncios 220V (queremos 110V). A lógica vive em lib/watchlist-monitor.mjs.
import path from "node:path";
import { runWatchlistMonitor } from "./lib/watchlist-monitor.mjs";

const dataDir =
  process.env.MELANGER_DATA_DIR ??
  path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".codex", "automations", "monitor-melanger");

runWatchlistMonitor({
  label: "Melanger",
  dataDir,
  profileDir: ".chrome-melanger-profile",
  terms: ["melanger"],
  minPrice: 1000,
  maxPrice: 5000,
  // Exclui 220V puro, mas mantém bivolt e qualquer menção a 110V/127V.
  excludeTerms: ["220v", "220 v", "220volts", "220 volts"],
  keepTerms: ["110v", "110 v", "110volts", "110 volts", "127v", "127 v", "bivolt", "bi-volt", "bi volt", "110/220", "110 / 220"],
  olxCategoryUrls: [
    "https://www.olx.com.br/eletro/eletroportateis-para-cozinha-e-limpeza",
    "https://www.olx.com.br/comercio-e-escritorio/gastronomia",
  ],
}).catch((error) => {
  console.error(`\nFalha: ${error.stack || error.message}`);
  process.exitCode = 1;
});
