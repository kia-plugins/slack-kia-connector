import { build } from 'esbuild';

// Slack has no runtime npm dependencies (pure Node + global fetch); the SDK is
// types-only and erased. esbuild emits one self-contained CommonJS file the host
// require()s in the forked extension process.
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: 'dist/index.js',
  logLevel: 'info',
});
console.log('bundled dist/index.js');
