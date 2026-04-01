# tradbotv6

## Admin protection for write APIs

State-changing endpoints (`/api/token`, `/api/settings`, `/api/cmd`, `DELETE /api/trades`) require an admin key.
Start bridge with:

```bash
FCB_ADMIN_KEY="your-secret" node bridge.js
```

When enabled, clients must send the same value in header:

```http
x-fcb-admin-key: your-secret
```

If `FCB_ADMIN_KEY` is missing, write APIs are locked and return `503`.

## CORS allowlist

Set allowed browser origins (comma-separated):

```bash
FCB_ALLOWED_ORIGINS="http://localhost:8080,http://127.0.0.1:8080" node bridge.js
```

### UI note
In the dashboard, use the **🔐 KEY** button to set/clear `fcb_v6_admin_key` in browser localStorage for authenticated write requests.

## Smoke test

```bash
node tests/indicators.smoke.js
node tests/strategies.smoke.js
node tests/bridge.api.smoke.js
```
