# Coding Conventions

## Core Principles
The project prioritizes **dependency minimalism** and **explicit logic**. It uses vanilla Node.js APIs and is designed for high reliability in algorithmic trading contexts.

## Style & Structure
- **Module System**: CommonJS (`require`).
- **Safety**: `"use strict"` is used in all main scripts.
- **Async Pattern**: `async`/`await` is standard.
- **Logical Headers**: Stylized headers are used extensively to group functions and logic (e.g., `// ─── STACK ───────────────────────────────────────────────────────────────`).

## Error Handling
- **Graceful Failures**: `try/catch` is used around critical file operations (e.g., `saveTrades`, `loadCFG`) to prevent bot crashes.
- **Atomic Writes**: `fs.renameSync` is used for trade file persistence to prevent file corruption during power loss.
- **Fail-safe Defaults**: Falling back to defaults when configuration is missing or corrupt.

## Naming & Typing
- **Variables**: Descriptive camelCase (e.g., `lastTradeCount`).
- **Constants**: UPPER_CASE (e.g., `ADMIN_KEY`, `TRD_FILE`).
- **Type Guards**: Frequent use of `Number.isFinite`, `Array.isArray`, and `typeof` checks to ensure data integrity.

## Logging
- **Centralized Logger**: A `log` function is available in `bot.js` and `bridge.js` for consistent formatting.
- **Format**: `[TIMESTAMP] [INFO/WARN/TRADE] Message`.
- **Retention**: Per-day rolling log files (`fcb_log_YYYY-MM-DD.txt`) for easy date-based tracking.
