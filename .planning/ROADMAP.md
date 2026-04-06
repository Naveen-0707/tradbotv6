# Roadmap: tradbotv6

## Overview
Rebuilding the foundations of tradbotv6 for the v6.2 milestone. This journey moves from a file-based CommonJS system to a modern, database-driven ESM architecture with enhanced user observability.

## Phases
- [ ] **Phase 1: Modernization (ESM)** - Convert core logic to ES Modules and formalize dependencies.
- [ ] **Phase 2: Data Hub (SQLite)** - Replace JSON persistence with a high-performance SQLite engine.
- [ ] **Phase 3: Observability (UI)** - Implement real-time dashboard notifications and structured error reporting.

## Phase Details

### Phase 1: Modernization (ESM)
**Goal**: Transition codebase to ES Modules and standard Node.js practices.
**Depends on**: Nothing
**Requirements**: MOD-01, MOD-02, MOD-03
**Success Criteria**:
  1. `bot.js` and `bridge.js` run successfully as ESM.
  2. `package.json` exists with correct dependencies and type definition.
  3. Existing smoke tests pass in the new environment.
**Plans**: 2 plans

Plans:
- [ ] 01-01: Convert module syntax and update imports
- [ ] 01-02: Setup package.json and verify environment

### Phase 2: Data Hub (SQLite)
**Goal**: Implement SQLite persistence for trades and signals.
**Depends on**: Phase 1
**Requirements**: PERS-01, PERS-02, PERS-03
**Success Criteria**:
  1. `trades.db` is initialized with the correct schema.
  2. Data from `fcb_trades.json` is migrated to SQLite.
  3. Bot and Bridge perform CRUD operations directly on the DB.
**Plans**: 3 plans

Plans:
- [ ] 02-01: Database schema and initialization logic
- [ ] 02-02: Data migration script (JSON to SQLite)
- [ ] 02-03: Bot/Bridge logic integration for DB persistence

### Phase 3: Observability (UI)
**Goal**: Enhance the User Interface with structured alerts and real-time feedback.
**Depends on**: Phase 2
**Requirements**: UI-01, UI-02, UI-03
**Success Criteria**:
  1. Real-time toast notifications appear for Macro Guard events.
  2. API errors are caught and rendered as user-friendly alerts.
  3. UI shows active connection state to the DB engine.
**Plans**: 2 plans

Plans:
- [ ] 03-01: UI Notification component and alert logic
- [ ] 03-02: Structured error handling in Bridge and UI integration

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Modernization | v6.2 | 0/2 | Not started | - |
| 2. Data Hub | v6.2 | 0/3 | Not started | - |
| 3. Observability | v6.2 | 0/2 | Not started | - |

---
*Roadmap defined: 2026-04-06*
*Last updated: 2026-04-06 after initial definition*
