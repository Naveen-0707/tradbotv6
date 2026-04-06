# Architecture

## System Overview
The project is a professional-grade algorithmic trading bot for the Indian stock market (NSE), integrated with the Upstox API. It follows a multi-process hub-and-spoke architecture.

## Core Components

### 1. The Bridge (`bridge.js`)
- **Role**: API Gateway & UI Server.
- **Functions**:
  - Serves the dashboard (`index.html`).
  - Provides a REST API for configuration and manual commands.
  - Streams real-time updates via **Server-Sent Events (SSE)**.
  - Proxies authentication for WebSocket market data feeds.
  - Manages bot process lifecycle (optional auto-respawn).

### 2. The Bot Engine (`bot.js`)
- **Role**: Execution & Decision Engine.
- **Functions**:
  - Main loop for scanning stocks and managing open positions.
  - **Macro Guard**: Monitors Nifty for extreme volatility to pause trading/auto-exit.
  - **Execution Control**: Handles Paper vs Live modes with capital risk management.
  - **Paper OCO**: Simulates Stop-Loss/Target hits for paper trading using LTP polling.

### 3. Logic Modules
- **`strategies.js`**: Houses various trading strategies (ORB, VWAP, EMA, etc.) with strict entry/exit criteria.
- **`indicators.js`**: Core technical indicators (ATR, EMA, RSI, etc.) used by strategies.
- **`proto-decoder.js`**: Handles decoding of Protobuf market data feeds.

## Data Persistence & Communication
- **State Store**: JSON files are used for persistence (`fcb_trades.json`, `config.json`).
- **Inter-Process Communication (IPC)**:
  - **File-based commands**: `bridge.js` writes to `fcb_cmd.json`, and the bot polls it.
  - **Heartbeats**: Bot writes to `fcb_bot_status.json` for health monitoring.
- **Real-time UI**: SSE allows the bot to push updates to all connected browser clients.

## Security Model
- **Admin Key**: Write APIs require a secret `FCB_ADMIN_KEY`.
- **CORS Allowlist**: Explicit origin checking for browser clients.
- **Admin Lock**: Write APIs are disabled if no admin key is configured.
