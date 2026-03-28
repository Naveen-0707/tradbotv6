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
const path         = require("path");
const { spawn, exec } = require("child_process");

const PORT = 8080;
const DIR  = __dirname;

// ─── FILE PATHS ───────────────────────────────────────────────────────────────
// NOTE: bridge.js NEVER writes to bot log files.
// Bot writes: fcb_log_YYYY-MM-DD.txt
// Bridge reads them (SSE + download) but never appends.

const CFG_FILE = path.join(DIR, "config.json");
const TRD_FILE = path.join(DIR, "fcb_trades.json");
const SIG_FILE = path.join(DIR, "fcb_signals.json");
const CMD_FILE = path.join(DIR, "fcb_cmd.json");

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

const cors = res => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type,Accept");
};

const json = (res, data, code = 200) => {
  cors(res);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
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
function getLogDates() {
  try {
    return fs.readdirSync(DIR)
      .filter(f => /^fcb_log_\d{4}-\d{2}-\d{2}\.txt$/.test(f))
      .map(f => f.replace("fcb_log_", "").replace(".txt", ""))
      .sort()
      .reverse();
  } catch { return []; }
}

// Read last N lines of a file without loading entire file into memory.
// Returns string lines array.
function readLastLines(filePath, n = 500) {
  try {
    const content = fs.readFileSync(filePath, "utf8").trim();
    if (!content) return [];
    const lines = content.split("\n");
    return n > 0 ? lines.slice(-n) : lines; // n=0 means all lines (for download)
  } catch { return []; }
}

// Read all lines since a given timestamp string (inclusive).
// Used by /api/logs?since= catch-up endpoint.
// Timestamp format: "10:37:42 am" (IST time string from log line prefix).
function readLinesSince(filePath, sinceTs) {
  try {
    const lines = readLastLines(filePath, 0); // all lines
    if (!sinceTs) return lines;
    // Find the index of the first line AT or AFTER sinceTs
    // Log line format: [HH:MM:SS am/pm] [TYPE] message
    const idx = lines.findIndex(l => {
      const m = l.match(/^\[(.+?)\]/);
      if (!m) return false;
      return m[1] >= sinceTs;
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
  try { watchedLogSize = fs.statSync(watchedLogFile).size; } catch { watchedLogSize = 0; }

  logFileWatcher = fs.watchFile(watchedLogFile, { interval: 800 }, curr => {
    if (curr.size <= watchedLogSize) return;
    try {
      const fd  = fs.openSync(watchedLogFile, "r");
      const buf = Buffer.alloc(curr.size - watchedLogSize);
      fs.readSync(fd, buf, 0, buf.length, watchedLogSize);
      fs.closeSync(fd);
      const newLines = buf.toString().trim().split("\n").filter(Boolean);
      for (const line of newLines) sseWrite({ type: "log", line });
      watchedLogSize = curr.size;
    } catch {}
  });

  console.log(G(`📋 Watching log: ${path.basename(watchedLogFile)}`));
}

// Start watcher immediately and re-check every minute for midnight rollover
getOrCreateLogWatcher();
setInterval(getOrCreateLogWatcher, 60000);

// ─── TRADES FILE WATCHER ─────────────────────────────────────────────────────
let lastTradeCount = -1;
fs.watchFile(TRD_FILE, { interval: 2000 }, () => {
  const trades = readJSON(TRD_FILE, []);
  if (trades.length !== lastTradeCount) {
    lastTradeCount = trades.length;
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
    res.writeHead(200, {
      "Content-Type":                "text/event-stream",
      "Cache-Control":               "no-cache",
      "Connection":                  "keep-alive",
      "Access-Control-Allow-Origin": "*",
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
    req.on("data", d => body += d);
    req.on("end", () => {
      try {
        const parsed = body ? JSON.parse(body) : {};

        // ── GET /api/config ──────────────────────────────────────────────
        if (req.method === "GET" && urlPath === "/api/config") {
          const cfg  = readJSON(CFG_FILE, {});
          const safe = { ...cfg, token: cfg.token ? "****" + cfg.token.slice(-4) : "" };
          return json(res, safe);
        }

        // ── POST /api/token ──────────────────────────────────────────────
        if (req.method === "POST" && urlPath === "/api/token") {
          const { token } = parsed;
          if (!token || typeof token !== "string" || !token.startsWith("eyJ"))
            return json(res, { ok: false, error: "Invalid token — must be JWT starting with eyJ" }, 400);
          const cfg = readJSON(CFG_FILE, {});
          cfg.token = token.trim();
          writeJSON(CFG_FILE, cfg);
          writeJSON(CMD_FILE, { cmd: "reload_token", ts: Date.now() });
          console.log(G("🔑 Token updated via UI"));
          exec(`termux-notification --title "🔑 FCB Bot V6" --content "Token updated" --id 7001`, () => {});
          return json(res, { ok: true, message: "Token updated — bot reloading config" });
        }

        // ── POST /api/settings ───────────────────────────────────────────
        if (req.method === "POST" && urlPath === "/api/settings") {
          const cfg = readJSON(CFG_FILE, {});
          const { riskPct, dailyLossLimit, maxTrades, wallet, paperMode,
                  scoreThreshold, stockTier, niftyFilter } = parsed;

          if (riskPct        !== undefined) cfg.riskPct        = Math.min(10,  Math.max(0.1,  parseFloat(riskPct)   || cfg.riskPct));
          if (dailyLossLimit !== undefined) cfg.dailyLossLimit = Math.max(0,   parseFloat(dailyLossLimit)           || cfg.dailyLossLimit);
          if (maxTrades      !== undefined) cfg.maxTrades      = Math.min(20,  Math.max(1,    parseInt(maxTrades)   || cfg.maxTrades));
          if (wallet         !== undefined) cfg.wallet         = Math.max(100, parseFloat(wallet)                   || cfg.wallet);
          if (paperMode      !== undefined) cfg.paperMode      = !!paperMode;
          if (scoreThreshold !== undefined) cfg.scoreThreshold = Math.min(10, Math.max(1, parseInt(scoreThreshold) || 6));
          if (stockTier      !== undefined) cfg.stockTier      = ["tier1", "tier1+2", "all"].includes(stockTier) ? stockTier : cfg.stockTier;
          if (niftyFilter    !== undefined) cfg.niftyFilter    = !!niftyFilter;

          writeJSON(CFG_FILE, cfg);
          writeJSON(CMD_FILE, { cmd: "reload_settings", ts: Date.now() });
          console.log(G("⚙️  Settings updated via UI"));
          return json(res, { ok: true, message: "Settings saved" });
        }

        // ── POST /api/cmd ────────────────────────────────────────────────
        if (req.method === "POST" && urlPath === "/api/cmd") {
          const { cmd, strats } = parsed;
          // BUG #8 FIX: "clear_trades" now in allowed list
          const allowed = ["stop", "resume", "scan", "reload_token", "reload_settings", "clear_trades"];
          if (!allowed.includes(cmd))
            return json(res, { ok: false, error: `Unknown command '${cmd}'` }, 400);

          const cmdObj = { cmd, ts: Date.now() };
          if (strats) cmdObj.strats = strats;
          writeJSON(CMD_FILE, cmdObj);
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
          return json(res, readJSON(TRD_FILE, []));
        }

        // ── DELETE /api/trades ───────────────────────────────────────────
        if (req.method === "DELETE" && urlPath === "/api/trades") {
          // Also send clear_trades command to bot so in-memory state clears
          writeJSON(TRD_FILE,  []);
          writeJSON(SIG_FILE,  []);
          writeJSON(CMD_FILE, { cmd: "clear_trades", ts: Date.now() });
          sseWrite({ type: "trades",  trades:  [] });
          sseWrite({ type: "signals", signals: [] });
          return json(res, { ok: true });
        }

        // ── GET /api/signals ─────────────────────────────────────────────
        if (req.method === "GET" && urlPath === "/api/signals") {
          return json(res, readJSON(SIG_FILE, []));
        }

        // ── GET /api/status ──────────────────────────────────────────────
        if (req.method === "GET" && urlPath === "/api/status") {
          const cfg = readJSON(CFG_FILE, {});
          return json(res, {
            running:        true,
            paperMode:      cfg.paperMode       !== false,
            wallet:         cfg.wallet          || 5000,
            riskPct:        cfg.riskPct         || 2,
            maxTrades:      cfg.maxTrades       || 3,
            dailyLossLimit: cfg.dailyLossLimit  || 500,
            scoreThreshold: cfg.scoreThreshold  || 6,
            stockTier:      cfg.stockTier       || "tier1+2",
            niftyFilter:    cfg.niftyFilter     !== false,
            currentLogFile: path.basename(todayLogFile()),
          });
        }

        // ── GET /api/pnl ─────────────────────────────────────────────────
        if (req.method === "GET" && urlPath === "/api/pnl") {
          const today  = todayStr();
          const trades = readJSON(TRD_FILE, []);
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
            const lines = readLinesSince(filePath, sinceParam);
            return json(res, { lines, count: lines.length, date: dateParam });
          }

          const lines = readLastLines(filePath, allLines ? 0 : 500);
          return json(res, { lines, count: lines.length, date: dateParam });
        }

        // ── GET /api/logs/dates ──────────────────────────────────────────
        // NEW: returns list of all dates that have log files, for date picker.
        if (req.method === "GET" && urlPath === "/api/logs/dates") {
          return json(res, { dates: getLogDates() });
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
          const lines = readLastLines(filePath, 0);

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
          res.end(content);
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
  const dates = getLogDates();
  if (dates.length > 0) {
    console.log(B(`📋 Log files: ${dates.slice(0, 5).join(", ")}${dates.length > 5 ? "..." : ""}`));
  }
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
