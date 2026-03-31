#!/usr/bin/env node
"use strict";

const assert = require("assert");
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

    console.log("✅ bridge api smoke tests passed");
  } finally {
    try { child.kill("SIGTERM"); } catch {}
  }
}

main().catch(err => {
  console.error("❌ bridge api smoke tests failed:", err.message);
  process.exit(1);
});
