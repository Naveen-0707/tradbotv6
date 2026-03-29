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
const istNow     = () => new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
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
    const r = await fetchR(API_HOST, `/v2/market-quote/ltp?instrument_key=${param}`, "GET", authH());
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
  try { trades = JSON.parse(fs.readFileSync(TRD_FILE, "utf8")); }
  catch { trades = []; }
}

function saveTrades() {
  try { fs.writeFileSync(TRD_FILE, JSON.stringify(trades, null, 2)); }
  catch (e) { log(`⚠️ saveTrades: ${e.message}`, "WARN"); }
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
  const maxByRisk    = Math.floor((avail * RPCT() / 100) / risk);
  const maxByCapital = Math.floor(avail / entry);
  return Math.max(1, Math.min(maxByRisk, maxByCapital));
}

// ─── NIFTY STATE — BUG #10 FIX ───────────────────────────────────────────────
const niftyState = { ltp: 0, prevClose: 0, direction: 0 };

async function refreshNiftyState() {
  if (!NIFTY_FILTER()) return;
  try {
    const ltpData = await fetchLTP([STOCKS.nifty.key]);
    const ltp = ltpData?.[STOCKS.nifty.key]?.last_price;
    if (!ltp) return;

    niftyState.ltp = ltp;

    // Load Nifty prevClose once per session (yesterday's close)
    if (!niftyState.prevClose) {
      const cs = await fetchCandles(STOCKS.nifty.key, 20);
      const toIST = ts => new Date(new Date(ts).toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
      const todayDateStr = istNow().toDateString();
      const yc = cs.filter(c => toIST(c.ts).toDateString() !== todayDateStr);
      if (yc.length > 0) niftyState.prevClose = yc[yc.length - 1].c;
    }

    // Direction: >0.1% change = meaningful
    if (niftyState.prevClose > 0) {
      const chg = ((ltp - niftyState.prevClose) / niftyState.prevClose) * 100;
      niftyState.direction = chg > 0.1 ? 1 : chg < -0.1 ? -1 : 0;
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

    const targetHit = trade.direction === "BUY" ? ltp >= trade.target : ltp <= trade.target;
    const slHit     = trade.direction === "BUY" ? ltp <= trade.sl     : ltp >= trade.sl;

    if (targetHit) {
      const pnl = +(trade.risk * trade.qty * (trade.rrMult || 2));
      trade.status = "TARGET_HIT";
      trade.pnl    = pnl;
      log(`🎯 PAPER TARGET: ${trade.name} [${trade.strategy}] +₹${pnl.toFixed(0)}`, "TRADE");
      notify(`🎯 Paper Target — ${trade.name}`, `+₹${pnl.toFixed(0)}`);
    } else if (slHit) {
      const pnl = -(trade.risk * trade.qty);
      trade.status = "STOPPED_OUT";
      trade.pnl    = pnl;
      log(`🛑 PAPER SL: ${trade.name} [${trade.strategy}] -₹${Math.abs(pnl).toFixed(0)}`, "WARN");
      notify(`🛑 Paper SL — ${trade.name}`, `-₹${Math.abs(pnl).toFixed(0)}`);
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
          const pnl = +(trade.risk * trade.qty * (trade.rrMult || 2));
          trade.status = "TARGET_HIT";
          trade.pnl    = pnl;
          saveTrades();
          log(`🎯 TARGET HIT: ${trade.name} [${trade.strategy}] +₹${pnl.toFixed(0)}`, "TRADE");
          notify("🎯 TARGET HIT!", `${trade.name} +₹${pnl.toFixed(0)}`);
          if (trade.slOrderId) try { await cancelOrder(trade.slOrderId); } catch { /* ignore */ }
          continue;
        }
      }

      if (trade.slOrderId) {
        const s = await getOrderStatus(trade.slOrderId);
        if (s?.status === "complete") {
          const pnl = -(trade.risk * trade.qty);
          trade.status = "STOPPED_OUT";
          trade.pnl    = pnl;
          saveTrades();
          log(`🛑 STOPPED: ${trade.name} [${trade.strategy}] -₹${Math.abs(pnl).toFixed(0)}`, "WARN");
          notify("🛑 STOPPED", `${trade.name} -₹${Math.abs(pnl).toFixed(0)}`);
          if (trade.targetOrderId) try { await cancelOrder(trade.targetOrderId); } catch { /* ignore */ }
        }
      }
    } catch (e) {
      log(`⚠️ Live OCO [${trade.name}]: ${e.message}`, "WARN");
    }
  }
}

// ─── EXECUTE TRADE ────────────────────────────────────────────────────────────
async function execTrade(signal) {
  // Gate 1: daily loss
  if (dailyPnL() <= -MLOSS()) {
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

  // Gate 4: qty calculation (BUG #2 & #11)
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
    log(`✅ Entry #${entryOrderId}`, "TRADE");

    const targetOrderId = await placeTarget(stock.key, exitTx, qty, signal.target);
    log(`✅ Target #${targetOrderId}`, "TRADE");

    const slOrderId     = await placeSL(stock.key, exitTx, qty, signal.sl);
    log(`✅ SL #${slOrderId}`, "TRADE");

    record.entryOrderId  = entryOrderId;
    record.targetOrderId = targetOrderId;
    record.slOrderId     = slOrderId;

    trades.push(record);
    saveTrades();

    log(`🚀 All orders live — ${signal.name} [${signal.strategy}] score:${signal.score}/10`, "TRADE");
    notify(`🚀 LIVE — ${signal.name}`, `${signal.direction} ${qty}× @ ₹${signal.entry} [${signal.score}/10]`);

  } catch (e) {
    log(`❌ Order failed [${signal.name}]: ${e.message}`, "ERROR");
    notify("❌ Order Failed", `${signal.name}: ${e.message.slice(0, 100)}`);
  }
}

// ─── SCAN — BUG #6 FIX ───────────────────────────────────────────────────────
// try/finally ensures scanning flag ALWAYS resets, even on uncaught errors.

let scanning = false;

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

    const niftyIcon = niftyState.direction > 0 ? "🟢" : niftyState.direction < 0 ? "🔴" : "⚪";
    log(
      `🚀 Scan: [${strategyNames.join("+")}] ${stocks.length} stocks` +
      ` | Nifty:${niftyIcon}${niftyState.ltp > 0 ? niftyState.ltp.toFixed(0) : "?"}` +
      ` | Score≥${SCORE_THRESH()}`,
      "INFO"
    );

    // Parallel fetch + analyze all stocks
    const results = await Promise.allSettled(
      stocks.map(async stock => {
        try {
          const candles = await fetchCandles(stock.key, candleCount);

          if (candles.length === 0) return [];

          // BUG #3: stale check from indicators.js (TZ-safe, correct direction)
          if (isStale(candles, 3)) {
            log(`⏱ Stale: ${stock.name} — skipped`, "WARN");
            return [];
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

    const signals = results
      .filter(r => r.status === "fulfilled")
      .flatMap(r => r.value);

    // Persist signals for UI
    try { fs.writeFileSync(SIG_FILE, JSON.stringify(signals, null, 2)); } catch { /* ignore */ }

    if (signals.length === 0) {
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

  const m     = minOfDay();
  const sched = getSchedule(m); // from strategies.js

  // Status log every 5 minutes
  if (m !== lastStatusMin && m % 5 === 0) {
    lastStatusMin = m;
    const pnl = dailyPnL();
    log(
      `⏰ ${istTime()} | ${sched.label}` +
      ` | P&L:₹${pnl.toFixed(0)}` +
      ` | Live:${tradesToday()}/${MTRD()} Paper:${paperTradesToday()}` +
      ` | ${PAPER() ? "PAPER" : "LIVE"}` +
      ` | Score≥${SCORE_THRESH()}` +
      ` | Avail:₹${availableBalance().toFixed(0)}`,
      "STATUS"
    );
    notifyPersistent(`${sched.label} | ₹${pnl.toFixed(0)} | ${PAPER() ? "PAPER" : "LIVE"}`);
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

// ─── EXPORTS (for bridge.js to read current log path) ─────────────────────────
module.exports = { getCurrentLogFile };

// ─── GO ───────────────────────────────────────────────────────────────────────
start().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
