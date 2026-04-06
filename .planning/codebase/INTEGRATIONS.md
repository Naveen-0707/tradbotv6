# Integrations

## Internal APIs
- **/api/status**: Uptime + memory stats (v6.1+)
- **/api/health**: Monitoring endpoint (v6.1+)
- **/api/token**: Admin key settings (write API)
- **/api/settings**: Configuration management (write API)
- **/api/cmd**: Command execution (write API)
- **/api/trades**: Trade management (DELETE supports selection and clear-all)

## External Data Feeds
- **Protocol Buffers Market Data**: Defined in `MarketDataFeed.proto`.
- **Feed Interaction**: Consumed via custom protocol handling.

## Authentication & Security
- **Admin Key**: Required for write APIs via `FCB_ADMIN_KEY` environment variable.
- **Headers**: `x-fcb-admin-key` for client authentication.
- **CORS**: Origin allowlist via `FCB_ALLOWED_ORIGINS` environment variable.

## State Management
- **Local Storage**: `fcb_v6_admin_key` stored locally in browser for authenticated write requests.
- **File System Persistence**: Trade data and commands persisted in `.json` files.
