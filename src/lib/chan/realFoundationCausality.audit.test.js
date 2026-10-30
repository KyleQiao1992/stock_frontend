import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeChan } from './index.js';

// Previously saved third-party chart inputs, not manually labelled Chan
// ground truth. The exact center expectations describe the current engine's
// lowest-layer convention, not proof of the original theory or completeness
// of the data before the fixture window.
const samples = [
  ['sh000001-day.json', 'zs-9-171', 250, 3815.84, 4034.08],
  ['sh510300-day.json', 'zs-62-157', 246, 4.41, 4.751],
  ['sh603818-30m.json', 'zs-2-194', 264, 3.51, 3.85],
  ['hk00700-5m.json', 'zs-3-423', 627, 431.2, 435.4],
];

for (const [filename, id, knownAt, zd, zg] of samples) {
  for (const sign of [1, -1]) {
    test(`${filename}: formation is absent at the prior prefix and present at its recorded prefix (sign ${sign})`, () => {
      const input = JSON.parse(readFileSync(new URL(`./fixtures/reference/${filename}`, import.meta.url)));
      const rows = input.candles.map(bar => ({
        // UTC here is a consistent label of the supplied epoch, not a claim
        // that the provider used a particular local exchange timezone.
        date: new Date(bar.time * 1000).toISOString().slice(0, 19).replace('T', ' '),
        open: sign * bar.open, close: sign * bar.close,
        high: sign > 0 ? bar.high : -bar.low,
        low: sign > 0 ? bar.low : -bar.high,
        volume: bar.vol,
      }));
      const before = analyzeChan(rows.slice(0, knownAt - 1), input.period);
      const at = analyzeChan(rows.slice(0, knownAt), input.period);
      const full = analyzeChan(rows, input.period);
      assert.equal(before.zs.some(zone => zone.id === id), false);
      const first = at.zs.find(zone => zone.id === id);
      const recent = full.zs.find(zone => zone.id === id);
      assert.ok(first, 'minimum center appears in actual production analysis');
      assert.ok(recent, 'same minimum center remains in the saved window');
      assert.deepEqual([first.zd, first.zg], sign > 0 ? [zd, zg] : [-zg, -zd]);
      assert.equal(first.confirmed_time, knownAt);
      assert.equal(recent.confirmed_time, knownAt);
      const foundation = at.recursiveReadiness.foundation.centers.find(zone => zone.id === id);
      assert.ok(foundation, 'readiness reports the same source-backed center');
      assert.equal(foundation.observedAt, knownAt);
      assert.equal(foundation.evidenceType, 'confirmed_segment_geometry');
      assert.equal(at.recursiveReadiness.source.historyBeforeStart, 'unverified');
      assert.equal(at.recursiveReadiness.source.marketContinuity, 'unverified');
    });
  }
}
