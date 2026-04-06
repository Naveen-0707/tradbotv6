import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DIR = __dirname;
const DB_FILE = path.join(DIR, "trades.db");
const TRD_FILE = path.join(DIR, "fcb_trades.json");
const SIG_FILE = path.join(DIR, "fcb_signals.json");

// Connect to SQLite
const db = new Database(DB_FILE);

// Set PRAGMAs for performance and safety
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

// ─── INIT SCHEMA ─────────────────────────────────────────────────────────────
function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      date TEXT,
      name TEXT,
      direction TEXT,
      status TEXT,
      paper INTEGER,
      data TEXT,
      timestamp INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_trades_date ON trades(date);
    CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);

    CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY,
      date TEXT,
      name TEXT,
      data TEXT,
      timestamp INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_signals_date ON signals(date);
  `);
}

initSchema();

// ─── JSON TO SQLITE MIGRATION ─────────────────────────────────────────────
function migrateData() {
  // Only migrate if there are no trades in DB but there is a JSON file
  const count = db.prepare("SELECT COUNT(*) as count FROM trades").get().count;
  if (count > 0) return; // Already migrated or populated

  try {
    if (fs.existsSync(TRD_FILE)) {
      const raw = fs.readFileSync(TRD_FILE, "utf8");
      const trades = JSON.parse(raw);
      if (Array.isArray(trades) && trades.length > 0) {
        console.log(`📦 Migrating ${trades.length} trades from JSON to SQLite...`);
        const insertTrade = db.prepare(`
          INSERT INTO trades (id, date, name, direction, status, paper, data, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        // Use transaction for speed and safety
        db.transaction(() => {
          trades.forEach((trade, idx) => {
            // Reconstruct a persistent ID if one doesn't exist
            const id = trade.id || `trade_${Date.now()}_${idx}`;
            trade.id = id;
            
            insertTrade.run(
              id,
              trade.date || "unknown",
              trade.name || "unknown",
              trade.direction || "unknown",
              trade.status || "unknown",
              trade.paper ? 1 : 0,
              JSON.stringify(trade),
              Date.now()
            );
          });
        })();
        console.log("✅ Trades migrated successfully.");
        
        // Backup the old JSON file
        fs.renameSync(TRD_FILE, `${TRD_FILE}.migrated.bak`);
      }
    }

    if (fs.existsSync(SIG_FILE)) {
      const raw = fs.readFileSync(SIG_FILE, "utf8");
      const signals = JSON.parse(raw);
      if (Array.isArray(signals) && signals.length > 0) {
        console.log(`📦 Migrating ${signals.length} signals from JSON to SQLite...`);
        const insertSignal = db.prepare(`
          INSERT INTO signals (id, date, name, data, timestamp)
          VALUES (?, ?, ?, ?, ?)
        `);

        db.transaction(() => {
          signals.forEach((sig, idx) => {
            const id = sig.id || `sig_${Date.now()}_${idx}`;
            sig.id = id;
            insertSignal.run(
              id,
              sig.date || "unknown",
              sig.name || "unknown",
              JSON.stringify(sig),
              Date.now()
            );
          });
        })();
        console.log("✅ Signals migrated successfully.");
        
        fs.renameSync(SIG_FILE, `${SIG_FILE}.migrated.bak`);
      }
    }
  } catch (err) {
    console.error("⚠️ Error during JSON to SQLite migration:", err.message);
  }
}

migrateData();

// ─── QUERY HELPERS ────────────────────────────────────────────────────────
const stmtInsertTrade = db.prepare(`
  INSERT OR REPLACE INTO trades (id, date, name, direction, status, paper, data, timestamp)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtInsertSignal = db.prepare(`
  INSERT OR REPLACE INTO signals (id, date, name, data, timestamp)
  VALUES (?, ?, ?, ?, ?)
`);

export function getAllTrades() {
  const rows = db.prepare("SELECT data FROM trades ORDER BY timestamp ASC").all();
  return rows.map((r) => JSON.parse(r.data));
}

export function saveTrades(tradesArray) {
  // Overwrites all and ensures sync? In bot.js we pass the whole array usually.
  // A better approach is to save individual trades, but to keep API compatibility:
  db.transaction(() => {
    db.prepare("DELETE FROM trades").run();
    tradesArray.forEach((trade, idx) => {
      const id = trade.id || `trade_${Date.now()}_${idx}`;
      trade.id = id;
      stmtInsertTrade.run(
        id,
        trade.date || "unknown",
        trade.name || "unknown",
        trade.direction || "unknown",
        trade.status || "unknown",
        trade.paper ? 1 : 0,
        JSON.stringify(trade),
        Date.now() + idx
      );
    });
  })();
}

export function getAllSignals() {
  const rows = db.prepare("SELECT data FROM signals ORDER BY timestamp ASC").all();
  return rows.map((r) => JSON.parse(r.data));
}

export function saveSignals(signalsArray) {
  db.transaction(() => {
    db.prepare("DELETE FROM signals").run();
    signalsArray.forEach((sig, idx) => {
      const id = sig.id || `sig_${Date.now()}_${idx}`;
      sig.id = id;
      stmtInsertSignal.run(
        id,
        sig.date || "unknown",
        sig.name || "unknown",
        JSON.stringify(sig),
        Date.now() + idx
      );
    });
  })();
}

export function clearTrades() {
  db.prepare("DELETE FROM trades").run();
  db.prepare("DELETE FROM signals").run();
}

export function clearTradesByIndexes(indexes) {
   const trades = getAllTrades();
   const toDelete = new Set(indexes);
   const remaining = trades.filter((_, i) => !toDelete.has(i));
   saveTrades(remaining);
   return remaining;
}

export function isDbOpen() {
  try {
    return db.open;
  } catch (e) {
    return false;
  }
}
