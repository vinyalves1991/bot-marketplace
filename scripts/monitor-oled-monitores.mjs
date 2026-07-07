// Monitor de monitores OLED (OLX com entrega + Enjoei) até R$ 3.000.
import path from "node:path";
import { runWatchlistMonitor } from "./lib/watchlist-monitor.mjs";

const dataDir =
  process.env.OLED_MONITORES_DATA_DIR ??
  path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".codex", "automations", "monitor-oled-monitores");

runWatchlistMonitor({
  label: "Monitores OLED",
  dataDir,
  profileDir: ".chrome-oled-monitores-profile",
  terms: [
    // Alienware
    "aw2726dm",
    "aw2725d",
    "aw2725df",
    "aw3225qf",
    "aw3423dw",
    "aw3423dwf",
    "aw3425dw",
    // Samsung Odyssey OLED
    "odyssey g6 oled",
    "ls32dg800",      // Odyssey G8 OLED (modelo LS32DG800*)
    "odyssey g9 oled",
    // Pichau
    "cepheus p1",
    // MSI
    "mag 271qp",
    "mag 274qp",
    "mpg 491cqp",
    // LG
    "27gx790a",
    "27gx704a",
    // Asus
    "xg27acdng",
  ],
  minPrice: 1500,
  maxPrice: 3000,
  olxDeliveryOnly: true,
}).catch((error) => {
  console.error(`\nFalha: ${error.stack || error.message}`);
  process.exitCode = 1;
});
