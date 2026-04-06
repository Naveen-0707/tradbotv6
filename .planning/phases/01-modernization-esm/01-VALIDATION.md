# Phase 01: Modernization (ESM) - Validation Strategy

**Gathered:** 2026-04-06
**Status:** Ready for planning

## Dimension 1: Static Analysis
- [ ] ALL files in `CWD/` use `import`/`export` syntax.
- [ ] No `require()` or `module.exports` exist in `bot.js`, `bridge.js`, `strategies.js`, `indicators.js`, `proto-decoder.js`.
- [ ] `package.json` contains `"type": "module"`.

## Dimension 2: Core Execution
- [ ] `node bot.js` exits 1 if `config.json` is missing (correct error path).
- [ ] `node bridge.js` starts a server on port 8080 (or `FCB_BRIDGE_PORT`).
- [ ] `node backtest.js` loads historical candles correctly.

## Dimension 3: Automated Tests
- [ ] `node tests/indicators.smoke.js` passes.
- [ ] `node tests/strategies.smoke.js` passes.
- [ ] `node tests/bridge.api.smoke.js` passes.

## Dimension 4: External Integrations
- [ ] Upstox API calls still succeed (verify via logs).
- [ ] Protobuf decoding of market data works (verify via logs if possible).
---
*Phase: 01-modernization-esm*
*Validation Strategy defined: 2026-04-06*
