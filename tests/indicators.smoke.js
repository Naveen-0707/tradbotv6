#!/usr/bin/env node

import assert from "node:assert";
import {
  ema,
  calcATR,
  calcRSI,
  calcMACD,
  calcSuperTrend,
  vwap,
} from "../indicators.js";


function mkCandles(n, start = 100) {
  const arr = [];
  let px = start;
  for (let i = 0; i < n; i++) {
    const o = px;
    const c = px + (i % 2 === 0 ? 1 : -0.4);
    const h = Math.max(o, c) + 0.6;
    const l = Math.min(o, c) - 0.5;
    const v = 1000 + i * 10;
    arr.push({ ts: Date.now() + i * 60000, o, h, l, c, v });
    px = c;
  }
  return arr;
}

const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 0.3);
const candles = mkCandles(80, 100);

const emaVals = ema(closes, 9);
assert(emaVals.length > 0, "EMA should produce values");
assert(Number.isFinite(emaVals.at(-1)), "EMA last value should be finite");

const atrVals = calcATR(candles, 14);
assert(atrVals.length > 0, "ATR should produce values");
assert(atrVals.every(Number.isFinite), "ATR values should be finite");

const rsiVals = calcRSI(closes, 14);
assert(rsiVals.length > 0, "RSI should produce values");
assert(rsiVals.every(v => v >= 0 && v <= 100), "RSI should stay within [0,100]");

const macd = calcMACD(closes, 12, 26, 9);
assert(macd.macdLine.length > 0 && macd.signal.length > 0, "MACD arrays should be populated");
assert(macd.histogram.length === macd.signal.length, "MACD histogram and signal lengths should match");

const st = calcSuperTrend(candles, 10, 3);
assert(st.superTrend.length > 0, "SuperTrend should produce values");
assert(st.direction.every(d => d === 1 || d === -1), "SuperTrend direction should be ±1");

const vwapVal = vwap(candles.slice(-30));
assert(Number.isFinite(vwapVal), "VWAP should be finite");

console.log("✅ indicators smoke tests passed");
