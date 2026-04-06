# Phase 01: Modernization (ESM) - Research

## Technical Approach: ESM Transition
Moving the `tradbotv6` codebase from CommonJS (`require`) to ES Modules (`import`) requires addressing several Node.js environmental differences.

### 1. `__dirname` and `__filename` Replacements
The project uses `__dirname` in `bot.js`, `bridge.js`, `backtest.js`, and `setup.js` for file path resolution. In ESM, these must be replaced:

```javascript
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
```

### 2. Import/Export Refactoring
All `module.exports` and `require()` calls must be converted:
- `require('fs')` → `import fs from 'fs'`
- `module.exports = { ... }` → `export { ... }` or `export const ...`

### 3. File Extensions & Resolution
- In ESM, file extensions are **mandatory** in imports (e.g., `import { ... } from './strategies.js'`, NOT `./strategies`).
- All internal module imports must be updated with `.js`.

### 4. Protobuf Loading
The project uses `protobufjs`. The current loader in `proto-decoder.js` should be verified for compatibility with ESM.

### 5. `package.json` Integration
A `package.json` file is required in the root with `"type": "module"`. This tells Node.js to treat all `.js` files as ESM.

### 6. Summary of Impact
- **Low Risk**: Logical functions (`strategies.js`, `indicators.js`) are purely mathematical/data-driven.
- **Medium Risk**: `bridge.js` (Server) and `bot.js` (Engine) have complex file-system interactions and child-process logic that could use CommonJS globals.
- **Verification**: Run `node tests/*.smoke.js` after the migration.

## Validation Architecture
- **Must Haves**:
  - `package.json` with `type: module`.
  - All core files using `import`/`export`.
  - `node bot.js` starts successfully.
  - `node bridge.js` starts successfully.
  - Smoke tests pass.
