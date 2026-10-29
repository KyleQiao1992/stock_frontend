// Compatibility entry point: validate production, not a patched source copy.
if (process.argv.includes('--gap-only')) {
  throw new Error('The gap-only trial is archived in docs/chan-segment-gap-only-audit.json. Use auditChanSegmentRules.mjs for current code.');
}
await import('./auditChanSegmentRules.mjs');
