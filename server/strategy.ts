import { parseFees } from './analytics.ts';
import { WALLET_ONLY } from './config.ts';
import { MARKET_IDS, type Category, type FeeTable, type Item, type MarketId } from './types.ts';

/**
 * Strategy builder: given a budget and constraints, pick the best buy→sell routes
 * ("связки") across all marketplaces and turn them into a concrete trade plan.
 *
 * Modes
 *  - cash       money → money: buy on a withdrawable market, sell on another one;
 *  - steam-out  Steam wallet → money: buy on Steam, sell where money can be withdrawn;
 *  - steam-in   money → Steam wallet: buy cheap on a market, sell on Steam.
 *
 * Method (transparent on purpose, so the trader can check every number):
 *  1. For every item take the best route allowed by the mode, after fees.
 *     Sell price = lowest ask − 1¢, capped by the 7-day sale median in "safe" mode.
 *  2. Drop illiquid items: expected time to sell must fit the horizon.
 *     Sales/day = Skinport 7-day sales / 7; we assume we capture `CAPTURE` of that flow.
 *  3. Rank by return per unit of money (net / cost), then fill the budget greedily,
 *     respecting quantity per skin and the max share of the budget per skin.
 */

export type StrategyMode = 'cash' | 'steam-out' | 'steam-in';

export interface StrategyOptions {
  mode: StrategyMode;
  /** USD */
  budget: number;
  fees: FeeTable;
  /** units of one skin */
  maxPerSkin: number;
  /** max fraction of the budget in one skin */
  maxShare: number;
  /** min sales per day (liquidity floor) */
  minPerDay: number;
  /** we want everything sold within this many days */
  horizonDays: number;
  /** days the bought item can't be traded (marketplace trade protection) */
  lockDays: number;
  sellMode: 'safe' | 'ask';
  /** cash / steam-in: min ROI; steam-out: ignored (ratio < 1 is normal there) */
  minRoi: number;
  /** USD, cash mode */
  minProfit: number;
  minPrice: number;
  categories: Category[];
  souvenir: boolean;
  markets: MarketId[];
  maxSteps: number;
}

export interface PlanStep {
  name: string;
  category: Category;
  buyMarket: MarketId;
  buyPrice: number;
  buyUrl: string;
  sellMarket: MarketId;
  sellAt: number;
  net: number;
  qty: number;
  cost: number;
  /** what lands on the sell side for all units */
  proceeds: number;
  profit: number;
  /** net / cost per unit: >1 = gain; for steam-out it's the withdrawal rate */
  ratio: number;
  perDay: number;
  daysToSell: number;
  median7d: number | null;
}

export interface RouteStat {
  buyMarket: MarketId;
  sellMarket: MarketId;
  /** items profitable on this route (1 unit each, all filters applied) */
  items: number;
  avgRatio: number;
  bestRatio: number;
  /** potential profit buying one unit of every such item */
  potential: number;
  /** what the plan actually uses */
  inPlan: number;
  planProfit: number;
  /** proceeds / cost of the plan's trades on this route (withdrawal rate for steam-out) */
  planRatio: number;
}

export interface Strategy {
  mode: StrategyMode;
  budget: number;
  spent: number;
  proceeds: number;
  profit: number;
  ratio: number;
  days: number;
  leftover: number;
  candidates: number;
  steps: PlanStep[];
  routes: RouteStat[];
  notes: string[];
}

/** Share of an item's daily sales we expect to capture as one more seller. */
const CAPTURE = 0.3;

type Params = { get(name: string): string | null };
const num = (p: Params, k: string, d: number): number => {
  const v = p.get(k);
  if (v == null || v === '') return d;
  const x = Number(v.replace(',', '.'));
  return Number.isFinite(x) ? x : d;
};

export function parseStrategyOptions(p: Params): StrategyOptions {
  const m = p.get('mode');
  const mode: StrategyMode = m === 'steam-out' || m === 'steam-in' ? m : 'cash';
  const mk = (p.get('markets') ?? '').split(',').filter((x): x is MarketId => (MARKET_IDS as readonly string[]).includes(x));
  const cats = (p.get('cat') ?? '').split(',').filter(Boolean) as Category[];
  return {
    mode,
    budget: Math.max(num(p, 'budget', 100), 0),
    fees: parseFees(p.get('fees')),
    maxPerSkin: Math.max(1, Math.trunc(num(p, 'maxPerSkin', 2))),
    maxShare: Math.min(Math.max(num(p, 'maxShare', 0.25), 0.01), 1),
    minPerDay: Math.max(num(p, 'minPerDay', 1), 0),
    horizonDays: Math.max(num(p, 'horizon', 7), 0.5),
    lockDays: Math.max(num(p, 'lockDays', 0), 0),
    sellMode: p.get('sellMode') === 'ask' ? 'ask' : 'safe',
    minRoi: num(p, 'minRoi', 0.03),
    minProfit: num(p, 'minProfit', 0.1),
    minPrice: num(p, 'minPrice', 0.5),
    categories: cats,
    souvenir: p.get('souvenir') !== '0',
    markets: mk.length ? mk : [...MARKET_IDS],
    maxSteps: Math.min(Math.max(Math.trunc(num(p, 'maxSteps', 40)), 1), 200),
  };
}

function sides(o: StrategyOptions): { buy: MarketId[]; sell: MarketId[] } {
  const cash = o.markets.filter((m) => !WALLET_ONLY.includes(m));
  const wallet = o.markets.filter((m) => WALLET_ONLY.includes(m));
  if (o.mode === 'steam-out') return { buy: wallet, sell: cash };
  if (o.mode === 'steam-in') return { buy: cash, sell: wallet };
  return { buy: cash, sell: cash };
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

interface Candidate {
  item: Item;
  buyMarket: MarketId;
  buyPrice: number;
  cost: number;
  sellMarket: MarketId;
  sellAt: number;
  net: number;
  ratio: number;
  perDay: number;
}

/** Best allowed route for every item (1 unit). */
function candidates(items: Item[], o: StrategyOptions): { all: Candidate[]; byRoute: Map<string, Candidate[]> } {
  const { buy, sell } = sides(o);
  const all: Candidate[] = [];
  const byRoute = new Map<string, Candidate[]>();
  for (const it of items) {
    if (o.categories.length && !o.categories.includes(it.category)) continue;
    if (!o.souvenir && it.souvenir) continue;
    const perDay = (it.stats?.volume7d ?? 0) / 7;
    if (perDay < o.minPerDay) continue;
    // one unit must sell within the horizon
    if (1 / (perDay * CAPTURE) > o.horizonDays) continue;
    const med = it.stats?.median7d ?? null;
    let best: Candidate | null = null;
    for (const bm of buy) {
      const bq = it.quotes[bm];
      if (!bq || bq.price < o.minPrice) continue;
      const cost = bq.price * (1 + o.fees[bm].buy);
      for (const sm of sell) {
        if (sm === bm) continue;
        const sq = it.quotes[sm];
        if (!sq || (sq.count != null && sq.count <= 1)) continue; // a lone listing is not a market price
        let sellAt = sq.price - 0.01;
        if (o.sellMode === 'safe' && med) sellAt = Math.min(sellAt, med);
        if (sellAt <= 0) continue;
        const net = sellAt * (1 - o.fees[sm].sell);
        const ratio = net / cost;
        // guard against data glitches (rare floats, stale asks)
        if (ratio > 2 || ratio < 0.5) continue;
        if (o.mode !== 'steam-out') {
          if (ratio - 1 < o.minRoi) continue;
          if (o.mode === 'cash' && net - cost < o.minProfit) continue;
        }
        const c: Candidate = { item: it, buyMarket: bm, buyPrice: bq.price, cost, sellMarket: sm, sellAt, net, ratio, perDay };
        const key = `${bm}>${sm}`;
        const arr = byRoute.get(key) ?? [];
        arr.push(c);
        byRoute.set(key, arr);
        if (!best || c.ratio > best.ratio) best = c;
      }
    }
    if (best) all.push(best);
  }
  // most money back per unit first; liquidity breaks ties
  all.sort((a, b) => b.ratio - a.ratio || b.perDay - a.perDay);
  return { all, byRoute };
}

export function buildStrategy(items: Item[], o: StrategyOptions): Strategy {
  const { all, byRoute } = candidates(items, o);
  const steps: PlanStep[] = [];
  let left = o.budget;
  const perSkinCap = o.budget * o.maxShare;

  for (const c of all) {
    if (steps.length >= o.maxSteps || left < o.minPrice) break;
    const listings = c.item.quotes[c.buyMarket]?.count ?? Infinity;
    // demand limit: units we can expect to sell within the horizon
    const demand = Math.floor(c.perDay * CAPTURE * o.horizonDays);
    const qty = Math.min(
      o.maxPerSkin,
      listings,
      Math.max(demand, 1),
      Math.floor(Math.min(left, perSkinCap) / c.cost),
    );
    if (qty < 1) continue;
    const cost = c.cost * qty;
    left -= cost;
    steps.push({
      name: c.item.name,
      category: c.item.category,
      buyMarket: c.buyMarket,
      buyPrice: c.buyPrice,
      buyUrl: c.item.quotes[c.buyMarket]?.url ?? '',
      sellMarket: c.sellMarket,
      sellAt: r2(c.sellAt),
      net: r2(c.net),
      qty,
      cost: r2(cost),
      proceeds: r2(c.net * qty),
      profit: r2((c.net - c.cost) * qty),
      ratio: Math.round(c.ratio * 10_000) / 10_000,
      perDay: Math.round(c.perDay * 10) / 10,
      daysToSell: Math.round((qty / (c.perDay * CAPTURE)) * 10) / 10,
      median7d: c.item.stats?.median7d ?? null,
    });
  }

  const spent = steps.reduce((s, x) => s + x.cost, 0);
  const proceeds = steps.reduce((s, x) => s + x.proceeds, 0);
  const days = steps.length ? o.lockDays + Math.max(...steps.map((s) => s.daysToSell)) : 0;

  const routes: RouteStat[] = [...byRoute.entries()]
    .map(([key, list]) => {
      const [buyMarket, sellMarket] = key.split('>') as [MarketId, MarketId];
      const inPlan = steps.filter((s) => s.buyMarket === buyMarket && s.sellMarket === sellMarket);
      const planCost = inPlan.reduce((s, x) => s + x.cost, 0);
      const planProceeds = inPlan.reduce((s, x) => s + x.proceeds, 0);
      return {
        buyMarket,
        sellMarket,
        items: list.length,
        avgRatio: Math.round((list.reduce((s, c) => s + c.ratio, 0) / list.length) * 10_000) / 10_000,
        bestRatio: Math.round(Math.max(...list.map((c) => c.ratio)) * 10_000) / 10_000,
        potential: r2(list.reduce((s, c) => s + (c.net - c.cost), 0)),
        inPlan: inPlan.length,
        planProfit: r2(inPlan.reduce((s, x) => s + x.profit, 0)),
        planRatio: planCost ? Math.round((planProceeds / planCost) * 10_000) / 10_000 : 0,
      };
    })
    // routes used by the plan first; "best" = most money for cash/steam-in, best rate for steam-out
    .sort(
      (a, b) =>
        Number(b.inPlan > 0) - Number(a.inPlan > 0) ||
        (o.mode === 'steam-out' ? b.planRatio - a.planRatio : b.planProfit - a.planProfit) ||
        b.avgRatio - a.avgRatio,
    );

  return {
    mode: o.mode,
    budget: o.budget,
    spent: r2(spent),
    proceeds: r2(proceeds),
    profit: r2(proceeds - spent),
    ratio: spent ? Math.round((proceeds / spent) * 10_000) / 10_000 : 0,
    days: Math.round(days * 10) / 10,
    leftover: r2(o.budget - spent),
    candidates: all.length,
    steps,
    routes,
    notes: [],
  };
}
