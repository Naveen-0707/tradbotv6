# Project tradbotv6

Professional-grade algorithmic trading bot for the Indian stock market (NSE), integrated with the Upstox API. Features a dual-process Hub-and-Spoke architecture (Bridge + Bot) with real-time SSE updates and historical backtesting capabilities.

## Architecture & Integration
### 1. Bridge Layer (`bridge.js`)
- Central API gateway and static UI server.
- Real-time updates via Server-Sent Events (SSE).
- Admin authentication using `FCB_ADMIN_KEY`.

### 2. Bot Engine (`bot.js`)
- Core execution loop for trade scanning and management.
- Macro spike guards and market volatility filtering (India VIX).
- Sophisticated Stop-Loss/Target simulation for Paper trading.

### 3. Logic & Strategy
- Modular strategies (`strategies.js`) and indicators (`indicators.js`).
- Protobuf-native market data feeds via `MarketDataFeed.proto`.

## Requirements

### Validated
- ✓ **Dual-process Architecture** — Existing Bridge + Bot split.
- ✓ **Strategy Engine** — Multiple working strategies (ORB, VWAP, etc.).
- ✓ **Backtesting** — Standalone historical replay system.
- ✓ **Admin Security** — Admin-key protected write APIs.

### Active
- [ ] **Modernization v6.2 (ESM)** — Convert codebase to ES Modules.
- [ ] **SQLite Persistence** — Switch from JSON files to SQLite for trade state.
- [ ] **UI Notifications** — Implement centralized error/alert system in dashboard.

### Out of Scope
- [Mobile Native App] — Using PWA-like web UI instead.
- [Cloud Hosting] — Local/Home server execution preferred for security.

## Key Decisions
| Decision | Rationale | Outcome |
|----------|-----------|---------|
| ESM Standardization | Improve tool compatibility and modern DX | Pending |
| SQLite for State | Performance and reliability over JSON files | Pending |
| Local/Home Execution | Privacy of trading strategies and API keys | Native |

## Context
Project transitioned to structured planning with GSD-build and Ralph in April 2026. Codebase is mature but requires modernization to handle scale and reduce latency.

---
*Last updated: 2026-04-06 after initialization*
