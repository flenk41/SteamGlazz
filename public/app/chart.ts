/**
 * Dependency-free SVG step-line chart for price history.
 *
 * - step-after lines: a price holds until the next stored point;
 * - one crosshair tooltip listing every visible series (snaps to the nearest data time);
 * - legend toggles series, ≤ 4 series are also direct-labelled at the line ends;
 * - keyboard: focus the plot and use ←/→; a table view mirrors the data.
 */

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  dashed?: boolean;
  points: [number, number][];
}

export interface ChartOptions {
  from: number;
  to: number;
  height?: number;
  format: (v: number) => string;
  empty?: string;
}

const SVG = 'http://www.w3.org/2000/svg';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.append(node);
  return node;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

function yScaleTicks(min: number, max: number, count: number): { lo: number; hi: number; ticks: number[] } {
  if (min === max) {
    const pad = Math.abs(min) * 0.05 || 1;
    min -= pad;
    max += pad;
  }
  const step = niceStep((max - min) / count);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
  return { lo, hi, ticks };
}

const X_STEPS = [HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 90 * DAY];

function xTicks(from: number, to: number, maxTicks: number): number[] {
  const span = to - from;
  const step = X_STEPS.find((s) => span / s <= maxTicks) ?? X_STEPS[X_STEPS.length - 1]!;
  const tz = new Date().getTimezoneOffset() * 60_000; // align to local midnight / hours
  const out: number[] = [];
  for (let t = Math.ceil((from - tz) / step) * step + tz; t <= to; t += step) out.push(t);
  return out;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
function fmtTime(t: number, span: number): string {
  const d = new Date(t);
  const date = `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`;
  if (span > 3 * DAY) return date;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return d.getHours() === 0 ? date : time;
}
function fmtFull(t: number): string {
  const d = new Date(t);
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} ${pad2(d.getHours())}:00`;
}

/** Value in force at time t (step-after), or null before the first point. */
function valueAt(points: [number, number][], t: number): number | null {
  let lo = 0;
  let hi = points.length - 1;
  let ans: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]![0] <= t) {
      ans = points[mid]![1];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function renderChart(root: HTMLElement, series: ChartSeries[], opts: ChartOptions): () => void {
  root.replaceChildren();
  root.classList.add('chart');
  const height = opts.height ?? 260;
  const hidden = new Set<string>();

  const legend = h('div', 'chart-legend');
  const plot = h('div', 'chart-plot');
  const tip = h('div', 'chart-tip');
  tip.hidden = true;
  plot.append(tip);
  const details = h('details', 'chart-table');
  details.append(h('summary', undefined, 'Показать таблицей'));
  root.append(legend, plot, details);

  for (const s of series) {
    const b = h('button', 'chart-key');
    b.type = 'button';
    b.setAttribute('aria-pressed', 'true');
    const key = h('i');
    key.style.setProperty('--c', s.color);
    if (s.dashed) key.classList.add('dashed');
    b.append(key, document.createTextNode(s.label));
    b.addEventListener('click', () => {
      if (hidden.has(s.key)) hidden.delete(s.key);
      else if (series.length - hidden.size > 1) hidden.add(s.key); // keep at least one
      b.setAttribute('aria-pressed', String(!hidden.has(s.key)));
      draw();
    });
    legend.append(b);
  }

  function buildTable(visible: ChartSeries[]): void {
    const times = [...new Set(visible.flatMap((s) => s.points.map((p) => p[0])))].sort((a, b) => b - a).slice(0, 300);
    const table = h('table', 'grid compact');
    const head = h('tr');
    head.append(h('th', undefined, 'Время'));
    for (const s of visible) head.append(h('th', 'num', s.label));
    const thead = h('thead');
    thead.append(head);
    const tbody = h('tbody');
    for (const t of times) {
      const tr = h('tr');
      tr.append(h('td', undefined, fmtFull(t)));
      for (const s of visible) {
        const v = valueAt(s.points, t);
        tr.append(h('td', 'num', v == null ? '—' : opts.format(v)));
      }
      tbody.append(tr);
    }
    table.append(thead, tbody);
    details.querySelector('table')?.remove();
    details.append(table);
  }

  let cleanupHover: (() => void) | null = null;

  function draw(): void {
    cleanupHover?.();
    plot.querySelector('svg')?.remove();
    plot.querySelector('.chart-empty')?.remove();
    const visible = series.filter((s) => !hidden.has(s.key) && s.points.length);
    buildTable(visible);
    if (!visible.length) {
      plot.prepend(h('div', 'chart-empty', opts.empty ?? 'Нет данных за период'));
      return;
    }

    const W = Math.max(plot.clientWidth, 280);
    const labelled = visible.length <= 4 && W > 520;
    const M = { l: 58, r: labelled ? 112 : 14, t: 12, b: 26 };
    const iw = W - M.l - M.r;
    const ih = height - M.t - M.b;
    const { from, to } = opts;
    const span = to - from;

    const vals = visible.flatMap((s) => s.points.filter((p) => p[0] <= to).map((p) => p[1]));
    const { lo, hi, ticks } = yScaleTicks(Math.min(...vals), Math.max(...vals), 4);
    const x = (t: number): number => M.l + ((Math.min(Math.max(t, from), to) - from) / span) * iw;
    const y = (v: number): number => M.t + (1 - (v - lo) / (hi - lo)) * ih;

    const svg = el('svg', {
      width: W, height, viewBox: `0 0 ${W} ${height}`, role: 'img', tabindex: 0,
      'aria-label': `График цен: ${visible.map((s) => s.label).join(', ')}. Стрелки ← → — перемещение по точкам.`,
    });

    // grid + y labels
    const grid = el('g', { class: 'chart-grid' }, svg);
    for (const v of ticks) {
      el('line', { x1: M.l, x2: M.l + iw, y1: y(v), y2: y(v) }, grid);
      const t = el('text', { x: M.l - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'chart-axis' }, grid);
      t.textContent = opts.format(v);
    }
    // x labels
    const maxX = Math.max(2, Math.floor(iw / 80));
    for (const t of xTicks(from, to, maxX)) {
      const tx = el('text', { x: x(t), y: height - 8, 'text-anchor': 'middle', class: 'chart-axis' }, svg);
      tx.textContent = fmtTime(t, span);
    }
    el('line', { x1: M.l, x2: M.l + iw, y1: M.t + ih, y2: M.t + ih, class: 'chart-base' }, svg);

    // series
    const ends: { s: ChartSeries; y: number; v: number }[] = [];
    for (const s of visible) {
      const pts = s.points.filter((p) => p[0] <= to);
      if (!pts.length) continue;
      let d = `M${x(pts[0]![0]).toFixed(1)},${y(pts[0]![1]).toFixed(1)}`;
      for (let i = 1; i < pts.length; i++) d += `H${x(pts[i]![0]).toFixed(1)}V${y(pts[i]![1]).toFixed(1)}`;
      d += `H${x(to).toFixed(1)}`;
      el('path', {
        d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
        ...(s.dashed ? { 'stroke-dasharray': '6 4' } : {}),
      }, svg);
      const lastV = pts[pts.length - 1]![1];
      if (pts.length === 1) el('circle', { cx: x(pts[0]![0]), cy: y(lastV), r: 4, fill: s.color, class: 'chart-ring' }, svg);
      el('circle', { cx: x(to), cy: y(lastV), r: 4, fill: s.color, class: 'chart-ring' }, svg);
      ends.push({ s, y: y(lastV), v: lastV });
    }

    // direct labels at the right edge, pushed apart so they never overlap
    if (labelled) {
      ends.sort((a, b) => a.y - b.y);
      const gap = 15;
      for (let i = 1; i < ends.length; i++) ends[i]!.y = Math.max(ends[i]!.y, ends[i - 1]!.y + gap);
      const overflow = ends.length ? ends[ends.length - 1]!.y - (M.t + ih) : 0;
      if (overflow > 0) for (const e of ends) e.y -= overflow;
      for (const e of ends) {
        const t = el('text', { x: x(to) + 10, y: e.y + 4, class: 'chart-direct' }, svg);
        t.textContent = e.s.label.replace(/ \(.*\)$/, '');
      }
    }

    // hover layer: crosshair snaps to the nearest stored time
    const times = [...new Set(visible.flatMap((s) => s.points.map((p) => Math.max(p[0], from))))]
      .filter((t) => t <= to)
      .sort((a, b) => a - b);
    const cross = el('line', { y1: M.t, y2: M.t + ih, class: 'chart-cross', visibility: 'hidden' }, svg);
    const dots = visible.map((s) => el('circle', { r: 4, fill: s.color, class: 'chart-ring', visibility: 'hidden' }, svg));
    const hit = el('rect', { x: M.l, y: M.t, width: iw, height: ih, fill: 'transparent' }, svg);
    plot.prepend(svg);

    let idx = -1;
    const show = (i: number): void => {
      idx = Math.max(0, Math.min(times.length - 1, i));
      const t = times[idx]!;
      const cx = x(t);
      cross.setAttribute('x1', String(cx));
      cross.setAttribute('x2', String(cx));
      cross.setAttribute('visibility', 'visible');
      tip.replaceChildren(h('div', 'chart-tip-time', fmtFull(t)));
      visible.forEach((s, k) => {
        const v = valueAt(s.points, t);
        const dot = dots[k]!;
        if (v == null) {
          dot.setAttribute('visibility', 'hidden');
          return;
        }
        dot.setAttribute('cx', String(cx));
        dot.setAttribute('cy', String(y(v)));
        dot.setAttribute('visibility', 'visible');
        const row = h('div', 'chart-tip-row');
        const key = h('i');
        key.style.setProperty('--c', s.color);
        if (s.dashed) key.classList.add('dashed');
        row.append(key, h('b', undefined, opts.format(v)), h('span', undefined, s.label));
        tip.append(row);
      });
      tip.hidden = false;
      const tw = tip.offsetWidth;
      tip.style.left = `${cx + 14 + tw > W ? cx - 14 - tw : cx + 14}px`;
      tip.style.top = `${M.t}px`;
    };
    const hide = (): void => {
      tip.hidden = true;
      cross.setAttribute('visibility', 'hidden');
      for (const d of dots) d.setAttribute('visibility', 'hidden');
    };
    const nearest = (t: number): number => {
      let lo2 = 0;
      let hi2 = times.length - 1;
      while (lo2 < hi2) {
        const mid = (lo2 + hi2) >> 1;
        if (times[mid]! < t) lo2 = mid + 1;
        else hi2 = mid;
      }
      if (lo2 > 0 && Math.abs(times[lo2 - 1]! - t) < Math.abs(times[lo2]! - t)) lo2--;
      return lo2;
    };
    const onMove = (e: PointerEvent): void => {
      const r = svg.getBoundingClientRect();
      const t = from + ((e.clientX - r.left - M.l) / iw) * span;
      show(nearest(t));
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        show(idx < 0 ? times.length - 1 : idx + (e.key === 'ArrowRight' ? 1 : -1));
      } else if (e.key === 'Escape') hide();
    };
    hit.addEventListener('pointermove', onMove);
    hit.addEventListener('pointerleave', hide);
    svg.addEventListener('keydown', onKey);
    svg.addEventListener('blur', hide);
    cleanupHover = () => {
      hit.removeEventListener('pointermove', onMove);
      svg.removeEventListener('keydown', onKey);
    };
  }

  draw();
  let raf = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(draw);
  });
  ro.observe(plot);
  return () => {
    ro.disconnect();
    cleanupHover?.();
  };
}
