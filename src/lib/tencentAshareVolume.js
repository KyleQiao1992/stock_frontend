// Tencent's STAR Market quote and A-share K-line volumes are shares; other
// A-share volumes are lots. Keep this conversion specific to Tencent A-shares.
export function tencentAshareVolumeUnit(code) {
  return /^(?:sh)?68[89]\d{3}$/i.test(String(code ?? '').trim()) ? 'share' : 'lot';
}

export function tencentAshareVolumeToLots(value, code) {
  if ((typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && value.trim() === '')) return NaN;
  const volume = Number(value);
  if (!Number.isFinite(volume) || volume < 0) return NaN;
  // A remainder below 100 shares is real volume, not a whole-lot rounding error.
  return tencentAshareVolumeUnit(code) === 'share' ? volume / 100 : volume;
}
