import test from 'node:test';
import assert from 'node:assert/strict';
import { tencentAshareVolumeUnit, tencentAshareVolumeToLots } from './tencentAshareVolume.js';

test('Tencent STAR Market stocks and CDRs identify their original share unit', () => {
  for (const code of ['688610', 'sh688610', '689009', 'sh689009']) {
    assert.equal(tencentAshareVolumeUnit(code), 'share');
  }
  for (const code of ['603818', 'sh603818', '300745', 'sz300745', '301163']) {
    assert.equal(tencentAshareVolumeUnit(code), 'lot');
  }
});

test('STAR Market total and side volumes preserve odd shares when converted to lots', () => {
  assert.equal(tencentAshareVolumeToLots('1763046.000', '688610'), 17630.46);
  assert.equal(tencentAshareVolumeToLots('970836', 'sh688610'), 9708.36);
  assert.equal(tencentAshareVolumeToLots('792210', '688610'), 7922.1);
  assert.equal(tencentAshareVolumeToLots('7045520', '689009'), 70455.2);
  assert.equal(tencentAshareVolumeToLots(46, 'sh689009'), 0.46);
  assert.equal(tencentAshareVolumeToLots(0, '688610'), 0);
});

test('ordinary and ChiNext A-share Tencent volumes already use lots', () => {
  assert.equal(tencentAshareVolumeToLots('268183.000', '603818'), 268183);
  assert.equal(tencentAshareVolumeToLots('43603', '300745'), 43603);
  assert.equal(tencentAshareVolumeToLots('12794', '301163'), 12794);
  assert.equal(tencentAshareVolumeToLots(0, '603818'), 0);
});

test('missing and invalid volumes cannot turn into a zero-volume observation', () => {
  for (const value of [undefined, null, '', '   ', 'invalid', NaN, Infinity, -1, '-1', true, [], {}]) {
    assert.ok(Number.isNaN(tencentAshareVolumeToLots(value, '688610')));
    assert.ok(Number.isNaN(tencentAshareVolumeToLots(value, '603818')));
  }
});
