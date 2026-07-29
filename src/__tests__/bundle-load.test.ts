/**
 * Smoke test for the bundled dist/index.js: the CJS/ESM interop in
 * src/index.ts (`export default mod; module.exports = mod;`) must survive
 * actual esbuild output — exactly what silently breaks on an esbuild upgrade.
 *
 * `bundleLoadSmoke` runs `npm run build` itself, then require()s the real
 * bundle and activates it. `senderIds` is asserted because the sender is
 * contributed from the SAME activate() — manifest contributes.senders lists
 * 'slack', so the host looks for it there.
 */
import { join } from 'node:path';
import { bundleLoadSmoke } from '@kiagent/connector-sdk/testing';

describe('dist bundle loads standalone', () => {
  it('require()s dist/index.js and activate() returns the slack source', async () => {
    await bundleLoadSmoke({
      root: join(__dirname, '..', '..'),
      selfId: 'slack',
      sourceIds: ['slack'],
      senderIds: ['slack'],
    });
  }, 30_000);
});
