// Watchlist da garrafa Lifefactory (OLX + Enjoei): 500ml a 1L, R$ 25–75.
// A lógica de coleta/merge/relatório vive em lib/watchlist-monitor.mjs.
import path from "node:path";
import { runWatchlistMonitor } from "./lib/watchlist-monitor.mjs";

const dataDir =
  process.env.LIFEFACTORY_DATA_DIR ??
  path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".codex", "automations", "monitor-lifefactory");

runWatchlistMonitor({
  label: "Lifefactory",
  dataDir,
  profileDir: ".chrome-lifefactory-profile",
  terms: ["lifefactory"],
  minPrice: 25,
  maxPrice: 75,
  minSizeMl: 500,
  maxSizeMl: 1000,
}).catch((error) => {
  console.error(`\nFalha: ${error.stack || error.message}`);
  process.exitCode = 1;
});
