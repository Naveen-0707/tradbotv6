# Context: Phase 2 - Data Hub (SQLite)

## Role & Goal
To migrate the current flat-file JSON persistence layer (`fcb_trades.json`, `fcb_signals.json`) into a robust SQLite database to provide better data integrity, indexing, query speed, and prevent file-corruption bugs.

## Current State
Data is read/written to `.json` files synchronously using `fs.readFileSync` and `fs.writeFileSync`. This involves parsing and stringifying the whole array every time a trade changes, which does not scale well as the number of trades grows and leads to race conditions.

## Requirements
- **PERS-01**: Use embedded SQLite (`better-sqlite3`).
- **PERS-02**: Provide a migration mechanism from JSON to SQLite.
- **PERS-03**: Bridge and Bot interface with the DB instead of JSON.

## Key Constraints
- Must function entirely synchronously or via minimal promises (to not break the main loop timing). `better-sqlite3` is fully synchronous, which is ideal.
- Backward compatibility: previous trades must import perfectly without data loss.
