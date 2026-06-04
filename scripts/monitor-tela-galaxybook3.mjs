// Watchlist da tela BA96-08462A (Galaxy Book3 Ultra) — OLX + Enjoei, até R$ 1.000.
// A lógica de coleta/merge/relatório vive em lib/watchlist-monitor.mjs.
import path from "node:path";
import { runWatchlistMonitor } from "./lib/watchlist-monitor.mjs";

const dataDir =
  process.env.TELA_GALAXYBOOK3_DATA_DIR ??
  path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".codex", "automations", "monitor-tela-galaxybook3");

runWatchlistMonitor({
  label: "Tela Galaxy Book3",
  dataDir,
  profileDir: ".chrome-tela-galaxybook3-profile",
  terms: ["BA96-08462A"],
  minPrice: 0,
  maxPrice: 1000,
}).catch((error) => {
  console.error(`\nFalha: ${error.stack || error.message}`);
  process.exitCode = 1;
});
