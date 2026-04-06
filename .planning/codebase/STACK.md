# Tech Stack

## Core
- **Runtime**: Node.js (tested with `node bridge.js`)
- **Language**: JavaScript (ESM or CommonJS, both patterns present)
- **UI**: Vanilla HTML/JS dashboard (`index.html`)

## Data & Communication
- **API**: Custom REST-like bridge (`bridge.js`)
- **Protocol**: Protocol Buffers (`MarketDataFeed.proto`)
- **Persistence**: JSON files (`fcb_cmd.json`, `fcb_trades.json`)
- **Browser State**: `localStorage` (for `fcb_v6_admin_key`)

## Dependencies
- **External**: No `package.json` detected, appears to favor standard library or script-based includes.
- **Protobuf**: Handled via `proto-decoder.js` (potentially using `protobufjs` or similar, or custom decoding).

## Testing
- Smoke tests located in `tests/` (`indicators.smoke.js`, `strategies.smoke.js`, `bridge.api.smoke.js`).
