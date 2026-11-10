import { DEFAULT_FEES, WALLET_ONLY } from './config.ts';
import {
  MARKET_IDS,
  type ArbRow,
  type Category,
  type DealRow,
  type FeeTable,
  type Item,
  type MarketId,
  type MoverBasis,
  type MoverRow,
  type RefKind,
  type SalesStats,
} from './types.ts';

// ── Shared filters ───────────────────────────────────────────────────────────

export interface BaseFilter {
  q: string;
  categories: Category[];
  stattrak: 'any' | 'only' | 'no';
  souvenir: boolean;
  minPrice: number;
  maxPrice: number;
  /** Minimum Skinport sales in the last 7 days — liquidity proxy */
  minVolume: number;
  sort: string;
  dir: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export interface DealOptions extends BaseFilter {
  markets: MarketId[];
  minDiscount: number;
  ref: 'auto' | RefKind;
}

export interface ArbOptions extends BaseFilter {
  buy: MarketId[];
  sell: MarketId[];
  fees: FeeTable;
  minProfit: number;
  minRoi: number;
  /** ROI above this is flagged as likely bad data / trade-locked / rare float */
  maxRoi: number;
  hideSuspicious: boolean;
  /** 'ask' = sell at the lowest ask minus undercut, 'safe' = also cap at the 7-day median */
  sellMode: 'ask' | 'safe';
  undercut: number;
}

type Params = { get(name: string): string | null };

const n = (p: Params, k: string, d: number): number => {
  const v = p.get(k);
  if (v == null || v === '') return d;
  const x = Number(v.replace(',', '.'));
  return Number.isFinite(x) ? x : d;
};

const markets = (p: Params, k: string): MarketId[] => {
  const v = p.get(k);
  if (!v) return [...MARKET_IDS];
  const set = v.split(',').filter((m): m is MarketId => (MARKET_IDS as readonly string[]).includes(m));
  return set.length ? set : [...MARKET_IDS];
};

const CATEGORIES: Category[] = [
  'knife', 'gloves', 'weapon', 'sticker', 'charm', 'container', 'agent', 'patch', 'music', 'graffiti', 'other',
];

function parseBase(p: Params, defaultSort: string): BaseFilter {
  const cats = (p.get('cat') ?? '').split(',').filter((c): c is Category => CATEGORIES.includes(c as Category));
  const st = p.get('stattrak');
  return {
    q: (p.get('q') ?? '').trim().toLowerCase(),
    categories: cats,
    stattrak: st === 'only' || st === 'no' ? st : 'any',
    souvenir: p.get('souvenir') !== '0',
    minPrice: n(p, 'minPrice', 0.5),
    maxPrice: n(p, 'maxPrice', 1_000_000),
    minVolume: n(p, 'minVolume', 5),
    sort: p.get('sort') || defaultSort,
    dir: p.get('dir') === 'asc' ? 'asc' : 'desc',
    limit: Math.min(Math.max(Math.trunc(n(p, 'limit', 200)), 1), 5000),
    offset: Math.max(Math.trunc(n(p, 'offset', 0)), 0),
  };
}

export function parseDealOptions(p: Params): DealOptions {
  const ref = p.get('ref');
  return {
    ...parseBase(p, 'discount'),
    markets: markets(p, 'markets'),
    minDiscount: n(p, 'minDiscount', 0.1),
    ref: ref === 'median7d' || ref === 'cross' || ref === 'suggested' ? ref : 'auto',
  };
}

export function parseFees(raw: string | null): FeeTable {
  const fees: FeeTable = structuredClone(DEFAULT_FEES);
  if (!raw) return fees;
  try {
    const obj = JSON.parse(raw) as Record<string, { sell?: unknown; buy?: unknown }>;
    for (const m of MARKET_IDS) {
      const f = obj[m];
      if (!f) continue;
      const sell = Number(f.sell);
      const buy = Number(f.buy);
      if (Number.isFinite(sell) && sell >= 0 && sell < 1) fees[m].sell = sell;
      if (Number.isFinite(buy) && buy >= 0 && buy < 1) fees[m].buy = buy;
    }
  } catch {
    // keep defaults
  }
  return fees;
}

export function parseArbOptions(p: Params): ArbOptions {
  return {
    ...parseBase(p, 'profit'),
    buy: markets(p, 'buy'),
    sell: markets(p, 'sell'),
    fees: parseFees(p.get('fees')),
    minProfit: n(p, 'minProfit', 0.3),
    minRoi: n(p, 'minRoi', 0.03),
    maxRoi: n(p, 'maxRoi', 1),
    hideSuspicious: p.get('hideSuspicious') === '1',
    sellMode: p.get('sellMode') === 'ask' ? 'ask' : 'safe',
    undercut: n(p, 'undercut', 0.01),
  };
}

function passesBase(it: Item, f: BaseFilter): boolean {
  if (f.q && !it.name.toLowerCase().includes(f.q)) return false;
  if (f.categories.length && !f.categories.includes(it.category)) return false;
  if (f.stattrak === 'only' && !it.stattrak) return false;
  if (f.stattrak === 'no' && it.stattrak) return false;
  if (!f.souvenir && it.souvenir) return false;
  if ((it.stats?.volume7d ?? 0) < f.minVolume) return false;
  return true;
}

function sortPage<T>(rows: T[], f: BaseFilter): { total: number; rows: T[] } {
  const key = f.sort as keyof T;
  const sign = f.dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const x = a[key];
    const y = b[key];
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
    return String(x ?? '').localeCompare(String(y ?? '')) * sign;
  });
  return { total: rows.length, rows: rows.slice(f.offset, f.offset + f.limit) };
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const round = (x: number, d = 2): number => Math.round(x * 10 ** d) / 10 ** d;

// ── Deals: listings priced below what the item usually sells for ────────────

function reference(it: Item, market: MarketId, mode: DealOptions['ref']): { ref: number; kind: RefKind } | null {
  const med = it.stats?.median7d ?? null;
  const cross = median(
    MARKET_IDS.filter((m) => m !== market)
      .map((m) => it.quotes[m]?.price)
      .filter((x): x is number => x != null),
  );
  if (mode === 'median7d') return med ? { ref: med, kind: 'median7d' } : null;
  if (mode === 'cross') return cross ? { ref: cross, kind: 'cross' } : null;
  if (mode === 'suggested') return it.suggested ? { ref: it.suggested, kind: 'suggested' } : null;
  // auto: realised sales beat asks; asks beat Skinport's "suggested" estimate
  if (med && (it.stats?.volume7d ?? 0) >= 3) return { ref: med, kind: 'median7d' };
  if (cross) return { ref: cross, kind: 'cross' };
  if (it.suggested) return { ref: it.suggested, kind: 'suggested' };
  return null;
}

export function computeDeals(items: Item[], o: DealOptions): { total: number; rows: DealRow[] } {
  const rows: DealRow[] = [];
  for (const it of items) {
    if (!passesBase(it, o)) continue;
    for (const m of o.markets) {
      const q = it.quotes[m];
      if (!q || q.price < o.minPrice || q.price > o.maxPrice) continue;
      const r = reference(it, m, o.ref);
      if (!r) continue;
      const discount = (r.ref - q.price) / r.ref;
      if (discount < o.minDiscount) continue;
      rows.push({
        name: it.name,
        category: it.category,
        market: m,
        price: q.price,
        ref: round(r.ref),
        refKind: r.kind,
        discount: round(discount, 4),
        count: q.count,
        volume7d: it.stats?.volume7d ?? 0,
        url: q.url,
        others: MARKET_IDS.filter((x) => x !== m && it.quotes[x]).map((x) => ({ market: x, price: it.quotes[x]!.price })),
      });
    }
  }
  return sortPage(rows, o);
}

// ── Arbitrage: buy on market A, list on market B, profit after fees ──────────

export function computeArbitrage(items: Item[], o: ArbOptions): { total: number; rows: ArbRow[] } {
  const rows: ArbRow[] = [];
  for (const it of items) {
    if (!passesBase(it, o)) continue;
    const med = it.stats?.median7d ?? null;
    for (const bm of o.buy) {
      const bq = it.quotes[bm];
      if (!bq || bq.price < o.minPrice || bq.price > o.maxPrice) continue;
      const buyCost = bq.price * (1 + o.fees[bm].buy);
      for (const sm of o.sell) {
        if (sm === bm) continue;
        const sq = it.quotes[sm];
        if (!sq) continue;
        let sellPrice = sq.price - o.undercut;
        if (o.sellMode === 'safe' && med) sellPrice = Math.min(sellPrice, med);
        if (sellPrice <= 0) continue;
        const sellNet = sellPrice * (1 - o.fees[sm].sell);
        const profit = sellNet - buyCost;
        const roi = profit / buyCost;
        if (profit < o.minProfit || roi < o.minRoi) continue;
        const suspicious = roi > o.maxRoi || (sq.count != null && sq.count <= 1);
        if (suspicious && o.hideSuspicious) continue;
        rows.push({
          name: it.name,
          category: it.category,
          buyMarket: bm,
          buyPrice: bq.price,
          buyCost: round(buyCost),
          buyUrl: bq.url,
          sellMarket: sm,
          sellPrice: round(sellPrice),
          sellNet: round(sellNet),
          sellUrl: sq.url,
          profit: round(profit),
          roi: round(roi, 4),
          volume7d: it.stats?.volume7d ?? 0,
          median7d: med,
          sellCount: sq.count ?? sq.volume,
          suspicious,
          walletOnly: WALLET_ONLY.includes(sm),
        });
      }
    }
  }
  return sortPage(rows, o);
}

// ── Movers: biggest price changes over a period ─────────────────────────────

export type MoverPeriod = '1d' | '7d' | '30d';
export const PERIOD_MS: Record<MoverPeriod, number> = { '1d': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };

export interface MoverOptions extends BaseFilter {
  basis: 'auto' | MoverBasis;
  period: MoverPeriod;
  markets: MarketId[];
  /** Ignore moves smaller than this fraction */
  minChange: number;
  /** Sales basis: minimum sales in the recent window */
  minSales: number;
  /** Sales basis: keep only moves the current lowest ask agrees with */
  onlyConfirmed: boolean;
}

export function parseMoverOptions(p: Params): MoverOptions {
  const basis = p.get('basis');
  const period = p.get('period');
  return {
    ...parseBase(p, 'change'),
    basis: basis === 'asks' || basis === 'sales' ? basis : 'auto',
    period: period === '7d' || period === '30d' ? period : '1d',
    markets: markets(p, 'markets'),
    minChange: n(p, 'minChange', 0.02),
    minSales: n(p, 'minSales', 3),
    onlyConfirmed: p.get('confirmed') !== '0',
    limit: Math.min(Math.max(Math.trunc(n(p, 'limit', 50)), 1), 1000),
  };
}

/** Recent vs longer Skinport sale-median window for each period. */
const SALES_WINDOWS: Record<MoverPeriod, (s: SalesStats) => { now: number | null; was: number | null; vol: number }> = {
  '1d': (s) => ({ now: s.median24h, was: s.median7d, vol: s.volume24h }),
  '7d': (s) => ({ now: s.median7d, was: s.median30d, vol: s.volume7d }),
  '30d': (s) => ({ now: s.median30d, was: s.median90d ?? null, vol: s.volume30d }),
};

export function computeMovers(
  items: Item[],
  o: MoverOptions,
  basis: MoverBasis,
  past: Map<string, number> | null,
): { up: MoverRow[]; down: MoverRow[]; total: number } {
  const rows: MoverRow[] = [];
  for (const it of items) {
    if (!passesBase(it, o)) continue;
    if (basis === 'sales') {
      if (!it.stats) continue;
      const w = SALES_WINDOWS[o.period](it.stats);
      if (w.now == null || w.was == null || w.vol < o.minSales) continue;
      if (w.now < o.minPrice || w.now > o.maxPrice) continue;
      const change = w.now / w.was - 1;
      if (Math.abs(change) < o.minChange) continue;
      // A few premium sales (rare float, stickers) can drag a median up while the
      // cheapest listings stay put — require the lowest ask to agree with the direction.
      const asks = MARKET_IDS.map((m) => it.quotes[m]?.price).filter((x): x is number => x != null);
      const best = asks.length ? Math.min(...asks) : null;
      const confirmed = best != null && (change > 0 ? best >= w.was : best <= w.was);
      if (o.onlyConfirmed && !confirmed) continue;
      rows.push({
        name: it.name, category: it.category, market: 'sales', was: w.was, now: w.now,
        change: round(change, 4), volume: w.vol, url: it.quotes.skinport?.url ?? null, confirmed,
      });
      continue;
    }
    for (const m of o.markets) {
      const q = it.quotes[m];
      const was = past?.get(`${it.name}\n${m}`);
      if (!q || !was || q.price < o.minPrice || q.price > o.maxPrice) continue;
      const change = q.price / was - 1;
      if (Math.abs(change) < o.minChange) continue;
      rows.push({
        name: it.name, category: it.category, market: m, was, now: q.price,
        change: round(change, 4), volume: it.stats?.volume7d ?? 0, url: q.url, confirmed: true,
      });
    }
  }
  const up = rows.filter((r) => r.change > 0).sort((a, b) => b.change - a.change);
  const down = rows.filter((r) => r.change < 0).sort((a, b) => a.change - b.change);
  return { up: up.slice(0, o.limit), down: down.slice(0, o.limit), total: rows.length };
}

// ── Search for the comparison page ──────────────────────────────────────────

export function searchItems(items: Item[], q: string, limit = 50): Item[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const out: Item[] = [];
  for (const it of items) {
    const name = it.name.toLowerCase();
    if (terms.every((t) => name.includes(t))) out.push(it);
  }
  out.sort((a, b) => (b.stats?.volume30d ?? 0) - (a.stats?.volume30d ?? 0));
  return out.slice(0, limit);
}

// ── Export ───────────────────────────────────────────────────────────────────

/** CSV that opens correctly in Excel with Russian locale (';' + decimal comma + BOM). */
export function toCsv(rows: Record<string, unknown>[], excelRu = true): string {
  if (!rows.length) return '';
  const sep = excelRu ? ';' : ',';
  const cols = Object.keys(rows[0]!).filter((k) => k !== 'others');
  const cell = (v: unknown): string => {
    if (v == null) return '';
    let s = typeof v === 'number' && excelRu ? String(v).replace('.', ',') : String(v);
    if (s.includes(sep) || /["\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [cols.join(sep), ...rows.map((r) => cols.map((c) => cell(r[c])).join(sep))];
  return (excelRu ? '﻿' : '') + lines.join('\r\n');
}
