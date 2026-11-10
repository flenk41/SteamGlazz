import { WALLET_ONLY } from './config.ts';
import type { SteamOverview } from './steam.ts';
import { MARKET_IDS, type Category, type FeeTable, type Item, type MarketId } from './types.ts';

/**
 * "Skin card": everything a trader asks about one item —
 * what it costs now, what it can be sold for (and what lands in your pocket),
 * the percentage between them and how liquid it is.
 */

export interface CardRow {
  market: MarketId;
  /** lowest listing now */
  ask: number | null;
  listings: number | null;
  /** price to list at to be the cheapest: ask − undercut */
  sellAt: number | null;
  /** what you receive after the seller fee */
  net: number | null;
  /** net vs cheapest purchase on another market */
  profit: number | null;
  profitPct: number | null;
  walletOnly: boolean;
  url: string | null;
}

export type LiquidityLevel = 'high' | 'medium' | 'low' | 'very-low';

export interface Card {
  name: string;
  category: Category;
  buy: { market: MarketId; price: number; cost: number; url: string } | null;
  /** best place to sell for withdrawable money */
  bestSell: CardRow | null;
  /** best overall, may be the Steam wallet */
  bestAnySell: CardRow | null;
  rows: CardRow[];
  median7d: number | null;
  median30d: number | null;
  /** cheapest ask vs 7-day median: negative = below the usual price */
  vsMedian: number | null;
  spreadPct: number | null;
  liquidity: {
    level: LiquidityLevel;
    perDay: number;
    steam24h: number | null;
    skinport7d: number;
    skinport30d: number;
    listings: number;
  };
  steam: SteamOverview | null;
}

const round = (x: number, d = 2): number => Math.round(x * 10 ** d) / 10 ** d;

export function buildCard(it: Item, fees: FeeTable, steam: SteamOverview | null, undercut = 0.01): Card {
  const ask = (m: MarketId): number | null =>
    m === 'steam' && steam?.lowest ? steam.lowest : (it.quotes[m]?.price ?? null);

  const buys = MARKET_IDS.map((m) => ({ m, p: ask(m) }))
    .filter((x): x is { m: MarketId; p: number } => x.p != null)
    .map((x) => ({ ...x, cost: x.p * (1 + fees[x.m].buy) }))
    .sort((a, b) => a.cost - b.cost);
  const cheapest = buys[0];

  const rows: CardRow[] = MARKET_IDS.map((m) => {
    const a = ask(m);
    const q = it.quotes[m];
    const sellAt = a != null ? Math.max(a - undercut, 0.01) : null;
    const net = sellAt != null ? sellAt * (1 - fees[m].sell) : null;
    // compare with the cheapest purchase elsewhere — buying and selling on the same market is pointless
    const buyElsewhere = buys.find((b) => b.m !== m);
    const profit = net != null && buyElsewhere ? net - buyElsewhere.cost : null;
    return {
      market: m,
      ask: a,
      listings: q?.count ?? null,
      sellAt: sellAt != null ? round(sellAt) : null,
      net: net != null ? round(net) : null,
      profit: profit != null ? round(profit) : null,
      profitPct: profit != null && buyElsewhere ? round(profit / buyElsewhere.cost, 4) : null,
      walletOnly: WALLET_ONLY.includes(m),
      url: q?.url ?? null,
    };
  });

  const byNet = rows.filter((r) => r.net != null).sort((a, b) => b.net! - a.net!);
  const prices = buys.map((b) => b.p);
  const med = it.stats?.median7d ?? null;

  const skinport7d = it.stats?.volume7d ?? 0;
  const steam24h = steam?.volume24h ?? null;
  const perDay = (steam24h ?? 0) + skinport7d / 7;
  const level: LiquidityLevel = perDay >= 20 ? 'high' : perDay >= 3 ? 'medium' : perDay >= 0.3 ? 'low' : 'very-low';

  return {
    name: it.name,
    category: it.category,
    buy: cheapest
      ? { market: cheapest.m, price: cheapest.p, cost: round(cheapest.cost), url: it.quotes[cheapest.m]?.url ?? '' }
      : null,
    bestSell: byNet.find((r) => !r.walletOnly) ?? null,
    bestAnySell: byNet[0] ?? null,
    rows,
    median7d: med,
    median30d: it.stats?.median30d ?? null,
    vsMedian: cheapest && med ? round(cheapest.p / med - 1, 4) : null,
    spreadPct: prices.length > 1 ? round(Math.max(...prices) / Math.min(...prices) - 1, 4) : null,
    liquidity: {
      level,
      perDay: round(perDay, 1),
      steam24h,
      skinport7d,
      skinport30d: it.stats?.volume30d ?? 0,
      listings: rows.reduce((s, r) => s + (r.listings ?? 0), 0),
    },
    steam,
  };
}
