==> Running 'node index.js'
node:internal/modules/cjs/loader:1459
  throw err;
  ^
Error: Cannot find module 'node-fetch'
Require stack:
- /opt/render/project/src/index.js
    at Module._resolveFilename (node:internal/modules/cjs/loader:1456:15)
    at defaultResolveImpl (node:internal/modules/cjs/loader:1066:19)
    at resolveForCJSWithHooks (node:internal/modules/cjs/loader:1071:22)
    at Module._load (node:internal/modules/cjs/loader:1242:25)
    at wrapModuleLoad (node:internal/modules/cjs/loader:255:19)
    at Module.require (node:internal/modules/cjs/loader:1556:12)
    at require (node:internal/modules/helpers:152:16)
    at Object.<anonymous> (/opt/render/project/src/index.js:2:15)
    at Module._compile (node:internal/modules/cjs/loader:1812:14)
    at Object..js (node:internal/modules/cjs/loader:1943:10) {
  code: 'MODULE_NOT_FOUND',
  requireStack: [ '/opt/render/project/src/index.js' ]
}
Node.js v24.14.1
