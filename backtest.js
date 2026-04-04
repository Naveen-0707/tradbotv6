#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  FCB BOT V6 — backtest.js  (standalone — zero changes to existing files)
//
//  Replays historical trading days through the exact same strategy engine
//  as the live bot. Results appear in the existing bridge.js UI in real-time:
//  same trade cards, same log viewer, same signal cards.
//
//  HOW IT WORKS:
//    Phase 1 — Fetch all 1-min historical candles for every stock + Nifty.
//    Phase 2 — Replay each day minute by minute, following the same SCHEDULE
//              and scan intervals as bot.js. At each scan tick, calls
//              analyzeStock() with candles sliced to that exact moment.
//              OCO (target/SL) is resolved immediately against the rest of
//              the day's candles — you see final trade status in the UI.
//
//  WHY NO CHANGES TO EXISTING FILES:
//    todayCandles() in indicators.js filters by the LAST candle's IST date,
//    not Date.now(). Passing a slice where the last candle is from the replay
//    date makes all strategies behave identically to live mode. ✅
//
//  PREREQUISITES:
//    1. node bridge.js running (UI shows results via SSE file watchers)
//    2. Valid Upstox token in config.json (refresh if expired)
//
//  USAGE:
//    node backtest.js                               # last 5 trading days
//    node backtest.js --date 2025-03-10             # single day
//    node backtest.js --from 2025-03-10 --to 2025-03-14
//    node backtest.js --speed 80                    # ms delay per scan tick (default 80)
//    node backtest.js --tier tier1                  # stock tier override
//    node backtest.js --score 7                     # score threshold override
//    node backtest.js --date 2025-03-10 --speed 0  # instant (no UI animation)
// ═══════════════════════════════════════════════════════════════════════════

"use strict";

const https = require("https");
const fs    = require("fs");
const path  = require("path");

// ─── IMPORTS (read-only — zero changes to these files) ───────────────────────
const {
  analyzeStock,
  getSchedule,
  getStocksForTier,
  hasOpenPosition,
  markLoss,
  STOCKS,
} = require("./strategies");

// ─── PATHS ────────────────────────────────────────────────────────────────────
const DIR      = __dirname;
const CFG_FILE = path.join(DIR, "config.json");
const TRD_FILE = path.join(DIR, "fcb_trades.json");
const SIG_FILE = path.join(DIR, "fcb_signals.json");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
let CFG;
try   { CFG = JSON.parse(fs.readFileSync(CFG_FILE, "utf8")); }
catch { console.error("❌  config.json not found — run node setup.js first"); process.exit(1); }

if (!CFG.token) { console.error("❌  No token in config.json — paste a valid Upstox token"); process.exit(1); }

// ─── CLI ARGS ─────────────────────────────────────────────────────────────────
const args   = process.argv.slice(2);
const getArg = (flag, def) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : def; };

const SPEED_MS     = parseInt(getArg("--speed", "80"), 10);
const TIER         = getArg("--tier",  CFG.modeSettings?.paper?.stockTier  || CFG.stockTier  || "tier1+2");
const SCORE_THRESH = parseInt(getArg("--score", String(CFG.modeSettings?.paper?.scoreThreshold || CFG.scoreThreshold || 7)), 10);
const WALLET       = CFG.modeSettings?.paper?.wallet  || CFG.wallet  || 50000;
const RISK_PCT     = CFG.modeSettings?.paper?.riskPct || CFG.riskPct || 2;
const COSTS        = (CFG.brokeragePerOrder || 20) * 2; // entry + exit legs

// ─── IST HELPERS ──────────────────────────────────────────────────────────────
const istNow     = () => new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
const istDateStr = d => {
  const t = d || istNow();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
};
const toIST    = ts => new Date(new Date(ts).toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
const istMOD   = ts => { const d = toIST(ts); return d.getHours() * 60 + d.getMinutes(); };
const istTimeStr = ts => toIST(ts).toLocaleTimeString("en-IN");

// DateString for candle grouping — matches todayCandles() in indicators.js
const istDayStr    = ts => toIST(ts).toDateString();
const replayDayStr = date => new Date(date + "T09:15:00+05:30").toDateString();

// ─── DATE RANGE CALCULATION ───────────────────────────────────────────────────
function lastNTradingDays(n) {
  const days = [];
  const d    = istNow();
  while (days.length < n) {
    d.setDate(d.getDate() - 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) days.push(istDateStr(d));
  }
  return days.reverse();
}

function dateRange(from, to) {
  const days = [];
  const d    = new Date(from + "T00:00:00+05:30");
  const end  = new Date(to   + "T00:00:00+05:30");
  while (d <= end) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) days.push(istDateStr(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

let DATES;
if (args.includes("--date")) {
  DATES = [getArg("--date", istDateStr())];
} else if (args.includes("--from") && args.includes("--to")) {
  DATES = dateRange(getArg("--from"), getArg("--to"));
} else {
  DATES = lastNTradingDays(5);
}

// ─── HTTP HELPERS ─────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function httpGet(host, urlPath) {
  return new Promise((res, rej) => {
    const req = https.request(
      { hostname: host, path: urlPath, method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${CFG.token}` } },
      resp => {
        let d = "";
        resp.on("data", c => d += c);
        resp.on("end", () => {
          try { res({ status: resp.statusCode, data: JSON.parse(d) }); }
          catch { res({ status: resp.statusCode, data: d }); }
        });
      }
    );
    req.on("error", rej);
    req.end();
  });
}

async function fetchR(host, urlPath, retries = 3) {
  for (let a = 0; a <= retries; a++) {
    try {
      const r = await httpGet(host, urlPath);
      if (r.status === 429) { await sleep(1000 * Math.pow(2, a)); continue; }
      return r;
    } catch (e) {
      if (a === retries) throw e;
      await sleep(600 * Math.pow(2, a));
    }
  }
  throw new Error("Max retries exceeded");
}

// ─── CANDLE FETCHER ───────────────────────────────────────────────────────────
// Returns oldest-first array of 1-min candles (same contract as bot.js).

async function fetchHistoricalCandles(instrumentKey, fromDate, toDate) {
  const key = encodeURIComponent(instrumentKey);
  try {
    const r = await fetchR(
      "api.upstox.com",
      `/v3/historical-candle/${key}/minutes/1/${toDate}/${fromDate}`
    );
    if (r.status === 200) {
      return (r.data?.data?.candles || [])
        .map(c => ({ ts: c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] }))
        .reverse(); // Upstox returns newest-first → flip to oldest-first
    }
    if (r.status === 401) {
      console.error("\n❌  Token expired or invalid — refresh config.json and retry");
      process.exit(1);
    }
  } catch {
    // non-fatal per stock
  }
  return [];
}

// ─── FILE WRITERS (same files bridge.js watches → UI updates via SSE) ─────────
let allBtTrades  = [];
let allBtSignals = [];

function saveTrades()  { try { fs.writeFileSync(TRD_FILE, JSON.stringify(allBtTrades,  null, 2)); } catch {} }
function saveSignals() { try { fs.writeFileSync(SIG_FILE, JSON.stringify(allBtSignals, null, 2)); } catch {} }

// ─── LOGGING (writes to same daily log files bridge.js streams) ──────────────
let activeLogFile = path.join(DIR, `fcb_log_${istDateStr()}.txt`);

function log(msg, type = "INFO", replayDate = "") {
  const ts   = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
  const tag  = replayDate ? `[BT:${replayDate}]` : "[BACKTEST]";
  const line = `[${ts}] [${type}] ${tag} ${msg}`;
  console.log(line);
  try { fs.appendFileSync(activeLogFile, line + "\n"); } catch {}
}

function setLogFile(date) {
  activeLogFile = path.join(DIR, `fcb_log_${date}.txt`);
}

// ─── QTY CALCULATOR ───────────────────────────────────────────────────────────
function calcQty(risk, entry, availBal) {
  if (availBal <= 0 || entry <= 0 || risk <= 0 || entry > availBal) return 0;
  const byRisk    = Math.floor((availBal * RISK_PCT / 100) / risk);
  const byCapital = Math.floor(availBal / entry);
  const byPct     = Math.floor((availBal * 0.30) / entry);
  const qty       = Math.min(byRisk, byCapital, byPct, 500);
  return qty > 0 ? qty : 0;
}

// ─── OCO SIMULATOR ───────────────────────────────────────────────────────────
// Resolves target/SL against actual historical candles after entry.
// Includes step-trailing identical to bot.js simulatePaperOCO.

function simulateOCO(trade, candlesAfterEntry) {
  if (!candlesAfterEntry || candlesAfterEntry.length === 0) {
    trade.status = "SQUARED_OFF";
    trade.pnl    = -COSTS;
    return trade;
  }

  for (const c of candlesAfterEntry) {
    const oneR       = trade.risk * trade.qty;
    const step       = trade.trailStep || 0;
    const unrealised = trade.direction === "BUY"
      ? (c.c - trade.entry) * trade.qty
      : (trade.entry - c.c) * trade.qty;

    // Step trailing (mirrors bot.js exactly)
    if (step < 3 && unrealised >= 3 * oneR) {
      const newSL = +(trade.direction === "BUY"
        ? trade.entry + trade.risk : trade.entry - trade.risk).toFixed(2);
      if (trade.direction === "BUY" ? newSL > trade.sl : newSL < trade.sl) {
        trade.sl = newSL; trade.trailStep = 3;
      }
    } else if (step < 2 && unrealised >= 2 * oneR) {
      const newSL = +(trade.direction === "BUY"
        ? trade.entry + trade.risk * 0.5 : trade.entry - trade.risk * 0.5).toFixed(2);
      if (trade.direction === "BUY" ? newSL > trade.sl : newSL < trade.sl) {
        trade.sl = newSL; trade.trailStep = 2;
      }
    } else if (step < 1 && unrealised >= oneR) {
      const newSL = +(trade.direction === "BUY"
        ? trade.entry - trade.risk * 0.3 : trade.entry + trade.risk * 0.3).toFixed(2);
      if (trade.direction === "BUY" ? newSL > trade.sl : newSL < trade.sl) {
        trade.sl = newSL; trade.trailStep = 1;
      }
    }

    // Conservative: prefer SL if both target and SL hit in same candle
    const targetHit = trade.direction === "BUY" ? c.h >= trade.target : c.l <= trade.target;
    const slHit     = trade.direction === "BUY" ? c.l <= trade.sl     : c.h >= trade.sl;

    if (slHit) {
      trade.status   = "STOPPED_OUT";
      trade.pnl      = +(
        (trade.direction === "BUY"
          ? trade.sl - trade.entry
          : trade.entry - trade.sl) * trade.qty - COSTS
      ).toFixed(0);
      trade.exitTime = istTimeStr(c.ts);
      markLoss(trade.name);
      return trade;
    }
    if (targetHit) {
      trade.status   = "TARGET_HIT";
      trade.pnl      = +(trade.risk * trade.qty * (trade.rrMult || 2) - COSTS).toFixed(0);
      trade.exitTime = istTimeStr(c.ts);
      return trade;
    }
  }

  // End of day — square off at last candle close
  const last      = candlesAfterEntry[candlesAfterEntry.length - 1];
  trade.status    = "SQUARED_OFF";
  trade.pnl       = +(
    (trade.direction === "BUY"
      ? last.c - trade.entry
      : trade.entry - last.c) * trade.qty - COSTS
  ).toFixed(0);
  trade.exitTime  = istTimeStr(last.ts);
  return trade;
}

// ─── REPLAY ONE TRADING DAY ───────────────────────────────────────────────────
// Mirrors bot.js main loop exactly:
//   - iterate over actual Nifty candle timestamps (ground truth clock)
//   - check schedule, fire scans at correct intervals
//   - call analyzeStock() with candles sliced to that exact moment
//   - resolve OCO immediately against remaining day candles
//   - write to fcb_trades.json + log after each trade (UI updates live)

async function replayDay(date, candleMap, niftyCandles) {
  const dayLabel = replayDayStr(date);

  const dayNifty = niftyCandles.filter(c => istDayStr(c.ts) === dayLabel);
  if (dayNifty.length === 0) {
    log(`⚠️  No Nifty candles for ${date} — NSE holiday or API gap, skipping`, "WARN", date);
    return null;
  }

  const prevNifty      = niftyCandles.filter(c => istDayStr(c.ts) !== dayLabel);
  const niftyPrevClose = prevNifty.length > 0 ? prevNifty[prevNifty.length - 1].c : 0;

  const stocks      = getStocksForTier(TIER);
  const dayTrades   = [];
  let   lastScanMin = -999;
  let   dailyPnL    = 0;

  log(`${"─".repeat(54)}`, "INFO", date);
  log(`Replaying ${date} | ${stocks.length} stocks | Score≥${SCORE_THRESH} | ${TIER}`, "INFO", date);

  for (const tick of dayNifty) {
    const m     = istMOD(tick.ts);
    const sched = getSchedule(m);

    if (m < 555 || m >= 920)                              continue;
    if (sched.blocked || !sched.strategies.length)         continue;
    if (m - lastScanMin < (sched.scanInterval || 2))       continue;
    lastScanMin = m;

    const locked   = dayTrades
      .filter(t => t.status === "PAPER" && t.direction === "BUY")
      .reduce((s, t) => s + t.entry * t.qty, 0);
    const availBal = WALLET + dailyPnL - locked;
    const niftyLtp = tick.c;

    log(
      `⏰ ${istTimeStr(tick.ts)} ${sched.label} | ₹${availBal.toFixed(0)} | ` +
      `${dayTrades.length} trades | Nifty:${niftyLtp.toFixed(0)}`,
      "STATUS", date
    );

    const newSignals = [];

    for (const stock of stocks) {
      const allCandles = candleMap[stock.name];
      if (!allCandles || allCandles.length < 10) continue;

      // KEY: slice candles to this exact replay moment.
      //   - Candles from BEFORE today: kept intact (indicator warmup for ATR/RSI/ADX/etc.)
      //   - Today's candles: only up to and including minute M
      // todayCandles() in indicators.js reads the LAST candle's date, so it will
      // correctly identify "today" as the replay date — no changes needed there.
      const sliced = allCandles.filter(c => {
        if (istDayStr(c.ts) !== dayLabel) return true;  // warmup: keep all prior days
        return istMOD(c.ts) <= m;                        // today: up to current minute only
      });

      if (sliced.length < 10) continue;

      try {
        const signal = analyzeStock({
          candles:          sliced,
          name:             stock.name,
          activeStrategies: sched.strategies,
          trades:           [...dayTrades, ...allBtTrades],
          niftyLtp,
          niftyPrevClose,
          scoreThreshold:   SCORE_THRESH,
        });

        if (!signal) continue;

        const qty = calcQty(signal.risk, signal.entry, availBal);
        if (qty <= 0) continue;

        // Candles from AFTER entry, within this day only (for OCO)
        const candlesAfter = allCandles.filter(c =>
          istDayStr(c.ts) === dayLabel && istMOD(c.ts) > m
        );

        const trade = {
          ...signal,
          qty,
          date,
          btDate:       date,
          time:         istTimeStr(tick.ts),
          paper:        true,    // renders as paper trade in UI
          backtest:     true,
          status:       "PAPER",
          pnl:          null,
          ltp:          null,
          livePnl:      0,
          trailStep:    0,
          instrumentKey: stock.key,
        };

        const completed = simulateOCO(trade, candlesAfter);
        if (completed.pnl !== null) dailyPnL += completed.pnl;

        dayTrades.push(completed);
        allBtTrades.push(completed);
        saveTrades();

        const emoji  = completed.status === "TARGET_HIT"  ? "🎯"
                     : completed.status === "STOPPED_OUT"  ? "🛑" : "📋";
        const pnlStr = completed.pnl != null
          ? `P&L:${completed.pnl >= 0 ? "+" : ""}₹${completed.pnl}`
          : "OPEN";

        log(
          `${emoji} ${completed.direction} ${qty}× ${stock.name} [${signal.strategy}] ` +
          `S:${signal.score}/10 @ ₹${signal.entry} | ${completed.status} ${pnlStr}` +
          (completed.exitTime ? ` → ${completed.exitTime}` : ""),
          "TRADE", date
        );

        newSignals.push({ ...signal, btDate: date, qty, backtest: true });

      } catch {
        // per-stock errors are non-fatal in backtest
      }
    }

    if (newSignals.length > 0) {
      allBtSignals = [...allBtSignals, ...newSignals];
      saveSignals();
      log(`🎯 ${newSignals.length} signal(s) fired`, "SIGNAL", date);
    }

    if (SPEED_MS > 0) await sleep(SPEED_MS);
  }

  const wins  = dayTrades.filter(t => t.pnl > 0).length;
  const losses = dayTrades.filter(t => t.pnl < 0).length;
  const sqoff  = dayTrades.filter(t => t.status === "SQUARED_OFF").length;
  log(
    `📊 DAY DONE: ${dayTrades.length} trades | ${wins}W ${losses}L ${sqoff} sq-off | ` +
    `P&L: ${dailyPnL >= 0 ? "+" : ""}₹${dailyPnL.toFixed(0)}`,
    "INFO", date
  );

  return { date, total: dayTrades.length, wins, losses, sqoff, pnl: dailyPnL };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  const HR = "═".repeat(60);
  console.log(HR);
  console.log("⚡ FCB BOT V6 — BACKTEST RUNNER");
  console.log(`   Dates   : ${DATES.join("  ")}`);
  console.log(`   Tier    : ${TIER}  |  Score≥${SCORE_THRESH}  |  Speed: ${SPEED_MS}ms/tick`);
  console.log(`   Wallet  : ₹${WALLET}  |  Risk: ${RISK_PCT}%  |  Costs: ₹${COSTS}/trade`);
  console.log(HR);
  console.log("ℹ️   bridge.js must be running → open http://localhost:8080");
  console.log("ℹ️   Token expires at 3:30 AM IST — refresh config.json if expired");
  console.log(HR);
  console.log();

  const stocks = getStocksForTier(TIER);

  // Warmup = 14 calendar days before first replay date (~10 trading days).
  // Ensures indicators like ADX (needs 28+ candles) are properly seeded.
  const warmupDate = new Date(DATES[0] + "T00:00:00+05:30");
  warmupDate.setDate(warmupDate.getDate() - 14);
  const fetchFrom = istDateStr(warmupDate);
  const fetchTo   = DATES[DATES.length - 1];

  // ── Phase 1: Fetch all candles ─────────────────────────────────────────────
  console.log(`📡 Phase 1 — Fetching candles  (${fetchFrom} → ${fetchTo})`);
  console.log(`   ${stocks.length} stocks + Nifty 50`);
  console.log();

  const candleMap  = {};
  const BATCH_SIZE = 8; // conservative — stays within Upstox rate limits

  for (let i = 0; i < stocks.length; i += BATCH_SIZE) {
    const batch = stocks.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(
      batch.map(async stock => {
        const candles = await fetchHistoricalCandles(stock.key, fetchFrom, fetchTo);
        candleMap[stock.name] = candles;
      })
    );
    process.stdout.write(`\r   Fetched ${Math.min(i + BATCH_SIZE, stocks.length)}/${stocks.length} stocks...`);
    await sleep(400);
  }

  const fetched = Object.values(candleMap).filter(c => c.length > 0).length;
  console.log(`\n   ✅ ${fetched}/${stocks.length} stocks with data\n`);

  process.stdout.write("   Fetching Nifty 50...");
  let niftyCandles = [];
  try {
    niftyCandles = await fetchHistoricalCandles(STOCKS.nifty.key, fetchFrom, fetchTo);
    console.log(` ✅ ${niftyCandles.length} candles`);
  } catch (e) {
    console.log(` ⚠️  failed (${e.message}) — Nifty direction filter disabled`);
  }

  // ── Phase 2: Replay ────────────────────────────────────────────────────────
  console.log();
  console.log(`🎬 Phase 2 — Replaying ${DATES.length} day(s)`);
  console.log();

  // Clear files so UI starts fresh for this backtest run
  allBtTrades  = [];
  allBtSignals = [];
  saveTrades();
  saveSignals();

  setLogFile(istDateStr());
  log(`Backtest started — dates: ${DATES.join(", ")}`);

  const results = [];
  for (const date of DATES) {
    setLogFile(date);
    const result = await replayDay(date, candleMap, niftyCandles);
    if (result) results.push(result);
    console.log();
  }

  // ── Final summary ──────────────────────────────────────────────────────────
  const hr2 = "─".repeat(60);
  console.log(HR);
  console.log("📊 BACKTEST SUMMARY");
  console.log(hr2);
  console.log(`  ${"DATE".padEnd(12)} ${"TRADES".padEnd(8)} ${"W".padEnd(5)} ${"L".padEnd(5)} ${"SQ".padEnd(5)} P&L`);
  console.log(hr2);

  let totPnL = 0, totT = 0, totW = 0, totL = 0, totSQ = 0;
  for (const r of results) {
    const pnl = `${r.pnl >= 0 ? "+" : ""}₹${r.pnl.toFixed(0)}`;
    console.log(`  ${r.date.padEnd(12)} ${String(r.total).padEnd(8)} ${String(r.wins).padEnd(5)} ${String(r.losses).padEnd(5)} ${String(r.sqoff).padEnd(5)} ${pnl}`);
    totPnL += r.pnl; totT += r.total; totW += r.wins; totL += r.losses; totSQ += r.sqoff;
  }

  const wr      = (totW + totL) > 0 ? ((totW / (totW + totL)) * 100).toFixed(0) : "—";
  const totPnl  = `${totPnL >= 0 ? "+" : ""}₹${totPnL.toFixed(0)}`;
  console.log(hr2);
  console.log(`  ${"TOTAL".padEnd(12)} ${String(totT).padEnd(8)} ${String(totW).padEnd(5)} ${String(totL).padEnd(5)} ${String(totSQ).padEnd(5)} ${totPnl}  WR:${wr}%`);
  console.log(HR);
  console.log();
  console.log("✅  Results visible in UI  →  http://localhost:8080  (Trades + Log tabs)");
  console.log("   Download CSV from Log tab for candle-level analysis");
  console.log(HR);
}

main().catch(e => {
  console.error(`\n❌  Backtest fatal: ${e.message}`);
  process.exit(1);
});
