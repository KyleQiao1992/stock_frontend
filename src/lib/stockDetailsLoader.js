const DETAIL_LABELS = {
  finance: '财报',
  tradeSide: '内外盘历史',
  profile: '公司资料',
  suspension: '停牌风险',
};

function timeoutError(key, timeoutMs) {
  const error = new Error(`${DETAIL_LABELS[key] || key}加载超时（${Math.ceil(timeoutMs / 1000)} 秒）`);
  error.name = 'TimeoutError';
  error.code = 'STOCK_DETAILS_TIMEOUT';
  return error;
}

// Each detail has its own deadline and publishes as soon as it finishes. A
// cancelled group also settles when a task ignores AbortSignal entirely.
export function createStockDetailsLoader() {
  let currentGroup = null;

  function cancel() {
    const group = currentGroup;
    currentGroup = null;
    if (!group) return;
    for (const cancelTask of [...group.pending]) cancelTask();
  }

  function load({ tasks, isCurrent = () => true, onSettled, timeoutMs = 30000 }) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError('股票资料请求超时时间必须是大于零的有限数值。');
    }
    cancel();
    const group = { pending: new Set() };
    currentGroup = group;

    const pending = Object.entries(tasks).map(([key, task]) => {
      const request = new Promise((resolve) => {
        const controller = new AbortController();
        let settled = false;
        let timer;
        const finish = (outcome, abort = false) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          group.pending.delete(cancelTask);
          if (abort) controller.abort(outcome.reason);
          resolve(outcome);
        };
        const cancelTask = () => finish({ status: 'rejected',
          reason: new DOMException('股票资料请求已取消。', 'AbortError') }, true);
        group.pending.add(cancelTask);
        timer = setTimeout(() => finish({ status: 'rejected', reason: timeoutError(key, timeoutMs) }, true), timeoutMs);

        // Both handlers stay attached after cancellation/timeout, so a late
        // rejection from an upstream task cannot become unhandled.
        Promise.resolve().then(() => {
          if (controller.signal.aborted) throw controller.signal.reason;
          return task(controller.signal);
        }).then(
          (value) => finish({ status: 'fulfilled', value }),
          (reason) => finish({ status: 'rejected', reason }),
        );
      });
      return request.then((outcome) => {
        if (currentGroup === group && isCurrent()) onSettled?.(key, outcome);
        return [key, outcome];
      });
    });

    // Waiting for the group is optional; publishing never waits for siblings.
    return Promise.all(pending).then(Object.fromEntries).finally(() => {
      if (currentGroup === group) currentGroup = null;
    });
  }

  return { cancel, load };
}
