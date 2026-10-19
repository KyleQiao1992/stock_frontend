import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { analyzeChan } from '../src/lib/chan/index.js';

// Replays observations, independently of the implementation's reported times.
// This checks causality on saved inputs, not the mathematical theory or returns.
const directory = new URL('../src/lib/chan/fixtures/reference/', import.meta.url);
const names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
const reports = [];
let prefixes = 0;
for (const file of names) {
  const saved = JSON.parse(await readFile(new URL(file, directory), 'utf8'));
  const rows = saved.candles.map(({ time, vol, ...row }) => ({ ...row, date: String(time), volume: vol }));
  let previous = new Map();
  const seen = new Set();
  const result = { file, prefixes: rows.length, appearances: 0, withdrawals: 0,
    reappearances: 0, timingChanges: 0, violations: [] };
  for (let length = 1; length <= rows.length; length++) {
    const data = analyzeChan(rows.slice(0, length), saved.period);
    assert.equal(data.definition.segmentHistoryBars, length,
      'these archived histories must not silently cross the period-window boundary');
    const current = new Map();
    for (const segment of data.segments) {
      current.set(segment.id, segment.confirmed_time);
      if (!previous.has(segment.id)) {
        result.appearances++;
        if (seen.has(segment.id)) result.reappearances++;
        seen.add(segment.id);
        if (segment.confirmed_time !== length) result.violations.push({
          kind: 'new-appearance-time', observed: length, id: segment.id, basis: segment.confirmed_time,
        });
      } else if (previous.get(segment.id) !== segment.confirmed_time) result.timingChanges++;
    }
    for (const id of previous.keys()) if (!current.has(id)) result.withdrawals++;
    previous = current;
  }
  assert.deepEqual(result.violations, [], `${file}: appearance must match its observed evidence K`);
  assert.equal(result.timingChanges, 0, `${file}: a continuously present segment must not drift`);
  prefixes += rows.length;
  reports.push(result);
}

// Explicitly closed, synthetic input isolates the separately documented effect
// of rolling the requested history origin beyond 300 day bars.
const turns = [2, ...Array.from({ length: 4 }, () => [0, 10, 4, 12, 5, 9, 3, 8, 2, 7, 4, 10, 6, 12]).flat()];
const prices = turns.flatMap((price, index) => index
  ? Array.from({ length: 8 }, (_, step) => turns[index - 1] + (price - turns[index - 1]) * (step + 1) / 8)
  : [price]);
const synthetic = prices.map((price, index) => ({ date: `K${index + 1}`, open: 100 + price,
  close: 100 + price, high: 100.2 + price, low: 99.8 + price, volume: 100, complete: true }));
let previous = new Map();
const changedOriginExamples = [];
for (let length = 300; length <= synthetic.length; length++) {
  const data = analyzeChan(synthetic.slice(0, length), 'day');
  for (const segment of data.segments) if (!previous.has(segment.id) && segment.confirmed_time < length && length > 300) {
    if (changedOriginExamples.length < 3) changedOriginExamples.push({
      observedAt: length, windowStart: data.definition.segmentHistoryStart,
      id: segment.id, basisK: segment.confirmed_time,
    });
  }
  previous = new Map(data.segments.map((segment) => [segment.id, segment.confirmed_time]));
}
assert.ok(changedOriginExamples.length > 0, 'must exercise actual window-origin reconstruction');
const report = { scope: '有限保存样本的因果回放；不验证全部原图、理论证明、交易收益或线上行情',
  completionInput: '保存样本不伪造complete字段；最新unknown待后继K，证据时刻记后继K',
  prefixes, reports,
  rollingWindow: { explicitlyClosedSynthetic: true, period: 'day', limit: 300,
    interpretation: '确认依据K来自本次窗口复算，不是该段跨窗口首次观测时刻', changedOriginExamples },
};
if (process.argv.includes('--report')) {
  await writeFile(new URL('../docs/chan-segment-causal-audit-results.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(`Segment causal replay passed: ${reports.length} saved histories, ${prefixes} prefixes, no premature evidence times or continuous timing drift.`);
console.log(`Rolling-window reconstruction reproduced: ${changedOriginExamples.length} recorded historical-basis examples; these are not first-observation or trading-signal times.`);
