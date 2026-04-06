# Requirements: tradbotv6 v6.2 Modernization

**Defined:** 2026-04-06
**Core Value:** Modern, high-performance, and reliable algorithmic trading execution with enhanced observability.

## v6.2 Requirements

These requirements define the scope for the v6.2 engineering modernization milestone.

### Modernization (ESM)
- [ ] **MOD-01**: User can run bot and bridge as ES Modules (using `import`/`export` syntax).
- [ ] **MOD-02**: Project has a formal `package.json` defining dependencies and `"type": "module"`.
- [ ] **MOD-03**: Smoke tests execute successfully using ESM modules.

### Persistence (SQLite)
- [ ] **PERS-01**: Bot uses an embedded SQLite database for trade state instead of JSON files.
- [ ] **PERS-02**: Existing trades from `fcb_trades.json` are automatically migrated to SQLite on first run.
- [ ] **PERS-03**: Trade data retrieval (for UI) occurs via SQL queries, improving bridge performance.

### Observability (UI)
- [ ] **UI-01**: Dashboard displays real-time toast notifications for critical bot events (Macro Guard, Heartbeat failure).
- [ ] **UI-02**: API errors (from Bridge) are captured and displayed to the user with actionable feedback.
- [ ] **UI-03**: Visual indicator in UI showing "DB Connection" status.

## Future Requirements (v6.3+)
### High Frequency & WebSocket
- **HFT-01**: Implement WebSocket market data subscription for lower latency vs REST polling.
- **HFT-02**: Multi-symbol parallel execution for higher capital utilization.

## Out of Scope
| Feature | Reason |
|---------|--------|
| Multi-user accounts | Project is designed as a personal trading bot |
| Public API | Security concerns regarding private trading strategies |

## Traceability
| Requirement | Phase | Status |
|-------------|-------|--------|
| MOD-01 | Phase 1 | Pending |
| MOD-02 | Phase 1 | Pending |
| MOD-03 | Phase 1 | Pending |
| PERS-01 | Phase 2 | Pending |
| PERS-02 | Phase 2 | Pending |
| PERS-03 | Phase 2 | Pending |
| UI-01 | Phase 3 | Pending |
| UI-02 | Phase 3 | Pending |
| UI-03 | Phase 3 | Pending |

**Coverage:**
- v6.2 requirements: 9 total
- Mapped to phases: 9
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-06*
*Last updated: 2026-04-06 after initial definition*
