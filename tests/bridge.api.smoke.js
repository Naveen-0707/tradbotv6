#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ADMIN_KEY = "smoke-admin-key";
const BASE = "http://127.0.0.1:8080";

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function req(path, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(`${BASE}${path}`, { method, headers, body });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

async function waitUntilUp(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await req("/api/status");
      if (r.status === 200) return;
    } catch {}
    await sleep(300);
  }
  throw new Error("bridge did not start in time");
}

async function main() {
  const TRD_FILE = path.join(process.cwd(), "fcb_trades.json");
  const seedTrades = [
    { name: "SBIN", status: "OPEN", qty: 1, paper: false },
    { name: "RELIANCE", status: "PAPER", qty: 1, paper: true },
    { name: "INFY", status: "PAPER", qty: 1 },
    { name: "TCS", status: "PAPER", qty: 1 },
  ];
  fs.writeFileSync(TRD_FILE, JSON.stringify(seedTrades, null, 2));

  const child = spawn("node", ["bridge.js"], {
    cwd: process.cwd(),
    stdio: "ignore",
    env: { ...process.env, FCB_ADMIN_KEY: ADMIN_KEY, FCB_ALLOWED_ORIGINS: "http://localhost:8080" },
  });

  try {
    await waitUntilUp();

    // 1) write API blocked without admin key
    {
      const r = await req("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: 5000 }),
      });
      assert.strictEqual(r.status, 401, "Expected 401 for missing admin key");
    }

    // 2) invalid JSON gets 400
    {
      const r = await req("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-fcb-admin-key": ADMIN_KEY },
        body: "{",
      });
      assert.strictEqual(r.status, 400, "Expected 400 for invalid JSON");
    }

    // 3) LIVE requires confirmation token
    {
      const r = await req("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-fcb-admin-key": ADMIN_KEY },
        body: JSON.stringify({ paperMode: false }),
      });
      assert.strictEqual(r.status, 400, "Expected 400 when confirmLive missing");
    }

    // 4) oversized body gets 413
    {
      const huge = JSON.stringify({ x: "a".repeat(1_100_000) });
      const r = await req("/api/cmd", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-fcb-admin-key": ADMIN_KEY },
        body: huge,
      });
      assert.strictEqual(r.status, 413, "Expected 413 for oversized body");
    }

    // 5) status exposes version
    {
      const r = await req("/api/status");
      assert.strictEqual(r.status, 200, "Expected 200 from /api/status");
      assert.strictEqual(typeof r.json?.version, "string", "Expected status.version to be a string");
    }

    // 6) health endpoint is operational
    {
      const r = await req("/api/health");
      assert.strictEqual(r.status, 200, "Expected 200 from /api/health");
      assert.strictEqual(r.json?.ok, true, "Expected health.ok=true");
      assert.strictEqual(r.json?.status, "healthy", "Expected health.status=healthy");
      assert.strictEqual(typeof r.json?.uptimeSec, "number", "Expected health.uptimeSec to be numeric");
    }

    // 7) deleting an open live trade is blocked
    {
      const r = await req("/api/trades", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "x-fcb-admin-key": ADMIN_KEY },
        body: JSON.stringify({ indexes: [0] }),
      });
      assert.strictEqual(r.status, 409, "Expected 409 when deleting an open live trade");
    }

    // 8) selective trade deletion by indexes
    {
      const r = await req("/api/trades", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "x-fcb-admin-key": ADMIN_KEY },
        body: JSON.stringify({ indexes: [2] }),
      });
      assert.strictEqual(r.status, 200, "Expected 200 for selective delete");
      assert.strictEqual(r.json?.ok, true, "Expected selective delete ok=true");
      const tradesAfter = JSON.parse(fs.readFileSync(TRD_FILE, "utf8"));
      assert.strictEqual(tradesAfter.length, 3, "Expected one trade to be deleted");
      assert.deepStrictEqual(tradesAfter.map(t => t.name), ["SBIN", "RELIANCE", "TCS"], "Expected INFY (index 2) to be removed");
    }

    // 9) clearing all trades is blocked while an open live trade exists
    {
      const r = await req("/api/trades", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "x-fcb-admin-key": ADMIN_KEY },
        body: JSON.stringify({}),
      });
      assert.strictEqual(r.status, 409, "Expected 409 when clearing while open live trades exist");
    }

    console.log("✅ bridge api smoke tests passed");
  } finally {
    try { child.kill("SIGTERM"); } catch {}
  }
}

main().catch(err => {
  console.error("❌ bridge api smoke tests failed:", err.message);
  process.exit(1);
});
