import { mkdir, writeFile } from 'node:fs/promises';

export default class CoverageReporter {
  constructor({ reportRoot = 'test-results/isolated' } = {}) {
    this.reportRoot = reportRoot; this.tests = []; this.layout = []; this.runErrors = [];
  }
  onError(error) { this.runErrors.push(error.message); }
  onBegin(_config, suite) { this.tests = suite.allTests(); this.layout = []; }
  onStepEnd(test, _result, step) {
    if (!/^\d+px$/.test(step.title) || !test.title.startsWith('页面覆盖与布局：')) return;
    this.layout.push({ page: test.title.replace('页面覆盖与布局：', ''),
      theme: step.parent?.title.split(' ').at(-1), width: Number(step.title.replace('px', '')),
      status: step.error ? 'failed' : 'passed', durationMs: step.duration });
  }
  async onEnd(result) {
    const cases = this.tests.map(test => ({
      title: test.titlePath().filter(Boolean).join(' › '),
      kind: /(?:audit|layout)-guard\.spec\.mjs$/.test(test.location.file) ? 'detector-guard'
        : /visual\.spec\.mjs$/.test(test.location.file) ? 'page-layout' : 'business-flow',
      status: test.outcome(),
      durationMs: test.results.reduce((sum, item) => sum + item.duration, 0),
      errors: test.results.flatMap(item => item.errors.map(error => error.message)),
    }));
    const report = { mode: process.env.E2E_LIVE === '1' ? 'live-no-mocks' : 'isolated-full-app',
      generatedAt: new Date().toISOString(), status: result.status, runErrors: this.runErrors,
      passed: cases.filter(item => item.status === 'expected').length,
      failed: cases.filter(item => item.status === 'unexpected').length,
      skipped: cases.filter(item => item.status === 'skipped').length,
      categories: Object.fromEntries(['business-flow', 'page-layout', 'detector-guard'].map(kind => [kind, {
        total: cases.filter(item => item.kind === kind).length,
        passed: cases.filter(item => item.kind === kind && item.status === 'expected').length,
        failed: cases.filter(item => item.kind === kind && item.status === 'unexpected').length,
      }])),
      layout: { checked: this.layout.length, passed: this.layout.filter(item => item.status === 'passed').length,
        failed: this.layout.filter(item => item.status === 'failed').length, cases: this.layout }, cases };
    await mkdir(this.reportRoot, { recursive: true });
    await writeFile(`${this.reportRoot}/coverage.json`, JSON.stringify(report, null, 2));
  }
}
