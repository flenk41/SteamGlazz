import type {
  ArbRow,
  Category,
  DealRow,
  FeeTable,
  HistoryResponse,
  Item,
  MarketId,
  MoverRow,
  MoversResponse,
  SourceStatus,
} from '../../server/types.ts';
import type { Card } from '../../server/card.ts';
import type { Strategy, StrategyMode } from '../../server/strategy.ts';
import { renderChart, type ChartSeries } from './chart.ts';

// ── Types & helpers ──────────────────────────────────────────────────────────

interface MarketInfo {
  id: MarketId;
  label: string;
  color: string;
  site: string;
}
interface Rate {
  rate: number;
  date: string;
  source: 'cbr' | 'cache' | 'fallback';
}
interface Meta {
  markets: Record<MarketId, MarketInfo>;
  defaultFees: FeeTable;
  sales: { label: string; color: string };
  walletOnly: MarketId[];
  rate: Rate;
}
interface Page<T> {
  total: number;
  rows: T[];
}
type Tab = 'deals' | 'strategy' | 'arbitrage' | 'movers' | 'card' | 'compare' | 'fees';
const TABS: Tab[] = ['deals', 'strategy', 'arbitrage', 'movers', 'card', 'compare', 'fees'];

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);
// ── Currency: all prices arrive in USD; RUB is a display conversion ─────────

type Currency = 'USD' | 'RUB';
const cur = {
  code: ((): Currency => {
    try {
      return localStorage.getItem('sg.cur') === '"RUB"' ? 'RUB' : 'USD';
    } catch {
      return 'USD';
    }
  })(),
  /** USD→RUB in use: the user's own rate or the CBR one */
  rate: 1,
};
/** multiplier from USD to the display currency */
const factor = (): number => (cur.code === 'RUB' ? cur.rate : 1);

/** Format a value that is already in the display currency. */
function fmtCur(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (cur.code === 'RUB') {
    const digits = Math.abs(v) < 100 ? 2 : 0;
    return `${v.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ₽`;
  }
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
/** Format a USD amount in the display currency. */
const usd = (x: number | null | undefined): string => (x == null ? '—' : fmtCur(x * factor()));
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const int = (x: number | null | undefined): string => (x == null ? '—' : x.toLocaleString('ru-RU'));

function ago(ts: number | null): string {
  if (!ts) return 'нет данных';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s} с`;
  if (s < 3600) return `${Math.round(s / 60)} мин`;
  return `${Math.round(s / 3600)} ч`;
}

const storage = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(key);
      return v ? (JSON.parse(v) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // private mode — ignore
    }
  },
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

function toast(msg: string): void {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), 2600);
}

const debounce = <A extends unknown[]>(fn: (...a: A) => void, ms: number) => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

const CAT_ABBR: Record<Category, string> = {
  knife: 'KN', gloves: 'GL', weapon: 'WP', sticker: 'ST', charm: 'CH', container: 'CS',
  agent: 'AG', patch: 'PT', music: 'MU', graffiti: 'GR', other: '··',
};
const CAT_LABEL: Record<Category, string> = {
  knife: 'Нож', gloves: 'Перчатки', weapon: 'Оружие', sticker: 'Наклейка', charm: 'Брелок', container: 'Кейс',
  agent: 'Агент', patch: 'Нашивка', music: 'Музыка', graffiti: 'Граффити', other: 'Другое',
};
const REF_LABEL = { median7d: 'медиана 7д', cross: 'др. площадки', suggested: 'suggested' } as const;

// ── State ────────────────────────────────────────────────────────────────────

let meta: Meta;
const PAGE = 100;
const limits: Record<'deals' | 'arbitrage', number> = { deals: PAGE, arbitrage: PAGE };
const controllers: Partial<Record<string, AbortController>> = {};

function getFees(): FeeTable {
  const saved = storage.get<Partial<FeeTable>>('sg.fees', {});
  const fees = structuredClone(meta.defaultFees);
  for (const m of Object.keys(fees) as MarketId[]) {
    const s = saved[m];
    if (s) fees[m] = { sell: Number(s.sell) || 0, buy: Number(s.buy) || 0 };
  }
  return fees;
}

const watchlist = {
  all: (): string[] => storage.get<string[]>('sg.watch', []),
  has: (name: string): boolean => watchlist.all().includes(name),
  toggle(name: string): boolean {
    const list = watchlist.all();
    const i = list.indexOf(name);
    if (i >= 0) list.splice(i, 1);
    else list.unshift(name);
    storage.set('sg.watch', list.slice(0, 50));
    return i < 0;
  },
};

function mk(market: MarketId, url?: string, text?: string): string {
  const m = meta.markets[market];
  const label = esc(text ?? m.label);
  const inner = url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${label}</a>` : label;
  return `<span class="mk" style="--c:${m.color}">${inner}</span>`;
}

function itemCell(name: string, cat: Category): string {
  const on = watchlist.has(name);
  return `<div class="item">
    <span class="cat" title="${CAT_LABEL[cat]}">${CAT_ABBR[cat]}</span>
    <button type="button" data-card="${esc(name)}" title="Карточка скина: цена, продажа, процент, ликвидность">${esc(name)}</button>
    <button type="button" class="star${on ? ' on' : ''}" data-star="${esc(name)}" aria-label="В избранное">${on ? '★' : '☆'}</button>
  </div>`;
}

// ── Filters → query string ───────────────────────────────────────────────────

function formParams(form: HTMLFormElement): URLSearchParams {
  const p = new URLSearchParams();
  const multi = new Map<string, string[]>();
  for (const el of Array.from(form.elements)) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement) || !el.name) continue;
    if (el instanceof HTMLInputElement && el.type === 'radio') {
      if (el.checked) p.set(el.name, el.value);
      continue;
    }
    if (el instanceof HTMLInputElement && el.type === 'checkbox') {
      if (el.closest('[data-multi]')) {
        const arr = multi.get(el.name) ?? [];
        if (el.checked) arr.push(el.value);
        multi.set(el.name, arr);
      } else if (el.checked) p.set(el.name, el.value);
      else if (el.dataset.off !== undefined) p.set(el.name, el.dataset.off);
      continue;
    }
    const v = el.value.trim().replace(',', '.');
    if (v === '') continue;
    if (el.dataset.pct !== undefined) p.set(el.name, String(Number(v) / 100));
    else if (el.dataset.money !== undefined) p.set(el.name, String(Number(v) / factor())); // API works in USD
    else p.set(el.name, v);
  }
  for (const [k, arr] of multi) p.set(k, arr.join(',') || 'none');
  return p;
}

function buildChips(): void {
  for (const fs of document.querySelectorAll<HTMLFieldSetElement>('fieldset[data-multi]')) {
    const name = fs.dataset.multi!;
    const key = `sg.chips.${fs.closest('form')!.id}.${name}`;
    const off = (fs.dataset.off ?? '').split(',');
    // saved as { on, all }; old saves were a plain array of the three original markets
    const saved = storage.get<{ on: string[]; all: string[] } | string[] | null>(key, null);
    const on = Array.isArray(saved) ? saved : (saved?.on ?? []);
    const known = Array.isArray(saved) ? ['skinport', 'marketcsgo', 'lisskins'] : (saved?.all ?? []);
    for (const m of Object.values(meta.markets)) {
      // markets the user has already seen keep their choice; new ones get the default
      const checked = known.includes(m.id) ? on.includes(m.id) : !off.includes(m.id);
      fs.insertAdjacentHTML(
        'beforeend',
        `<label class="chip" style="--c:${m.color}"><input type="checkbox" name="${name}" value="${m.id}"${checked ? ' checked' : ''}><span>${esc(m.label)}</span></label>`,
      );
    }
    fs.addEventListener('change', () => {
      const vals = [...fs.querySelectorAll<HTMLInputElement>('input:checked')].map((i) => i.value);
      storage.set(key, { on: vals, all: Object.keys(meta.markets) });
    });
  }
}

// ── Tables ───────────────────────────────────────────────────────────────────

interface Col {
  label: string;
  sort?: string;
  num?: boolean;
}

function head(form: HTMLFormElement, cols: Col[]): string {
  const sort = (form.elements.namedItem('sort') as HTMLInputElement).value;
  const dir = (form.elements.namedItem('dir') as HTMLInputElement).value;
  return `<thead><tr>${cols
    .map((c) => {
      const cls = [c.num ? 'num' : '', c.sort === sort ? `sorted ${dir}` : ''].join(' ').trim();
      return `<th${cls ? ` class="${cls}"` : ''}${c.sort ? ` data-sort="${c.sort}"` : ''}>${c.label}</th>`;
    })
    .join('')}</tr></thead>`;
}

function emptyRow(span: number, text: string): string {
  return `<tbody><tr class="empty-row"><td colspan="${span}">${text}</td></tr></tbody>`;
}

const DEAL_COLS: Col[] = [
  { label: 'Предмет', sort: 'name' },
  { label: 'Площадка', sort: 'market' },
  { label: 'Цена', sort: 'price', num: true },
  { label: 'Обычно', sort: 'ref', num: true },
  { label: 'Скидка', sort: 'discount', num: true },
  { label: 'Лотов', sort: 'count', num: true },
  { label: 'Продаж 7д', sort: 'volume7d', num: true },
  { label: 'На других площадках' },
  { label: '' },
];

function renderDeals(form: HTMLFormElement, page: Page<DealRow>): void {
  const t = $<HTMLTableElement>('#t-deals');
  $('#deals-count').innerHTML = `Найдено: <b>${int(page.total)}</b>`;
  if (!page.rows.length) {
    t.innerHTML = head(form, DEAL_COLS) + emptyRow(DEAL_COLS.length, 'Ничего не найдено — ослабьте фильтры (скидка, продажи за 7 дней, цена).');
  } else {
    t.innerHTML =
      head(form, DEAL_COLS) +
      `<tbody>${page.rows
        .map(
          (r) => `<tr>
        <td>${itemCell(r.name, r.category)}</td>
        <td>${mk(r.market, r.url)}</td>
        <td class="num"><b>${usd(r.price)}</b></td>
        <td class="num" title="${REF_LABEL[r.refKind]}">${usd(r.ref)} <span class="badge">${REF_LABEL[r.refKind]}</span></td>
        <td class="num up">−${pct(r.discount)}</td>
        <td class="num">${int(r.count)}</td>
        <td class="num">${int(r.volume7d)}</td>
        <td><div class="others">${r.others.map((o) => `<span>${mk(o.market, undefined, usd(o.price))}</span>`).join('') || '<span>—</span>'}</div></td>
        <td><a class="buy-link" href="${esc(r.url)}" target="_blank" rel="noopener">Купить →</a></td>
      </tr>`,
        )
        .join('')}</tbody>`;
  }
  $('#deals-more').hidden = page.rows.length >= page.total;
}

const ARB_COLS: Col[] = [
  { label: 'Предмет', sort: 'name' },
  { label: 'Купить', sort: 'buyPrice', num: true },
  { label: 'Продать', sort: 'sellPrice', num: true },
  { label: 'Получите', sort: 'sellNet', num: true },
  { label: 'Профит', sort: 'profit', num: true },
  { label: 'ROI', sort: 'roi', num: true },
  { label: 'Продаж 7д', sort: 'volume7d', num: true },
  { label: 'Медиана 7д', sort: 'median7d', num: true },
  { label: '' },
];

function renderArb(form: HTMLFormElement, page: Page<ArbRow>): void {
  const t = $<HTMLTableElement>('#t-arbitrage');
  const sum = page.rows.reduce((s, r) => s + r.profit, 0);
  $('#arbitrage-count').innerHTML = `Связок: <b>${int(page.total)}</b> · суммарный профит на странице: <b class="up">${usd(sum)}</b>`;
  if (!page.rows.length) {
    t.innerHTML = head(form, ARB_COLS) + emptyRow(ARB_COLS.length, 'Выгодных связок нет — уменьшите минимальный профит/ROI или выберите режим «По мин. лоту».');
  } else {
    t.innerHTML =
      head(form, ARB_COLS) +
      `<tbody>${page.rows
        .map(
          (r) => `<tr>
        <td>${itemCell(r.name, r.category)}</td>
        <td class="num"><span class="route">${mk(r.buyMarket, r.buyUrl)} <b>${usd(r.buyPrice)}</b></span></td>
        <td class="num"><span class="route">${mk(r.sellMarket, r.sellUrl)} ${usd(r.sellPrice)}</span></td>
        <td class="num">${usd(r.sellNet)}</td>
        <td class="num"><span class="pill-profit">+${usd(r.profit)}</span></td>
        <td class="num up">${pct(r.roi)}</td>
        <td class="num">${int(r.volume7d)}</td>
        <td class="num muted">${usd(r.median7d)}</td>
        <td>${r.walletOnly ? '<span class="badge warn" title="Деньги от продажи в Steam остаются на балансе Steam — вывести их нельзя">баланс Steam</span> ' : ''}${r.suspicious ? '<span class="badge warn" title="Слишком большой ROI или единственный лот — проверьте вручную">проверить</span>' : ''}</td>
      </tr>`,
        )
        .join('')}</tbody>`;
  }
  $('#arbitrage-more').hidden = page.rows.length >= page.total;
}

async function loadTable(tab: 'deals' | 'arbitrage'): Promise<void> {
  const form = $<HTMLFormElement>(`#f-${tab}`);
  const p = formParams(form);
  p.set('limit', String(limits[tab]));
  if (tab === 'arbitrage') p.set('fees', JSON.stringify(getFees()));
  controllers[tab]?.abort();
  const ctl = new AbortController();
  controllers[tab] = ctl;
  const wrap = $(`#t-${tab}`).parentElement!;
  wrap.classList.add('busy');
  try {
    const page = await api<Page<DealRow & ArbRow>>(`/api/${tab}?${p}`, { signal: ctl.signal });
    if (tab === 'deals') renderDeals(form, page);
    else renderArb(form, page);
  } catch (err) {
    if ((err as Error).name !== 'AbortError') toast(`Ошибка загрузки: ${(err as Error).message}`);
  } finally {
    wrap.classList.remove('busy');
  }
}

function wireTable(tab: 'deals' | 'arbitrage'): void {
  const form = $<HTMLFormElement>(`#f-${tab}`);
  const reload = debounce(() => {
    limits[tab] = PAGE;
    void loadTable(tab);
  }, 300);
  form.addEventListener('input', reload);
  form.addEventListener('change', reload);
  form.addEventListener('submit', (e) => e.preventDefault());

  $(`#t-${tab}`).addEventListener('click', (e) => {
    const th = (e.target as Element).closest<HTMLElement>('th[data-sort]');
    if (!th) return;
    const sort = form.elements.namedItem('sort') as HTMLInputElement;
    const dir = form.elements.namedItem('dir') as HTMLInputElement;
    if (sort.value === th.dataset.sort) dir.value = dir.value === 'desc' ? 'asc' : 'desc';
    else {
      sort.value = th.dataset.sort!;
      dir.value = sort.value === 'name' || sort.value === 'market' ? 'asc' : 'desc';
    }
    void loadTable(tab);
  });

  $(`#${tab}-more`).addEventListener('click', () => {
    limits[tab] += PAGE;
    void loadTable(tab);
  });

  for (const a of document.querySelectorAll<HTMLAnchorElement>(`a[data-export="${tab}"]`)) {
    a.addEventListener('click', () => {
      const p = formParams(form);
      p.set('type', tab);
      p.set('format', a.dataset.format!);
      if (tab === 'arbitrage') p.set('fees', JSON.stringify(getFees()));
      exportCurrency(p);
      a.href = `/api/export?${p}`;
    });
  }
}

/** Exports follow the display currency (server converts money columns). */
function exportCurrency(p: URLSearchParams): void {
  if (cur.code !== 'RUB') return;
  p.set('currency', 'RUB');
  p.set('rate', String(cur.rate));
}

// ── Strategy ─────────────────────────────────────────────────────────────────

const MODE_TEXT: Record<StrategyMode, { spend: string; get: string; gain: string; empty: string }> = {
  cash: {
    spend: 'Вложить',
    get: 'Получите на руки',
    gain: 'Прибыль',
    empty: 'Под эти условия выгодных связок нет — увеличьте срок продажи, снизьте мин. продажи в день или мин. выгоду.',
  },
  'steam-out': {
    spend: 'Потратите баланса Steam',
    get: 'Получите деньгами',
    gain: 'Курс вывода',
    empty: 'Нет скинов Steam, подходящих под условия. Цены Steam собираются в фоне — попробуйте позже или увеличьте срок продажи.',
  },
  'steam-in': {
    spend: 'Потратите',
    get: 'Получите на баланс Steam',
    gain: 'Бонус к пополнению',
    empty: 'Сейчас нет скинов, через которые выгодно пополнять Steam под эти условия. Снизьте мин. выгоду или подождите, пока соберутся цены Steam.',
  },
};

function strategyParams(): URLSearchParams {
  const p = formParams($<HTMLFormElement>('#f-strategy'));
  p.set('fees', JSON.stringify(getFees()));
  return p;
}

async function loadStrategy(): Promise<void> {
  const out = $('#strategy-out');
  const p = strategyParams();
  controllers.strategy?.abort();
  const ctl = new AbortController();
  controllers.strategy = ctl;
  out.classList.add('busy');
  try {
    const s = await api<Strategy>(`/api/strategy?${p}`, { signal: ctl.signal });
    out.innerHTML = renderStrategy(s);
    for (const a of out.querySelectorAll<HTMLAnchorElement>('a[data-export="strategy"]')) {
      const e = strategyParams();
      e.set('type', 'strategy');
      e.set('format', a.dataset.format!);
      exportCurrency(e);
      a.href = `/api/export?${e}`;
    }
  } catch (err) {
    if ((err as Error).name !== 'AbortError') toast(`Ошибка: ${(err as Error).message}`);
  } finally {
    out.classList.remove('busy');
  }
}

function renderStrategy(s: Strategy): string {
  const t = MODE_TEXT[s.mode];
  if (!s.steps.length) {
    return `<div class="card empty"><p>${t.empty}</p><p class="muted">Подходящих скинов найдено: ${int(s.candidates)}.</p></div>`;
  }
  const gainValue =
    s.mode === 'steam-out'
      ? `<b class="${s.ratio >= 1 ? 'up' : 'warn'}">${(s.ratio * 100).toFixed(1)}%</b><span>за 100 ${cur.code === 'RUB' ? '₽' : '$'} баланса получите ${usd(100 / factor() * s.ratio)}</span>`
      : `<b class="${signCls(s.ratio - 1)}">${s.profit >= 0 ? '+' : '−'}${usd(Math.abs(s.profit))}</b><span>${signPct(s.ratio - 1)} к вложенному</span>`;

  // human-readable plan
  const top = s.routes.find((r) => r.inPlan > 0);
  const byRoute = s.routes.filter((r) => r.inPlan > 0);
  const units = s.steps.reduce((n, x) => n + x.qty, 0);
  const lines: string[] = [];
  if (top) {
    lines.push(
      `<p>Самая выгодная связка сейчас: <b>${esc(meta.markets[top.buyMarket].label)} → ${esc(meta.markets[top.sellMarket].label)}</b> — ` +
        `${top.inPlan} ${plural(top.inPlan, 'скин', 'скина', 'скинов')} в плане, ` +
        (s.mode === 'steam-out' ? `курс вывода ${(top.planRatio * 100).toFixed(1)}%.` : `прибыль ${usd(top.planProfit)}.`) +
        '</p>',
    );
  }
  lines.push(
    `<p>План: <b>${units} ${plural(units, 'покупка', 'покупки', 'покупок')}</b> (${s.steps.length} ${plural(s.steps.length, 'скин', 'скина', 'скинов')}) на <b>${usd(s.spent)}</b>` +
      (s.leftover >= 0.5 ? `, остаток бюджета ${usd(s.leftover)} — больше подходящих скинов под ограничения нет` : '') +
      `. Всё должно продаться примерно за <b>${s.days.toLocaleString('ru-RU')} ${Number.isInteger(s.days) ? plural(s.days, 'день', 'дня', 'дней') : 'дня'}</b>.</p>`,
  );
  lines.push(
    '<ol>' +
      byRoute
        .map(
          (r) =>
            `<li>Купите на <b>${esc(meta.markets[r.buyMarket].label)}</b> ${r.inPlan} ${plural(r.inPlan, 'скин', 'скина', 'скинов')} из плана и выставьте их на <b>${esc(meta.markets[r.sellMarket].label)}</b> по указанной цене.</li>`,
        )
        .join('') +
      '<li>Выставляйте на 1 цент ниже текущего минимального лота; если за пару дней не продалось — снижайте до медианы.</li>' +
      (s.mode === 'steam-in' ? '<li>Деньги от продажи в Steam остаются на балансе Steam — вывести их нельзя.</li>' : '') +
      '</ol>',
  );

  const routeRows = s.routes
    .slice(0, 12)
    .map(
      (r, i) => `<tr${i === 0 && r.inPlan ? ' class="route-top"' : ''}>
        <td><span class="route-cell">${mk(r.buyMarket)}<span class="arrow">→</span>${mk(r.sellMarket)}</span></td>
        <td class="num">${int(r.items)}</td>
        <td class="num ${signCls(r.avgRatio - 1)}">${s.mode === 'steam-out' ? (r.avgRatio * 100).toFixed(1) + '%' : signPct(r.avgRatio - 1)}</td>
        <td class="num ${signCls(r.bestRatio - 1)}">${s.mode === 'steam-out' ? (r.bestRatio * 100).toFixed(1) + '%' : signPct(r.bestRatio - 1)}</td>
        <td class="num">${r.inPlan || '—'}</td>
        <td class="num ${signCls(r.planProfit)}">${r.inPlan ? (r.planProfit >= 0 ? '+' : '−') + usd(Math.abs(r.planProfit)) : '—'}</td>
      </tr>`,
    )
    .join('');

  const stepRows = s.steps
    .map(
      (x, i) => `<tr>
        <td class="num muted">${i + 1}</td>
        <td>${itemCell(x.name, x.category)}</td>
        <td class="num"><span class="route">${mk(x.buyMarket, x.buyUrl)} <b>${usd(x.buyPrice)}</b></span></td>
        <td class="num">×${x.qty}</td>
        <td class="num"><span class="route">${mk(x.sellMarket)} ${usd(x.sellAt)}</span></td>
        <td class="num">${usd(x.proceeds)}</td>
        <td class="num ${signCls(x.profit)}">${x.profit >= 0 ? '+' : '−'}${usd(Math.abs(x.profit))}</td>
        <td class="num ${signCls(x.ratio - 1)}">${s.mode === 'steam-out' ? (x.ratio * 100).toFixed(1) + '%' : signPct(x.ratio - 1)}</td>
        <td class="num">${x.perDay.toLocaleString('ru-RU')}</td>
        <td class="num">~${x.daysToSell.toLocaleString('ru-RU')} дн</td>
      </tr>`,
    )
    .join('');

  return `
    <div class="kpis">
      <div class="kpi"><small>${t.spend}</small><b>${usd(s.spent)}</b><span>из бюджета ${usd(s.budget)}</span></div>
      <div class="kpi"><small>${t.get}</small><b>${usd(s.proceeds)}</b><span>после комиссий площадок</span></div>
      <div class="kpi"><small>${t.gain}</small>${gainValue}</div>
      <div class="kpi"><small>Срок</small><b>~${s.days.toLocaleString('ru-RU')} дн</b><span>${s.steps.length} ${plural(s.steps.length, 'скин', 'скина', 'скинов')} · из ${int(s.candidates)} подходящих</span></div>
    </div>
    <div class="plan-text">${lines.join('')}</div>

    <h2 class="section-h">Связки площадок</h2>
    <div class="table-wrap"><table class="grid">
      <thead><tr><th>Купить → продать</th><th class="num">Подходит скинов</th><th class="num">${s.mode === 'steam-out' ? 'Средний курс' : 'Средняя выгода'}</th><th class="num">Лучшая</th><th class="num">В плане</th><th class="num">Прибыль в плане</th></tr></thead>
      <tbody>${routeRows}</tbody>
    </table></div>

    <div class="toolbar">
      <h2 class="section-h" style="margin:0">План сделок</h2>
      <span class="spacer"></span>
      <a class="btn" data-export="strategy" data-format="csv">Выгрузить план CSV</a>
      <a class="btn" data-export="strategy" data-format="json">JSON</a>
    </div>
    <div class="table-wrap"><table class="grid">
      <thead><tr><th class="num">#</th><th>Скин</th><th class="num">Купить</th><th class="num">Шт</th><th class="num">Выставить</th>
        <th class="num">На руки</th><th class="num">Прибыль</th><th class="num">${s.mode === 'steam-out' ? 'Курс' : 'Выгода'}</th>
        <th class="num">Продаж/день</th><th class="num">Продастся</th></tr></thead>
      <tbody>${stepRows}</tbody>
    </table></div>`;
}

function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

function wireStrategy(): void {
  const form = $<HTMLFormElement>('#f-strategy');
  const reload = debounce(() => void loadStrategy(), 350);
  form.addEventListener('input', reload);
  form.addEventListener('change', reload);
  form.addEventListener('submit', (e) => e.preventDefault());
}

// ── Movers ───────────────────────────────────────────────────────────────────

const PERIOD_TEXT: Record<string, { label: string; sales: string }> = {
  '1d': { label: '24 часа', sales: 'медиана продаж за последние 24 часа против медианы за 7 дней' },
  '7d': { label: '7 дней', sales: 'медиана продаж за 7 дней против медианы за 30 дней' },
  '30d': { label: '30 дней', sales: 'медиана продаж за 30 дней против медианы за 90 дней' },
};

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

const MOVER_COLS: Col[] = [
  { label: 'Предмет' },
  { label: 'Где' },
  { label: 'Было → сейчас', num: true },
  { label: 'Изменение', num: true },
  { label: 'Продаж', num: true },
];

function moverRows(rows: MoverRow[], emptyText: string): string {
  const thead = `<thead><tr>${MOVER_COLS.map((c) => `<th${c.num ? ' class="num"' : ''}>${c.label}</th>`).join('')}</tr></thead>`;
  if (!rows.length) return thead + emptyRow(MOVER_COLS.length, emptyText);
  return (
    thead +
    `<tbody>${rows
      .map((r) => {
        const where =
          r.market === 'sales'
            ? `<span class="mk-sales" title="Медиана реальных продаж Skinport">Продажи${r.url ? ` <a href="${esc(r.url)}" target="_blank" rel="noopener">↗</a>` : ''}</span>`
            : mk(r.market, r.url ?? undefined);
        const up = r.change > 0;
        return `<tr>
          <td>${itemCell(r.name, r.category)}</td>
          <td>${where}</td>
          <td class="num"><span class="muted">${usd(r.was)} →</span> <b>${usd(r.now)}</b></td>
          <td class="num chg-cell ${up ? 'up' : 'down'}">${up ? '▲ +' : '▼ −'}${pct(Math.abs(r.change))}</td>
          <td class="num">${int(r.volume)}</td>
        </tr>`;
      })
      .join('')}</tbody>`
  );
}

async function loadMovers(): Promise<void> {
  const form = $<HTMLFormElement>('#f-movers');
  const p = formParams(form);
  p.set('limit', '50');
  controllers.movers?.abort();
  const ctl = new AbortController();
  controllers.movers = ctl;
  const grid = $('.movers-grid');
  grid.style.opacity = '0.55';
  try {
    const m = await api<MoversResponse>(`/api/movers?${p}`, { signal: ctl.signal });
    const per = PERIOD_TEXT[m.period]!;
    const note = $('#movers-basis');
    if (m.basis === 'sales') {
      note.innerHTML =
        `Сравнивается <b>${per.sales}</b> (Skinport). ` +
        (p.get('basis') === 'sales'
          ? ''
          : m.coverageStart
            ? `Собственная история цен лотов ведётся с ${fmtDate(m.coverageStart)} — когда она станет длиннее ${per.label}, «Авто» переключится на неё.`
            : 'Собственная история цен лотов ещё не собрана.');
    } else if (m.since == null) {
      note.innerHTML = 'История цен лотов ещё не собрана — выберите «Продажи Skinport» или подождите, пока сервер сохранит первые снимки.';
    } else {
      const short = Date.now() - m.since < (m.period === '1d' ? 86_400_000 : m.period === '7d' ? 7 * 86_400_000 : 30 * 86_400_000) - 3_600_000;
      note.innerHTML = short
        ? `Сравнивается <b>минимальная цена лота сейчас</b> с ценой на ${fmtDate(m.since)} — это самый ранний снимок: истории пока меньше ${per.label}.`
        : `Сравнивается <b>минимальная цена лота сейчас</b> с ценой ${per.label} назад (${fmtDate(m.since)}).`;
    }
    $('#movers-count').innerHTML = `Изменилось больше порога: <b>${int(m.total)}</b> · показаны топ-50 в каждую сторону`;
    $('#t-up').innerHTML = moverRows(m.up, 'Нет подорожавших предметов с такими фильтрами.');
    $('#t-down').innerHTML = moverRows(m.down, 'Нет подешевевших предметов с такими фильтрами.');
  } catch (err) {
    if ((err as Error).name !== 'AbortError') toast(`Ошибка загрузки: ${(err as Error).message}`);
  } finally {
    grid.style.opacity = '';
  }
}

function wireMovers(): void {
  const form = $<HTMLFormElement>('#f-movers');
  const reload = debounce(() => void loadMovers(), 300);
  form.addEventListener('input', reload);
  form.addEventListener('change', reload);
  form.addEventListener('submit', (e) => e.preventDefault());
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a[data-export="movers"]')) {
    a.addEventListener('click', () => {
      const p = formParams(form);
      p.set('type', 'movers');
      p.set('format', a.dataset.format!);
      exportCurrency(p);
      a.href = `/api/export?${p}`;
    });
  }
}

// ── Compare ──────────────────────────────────────────────────────────────────

function bestQuote(it: Item): { market: MarketId; price: number } | null {
  let best: { market: MarketId; price: number } | null = null;
  for (const [m, q] of Object.entries(it.quotes) as [MarketId, Item['quotes'][MarketId]][]) {
    if (q && (!best || q.price < best.price)) best = { market: m, price: q.price };
  }
  return best;
}

/**
 * Search box with suggestions. Each option carries `data-<attr>`; the global click
 * handler routes data-open → comparison, data-card → skin card.
 */
function wireSuggest(inputSel: string, listSel: string, attr: 'open' | 'card', onPick: (name: string) => void): void {
  const input = $<HTMLInputElement>(inputSel);
  const list = $<HTMLUListElement>(listSel);
  let ctl: AbortController | undefined;
  let index = -1;

  const search = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) {
      list.hidden = true;
      return;
    }
    ctl?.abort();
    ctl = new AbortController();
    try {
      const items = await api<Item[]>(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctl.signal });
      index = -1;
      list.innerHTML = items.length
        ? items
            .map((it) => {
              const b = bestQuote(it);
              return `<li role="option" data-${attr}="${esc(it.name)}"><span>${esc(it.name)}</span><span class="p">${b ? 'от ' + usd(b.price) : ''}</span></li>`;
            })
            .join('')
        : '<li class="muted">Ничего не найдено</li>';
      list.hidden = false;
    } catch (err) {
      if ((err as Error).name !== 'AbortError') toast((err as Error).message);
    }
  }, 200);

  input.addEventListener('input', search);
  input.addEventListener('focus', () => {
    if (list.children.length) list.hidden = false;
  });
  input.addEventListener('keydown', (e) => {
    const opts = [...list.querySelectorAll<HTMLLIElement>(`li[data-${attr}]`)];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      index = Math.max(0, Math.min(opts.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)));
      opts.forEach((o, i) => o.setAttribute('aria-selected', String(i === index)));
      opts[index]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      const pick = opts[Math.max(index, 0)];
      if (pick) onPick(pick.dataset[attr]!);
    } else if (e.key === 'Escape') list.hidden = true;
  });
  document.addEventListener('click', (e) => {
    if (!(e.target as Element).closest('.search-box')) list.hidden = true;
  });
}

function wireCompare(): void {
  wireSuggest('#cmp-q', '#cmp-results', 'open', (n) => void openItem(n));
}

let currentItem: string | null = null;

async function openItem(name: string): Promise<void> {
  currentItem = name;
  switchTab('compare');
  $('#cmp-results').hidden = true;
  const card = $('#cmp-card');
  card.className = 'card';
  card.innerHTML = '<div class="loading-bar"></div>';
  try {
    const { item, links } = await api<{ item: Item; links: { label: string; url: string }[] }>(
      `/api/item?name=${encodeURIComponent(name)}`,
    );
    const quotes = (Object.keys(meta.markets) as MarketId[]).map((m) => ({ m, q: item.quotes[m] }));
    const prices = quotes.map((x) => x.q?.price).filter((x): x is number => x != null);
    const max = Math.max(...prices, 0.01);
    const min = Math.min(...prices);
    const spread = prices.length > 1 ? (max - min) / min : 0;
    const s = item.stats;
    const on = watchlist.has(item.name);
    card.innerHTML = `
      <div class="cmp-head">
        <span class="cat" title="${CAT_LABEL[item.category]}">${CAT_ABBR[item.category]}</span>
        <h2>${esc(item.name)}</h2>
        <button type="button" class="btn ghost" data-star="${esc(item.name)}">${on ? '★ В избранном' : '☆ В избранное'}</button>
      </div>
      <div class="stats">
        <div class="stat"><small>Лучшая цена</small><b class="up">${usd(prices.length ? min : null)}</b></div>
        <div class="stat"><small>Медиана продаж 7д</small><b>${usd(s?.median7d)}</b></div>
        <div class="stat"><small>Продаж 7д / 30д</small><b>${int(s?.volume7d ?? 0)} / ${int(s?.volume30d ?? 0)}</b></div>
        <div class="stat"><small>Разброс цен</small><b>${prices.length > 1 ? pct(spread) : '—'}</b></div>
      </div>
      <div class="bars">
        ${quotes
          .map(({ m, q }) => {
            const info = meta.markets[m];
            if (!q) {
              return `<div class="bar" style="--c:${info.color}">${mk(m)}<div class="track"></div><span class="price muted">нет лотов</span><span class="meta"></span></div>`;
            }
            const meta2 = q.count != null ? `${int(q.count)} лотов` : q.volume != null ? `объём ${int(q.volume)}` : '';
            return `<div class="bar${q.price === min ? ' best' : ''}" style="--c:${info.color}">
              ${mk(m, q.url)}
              <div class="track"><div class="fill" style="width:${((q.price / max) * 100).toFixed(1)}%"></div></div>
              <span class="price">${usd(q.price)}</span>
              <span class="meta">${meta2}</span>
            </div>`;
          })
          .join('')}
      </div>
      <section class="history">
        <div class="hist-head">
          <h2>История цен</h2>
          <div class="seg" role="group" aria-label="Период">
            ${RANGES.map(([v, l]) => `<button type="button" data-range="${v}" aria-pressed="${v === historyRange}">${l}</button>`).join('')}
          </div>
        </div>
        <div class="hist-changes" id="hist-changes"></div>
        <div id="cmp-chart" class="hist-chart"></div>
        <p class="hist-note" id="hist-note"></p>
        ${
          s
            ? `<div class="periods"><span>Медиана продаж Skinport:</span>
              ${[
                ['24ч', s.median24h, s.volume24h],
                ['7д', s.median7d, s.volume7d],
                ['30д', s.median30d, s.volume30d],
                ['90д', s.median90d ?? null, s.volume90d ?? null],
              ]
                .map(([l, m, v]) => `<span class="period"><small>${l}</small> <b>${usd(m as number | null)}</b> <em>${v == null ? '' : int(v as number) + ' прод.'}</em></span>`)
                .join('')}</div>`
            : ''
        }
      </section>
      <h2>Другие площадки</h2>
      <div class="links">${links
        .map((l) => `<a class="btn ghost" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`)
        .join('')}</div>`;
    const input = $<HTMLInputElement>('#cmp-q');
    if (input.value !== item.name) input.value = item.name;
    card.querySelector('.seg')!.addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLButtonElement>('[data-range]');
      if (!b) return;
      historyRange = b.dataset.range!;
      storage.set('sg.range', historyRange);
      for (const x of card.querySelectorAll('[data-range]')) x.setAttribute('aria-pressed', String(x === b));
      void loadHistory(item.name);
    });
    void loadHistory(item.name);
  } catch (err) {
    card.className = 'card empty';
    card.innerHTML = `<p>Не удалось загрузить предмет: ${esc((err as Error).message)}</p>`;
  }
}

// ── Price history ────────────────────────────────────────────────────────────

const RANGES: [string, string][] = [['1d', '24ч'], ['7d', '7д'], ['30d', '30д'], ['90d', '90д'], ['all', 'Всё']];
let historyRange = storage.get<string>('sg.range', '7d');
let chartCleanup: (() => void) | null = null;
let historyReq = 0;

function seriesInfo(key: string): { label: string; color: string; dashed: boolean } {
  if (key === 'sales') return { ...meta.sales, dashed: true };
  const m = meta.markets[key as MarketId];
  return { label: m.label, color: m.color, dashed: false };
}

async function loadHistory(name: string): Promise<void> {
  const req = ++historyReq;
  const box = document.querySelector<HTMLElement>('#cmp-chart');
  if (!box) return;
  box.classList.add('busy'); // keep the previous frame while refetching
  try {
    const hist = await api<HistoryResponse>(`/api/history?name=${encodeURIComponent(name)}&range=${historyRange}`);
    if (req !== historyReq) return;
    // convert to the display currency before plotting so the axis gets round ticks
    const f = factor();
    const series: ChartSeries[] = hist.series.map((s) => ({
      key: s.key,
      points: s.points.map(([t, v]) => [t, v * f] as [number, number]),
      ...seriesInfo(s.key),
    }));

    chartCleanup?.();
    chartCleanup = renderChart(box, series, {
      from: hist.from,
      to: hist.to,
      format: (v) => fmtCur(v),
      empty: 'Точек пока нет — первая появится после ближайшего обновления цен.',
    });

    // change over the visible period per series (first value in range → last)
    $('#hist-changes').innerHTML = series
      .filter((s) => s.points.length > 1)
      .map((s) => {
        const a = s.points[0]![1];
        const b = s.points[s.points.length - 1]![1];
        const d = (b - a) / a;
        const cls = Math.abs(d) < 0.0005 ? 'muted' : d > 0 ? 'up' : 'down';
        const sign = d > 0 ? '+' : d < 0 ? '−' : '';
        return `<span class="chg"><i style="--c:${s.color}"${s.dashed ? ' class="dashed"' : ''}></i>${esc(s.label)} <b class="${cls}">${sign}${pct(Math.abs(d))}</b></span>`;
      })
      .join('');

    const note = $('#hist-note');
    if (hist.firstAt == null) {
      note.textContent = 'История этого предмета только начинает собираться: сервер сохраняет цены раз в час, пока он запущен.';
    } else if (hist.firstAt > hist.from) {
      note.textContent = `Цены сохраняются с ${new Date(hist.firstAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })} — раньше этого момента данных нет. Точка пишется раз в час, если цена сдвинулась на 0,5 % и больше (иначе раз в 6 ч).`;
    } else {
      note.textContent = 'Ступенчатая линия: цена держится до следующей записанной точки.';
    }
  } catch (err) {
    if (req === historyReq) box.textContent = `Не удалось загрузить историю: ${(err as Error).message}`;
  } finally {
    box.classList.remove('busy');
  }
}

async function renderWatchlist(): Promise<void> {
  const ul = $('#watchlist');
  const names = watchlist.all();
  if (!names.length) {
    ul.innerHTML = '<li class="none">Нажмите ☆ рядом с предметом, чтобы следить за ценой.</li>';
    return;
  }
  const items = await Promise.all(
    names.map((n) =>
      api<{ item: Item }>(`/api/item?name=${encodeURIComponent(n)}`).then(
        (r) => r.item,
        () => null,
      ),
    ),
  );
  ul.innerHTML = names
    .map((n, i) => {
      const it = items[i];
      const b = it ? bestQuote(it) : null;
      return `<li data-open="${esc(n)}"><span title="${esc(n)}">${esc(n)}</span><span class="p">${b ? usd(b.price) : '—'}</span></li>`;
    })
    .join('');
}

// ── Skin card ────────────────────────────────────────────────────────────────

const LIQ: Record<Card['liquidity']['level'], { label: string; bars: number; cls: string; hint: string }> = {
  high: { label: 'Высокая', bars: 4, cls: 'up', hint: 'продаётся быстро, обычно в течение часов' },
  medium: { label: 'Средняя', bars: 3, cls: 'accent', hint: 'обычно продаётся за день-два' },
  low: { label: 'Низкая', bars: 2, cls: 'warn', hint: 'продажа может занять несколько дней' },
  'very-low': { label: 'Очень низкая', bars: 1, cls: 'down', hint: 'покупателей мало — продать быстро будет трудно' },
};

const signPct = (x: number | null | undefined): string =>
  x == null ? '—' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${pct(Math.abs(x))}`;
const signCls = (x: number | null | undefined): string => (x == null || Math.abs(x) < 0.0005 ? 'muted' : x > 0 ? 'up' : 'down');

function meter(level: Card['liquidity']['level']): string {
  const l = LIQ[level];
  return `<span class="meter ${l.cls}" aria-hidden="true">${[1, 2, 3, 4].map((i) => `<i${i <= l.bars ? ' class="on"' : ''}></i>`).join('')}</span>`;
}

let currentCard: string | null = null;
let cardReq = 0;

async function openCard(name: string): Promise<void> {
  currentCard = name;
  switchTab('card');
  $('#card-results').hidden = true;
  const view = $('#card-view');
  const req = ++cardReq;
  view.className = 'card';
  if (!view.querySelector('.kpis')) view.innerHTML = '<div class="loading-bar"></div>';
  else view.classList.add('busy');
  try {
    const { card, links } = await api<{ card: Card; links: { label: string; url: string }[] }>(
      `/api/card?name=${encodeURIComponent(name)}&fees=${encodeURIComponent(JSON.stringify(getFees()))}`,
    );
    if (req !== cardReq) return;
    const input = $<HTMLInputElement>('#card-q');
    if (input.value !== card.name) input.value = card.name;
    view.classList.remove('busy');
    view.innerHTML = renderCard(card, links);
  } catch (err) {
    if (req !== cardReq) return;
    view.className = 'card empty';
    view.innerHTML = `<p>Не удалось загрузить карточку: ${esc((err as Error).message)}</p>`;
  }
}

function renderCard(c: Card, links: { label: string; url: string }[]): string {
  const on = watchlist.has(c.name);
  const sell = c.bestSell;
  const liq = LIQ[c.liquidity.level];
  const walletBetter =
    c.bestAnySell && c.bestAnySell.walletOnly && (!sell || (c.bestAnySell.net ?? 0) > (sell.net ?? 0)) ? c.bestAnySell : null;
  const steamLine = c.steam
    ? `Steam: <b>${int(c.steam.volume24h)}</b> продаж за 24 ч, медиана <b>${usd(c.steam.median)}</b>`
    : 'Steam: живые данные сейчас недоступны (лимит запросов) — показана цена из фонового обхода';

  return `
    <div class="cmp-head">
      <span class="cat" title="${CAT_LABEL[c.category]}">${CAT_ABBR[c.category]}</span>
      <h2>${esc(c.name)}</h2>
      <button type="button" class="btn ghost" data-star="${esc(c.name)}">${on ? '★ В избранном' : '☆ В избранное'}</button>
      <button type="button" class="btn ghost" data-open="${esc(c.name)}">График и сравнение →</button>
    </div>

    <div class="kpis">
      <div class="kpi">
        <small>Стоит сейчас</small>
        <b>${usd(c.buy?.price)}</b>
        <span>${c.buy ? `${mk(c.buy.market)} · <a class="buy-link" href="${esc(c.buy.url)}" target="_blank" rel="noopener">Купить →</a>` : 'нет лотов'}</span>
      </div>
      <div class="kpi">
        <small>Можно продать за</small>
        <b>${usd(sell?.sellAt)}</b>
        <span>${sell ? `${mk(sell.market)} · на руки <b>${usd(sell.net)}</b>` : 'нет площадки для продажи'}</span>
      </div>
      <div class="kpi">
        <small>Процент</small>
        <b class="${signCls(sell?.profitPct)}">${signPct(sell?.profitPct)}</b>
        <span>${sell?.profit != null ? `${sell.profit >= 0 ? '+' : '−'}${usd(Math.abs(sell.profit))} с одной штуки` : '—'} · к медиане 7д <b class="${signCls(c.vsMedian == null ? null : -c.vsMedian)}">${signPct(c.vsMedian)}</b></span>
      </div>
      <div class="kpi">
        <small>Ликвидность</small>
        <b class="liq">${meter(c.liquidity.level)} ${liq.label}</b>
        <span>≈ ${c.liquidity.perDay.toLocaleString('ru-RU')} продаж в день · ${liq.hint}</span>
      </div>
    </div>

    ${
      walletBetter
        ? `<p class="basis-note">В Steam можно продать дороже: на руки <b>${usd(walletBetter.net)}</b>, но деньги останутся на балансе Steam — вывести их нельзя.</p>`
        : ''
    }

    <div class="table-wrap">
      <table class="grid compact card-table">
        <thead><tr>
          <th>Площадка</th><th class="num">Купить сейчас</th><th class="num">Лотов</th>
          <th class="num">Выставить за</th><th class="num">На руки</th><th class="num">Профит</th><th></th>
        </tr></thead>
        <tbody>${c.rows
          .map((r) => {
            const cls = [r.market === c.buy?.market ? 'best-buy' : '', r.market === sell?.market ? 'best-sell' : ''].join(' ').trim();
            const tags = [
              r.market === c.buy?.market ? '<span class="badge">дешевле всего</span>' : '',
              r.market === sell?.market ? '<span class="badge">выгоднее продать</span>' : '',
              r.walletOnly ? '<span class="badge warn" title="Деньги остаются на балансе Steam">баланс Steam</span>' : '',
            ].join(' ');
            return `<tr${cls ? ` class="${cls}"` : ''}>
              <td>${mk(r.market, r.url ?? undefined)}</td>
              <td class="num">${r.ask == null ? '<span class="muted">нет лотов</span>' : `<b>${usd(r.ask)}</b>`}</td>
              <td class="num">${int(r.listings)}</td>
              <td class="num">${usd(r.sellAt)}</td>
              <td class="num">${usd(r.net)}</td>
              <td class="num ${signCls(r.profitPct)}">${r.profit == null ? '—' : `${r.profit >= 0 ? '+' : '−'}${usd(Math.abs(r.profit))} <small>(${signPct(r.profitPct)})</small>`}</td>
              <td>${tags}</td>
            </tr>`;
          })
          .join('')}</tbody>
      </table>
    </div>

    <div class="liq-details">
      <span>${steamLine}</span>
      <span>Skinport: <b>${int(c.liquidity.skinport7d)}</b> продаж за 7 дн, <b>${int(c.liquidity.skinport30d)}</b> за 30 дн</span>
      <span>Медиана продаж 7д / 30д: <b>${usd(c.median7d)}</b> / <b>${usd(c.median30d)}</b></span>
      <span>Лотов на всех площадках: <b>${int(c.liquidity.listings)}</b> · разброс цен <b>${c.spreadPct == null ? '—' : pct(c.spreadPct)}</b></span>
    </div>

    <p class="hist-note">«Выставить за» — на 1 цент дешевле самого дешёвого лота площадки. «На руки» — после комиссии продажи
      (настраивается во вкладке «Комиссии»). Профит — против самой дешёвой покупки на другой площадке.</p>

    <h2>Другие площадки</h2>
    <div class="links">${links
      .map((l) => `<a class="btn ghost" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`)
      .join('')}</div>`;
}

let watchReq = 0;

async function renderCardWatch(): Promise<void> {
  const box = $('#card-watch');
  const names = watchlist.all().slice(0, 12);
  if (!names.length) {
    box.innerHTML = '<p class="muted">Нажмите ☆ у скина, и здесь появится его мини-карточка.</p>';
    return;
  }
  const req = ++watchReq;
  const fees = encodeURIComponent(JSON.stringify(getFees()));
  const cards = await Promise.all(
    names.map((n) =>
      api<{ card: Card }>(`/api/card?name=${encodeURIComponent(n)}&live=0&fees=${fees}`).then(
        (r) => r.card,
        () => null,
      ),
    ),
  );
  if (req !== watchReq) return;
  box.innerHTML = cards
    .map((c, i) => {
      if (!c) return `<div class="mini"><b>${esc(names[i]!)}</b><span class="muted">нет данных</span></div>`;
      const s = c.bestSell;
      const l = LIQ[c.liquidity.level];
      return `<button type="button" class="mini" data-card="${esc(c.name)}">
        <span class="mini-name">${esc(c.name)}</span>
        <span class="mini-row"><small>Стоит</small><b>${usd(c.buy?.price)}</b></span>
        <span class="mini-row"><small>Продать за</small><b>${usd(s?.sellAt)}</b></span>
        <span class="mini-row"><small>Процент</small><b class="${signCls(s?.profitPct)}">${signPct(s?.profitPct)}</b></span>
        <span class="mini-row"><small>Ликвидность</small><span>${meter(c.liquidity.level)} ${l.label}</span></span>
      </button>`;
    })
    .join('');
}

// ── Currency switch ─────────────────────────────────────────────────────────

function setCurrency(code: Currency, initial = false): void {
  const oldF = initial ? 1 : factor();
  cur.code = code;
  const newF = factor();
  // money filters are typed in the display currency — keep their value equivalent
  for (const inp of document.querySelectorAll<HTMLInputElement>('input[data-money]')) {
    const v = Number(inp.value.replace(',', '.'));
    if (inp.value.trim() === '' || !Number.isFinite(v)) continue;
    const next = (v / oldF) * newF;
    inp.value = String(newF > 1 ? Math.round(next) : Math.round(next * 100) / 100);
    inp.step = newF > 1 ? '1' : '0.01';
  }
  for (const s of document.querySelectorAll('.cur-sym')) s.textContent = code === 'RUB' ? '₽' : '$';
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-cur]')) {
    b.setAttribute('aria-pressed', String(b.dataset.cur === code));
  }
  storage.set('sg.cur', code);
  if (initial) return;
  rerender();
}

/** Re-render whatever is on screen (after a currency or rate change). */
function rerender(): void {
  loaded.clear();
  const tab = (location.hash.slice(1) as Tab) || 'deals';
  if (tab === 'card' && currentCard) void openCard(currentCard);
  else if (tab === 'compare' && currentItem) void openItem(currentItem);
  else switchTab(tab);
}

function rateInfo(): void {
  const r = meta.rate;
  const src = r.source === 'cbr' ? 'ЦБ РФ' : r.source === 'cache' ? 'ЦБ РФ (сохранённый)' : 'запасной, ЦБ недоступен';
  $('#rate-info').textContent =
    `Курс ${src} на ${new Date(r.date).toLocaleDateString('ru-RU')}: ${r.rate.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽. ` +
    'Оставьте поле пустым, чтобы использовать его; площадки в рублях часто считают по своему курсу.';
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-cur]')) {
    b.title = `1 $ = ${cur.rate.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;
  }
}

// ── Fees ─────────────────────────────────────────────────────────────────────

function renderFees(): void {
  const fees = getFees();
  $('#fees-body').innerHTML = (Object.keys(meta.markets) as MarketId[])
    .map(
      (m) => `<tr>
      <td>${mk(m)}</td>
      <td><input type="number" step="0.1" min="0" max="99" data-fee="${m}.sell" value="${+(fees[m].sell * 100).toFixed(2)}"></td>
      <td><input type="number" step="0.1" min="0" max="99" data-fee="${m}.buy" value="${+(fees[m].buy * 100).toFixed(2)}"></td>
    </tr>`,
    )
    .join('');
}

function wireFees(): void {
  $('#f-fees').addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    const [m, kind] = (el.dataset.fee ?? '').split('.') as [MarketId, 'sell' | 'buy'];
    if (!m || !kind) return;
    const fees = getFees();
    const v = Number(el.value);
    if (!Number.isFinite(v) || v < 0 || v >= 100) return;
    fees[m][kind] = v / 100;
    storage.set('sg.fees', fees);
  });
  const rateInput = $<HTMLInputElement>('#rate-input');
  const custom = storage.get<number | null>('sg.rate', null);
  if (custom) rateInput.value = String(custom);
  rateInput.placeholder = `по ЦБ: ${meta.rate.rate.toFixed(2)}`;
  rateInput.addEventListener(
    'input',
    debounce(() => {
      const v = Number(rateInput.value.replace(',', '.'));
      const valid = rateInput.value.trim() !== '' && v > 1;
      storage.set('sg.rate', valid ? v : null);
      cur.rate = valid ? v : meta.rate.rate;
      rateInfo();
      loaded.clear();
    }, 300),
  );
  rateInfo();

  $('#fees-reset').addEventListener('click', () => {
    storage.set('sg.fees', {});
    renderFees();
    toast('Комиссии сброшены к значениям по умолчанию');
  });
}

// ── Sources status ───────────────────────────────────────────────────────────

async function refreshStatus(force = false): Promise<void> {
  try {
    const st = await api<{ sources: SourceStatus[] }>(force ? '/api/refresh' : '/api/status', force ? { method: 'POST' } : undefined);
    $('#sources').innerHTML = st.sources
      .map((s) => {
        const cls = s.loading ? 'loading' : s.error && !s.fetchedAt ? 'err' : s.fetchedAt && Date.now() - s.fetchedAt > 20 * 60_000 ? 'stale' : '';
        const title = s.error ? `Ошибка: ${s.error}` : `Обновлено ${ago(s.fetchedAt)} назад`;
        return `<span class="src ${cls}" title="${esc(title)}"><i></i>${esc(s.label)} · ${int(s.count)} · ${ago(s.fetchedAt)}</span>`;
      })
      .join('');
  } catch {
    $('#sources').innerHTML = '<span class="src err"><i></i>сервер недоступен</span>';
  }
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

const loaded = new Set<Tab>();

function switchTab(tab: Tab): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  }
  for (const p of document.querySelectorAll<HTMLElement>('[data-panel]')) p.hidden = p.dataset.panel !== tab;
  if (location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`);
  // arbitrage depends on fees, so always reload it
  if (tab === 'deals' && !loaded.has(tab)) void loadTable('deals');
  if (tab === 'arbitrage') void loadTable('arbitrage');
  if (tab === 'movers') void loadMovers();
  if (tab === 'strategy') void loadStrategy();
  if (tab === 'card') void renderCardWatch();
  if (tab === 'compare') void renderWatchlist();
  if (tab === 'fees') renderFees();
  loaded.add(tab);
}

// ── Boot ─────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  meta = await api<Meta>('/api/meta');
  cur.rate = storage.get<number | null>('sg.rate', null) ?? meta.rate.rate;
  setCurrency(cur.code, true); // HTML defaults are in USD — convert if the user prefers roubles
  buildChips();
  wireTable('deals');
  wireTable('arbitrage');
  wireMovers();
  wireStrategy();
  wireCompare();
  wireSuggest('#card-q', '#card-results', 'card', (n) => void openCard(n));
  wireFees();
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-cur]')) {
    b.addEventListener('click', () => setCurrency(b.dataset.cur as Currency));
  }

  document.addEventListener('click', (e) => {
    const target = e.target as Element;
    const star = target.closest<HTMLElement>('[data-star]');
    if (star) {
      const name = star.dataset.star!;
      const added = watchlist.toggle(name);
      for (const s of document.querySelectorAll<HTMLElement>(`[data-star="${CSS.escape(name)}"]`)) {
        if (s.classList.contains('star')) {
          s.classList.toggle('on', added);
          s.textContent = added ? '★' : '☆';
        } else s.textContent = added ? '★ В избранном' : '☆ В избранное';
      }
      toast(added ? 'Добавлено в избранное' : 'Удалено из избранного');
      if (!$('[data-panel="compare"]').hidden) void renderWatchlist();
      if (!$('[data-panel="card"]').hidden) void renderCardWatch();
      return;
    }
    const cardEl = target.closest<HTMLElement>('[data-card]');
    if (cardEl) {
      void openCard(cardEl.dataset.card!);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const open = target.closest<HTMLElement>('[data-open]');
    if (open) void openItem(open.dataset.open!);
    const tab = target.closest<HTMLElement>('[data-tab]');
    if (tab) switchTab(tab.dataset.tab as Tab);
  });

  const btn = $<HTMLButtonElement>('#refresh');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    await refreshStatus(true);
    loaded.clear();
    switchTab((location.hash.slice(1) as Tab) || 'deals');
    btn.disabled = false;
    toast('Цены обновлены');
  });

  void refreshStatus();
  setInterval(() => void refreshStatus(), 30_000);

  const fromHash = (): Tab => {
    const h = location.hash.slice(1) as Tab;
    return TABS.includes(h) ? h : 'deals';
  };
  window.addEventListener('hashchange', () => switchTab(fromHash()));
  switchTab(fromHash());
}

void boot();
