// ═══════════════════════════════════════════════════════════════════════════


// ─── GUARD ───────────────────────────────────────────────────────────────────
// Every public function validates its input before computing.
// Returns null/[] on bad input so callers never receive NaN.

function guard(arr, min, label) {
  if (!Array.isArray(arr) || arr.length < min) {
    if (label) console.warn(`[indicators] ${label}: insufficient data (got ${Array.isArray(arr) ? arr.length : typeof arr}, need ${min})`);
    return false;
  }
  return true;
}

// ─── 1. WILDER'S SMOOTHED MOVING AVERAGE (RMA) ───────────────────────────────
// Used by ATR, RSI, ADX — NOT the same as regular EMA.
// First value = simple average of first `period` items.
// Subsequent values = (prev × (period-1) + curr) / period
// Output length = vals.length - period + 1

function smoothed(vals, period) {
  if (!guard(vals, period, "smoothed")) return [];
  const result = [];
  // seed with simple average
  let seed = 0;
  for (let i = 0; i < period; i++) seed += vals[i];
  seed /= period;
  result.push(seed);
  for (let i = period; i < vals.length; i++) {
    result.push((result[result.length - 1] * (period - 1) + vals[i]) / period);
  }
  return result;
}

// ─── 2. EXPONENTIAL MOVING AVERAGE ───────────────────────────────────────────
// Standard EMA with k = 2 / (period + 1).
// First value = simple average of first `period` items.
// Output length = vals.length - period + 1

function ema(vals, period) {
  if (!guard(vals, period, "ema")) return [];
  const k = 2 / (period + 1);
  const result = [];
  let seed = 0;
  for (let i = 0; i < period; i++) seed += vals[i];
  seed /= period;
  result.push(seed);
  for (let i = period; i < vals.length; i++) {
    result.push(vals[i] * k + result[result.length - 1] * (1 - k));
  }
  return result;
}

// ─── 3. AVERAGE TRUE RANGE ───────────────────────────────────────────────────
// True Range = max(H-L, |H-prevC|, |L-prevC|)
// ATR = Wilder's smoothing of TR over `period` candles.
// Output: array of ATR values, same length as smoothed() output.
// Output index 0 corresponds to candles[period] (first candle with prev data).

function calcATR(candles, period = 14) {
  if (!guard(candles, period + 1, "calcATR")) return [];
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const { h, l } = candles[i];
    const prevC = candles[i - 1].c;
    tr.push(Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC)));
  }
  return smoothed(tr, period);
}

// ─── 4. RSI — RELATIVE STRENGTH INDEX ────────────────────────────────────────
// Uses Wilder's smoothing (same as TradingView default).
// Input: close prices array. period = 14 default.
// Returns: array of RSI values (0-100).
// Output index 0 corresponds to closes[period] (first RSI value).

function calcRSI(closes, period = 14) {
  if (!guard(closes, period + 1, "calcRSI")) return [];
  const gains = [];
  const losses = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }
  const avgGain = smoothed(gains, period);
  const avgLoss = smoothed(losses, period);
  return avgGain.map((g, i) => {
    const loss = avgLoss[i];
    if (loss === 0) return 100;
    return 100 - (100 / (1 + g / loss));
  });
}

// ─── 5. MACD ─────────────────────────────────────────────────────────────────
// macdLine  = EMA(fast) - EMA(slow)
// signal    = EMA(macdLine, signalPeriod)
// histogram = macdLine - signal
// Returns: { macdLine[], signal[], histogram[] }
// All arrays are aligned — index 0 is the oldest value with full data.

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (!guard(closes, slow + signal, "calcMACD")) {
    return { macdLine: [], signal: [], histogram: [] };
  }
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);

  // Align emaFast and emaSlow — emaSlow is shorter by (slow - fast) elements
  const offset = slow - fast; // emaSlow[0] aligns with emaFast[offset]
  const macdLine = emaSlow.map((s, i) => emaFast[i + offset] - s);

  const signalLine = ema(macdLine, signal);

  // Align signal with macdLine — signalLine[0] aligns with macdLine[signal-1]
  const histogram = signalLine.map((sig, i) => macdLine[i + (signal - 1)] - sig);

  return { macdLine, signal: signalLine, histogram };
}

// ─── 6. SUPERTREND ───────────────────────────────────────────────────────────
// SuperTrend = ATR-based trailing stop/start band.
// Upper band = (H+L)/2 + multiplier × ATR  (bears)
// Lower band = (H+L)/2 - multiplier × ATR  (bulls)
// Returns: { superTrend[], direction[] }
//   direction: 1 = bullish (price above ST), -1 = bearish (price below ST)
// Output length = ATR output length = candles.length - period

function calcSuperTrend(candles, period = 10, multiplier = 3) {
  if (!guard(candles, period + 2, "calcSuperTrend")) {
    return { superTrend: [], direction: [] };
  }

  const atrVals = calcATR(candles, period);
  // atrVals[0] corresponds to candles[period] (need candles[period-1] as anchor)
  // atrStart: first candle index with ATR = candles[period]
  const atrStart = period; // candles[atrStart] is first candle with ATR

  const superTrend = [];
  const direction = [];

  let prevUpper = 0;
  let prevLower = 0;
  let prevDir = 1;

  for (let i = 0; i < atrVals.length; i++) {
    const cIdx = atrStart + i;
    const c = candles[cIdx];
    const atr = atrVals[i];
    const mid = (c.h + c.l) / 2;

    let upper = mid + multiplier * atr;
    let lower = mid - multiplier * atr;

    // Band adjustment: bands can only move in their direction
    if (i > 0) {
      // Lower band can only move up
      lower = lower > prevLower || candles[cIdx - 1].c < prevLower ? lower : prevLower;
      // Upper band can only move down
      upper = upper < prevUpper || candles[cIdx - 1].c > prevUpper ? upper : prevUpper;
    }

    // Direction
    let dir;
    if (i === 0) {
      dir = c.c > (upper + lower) / 2 ? 1 : -1;
    } else {
      if (prevDir === 1) {
        dir = c.c < lower ? -1 : 1;
      } else {
        dir = c.c > upper ? 1 : -1;
      }
    }

    superTrend.push(dir === 1 ? lower : upper);
    direction.push(dir);
    prevUpper = upper;
    prevLower = lower;
    prevDir = dir;
  }

  return { superTrend, direction };
}

// ─── 7. ADX — AVERAGE DIRECTIONAL INDEX ──────────────────────────────────────
// Measures trend strength (not direction).
// ADX > 25 = strong trend. ADX < 20 = sideways/flat.
// +DI > -DI = bullish direction. -DI > +DI = bearish direction.
// Returns: { adx[], plusDI[], minusDI[] } — all same length.

function calcADX(candles, period = 14) {
  if (!guard(candles, period * 2 + 1, "calcADX")) {
    return { adx: [], plusDI: [], minusDI: [] };
  }

  const tr = [];
  const plusDM = [];
  const minusDM = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];

    const upMove = c.h - p.h;
    const downMove = p.l - c.l;

    tr.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  const smoothTR = smoothed(tr, period);
  const smoothPlus = smoothed(plusDM, period);
  const smoothMinus = smoothed(minusDM, period);

  const plusDI = smoothPlus.map((v, i) => smoothTR[i] > 0 ? (v / smoothTR[i]) * 100 : 0);
  const minusDI = smoothMinus.map((v, i) => smoothTR[i] > 0 ? (v / smoothTR[i]) * 100 : 0);
  const dx = plusDI.map((p, i) => {
    const sum = p + minusDI[i];
    return sum > 0 ? (Math.abs(p - minusDI[i]) / sum) * 100 : 0;
  });

  const adx = smoothed(dx, period);

  // Align all outputs to same length (adx is shortest)
  const offset = dx.length - adx.length;
  return {
    adx,
    plusDI: plusDI.slice(offset),
    minusDI: minusDI.slice(offset),
  };
}

// ─── 8. BOLLINGER BANDS ───────────────────────────────────────────────────────
// middle = SMA(period)
// upper  = middle + mult × stdDev
// lower  = middle - mult × stdDev
// width  = (upper - lower) / middle × 100  (bandwidth %)
// Returns snapshot for LAST candle in array only.
// For full series use calcBBSeries.

function calcBB(closes, period = 20, mult = 2) {
  if (!guard(closes, period, "calcBB")) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  const std = Math.sqrt(variance);
  return {
    upper: mean + mult * std,
    middle: mean,
    lower: mean - mult * std,
    std,
    width: std > 0 ? ((4 * mult * std) / mean) * 100 : 0,
  };
}

// Full BB series — returns array of {upper, middle, lower, std, width} per candle
function calcBBSeries(closes, period = 20, mult = 2) {
  if (!guard(closes, period, "calcBBSeries")) return [];
  const result = [];
  for (let i = period - 1; i < closes.length; i++) {
    result.push(calcBB(closes.slice(0, i + 1), period, mult));
  }
  return result;
}

// ─── 9. VWAP ─────────────────────────────────────────────────────────────────
// VWAP = cumulative(typical_price × volume) / cumulative(volume)
// typical_price = (high + low + close) / 3
// Resets every day. Pass only TODAY's candles.
// Returns scalar (single VWAP value for current moment).

function vwap(candles) {
  if (!guard(candles, 1, "vwap")) return null;
  let cumTP = 0;
  let cumVol = 0;
  for (const c of candles) {
    const tp = (c.h + c.l + c.c) / 3;
    cumTP += tp * c.v;
    cumVol += c.v;
  }
  return cumVol > 0 ? cumTP / cumVol : null;
}

// VWAP with standard deviation bands
// Returns { vwap, upper1, upper2, lower1, lower2 }
// upper2/lower2 = 2 standard deviations (overbought/oversold zones)

function vwapBands(candles) {
  if (!guard(candles, 1, "vwapBands")) return null;
  let cumTP = 0;
  let cumTP2 = 0;
  let cumVol = 0;
  for (const c of candles) {
    const tp = (c.h + c.l + c.c) / 3;
    cumTP += tp * c.v;
    cumTP2 += tp * tp * c.v;
    cumVol += c.v;
  }
  if (cumVol === 0) return null;
  const vwapVal = cumTP / cumVol;
  const variance = (cumTP2 / cumVol) - (vwapVal * vwapVal);
  const std = Math.sqrt(Math.max(0, variance));
  return {
    vwap: vwapVal,
    upper1: vwapVal + std,
    upper2: vwapVal + 2 * std,
    lower1: vwapVal - std,
    lower2: vwapVal - 2 * std,
    std,
  };
}

// ─── 10. AVERAGE VOLUME ───────────────────────────────────────────────────────
// Average volume of last n candles, EXCLUDING the most recent (to avoid
// comparing current candle volume against itself).
// Returns scalar. If not enough candles, returns average of what's available.

function avgVol(candles, n = 10) {
  if (!guard(candles, 2, "avgVol")) return 1;
  const src = candles.slice(-(n + 1), -1); // exclude last candle
  if (src.length === 0) return 1;
  return src.reduce((a, c) => a + c.v, 0) / src.length;
}

// ─── 11. SIMPLE MOVING AVERAGE ───────────────────────────────────────────────
// Returns full array of SMA values.

function sma(vals, period) {
  if (!guard(vals, period, "sma")) return [];
  const result = [];
  for (let i = period - 1; i < vals.length; i++) {
    result.push(vals.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period);
  }
  return result;
}

// ─── 12. RSI DIVERGENCE DETECTOR ─────────────────────────────────────────────
// Looks at price vs RSI swing points over the last `lookback` candles.
// Returns: 'bullish' | 'bearish' | null
// Bullish: price lower low, RSI higher low (seller exhaustion → expect BUY)
// Bearish: price higher high, RSI lower high (buyer exhaustion → expect SELL)

function detectRSIDivergence(candles, rsiVals, lookback = 12) {
  if (!guard(candles, lookback * 2, "detectRSIDivergence")) return null;
  if (!guard(rsiVals, lookback * 2, "detectRSIDivergence:rsi")) return null;

  // Work with last lookback*2 candles to find two swing points
  const priceSlice = candles.slice(-lookback * 2);
  const rsiSlice = rsiVals.slice(-lookback * 2);
  const half = lookback;

  // First half (older)
  const priceLow1 = Math.min(...priceSlice.slice(0, half).map(c => c.l));
  const priceHigh1 = Math.max(...priceSlice.slice(0, half).map(c => c.h));
  const rsiLow1 = Math.min(...rsiSlice.slice(0, half));
  const rsiHigh1 = Math.max(...rsiSlice.slice(0, half));

  // Second half (recent)
  const priceLow2 = Math.min(...priceSlice.slice(half).map(c => c.l));
  const priceHigh2 = Math.max(...priceSlice.slice(half).map(c => c.h));
  const rsiLow2 = Math.min(...rsiSlice.slice(half));
  const rsiHigh2 = Math.max(...rsiSlice.slice(half));

  // Bullish divergence: price made lower low, RSI made higher low
  if (priceLow2 < priceLow1 && rsiLow2 > rsiLow1 + 2) return "bullish";

  // Bearish divergence: price made higher high, RSI made lower high
  if (priceHigh2 > priceHigh1 && rsiHigh2 < rsiHigh1 - 2) return "bearish";

  return null;
}

// ─── 13. MACD CROSSOVER DETECTOR ─────────────────────────────────────────────
// Checks if MACD line just crossed signal line.
// Returns: 'BUY' | 'SELL' | null
// Uses last 2 values of histogram to detect sign change.

function macdCrossDirection(histogram) {
  if (!histogram || histogram.length < 2) return null;
  const prev = histogram[histogram.length - 2];
  const curr = histogram[histogram.length - 1];
  if (prev <= 0 && curr > 0) return "BUY";
  if (prev >= 0 && curr < 0) return "SELL";
  return null;
}

// ─── 14. BOLLINGER BAND SQUEEZE DETECTOR ─────────────────────────────────────
// Squeeze = band width < threshold % (compressed volatility, big move imminent)
// Returns: true if squeeze is active on most recent candle.

function isBBSqueeze(closes, period = 20, mult = 2, thresholdPct = 2.0) {
  const bb = calcBB(closes, period, mult);
  if (!bb) return false;
  return bb.width < thresholdPct;
}

// ─── 15. SWING HIGH / LOW FINDER ─────────────────────────────────────────────
// Finds recent swing high and low within last `lookback` candles.
// Used by FCB and GAP strategies.

function recentSwing(candles, lookback = 5) {
  if (!guard(candles, lookback, "recentSwing")) return { high: 0, low: Infinity };
  const slice = candles.slice(-lookback);
  return {
    high: Math.max(...slice.map(c => c.h)),
    low: Math.min(...slice.map(c => c.l)),
  };
}

// ─── 16. TODAY CANDLE FILTER ──────────────────────────────────────────────────
// Filters candles to only those from today's IST date.
// Used by every strategy to isolate intraday data.

function todayCandles(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return [];
  const toIST = ts => new Date(new Date(ts).toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const today = toIST(candles[candles.length - 1].ts).toDateString();
  return candles.filter(c => toIST(c.ts).toDateString() === today);
}

// ─── 17. STALE CANDLE CHECK ───────────────────────────────────────────────────
// Returns true if the most recent candle is older than maxMinutes AND
// younger than 12 hours (to avoid wrong timezone parse giving huge diffs).

function isStale(candles, maxMinutes = 3) {
  if (!Array.isArray(candles) || candles.length === 0) return true;
  const lastTs = new Date(candles[candles.length - 1].ts).getTime();
  const diff = Date.now() - lastTs;
  return diff > maxMinutes * 60000 && diff < 6 * 3600000;
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────
export {
  // Core math
  smoothed,
  ema,
  sma,

  // Indicators
  calcATR,
  calcRSI,
  calcMACD,
  calcSuperTrend,
  calcADX,
  calcBB,
  calcBBSeries,
  vwap,
  vwapBands,
  avgVol,

  // Pattern detectors
  detectRSIDivergence,
  macdCrossDirection,
  isBBSqueeze,
  recentSwing,

  // Candle utilities
  todayCandles,
  isStale,
};

