import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TOP_FRACTAL_LABELS, topFractalTraitDescription } from '../lib/chan/topFractalTraits.js';
import { BOTTOM_FRACTAL_LABELS, bottomFractalTraitDescription } from '../lib/chan/bottomFractalTraits.js';

const CHART_HEIGHT = 260;
const MARGIN = { left: 16, right: 16, top: 42, bottom: 22 };
const PRICE_FORMAT = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6, useGrouping: false });
const price = (value) => PRICE_FORMAT.format(value);

function useContainerWidth(containerRef) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const measure = () => {
      if (container.clientWidth > 0) setWidth(container.clientWidth);
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(container);
    const frame = requestAnimationFrame(measure);
    if (!observer) window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
      if (!observer) window.removeEventListener('resize', measure);
    };
  }, [containerRef]);
  return width;
}

function chartScale(detail) {
  const values = [...detail.rawCandles, ...detail.mergedCandles];
  const high = Math.max(...values.map((candle) => candle.high));
  const low = Math.min(...values.map((candle) => candle.low));
  const padding = Math.max((high - low) * 0.12, Math.abs(high) * 0.002, 0.01);
  const min = low - padding;
  const max = high + padding;
  return (value) => MARGIN.top + (max - value) / (max - min) * (CHART_HEIGHT - MARGIN.top - MARGIN.bottom);
}

function ChartGrid({ width }) {
  return <g aria-hidden="true">
    {[0, 1, 2].map((index) => <line key={index} x1={MARGIN.left} x2={width - MARGIN.right}
      y1={MARGIN.top + index * (CHART_HEIGHT - MARGIN.top - MARGIN.bottom) / 2}
      y2={MARGIN.top + index * (CHART_HEIGHT - MARGIN.top - MARGIN.bottom) / 2}
      stroke="var(--chart-grid)" strokeOpacity="0.45" strokeDasharray="3 5" />)}
  </g>;
}

function StandardFractal({ mark }) {
  const containerRef = useRef(null);
  const width = Math.max(152, useContainerWidth(containerRef));
  const step = (width - MARGIN.left - MARGIN.right) / 3;
  const top = mark === 'G';
  // Match the reference's staggered sides, rather than a symmetric arch/V.
  const positions = top ? [128, 56, 92] : [92, 128, 56];
  const label = top ? '标准顶分型' : '标准底分型';
  return <div ref={containerRef} className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
    <svg viewBox={`0 0 ${width} ${CHART_HEIGHT}`} width={width} height={CHART_HEIGHT} className="block"
      role="img" aria-label={`${label}示意图`} data-chan-detail-standard>
      {positions.map((topY, index) => <g key={index}>
        <text x={MARGIN.left + step * (index + 0.5)} y="24" textAnchor="middle" fontSize="13"
          fontWeight={index === 1 ? '700' : '500'} fill="var(--chart-ink-2)">{index + 1}</text>
        <rect data-chan-detail-standard-bar x={MARGIN.left + step * (index + 0.5) - 9} y={topY}
          width="18" height="90" fill="var(--chart-ink-2)" />
      </g>)}
      <text x={width / 2} y="246" textAnchor="middle" fontSize="11" fill="var(--chart-muted)">形态示意</text>
    </svg>
  </div>;
}

function ComparisonChart({ detail, merged, y }) {
  const scrollRef = useRef(null);
  const anchorRef = useRef(null);
  const containerWidth = useContainerWidth(scrollRef);
  const candles = merged ? detail.mergedCandles : detail.rawCandles;
  const width = Math.max(containerWidth, candles.length * 40 + MARGIN.left + MARGIN.right);
  const step = (width - MARGIN.left - MARGIN.right) / candles.length;
  const accent = detail.mark === 'G' ? 'var(--chan-top)' : 'var(--chan-bottom)';
  const kind = merged ? 'merged' : 'raw';

  useEffect(() => {
    if (merged) return undefined;
    const frame = requestAnimationFrame(() => {
      const container = scrollRef.current;
      const anchor = anchorRef.current;
      if (!container || !anchor) return;
      const viewport = container.getBoundingClientRect();
      const point = anchor.getBoundingClientRect();
      if (point.left >= viewport.left + 12 && point.right <= viewport.right - 12) return;
      container.scrollLeft += point.left + point.width / 2 - viewport.left - container.clientWidth / 2;
    });
    return () => cancelAnimationFrame(frame);
  }, [merged, detail.time, width]);

  return <div ref={scrollRef} className="overflow-x-auto overscroll-x-contain rounded-xl border border-slate-200 bg-white"
    tabIndex={0} role="region" aria-label={`${merged ? '缠论' : '原始'}K线图，可横向滚动`}
    data-chan-detail-raw-scroll={merged ? undefined : ''}>
    <svg width={width} height={CHART_HEIGHT} viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
      style={{ display: 'block', width, height: CHART_HEIGHT, maxWidth: 'none' }}
      role="img" aria-label={`${candles.length}根${merged ? '缠论' : '原始'}K线，依次编号`}
      data-chan-detail-chart={kind}>
      <ChartGrid width={width} />
      {candles.map((candle, index) => {
        const center = MARGIN.left + step * (index + 0.5);
        const anchor = !merged && candle.time === detail.time;
        // The processed rectangle spans high/low, never an open/close body.
        // Color only shows the source group's first-open to last-close change;
        // it does not participate in inclusion or fractal calculations.
        const sourceGroup = merged ? candle.sources : [candle];
        const color = sourceGroup.at(-1).close >= sourceGroup[0].open ? 'var(--chart-up)' : 'var(--chart-down)';
        const halfWidth = Math.min(merged ? 18 : 13, step * 0.25);
        const sources = merged ? candle.sources.map((source) => detail.rawCandles.findIndex((raw) => raw.idx === source.idx) + 1) : [];
        return <g key={index} data-chan-detail-candle={merged ? undefined : candle.idx}
          data-chan-detail-merged={merged ? index : undefined}
          data-chan-detail-rendering={merged ? 'range' : 'ohlc'}
          data-high={merged ? candle.high : undefined} data-low={merged ? candle.low : undefined}
          data-chan-detail-anchor={anchor ? 'true' : undefined}>
          <title>{merged
            ? `缠论K线 ${index + 1} · 对应原K ${sources.join('、')}\n高 ${price(candle.high)} / 低 ${price(candle.low)}`
            : `原始K线 ${index + 1} · ${String(candle.date ?? candle.time)}\n开 ${price(candle.open)} / 高 ${price(candle.high)} / 低 ${price(candle.low)} / 收 ${price(candle.close)}`}</title>
          <text x={center} y="24" textAnchor="middle" fontSize="13" fontWeight={anchor || (merged && index === 1) ? '700' : '500'}
            fill={anchor || (merged && index === 1) ? accent : 'var(--chart-ink-2)'} data-chan-detail-number={kind}>{index + 1}</text>
          {merged ? <>
            <rect data-chan-detail-range x={center - halfWidth} y={y(candle.high)} width={halfWidth * 2}
              height={Math.max(0, y(candle.low) - y(candle.high))} fill={color} stroke={color} />
            {candle.high === candle.low && <line data-chan-detail-flat-range
              x1={center - halfWidth} x2={center + halfWidth} y1={y(candle.high)} y2={y(candle.low)}
              stroke={color} strokeWidth="1" />}
          </> : <>
            <line data-chan-detail-wick x1={center} x2={center} y1={y(candle.high)} y2={y(candle.low)} stroke={color} strokeWidth="1.5" />
            <rect data-chan-detail-body x={center - halfWidth} y={y(Math.max(candle.open, candle.close))} width={halfWidth * 2}
              height={Math.max(1.5, Math.abs(y(candle.open) - y(candle.close)))} fill={color} stroke={color} />
            {anchor && <circle ref={anchorRef} cx={center} cy={y(detail.price)} r="3.5" fill={accent} stroke="var(--chart-surface)" strokeWidth="1.5" />}
          </>}
        </g>;
      })}
    </svg>
  </div>;
}

function MergeGuides({ detail, comparisonRef }) {
  const [guides, setGuides] = useState([]);

  useEffect(() => {
    const comparison = comparisonRef.current;
    if (!comparison) return undefined;
    const rawViewport = comparison.querySelector('[data-chan-detail-raw-scroll]');
    const mergedViewport = comparison.querySelector('[data-chan-detail-chart="merged"]').parentElement;
    const clippingAncestors = [];
    for (let ancestor = comparison.parentElement; ancestor; ancestor = ancestor.parentElement) {
      clippingAncestors.push(ancestor);
      // A modal dialog is in the top layer and escapes body/HTML overflow clips.
      if (ancestor.tagName === 'DIALOG') break;
    }
    const effectiveViewport = (viewport) => {
      const visible = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
      for (let ancestor = viewport; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        const bounds = ancestor.getBoundingClientRect();
        if (ancestor === viewport || /^(auto|scroll|hidden|clip)$/.test(style.overflowX)) {
          visible.left = Math.max(visible.left, bounds.left + ancestor.clientLeft);
          visible.right = Math.min(visible.right, bounds.left + ancestor.clientLeft + ancestor.clientWidth);
        }
        if (ancestor === viewport || /^(auto|scroll|hidden|clip)$/.test(style.overflowY)) {
          visible.top = Math.max(visible.top, bounds.top + ancestor.clientTop);
          visible.bottom = Math.min(visible.bottom, bounds.top + ancestor.clientTop + ancestor.clientHeight);
        }
        if (ancestor.tagName === 'DIALOG') break;
      }
      return visible;
    };
    const isVisible = (point, visible) => point.x >= visible.left && point.x <= visible.right
      && point.y >= visible.top && point.y <= visible.bottom;
    const screenPoint = (element, x, y) => {
      const matrix = element.getScreenCTM();
      return matrix ? new DOMPoint(x, y).matrixTransform(matrix) : null;
    };
    let frame;
    const measure = () => {
      const bounds = comparison.getBoundingClientRect();
      const sourceVisible = effectiveViewport(rawViewport);
      const resultVisible = effectiveViewport(mergedViewport);
      const next = detail.mergedCandles.flatMap((bar, group) => {
        if (bar.sources.length < 2) return [];
        const result = comparison.querySelector(`[data-chan-detail-merged="${group}"]`);
        return ['high', 'low'].flatMap((field) => {
          // The retained high and low can come from different original candles.
          const source = bar.sources.slice().reverse().find((candle) => candle[field] === bar[field]);
          if (!source) return [];
          const wick = comparison.querySelector(`[data-chan-detail-candle="${source.idx}"] [data-chan-detail-wick]`);
          const range = result.querySelector('[data-chan-detail-range]');
          // Read the actual SVG price coordinates, including a zero-height range.
          // A decorative minimum size must never become a price boundary.
          const start = screenPoint(wick, wick.x1.baseVal.value,
            field === 'high' ? wick.y1.baseVal.value : wick.y2.baseVal.value);
          const end = screenPoint(range, range.x.baseVal.value,
            range.y.baseVal.value + (field === 'low' ? range.height.baseVal.value : 0));
          // Both ends must survive the inner, outer and dialog viewport clips.
          if (!start || !end || !isVisible(start, sourceVisible) || !isVisible(end, resultVisible)) return [];
          return [{ group, field, price: bar[field], sourceIdx: source.idx,
            x1: start.x - bounds.left, x2: end.x - bounds.left, y: start.y - bounds.top }];
        });
      });
      setGuides(next);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(comparison);
    clippingAncestors.forEach((ancestor) => observer?.observe(ancestor));
    comparison.querySelectorAll('[data-chan-detail-chart]').forEach((chart) => observer?.observe(chart));
    // The outer three-panel scroller is a parent of comparison, so a listener
    // on comparison alone cannot receive its scroll events.
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
    };
  }, [detail, comparisonRef]);

  return <svg className="pointer-events-none absolute inset-0 z-10 h-full w-full" aria-hidden="true"
    data-chan-detail-guides>
    {guides.map((guide) => <line key={`${guide.group}:${guide.field}`}
      x1={guide.x1} x2={guide.x2} y1={guide.y} y2={guide.y}
      stroke={detail.mark === 'G' ? 'var(--chan-top)' : 'var(--chan-bottom)'}
      strokeWidth="1" strokeOpacity="0.8" strokeDasharray="3 4"
      data-chan-detail-guide={`${guide.group}:${guide.field}`} data-price={guide.price}
      data-source-idx={guide.sourceIdx} />)}
  </svg>;
}

export default function ChanFractalDetail({ detail, kind = 'fx', onClose }) {
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const comparisonRef = useRef(null);
  const titleId = useId();
  const traitHelpId = useId();
  const [traitHelpOpen, setTraitHelpOpen] = useState(false);
  const isOpen = Boolean(detail);

  useEffect(() => {
    if (!isOpen) return undefined;
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    dialog.showModal();
    closeRef.current?.focus({ preventScroll: true });
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected && typeof previousFocus.focus === 'function') previousFocus.focus({ preventScroll: true });
    };
  }, [isOpen]);

  if (!detail || typeof document === 'undefined') return null;
  const y = chartScale(detail);
  const fractalName = detail.mark === 'G' ? '顶分型' : '底分型';
  const hasInclusion = detail.mergedCandles.some((candle) => candle.sources.length > 1);
  const isTop = detail.mark === 'G';
  const traits = isTop ? detail.topTraits : detail.bottomTraits;
  const invalidOhlc = traits?.reason === 'invalid-ohlc';
  const trait = invalidOhlc ? 'invalid-ohlc' : traits?.primary || (hasInclusion ? 'inclusion' : 'ordinary');
  const traitLabel = (isTop ? TOP_FRACTAL_LABELS : BOTTOM_FRACTAL_LABELS)[trait];
  const traitDescription = (isTop ? topFractalTraitDescription : bottomFractalTraitDescription)(traits);
  const close = () => dialogRef.current?.close();
  const stopInteraction = (event) => event.stopPropagation();

  return createPortal(<dialog ref={dialogRef} aria-labelledby={titleId}
    onMouseDown={stopInteraction} onMouseMove={stopInteraction} onMouseUp={stopInteraction}
    onTouchStart={stopInteraction} onTouchMove={stopInteraction} onTouchEnd={stopInteraction} onTouchCancel={stopInteraction}
    onPointerDown={stopInteraction} onPointerMove={stopInteraction} onPointerUp={stopInteraction} onPointerCancel={stopInteraction}
    onClose={onClose} onClick={(event) => {
      event.stopPropagation();
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
    }}
    className="m-auto max-h-[92dvh] w-[min(1100px,calc(100vw-24px))] max-w-none overflow-y-auto overscroll-contain rounded-2xl border border-slate-200 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-[rgba(0,0,0,0.6)]"
    data-chan-fractal-detail={detail.mark}>
    <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 sm:px-5">
      <div>
        <h2 id={titleId} className="text-base font-semibold">{detail.mark === 'G' ? '顶分型' : '底分型'}</h2>
        <p className="mt-1 text-xs text-slate-500" data-chan-detail-snapshot={kind}>
          {kind === 'bi' ? '笔端快照' : '分型快照'} · 右K截至 {String(detail.mergedCandles[2].sources.at(-1).date)}
        </p>
      </div>
      <button ref={closeRef} type="button" onClick={close} aria-label="关闭分型详情"
        className="rounded-lg px-2 py-1 text-xl leading-none text-slate-500 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600">×</button>
    </header>
    <div className="overflow-x-auto overscroll-x-contain" tabIndex={0} role="region" aria-label="分型三图对照，可横向滚动">
    <div ref={comparisonRef} className="relative grid min-w-[560px] grid-cols-3 gap-3 p-3 sm:gap-5 sm:p-5" data-chan-detail-comparison>
      <section className="min-w-0" aria-label={detail.mark === 'G' ? '标准顶分型' : '标准底分型'} data-chan-detail-panel="standard">
        <h3 className="mb-3 text-center text-sm font-medium">{detail.mark === 'G' ? '标准顶分型' : '标准底分型'}</h3>
        <StandardFractal mark={detail.mark} />
      </section>
      <section className="min-w-0" aria-label="原始K线" data-chan-detail-panel="raw">
        <h3 className="mb-3 text-center text-sm font-medium">原始K线</h3>
        <ComparisonChart detail={detail} merged={false} y={y} />
      </section>
      <section className="min-w-0" aria-label="缠论K线" data-chan-detail-panel="merged">
        <h3 className="mb-3 text-center text-sm font-medium">缠论K线</h3>
        <ComparisonChart detail={detail} merged y={y} />
      </section>
      <MergeGuides detail={detail} comparisonRef={comparisonRef} />
    </div>
    </div>
    <footer className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-slate-200 bg-slate-50 px-4 py-3 text-sm sm:px-5" data-chan-detail-conclusion>
      <span className="mr-2 text-slate-500">结论</span>
      <strong className="font-semibold text-slate-900"
        data-chan-detail-top-trait={isTop && !traitLabel ? trait : undefined}
        data-chan-detail-bottom-trait={!isTop && !traitLabel ? trait : undefined}>
        {hasInclusion ? `第二种：包含关系的${fractalName}` : `第一种：直接${fractalName}`}
      </strong>
      {invalidOhlc && <span role="status" className="text-xs text-amber-700" data-chan-detail-data-error>原K数据异常，未进行力度识别</span>}
      {traitLabel && <span className="text-xs text-slate-500" data-chan-detail-software-reference>软件形态参考</span>}
      {traitLabel && <button type="button" data-chan-detail-top-trait={isTop ? trait : undefined}
        data-chan-detail-bottom-trait={isTop ? undefined : trait} title={traitDescription}
        aria-expanded={traitHelpOpen} aria-controls={traitHelpId}
        onClick={() => setTraitHelpOpen((open) => !open)}
        className={`rounded-full border px-2.5 py-1 text-xs font-medium ${trait === 'continuation'
          ? 'border-blue-200 bg-blue-50 text-blue-700' : trait === 'strong'
            ? 'border-amber-200 bg-amber-50 text-amber-700' : isTop
              ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
        {traitLabel}
      </button>}
      {traitLabel && traitHelpOpen && <p id={traitHelpId} data-chan-detail-trait-help
        className="w-full text-xs leading-6 text-slate-600">
        {traitDescription}
        <a href="https://blog.sina.com.cn/s/blog_486e105c01000cq4.html" target="_blank" rel="noreferrer"
          className="ml-1 text-blue-600 underline underline-offset-2">第82课原文</a>
      </p>}
    </footer>
  </dialog>, document.body);
}
