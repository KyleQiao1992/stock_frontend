import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTradeSideRows, formatTradeVolume, formatTradeRatio } from './tradeSideHistory.js';

test('closed-day summary weights actual volumes and excludes unfinished snapshots', () => {
  const result = summarizeTradeSideRows([
    {date:'2026-10-09', complete:true, innerVol:10, outerVol:90},
    {date:'2026-10-12', complete:true, innerVol:900, outerVol:100},
    {date:'2026-10-13', complete:false, innerVol:0, outerVol:5000},
  ]);
  assert.equal(result.days, 2);
  assert.equal(result.netVol, -720);
  assert.equal(result.netRatio, -720 / 1100 * 100);
  assert.equal(result.lastDate, '2026-10-12');
});

test('missing and zero-volume records never imply a balanced multi-day trend', () => {
  assert.equal(summarizeTradeSideRows([{complete:true, innerVol:0, outerVol:0}]), null);
  assert.equal(summarizeTradeSideRows([{complete:false, innerVol:10, outerVol:10}]), null);
  assert.equal(summarizeTradeSideRows(undefined), null);
});

test('statistics use the last five recorded closes and retain their actual date range', () => {
  const rows = Array.from({length:8}, (_, i) => ({date:`2026-10-${String(i + 1).padStart(2,'0')}`, complete:true, innerVol:5, outerVol:15}));
  const result = summarizeTradeSideRows(rows);
  assert.equal(result.days, 5);
  assert.equal(result.firstDate, '2026-10-04');
  assert.equal(result.netVol, 50);
});

test('volume formatting keeps lots distinct from money and missing values', () => {
  assert.equal(formatTradeVolume(150901), '15.09万手');
  assert.equal(formatTradeVolume(-12391, true), '−1.24万手');
  assert.equal(formatTradeVolume(null), '—');
  assert.equal(formatTradeRatio(null), '—');
  assert.equal(formatTradeRatio(0, true), '0.00%');
});
