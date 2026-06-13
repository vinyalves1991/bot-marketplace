// Watchlist do fone Galaxy Buds4 Pro — OLX + Enjoei, R$ 500–1.000.
// IMPORTANTE: só o modelo PRO interessa. O termo "galaxy buds4 pro" casa por
// normalização sem separadores ("galaxybuds4pro"): o modelo comum "Galaxy Buds4"
// vira "galaxybuds4" e NÃO contém "galaxybuds4pro", então fica de fora.
import path from "node:path";
import { runWatchlistMonitor } from "./lib/watchlist-monitor.mjs";

const dataDir =
  process.env.GALAXY_BUDS4_PRO_DATA_DIR ??
  path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".codex", "automations", "monitor-galaxy-buds4-pro");

runWatchlistMonitor({
  label: "Galaxy Buds4 Pro",
  dataDir,
  profileDir: ".chrome-galaxy-buds4-pro-profile",
  terms: ["galaxy buds4 pro"],
  minPrice: 500,
  maxPrice: 1000,
}).catch((error) => {
  console.error(`\nFalha: ${error.stack || error.message}`);
  process.exitCode = 1;
});
