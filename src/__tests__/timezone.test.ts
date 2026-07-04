/**
 * dayKey / localDayStartTs are LOCAL-wall-clock by design; the main suites
 * pin TZ=UTC (jest.config.js), which would mask a local/UTC conflation bug.
 *
 * A runtime `process.env.TZ` flip does NOT reach Jest's test context (works
 * in plain node, but V8 keeps a per-vm-context date cache that node's TZ
 * setter hook doesn't reset there — verified on this runtime). So this suite
 * goes spawn-level: it bundles the REAL src/messages.ts with esbuild and
 * executes it in child node processes whose TZ is set at spawn — an honest
 * wall-clock test of the shipped code, not a faked Date.
 */
import { execFileSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 2024-01-04T18:30:00Z — a UTC evening that is already Jan 5 in Tokyo
// (UTC+9) and still Jan 4 morning in Los Angeles (UTC−8, PST in January —
// both zones are DST-stable at this instant).
const T_TS = '1704393000.000100';

interface ZoneProbe {
  dayKey: string;
  dayStart: string;
  epochStart: string;
}

let probe: (tz: string) => ZoneProbe;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-tz-'));
  const bundle = join(dir, 'messages.cjs');
  buildSync({
    entryPoints: [join(__dirname, '..', 'messages.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
  });
  const script = [
    'const m = require(process.argv[1]);',
    'const ts = process.argv[2];',
    'process.stdout.write(JSON.stringify({',
    '  dayKey: m.dayKey(m.tsToDate(ts)),',
    '  dayStart: m.localDayStartTs(ts),',
    "  epochStart: m.localDayStartTs('0'),",
    '}));',
  ].join('\n');
  const cache = new Map<string, ZoneProbe>();
  probe = (tz: string) => {
    let r = cache.get(tz);
    if (!r) {
      const out = execFileSync(process.execPath, ['-e', script, bundle, T_TS], {
        env: { ...process.env, TZ: tz },
      });
      r = JSON.parse(out.toString()) as ZoneProbe;
      cache.set(tz, r);
    }
    return r;
  };
}, 30_000);

describe('local-day helpers under non-UTC timezones', () => {
  it('dayKey follows the local wall clock across the midnight boundary', () => {
    expect(probe('UTC').dayKey).toBe('2024-01-04');
    expect(probe('Asia/Tokyo').dayKey).toBe('2024-01-05');
    expect(probe('America/Los_Angeles').dayKey).toBe('2024-01-04');
  });

  it('localDayStartTs floors to LOCAL midnight, not UTC midnight', () => {
    // UTC:   Jan 4 00:00 UTC
    expect(probe('UTC').dayStart).toBe('1704326400');
    // Tokyo: Jan 5 00:00 JST = Jan 4 15:00 UTC
    expect(probe('Asia/Tokyo').dayStart).toBe('1704380400');
    // LA:    Jan 4 00:00 PST = Jan 4 08:00 UTC
    expect(probe('America/Los_Angeles').dayStart).toBe('1704355200');
  });

  it('never returns a negative ts near the epoch, in zones on either side of UTC', () => {
    expect(probe('America/Los_Angeles').epochStart).toBe('0');
    expect(probe('Asia/Tokyo').epochStart).toBe('0');
  });
});
