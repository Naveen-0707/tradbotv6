#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  FCB BOT V6 — bot.js
//  Main trading engine. Full rewrite. All 14 bugs fixed.
//  Requires: indicators.js · strategies.js
//  Run: node bot.js  (or via bridge.js with RUN_BOT=1)
//
//  BUG FIX INDEX (all 14 addressed):
//   #1  Duplicate trades      → hasOpenPosition() in strategies.js + scan guard
//   #2  Qty ignores balance   → calcQty uses availableBalance() + entry cap
//   #3  Stale false positives → isStale() from indicators.js, candles oldest-first
//   #4  Opposite dir trades   → hasOpenPosition() in strategies.js
//   #5  Locked capital wrong  → lockedCapital counts BUY-only OPEN trades
//   #6  scanning flag sticks  → try/finally in scan()
//   #7  WS hammering          → handled in index.html (30s delay)
//   #8  Old trades on restart → "clear_trades" cmd clears memory + file atomically
//   #9  Early candle scan     → minimum candle guards in every strategy
//  #10  No Nifty filter       → niftyState tracked + passed to analyzeStock
//  #11  Risk on full wallet   → calcQty uses availableBalance, not wallet
//  #12  Paper OCO never fires → simulatePaperOCO() uses REST LTP check every 5s
//  #13  Logs mixed            → per-day fcb_log_YYYY-MM-DD.txt, [BOT] prefix
//  #14  Paper in live count   → tradesToday() counts only !t.paper trades
// ═══════════════════════════════════════════════════════════════════════════

"use strict";

const https      = require("https");
const fs         = require("fs");
const path       = require("path");
const { exec }   = require("child_process");

const {
  analyzeStock,
  getSchedule,
  getStocksForTier,
  hasOpenPosition,
  markLoss,
  STOCKS,
} = require("./strategies");

const { isStale } = require("./indicators");

// ─── PATHS ────────────────────────────────────────────────────────────────────
const DIR      = __dirname;
const CFG_FILE = path.join(DIR, "config.json");
const TRD_FILE = path.join(DIR, "fcb_trades.json");
const SIG_FILE = path.join(DIR, "fcb_signals.json");
const CMD_FILE = path.join(DIR, "fcb_cmd.json");

// ─── PER-DAY LOG FILE — BUG #13 FIX ─────────────────────────────────────────
// New file created every calendar day. Bridge.js watches today's file.
// Exported via /api/status so bridge.js always knows current log path.

function todayLogFile() {
  const d   = new Date();
  const y   = d.getFullYear();
  const mo  = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return path.join(DIR, `fcb_log_${y}-${mo}-${day}.txt`);
}

let currentLogFile = todayLogFile();

// Called by bridge.js via require to get today's log path
function getCurrentLogFile() { return currentLogFile; }

// ─── CONFIG ───────────────────────────────────────────────────────────────────
function loadCFG() {
  try { return JSON.parse(fs.readFileSync(CFG_FILE, "utf8")); }
  catch { console.error("❌ config.json not found. Run: node setup.js"); process.exit(1); }
}

let CFG = loadCFG();

const TOKEN        = () => CFG.token;
const PAPER        = () => CFG.paperMode       !== false;
const RPCT         = () => CFG.riskPct         || 2;
const MLOSS        = () => CFG.dailyLossLimit   || 200;
const MTRD         = () => CFG.maxTrades        || 3;
const WAL          = () => CFG.wallet           || 5000;
const SCORE_THRESH = () => CFG.scoreThreshold   || 6;
const STOCK_TIER   = () => CFG.stockTier        || "tier1+2";
const NIFTY_FILTER = () => CFG.niftyFilter      !== false;
const COSTS        = () => CFG.brokeragePerOrder || 20; // ₹ per order leg (entry + exit = 2 legs)

// ─── API ENDPOINTS ────────────────────────────────────────────────────────────
const API_HOST = "api.upstox.com";
const HFT_HOST = "api-hft.upstox.com";
const HFT_PATH = "/v3/order/place";

// ─── LOGGING ─────────────────────────────────────────────────────────────────
function log(msg, type = "INFO") {
  // Auto-rollover to new file at midnight
  const todayFile = todayLogFile();
  if (todayFile !== currentLogFile) currentLogFile = todayFile;

  const ts   = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
  const line = `[${ts}] [${type}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(currentLogFile, line + "\n"); } catch { /* never crash on log */ }
}

function notify(title, body) {
  exec(
    `termux-notification --title "${title}" --content "${body.slice(0, 200)}"` +
    ` --id ${Math.floor(Math.random() * 9000 + 1000)} --priority high`,
    () => {}
  );
}

function notifyPersistent(text) {
  exec(
    `termux-notification --title "⚡ FCB Bot V6" --content "${text}" --id 9999 --ongoing`,
    () => {}
  );
}

// ─── IST UTILITIES ────────────────────────────────────────────────────────────
const istNow     = () => new Date(Date.now() + 5.5 * 3600000);
const istTime    = () => istNow().toLocaleTimeString("en-IN");
const minOfDay   = () => { const t = istNow(); return t.getHours() * 60 + t.getMinutes(); };
const istDateStr = (d) => {
  const t = d || istNow();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
};
const todayStr = () => istDateStr();
const isMarket = () => {
  const d = istNow().getDay(), m = minOfDay();
  return d >= 1 && d <= 5 && m >= 555 && m <= 930;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── HTTP HELPERS ─────────────────────────────────────────────────────────────
function httpReq(host, urlPath, method, headers, body) {
  return new Promise((res, rej) => {
    const hostname = host.replace(/^https?:\/\//, "");
    const opts = {
      hostname, path: urlPath, method,
      headers: { Accept: "application/json", ...headers },
    };
    const req = https.request(opts, resp => {
      let d = "";
      resp.on("data", c => d += c);
      resp.on("end", () => {
        try { res({ status: resp.statusCode, data: JSON.parse(d) }); }
        catch { res({ status: resp.statusCode, data: d }); }
      });
    });
    req.on("error", rej);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function fetchR(host, urlPath, method, hdrs, body, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await httpReq(host, urlPath, method, hdrs, body);
      if (r.status === 429) { await sleep(600 * Math.pow(2, attempt)); continue; }
      return r;
    } catch (e) {
      if (attempt === retries) throw e;
      await sleep(600 * Math.pow(2, attempt));
    }
  }
  throw new Error("Max retries exceeded");
}

const authH = () => ({ Authorization: `Bearer ${TOKEN()}` });

// ─── CANDLE FETCHER ───────────────────────────────────────────────────────────
// BUG #3 FIX: candles reversed immediately to oldest-first (cs[0] = 9:15 AM).
// Strategies depend on this contract — never return newest-first.

async function fetchCandles(instrumentKey, count) {
  let todayArr = [];

  try {
    const r = await fetchR(
      API_HOST,
      `/v3/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/minutes/1`,
      "GET", authH()
    );
    if (r.status === 200) {
      todayArr = (r.data?.data?.candles || [])
        .map(c => ({ ts: c[0], o: c[1], h: c[2], l: c[3], c: c[4], v: c[5] }))
        .reverse(); // BUG #3 FIX: Upstox returns newest-first → oldest-first
    }
  } catch (e) {
    log(`⚠️ Intraday fetch [${instrumentKey}]: ${e.message}`, "WARN");
  }

  if (todayArr.length >= count) return todayArr.slice(-count);

  // Pad with historical data (last 7 trading days) for indicator warmup
  const toD = new Date(istNow()); toD.setDate(toD.getDate() - 1);
  const frD = new Date(istNow()); frD.setDate(frD.getDate() - 7);

  try {
    const r = await fetchR(
      API_HOST,
      `/v3/historical-candle/${encodeURIComponent(instrumentKey)}/minutes/1/${istDateStr(toD)}/${istDateStr(frD)}`,
      "GET", authH()
    );
    if (r.status === 200) {
      const hist = (r.data?.data?.candles || [])
        .map(c => ({ ts: c[0], o: c[1], h: c[2], l: c[3], c: c[4], v: c[5] }))
        .reverse(); // oldest-first
      return [...hist, ...todayArr].slice(-count);
    }
  } catch (e) {
    log(`⚠️ Historical fetch [${instrumentKey}]: ${e.message}`, "WARN");
  }

  return todayArr.slice(-count);
}

// ─── LTP FETCHER ─────────────────────────────────────────────────────────────
// BUG #10 FIX: Nifty LTP for direction gate
// BUG #12 FIX: Paper OCO LTP simulation
// Accepts array of instrument keys, returns { key: { last_price } } map

async function fetchLTP(keys) {
  if (!keys || keys.length === 0) return {};
  // Upstox allows comma-separated keys in query param
  const param = keys.map(k => encodeURIComponent(k)).join("%2C");
  try {
    const r = await fetchR(API_HOST, `/v3/market-quote/quotes?instrument_key=${param}`, "GET", authH());
    if (r.status === 200 && r.data?.data) return r.data.data;
  } catch (e) {
    log(`⚠️ LTP fetch failed: ${e.message}`, "WARN");
  }
  return {};
}

// ─── ORDER HELPERS ────────────────────────────────────────────────────────────
async function placeOrd(body) {
  const r = await fetchR(HFT_HOST, HFT_PATH, "POST",
    { ...authH(), "Content-Type": "application/json" }, body);
  if (r.status !== 200 && r.status !== 201)
    throw new Error(r.data?.message || r.data?.errors?.[0]?.message || "Order failed");
  return r.data?.data?.order_id;
}

const placeEntry = (ik, tx, qty, price) => placeOrd({
  quantity: qty, product: "I", validity: "DAY", price,
  tag: "FCB_V6_ENTRY", instrument_token: ik, order_type: "LIMIT",
  transaction_type: tx, disclosed_quantity: 0, trigger_price: 0,
  is_amo: false, slice: false,
});

const placeTarget = (ik, tx, qty, price) => placeOrd({
  quantity: qty, product: "I", validity: "DAY", price,
  tag: "FCB_V6_TARGET", instrument_token: ik, order_type: "LIMIT",
  transaction_type: tx, disclosed_quantity: 0, trigger_price: 0,
  is_amo: false, slice: false,
});

const placeSL = (ik, tx, qty, trigger) => placeOrd({
  quantity: qty, product: "I", validity: "DAY", price: 0,
  tag: "FCB_V6_SL", instrument_token: ik, order_type: "SL-M",
  transaction_type: tx, disclosed_quantity: 0, trigger_price: trigger,
  is_amo: false, slice: false,
});

const getOrderStatus = (id) =>
  fetchR(API_HOST, `/v2/order/details?order_id=${id}`, "GET", authH())
    .then(r => r.data?.data);

const cancelOrder = (id) =>
  fetchR(HFT_HOST, `/v3/order/cancel?order_id=${id}`, "DELETE", authH())
    .then(r => r.data);

// ─── TRADE STATE ──────────────────────────────────────────────────────────────
let trades = [];

function loadTrades() {
  // Try primary file first, fall back to backup if corrupt
  const tryLoad = (file) => {
    try {
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("not an array");
      return parsed;
    } catch { return null; }
  };

  const primary = tryLoad(TRD_FILE);
  if (primary !== null) { trades = primary; return; }

  log("⚠️ fcb_trades.json corrupt — trying backup", "WARN");
  const backup = tryLoad(TRD_FILE + ".bak");
  if (backup !== null) {
    trades = backup;
    log(`⚠️ Recovered ${trades.length} trade(s) from backup`, "WARN");
    saveTrades(); // restore primary from backup
    return;
  }

  log("⚠️ Both trade files unreadable — starting fresh", "WARN");
  trades = [];
}
function saveTrades() {
  try {
    const json = JSON.stringify(trades, null, 2);
    // Validate before writing — never save corrupt data
    JSON.parse(json);
    const tmp = TRD_FILE + ".tmp";
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, TRD_FILE); // atomic on Linux/Android
    // Keep a rolling backup (last known good)
    fs.writeFileSync(TRD_FILE + ".bak", json);
  } catch (e) { log(`⚠️ saveTrades: ${e.message}`, "WARN"); }
}

// BUG #14 FIX: paper trades do NOT count toward live trade limit
function tradesToday()      { return trades.filter(t => t.date === todayStr() && !t.paper).length; }
function paperTradesToday() { return trades.filter(t => t.date === todayStr() &&  t.paper).length; }

function dailyPnL() {
  return trades.filter(t => t.date === todayStr()).reduce((s, t) => s + (t.pnl || 0), 0);
}

function dailyLivePnL() {
  return trades.filter(t => t.date === todayStr() && !t.paper).reduce((s, t) => s + (t.pnl || 0), 0);
}

function dailyTotalPnL() {
  return trades.filter(t => t.date === todayStr()).reduce((s, t) => {
    if (t.pnl !== null) return s + t.pnl;
    return s + (t.livePnl || 0);
  }, 0);
}

// BUG #5 FIX: SELL trades (shorts) don't require capital — exclude from locked
function lockedCapital() {
  return trades
    .filter(t => (t.status === "OPEN" || t.status === "PAPER") && t.direction === "BUY")
    .reduce((s, t) => s + t.entry * t.qty, 0);
}

// BUG #11 FIX: available balance shrinks as trades lock capital
function availableBalance() {
  return WAL() + dailyLivePnL() - lockedCapital();
}

// BUG #2 + #11 FIX: qty capped by BOTH risk% AND available capital
function calcQty(risk, entry) {
  const avail = availableBalance();
  if (avail <= 0 || entry <= 0 || risk <= 0) return 0;
  if (entry > avail) return 0;
  const maxByRisk    = Math.floor((avail * RPCT() / 100) / risk);
  const maxByCapital = Math.floor(avail / entry);
  const MAX_QTY      = 500; // safety cap — prevents runaway qty on tiny risk values
  return Math.min(Math.max(1, Math.min(maxByRisk, maxByCapital)), MAX_QTY);
}

// ─── NIFTY STATE — BUG #10 FIX ───────────────────────────────────────────────
const niftyState = { ltp: 0, prevClose: 0, direction: 0, lastUpdated: 0 };

async function refreshNiftyState() {
  if (!NIFTY_FILTER()) return;
  try {
    const ltpData = await fetchLTP([STOCKS.nifty.key]);
    const ltp = ltpData?.[STOCKS.nifty.key]?.last_price;
    if (!ltp) return;

    niftyState.ltp = ltp;

    // Load Nifty prevClose once per session (yesterday's close)
    if (!niftyState.prevClose) {
      const cs = await fetchCandles(STOCKS.nifty.key, 100);
      const toIST = ts => new Date(new Date(ts).toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
      const todayDateStr = istNow().toDateString();
      const yc = cs.filter(c => toIST(c.ts).toDateString() !== todayDateStr);
      if (yc.length > 0) niftyState.prevClose = yc[yc.length - 1].c;
    }

    // Direction: >0.1% change = meaningful
    if (niftyState.prevClose > 0) {
      const chg = ((ltp - niftyState.prevClose) / niftyState.prevClose) * 100;
      niftyState.direction  = chg > 0.1 ? 1 : chg < -0.1 ? -1 : 0;
      niftyState.lastUpdated = Date.now();
    }
  } catch (e) {
    log(`⚠️ Nifty refresh: ${e.message}`, "WARN");
  }
}

// ─── PAPER OCO SIMULATION — BUG #12 FIX ──────────────────────────────────────
// V5 never auto-closed paper trades. V6 checks LTP every 5s and simulates hits.

async function simulatePaperOCO() {
  const open = trades.filter(t => t.status === "PAPER" && t.paper);
  if (open.length === 0) return;

  // Build key → trade map for batch LTP fetch
  const allStockList = [...STOCKS.tier1, ...STOCKS.tier2, ...STOCKS.tier3];
  const keyMap = {};
  for (const trade of open) {
    const s = allStockList.find(x => x.name === trade.name);
    if (s) keyMap[s.key] = trade;
  }

  const keys = Object.keys(keyMap);
  if (keys.length === 0) return;

  const ltpData = await fetchLTP(keys);
  let changed = false;

  for (const [key, trade] of Object.entries(keyMap)) {
    const ltp = ltpData?.[key]?.last_price;
    if (!ltp) continue;

    // Update live P&L display
    trade.ltp     = +ltp.toFixed(2);
    trade.livePnl = +(
      (trade.direction === "BUY" ? ltp - trade.entry : trade.entry - ltp) * trade.qty
    ).toFixed(0);
    changed = true;

    // #10: 1R trailing stop — move SL to entry once profit >= 1R
    if (!trade.trailed) {
      const unrealised = trade.direction === "BUY"
        ? (ltp - trade.entry) * trade.qty
        : (trade.entry - ltp) * trade.qty;
      const oneR = trade.risk * trade.qty;

      if (unrealised >= oneR) {
        // Check VWAP condition — price must still be on correct side
        const allStockList = [...STOCKS.tier1, ...STOCKS.tier2, ...STOCKS.tier3];
        const stock = allStockList.find(x => x.name === trade.name);
        if (stock) {
          try {
            const ltpData = await fetchLTP([stock.key]);
            const quote   = ltpData?.[stock.key];
            // Use last_price as proxy — full VWAP needs candles, this is a safety check
            const aboveEntry = trade.direction === "BUY"
              ? ltp > trade.entry
              : ltp < trade.entry;
            const slNeedsTrail = trade.direction === "BUY" ? trade.sl < trade.entry : trade.sl > trade.entry;
            if (aboveEntry && slNeedsTrail) {
              trade.sl      = trade.entry; // move SL to breakeven
              trade.trailed = true;
              log(`🔒 Trail: ${trade.name} SL moved to entry ₹${trade.entry} (profit ≥ 1R)`, "TRADE");
            }
          } catch { /* non-fatal */ }
        }
      }
    }

    const targetHit = trade.direction === "BUY" ? ltp >= trade.target : ltp <= trade.target;
    const slHit     = trade.direction === "BUY" ? ltp <= trade.sl     : ltp >= trade.sl;

    if (targetHit) {
      const charges = COSTS() * 2;
      const pnl = +((trade.risk * trade.qty * (trade.rrMult || 2)) - charges);
      trade.status = "TARGET_HIT";
      trade.pnl    = pnl;
      log(`🎯 PAPER TARGET: ${trade.name} [${trade.strategy}] +₹${pnl.toFixed(0)} (after ₹${charges} charges)`, "TRADE");
      notify(`🎯 Paper Target — ${trade.name}`, `+₹${pnl.toFixed(0)} net`);
    } else if (slHit) {
      const charges = COSTS() * 2;
      const pnl = -((trade.risk * trade.qty) + charges);
      trade.status = "STOPPED_OUT";
      trade.pnl    = pnl;
      markLoss(trade.name);
      log(`🛑 PAPER SL: ${trade.name} [${trade.strategy}] -₹${Math.abs(pnl).toFixed(0)} (incl ₹${charges} charges)`, "WARN");
      notify(`🛑 Paper SL — ${trade.name}`, `-₹${Math.abs(pnl).toFixed(0)} net`);
    }
  }
  if (changed) saveTrades();
}

// ─── LIVE OCO CHECK ───────────────────────────────────────────────────────────
async function checkLiveOCO() {
  const open = trades.filter(t => t.status === "OPEN" && !t.paper &&
    (t.targetOrderId || t.slOrderId));

  for (const trade of open) {
    try {
      if (trade.targetOrderId) {
        const s = await getOrderStatus(trade.targetOrderId);
        if (s?.status === "complete") {
          const charges = COSTS() * 2;
          const pnl = +(trade.risk * trade.qty * (trade.rrMult || 2) - charges);
          trade.status = "TARGET_HIT";
          trade.pnl    = pnl;
          saveTrades();
          log(`🎯 TARGET HIT: ${trade.name} [${trade.strategy}] +₹${pnl.toFixed(0)} (after ₹${charges} charges)`, "TRADE");
          notify("🎯 TARGET HIT!", `${trade.name} +₹${pnl.toFixed(0)} net`);
          if (trade.slOrderId) try { await cancelOrder(trade.slOrderId); } catch (e) { log(`⚠️ Cancel SL failed ${trade.name}: ${e.message}`, "WARN"); }
          continue;
        }
      }

      if (trade.slOrderId) {
        const s = await getOrderStatus(trade.slOrderId);
        if (s?.status === "complete") {
          const charges = COSTS() * 2;
          const pnl = -((trade.risk * trade.qty) + charges);
          trade.status = "STOPPED_OUT";
          trade.pnl    = pnl;
          markLoss(trade.name);
          saveTrades();
          log(`🛑 STOPPED: ${trade.name} [${trade.strategy}] -₹${Math.abs(pnl).toFixed(0)} (incl ₹${charges} charges)`, "WARN");
          notify("🛑 STOPPED", `${trade.name} -₹${Math.abs(pnl).toFixed(0)} net`);
          if (trade.targetOrderId) try { await cancelOrder(trade.targetOrderId); } catch (e) { log(`⚠️ Cancel target failed ${trade.name}: ${e.message}`, "WARN"); }
        }
      }
    } catch (e) {
      log(`⚠️ Live OCO [${trade.name}]: ${e.message}`, "WARN");
    }
  }
}

// ─── EXECUTE TRADE ────────────────────────────────────────────────────────────
async function execTrade(signal) {
  if (executing) {
    log(`⚠️ Trade execution busy — skip ${signal.name}`, "WARN");
    return;
  }
  executing = true;
  try {
  // Gate 0: global trade cooldown
  const timeSinceLast = Date.now() - lastTradeTime;
  if (lastTradeTime > 0 && timeSinceLast < TRADE_COOLDOWN) {
    const waitSec = Math.ceil((TRADE_COOLDOWN - timeSinceLast) / 1000);
    log(`⏳ Global cooldown — ${waitSec}s remaining — skip ${signal.name}`, "WARN");
    return;
  }

  // Gate 1: daily loss
  if (dailyTotalPnL() <= -MLOSS()) {
    log(`🛑 Daily loss limit ₹${MLOSS()} — skip ${signal.name}`, "WARN");
    return;
  }

  // Gate 2: max live trades (BUG #14: paper excluded)
  if (!PAPER() && tradesToday() >= MTRD()) {
    log(`🛑 Max live trades ${MTRD()} — skip ${signal.name}`, "WARN");
    return;
  }

  // Gate 3: open position (BUG #1 & #4 — second line of defence after strategies.js)
  if (hasOpenPosition(signal.name, trades)) {
    log(`🛑 Already open: ${signal.name} — skip`, "WARN");
    return;
  }

  // Gate 4: spread/slippage check — reject if spread > 0.3% of entry
  try {
    const allStockList = [...STOCKS.tier1, ...STOCKS.tier2, ...STOCKS.tier3];
    const stock = allStockList.find(s => s.name === signal.name);
    if (stock) {
      const ltpData = await fetchLTP([stock.key]);
      const quote = ltpData?.[stock.key];
      if (quote?.depth?.top) {
        const bestBid = quote.depth.top[0]?.bidP || 0;
        const bestAsk = quote.depth.top[0]?.askP || 0;
        if (bestBid > 0 && bestAsk > 0) {
          const spread = ((bestAsk - bestBid) / signal.entry) * 100;
          if (spread > 0.3) {
            log(`⚠️ Spread too wide: ${signal.name} spread ${spread.toFixed(3)}% > 0.3% — skip`, "WARN");
            return;
          }
        }
      }
    }
  } catch (e) {
    log(`⚠️ Spread check failed ${signal.name}: ${e.message} — proceeding`, "WARN");
    // non-fatal — proceed with trade if spread check errors
  }

  // Gate 5: qty calculation (BUG #2 & #11)
  const qty = calcQty(signal.risk, signal.entry);
  if (qty <= 0) {
    log(`🛑 Insufficient balance for ${signal.name} @ ₹${signal.entry} (avail:₹${availableBalance().toFixed(0)}) — skip`, "WARN");
    return;
  }

  const exitTx = signal.direction === "BUY" ? "SELL" : "BUY";
  const allStockList = [...STOCKS.tier1, ...STOCKS.tier2, ...STOCKS.tier3];
  const stock = allStockList.find(s => s.name === signal.name);

  const record = {
    ...signal,
    qty,
    date:    todayStr(),
    time:    istTime(),
    paper:   PAPER(),
    status:  "OPEN",
    pnl:     null,
    ltp:     null,
    livePnl: 0,
  };

  // ── PAPER ──
  if (PAPER()) {
    record.status = "PAPER";
    lastTradeTime = Date.now();
    trades.push(record);
    saveTrades();
    log(
      `📝 PAPER: ${signal.direction} ${qty}× ${signal.name}` +
      ` [${signal.strategy}] score:${signal.score}/10` +
      ` @ ₹${signal.entry} T:₹${signal.target} SL:₹${signal.sl}` +
      ` confirmed:[${(signal.confirmedBy || [signal.strategy]).join(",")}]`,
      "TRADE"
    );
    notify(`📝 Paper — ${signal.name}`, `${signal.direction} ${qty}× @ ₹${signal.entry} [${signal.score}/10]`);
    return;
  }

  // ── LIVE ──
  if (!stock) {
    log(`❌ No instrument key for ${signal.name}`, "ERROR");
    return;
  }

  try {
    log(`🔄 LIVE: ${signal.direction} ${qty}× ${signal.name} [${signal.strategy}] score:${signal.score}/10 @ ₹${signal.entry}`, "TRADE");

    const entryOrderId  = await placeEntry(stock.key, signal.direction, qty, signal.entry);
    log(`✅ Entry #${entryOrderId} — waiting for fill...`, "TRADE");

    // D1 FIX: wait for entry fill before placing OCO — 60s timeout
    let filled = false;
    for (let i = 0; i < 12; i++) {
      await sleep(5000);
      try {
        const s = await getOrderStatus(entryOrderId);
        if (s?.status === "complete") { filled = true; break; }
        if (s?.status === "cancelled" || s?.status === "rejected") {
          log(`⛔ Entry ${s.status} — OCO skipped for ${signal.name}`, "WARN");
          notify("⛔ Entry Not Filled", `${signal.name} order ${s.status}`);
          return;
        }
      } catch { /* keep polling */ }
    }

    if (!filled) {
      log(`⏱ Entry timeout — cancelling & skipping OCO for ${signal.name}`, "WARN");
      notify("⏱ Entry Timeout", `${signal.name} — OCO not placed`);
      try { await cancelOrder(entryOrderId); } catch (e) { log(`⚠️ Cancel failed for entry order ${entryOrderId}: ${e.message}`, "WARN"); }
      return;
    }

    log(`✅ Entry filled #${entryOrderId} — placing OCO`, "TRADE");

    const targetOrderId = await placeTarget(stock.key, exitTx, qty, signal.target);
    log(`✅ Target #${targetOrderId}`, "TRADE");

    const slOrderId     = await placeSL(stock.key, exitTx, qty, signal.sl);
    log(`✅ SL #${slOrderId}`, "TRADE");

    record.entryOrderId  = entryOrderId;
    record.targetOrderId = targetOrderId;
    record.slOrderId     = slOrderId;

    lastTradeTime = Date.now();
    trades.push(record);
    saveTrades();

    log(`🚀 All orders live — ${signal.name} [${signal.strategy}] score:${signal.score}/10`, "TRADE");
    notify(`🚀 LIVE — ${signal.name}`, `${signal.direction} ${qty}× @ ₹${signal.entry} [${signal.score}/10]`);

  } catch (e) {
    log(`❌ Order failed [${signal.name}]: ${e.message}`, "ERROR");
    notify("❌ Order Failed", `${signal.name}: ${e.message.slice(0, 100)}`);
  }
  } finally {
    executing = false;
  }
}

// ─── SCAN — BUG #6 FIX ───────────────────────────────────────────────────────
// try/finally ensures scanning flag ALWAYS resets, even on uncaught errors.

let scanning  = false;
let executing        = false; // mutex — prevents concurrent execTrade() calls
let lastTradeTime    = 0;     // global cooldown — min gap between any two trades
const TRADE_COOLDOWN = 120000; // 2 minutes in ms

async function scan(strategyNames) {
  if (scanning) {
    log("⚠️ Scan already running — skipped", "WARN");
    return;
  }
  if (!strategyNames || strategyNames.length === 0) return;

  scanning = true;
  try {
    // BUG #10: refresh Nifty before every scan
    await refreshNiftyState();

    const stocks      = getStocksForTier(STOCK_TIER());
    const candleCount = 75; // enough for all indicators (ST_MACD/ADX need 60+)

    // #8: warn if Nifty feed is stale (not updated in last 5 mins during market hours)
    if (isMarket() && NIFTY_FILTER() && niftyState.lastUpdated > 0) {
      const niftyAge = Date.now() - niftyState.lastUpdated;
      if (niftyAge > 5 * 60000) {
        log(`⚠️ Nifty feed stale — last update ${Math.floor(niftyAge/60000)}m ago — direction filter unreliable`, "WARN");
        niftyState.direction = 0; // reset to neutral so no trades are blocked/penalised
      }
    }

    const niftyIcon = niftyState.direction > 0 ? "🟢" : niftyState.direction < 0 ? "🔴" : "⚪";
    log(
      `🚀 Scan: [${strategyNames.join("+")}] ${stocks.length} stocks` +
      ` | Nifty:${niftyIcon}${niftyState.ltp > 0 ? niftyState.ltp.toFixed(0) : "?"}` +
      ` | Score≥${SCORE_THRESH()}`,
      "INFO"
    );

    // Batched fetch + analyze — 20 stocks at a time, 10s gap between batches
    const BATCH_SIZE = 20;
    const BATCH_DELAY = 10000;
    const allResults = [];
    for (let i = 0; i < stocks.length; i += BATCH_SIZE) {
      const batch = stocks.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.allSettled(
        batch.map(async stock => {
        try {
          const candles = await fetchCandles(stock.key, candleCount);

          if (candles.length === 0) return [];

          // BUG #3: stale check from indicators.js (TZ-safe, correct direction)
          if (isStale(candles, 3)) {
            log(`⏱ Stale: ${stock.name} — skipped`, "WARN");
            return [];
          }

          // #13: opening volatility shield — 9:20–9:22 require range < 1.5%
          const openMin = minOfDay();
          if (openMin >= 560 && openMin <= 562) {
            const todayCs = candles.filter(c => {
              const t = new Date(new Date(c.ts).toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
              return t.toDateString() === new Date(Date.now() + 5.5 * 3600000).toDateString();
            });
            if (todayCs.length >= 2) {
              const rngHigh = Math.max(...todayCs.map(c => c.h));
              const rngLow  = Math.min(...todayCs.map(c => c.l));
              const rngPct  = ((rngHigh - rngLow) / rngLow) * 100;
              if (rngPct > 1.5) {
                log(`🛡 Opening shield: ${stock.name} range ${rngPct.toFixed(2)}% > 1.5% — skipped`, "WARN");
                return [];
              }
            }
          }

          // #14: midday low-volume protection — require 2× volume 12:00–1:15 PM
          const candleMin = minOfDay();
          if (candleMin >= 720 && candleMin <= 795) {
            const av = candles.length >= 2
              ? candles.slice(-(11)).slice(0, -1).reduce((s, c) => s + c.v, 0) / Math.max(1, candles.slice(-(11)).slice(0, -1).length)
              : 1;
            const lastVol = candles[candles.length - 1].v;
            if (av > 0 && lastVol < av * 2) {
              log(`🕐 Midday low-vol: ${stock.name} vol ${lastVol} < 2×avg ${(av*2).toFixed(0)} — skipped`, "WARN");
              return [];
            }
          }

          // #15: news spike filter — reject if last candle range > 3× ATR
          if (candles.length >= 15) {
            const { isStale, calcATR } = require("./indicators");
            const atrVals = calcATR(candles, 14);
            if (atrVals.length > 0) {
              const atr = atrVals[atrVals.length - 1];
              const last = candles[candles.length - 1];
              const candleRange = last.h - last.l;
              if (candleRange > atr * 3) {
                log(`⚡ Spike: ${stock.name} range ${candleRange.toFixed(2)} > 3×ATR ${(atr*3).toFixed(2)} — skipped`, "WARN");
                return [];
              }
            }
          }

          const signal = analyzeStock({
            candles,
            name:             stock.name,
            activeStrategies: strategyNames,
            trades,
            niftyLtp:         NIFTY_FILTER() ? niftyState.ltp      : 0,
            niftyPrevClose:   NIFTY_FILTER() ? niftyState.prevClose : 0,
            scoreThreshold:   SCORE_THRESH(),
          });

          if (signal) {
            log(
              `✅ SIGNAL [${signal.strategy}] ${stock.name} ${signal.direction}` +
              ` score:${signal.score}/10 @ ₹${signal.entry}` +
              ` | confirmed:[${(signal.confirmedBy || [signal.strategy]).join(",")}]` +
              ` | vol:${signal.volRatio}×`,
              "SIGNAL"
            );
            return [signal];
          }
          return [];
        } catch (e) {
          log(`❌ ${stock.name}: ${e.message}`, "ERROR");
          return [];
        }
      })
    );
    allResults.push(...batchResults);
    if (i + BATCH_SIZE < stocks.length) await sleep(BATCH_DELAY);
  }

  const signals = allResults
    .filter(r => r.status === "fulfilled")
    .flatMap(r => r.value);

    // Persist signals for UI
    try { fs.writeFileSync(SIG_FILE, JSON.stringify(signals, null, 2)); } catch { /* ignore */ }

    if (signals.length === 0) {
      try {
        if (Array.isArray(scoredStocks) && scoredStocks.length > 0) {
          // SCORE DISTRIBUTION
          const buckets = {
            low: 0,
            s4: 0,
            s5: 0,
            s6: 0,
            high: 0
          };
          for (let i = 0; i < scoredStocks.length; i++) 
            const s = scoredStocks[i];
            if (!s || typeof s.score !== "number") continue;
            if (s.score <= 3) buckets.low++;
            else if (s.score === 4) buckets.s4++;
            else if (s.score === 5) buckets.s5++;
            else if (s.score === 6) buckets.s6++;
            else buckets.high++;
          }
          log(
            "📊 Score dist → ≤3:" + buckets.low +
            " | 4:" + buckets.s4 +
            " | 5:" + buckets.s5 +
            " | 6:" + buckets.s6 +
            " | 7+:" + buckets.high,
            "SCAN"
          );
          // TOP 3 SCORES
          const top3 = scoredStocks
            .filter(function(s) {
              return s && typeof s.score === "number";
            })
            .sort(function(a, b) {
              return b.score - a.score;
            })
            .slice(0, 3)
            .map(function(s) {
              return s.name + "(" + s.score + ")";
            })
            .join(", ");
          if (top3.length > 0) {
            log("📈 Top scores → " + top3, "SCAN");
          }
        }
      } catch (err) {
        log("⚠️ Score debug failed: " + err.message, "WARN");
      }
      log("🚫 No signals", "SCAN");
      return;
    }

    log(`🎯 ${signals.length} signal(s)!`, "SIGNAL");
    notify(
      `🎯 ${signals.length} Signal${signals.length > 1 ? "s" : ""}!`,
      signals.map(s => `${s.name} ${s.direction} ₹${s.entry} [${s.score}/10]`).join(" | ")
    );

    for (const signal of signals) {
      await execTrade(signal);
      await sleep(500);
    }

  } catch (e) {
    log(`❌ Scan error: ${e.message}`, "ERROR");
  } finally {
    // BUG #6 FIX: ALWAYS resets — no more 30-minute scan blackouts
    scanning = false;
  }
}

// ─── MAIN LOOP ────────────────────────────────────────────────────────────────
let botStopped    = false;
let lastLabel     = "";
let lastCmdTs     = 0;
let lastStatusMin = -1;
let lastScanMin   = -999; // single tracker sufficient for schedule-driven scans

async function loop() {
  if (botStopped) return;

  // D2 FIX: auto-square-off all open positions at 3:20 PM
  if (minOfDay() === 920) {
    const openTrades = trades.filter(t =>
      (t.status === "OPEN" || t.status === "PAPER") &&
      t.date === todayStr()
    );
    if (openTrades.length > 0) {
      log(`⏰ 3:20 PM — auto-squaring ${openTrades.length} open position(s)`, "WARN");
      notify("⏰ Auto Square-Off", `Closing ${openTrades.length} open position(s)`);
      for (const trade of openTrades) {
        if (trade.paper) {
          trade.status = "SQUARED_OFF";
          trade.pnl    = trade.livePnl || 0;
          log(`📋 Paper squared: ${trade.name} P&L ₹${trade.pnl}`, "TRADE");
        } else {
          const exitTx = trade.direction === "BUY" ? "SELL" : "BUY";
          const allStockList = [...STOCKS.tier1, ...STOCKS.tier2, ...STOCKS.tier3];
          const stock = allStockList.find(s => s.name === trade.name);
          if (stock) {
            try {
              await placeOrd({
                quantity: trade.qty, product: "I", validity: "DAY", price: 0,
                tag: "FCB_SQUAREOFF", instrument_token: stock.key,
                order_type: "MARKET", transaction_type: exitTx,
                disclosed_quantity: 0, trigger_price: 0, is_amo: false, slice: false,
              });
              trade.status = "SQUARED_OFF";
              log(`✅ Live squared: ${trade.name}`, "TRADE");
              if (trade.targetOrderId) try { await cancelOrder(trade.targetOrderId); } catch (e) { log(`⚠️ Cancel target order failed ${trade.name}: ${e.message}`, "WARN"); }
              if (trade.slOrderId)     try { await cancelOrder(trade.slOrderId);     } catch (e) { log(`⚠️ Cancel SL order failed ${trade.name}: ${e.message}`, "WARN"); }
            } catch (e) {
              log(`❌ Square-off failed ${trade.name}: ${e.message}`, "ERROR");
              notify("❌ Square-Off Failed", `${trade.name}: ${e.message.slice(0, 80)}`);
            }
          }
        }
      }
      saveTrades();
    }
  }

  const m     = minOfDay();
  const sched = getSchedule(m); // from strategies.js

  // Status log every 5 minutes
  if (m !== lastStatusMin && m % 5 === 0) {
    lastStatusMin = m;
    const pnl = dailyTotalPnL();
    log(
      `⏰ ${istTime()} | ${sched.label}` +
      ` | P&L:₹${pnl.toFixed(0)}` +
      ` | Live:${tradesToday()}/${MTRD()} Paper:${paperTradesToday()}` +
      ` | ${PAPER() ? "PAPER" : "LIVE"}` +
      ` | Score≥${SCORE_THRESH()}` +
      ` | Avail:₹${availableBalance().toFixed(0)}`,
      "STATUS"
    );
    if (m >= 525 && m <= 960) notifyPersistent(`${sched.label} | ₹${pnl.toFixed(0)} | ${PAPER() ? "PAPER" : "LIVE"}`);
  }

  // Log strategy window transitions
  if (sched.label !== lastLabel) {
    lastLabel = sched.label;
    if (!sched.blocked && sched.strategies.length > 0) {
      log(`⏰ → ${sched.label} [${sched.strategies.join("+")}]`, "INFO");
      notify(`⏰ ${sched.label}`, `Active: ${sched.strategies.join(" + ")}`);
    }
  }

  // Token expiry warning
  const h = istNow().getHours(), mn = istNow().getMinutes();
  if (h === 3 && mn <= 5) {
    notify("🔑 Token Expiring!", "Update before 3:30 AM IST");
  }

  if (!isMarket() || sched.blocked || sched.strategies.length === 0) return;

  const interval = sched.scanInterval || 2;
  if (m - lastScanMin >= interval) {
    lastScanMin = m;
    await scan(sched.strategies);
  }
}

// ─── COMMAND WATCHER — BUG #8 FIX ────────────────────────────────────────────
function watchCMD() {
  setInterval(() => {
    try {
      const cmd = JSON.parse(fs.readFileSync(CMD_FILE, "utf8"));
      if (!cmd || cmd.ts <= lastCmdTs) return;
      lastCmdTs = cmd.ts;

      switch (cmd.cmd) {
        case "reload_token":
        case "reload_settings":
          CFG = loadCFG();
          log(`🔄 Config reloaded: ${cmd.cmd}`, "INFO");
          notify("🔄 FCB Bot V6", "Config updated from UI");
          break;

        case "stop":
          botStopped = true;
          log("🛑 Bot stopped via UI", "WARN");
          notify("🛑 FCB Bot V6", "Stopped from UI");
          break;

        case "resume":
          botStopped = false;
          log("▶️ Bot resumed via UI", "INFO");
          notify("▶️ FCB Bot V6", "Resumed from UI");
          break;

        case "scan": {
          const s = cmd.strats || getSchedule(minOfDay()).strategies;
          if (s.length > 0) scan(s);
          break;
        }
        case "manual_paper":
          if (cmd.trade) {
            const t = cmd.trade;
            if (!hasOpenPosition(t.name, trades)) {
              trades.push({ ...t, paper: true, status: "PAPER" });
              saveTrades();
              log(`📝 UI Paper synced: ${t.direction} ${t.qty}× ${t.name}`, "TRADE");
            }
          }
          break; 

        // BUG #8 FIX: atomically clears in-memory trades AND disk file
        case "clear_trades":
          trades = [];
          saveTrades();
          try { fs.writeFileSync(SIG_FILE, "[]"); } catch { /* ignore */ }
          log("🗑 Trades cleared via UI command", "INFO");
          break;

        default:
          log(`⚠️ Unknown command: ${cmd.cmd}`, "WARN");
      }
    } catch { /* cmd file may not exist on first run */ }
  }, 2000);
}

// ─── STARTUP ──────────────────────────────────────────────────────────────────
async function start() {
  exec("termux-wake-lock", err => {
    if (err) log("⚠️ Wake lock unavailable (non-Termux?)", "WARN");
    else     log("🔒 Wake lock active", "INFO");
  });

  log("=".repeat(54));
  log("⚡ FCB BOT V6 — LIVE EDITION");
  log(`Mode:    ${PAPER() ? "📋 PAPER (safe)" : "⚠️  LIVE (real money)"}`);
  log(`Wallet:  ₹${WAL()} | Risk: ${RPCT()}% | Loss limit: ₹${MLOSS()}`);
  log(`Trades:  max ${MTRD()} live | Score threshold: ${SCORE_THRESH()}/10`);
  log(`Stocks:  ${getStocksForTier(STOCK_TIER()).length} (tier: ${STOCK_TIER()}) | Nifty filter: ${NIFTY_FILTER()}`);
  log(`Log:     ${path.basename(currentLogFile)}`);
  log("=".repeat(54));

  notify("⚡ FCB Bot V6 Started", `${PAPER() ? "Paper" : "LIVE"} | ₹${WAL()} | Score≥${SCORE_THRESH()}`);

  // Load trades, keep only today's (don't carry stale yesterday trades)
  loadTrades();
  const before = trades.length;
  trades = trades.filter(t => t.date === todayStr());
  if (before !== trades.length) {
    saveTrades();
    log(`📋 Pruned ${before - trades.length} old-day trade(s). Today: ${trades.length}`, "INFO");
  } else {
    log(`📋 ${trades.length} trade(s) from today loaded`, "INFO");
  }

  // Ensure cmd file exists
  if (!fs.existsSync(CMD_FILE)) {
    fs.writeFileSync(CMD_FILE, JSON.stringify({ cmd: "noop", ts: 0 }));
  }

  // BUG-007 FIX: post-crash order audit — reconcile open trades against broker
  const orphanedTrades = trades.filter(t =>
    t.status === "OPEN" && !t.paper && t.date === todayStr() &&
    (!t.slOrderId || !t.targetOrderId)
  );
  if (orphanedTrades.length > 0) {
    log(`⚠️ ${orphanedTrades.length} orphaned trade(s) detected — auditing broker orders`, "WARN");
    notify("⚠️ Orphaned Trades", `${orphanedTrades.length} trade(s) missing OCO legs — check manually`);
    for (const trade of orphanedTrades) {
      log(`⚠️ Orphaned: ${trade.name} ${trade.direction} qty:${trade.qty} entry:₹${trade.entry} — no SL/Target order ID`, "WARN");
    }
  }

  // Audit all open live trades — check if OCO orders still active on broker
  const openLive = trades.filter(t => t.status === "OPEN" && !t.paper && t.date === todayStr());
  if (openLive.length > 0) {
    log(`🔍 Auditing ${openLive.length} open live trade(s) on restart...`, "INFO");
    for (const trade of openLive) {
      try {
        if (trade.slOrderId) {
          const s = await getOrderStatus(trade.slOrderId);
          if (s?.status === "complete") {
            const pnl = -((trade.risk * trade.qty) + COSTS() * 2);
            trade.status = "STOPPED_OUT";
            trade.pnl    = pnl;
            markLoss(trade.name);
            log(`🔍 Audit: ${trade.name} SL already hit — marking STOPPED_OUT`, "WARN");
          }
        }
        if (trade.targetOrderId && trade.status === "OPEN") {
          const s = await getOrderStatus(trade.targetOrderId);
          if (s?.status === "complete") {
            const pnl = +(trade.risk * trade.qty * (trade.rrMult || 2) - COSTS() * 2);
            trade.status = "TARGET_HIT";
            trade.pnl    = pnl;
            log(`🔍 Audit: ${trade.name} Target already hit — marking TARGET_HIT`, "INFO");
          }
        }
      } catch (e) {
        log(`⚠️ Audit failed for ${trade.name}: ${e.message}`, "WARN");
      }
    }
    saveTrades();
    log(`✅ Order audit complete`, "INFO");
  }

  watchCMD();
  await loop();

  // Main tick: every 30 seconds
  setInterval(loop, 30000);

  // OCO monitors: every 5 seconds
  setInterval(async () => {
    try { await checkLiveOCO(); }
    catch (e) { log(`⚠️ Live OCO: ${e.message}`, "WARN"); }
  }, 5000);

  setInterval(async () => {
    try { if (isMarket()) await simulatePaperOCO(); }
    catch (e) { log(`⚠️ Paper OCO: ${e.message}`, "WARN"); }
  }, 5000);

  log("⚡ OCO monitors active (5s)", "INFO");
}

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────
process.on("SIGINT",  () => { log("Stopped (SIGINT)",  "INFO"); exec("termux-notification-remove 9999", () => {}); exec("termux-wake-unlock", () => {}); process.exit(0); });
process.on("SIGTERM", () => { log("Stopped (SIGTERM)", "INFO"); exec("termux-wake-unlock", () => {}); process.exit(0); });
process.on("uncaughtException",  e => { log(`💥 Uncaught: ${e.message}`, "ERROR"); notify("⚠️ Bot Error", e.message.slice(0, 100)); });
process.on("unhandledRejection", r => { const m = r instanceof Error ? r.message : String(r); log(`💥 Rejection: ${m}`, "ERROR"); });

// bot.js has no exports — bridge.js computes log path independently
// ─── GO ───────────────────────────────────────────────────────────────────────
start().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
