# Phase 01: Modernization (ESM) - Context

**Gathered:** 2026-04-06
**Status:** Ready for planning
**Source:** PRD Express Path (.planning/prd.json)

<domain>
## Phase Boundary
Convert the entire tradbotv6 codebase to formal ES Modules (ESM) while preserving all trading logic and strategy performance.

This phase delivers:
- Codebase-wide transition from CommonJS (`require`/`module.exports`) to ESM (`import`/`export`).
- Formalized dependency and environment management via `package.json`.
- Verified execution of all core logic in the new ESM environment.

</domain>

<decisions>
## Implementation Decisions

### Syntax & Standards
- **Standard**: ESM (`import`/`export`) throughout.
- **Node.js Config**: Set `"type": "module"` in the root `package.json`.
- **Top-level await**: Allowed where necessary for startup logic (e.g., loading config).

### Code Migration (LOCKED)
- [MOD-01] Convert ALL core scripts: `bot.js`, `bridge.js`, `strategies.js`, `indicators.js`, `proto-decoder.js`.
- [MOD-02] Create a root `package.json` with `type: "module"` and appropriate metadata.
- [MOD-03] Update all files in `tests/` to use ESM and ensure they execute without errors.

### the agent's Discretion
- Selection of specific ESM patterns (e.g., named vs default exports for strategies).
- Any necessary shims for `__dirname` or `__filename` (as these don't exist in ESM by default).
- Order of migration (bot vs bridge).

</decisions>

<canonical_refs>
## Canonical References
**Downstream agents MUST read these before planning or implementing.**

### Core Scripts
- `bot.js` — Main execution logic (Migration target)
- `bridge.js` — API/UI server (Migration target)
- `strategies.js` — Trading strategies (Migration target)
- `indicators.js` — Technical indicators (Migration target)
- `proto-decoder.js` — Protobuf logic (Migration target)

### Testing
- `tests/indicators.smoke.js` — Indicator validation
- `tests/strategies.smoke.js` — Strategy validation
- `tests/bridge.api.smoke.js` — API validation

</canonical_refs>

<specifics>
## Specific Ideas
- Use `path.join(path.dirname(url.fileURLToPath(import.meta.url)), ...)` for directory references in ESM.
- Ensure `MarketDataFeed.proto` loading still works correctly after the migration.

</specifics>

<deferred>
## Deferred Ideas
- SQLite integration (Moved to Phase 2)
- UI notifications (Moved to Phase 3)

</deferred>

---
*Phase: 01-modernization-esm*
*Context gathered: 2026-04-06 via PRD Express Path*
