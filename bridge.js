#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  FCB BOT V6 — bridge.js
//  HTTP server + SSE event stream + WebSocket auth proxy.
//  Serves index.html and all static files to the browser.
//
//  NEW IN V6 (vs V5):
//    • Per-day log file watching — auto-switches at midnight IST
//    • GET /api/logs/download?format=txt|csv|json&date= — single-click download
//    • GET /api/logs?since=<timestamp> — catch-up endpoint on UI reconnect
//    • GET /api/logs/dates — list all available log dates for date picker
//    • POST /api/cmd — "clear_trades" added to allowed list (BUG #8 fix)
//    • SSE sends "reconnect" event with missed log count on new connection
//    • Bridge console output NEVER written to bot log files (logs stay clean)
//
//  UNCHANGED FROM V5 (working well):
//    • /ws-auth proxy to Upstox WS auth endpoint
//    • /events SSE stream (25s heartbeat)
//    • Static file serving with path traversal guard
//    • Optional bot.js child spawn (RUN_BOT=1 env var)
//    • CORS headers on all responses
// ═══════════════════════════════════════════════════════════════════════════

"use strict";

const http         = require("http");
const https        = require("https");
const fs           = require("fs");
const fsp          = fs.promises;
const path         = require("path");
const { spawn, exec } = require("child_process");

const PORT = 8080;
const DIR  = __dirname;
const MAX_API_BODY_BYTES = 1_000_000; // 1 MB safeguard against oversized JSON payloads
const APP_VERSION = "6.1.0";
const ADMIN_KEY = (process.env.FCB_ADMIN_KEY || "").trim();
const ALLOWED_ORIGINS = (process.env.FCB_ALLOWED_ORIGINS || "http://localhost:8080,http://127.0.0.1:8080")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// ─── FILE PATHS ───────────────────────────────────────────────────────────────
// NOTE: bridge.js NEVER writes to bot log files.
// Bot writes: fcb_log_YYYY-MM-DD.txt
// Bridge reads them (SSE + download) but never appends.

const CFG_FILE = path.join(DIR, "config.json");
const TRD_FILE = path.join(DIR, "fcb_trades.json");
const SIG_FILE = path.join(DIR, "fcb_signals.json");
const CMD_FILE = path.join(DIR, "fcb_cmd.json");
const BOT_STATUS_FILE = path.join(DIR, "fcb_bot_status.json");

// ─── TERMINAL COLOURS (bridge console only — never touches log files) ─────────
const G = s => `\x1b[32m${s}\x1b[0m`;
const Y = s => `\x1b[33m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const B = s => `\x1b[36m${s}\x1b[0m`;
const W = s => `\x1b[1m${s}\x1b[0m`;

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const readJSON = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); }
  catch { return fallback !== undefined ? fallback : {}; }
};

const writeJSON = (f, d) => {
  try { fs.writeFileSync(f, JSON.stringify(d, null, 2)); return true; }
  catch { return false; }
};

const readJSONAsync = async (f, fallback) => {
  try { return JSON.parse(await fsp.readFile(f, "utf8")); }
  catch { return fallback !== undefined ? fallback : {}; }
};

const writeJSONAsync = async (f, d) => {
  try { await fsp.writeFile(f, JSON.stringify(d, null, 2)); return true; }
  catch { return false; }
};

const failWrite = (res, target) =>
  json(res, { ok: false, error: `Failed to write ${target}` }, 500);

function isOpenLiveTrade(trade) {
  return !!trade && trade.status === "OPEN" && !trade.paper;
}

function hasProtectedLiveTrades(trades, indexes) {
  if (!Array.isArray(trades) || trades.length === 0) return false;
  if (Array.isArray(indexes)) {
    return indexes.some(i => isOpenLiveTrade(trades[i]));
  }
  return trades.some(isOpenLiveTrade);
}

async function getBotStatus() {
  const status = await readJSONAsync(BOT_STATUS_FILE, null);
  if (!status || typeof status !== "object") return null;
  const heartbeat = Number(status.lastHeartbeat || 0);
  const fresh = heartbeat > 0 && (Date.now() - heartbeat) < 90_000;
  return {
    ...status,
    fresh,
    running: status.alive === true && status.botStopped !== true && fresh,
  };
}

function ensureModeSettings(cfg = {}) {
  const defaults = {
    wallet: 5000,
    riskPct: 2,
    dailyLossLimit: 500,
    maxTrades: 3,
    scoreThreshold: 6,
    stockTier: "tier1+2",
    niftyFilter: true,
  };
  const paperBase = cfg.modeSettings?.paper || {};
  const liveBase  = cfg.modeSettings?.live  || {};
  cfg.modeSettings = {
    paper: {
      wallet:         Number.isFinite(Number(paperBase.wallet))         ? Number(paperBase.wallet)         : Number.isFinite(Number(cfg.wallet))         ? Number(cfg.wallet)         : defaults.wallet,
      riskPct:        Number.isFinite(Number(paperBase.riskPct))        ? Number(paperBase.riskPct)        : Number.isFinite(Number(cfg.riskPct))        ? Number(cfg.riskPct)        : defaults.riskPct,
      dailyLossLimit: Number.isFinite(Number(paperBase.dailyLossLimit)) ? Number(paperBase.dailyLossLimit) : Number.isFinite(Number(cfg.dailyLossLimit)) ? Number(cfg.dailyLossLimit) : defaults.dailyLossLimit,
      maxTrades:      Number.isFinite(Number(paperBase.maxTrades))      ? Number(paperBase.maxTrades)      : Number.isFinite(Number(cfg.maxTrades))      ? Number(cfg.maxTrades)      : defaults.maxTrades,
      scoreThreshold: Number.isFinite(Number(paperBase.scoreThreshold)) ? Number(paperBase.scoreThreshold) : Number.isFinite(Number(cfg.scoreThreshold)) ? Number(cfg.scoreThreshold) : defaults.scoreThreshold,
      stockTier:      ["tier1", "tier1+2", "all"].includes(paperBase.stockTier) ? paperBase.stockTier : ["tier1", "tier1+2", "all"].includes(cfg.stockTier) ? cfg.stockTier : defaults.stockTier,
      niftyFilter:    typeof paperBase.niftyFilter === "boolean" ? paperBase.niftyFilter : typeof cfg.niftyFilter === "boolean" ? cfg.niftyFilter : defaults.niftyFilter,
    },
    live: {
      wallet:         Number.isFinite(Number(liveBase.wallet))         ? Number(liveBase.wallet)         : Number.isFinite(Number(cfg.wallet))         ? Number(cfg.wallet)         : defaults.wallet,
      riskPct:        Number.isFinite(Number(liveBase.riskPct))        ? Number(liveBase.riskPct)        : Number.isFinite(Number(cfg.riskPct))        ? Number(cfg.riskPct)        : defaults.riskPct,
      dailyLossLimit: Number.isFinite(Number(liveBase.dailyLossLimit)) ? Number(liveBase.dailyLossLimit) : Number.isFinite(Number(cfg.dailyLossLimit)) ? Number(cfg.dailyLossLimit) : defaults.dailyLossLimit,
      maxTrades:      Number.isFinite(Number(liveBase.maxTrades))      ? Number(liveBase.maxTrades)      : Number.isFinite(Number(cfg.maxTrades))      ? Number(cfg.maxTrades)      : defaults.maxTrades,
      scoreThreshold: Number.isFinite(Number(liveBase.scoreThreshold)) ? Number(liveBase.scoreThreshold) : Number.isFinite(Number(cfg.scoreThreshold)) ? Number(cfg.scoreThreshold) : defaults.scoreThreshold,
      stockTier:      ["tier1", "tier1+2", "all"].includes(liveBase.stockTier) ? liveBase.stockTier : ["tier1", "tier1+2", "all"].includes(cfg.stockTier) ? cfg.stockTier : defaults.stockTier,
      niftyFilter:    typeof liveBase.niftyFilter === "boolean" ? liveBase.niftyFilter : typeof cfg.niftyFilter === "boolean" ? cfg.niftyFilter : defaults.niftyFilter,
    },
  };
  cfg.liveShortAllowlist = Array.isArray(cfg.liveShortAllowlist)
    ? cfg.liveShortAllowlist.map(s => String(s || "").trim()).filter(Boolean)
    : [];
  return cfg;
}

const cors = res => {
  const origin = res.req?.headers?.origin;
  const allow = !origin || ALLOWED_ORIGINS.includes(origin) ? (origin || ALLOWED_ORIGINS[0]) : "";
  if (allow) res.setHeader("Access-Control-Allow-Origin", allow);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type,Accept,x-fcb-admin-key");
  res.setHeader("Vary", "Origin");
};

const json = (res, data, code = 200) => {
  cors(res);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};

const requireAdmin = (req, res) => {
  if (!ADMIN_KEY) {
    json(res, {
      ok: false,
      error: "Write APIs are locked. Set FCB_ADMIN_KEY on bridge startup.",
    }, 503);
    return false;
  }
  const key = (req.headers["x-fcb-admin-key"] || "").toString().trim();
  if (key === ADMIN_KEY) return true;
  json(res, { ok: false, error: "Unauthorized" }, 401);
  return false;
};

// ─── IST DATE HELPERS ─────────────────────────────────────────────────────────
function istNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}

function istDateStr(d) {
  const t  = d || istNow();
  const y  = t.getFullYear();
  const mo = String(t.getMonth() + 1).padStart(2, "0");
  const dy = String(t.getDate()).padStart(2, "0");
  return `${y}-${mo}-${dy}`;
}

function todayStr() { return istDateStr(); }
function processUptimeSec() { return Math.floor(process.uptime()); }

// ─── PER-DAY LOG FILE RESOLUTION ─────────────────────────────────────────────
// Bot writes: fcb_log_YYYY-MM-DD.txt
// Bridge watches today's file, auto-switches at midnight.

function logFileForDate(dateStr) {
  // dateStr format: YYYY-MM-DD  or  "today"
  const d = (!dateStr || dateStr === "today") ? todayStr() : dateStr;
  return path.join(DIR, `fcb_log_${d}.txt`);
}

function todayLogFile() { return logFileForDate(todayStr()); }

// Return all available log dates (from files on disk), newest first.
async function getLogDates() {
  try {
    return (await fsp.readdir(DIR))
      .filter(f => /^fcb_log_\d{4}-\d{2}-\d{2}\.txt$/.test(f))
      .map(f => f.replace("fcb_log_", "").replace(".txt", ""))
      .sort()
      .reverse();
  } catch { return []; }
}

// Read last N lines of a file without loading entire file into memory.
// Returns string lines array.
async function readLastLines(filePath, n = 500) {
  try {
    const content = (await fsp.readFile(filePath, "utf8")).trim();
    if (!content) return [];
    const lines = content.split("\n");
    return n > 0 ? lines.slice(-n) : lines; // n=0 means all lines (for download)
  } catch { return []; }
}

// Read all lines since a given timestamp string (inclusive).
// Used by /api/logs?since= catch-up endpoint.
// Timestamp format: "10:37:42 am" (IST time string from log line prefix).
async function readLinesSince(filePath, sinceTs) {
  try {
    const lines = await readLastLines(filePath, 0); // all lines
    if (!sinceTs) return lines;

    // Convert "10:37:42 am" / "3:45:01 pm" → seconds since midnight for numeric compare
    const toSecs = str => {
      const m = str.match(/(\d+):(\d+):(\d+)\s*(am|pm)/i);
      if (!m) return 0;
      let h = parseInt(m[1]), min = parseInt(m[2]), s = parseInt(m[3]);
      const pm = m[4].toLowerCase() === "pm";
      if (pm && h !== 12) h += 12;
      if (!pm && h === 12) h = 0;
      return h * 3600 + min * 60 + s;
    };

    const sinceSecs = toSecs(sinceTs);
    const idx = lines.findIndex(l => {
      const m = l.match(/^\[(.+?)\]/);
      if (!m) return false;
      return toSecs(m[1]) >= sinceSecs;
    });
    return idx >= 0 ? lines.slice(idx) : [];
  } catch { return []; }
}

// ─── SSE CLIENT REGISTRY ─────────────────────────────────────────────────────
const sseClients = new Set();

function sseWrite(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) {
    try { c.write(payload); } catch { sseClients.delete(c); }
  }
}

// Heartbeat keeps connections alive through Android sleep and proxies.
// 25s interval (Nginx proxy_read_timeout is typically 60s).
setInterval(() => {
  for (const c of sseClients) {
    try { c.write(": heartbeat\n\n"); } catch { sseClients.delete(c); }
  }
}, 25000);

// ─── PER-DAY LOG FILE WATCHER ─────────────────────────────────────────────────
// Auto-switches to new log file at midnight IST.
// Only streams NEW bytes (not re-reading old content on each change).

let watchedLogFile  = todayLogFile();
let watchedLogSize  = 0;
let currentLogDate  = todayStr();
let logFileWatcher  = null;

function getOrCreateLogWatcher() {
  // Check if date has changed (midnight rollover)
  const today = todayStr();
  if (today !== currentLogDate) {
    console.log(Y(`🔄 Log date changed: ${currentLogDate} → ${today}. Switching watcher.`));
    if (logFileWatcher) { try { logFileWatcher.stop(); } catch {} }
    currentLogDate  = today;
    watchedLogFile  = todayLogFile();
    watchedLogSize  = 0;
    logFileWatcher  = null;
  }

  if (logFileWatcher) return;

  // Seed size from existing file (don't re-send old lines on start)
  fsp.stat(watchedLogFile).then(st => { watchedLogSize = st.size; }).catch(() => { watchedLogSize = 0; });

  logFileWatcher = fs.watchFile(watchedLogFile, { interval: 800 }, async curr => {
    if (curr.size <= watchedLogSize) return;
    try {
      const fh  = await fsp.open(watchedLogFile, "r");
      const buf = Buffer.alloc(curr.size - watchedLogSize);
      await fh.read(buf, 0, buf.length, watchedLogSize);
      await fh.close();
      const newLines = buf.toString().trim().split("\n").filter(Boolean);
      for (const line of newLines) sseWrite({ type: "log", line });
      watchedLogSize = curr.size;
    } catch (e) { console.warn(`[bridge] Log read error: ${e.message}`); }
  });

  console.log(G(`📋 Watching log: ${path.basename(watchedLogFile)}`));
}

// Start watcher immediately and re-check every minute for midnight rollover
getOrCreateLogWatcher();
setInterval(getOrCreateLogWatcher, 60000);

// ─── TRADES FILE WATCHER ─────────────────────────────────────────────────────
let lastTradeCount = -1;
let lastTradesMtimeMs = 0;
fs.watchFile(TRD_FILE, { interval: 5000 }, () => {
  const trades = readJSON(TRD_FILE, []);
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(TRD_FILE).mtimeMs || 0; } catch {}

  // Push trade updates when file content changes (not only when count changes),
  // so UI can refresh live LTP / Live P&L for open trades.
  if (trades.length !== lastTradeCount || mtimeMs !== lastTradesMtimeMs) {
    lastTradeCount = trades.length;
    lastTradesMtimeMs = mtimeMs;
    sseWrite({ type: "trades", trades });
  }
});

// ─── SIGNALS FILE WATCHER ────────────────────────────────────────────────────
fs.watchFile(SIG_FILE, { interval: 1000 }, () => {
  const signals = readJSON(SIG_FILE, []);
  sseWrite({ type: "signals", signals });
});

// ─── OPTIONAL BOT.JS CHILD PROCESS ───────────────────────────────────────────
// Activated with: RUN_BOT=1 node bridge.js
// Auto-restarts bot.js on crash.

let botChild = null;
if (process.env.RUN_BOT === "1") {
  const botPath = path.join(DIR, "bot.js");
  if (fs.existsSync(botPath)) {
    const spawnBot = () => {
      console.log(Y("🤖 Spawning bot.js…"));
      botChild = spawn(process.execPath, [botPath], {
        stdio: ["ignore", "inherit", "inherit"],
        env: process.env,
      });
      botChild.on("exit", code => {
        console.log(Y(`⚠️  bot.js exited (code ${code}) — restarting in 5s`));
        setTimeout(spawnBot, 5000);
      });
    };
    spawnBot();
  } else {
    console.log(Y("⚠️  RUN_BOT=1 but bot.js not found — skipping spawn"));
  }
}

// ─── MIME TYPES ───────────────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html",
  ".js":   "application/javascript",
  ".json": "application/json",
  ".css":  "text/css",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
  ".svg":  "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".proto": "application/octet-stream",
};

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const [urlPath, queryStr] = req.url.split("?");
  const qp = new URLSearchParams(queryStr || "");

  // ── SSE: real-time event stream ──────────────────────────────────────────
  if (urlPath === "/events") {
    cors(res);
    res.writeHead(200, {
      "Content-Type":                "text/event-stream",
      "Cache-Control":               "no-cache",
      "Connection":                  "keep-alive",
      "X-Accel-Buffering":           "no",
    });
    res.write(": connected\n\n");
    sseClients.add(res);

    // Send current state immediately on connect
    const initTrades  = readJSON(TRD_FILE, []);
    const initSignals = readJSON(SIG_FILE, []);
    res.write(`data: ${JSON.stringify({ type: "trades",  trades:  initTrades  })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "signals", signals: initSignals })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "connected", ts: Date.now()      })}\n\n`);

    req.on("close", () => sseClients.delete(res));
    return;
  }

  // ── WS Auth proxy ────────────────────────────────────────────────────────
  if (urlPath === "/ws-auth") {
    const cfg   = readJSON(CFG_FILE, {});
    const token = cfg.token;
    if (!token) return json(res, { error: "Token missing — run setup.js" }, 401);

    const upReq = https.request({
      hostname: "api.upstox.com",
      path:     "/v3/feed/market-data-feed/authorize",
      method:   "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    }, upRes => {
      let d = "";
      upRes.on("data", c => d += c);
      upRes.on("end", () => {
        try { json(res, JSON.parse(d), upRes.statusCode); }
        catch { json(res, { error: "Invalid WS auth response from Upstox" }, 502); }
      });
    });
    upReq.on("error", e => json(res, { error: e.message }, 502));
    upReq.end();
    return;
  }

  // ── REST API ─────────────────────────────────────────────────────────────
  if (urlPath.startsWith("/api/")) {
    let body = "";
    let bodyTooLarge = false;
    req.on("data", d => {
      if (bodyTooLarge) return;
      if (Buffer.byteLength(body) + d.length > MAX_API_BODY_BYTES) {
        bodyTooLarge = true;
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Request body too large" }));
        try { req.destroy(); } catch {}
        return;
      }
      body += d;
    });
    req.on("end", async () => {
      try {
        if (bodyTooLarge) return;
        let parsed = {};
        if (body) {
          try { parsed = JSON.parse(body); }
          catch { return json(res, { ok: false, error: "Invalid JSON body" }, 400); }
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return json(res, { ok: false, error: "JSON body must be an object" }, 400);
        }

        // ── GET /api/config ──────────────────────────────────────────────
        if (req.method === "GET" && urlPath === "/api/config") {
          const cfg  = await readJSONAsync(CFG_FILE, {});
          const safe = { ...cfg, token: cfg.token ? "****" + cfg.token.slice(-4) : "" };
          return json(res, safe);
        }

        // ── POST /api/token ──────────────────────────────────────────────
        if (req.method === "POST" && urlPath === "/api/token") {
          if (!requireAdmin(req, res)) return;
          const { token } = parsed;
          if (!token || typeof token !== "string" || !token.startsWith("eyJ"))
            return json(res, { ok: false, error: "Invalid token — must be JWT starting with eyJ" }, 400);
          const cfg = await readJSONAsync(CFG_FILE, {});
          cfg.token = token.trim();
          if (!await writeJSONAsync(CFG_FILE, cfg)) return failWrite(res, "config");
          if (!await writeJSONAsync(CMD_FILE, { cmd: "reload_token", ts: Date.now() })) return failWrite(res, "command");
          console.log(G("🔑 Token updated via UI"));
          exec(`termux-notification --title "🔑 FCB Bot V6" --content "Token updated" --id 7001`, () => {});
          return json(res, { ok: true, message: "Token updated — bot reloading config" });
        }

        // ── POST /api/settings ───────────────────────────────────────────
        if (req.method === "POST" && urlPath === "/api/settings") {
          if (!requireAdmin(req, res)) return;
          let cfg = await readJSONAsync(CFG_FILE, {});
          cfg = ensureModeSettings(cfg);
          const { mode, riskPct, dailyLossLimit, maxTrades, wallet, paperMode, confirmLive,
                  scoreThreshold, stockTier, niftyFilter, liveShortAllowlist } = parsed;
          const modeKey = mode === "paper" || mode === "live"
            ? mode
            : (cfg.paperMode !== false ? "paper" : "live");
          const modeCfg = cfg.modeSettings[modeKey];

          if (riskPct !== undefined) {
            const n = Number(riskPct);
            if (!Number.isFinite(n)) return json(res, { ok: false, error: "riskPct must be numeric" }, 400);
            modeCfg.riskPct = Math.min(10, Math.max(0.1, n));
          }
          if (dailyLossLimit !== undefined) {
            const n = Number(dailyLossLimit);
            if (!Number.isFinite(n)) return json(res, { ok: false, error: "dailyLossLimit must be numeric" }, 400);
            modeCfg.dailyLossLimit = Math.max(0, n);
          }
          if (maxTrades !== undefined) {
            const n = Number(maxTrades);
            if (!Number.isFinite(n)) return json(res, { ok: false, error: "maxTrades must be numeric" }, 400);
            modeCfg.maxTrades = Math.min(20, Math.max(1, Math.trunc(n)));
          }
          if (wallet !== undefined) {
            const n = Number(wallet);
            if (!Number.isFinite(n)) return json(res, { ok: false, error: "wallet must be numeric" }, 400);
            modeCfg.wallet = Math.max(100, n);
          }
          if (paperMode !== undefined) {
            if (typeof paperMode !== "boolean") return json(res, { ok: false, error: "paperMode must be boolean" }, 400);
            // Server-side safety gate: LIVE mode requires explicit confirmation token.
            if (paperMode === false && confirmLive !== "LIVE") {
              return json(res, {
                ok: false,
                error: "LIVE mode requires explicit confirmation (confirmLive: 'LIVE').",
              }, 400);
            }
            cfg.paperMode = !!paperMode;
          }
          if (scoreThreshold !== undefined) {
            const n = Number(scoreThreshold);
            if (!Number.isFinite(n)) return json(res, { ok: false, error: "scoreThreshold must be numeric" }, 400);
            modeCfg.scoreThreshold = Math.min(10, Math.max(1, Math.trunc(n)));
          }
          if (stockTier !== undefined) {
            if (!["tier1", "tier1+2", "all"].includes(stockTier)) {
              return json(res, { ok: false, error: "stockTier must be tier1|tier1+2|all" }, 400);
            }
            modeCfg.stockTier = stockTier;
          }
          if (niftyFilter !== undefined) {
            if (typeof niftyFilter !== "boolean") return json(res, { ok: false, error: "niftyFilter must be boolean" }, 400);
            modeCfg.niftyFilter = niftyFilter;
          }
          if (liveShortAllowlist !== undefined) {
            if (!Array.isArray(liveShortAllowlist) || liveShortAllowlist.some(s => typeof s !== "string" || !s.trim())) {
              return json(res, { ok: false, error: "liveShortAllowlist must be an array of non-empty stock names" }, 400);
            }
            cfg.liveShortAllowlist = [...new Set(liveShortAllowlist.map(s => s.trim()))];
          }

          // Legacy compatibility (root mirrors active mode).
          cfg.wallet         = modeCfg.wallet;
          cfg.riskPct        = modeCfg.riskPct;
          cfg.dailyLossLimit = modeCfg.dailyLossLimit;
          cfg.maxTrades      = modeCfg.maxTrades;
          cfg.scoreThreshold = modeCfg.scoreThreshold;
          cfg.stockTier      = modeCfg.stockTier;
          cfg.niftyFilter    = modeCfg.niftyFilter;

          if (!await writeJSONAsync(CFG_FILE, cfg)) return failWrite(res, "config");
          if (!await writeJSONAsync(CMD_FILE, { cmd: "reload_settings", ts: Date.now() })) return failWrite(res, "command");
          console.log(G("⚙️  Settings updated via UI"));
          return json(res, { ok: true, message: "Settings saved" });
        }

        // ── POST /api/cmd ────────────────────────────────────────────────
        if (req.method === "POST" && urlPath === "/api/cmd") {
          if (!requireAdmin(req, res)) return;
          const { cmd, strats } = parsed;
          const currentTrades = await readJSONAsync(TRD_FILE, []);
          if (typeof cmd !== "string" || !cmd.trim()) {
            return json(res, { ok: false, error: "cmd must be a non-empty string" }, 400);
          }
          // BUG #8 FIX: "clear_trades" now in allowed list
          const allowed = ["stop", "resume", "scan", "reload_token", "reload_settings", "clear_trades", "delete_trades", "manual_paper"];
          if (!allowed.includes(cmd))
            return json(res, { ok: false, error: `Unknown command '${cmd}'` }, 400);

          if (cmd === "scan" && strats !== undefined) {
            const valid = ["FCB", "ORB", "VWAP", "EMA", "GAP", "ST_MACD", "RSI_DIV", "BB_SQZ", "ADX_EMA"];
            if (!Array.isArray(strats) || strats.length === 0 || strats.some(s => typeof s !== "string" || !valid.includes(s))) {
              return json(res, { ok: false, error: "strats must be array of valid strategy codes" }, 400);
            }
          }

          if (cmd === "manual_paper") {
            const t = parsed.trade;
            const ok = t && typeof t === "object" &&
              typeof t.name === "string" &&
              (t.direction === "BUY" || t.direction === "SELL") &&
              Number.isFinite(Number(t.qty)) &&
              Number.isFinite(Number(t.entry)) &&
              Number.isFinite(Number(t.target)) &&
              Number.isFinite(Number(t.sl));
            if (!ok) {
              return json(res, { ok: false, error: "trade payload invalid for manual_paper" }, 400);
            }
          }

          if (cmd === "delete_trades") {
            const idx = parsed.indexes;
            if (!Array.isArray(idx) || idx.length === 0 ||
                idx.some(n => !Number.isInteger(n) || n < 0)) {
              return json(res, { ok: false, error: "indexes must be a non-empty array of non-negative integers" }, 400);
            }
            if (hasProtectedLiveTrades(currentTrades, idx)) {
              return json(res, { ok: false, error: "Cannot delete open live trades. Square them off first." }, 409);
            }
          }

          if (cmd === "clear_trades" && hasProtectedLiveTrades(currentTrades)) {
            return json(res, { ok: false, error: "Cannot clear while open live trades exist. Square them off first." }, 409);
          }

          const cmdObj = { cmd, ts: Date.now() };
          if (strats) cmdObj.strats = strats;
          if (cmd === "manual_paper" && parsed.trade) cmdObj.trade = parsed.trade;
          if (cmd === "delete_trades" && parsed.indexes) cmdObj.indexes = parsed.indexes;
          if (!await writeJSONAsync(CMD_FILE, cmdObj)) return failWrite(res, "command");
          console.log(Y(`📨 Command → bot: ${cmd}`));

          // When clear_trades fires, also push empty state via SSE immediately
          // so UI updates without waiting for file watcher
          if (cmd === "clear_trades") {
            sseWrite({ type: "trades",  trades:  [] });
            sseWrite({ type: "signals", signals: [] });
          }

          return json(res, { ok: true, message: `Command '${cmd}' sent` });
        }

        // ── GET /api/trades ──────────────────────────────────────────────
        if (req.method === "GET" && urlPath === "/api/trades") {
          return json(res, await readJSONAsync(TRD_FILE, []));
        }

        // ── DELETE /api/trades ───────────────────────────────────────────
        if (req.method === "DELETE" && urlPath === "/api/trades") {
          if (!requireAdmin(req, res)) return;
          const currentTrades = await readJSONAsync(TRD_FILE, []);
          const idx = parsed.indexes;

          // Mode 1: selective delete by indexes
          if (idx !== undefined) {
            if (!Array.isArray(idx) || idx.length === 0 ||
                idx.some(n => !Number.isInteger(n) || n < 0 || n >= currentTrades.length)) {
              return json(res, { ok: false, error: "indexes must be valid trade indexes within current trade list" }, 400);
            }
            if (hasProtectedLiveTrades(currentTrades, idx)) {
              return json(res, { ok: false, error: "Cannot delete open live trades. Square them off first." }, 409);
            }
            const toDelete = new Set(idx);
            const nextTrades = currentTrades.filter((_, i) => !toDelete.has(i));
            if (!await writeJSONAsync(TRD_FILE, nextTrades)) return failWrite(res, "trades");
            if (!await writeJSONAsync(CMD_FILE, {
              cmd: "delete_trades",
              indexes: [...toDelete],
              ts: Date.now(),
            })) return failWrite(res, "command");
            sseWrite({ type: "trades", trades: nextTrades });
            return json(res, { ok: true, deleted: toDelete.size, remaining: nextTrades.length });
          }

          // Mode 2: clear all (legacy behavior)
          if (hasProtectedLiveTrades(currentTrades)) {
            return json(res, { ok: false, error: "Cannot clear while open live trades exist. Square them off first." }, 409);
          }
          if (!await writeJSONAsync(TRD_FILE, [])) return failWrite(res, "trades");
          if (!await writeJSONAsync(SIG_FILE, [])) return failWrite(res, "signals");
          if (!await writeJSONAsync(CMD_FILE, { cmd: "clear_trades", ts: Date.now() })) return failWrite(res, "command");
          sseWrite({ type: "trades",  trades:  [] });
          sseWrite({ type: "signals", signals: [] });
          return json(res, { ok: true, deleted: currentTrades.length, remaining: 0 });
        }

        // ── GET /api/signals ─────────────────────────────────────────────
        if (req.method === "GET" && urlPath === "/api/signals") {
          return json(res, await readJSONAsync(SIG_FILE, []));
        }

        // ── GET /api/status ──────────────────────────────────────────────
        if (req.method === "GET" && urlPath === "/api/status") {
          let cfg = await readJSONAsync(CFG_FILE, {});
          cfg = ensureModeSettings(cfg);
          const activeMode = cfg.paperMode !== false ? "paper" : "live";
          const active = cfg.modeSettings[activeMode];
          const botStatus = await getBotStatus();
          const managedBotRunning = !!botChild && botChild.exitCode === null && !botChild.killed;
          const botRunning = botStatus?.running === true || managedBotRunning;
          return json(res, {
            running:        botRunning,
            botRunning,
            version:        APP_VERSION,
            paperMode:      cfg.paperMode       !== false,
            wallet:         active.wallet,
            riskPct:        active.riskPct,
            maxTrades:      active.maxTrades,
            dailyLossLimit: active.dailyLossLimit,
            scoreThreshold: active.scoreThreshold,
            stockTier:      active.stockTier,
            niftyFilter:    active.niftyFilter,
            brokeragePerOrder: Number(cfg.brokeragePerOrder || 20),
            liveShortAllowlist: cfg.liveShortAllowlist,
            modeSettings:   cfg.modeSettings,
            currentLogFile: path.basename(todayLogFile()),
            botStatus,
          });
        }

        // ── GET /api/health ──────────────────────────────────────────────
        // Lightweight operational endpoint for uptime monitors and scripts.
        if (req.method === "GET" && urlPath === "/api/health") {
          const mem = process.memoryUsage();
          return json(res, {
            ok: true,
            status: "healthy",
            version: APP_VERSION,
            uptimeSec: processUptimeSec(),
            nowIso: new Date().toISOString(),
            memory: {
              rss: mem.rss,
              heapTotal: mem.heapTotal,
              heapUsed: mem.heapUsed,
              external: mem.external,
            },
          });
        }

        // ── GET /api/pnl ─────────────────────────────────────────────────
        if (req.method === "GET" && urlPath === "/api/pnl") {
          const today  = todayStr();
          const trades = await readJSONAsync(TRD_FILE, []);
          const daily  = trades.filter(t => t.date === today);
          const pnl    = daily.reduce((s, t) => s + (t.pnl || 0), 0);
          return json(res, {
            pnl,
            liveTradeCount:  daily.filter(t => !t.paper).length,
            paperTradeCount: daily.filter(t => t.paper).length,
            openCount:       daily.filter(t => t.status === "OPEN" || t.status === "PAPER").length,
            total:           daily.length,
          });
        }

        // ── GET /api/logs ────────────────────────────────────────────────
        // Used by UI log tab (last 500 lines by default) and
        // by catch-up endpoint (?since=timestamp).
        // NEW: ?since= returns only lines after that timestamp.
        // NEW: ?date= reads a specific day's log file.
        // NEW: ?all=1 returns all lines (for download, no limit).
        if (req.method === "GET" && urlPath === "/api/logs") {
          const dateParam  = qp.get("date") || "today";
          const sinceParam = qp.get("since") || "";
          const allLines   = qp.get("all")   === "1";
          const filePath   = logFileForDate(dateParam);

          if (sinceParam) {
            // Catch-up: lines since a given timestamp
            const lines = await readLinesSince(filePath, sinceParam);
            return json(res, { lines, count: lines.length, date: dateParam });
          }

          const lines = await readLastLines(filePath, allLines ? 0 : 500);
          return json(res, { lines, count: lines.length, date: dateParam });
        }

        // ── GET /api/logs/dates ──────────────────────────────────────────
        // NEW: returns list of all dates that have log files, for date picker.
        if (req.method === "GET" && urlPath === "/api/logs/dates") {
          return json(res, { dates: await getLogDates() });
        }

        // ── GET /api/logs/download ───────────────────────────────────────
        // NEW: single-click download in TXT, CSV, or JSON format.
        // ?format=txt|csv|json  ?date=YYYY-MM-DD (default: today)
        if (req.method === "GET" && urlPath === "/api/logs/download") {
          const fmt      = qp.get("format") || "txt";
          const dateParam = qp.get("date")  || "today";
          const filePath  = logFileForDate(dateParam);
          const dateLabel = dateParam === "today" ? todayStr() : dateParam;

          // All lines — no limit for download
          const lines = await readLastLines(filePath, 0);

          let content     = "";
          let contentType = "text/plain";
          let filename    = `fcb_log_${dateLabel}.${fmt}`;

          if (fmt === "txt") {
            content     = `FCB BOT V6 LOG — ${dateLabel}\n${"─".repeat(50)}\n${lines.join("\n")}`;
            contentType = "text/plain";
          } else if (fmt === "csv") {
            const header = "Date,Time,Type,Message\n";
            const rows   = lines.map(line => {
              // Parse: [10:37:42 am] [INFO] message
              const m = line.match(/^\[(.+?)\] \[(.+?)\] (.+)$/);
              if (!m) return `"${dateLabel}","","","${line.replace(/"/g, "'")}"`;
              return `"${dateLabel}","${m[1]}","${m[2]}","${m[3].replace(/"/g, "'")}"`;
            });
            content     = header + rows.join("\n");
            contentType = "text/csv";
          } else if (fmt === "json") {
            const entries = lines.map(line => {
              const m = line.match(/^\[(.+?)\] \[(.+?)\] (.+)$/);
              if (!m) return { date: dateLabel, ts: "", type: "RAW", msg: line };
              return { date: dateLabel, ts: m[1], type: m[2], msg: m[3] };
            });
            content     = JSON.stringify(entries, null, 2);
            contentType = "application/json";
          } else {
            return json(res, { error: "Invalid format. Use txt, csv, or json." }, 400);
          }

          cors(res);
          res.writeHead(200, {
            "Content-Type":        `${contentType}; charset=utf-8`,
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Cache-Control":       "no-cache",
          });
          if (fmt === "txt") {
            const header = `FCB BOT V6 LOG — ${dateLabel}\n${"─".repeat(50)}\n`;
            res.write(header);
            const stream = fs.createReadStream(filePath, { encoding: "utf8" });
            stream.pipe(res);
            stream.on("error", () => res.end());
          } else {
            res.end(content);
          }
          return;
        }

        return json(res, { error: "Not found" }, 404);

      } catch (e) {
        console.error(R("API error: " + e.message));
        json(res, { error: e.message }, 500);
      }
    });
    return;
  }

  // ── STATIC FILES ─────────────────────────────────────────────────────────
  const safeBase = path.resolve(DIR);
  let filePath   = urlPath === "/" ? path.join(DIR, "index.html") : path.join(DIR, urlPath);
  filePath       = path.resolve(filePath);

  // Path traversal guard
  if (!filePath.startsWith(safeBase)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }

  const ext  = path.extname(filePath);
  const mime = MIME[ext] || "text/plain";

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Fall back to index.html for SPA routing
      fs.readFile(path.join(DIR, "index.html"), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end("Not found"); return; }
        cors(res);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(d2);
      });
      return;
    }
    cors(res);
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  });
});

// ─── START ────────────────────────────────────────────────────────────────────
server.listen(PORT, "0.0.0.0", () => {
  console.log(W("\n⚡ FCB BOT V6 — BRIDGE SERVER"));
  console.log("─".repeat(50));
  console.log(G(`✅  UI:       http://localhost:${PORT}`));
  console.log(G(`✅  API:      http://localhost:${PORT}/api/`));
  console.log(G(`✅  Events:   http://localhost:${PORT}/events`));
  console.log(G(`✅  WS-Auth:  http://localhost:${PORT}/ws-auth`));
  console.log(G(`✅  Download: http://localhost:${PORT}/api/logs/download?format=csv`));
  console.log(B(`🔐 Admin key: ${ADMIN_KEY ? "ENABLED" : "MISSING (write APIs locked)"}`));
  console.log(B(`🌐 CORS allowlist: ${ALLOWED_ORIGINS.join(", ")}`));
  console.log("─".repeat(50));
  console.log(Y(`Open Chrome → http://localhost:${PORT}`));
  console.log(Y("Press Ctrl+C to stop\n"));

  if (!fs.existsSync(CFG_FILE)) {
    console.log(R("⚠️  config.json not found — run `node setup.js` first!"));
  } else {
    const cfg = readJSON(CFG_FILE, {});
    console.log(B(`ℹ️  Paper: ${cfg.paperMode !== false} | Wallet: ₹${cfg.wallet || 5000} | Score≥${cfg.scoreThreshold || 6}`));
  }

  // Log available log files
  // BUG-8 FIX: getLogDates() is async; calling without await returns a Promise.
  // Promise.length is undefined so dates.length > 0 was always false. Use .then().
  getLogDates().then(dates => {
    if (dates.length > 0)
      console.log(B(`📋 Log files: ${dates.slice(0, 5).join(", ")}${dates.length > 5 ? "..." : ""}`));
  });
});

// ─── SERVER ERROR ─────────────────────────────────────────────────────────────
server.on("error", e => {
  if (e.code === "EADDRINUSE") {
    console.log(Y(`⚠️  Port ${PORT} is already in use.`));
    console.log(Y("   Check with: lsof -i :8080  or  pkill -f bridge.js"));
  } else {
    console.log(R("❌ Server error: " + e.message));
  }
});

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(Y(`\n🛑 ${signal} — shutting down bridge`));
  if (botChild) {
    console.log(Y("   Stopping bot.js child…"));
    botChild.removeAllListeners("exit");
    botChild.kill("SIGTERM");
  }
  // Stop log file watcher
  try { fs.unwatchFile(watchedLogFile); } catch {}
  // Close all SSE connections cleanly
  for (const c of sseClients) { try { c.end(); } catch {} }
  server.close(() => {
    console.log(G("✅  Bridge stopped cleanly."));
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 3000);
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
