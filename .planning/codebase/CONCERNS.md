# Technical Concerns

## ⚠️ High Priority
- **Dependency Management**: No `package.json` file was found in the root. While the project appears to favor minimal dependencies, this makes the environment hard to reproduce.
- **File-based IPC Performance**: The bridge and bot communicate via polling and writing to JSON files (`fcb_cmd.json`, `fcb_trades.json`). This introduces inherent latency (1–5 seconds) and increases disk I/O significantly.
- **Single-user Authentication**: The `FCB_ADMIN_KEY` model is simple but limits the app to a single user. Admin keys stored in `localStorage` could be exposed via XSS if any external scripts are added.

## ⚠️ Moderate Priority
- **Mixed Code Patterns**: ES modules and CommonJS patterns are used interchangeably across different files (e.g., `indicators.js` vs `bot.js`).
- **Fragile State Persistence**: Although atomic writes are implemented, frequent writing to JSON files for high-frequency trading data could lead to performance bottlenecks or increased disk wear on SSDs.
- **Protobuf Decoding**: `proto-decoder.js` handles data decoding from Upstox. Any changes in the Upstox protobuf schema would require manual updates here, which could be error-prone.

## 💡 Improvements
- **Standardize on ESM**: Modernize the codebase to use ES Modules throughout for better tree-shaking and tool compatibility.
- **Consolidate State Management**: Use a lightweight embedded database (e.g., `Better-SQLite3`) instead of JSON files for trade and signal persistence to improve reliability and performance.
- **Implement Centralized Error Reporting**: Instead of simple `try/catch` with console logs, implement a more structured error reporting system for the UI.
