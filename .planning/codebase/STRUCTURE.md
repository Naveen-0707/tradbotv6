# Project Structure

## Directory Layout

```text
/tradbotv6
├── bridge.js              # The HTTP/SSE/UI server (central gateway)
├── bot.js                 # Core trading logic and scan loop
├── strategies.js          # Trading strategy definitions (ORB, VWAP, EMA, etc.)
├── indicators.js          # Technical indicator logic (ATR, EMA, RSI)
├── index.html             # The browser-based dashboard UI
├── setup.js               # CLI configuration utility
├── proto-decoder.js       # Protobuf market data decoder
├── MarketDataFeed.proto   # Protobuf definition for Upstox data
├── README.md              # Project overview and setup guide
│
├── .agent/                # GSD plugin and skill configurations
├── .planning/             # GSD planning state and codebase map
│
├── tests/                 # System smoke tests
│   ├── indicators.smoke.js
│   ├── strategies.smoke.js
│   └── bridge.api.smoke.js
│
└── [State Files (Generated)]
    ├── config.json        # Main bot configuration
    ├── fcb_trades.json    # Active and past trades (persistent)
    ├── fcb_signals.json   # Detected strategy signals
    ├── fcb_cmd.json       # Communication bridge (Bridge -> Bot)
    ├── fcb_bot_status.json # Bot health and monitoring state
    └── fcb_log_*.txt      # Per-day rolling log files
```

## Key Locations

- **Entry Point (UI/Bridge)**: `bridge.js` - Start with `node bridge.js`.
- **Core Engine**: `bot.js` - Core trading loop.
- **Strategy Definitions**: `strategies.js` - Add new strategies here.
- **Indicator Logic**: `indicators.js` - Add new indicators here.
- **UI Logic**: Embedded in `index.html`.
- **Persistence**: Managed via JSON files in the root.
- **Protocol**: `MarketDataFeed.proto` for market data feeds.

## Naming Conventions
- **Files**: Lowercase with hyphens or underscores (mostly `snake_case` or `kebab-case`).
- **Core Scripts**: Prefixed with `fcb_` for state files (e.g., `fcb_trades.json`).
- **Logs**: Prefixed with `fcb_log_` followed by date (`YYYY-MM-DD`).
