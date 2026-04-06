#!/usr/bin/env node

import assert from "node:assert";
import {
  getSchedule,
  scoreSignal,
  hasOpenPosition,
  analyzeStock,
} from "../strategies.js";


// Schedule boundaries
assert.strictEqual(getSchedule(554).blocked, true, "Pre-market should be blocked");
assert.strictEqual(getSchedule(560).label, "FCB + GAP", "9:20 schedule should start FCB+GAP");
assert.strictEqual(getSchedule(929).label, "CLOSED", "3:29 PM should be CLOSED window");

// Open position guard
const trades = [{ name: "RELIANCE", status: "OPEN" }, { name: "INFY", status: "CLOSED" }];
assert.strictEqual(hasOpenPosition("RELIANCE", trades), true, "OPEN position must be detected");
assert.strictEqual(hasOpenPosition("INFY", trades), false, "Closed position must not block");

// Score merge behavior
const merged = scoreSignal([
  { strategy: "VWAP", direction: "BUY", score: 2, scoreBreakdown: { VWAP: 2 }, entry: 100 },
  { strategy: "EMA", direction: "BUY", score: 2, scoreBreakdown: { EMA: 2 }, entry: 100 },
  { strategy: "GAP", direction: "SELL", score: 2, scoreBreakdown: { GAP: 2 }, entry: 100 },
]);
assert(merged, "Merged score should exist");
assert.strictEqual(merged.direction, "BUY", "Winning direction should be BUY");
assert.strictEqual(merged.score, 4, "Scores should sum for agreeing signals");
assert.deepStrictEqual(merged.confirmedBy.sort(), ["EMA", "VWAP"], "ConfirmedBy should contain winning strategies");

const conflicted = scoreSignal([
  { name: "SBIN", strategy: "ST_MACD", direction: "BUY", score: 3, scoreBreakdown: { ST_MACD: 3 }, entry: 100 },
  { name: "SBIN", strategy: "ADX_EMA", direction: "SELL", score: 3, scoreBreakdown: { ADX_EMA: 3 }, entry: 100 },
]);
assert.strictEqual(conflicted, null, "Conflicting 3-vs-3 signals should be skipped");

// Analyze guard rails
assert.strictEqual(analyzeStock({ candles: [], name: "RELIANCE", activeStrategies: ["VWAP"], trades: [] }), null, "Insufficient candles should return null");
assert.strictEqual(analyzeStock({ candles: new Array(20).fill({ c: 1 }), name: "RELIANCE", activeStrategies: [], trades: [] }), null, "No active strategies should return null");

console.log("✅ strategies smoke tests passed");
