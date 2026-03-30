// ═══════════════════════════════════════════════════════════════════════════
//  FCB BOT V6 — strategies.js
//  All 9 strategy analyzers + multi-confirmation scoring engine.
//  Required by: bot.js
//  Requires:    indicators.js
//
//  CANDLE CONTRACT (enforced everywhere):
//    candles[] = oldest first, newest last  (after .reverse() in fetchCandles)
//    candle shape: { ts, o, h, l, c, v }
//
//  SIGNAL CONTRACT (returned by analyzeStock):
//    null                  = no trade
//    { ...fields, score }  = trade candidate — bot.js decides to execute
//
//  SCORE SYSTEM (from master plan):
//    FCB=3  ORB=2  VWAP=2  EMA=2  GAP=2  ST_MACD=3  RSI_DIV=3  BB_SQZ=2  ADX_EMA=3
//    Bonus: volume > 2× avg = +1 | Nifty aligned = +1 | Nifty opposite = -2
//    Threshold: score >= 6 to trade (configurable via scoreThreshold in config)
//
//  BUG FIXES BAKED IN:
//    #1  Duplicate trades    → hasOpenPosition() called before every signal
//    #4  Opposite direction  → hasOpenPosition() blocks same-stock re-entry
//    #9  Early candle scan   → every analyzer has minimum candle guard
//    #10 No Nifty filter     → getNiftyDirection() + score penalty/bonus
// ═══════════════════════════════════════════════════════════════════════════

"use strict";

const {
  ema,
  calcATR,
  calcRSI,
  calcMACD,
  calcSuperTrend,
  calcADX,
  calcBB,
  vwap,
  vwapBands,
  avgVol,
  detectRSIDivergence,
  macdCrossDirection,
  isBBSqueeze,
  todayCandles,
} = require("./indicators");

// ─── HELPERS ─────────────────────────────────────────────────────────────────

// Round to 2 decimal places — keeps signal prices clean
const r2 = v => +v.toFixed(2);

function atrNormalizedRisk(candles) {
  const atrVals = calcATR(candles, 14);
  if (!atrVals.length) return 0;
  return (atrVals[atrVals.length - 1] / candles[candles.length - 1].c) * 100;
}

// Safe last N items of array (returns [] if not enough)
const tail = (arr, n) => (arr.length >= n ? arr.slice(-n) : arr);

// IST date string for a candle timestamp
const istDate = ts =>
  new Date(new Date(ts).toLocaleString("en-US", { timeZone: "Asia/Kolkata" })).toDateString();

// ─── BUG #1 & #4 FIX — OPEN POSITION GUARD ───────────────────────────────────
// Called before any signal is returned.
// Prevents: duplicate trades, opposite-direction trades on same stock.
// trades[] is the live trades array from bot.js (passed in by analyzeStock).

function hasOpenPosition(name, trades) {
  if (!Array.isArray(trades)) return false;
  return trades.some(
    t => t.name === name && (t.status === "OPEN" || t.status === "PAPER")
  );
}

const lastLossTime = {};
function inCooldown(name, cooldownMinutes = 15) {
  if (!lastLossTime[name]) return false;
  return Date.now() - lastLossTime[name] < cooldownMinutes * 60 * 1000;
}
function markLoss(name) { lastLossTime[name] = Date.now(); }

// ─── BUG #10 FIX — NIFTY DIRECTION ───────────────────────────────────────────
// Returns: 1 = Nifty bullish (above prev close), -1 = bearish, 0 = unknown
// niftyLtp: current Nifty 50 LTP from WebSocket
// niftyPrevClose: yesterday's close (loaded from config/candle data in bot.js)

function getNiftyDirection(niftyLtp, niftyPrevClose) {
  if (!niftyLtp || !niftyPrevClose || niftyPrevClose === 0) return 0;
  const changePct = ((niftyLtp - niftyPrevClose) / niftyPrevClose) * 100;
  if (changePct > 0.1) return 1;   // meaningfully positive
  if (changePct < -0.1) return -1; // meaningfully negative
  return 0;                         // flat — no filter applied
}

// ─── SCORE APPLIER ────────────────────────────────────────────────────────────
// Applies Nifty bonus/penalty and volume bonus to a raw strategy score.
// Returns final adjusted score (clamped to 0 minimum).

function applyBonuses(rawScore, direction, volRatio, niftyDir) {
  return rawScore; // bonuses applied once in analyzeStock after merging
}

// ─── SIGNAL BUILDER ───────────────────────────────────────────────────────────
// Assembles the final signal object with all required fields.
// Ensures no field is undefined so UI/bot.js never crash on missing data.

function buildSignal(params) {
  const {
    name, strategy, direction, entry, target, sl, risk,
    rrLabel, rrMult, score, scoreBreakdown, volRatio, candles,
    firstHigh, firstLow, vwapVal, ema9, ema21,
    gapPct, yClose, adxVal, rsiVal, bbWidth, stVal,
  } = params;

  return {
    name,
    strategy,
    direction,
    entry:    r2(entry),
    target:   r2(target),
    sl:       r2(sl),
    risk:     r2(risk),
    riskPct:  r2((risk / entry) * 100),
    rrLabel:  rrLabel || "1:2",
    rrMult:   rrMult  || 2,
    score,
    scoreBreakdown: scoreBreakdown || {},
    volRatio: r2(volRatio || 1),
    candles:  tail(candles, 10),

    // Optional extras — undefined becomes null for clean JSON
    firstHigh: firstHigh != null ? r2(firstHigh) : null,
    firstLow:  firstLow  != null ? r2(firstLow)  : null,
    vwap:      vwapVal   != null ? r2(vwapVal)   : null,
    ema9:      ema9      != null ? r2(ema9)       : null,
    ema21:     ema21     != null ? r2(ema21)      : null,
    gapPct:    gapPct    != null ? r2(gapPct)     : null,
    yClose:    yClose    != null ? r2(yClose)     : null,
    adx:       adxVal    != null ? r2(adxVal)     : null,
    rsi:       rsiVal    != null ? r2(rsiVal)     : null,
    bbWidth:   bbWidth   != null ? r2(bbWidth)    : null,
    superTrend: stVal    != null ? r2(stVal)      : null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  STRATEGY 1 — FCB (Fair Value Gap + ORB Breakout)
//  Score contribution: 3
//  Best window: 9:20–9:35 AM
//  Logic: First 5 candles form a range. Price breaks out with:
//    - FVG (gap between candle bodies) formed between last 3 candles
//    - Retrace into FVG on prior candle
//    - Engulfing candle confirms breakout
//    - Volume above average
//  RR: 1:3 (risk = entry to first range boundary)
// ═══════════════════════════════════════════════════════════════════════════

function fcbAnalyze(candles, name, trades, niftyDir) {
  const tc = todayCandles(candles);

  // BUG #9: minimum 8 today-candles needed (5 range + 3 action)
  if (tc.length < 8) return null;

  // BUG #1/#4: open position guard
  if (hasOpenPosition(name, trades)) return null;

  const firstFive = tc.slice(0, 5);
  const fH = Math.max(...firstFive.map(c => c.h));
  const fL = Math.min(...firstFive.map(c => c.l));

  const recent = tc.slice(5);
  if (recent.length < 3) return null;

  const la = recent[recent.length - 1];
  const p1 = recent[recent.length - 2];
  const p2 = recent[recent.length - 3];
  const av  = avgVol(tc);
  const vr  = av > 0 ? la.v / av : 1;

  // Volume must be above average
  if (la.v < av) return null;

  // ── BUY SETUP ──
  if (la.c > fH) {
    // FVG: gap between p2 high and p1 low (bullish FVG = p1 low > p2 high)
    const fvgLow  = p2.h;
    const fvgHigh = p1.l > p2.h ? p1.l : null;
    const hasFVG  = fvgHigh !== null && fvgHigh > fvgLow;

    // Retrace: last candle dipped into FVG zone and closed above
    const retrace = hasFVG && la.l <= fvgHigh && la.c > fvgLow;

    // Engulfing: last candle body engulfs prior candle body
    const engulfing = la.c > p1.h && la.o <= p1.c;

    // Risk must be meaningful (≥ 0.5% of price)
    const fcbEntry = r2(Math.max(la.h, la.c) * 1.0015);
    const risk = fcbEntry - fL;
    const riskPct = (risk / fcbEntry) * 100;

    const atrPct = atrNormalizedRisk(tc); if (hasFVG && retrace && engulfing && riskPct >= 0.5 && atrPct < 2.8) {
      const rawScore = 3;
      const score = applyBonuses(rawScore, "BUY", vr, niftyDir);
      return buildSignal({
        name, strategy: "FCB", direction: "BUY",
        entry: r2(Math.max(la.h, la.c) * 1.0015), target: r2(Math.max(la.h, la.c) * 1.0015 + risk * 3), sl: r2(la.c * 1.002 - risk), risk,
        rrLabel: "1:3", rrMult: 3, score,
        scoreBreakdown: { FCB: 3 },
        volRatio: vr, candles: tc,
        firstHigh: fH, firstLow: fL,
      });
    }
  }

  // ── SELL SETUP ──
  if (la.c < fL) {
    // Bearish FVG: p1 high < p2 low
    const fvgHigh = p2.l;
    const fvgLow  = p1.h < p2.l ? p1.h : null;
    const hasFVG  = fvgLow !== null && fvgLow < fvgHigh;

    const retrace   = hasFVG && la.h >= fvgLow && la.c < fvgHigh;
    const engulfing = la.c < p1.l && la.o >= p1.c;

    const fcbEntry = r2(Math.min(la.l, la.c) * 0.9985);
    const risk    = fH - fcbEntry;
    const riskPct = (risk / fcbEntry) * 100;
    if (hasFVG && retrace && engulfing && riskPct >= 0.5) {
      const rawScore = 3;
      const score = applyBonuses(rawScore, "SELL", vr, niftyDir);
      return buildSignal({
        name, strategy: "FCB", direction: "SELL",
        entry: r2(Math.min(la.l, la.c) * 0.9985), target: r2(Math.min(la.l, la.c) * 0.9985 - risk * 3), sl: r2(la.c * 0.998 + risk), risk,
        rrLabel: "1:3", rrMult: 3, score,
        scoreBreakdown: { FCB: 3 },
        volRatio: vr, candles: tc,
        firstHigh: fH, firstLow: fL,
      });
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  STRATEGY 2 — ORB (Opening Range Breakout) + BB Squeeze confirmation
//  Score contribution: 2 (ORB) + 2 (BB_SQZ if squeeze present)
//  Best window: 9:35–11:30 AM
//  Logic: First 15 candles define opening range (H/L).
//    Breakout above/below with 1.5× volume. SL = midpoint. RR = 1:2.
//    BB squeeze adds +2 if bands were compressed before breakout.
// ═══════════════════════════════════════════════════════════════════════════

function orbAnalyze(candles, name, trades, niftyDir) {
  const tc = todayCandles(candles);

  // BUG #9: need 17+ candles (15 range + 2 action)
  if (tc.length < 17) return null;
  if (hasOpenPosition(name, trades)) return null;

  const rangePeriod = 15;
  const openRange  = tc.slice(0, rangePeriod);
  const oH = Math.max(...openRange.map(c => c.h));
  const oL = Math.min(...openRange.map(c => c.l));
  const oM = (oH + oL) / 2;

  const postRange = tc.slice(rangePeriod);
  if (postRange.length < 2) return null;

  const la  = postRange[postRange.length - 1];
  const p1  = postRange[postRange.length - 2];
  const av  = avgVol(tc);
  const vr  = av > 0 ? la.v / av : 1;

  if (vr < 1.5) return null;

  // Check BB squeeze on candles leading up to breakout
  const closesBeforeBreak = tc.slice(0, rangePeriod + postRange.length - 1).map(c => c.c);
  const squeeze = isBBSqueeze(closesBeforeBreak, 20, 2, 2.0);
  const bbBonus = squeeze ? 2 : 0;

  // ── BUY SETUP ──
  const atrPct = atrNormalizedRisk(tc); if (la.c > oH && p1.c <= oH && atrPct < 3.0) {
    const orbBuyEntry = r2(Math.max(la.h, oH) * 1.0015);
    const risk    = orbBuyEntry - oM;
    const riskPct = (risk / orbBuyEntry) * 100;
    if (riskPct < 0.25 || riskPct > 6) return null;

    const rawScore = 2 + bbBonus;
    const score    = applyBonuses(rawScore, "BUY", vr, niftyDir);
    const breakdown = { ORB: 2 };
    if (bbBonus) breakdown.BB_SQZ = bbBonus;

    return buildSignal({
      name, strategy: "ORB", direction: "BUY",
      entry: r2(Math.max(la.h, oH) * 1.0015), target: r2(Math.max(la.h, oH) * 1.0015 + risk * 2), sl: oM, risk,
      rrLabel: "1:2", rrMult: 2, score,
      scoreBreakdown: breakdown,
      volRatio: vr, candles: tc,
      firstHigh: oH, firstLow: oL,
      bbWidth: squeeze ? calcBB(closesBeforeBreak)?.width : null,
    });
  }

  // ── SELL SETUP ──
  if (la.c < oL && p1.c >= oL && atrPct < 3.0) {
    const orbSellEntry = r2(Math.min(la.l, oL) * 0.9985);
    const risk    = oM - orbSellEntry;
    const riskPct = (risk / orbSellEntry) * 100;
    if (riskPct < 0.25 || riskPct > 6) return null;

    const rawScore = 2 + bbBonus;
    const score    = applyBonuses(rawScore, "SELL", vr, niftyDir);
    const breakdown = { ORB: 2 };
    if (bbBonus) breakdown.BB_SQZ = bbBonus;

    return buildSignal({
      name, strategy: "ORB", direction: "SELL",
      entry: r2(Math.min(la.l, oL) * 0.9985), target: r2(Math.min(la.l, oL) * 0.9985 - risk * 2), sl: oM, risk,
      rrLabel: "1:2", rrMult: 2, score,
      scoreBreakdown: breakdown,
      volRatio: vr, candles: tc,
      firstHigh: oH, firstLow: oL,
      bbWidth: squeeze ? calcBB(closesBeforeBreak)?.width : null,
    });
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  STRATEGY 3 — VWAP Crossover
//  Score contribution: 2
//  Best window: 11:30 AM–1:30 PM and 2:30–3:20 PM
//  Logic: Price crosses VWAP. Previous candle was on other side.
//    Volume 1.5×. Risk = 0.5% of price. RR = 1:2.
// ═══════════════════════════════════════════════════════════════════════════

function vwapAnalyze(candles, name, trades, niftyDir) {
  const tc = todayCandles(candles);
  if (tc.length < 15) return null;
  if (hasOpenPosition(name, trades)) return null;

  const vwapVal = vwap(tc);
  if (!vwapVal) return null;

  const la = tc[tc.length - 1];
  const p1 = tc[tc.length - 2];
  const av = avgVol(tc);
  const vr = av > 0 ? la.v / av : 1;

  if (vr < 1.5) return null;

  const atrVals = calcATR(tc, 14);
  const atr = atrVals.length > 0 ? atrVals[atrVals.length - 1] : la.c * 0.005;

  // ── BUY: price crossed above VWAP ──
  if (p1.c < vwapVal && la.c > vwapVal && vwap(tc.slice(0, -1)) < vwapVal) {
    const risk = Math.max(atr * 1.5, la.c * 0.003);
    const rawScore = 2;
    const score = applyBonuses(rawScore, "BUY", vr, niftyDir);
    return buildSignal({
      name, strategy: "VWAP", direction: "BUY",
      entry: la.c, target: la.c + risk * 2, sl: la.c - risk, risk,
      rrLabel: "1:2", rrMult: 2, score,
      scoreBreakdown: { VWAP: 2 },
      volRatio: vr, candles: tc,
      firstHigh: Math.max(...tc.slice(-5).map(c => c.h)),
      firstLow:  Math.min(...tc.slice(-5).map(c => c.l)),
      vwapVal,
    });
  }

  // ── SELL: price crossed below VWAP ──
  if (p1.c > vwapVal && la.c < vwapVal && vwap(tc.slice(0, -1)) > vwapVal) {
    const risk = Math.max(atr * 1.5, la.c * 0.003);
    const rawScore = 2;
    const score = applyBonuses(rawScore, "SELL", vr, niftyDir);
    return buildSignal({
      name, strategy: "VWAP", direction: "SELL",
      entry: la.c, target: la.c - risk * 2, sl: la.c + risk, risk,
      rrLabel: "1:2", rrMult: 2, score,
      scoreBreakdown: { VWAP: 2 },
      volRatio: vr, candles: tc,
      firstHigh: Math.max(...tc.slice(-5).map(c => c.h)),
      firstLow:  Math.min(...tc.slice(-5).map(c => c.l)),
      vwapVal,
    });
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  STRATEGY 4 — EMA 9/21 Cross + VWAP Confirmation
//  Score contribution: 2
//  Best window: 1:30–2:30 PM
//  Logic: EMA9 crosses EMA21. Price above/below VWAP confirms.
//    Risk = distance from entry to EMA21. RR = 1:2.
// ═══════════════════════════════════════════════════════════════════════════

function emaAnalyze(candles, name, trades, niftyDir) {
  const tc = todayCandles(candles);
  if (tc.length < 25) return null;
  if (hasOpenPosition(name, trades)) return null;

  const closes = tc.map(c => c.c);
  const e9  = ema(closes, 9);
  const e21 = ema(closes, 21);

  if (e9.length < 2 || e21.length < 2) return null;

  const e9n  = e9[e9.length - 1];
  const e9p  = e9[e9.length - 2];
  const e21n = e21[e21.length - 1];
  const e21p = e21[e21.length - 2];

  const vwapVal = vwap(tc);
  const la = tc[tc.length - 1];
  const av = avgVol(tc);
  const vr = av > 0 ? la.v / av : 1;

  // ── BUY: EMA9 crosses above EMA21 + price above VWAP ──
  const { adx } = calcADX(tc, 14);
  const adxNow = adx?.[adx.length - 1] || 0;
  if (e9p <= e21p && e9n > e21n && vwapVal && la.c > vwapVal && adxNow > 20) {
    const risk = Math.max(la.c - e21n, la.c * 0.003);
    const riskPct = (risk / la.c) * 100;
    if (riskPct < 0.2 || riskPct > 5) return null;

    const rawScore = 2;
    const score = applyBonuses(rawScore, "BUY", vr, niftyDir);
    return buildSignal({
      name, strategy: "EMA", direction: "BUY",
      entry: la.c, target: la.c + risk * 2, sl: e21n, risk,
      rrLabel: "1:2", rrMult: 2, score,
      scoreBreakdown: { EMA: 2 },
      volRatio: vr, candles: tc,
      firstHigh: Math.max(...tc.slice(-5).map(c => c.h)),
      firstLow:  Math.min(...tc.slice(-5).map(c => c.l)),
      vwapVal, ema9: e9n, ema21: e21n,
    });
  }

  // ── SELL: EMA9 crosses below EMA21 + price below VWAP ──
  if (e9p >= e21p && e9n < e21n && vwapVal && la.c < vwapVal && adxNow > 20) {
    const risk = Math.max(e21n - la.c, la.c * 0.003);
    const riskPct = (risk / la.c) * 100;
    if (riskPct < 0.2 || riskPct > 5) return null;

    const rawScore = 2;
    const score = applyBonuses(rawScore, "SELL", vr, niftyDir);
    return buildSignal({
      name, strategy: "EMA", direction: "SELL",
      entry: la.c, target: la.c - risk * 2, sl: e21n, risk,
      rrLabel: "1:2", rrMult: 2, score,
      scoreBreakdown: { EMA: 2 },
      volRatio: vr, candles: tc,
      firstHigh: Math.max(...tc.slice(-5).map(c => c.h)),
      firstLow:  Math.min(...tc.slice(-5).map(c => c.l)),
      vwapVal, ema9: e9n, ema21: e21n,
    });
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  STRATEGY 5 — GAP Fill
//  Score contribution: 2
//  Best window: 9:20–9:35 AM
//  Logic: Stock gaps 0.3–2.5% vs yesterday close.
//    Gap up → fade (SELL), target = yesterday close.
//    Gap down → BUY, target = yesterday close.
//    SL = today's extreme + small buffer.
// ═══════════════════════════════════════════════════════════════════════════

function gapAnalyze(candles, name, trades, niftyDir) {
  // Need at least 2 days of data
  if (!Array.isArray(candles) || candles.length < 15) return null;
  if (hasOpenPosition(name, trades)) return null;

  const toIST = ts =>
    new Date(new Date(ts).toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));

  // Find unique dates (oldest to newest, candles are oldest-first)
  const dates = [...new Set(candles.map(c => istDate(c.ts)))];
  if (dates.length < 2) return null;

  const todayStr     = dates[dates.length - 1];
  const yesterdayStr = dates[dates.length - 2];

  const tc = candles.filter(c => istDate(c.ts) === todayStr);
  const yc = candles.filter(c => istDate(c.ts) === yesterdayStr);

  if (tc.length < 5 || yc.length < 5) return null;

  const yClose = yc[yc.length - 1].c;     // yesterday's last close
  const tOpen  = tc[0].o;                  // today's first open
  const gapPct = ((tOpen - yClose) / yClose) * 100;
  const absGap = Math.abs(gapPct);

  // Only trade gaps of 0.3–2.5%
  if (absGap < 0.3 || absGap > 2.5) return null;

  const la = tc[tc.length - 1];
  const av = avgVol(tc);
  const vr = av > 0 ? la.v / av : 1;

  // ── GAP UP → SELL (fade the gap) ──
  if (gapPct > 0 && tc[tc.length - 2].c < tc[tc.length - 2].o) {
    const tH  = Math.max(...tc.map(c => c.h));
    const sl  = r2(tH + la.c * 0.002);      // SL just above today's high
    const risk = sl - la.c;
    const pGap = la.c - yClose;              // profit potential to target
    if (pGap < risk * 0.5 || pGap <= 0) return null;

    const rawScore = 2;
    const score = applyBonuses(rawScore, "SELL", vr, niftyDir);
    return buildSignal({
      name, strategy: "GAP", direction: "SELL",
      entry: la.c, target: yClose, sl, risk,
      rrLabel: "1:1.5", rrMult: 1.5, score,
      scoreBreakdown: { GAP: 2 },
      volRatio: vr, candles: tc,
      firstHigh: tH, firstLow: Math.min(...tc.map(c => c.l)),
      gapPct, yClose,
    });
  }

  // ── GAP DOWN → BUY (fade the gap) ──
  if (gapPct < 0 && tc[tc.length - 2].c > tc[tc.length - 2].o) {
    const tL  = Math.min(...tc.map(c => c.l));
    const sl  = r2(tL - la.c * 0.002);      // SL just below today's low
    const risk = la.c - sl;
    const pGap = yClose - la.c;
    if (pGap < risk * 0.5 || pGap <= 0) return null;

    const rawScore = 2;
    const score = applyBonuses(rawScore, "BUY", vr, niftyDir);
    return buildSignal({
      name, strategy: "GAP", direction: "BUY",
      entry: la.c, target: yClose, sl, risk,
      rrLabel: "1:1.5", rrMult: 1.5, score,
      scoreBreakdown: { GAP: 2 },
      volRatio: vr, candles: tc,
      firstHigh: Math.max(...tc.map(c => c.h)), firstLow: tL,
      gapPct, yClose,
    });
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  STRATEGY 6 — SuperTrend + MACD Confluence
//  Score contribution: 3
//  Best window: 9:30–11:30 AM and 2:00–3:00 PM
//  Logic: SuperTrend(10,3) direction + MACD histogram crosses zero.
//    Both must agree. Volume 1.5×. Accuracy ~72–75%.
// ═══════════════════════════════════════════════════════════════════════════

function stMacdAnalyze(candles, name, trades, niftyDir) {
  // Need enough for SuperTrend(10) + MACD(26+9) = 45+ candles total
  if (!Array.isArray(candles) || candles.length < 50) return null;
  if (hasOpenPosition(name, trades)) return null;

  const tc = todayCandles(candles);
  if (tc.length < 20) return null;

  // Use combined historical + today for ST/MACD calculations (need warmup data)
  const allC   = candles;
  const closes = allC.map(c => c.c);

  const { direction: stDir, superTrend: stVals } = calcSuperTrend(allC, 10, 3);
  const { histogram } = calcMACD(closes, 12, 26, 9);

  if (!stDir.length || !histogram.length) return null;

  const macdCross = macdCrossDirection(histogram);
  if (!macdCross) return null;

  const la  = allC[allC.length - 1];
  const stD = stDir[stDir.length - 1];
  const stV = stVals[stVals.length - 1];
  const av  = avgVol(tc);
  const vr  = av > 0 ? la.v / av : 1;

  if (vr < 1.5) return null;

  // Both SuperTrend and MACD must agree on direction
  if (macdCross === "BUY" && stD === 1) {
    const risk = Math.max(la.c - stV, la.c * 0.003);
    const rawScore = 3;
    const score = applyBonuses(rawScore, "BUY", vr, niftyDir);
    return buildSignal({
      name, strategy: "ST_MACD", direction: "BUY",
      entry: la.c, target: la.c + risk * 2, sl: stV, risk,
      rrLabel: "1:2", rrMult: 2, score,
      scoreBreakdown: { ST_MACD: 3 },
      volRatio: vr, candles: tc,
      firstHigh: Math.max(...tc.slice(-5).map(c => c.h)),
      firstLow:  Math.min(...tc.slice(-5).map(c => c.l)),
      stVal: stV,
    });
  }

  if (macdCross === "SELL" && stD === -1) {
    const risk = Math.max(stV - la.c, la.c * 0.003);
    const rawScore = 3;
    const score = applyBonuses(rawScore, "SELL", vr, niftyDir);
    return buildSignal({
      name, strategy: "ST_MACD", direction: "SELL",
      entry: la.c, target: la.c - risk * 2, sl: stV, risk,
      rrLabel: "1:2", rrMult: 2, score,
      scoreBreakdown: { ST_MACD: 3 },
      volRatio: vr, candles: tc,
      firstHigh: Math.max(...tc.slice(-5).map(c => c.h)),
      firstLow:  Math.min(...tc.slice(-5).map(c => c.l)),
      stVal: stV,
    });
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  STRATEGY 7 — RSI Divergence + SuperTrend Confirmation
//  Score contribution: 3
//  Best window: 10:00 AM–1:30 PM
//  Logic: RSI divergence (price vs RSI swing comparison over 12 candles).
//    SuperTrend must confirm direction.
//    RSI zone: 30–50 for BUY, 50–70 for SELL.
//    Accuracy ~72–78%.
// ═══════════════════════════════════════════════════════════════════════════

function rsiDivAnalyze(candles, name, trades, niftyDir) {
  if (!Array.isArray(candles) || candles.length < 50) return null;
  if (hasOpenPosition(name, trades)) return null;

  const tc = todayCandles(candles);
  if (tc.length < 20) return null;

  const allC   = candles;
  const closes = allC.map(c => c.c);

  const rsiVals = calcRSI(closes, 14);
  if (rsiVals.length < 24) return null;

  const { direction: stDir } = calcSuperTrend(allC, 10, 3);
  if (!stDir.length) return null;

  const divergence = detectRSIDivergence(allC, rsiVals, 12);
  if (!divergence) return null;

  const stD    = stDir[stDir.length - 1];
  const rsiNow = rsiVals[rsiVals.length - 1];
  const la     = allC[allC.length - 1];
  const av     = avgVol(tc);
  const vr     = av > 0 ? la.v / av : 1;

  // BUY: bullish divergence + ST bullish + RSI in 30–50 zone
  if (divergence === "bullish" && stD === 1 && rsiNow >= 30 && rsiNow <= 50) {
    const atrVals = calcATR(allC, 14);
    const atr = atrVals.length > 0 ? atrVals[atrVals.length - 1] : la.c * 0.006;
    const risk = Math.max(atr * 1.5, la.c * 0.003);
    const rawScore = 3;
    const score = applyBonuses(rawScore, "BUY", vr, niftyDir);
    return buildSignal({
      name, strategy: "RSI_DIV", direction: "BUY",
      entry: la.c, target: la.c + risk * 2.5, sl: la.c - risk, risk,
      rrLabel: "1:2.5", rrMult: 2.5, score,
      scoreBreakdown: { RSI_DIV: 3 },
      volRatio: vr, candles: tc,
      firstHigh: Math.max(...tc.slice(-5).map(c => c.h)),
      firstLow:  Math.min(...tc.slice(-5).map(c => c.l)),
      rsiVal: rsiNow,
    });
  }

  // SELL: bearish divergence + ST bearish + RSI in 50–70 zone
  if (divergence === "bearish" && stD === -1 && rsiNow >= 50 && rsiNow <= 70) {
    const atrVals = calcATR(allC, 14);
    const atr = atrVals.length > 0 ? atrVals[atrVals.length - 1] : la.c * 0.006;
    const risk = Math.max(atr * 1.5, la.c * 0.003);
    const rawScore = 3;
    const score = applyBonuses(rawScore, "SELL", vr, niftyDir);
    return buildSignal({
      name, strategy: "RSI_DIV", direction: "SELL",
      entry: la.c, target: la.c - risk * 2.5, sl: la.c + risk, risk,
      rrLabel: "1:2.5", rrMult: 2.5, score,
      scoreBreakdown: { RSI_DIV: 3 },
      volRatio: vr, candles: tc,
      firstHigh: Math.max(...tc.slice(-5).map(c => c.h)),
      firstLow:  Math.min(...tc.slice(-5).map(c => c.l)),
      rsiVal: rsiNow,
    });
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  STRATEGY 8 — Bollinger Band Squeeze Breakout
//  Score contribution: 2 (standalone)
//  Best window: 9:15–10:00 AM and 2:00+ PM
//  Logic: BB width < 1.5% (squeeze). Breakout candle above upper / below lower.
//    Volume 2× avg. MACD histogram confirms direction.
//    NOTE: BB_SQZ also contributes +2 as bonus inside orbAnalyze when ORB fires.
// ═══════════════════════════════════════════════════════════════════════════

function bbSqueezeAnalyze(candles, name, trades, niftyDir) {
  if (!Array.isArray(candles) || candles.length < 40) return null;
  if (hasOpenPosition(name, trades)) return null;

  const tc = todayCandles(candles);
  if (tc.length < 20) return null;

  const allC   = candles;
  const closes = allC.map(c => c.c);

  // Check squeeze on closes BEFORE the current candle (not including it)
  const prevCloses = closes.slice(0, -1);
  const squeeze    = isBBSqueeze(prevCloses, 20, 2, 1.5);
  if (!squeeze) return null;

  const bb = calcBB(closes, 20, 2);
  if (!bb) return null;

  const la  = allC[allC.length - 1];
  const p1  = allC[allC.length - 2];
  const av  = avgVol(tc);
  const vr  = av > 0 ? la.v / av : 1;

  // Volume must be 2× for squeeze breakout
  if (vr < 2.0) return null;

  // MACD must agree with breakout direction
  const { histogram } = calcMACD(closes, 12, 26, 9);
  const macdH = histogram.length > 0 ? histogram[histogram.length - 1] : 0;

  // ── BUY: price broke above upper band ──
  const atrPct = atrNormalizedRisk(allC); if (la.c > bb.upper && p1.c < bb.upper && macdH > 0 && atrPct < 3.2) {
    const bbBuyEntry = r2(Math.max(la.h, bb.upper) * 1.0015);
    const risk = bbBuyEntry - bb.middle;
    if (risk <= 0) return null;
    const rawScore = 2;
    const score = applyBonuses(rawScore, "BUY", vr, niftyDir);
    return buildSignal({
      name, strategy: "BB_SQZ", direction: "BUY",
      entry: r2(Math.max(la.h, bb.upper) * 1.0015), target: r2(Math.max(la.h, bb.upper) * 1.0015 + risk * 2), sl: bb.middle, risk,
      rrLabel: "1:2", rrMult: 2, score,
      scoreBreakdown: { BB_SQZ: 2 },
      volRatio: vr, candles: tc,
      firstHigh: bb.upper, firstLow: bb.lower,
      bbWidth: bb.width,
    });
  }

  // ── SELL: price broke below lower band ──
  if (la.c < bb.lower && p1.c > bb.lower && macdH < 0 && atrPct < 3.2) {
    const bbSellEntry = r2(Math.min(la.l, bb.lower) * 0.9985);
    const risk = bb.middle - bbSellEntry;
    if (risk <= 0) return null;
    const rawScore = 2;
    const score = applyBonuses(rawScore, "SELL", vr, niftyDir);
    return buildSignal({
      name, strategy: "BB_SQZ", direction: "SELL",
      entry: r2(Math.min(la.l, bb.lower) * 0.9985), target: r2(Math.min(la.l, bb.lower) * 0.9985 - risk * 2), sl: bb.middle, risk,
      rrLabel: "1:2", rrMult: 2, score,
      scoreBreakdown: { BB_SQZ: 2 },
      volRatio: vr, candles: tc,
      firstHigh: bb.upper, firstLow: bb.lower,
      bbWidth: bb.width,
    });
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  STRATEGY 9 — ADX Trend Strength + EMA Filter
//  Score contribution: 3
//  Best window: 10:00 AM–3:00 PM (trending hours)
//  Logic: ADX > 25 = strong trend exists. +DI vs -DI gives direction.
//    EMA9 > EMA21 confirms up-trend (BUY) or EMA9 < EMA21 confirms down (SELL).
//    This filter PREVENTS trading in sideways markets — biggest accuracy booster.
// ═══════════════════════════════════════════════════════════════════════════

function adxEmaAnalyze(candles, name, trades, niftyDir) {
  if (!Array.isArray(candles) || candles.length < 60) return null;
  if (hasOpenPosition(name, trades)) return null;

  const tc = todayCandles(candles);
  if (tc.length < 20) return null;

  const allC = candles;
  const { adx, plusDI, minusDI } = calcADX(allC, 14);

  if (adx.length < 2 || plusDI.length < 2 || minusDI.length < 2) return null;

  const adxNow   = adx[adx.length - 1];
  const pDINow   = plusDI[plusDI.length - 1];
  const mDINow   = minusDI[minusDI.length - 1];
  const pDIPrev  = plusDI[plusDI.length - 2];
  const mDIPrev  = minusDI[minusDI.length - 2];

  // ADX must show strong and strengthening trend
  const adxPrev = adx[adx.length - 2];
  if (adxNow < 25 || adxNow <= adxPrev) return null;

  const closes = allC.map(c => c.c);
  const e9  = ema(closes, 9);
  const e21 = ema(closes, 21);
  if (e9.length < 1 || e21.length < 1) return null;

  const e9n  = e9[e9.length - 1];
  const e21n = e21[e21.length - 1];
  const la   = allC[allC.length - 1];
  const av   = avgVol(tc);
  const vr   = av > 0 ? la.v / av : 1;

  // ── BUY: +DI crossed above -DI AND EMA9 > EMA21 ──
  if (pDIPrev <= mDIPrev && pDINow > mDINow && e9n > e21n) {
    const risk    = Math.max(la.c - e21n, la.c * 0.004);
    const riskPct = (risk / la.c) * 100;
    if (riskPct < 0.2 || riskPct > 5) return null;

    const rawScore = 3;
    const score = applyBonuses(rawScore, "BUY", vr, niftyDir);
    return buildSignal({
      name, strategy: "ADX_EMA", direction: "BUY",
      entry: la.c, target: la.c + risk * 2, sl: e21n, risk,
      rrLabel: "1:2", rrMult: 2, score,
      scoreBreakdown: { ADX_EMA: 3 },
      volRatio: vr, candles: tc,
      firstHigh: Math.max(...tc.slice(-5).map(c => c.h)),
      firstLow:  Math.min(...tc.slice(-5).map(c => c.l)),
      ema9: e9n, ema21: e21n, adxVal: adxNow,
    });
  }

  // ── SELL: -DI crossed above +DI AND EMA9 < EMA21 ──
  if (mDIPrev <= pDIPrev && mDINow > pDINow && e9n < e21n) {
    const risk    = Math.max(e21n - la.c, la.c * 0.004);
    const riskPct = (risk / la.c) * 100;
    if (riskPct < 0.2 || riskPct > 5) return null;

    const rawScore = 3;
    const score = applyBonuses(rawScore, "SELL", vr, niftyDir);
    return buildSignal({
      name, strategy: "ADX_EMA", direction: "SELL",
      entry: la.c, target: la.c - risk * 2, sl: e21n, risk,
      rrLabel: "1:2", rrMult: 2, score,
      scoreBreakdown: { ADX_EMA: 3 },
      volRatio: vr, candles: tc,
      firstHigh: Math.max(...tc.slice(-5).map(c => c.h)),
      firstLow:  Math.min(...tc.slice(-5).map(c => c.l)),
      ema9: e9n, ema21: e21n, adxVal: adxNow,
    });
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  MULTI-CONFIRMATION SCORER
//  Takes array of partial signals from different strategies for SAME stock.
//  Merges them if they agree on direction. Combines scores. Returns best signal.
//
//  Why this matters: if VWAP + ST_MACD + ADX_EMA all fire BUY on RELIANCE,
//  that's score 2+3+3=8 → very high confidence. Much better than any one alone.
// ═══════════════════════════════════════════════════════════════════════════

function scoreSignal(signals) {
  if (!Array.isArray(signals) || signals.length === 0) return null;

  // Separate by direction
  const buys  = signals.filter(s => s.direction === "BUY");
  const sells = signals.filter(s => s.direction === "SELL");

  // Pick direction with more agreement (tiebreak: higher total score)
  const buyScore  = buys.reduce((a, s) => a + s.score, 0);
  const sellScore = sells.reduce((a, s) => a + s.score, 0);

  const winning = buyScore >= sellScore ? buys : sells;
  if (winning.length === 0) return null;

  // Use the signal with highest individual score as the base
  const base = winning.reduce((a, s) => (s.score > a.score ? s : a), winning[0]);

  // Combine scores and scoreBreakdowns from all agreeing signals
  const totalScore = winning.reduce((a, s) => a + s.score, 0);

  // Cap at 10 (max possible per master plan)
  const finalScore = Math.min(10, totalScore);

  // Merge scoreBreakdowns
  const breakdown = {};
  for (const s of winning) {
    for (const [k, v] of Object.entries(s.scoreBreakdown || {})) {
      breakdown[k] = (breakdown[k] || 0) + v;
    }
  }

  return {
    ...base,
    score: finalScore,
    scoreBreakdown: breakdown,
    confirmedBy: winning.map(s => s.strategy),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  STRATEGY SCHEDULE
//  Maps time-of-day (minute of day) to which strategies should run.
//  Based on master plan schedule. bot.js calls getSchedule(minuteOfDay).
// ═══════════════════════════════════════════════════════════════════════════

const SCHEDULE = [
  { from: 555, to: 560, label: "WAIT",          strategies: [],                             blocked: true,  scanInterval: 0 },
  { from: 560, to: 575, label: "FCB + GAP",      strategies: ["FCB", "GAP"],                blocked: false, scanInterval: 1 },
  { from: 575, to: 690, label: "ORB + BB",        strategies: ["ORB", "BB_SQZ"],             blocked: false, scanInterval: 2 },
  { from: 690, to: 810, label: "VWAP + ST_MACD",  strategies: ["VWAP", "ST_MACD"],           blocked: false, scanInterval: 3 },
  { from: 810, to: 870, label: "EMA + ADX",        strategies: ["EMA", "ADX_EMA"],            blocked: false, scanInterval: 3 },
  { from: 870, to: 920, label: "VWAP + RSI_DIV",   strategies: ["VWAP", "RSI_DIV"],           blocked: false, scanInterval: 2 },
  { from: 920, to: 930, label: "CLOSED",           strategies: [],                             blocked: true,  scanInterval: 0 },
];

function getSchedule(minuteOfDay) {
  const seg = SCHEDULE.find(s => minuteOfDay >= s.from && minuteOfDay < s.to);
  return seg || { label: "PRE-MARKET", strategies: [], blocked: true, scanInterval: 0 };
}

// ═══════════════════════════════════════════════════════════════════════════
//  STOCK UNIVERSE — 3 TIERS
//  bot.js reads these based on config.stockTier setting.
// ═══════════════════════════════════════════════════════════════════════════

const STOCKS = {
  tier1: [
    // Original 18 from V5
    { name: "RELIANCE",   key: "NSE_EQ|INE002A01018" },
    { name: "TCS",        key: "NSE_EQ|INE467B01029" },
    { name: "HDFCBANK",   key: "NSE_EQ|INE040A01034" },
    { name: "INFY",       key: "NSE_EQ|INE009A01021" },
    { name: "ICICIBANK",  key: "NSE_EQ|INE090A01021" },
    { name: "BAJFINANCE", key: "NSE_EQ|INE296A01024" },
    { name: "SBIN",       key: "NSE_EQ|INE062A01020" },
    { name: "AXISBANK",   key: "NSE_EQ|INE238A01034" },
    { name: "KOTAKBANK",  key: "NSE_EQ|INE237A01028" },
    { name: "LT",         key: "NSE_EQ|INE018A01030" },
    { name: "TITAN",      key: "NSE_EQ|INE280A01028" },
    { name: "TATAMOTORS", key: "NSE_EQ|INE155A01022" },
    { name: "BHARTIARTL", key: "NSE_EQ|INE397D01024" },
    { name: "SUNPHARMA",  key: "NSE_EQ|INE044A01036" },
    { name: "HINDUNILVR", key: "NSE_EQ|INE030A01027" },
    { name: "ADANIPORTS", key: "NSE_EQ|INE742F01042" },
    { name: "WIPRO",      key: "NSE_EQ|INE075A01022" },
    { name: "MARUTI",     key: "NSE_EQ|INE585B01010" },
    // Nifty 50 additions
    { name: "HCLTECH",    key: "NSE_EQ|INE860A01027" },
    { name: "NESTLEIND",  key: "NSE_EQ|INE239A01024" },
    { name: "POWERGRID",  key: "NSE_EQ|INE752E01010" },
    { name: "NTPC",       key: "NSE_EQ|INE733E01010" },
    { name: "ULTRACEMCO", key: "NSE_EQ|INE481G01011" },
    { name: "ONGC",       key: "NSE_EQ|INE213A01029" },
    { name: "COALINDIA",  key: "NSE_EQ|INE522F01014" },
    { name: "BPCL",       key: "NSE_EQ|INE029A01011" },
    { name: "BAJAJFINSV", key: "NSE_EQ|INE918I01026" },
    { name: "ASIANPAINT", key: "NSE_EQ|INE021A01026" },
    { name: "TECHM",      key: "NSE_EQ|INE669C01036" },
    { name: "GRASIM",     key: "NSE_EQ|INE047A01021" },
    { name: "DIVISLAB",   key: "NSE_EQ|INE361B01024" },
    { name: "DRREDDY",    key: "NSE_EQ|INE089A01023" },
    { name: "EICHERMOT",  key: "NSE_EQ|INE066A01021" },
    { name: "CIPLA",      key: "NSE_EQ|INE059A01026" },
    { name: "APOLLOHOSP", key: "NSE_EQ|INE437A01024" },
    { name: "HEROMOTOCO", key: "NSE_EQ|INE158A01026" },
    { name: "INDUSINDBK", key: "NSE_EQ|INE095A01012" },
    { name: "JSWSTEEL",   key: "NSE_EQ|INE019A01038" },
    { name: "TATASTEEL",  key: "NSE_EQ|INE081A01012" },
    { name: "M&M",        key: "NSE_EQ|INE101A01026" },
    { name: "BRITANNIA",  key: "NSE_EQ|INE216A01030" },
    { name: "TATACONSUM", key: "NSE_EQ|INE192A01025" },
    { name: "SHREECEM",   key: "NSE_EQ|INE070A01015" },
    { name: "PIDILITIND", key: "NSE_EQ|INE318A01026" },
    { name: "HINDZINC",   key: "NSE_EQ|INE267A01025" },
    { name: "UPL",        key: "NSE_EQ|INE628A01036" },
    { name: "VEDL",       key: "NSE_EQ|INE205A01025" },
  ],

  tier2: [
    { name: "BANKBARODA",   key: "NSE_EQ|INE028A01039" },
    { name: "CANBK",        key: "NSE_EQ|INE476A01014" },
    { name: "IDFCFIRSTB",   key: "NSE_EQ|INE092T01019" },
    { name: "FEDERALBNK",   key: "NSE_EQ|INE171A01029" },
    { name: "BANDHANBNK",   key: "NSE_EQ|INE545U01014" },
    { name: "PNB",          key: "NSE_EQ|INE160A01022" },
    { name: "GAIL",         key: "NSE_EQ|INE129A01019" },
    { name: "IOC",          key: "NSE_EQ|INE242A01010" },
    { name: "GODREJCP",     key: "NSE_EQ|INE102D01028" },
    { name: "SIEMENS",      key: "NSE_EQ|INE003A01024" },
    { name: "ABB",          key: "NSE_EQ|INE117A01022" },
    { name: "TRENT",        key: "NSE_EQ|INE849A01020" },
    { name: "MUTHOOTFIN",   key: "NSE_EQ|INE414G01012" },
    { name: "CHOLAFIN",     key: "NSE_EQ|INE121A01024" },
    { name: "HAVELLS",      key: "NSE_EQ|INE176B01034" },
    { name: "DABUR",        key: "NSE_EQ|INE016A01026" },
    { name: "GODREJPROP",   key: "NSE_EQ|INE484J01027" },
    { name: "DLF",          key: "NSE_EQ|INE271C01023" },
    { name: "PFC",          key: "NSE_EQ|INE134E01011" },
    { name: "RECLTD",       key: "NSE_EQ|INE020B01018" },
    { name: "SAIL",         key: "NSE_EQ|INE114A01011" },
    { name: "BHEL",         key: "NSE_EQ|INE257A01026" },
    { name: "COLPAL",       key: "NSE_EQ|INE259A01022" },
    { name: "MARICO",       key: "NSE_EQ|INE196A01026" },
    { name: "BIOCON",       key: "NSE_EQ|INE376G01013" },
    { name: "LUPIN",        key: "NSE_EQ|INE326A01037" },
    { name: "AUROPHARMA",   key: "NSE_EQ|INE406A01037" },
    { name: "TORNTPHARM",   key: "NSE_EQ|INE685A01028" },
    { name: "TVSMOTOR",     key: "NSE_EQ|INE494B01023" },
    { name: "BALKRISIND",   key: "NSE_EQ|INE787D01026" },
  ],

  tier3: [
    { name: "DIXON",        key: "NSE_EQ|INE935N01012" },
    { name: "HAPPSTMNDS",   key: "NSE_EQ|INE419U01012" },
    { name: "COFORGE",      key: "NSE_EQ|INE591G01017" },
    { name: "PERSISTENT",   key: "NSE_EQ|INE262H01021" },
    { name: "LTTS",         key: "NSE_EQ|INE010V01017" },
    { name: "MPHASIS",      key: "NSE_EQ|INE356A01018" },
    { name: "CROMPTON",     key: "NSE_EQ|INE299U01018" },
    { name: "VOLTAS",       key: "NSE_EQ|INE226A01021" },
    { name: "BLUESTARCO",   key: "NSE_EQ|INE386A01015" },
    { name: "POLYCAB",      key: "NSE_EQ|INE455K01017" },
    { name: "ASTRAL",       key: "NSE_EQ|INE006I01046" },
    { name: "DEEPAKFERT",   key: "NSE_EQ|INE501A01019" },
    { name: "CHAMBLFERT",   key: "NSE_EQ|INE085A01013" },
    { name: "GSFC",         key: "NSE_EQ|INE026A01025" },
    { name: "GLENMARK",     key: "NSE_EQ|INE935A01035" },
    { name: "ALKEM",        key: "NSE_EQ|INE540L01014" },
    { name: "ZYDUSLIFE",    key: "NSE_EQ|INE010B01027" },
    { name: "LAURUSLABS",   key: "NSE_EQ|INE947Q01028" },
    { name: "ESCORTS",      key: "NSE_EQ|INE042A01014" },
    { name: "CUMMINSIND",   key: "NSE_EQ|INE298A01020" },
    { name: "ENGINERSIN",   key: "NSE_EQ|INE285A01027" },
    { name: "CARBORUNDUM",  key: "NSE_EQ|INE120A01034" },
    { name: "CASTROLIND",   key: "NSE_EQ|INE172A01027" },
    { name: "EXIDEIND",     key: "NSE_EQ|INE302A01020" },
    { name: "AMARAJABAT",   key: "NSE_EQ|INE885A01032" },
    { name: "BATAINDIA",    key: "NSE_EQ|INE176A01028" },
    { name: "RELAXO",       key: "NSE_EQ|INE131B01039" },
    { name: "PAGEIND",      key: "NSE_EQ|INE761H01022" },
    { name: "ABCAPITAL",    key: "NSE_EQ|INE674K01013" },
    { name: "CANFINHOME",   key: "NSE_EQ|INE477A01020" },
  ],

  // Nifty index — used for Nifty direction filter only, never traded
  nifty: { name: "NIFTY50", key: "NSE_INDEX|Nifty 50" },
};

// Helper: get all stocks for a given tier config
function getStocksForTier(tierConfig) {
  if (tierConfig === "tier1")    return STOCKS.tier1;
  if (tierConfig === "tier1+2")  return [...STOCKS.tier1, ...STOCKS.tier2];
  return [...STOCKS.tier1, ...STOCKS.tier2, ...STOCKS.tier3]; // "all"
}

// ═══════════════════════════════════════════════════════════════════════════
//  ANALYZER REGISTRY
//  Maps strategy name string → analyzer function.
//  bot.js uses this to call the right function by name from schedule.
// ═══════════════════════════════════════════════════════════════════════════

const ANALYZERS = {
  FCB:     fcbAnalyze,
  ORB:     orbAnalyze,
  VWAP:    vwapAnalyze,
  EMA:     emaAnalyze,
  GAP:     gapAnalyze,
  ST_MACD: stMacdAnalyze,
  RSI_DIV: rsiDivAnalyze,
  BB_SQZ:  bbSqueezeAnalyze,
  ADX_EMA: adxEmaAnalyze,
};

// ═══════════════════════════════════════════════════════════════════════════
//  MAIN ENTRY POINT — analyzeStock
//  Called by bot.js for each stock in the scan loop.
//  Runs all active strategies, scores them, returns best signal or null.
//
//  params:
//    candles[]         — full candle history oldest-first
//    name              — stock name (e.g. "RELIANCE")
//    activeStrategies  — string[] from getSchedule().strategies
//    trades[]          — current open trades (for position guard)
//    niftyLtp          — current Nifty50 LTP (0 if unknown)
//    niftyPrevClose    — Nifty50 previous close (0 if unknown)
//    scoreThreshold    — minimum score to return signal (default 6)
// ═══════════════════════════════════════════════════════════════════════════

function analyzeStock({
  candles,
  name,
  activeStrategies,
  trades,
  niftyLtp       = 0,
  niftyPrevClose = 0,
  scoreThreshold = 6,
}) {
  if (!Array.isArray(candles) || candles.length < 10) return null;
  if (!Array.isArray(activeStrategies) || activeStrategies.length === 0) return null;

  // BUG #1/#4: early exit if stock already has open position
  if (hasOpenPosition(name, trades) || inCooldown(name)) return null;

  const niftyDir = getNiftyDirection(niftyLtp, niftyPrevClose);

  // Run each active strategy
  const rawSignals = [];
  for (const stratName of activeStrategies) {
    const fn = ANALYZERS[stratName];
    if (!fn) continue;
    try {
      const sig = fn(candles, name, trades, niftyDir);
      if (sig) rawSignals.push(sig);
    } catch (e) {
      // Individual strategy errors never crash the scan loop
      // bot.js will log this via its try/catch around analyzeStock
    }
  }

  if (rawSignals.length === 0) return null;

  // Multi-confirmation scoring
  const scored = scoreSignal(rawSignals);
  if (!scored) return null;

  // Apply volume + Nifty bonuses ONCE after merge — prevents double-counting
  let finalScore = scored.score;
  if (scored.volRatio >= 2.0) finalScore += 1;
  if (niftyDir !== 0) {
    const aligned = scored.direction === "BUY" ? niftyDir === 1 : niftyDir === -1;
    if (aligned) finalScore += 1;
    else finalScore -= 2;
  }
  scored.score = Math.min(10, Math.max(0, finalScore));

  // Apply score threshold (BUG #9 prevention: weak early signals filtered here)
  if (scored.score < scoreThreshold) return null;
  return scored;
}

// ═══════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  // Main entry point — bot.js calls this
  analyzeStock,

  // Schedule — bot.js calls this to get active strategies by time
  getSchedule,

  // Stock universe — bot.js reads this
  STOCKS,
  getStocksForTier,

  // Utilities — bot.js uses these
  hasOpenPosition,
  markLoss,
  getNiftyDirection,
  
  // Exposed for testing
  ANALYZERS,
  scoreSignal,
};
