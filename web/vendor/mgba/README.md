# mGBA (WebAssembly build)

`mgba.js` and `mgba.wasm` are copied unmodified from the npm package
[`@thenick775/mgba-wasm`](https://www.npmjs.com/package/@thenick775/mgba-wasm)
version 2.5.1, a WebAssembly build of [mGBA](https://mgba.io/) by
[thenick775](https://github.com/thenick775/mgba/tree/feature/wasm).

mGBA is licensed under the Mozilla Public License 2.0 (see `LICENSE`).

To update: `npm pack @thenick775/mgba-wasm`, extract `package/dist/mgba.js`
and `package/dist/mgba.wasm` here, and check that `web/js/netsync.js` still
finds the emulator's memory (run `tests/e2e.mjs`).
