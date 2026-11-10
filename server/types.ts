export type MarketId = 'skinport' | 'marketcsgo' | 'lisskins' | 'steam';

export const MARKET_IDS: readonly MarketId[] = ['skinport', 'marketcsgo', 'lisskins', 'steam'];

export interface Quote {
  market: MarketId;
  /** Lowest ask in USD */
  price: number;
  /** Number of listings, when the source reports it */
  count: number | null;
  /** Sales volume reported by the source (market.csgo only) */
  volume: number | null;
  url: string;
}

export interface NamedQuote extends Quote {
  name: string;
}

/** Realised sales on Skinport — the only free public sales history. */
export interface SalesStats {
  name: string;
  median24h: number | null;
  volume24h: number;
  median7d: number | null;
  avg7d: number | null;
  volume7d: number;
  median30d: number | null;
  volume30d: number;
  /** Absent in caches written before 90-day stats were collected */
  median90d?: number | null;
  volume90d?: number;
}

export type SeriesKey = MarketId | 'sales';

/** 'asks' = lowest listing now vs our stored snapshot; 'sales' = Skinport sale medians, recent vs longer window */
export type MoverBasis = 'asks' | 'sales';

export interface MoverRow {
  name: string;
  category: Category;
  market: SeriesKey;
  was: number;
  now: number;
  change: number;
  volume: number;
  url: string | null;
  /** Sales basis: today's lowest ask moved the same way (filters out float/sticker-premium spikes) */
  confirmed: boolean;
}

export interface MoversResponse {
  basis: MoverBasis;
  period: string;
  /** Moment the "was" price is taken from (asks basis), null for sales */
  since: number | null;
  /** Earliest snapshot in the history DB */
  coverageStart: number | null;
  up: MoverRow[];
  down: MoverRow[];
  total: number;
}

export interface HistoryResponse {
  name: string;
  from: number;
  to: number;
  series: { key: SeriesKey; points: [ts: number, price: number][] }[];
  /** Earliest snapshot stored for this item, null when none yet */
  firstAt: number | null;
}

export type Category =
  | 'knife'
  | 'gloves'
  | 'weapon'
  | 'sticker'
  | 'charm'
  | 'container'
  | 'agent'
  | 'patch'
  | 'music'
  | 'graffiti'
  | 'other';

export interface Item {
  name: string;
  category: Category;
  stattrak: boolean;
  souvenir: boolean;
  quotes: Partial<Record<MarketId, Quote>>;
  stats: SalesStats | null;
  suggested: number | null;
}

export interface Fees {
  /** Fraction taken from the sale price, e.g. 0.08 */
  sell: number;
  /** Extra cost on top of the buy price (deposit / payment fee) */
  buy: number;
}

export type FeeTable = Record<MarketId, Fees>;

export type RefKind = 'median7d' | 'cross' | 'suggested';

export interface DealRow {
  name: string;
  category: Category;
  market: MarketId;
  price: number;
  ref: number;
  refKind: RefKind;
  discount: number;
  count: number | null;
  volume7d: number;
  url: string;
  others: { market: MarketId; price: number }[];
}

export interface ArbRow {
  name: string;
  category: Category;
  buyMarket: MarketId;
  buyPrice: number;
  buyCost: number;
  buyUrl: string;
  sellMarket: MarketId;
  sellPrice: number;
  sellNet: number;
  sellUrl: string;
  profit: number;
  roi: number;
  volume7d: number;
  median7d: number | null;
  sellCount: number | null;
  suspicious: boolean;
  /** Selling here pays out to a non-withdrawable balance (Steam wallet) */
  walletOnly: boolean;
}

export interface SourceStatus {
  id: string;
  label: string;
  fetchedAt: number | null;
  count: number;
  error: string | null;
  loading: boolean;
}
