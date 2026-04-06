#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  FCB BOT V6 — setup.js
//  Interactive CLI setup wizard. Run once before starting the bot.
//  Writes config.json and initialises fcb_cmd.json.
//
//  CONFIG STRUCTURE WRITTEN:
//  {
//    token, paperMode,
//    modeSettings: {
//      paper: { wallet, riskPct, dailyLossLimit, maxTrades,
//               scoreThreshold, stockTier, niftyFilter },
//      live:  { wallet, riskPct, dailyLossLimit, maxTrades,
//               scoreThreshold, stockTier, niftyFilter }
//    },
//    brokeragePerOrder,   // ₹ per order leg (entry=1 leg, exit=1 leg)
//    blockedEvents: [],   // [ { date, from, to, reason } ] — filled manually
//    liveShortAllowlist,  // explicit stock-name allowlist for live SELL entries
//    updatedAt
//  }
//
//  bot.js reads settings via getModeValue() which checks modeSettings[mode]
//  first, then falls back to root-level keys for backwards compatibility.
//  bridge.js ensureModeSettings() also reads this same structure.
// ═══════════════════════════════════════════════════════════════════════════


import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIR      = __dirname;

const CFG_FILE = path.join(DIR, "config.json");
const CMD_FILE = path.join(DIR, "fcb_cmd.json");

// ─── TERMINAL COLOURS ─────────────────────────────────────────────────────────
const G   = s => `\x1b[32m${s}\x1b[0m`;
const Y   = s => `\x1b[33m${s}\x1b[0m`;
const R   = s => `\x1b[31m${s}\x1b[0m`;
const B   = s => `\x1b[36m${s}\x1b[0m`;
const W   = s => `\x1b[1m${s}\x1b[0m`;
const DIM = s => `\x1b[2m${s}\x1b[0m`;
const MAG = s => `\x1b[35m${s}\x1b[0m`;

// ─── READLINE ─────────────────────────────────────────────────────────────────
const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(r => rl.question(q, r));

function bye(code = 0) { try { rl.close(); } catch {} process.exit(code); }
process.on("SIGINT", () => { console.log(Y("\n\n⚠️  Setup interrupted.")); bye(1); });

const div  = () => console.log(DIM("─".repeat(58)));
const div2 = () => console.log(W("═".repeat(58)));
const hdr  = t  => { div(); console.log(W(`  ${t}`)); console.log(); };

// ─── HELPERS ──────────────────────────────────────────────────────────────────
// Ask a numeric question with a default value and min/max bounds.
async function askNum(prompt, def, min, max, round = false) {
  const raw = (await ask(`  ${prompt} [${def}]: `)).trim();
  if (!raw) return def;
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) { console.log(Y(`  ⚠️  Invalid — using ${def}`)); return def; }
  const clamped = Math.max(min, Math.min(max, n));
  return round ? Math.trunc(clamped) : clamped;
}

// Ask a yes/no question, returns boolean.
async function askBool(prompt, def) {
  const label = def ? "Y=default/n" : "y/N=default";
  const raw   = (await ask(`  ${prompt} [${label}]: `)).trim().toLowerCase();
  if (!raw) return def;
  return raw === "y";
}

// Ask for a stockTier value with shorthand support.
async function askTier(def) {
  const raw = (await ask(`  Stock tier [tier1 / tier1+2 / all] [${def}]: `)).trim().toLowerCase();
  if (!raw) return def;
  if (raw === "1")     return "tier1";
  if (raw === "2")     return "tier1+2";
  if (raw === "3")     return "all";
  if (["tier1", "tier1+2", "all"].includes(raw)) return raw;
  console.log(Y(`  ⚠️  Invalid tier — using ${def}`));
  return def;
}

// Collect all 7 mode-specific settings for paper OR live.
async function askModeSettings(label, ex, isSafe) {
  const e = ex || {};
  console.log();
  console.log(isSafe
    ? G(`  Configuring ${label} settings (no real money):`)
    : R(`  Configuring ${label} settings (REAL MONEY — be conservative):`));
  console.log();

  // Wallet
  console.log(DIM("  Wallet — capital allocated to this mode."));
  const walletDefault = e.wallet || (isSafe ? 100000 : 50000);
  const wallet = await askNum("Wallet ₹", walletDefault, 100, 100000000);

  // Risk %
  console.log();
  console.log(DIM(`  Risk % — % of wallet to risk per trade. ${isSafe ? "2% rec. for paper." : "1% rec. for live."}`));
  console.log(DIM(`  At ${(wallet * (isSafe ? 0.02 : 0.01)).toFixed(0)}–₹${(wallet * 0.02).toFixed(0)} risk/trade with ₹${wallet} wallet.`));
  const riskPctDefault = e.riskPct || (isSafe ? 2 : 1);
  const riskPct = await askNum("Risk %", riskPctDefault, 0.1, 10);

  // Daily loss limit
  console.log();
  console.log(DIM("  Daily loss limit — stop trading for the day if total loss hits this."));
  const lossDefault = e.dailyLossLimit || Math.round(wallet * (isSafe ? 0.1 : 0.05));
  const dailyLossLimit = await askNum("Loss limit ₹", lossDefault, 0, wallet);

  // Max trades
  console.log();
  console.log(DIM(`  Max live trades/day. ${isSafe ? "Paper trades don't count toward this." : "Hard cap on real orders."}`));
  const maxDefault = e.maxTrades || (isSafe ? 5 : 3);
  const maxTrades = await askNum("Max trades", maxDefault, 1, 20, true);

  // Score threshold
  console.log();
  console.log(DIM("  Min signal score (out of 10). Higher = fewer but stronger signals."));
  console.log(DIM("  FCB=3 ORB=2 VWAP=2 EMA=2 GAP=2 ST_MACD=3 RSI_DIV=3 BB_SQZ=2 ADX_EMA=3"));
  console.log(DIM("  Bonus: Vol>2×avg=+1 | Nifty aligned=+1 | VIX>20=+1 threshold penalty"));
  const stDefault = e.scoreThreshold || (isSafe ? 6 : 7);
  const scoreThreshold = await askNum("Score threshold 1–10", stDefault, 1, 10, true);

  // Stock tier
  console.log();
  console.log(DIM("  tier1   — ~47 stocks  (Nifty 50 only)"));
  console.log(DIM("  tier1+2 — ~77 stocks  (Nifty 50 + Next 50 select)  ← recommended"));
  console.log(DIM("  all     — ~107 stocks (+ Midcap momentum)"));
  const tierDefault = e.stockTier || (isSafe ? "all" : "tier1+2");
  const stockTier = await askTier(tierDefault);

  // Nifty filter
  console.log();
  console.log(DIM("  Nifty filter: block BUY when Nifty negative, SELL when Nifty positive."));
  console.log(DIM("  Also applies +1 score for aligned trades, -2 for counter-trend."));
  const nfDefault = e.niftyFilter !== false;
  const niftyFilter = await askBool("Enable Nifty direction filter?", nfDefault);

  return { wallet, riskPct, dailyLossLimit, maxTrades, scoreThreshold, stockTier, niftyFilter };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  div2();
  console.log(W("  ⚡ FCB BOT V6 — SETUP WIZARD"));
  console.log(DIM("  9 Strategies · Multi-Confirm Scoring · 3 Stock Tiers"));
  console.log(DIM("  Separate Paper / Live settings · VIX gate · NSE holidays · Macro guard"));
  div2();
  console.log();

  // Load existing config to show current values as defaults
  let ex = {};
  try { ex = JSON.parse(fs.readFileSync(CFG_FILE, "utf8")); }
  catch { /* first run */ }

  const exPaper = ex.modeSettings?.paper || {};
  const exLive  = ex.modeSettings?.live  || {};

  if (Object.keys(ex).length > 0) {
    console.log(Y("  ℹ️  Existing config found. Press Enter to keep current values.\n"));
  }

  // ── STEP 1: ACCESS TOKEN ──────────────────────────────────────────────────
  hdr("STEP 1 — UPSTOX ACCESS TOKEN");
  console.log(DIM("  Get from: upstox.com → Developer → My Apps → Access Token\n"));

  const tokenPrompt = ex.token
    ? `  Token [current: ****${ex.token.slice(-4)}]: `
    : "  Paste access token: ";
  let token = (await ask(tokenPrompt)).trim();
  if (!token && ex.token) { token = ex.token; console.log(G("  ✓ Keeping existing token")); }
  if (!token) { console.log(R("  ❌ Token is required.")); bye(1); }
  if (!token.startsWith("eyJ")) {
    console.log(Y("  ⚠️  Live tokens are JWTs starting with 'eyJ'."));
    const cont = (await ask("  Continue anyway? [y/N]: ")).trim().toLowerCase();
    if (cont !== "y") { console.log(Y("  Setup cancelled.")); bye(1); }
  }

  // ── STEP 2: PAPER MODE (DEFAULT ON STARTUP) ────────────────────────────────
  hdr("STEP 2 — DEFAULT TRADING MODE ON STARTUP");
  console.log(DIM("  This is which mode the bot starts in when you run node bot.js."));
  console.log(DIM("  You can switch mode any time from the UI without re-running setup.\n"));
  console.log(G("    paper — safe test with virtual money (RECOMMENDED)"));
  console.log(R("    live  — real NSE orders with real money\n"));

  const pmDefault = ex.paperMode !== false ? "y" : "n";
  const pmInput   = (await ask(`  Start in paper mode? [${pmDefault.toUpperCase()}=default, y/n]: `)).trim().toLowerCase();
  const wantsLive = pmInput === "n" || (pmInput !== "y" && ex.paperMode === false);
  let paperMode   = true;

  if (wantsLive) {
    console.log();
    console.log(R("  ⚠️  WARNING: LIVE MODE PLACES REAL ORDERS WITH REAL MONEY"));
    console.log(R("  ⚠️  NSE requires a STATIC IP for algo trading (regulation)"));
    console.log();
    const confirm = (await ask("  Type 'LIVE' to confirm: ")).trim();
    if (confirm === "LIVE") {
      paperMode = false;
      console.log(R("  ⚠️  LIVE mode set as default startup mode."));
    } else {
      console.log(Y("  → Falling back to PAPER mode."));
    }
  } else {
    console.log(G("  ✓ Paper mode set as default startup mode."));
  }

  // ── STEP 3: PAPER SETTINGS ────────────────────────────────────────────────
  hdr("STEP 3 — 📋 PAPER MODE SETTINGS");
  console.log(DIM("  These apply when the bot is running in PAPER mode."));
  console.log(DIM("  Use a large wallet here — paper trades have no real risk.\n"));
  const paperSettings = await askModeSettings("PAPER", exPaper, true);

  // ── STEP 4: LIVE SETTINGS ─────────────────────────────────────────────────
  hdr("STEP 4 — ⚠️  LIVE MODE SETTINGS");
  console.log(DIM("  These apply when the bot is running in LIVE mode."));
  console.log(DIM("  Be conservative — lower wallet, lower risk %, fewer trades.\n"));
  const liveSettings = await askModeSettings("LIVE", exLive, false);

  // ── STEP 5: BROKERAGE ────────────────────────────────────────────────────
  hdr("STEP 5 — BROKERAGE PER ORDER LEG");
  console.log(DIM("  ₹ charged per order leg by your broker (flat fee)."));
  console.log(DIM("  Each trade = 1 entry + 1 exit = 2 legs = 2× this amount."));
  console.log(DIM("  Upstox/Zerodha flat fee: ₹20. Set 0 to disable charge tracking.\n"));
  const brokerageDefault = ex.brokeragePerOrder !== undefined ? ex.brokeragePerOrder : 20;
  const brokeragePerOrder = await askNum("Brokerage ₹/leg", brokerageDefault, 0, 100);

  // ── STEP 6: BLOCKED EVENTS ────────────────────────────────────────────────
  hdr("STEP 6 — 📅 MACRO EVENT BLOCKING");
  console.log(DIM("  The bot auto-detects Nifty spikes (>0.4% in 3 min) and blocks"));
  console.log(DIM("  new scans + force-exits losing trades as a macro guard."));
  console.log();
  console.log(DIM("  For KNOWN events (RBI, Budget, US Fed), add them to config.json"));
  console.log(DIM("  manually after setup under 'blockedEvents'. Format:"));
  console.log();
  console.log(B('  "blockedEvents": ['));
  console.log(B('    { "date": "2026-06-06", "from": 555, "to": 930, "reason": "RBI Policy" },'));
  console.log(B('    { "date": "2026-07-23", "reason": "Union Budget" }'));
  console.log(B("  ]"));
  console.log();
  console.log(DIM("  from/to are minOfDay (555=9:15AM, 930=3:30PM)."));
  console.log(DIM("  Omit from/to to block the full session.\n"));
  console.log(DIM("  NSE trading holidays are fetched automatically from Upstox API"));
  console.log(DIM("  and cached in nse_holidays.json — no manual entry needed.\n"));
  console.log(G("  ✓ Spike guard: always ON (no config needed)"));
  console.log(G("  ✓ NSE holidays: auto-fetched on startup"));
  console.log(G("  ✓ VIX gate: always ON (score +1 if VIX>20, +2 if VIX>25)"));
  console.log(DIM("\n  Press Enter to continue..."));
  await ask("");

  // ── BUILD CONFIG ──────────────────────────────────────────────────────────
  // Preserve existing blockedEvents if any — setup doesn't overwrite them.
  const blockedEvents = ex.blockedEvents || [];
  const liveShortAllowlist = Array.isArray(ex.liveShortAllowlist)
    ? ex.liveShortAllowlist.map(s => String(s || "").trim()).filter(Boolean)
    : [];

  const cfg = {
    token,
    paperMode,
    // Root-level mirrors active mode for backwards compat (bot.js getModeValue fallback)
    wallet:         paperMode ? paperSettings.wallet         : liveSettings.wallet,
    riskPct:        paperMode ? paperSettings.riskPct        : liveSettings.riskPct,
    dailyLossLimit: paperMode ? paperSettings.dailyLossLimit : liveSettings.dailyLossLimit,
    maxTrades:      paperMode ? paperSettings.maxTrades      : liveSettings.maxTrades,
    scoreThreshold: paperMode ? paperSettings.scoreThreshold : liveSettings.scoreThreshold,
    stockTier:      paperMode ? paperSettings.stockTier      : liveSettings.stockTier,
    niftyFilter:    paperMode ? paperSettings.niftyFilter    : liveSettings.niftyFilter,
    // Separate mode settings (primary source for bot.js)
    modeSettings: {
      paper: paperSettings,
      live:  liveSettings,
    },
    brokeragePerOrder,
    blockedEvents,
    liveShortAllowlist,
    updatedAt: new Date().toISOString(),
  };

  // ── WRITE CONFIG ──────────────────────────────────────────────────────────
  fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2));
  console.log();
  console.log(G("  ✅ config.json saved."));

  if (!fs.existsSync(CMD_FILE)) {
    fs.writeFileSync(CMD_FILE, JSON.stringify({ cmd: "noop", ts: 0 }, null, 2));
    console.log(G("  ✅ fcb_cmd.json initialised."));
  }

  const TRD_FILE = path.join(DIR, "fcb_trades.json");
  const SIG_FILE = path.join(DIR, "fcb_signals.json");
  if (!fs.existsSync(TRD_FILE)) { fs.writeFileSync(TRD_FILE, "[]"); console.log(G("  ✅ fcb_trades.json initialised.")); }
  if (!fs.existsSync(SIG_FILE)) { fs.writeFileSync(SIG_FILE, "[]"); console.log(G("  ✅ fcb_signals.json initialised.")); }

  // ── SUMMARY ───────────────────────────────────────────────────────────────
  const TC = { "tier1": 47, "tier1+2": 77, "all": 107 };
  const modeTag = s => s >= 8 ? "(high confidence)" : s === 7 ? "(recommended)" : s === 6 ? "(standard)" : "(lenient)";

  console.log();
  div2();
  console.log(W("  ✅ FCB BOT V6 SETUP COMPLETE"));
  div2();
  console.log();
  console.log(`  ${W("Startup mode:")}   ${paperMode ? G("📋 PAPER") : R("⚠️  LIVE")}`);
  console.log();
  console.log(`  ${MAG("── 📋 PAPER SETTINGS ─────────────────────────────────")}`);
  console.log(`  ${W("Wallet:")}         ${B("₹" + paperSettings.wallet.toLocaleString("en-IN"))}`);
  console.log(`  ${W("Risk:")}           ${B(paperSettings.riskPct + "% / trade")} ${DIM("(₹" + (paperSettings.wallet * paperSettings.riskPct / 100).toFixed(0) + " max)")}`);
  console.log(`  ${W("Loss limit:")}     ${B("₹" + paperSettings.dailyLossLimit + " /day")}`);
  console.log(`  ${W("Max trades:")}     ${B(paperSettings.maxTrades + " /day")}`);
  console.log(`  ${W("Score min:")}      ${B(paperSettings.scoreThreshold + "/10")} ${DIM(modeTag(paperSettings.scoreThreshold))}`);
  console.log(`  ${W("Stock tier:")}     ${B(paperSettings.stockTier)} ${DIM("(" + TC[paperSettings.stockTier] + " stocks)")}`);
  console.log(`  ${W("Nifty filter:")}   ${paperSettings.niftyFilter ? G("ON") : Y("OFF")}`);
  console.log();
  console.log(`  ${R("── ⚠️  LIVE SETTINGS ──────────────────────────────────")}`);
  console.log(`  ${W("Wallet:")}         ${B("₹" + liveSettings.wallet.toLocaleString("en-IN"))}`);
  console.log(`  ${W("Risk:")}           ${B(liveSettings.riskPct + "% / trade")} ${DIM("(₹" + (liveSettings.wallet * liveSettings.riskPct / 100).toFixed(0) + " max)")}`);
  console.log(`  ${W("Loss limit:")}     ${B("₹" + liveSettings.dailyLossLimit + " /day")}`);
  console.log(`  ${W("Max trades:")}     ${B(liveSettings.maxTrades + " /day")}`);
  console.log(`  ${W("Score min:")}      ${B(liveSettings.scoreThreshold + "/10")} ${DIM(modeTag(liveSettings.scoreThreshold))}`);
  console.log(`  ${W("Stock tier:")}     ${B(liveSettings.stockTier)} ${DIM("(" + TC[liveSettings.stockTier] + " stocks)")}`);
  console.log(`  ${W("Nifty filter:")}   ${liveSettings.niftyFilter ? G("ON") : Y("OFF")}`);
  console.log();
  console.log(`  ${W("Brokerage:")}      ${B("₹" + brokeragePerOrder + " /leg (₹" + brokeragePerOrder * 2 + " round trip)")}`);
  console.log();
  console.log(`  ${W("Guards (always ON):")}`);
  console.log(`  ${DIM("  🚨 Nifty spike >0.4% in 3 min → scans blocked + emergency exit")}`);
  console.log(`  ${DIM("  📊 VIX >20 → score threshold +1  |  VIX >25 → +2")}`);
  console.log(`  ${DIM("  📅 NSE holidays → auto-fetched from Upstox, cached weekly")}`);
  console.log(`  ${DIM("  📅 Blocked events → edit blockedEvents[] in config.json")}`);
  console.log();

  // ── START INSTRUCTIONS ────────────────────────────────────────────────────
  div();
  console.log(W("  🚀 HOW TO START (Termux):\n"));
  console.log(G("  # Both together (recommended):"));
  console.log(Y("  FCB_ADMIN_KEY=yourkey RUN_BOT=1 nohup node bridge.js > bridge.log 2>&1 &\n"));
  console.log(G("  # Or separately:"));
  console.log(Y("  nohup node bot.js > bot.log 2>&1 &"));
  console.log(Y("  FCB_ADMIN_KEY=yourkey nohup node bridge.js > bridge.log 2>&1 &\n"));
  console.log(G("  # Open UI in Chrome:"));
  console.log(Y("  http://localhost:8080\n"));
  div();
  console.log(W("  📁 FILES:\n"));
  console.log(DIM("  config.json              ← your settings (just written)"));
  console.log(DIM("  fcb_trades.json          ← trade history"));
  console.log(DIM("  fcb_signals.json         ← latest scan signals"));
  console.log(DIM("  fcb_cmd.json             ← UI → bot command channel"));
  console.log(DIM("  nse_holidays.json        ← auto-created on first bot startup"));
  console.log(DIM("  fcb_log_YYYY-MM-DD.txt   ← per-day log (downloadable from UI)"));
  console.log();
  console.log(W("  ⚠️  IMPORTANT — FCB_ADMIN_KEY:\n"));
  console.log(DIM("  Write APIs (token update, settings, scan, trades) require"));
  console.log(DIM("  FCB_ADMIN_KEY env var set on bridge.js startup."));
  console.log(DIM("  Without it, the UI operates in read-only mode."));
  console.log(DIM("  Use any strong password — it never leaves your device.\n"));
  div2();
  console.log(W("  ⚡ FCB BOT V6 — READY TO TRADE"));
  console.log(DIM("  Paper trade for ≥30 market days before going LIVE."));
  div2();
  console.log();

  bye(0);
}

main().catch(e => { console.error(R("❌ Setup error: " + e.message)); bye(1); });
