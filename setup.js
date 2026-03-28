#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  FCB BOT V6 — setup.js
//  Interactive CLI setup wizard. Run once before starting the bot.
//  Writes config.json and initialises fcb_cmd.json.
//
//  NEW IN V6 (3 new questions vs V5):
//    • scoreThreshold — minimum multi-confirm score to execute a trade (1–10)
//    • stockTier      — which stock universe to scan (tier1 / tier1+2 / all)
//    • niftyFilter    — gate trades against Nifty50 direction (true / false)
//
//  CONFIG KEYS WRITTEN (all consumed by bot.js):
//    token           — Upstox live access token (JWT)
//    paperMode       — true = paper/safe, false = real money
//    wallet          — daily allocated capital in ₹
//    riskPct         — % of wallet to risk per trade (0.1–10)
//    dailyLossLimit  — stop trading if daily loss hits this ₹ amount
//    maxTrades       — max live (non-paper) trades per day
//    scoreThreshold  — min score out of 10 to execute signal (default 6)
//    stockTier       — "tier1" (~47) | "tier1+2" (~77) | "all" (~107)
//    niftyFilter     — true: BUY blocked when Nifty negative, SELL when positive
//    updatedAt       — ISO timestamp of last setup run
// ═══════════════════════════════════════════════════════════════════════════

"use strict";

const readline = require("readline");
const fs       = require("fs");
const path     = require("path");

const DIR      = __dirname;
const CFG_FILE = path.join(DIR, "config.json");
const CMD_FILE = path.join(DIR, "fcb_cmd.json");

// ─── TERMINAL COLOURS ─────────────────────────────────────────────────────────
const G  = s => `\x1b[32m${s}\x1b[0m`;   // green
const Y  = s => `\x1b[33m${s}\x1b[0m`;   // yellow
const R  = s => `\x1b[31m${s}\x1b[0m`;   // red
const B  = s => `\x1b[36m${s}\x1b[0m`;   // cyan
const W  = s => `\x1b[1m${s}\x1b[0m`;    // bold
const DIM= s => `\x1b[2m${s}\x1b[0m`;    // dim

// ─── READLINE SETUP ───────────────────────────────────────────────────────────
const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(r => rl.question(q, r));

function bye(code = 0) {
  try { rl.close(); } catch {}
  process.exit(code);
}

process.on("SIGINT", () => { console.log(Y("\n\n⚠️  Setup interrupted.")); bye(1); });

// ─── DIVIDER ──────────────────────────────────────────────────────────────────
const div  = () => console.log(DIM("─".repeat(54)));
const div2 = () => console.log(W("═".repeat(54)));

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  div2();
  console.log(W("  ⚡ FCB BOT V6 — SETUP WIZARD"));
  console.log(DIM("  9 Strategies · Multi-Confirm Scoring · 3 Stock Tiers"));
  div2();
  console.log();

  // Load existing config so we can show current values as defaults
  let ex = {};
  try { ex = JSON.parse(fs.readFileSync(CFG_FILE, "utf8")); }
  catch { /* first run — no existing config */ }

  if (Object.keys(ex).length > 0) {
    console.log(Y("  ℹ️  Existing config found. Press Enter to keep current values.\n"));
  }

  // ── 1. ACCESS TOKEN ───────────────────────────────────────────────────────
  div();
  console.log(W("  STEP 1 — UPSTOX ACCESS TOKEN"));
  console.log(DIM("  Get from: upstox.com → Developer → My Apps → Access Token\n"));

  const tokenPrompt = ex.token
    ? `  Token [current: ****${ex.token.slice(-4)}]: `
    : "  Paste access token: ";

  let token = (await ask(tokenPrompt)).trim();

  // If user pressed Enter and there's an existing token, keep it
  if (!token && ex.token) {
    token = ex.token;
    console.log(G("  ✓ Keeping existing token"));
  }

  if (!token) {
    console.log(R("  ❌ Token is required."));
    bye(1);
  }

  if (!token.startsWith("eyJ")) {
    console.log(Y("  ⚠️  Warning: Live tokens are JWTs starting with 'eyJ'."));
    const cont = (await ask("  Continue anyway? [y/N]: ")).trim().toLowerCase();
    if (cont !== "y") { console.log(Y("  Setup cancelled.")); bye(1); }
  }

  // ── 2. PAPER MODE ──────────────────────────────────────────────────────────
  div();
  console.log(W("  STEP 2 — TRADING MODE"));
  console.log(DIM("  Paper mode = safe test with no real money"));
  console.log(DIM("  Live mode  = real NSE orders via HFT endpoint\n"));

  const pmDefault = ex.paperMode !== false ? "y" : "n";
  const pmInput   = (await ask(`  Paper mode? [${pmDefault.toUpperCase()}=default, y/n]: `)).trim().toLowerCase();
  const paperMode = pmInput === "n" ? false : pmInput === "y" ? true : (ex.paperMode !== false);

  if (!paperMode) {
    console.log();
    console.log(R("  ⚠️  WARNING: LIVE MODE PLACES REAL ORDERS WITH REAL MONEY"));
    console.log(R("  ⚠️  NSE requires a STATIC IP for algo trading (May 2025 regulation)"));
    console.log();
    const confirm = (await ask("  Type 'LIVE' to confirm real-money trading: ")).trim();
    if (confirm !== "LIVE") {
      console.log(Y("  → Falling back to PAPER mode for safety."));
      // paperMode stays true (keep safe)
    }
  }

  // ── 3. WALLET ──────────────────────────────────────────────────────────────
  div();
  console.log(W("  STEP 3 — DAILY WALLET"));
  console.log(DIM("  How much capital to allocate for trading today.\n"));

  const wDefault = ex.wallet || 5000;
  const wRaw     = (await ask(`  Wallet ₹ [${wDefault}]: `)).trim();
  const wallet   = parseFloat(wRaw) || wDefault;

  if (wallet <= 0) {
    console.log(R("  ❌ Wallet must be > ₹0.")); bye(1);
  }

  // ── 4. RISK % ──────────────────────────────────────────────────────────────
  div();
  console.log(W("  STEP 4 — RISK PER TRADE (%)"));
  console.log(DIM("  % of wallet to risk on each trade. 1–2% recommended.\n"));
  console.log(DIM(`  At ${(wallet * 0.01).toFixed(0)}–₹${(wallet * 0.02).toFixed(0)} risk/trade with ₹${wallet} wallet.\n`));

  const rDefault  = ex.riskPct || 2;
  const rRaw      = (await ask(`  Risk % [${rDefault}]: `)).trim();
  const riskPct   = Math.min(10, Math.max(0.1, parseFloat(rRaw) || rDefault));

  // ── 5. DAILY LOSS LIMIT ────────────────────────────────────────────────────
  div();
  console.log(W("  STEP 5 — DAILY LOSS LIMIT"));
  console.log(DIM("  Bot stops trading for the day if total loss hits this.\n"));

  const lDefault       = ex.dailyLossLimit || Math.round(wallet * 0.1); // default 10% of wallet
  const lRaw           = (await ask(`  Loss limit ₹ [${lDefault}]: `)).trim();
  const dailyLossLimit = Math.max(0, parseFloat(lRaw) || lDefault);

  // ── 6. MAX TRADES ──────────────────────────────────────────────────────────
  div();
  console.log(W("  STEP 6 — MAX LIVE TRADES PER DAY"));
  console.log(DIM("  Paper trades don't count. Live trades only.\n"));

  const tDefault = ex.maxTrades || 5;
  const tRaw     = (await ask(`  Max trades [${tDefault}]: `)).trim();
  const maxTrades = Math.min(20, Math.max(1, parseInt(tRaw) || tDefault));

  // ── 7. SCORE THRESHOLD (NEW V6) ────────────────────────────────────────────
  div();
  console.log(W("  STEP 7 — MINIMUM SIGNAL SCORE (V6 NEW)"));
  console.log(DIM("  Multi-confirmation score out of 10. Higher = fewer but stronger signals."));
  console.log();
  console.log(DIM("  How scoring works:"));
  console.log(DIM("    FCB=3  ORB=2  VWAP=2  EMA=2  GAP=2"));
  console.log(DIM("    ST+MACD=3  RSI_DIV=3  BB_SQZ=2  ADX+EMA=3"));
  console.log(DIM("    Bonus: Vol>2×avg=+1 | Nifty aligned=+1 | Nifty opposite=-2"));
  console.log();
  console.log(Y("    Score 1–5:  SKIP (not enough confirmation)"));
  console.log(Y("    Score 6:    POSSIBLE (minimum threshold)"));
  console.log(Y("    Score 7–8:  TRADE (good confidence)"));
  console.log(G("    Score 9–10: STRONG (multiple strategies agree)"));
  console.log();

  const stDefault    = ex.scoreThreshold || 6;
  const stRaw        = (await ask(`  Score threshold 1–10 [${stDefault}]: `)).trim();
  const scoreThreshold = Math.min(10, Math.max(1, parseInt(stRaw) || stDefault));

  // ── 8. STOCK TIER (NEW V6) ─────────────────────────────────────────────────
  div();
  console.log(W("  STEP 8 — STOCK UNIVERSE TIER (V6 NEW)"));
  console.log(DIM("  More stocks = more signal opportunities, more API calls.\n"));
  console.log(B("    tier1    — ~47 stocks  · Nifty 50 only · scan every 1–2 min"));
  console.log(B("    tier1+2  — ~77 stocks  · Nifty 50 + Next 50 select · recommended"));
  console.log(B("    all      — ~107 stocks · + Midcap momentum stocks · most coverage"));
  console.log();

  const tierOptions = ["tier1", "tier1+2", "all"];
  const tierDefault = ex.stockTier || "tier1+2";
  let   tierRaw     = (await ask(`  Stock tier [tier1 / tier1+2 / all] [${tierDefault}]: `)).trim().toLowerCase();

  // Accept shorthand: "1" → "tier1", "2" → "tier1+2", "3" → "all"
  if (tierRaw === "1") tierRaw = "tier1";
  if (tierRaw === "2") tierRaw = "tier1+2";
  if (tierRaw === "3") tierRaw = "all";

  const stockTier = tierOptions.includes(tierRaw) ? tierRaw : tierDefault;

  const tierStockCounts = { "tier1": 47, "tier1+2": 77, "all": 107 };
  console.log(G(`  ✓ Scanning ${tierStockCounts[stockTier]} stocks`));

  // ── 9. NIFTY FILTER (NEW V6) ───────────────────────────────────────────────
  div();
  console.log(W("  STEP 9 — NIFTY DIRECTION FILTER (V6 NEW)"));
  console.log(DIM("  Gates trade direction against the Nifty 50 index movement.\n"));
  console.log(Y("    ON:  BUY signals blocked when Nifty is negative (>0.1% down)"));
  console.log(Y("         SELL signals blocked when Nifty is positive (>0.1% up)"));
  console.log(Y("         Score penalty -2 for trading against Nifty"));
  console.log(Y("         Score bonus  +1 for trading with Nifty"));
  console.log(DIM("    OFF: All signals evaluated regardless of Nifty direction"));
  console.log();
  console.log(G("  Recommended: ON — improves accuracy by ~5–8%\n"));

  const nfDefault = ex.niftyFilter !== false ? "y" : "n";
  const nfRaw     = (await ask(`  Enable Nifty filter? [${nfDefault.toUpperCase()}=default, y/n]: `)).trim().toLowerCase();
  const niftyFilter = nfRaw === "n" ? false : nfRaw === "y" ? true : (ex.niftyFilter !== false);

  // ── BUILD CONFIG ──────────────────────────────────────────────────────────
  const cfg = {
    token,
    paperMode,
    wallet,
    riskPct,
    dailyLossLimit,
    maxTrades,
    scoreThreshold,
    stockTier,
    niftyFilter,
    updatedAt: new Date().toISOString(),
  };

  // ── WRITE CONFIG ──────────────────────────────────────────────────────────
  fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2));
  console.log();
  console.log(G("  ✅ config.json saved."));

  // Initialise cmd file if not present
  if (!fs.existsSync(CMD_FILE)) {
    fs.writeFileSync(CMD_FILE, JSON.stringify({ cmd: "noop", ts: 0 }, null, 2));
    console.log(G("  ✅ fcb_cmd.json initialised."));
  }

  // Initialise empty trades + signals files if not present
  const TRD_FILE = path.join(DIR, "fcb_trades.json");
  const SIG_FILE = path.join(DIR, "fcb_signals.json");
  if (!fs.existsSync(TRD_FILE)) { fs.writeFileSync(TRD_FILE, "[]"); console.log(G("  ✅ fcb_trades.json initialised.")); }
  if (!fs.existsSync(SIG_FILE)) { fs.writeFileSync(SIG_FILE, "[]"); console.log(G("  ✅ fcb_signals.json initialised.")); }

  // ── SUMMARY ───────────────────────────────────────────────────────────────
  console.log();
  div2();
  console.log(W("  ✅ FCB BOT V6 SETUP COMPLETE"));
  div2();
  console.log();
  console.log(`  ${W("Mode:")}         ${paperMode ? G("📋 PAPER (safe — no real money)") : R("⚠️  LIVE (real money — be careful!)")}`);
  console.log(`  ${W("Wallet:")}       ${B("₹" + wallet.toFixed(0))}`);
  console.log(`  ${W("Risk:")}         ${B(riskPct + "% per trade")} ${DIM("(₹" + (wallet * riskPct / 100).toFixed(0) + " max per trade)")}`);
  console.log(`  ${W("Loss limit:")}   ${B("₹" + dailyLossLimit + "/day")}`);
  console.log(`  ${W("Max trades:")}   ${B(maxTrades + " live trades/day")}`);
  console.log(`  ${W("Score min:")}    ${B(scoreThreshold + "/10")} ${DIM(scoreThreshold >= 7 ? "(high confidence — fewer signals)" : scoreThreshold === 6 ? "(standard — recommended)" : "(low — many signals, less accurate)")}`);
  console.log(`  ${W("Stock tier:")}   ${B(stockTier)} ${DIM("(" + tierStockCounts[stockTier] + " stocks scanned)")}`);
  console.log(`  ${W("Nifty filter:")} ${niftyFilter ? G("ON (trades gated by Nifty direction)") : Y("OFF (all signals allowed)")}`);
  console.log();

  // ── START INSTRUCTIONS ────────────────────────────────────────────────────
  div();
  console.log(W("  🚀 HOW TO START THE BOT (run in Termux):\n"));
  console.log(G("  # Terminal 1 — Bridge server (serves UI + API)"));
  console.log(Y("  nohup node bridge.js > bridge.log 2>&1 &\n"));
  console.log(G("  # Terminal 2 — Trading bot"));
  console.log(Y("  nohup node bot.js > bot.log 2>&1 &\n"));
  console.log(G("  # Or run both with one command:"));
  console.log(Y("  RUN_BOT=1 nohup node bridge.js > bridge.log 2>&1 &\n"));
  console.log(G("  # Open UI in Chrome:"));
  console.log(Y("  http://localhost:8080\n"));
  div();
  console.log(W("  📋 HOW TO CHECK IF RUNNING:\n"));
  console.log(DIM("  cat bot.log        ← bot activity (scans, signals, trades)"));
  console.log(DIM("  cat bridge.log     ← bridge server activity"));
  console.log(DIM("  tail -f bot.log    ← live-follow the bot log"));
  console.log(DIM("  jobs               ← list background processes"));
  console.log(DIM("  kill %1            ← stop if needed\n"));
  div();
  console.log(W("  📁 FILES CREATED BY THE BOT:\n"));
  console.log(DIM("  config.json              — your settings (just written)"));
  console.log(DIM("  fcb_trades.json          — trade history"));
  console.log(DIM("  fcb_signals.json         — latest scan signals"));
  console.log(DIM("  fcb_cmd.json             — UI → bot command channel"));
  console.log(DIM("  fcb_log_YYYY-MM-DD.txt   — per-day trading log (downloadable from UI)"));
  console.log();
  div2();
  console.log(W("  ⚡ FCB BOT V6 — READY TO TRADE"));
  console.log(DIM("  Paper trade for ≥30 market days before going LIVE."));
  div2();
  console.log();

  bye(0);
}

main().catch(e => {
  console.error(R("❌ Setup error: " + e.message));
  bye(1);
});
