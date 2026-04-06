# Testing Practices

## Testing Philosophy
The project favors **smoke tests** to verify the core logic in isolation before deployment. The tests are designed to be fast, zero-dependency, and easy to run in any environment.

## Test Components

### 1. Indicators Smoke Test (`tests/indicators.smoke.js`)
- **Scope**: Verifies the numerical correctness and stability of technical indicators (EMA, ATR, RSI, MACD, SuperTrend, VWAP).
- **Tooling**: Built-in `node:assert`.
- **Approach**: Uses mock candle data (generated via `mkCandles`) to test indicator calculations under controlled conditions.

### 2. Strategies Smoke Test (`tests/strategies.smoke.js`)
- **Scope**: Verifies that trading strategies (ORB, VWAP, EMA, etc.) correctly identify signals and follow entry/exit rules.
- **Approach**: Tests signals against known price patterns to ensure no regressions in detection logic.

### 3. Bridge API Smoke Test (`tests/bridge.api.smoke.js`)
- **Scope**: Verifies the HTTP/SSE server endpoints (status, health, config, token).
- **Approach**: Mocks client requests to ensure correct response codes and JSON structures.

## How to Run Tests

```bash
# Run all smoke tests
node tests/indicators.smoke.js
node tests/strategies.smoke.js
node tests/bridge.api.smoke.js
```

## Future Recommendations
- Integration of a standard test runner (e.g., `vitest` or `node --test`).
- End-to-end (E2E) testing for the browser UI (`index.html`).
- More extensive backtesting logic in `backtest.js` to simulate historically performance.
