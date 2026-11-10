import type { FeeTable, MarketId } from './types.ts';

try {
  process.loadEnvFile();
} catch {
  // .env is optional
}

export const PORT = Number(process.env.PORT ?? 3000);
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim() || null;
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID?.trim() || null;

export interface MarketInfo {
  id: MarketId;
  label: string;
  color: string;
  site: string;
}

export const MARKETS: Record<MarketId, MarketInfo> = {
  // Categorical palette validated for the dark surface (CVD + normal-vision separation):
  // node scripts/validate_palette.js "#3987e5,#d95926,#199e70,#c98500,#d55181" --mode dark --surface "#14181e"
  skinport: { id: 'skinport', label: 'Skinport', color: '#d95926', site: 'https://skinport.com' },
  marketcsgo: { id: 'marketcsgo', label: 'Market.CSGO', color: '#3987e5', site: 'https://market.csgo.com' },
  lisskins: { id: 'lisskins', label: 'LIS-SKINS', color: '#199e70', site: 'https://lis-skins.com' },
  steam: { id: 'steam', label: 'Steam', color: '#d55181', site: 'https://steamcommunity.com/market' },
};

/** Money from Steam sales stays on the Steam wallet — it cannot be withdrawn. */
export const WALLET_ONLY: readonly MarketId[] = ['steam'];

/** How many of the most popular Steam items the background crawler keeps priced. */
export const STEAM_CRAWL_LIMIT = Number(process.env.STEAM_CRAWL_LIMIT ?? 5000);

/** Fourth chart series: realised Skinport sales (median of the last 24 h). Dashed. */
export const SALES_SERIES = { label: 'Продажи (медиана 24ч)', color: '#c98500' };

/**
 * Default seller / buyer fees. Площадки меняют комиссии — проверяйте актуальные
 * значения и правьте их на вкладке «Комиссии» (или флагом --fees в сканере).
 */
export const DEFAULT_FEES: FeeTable = {
  skinport: { sell: 0.08, buy: 0 },
  marketcsgo: { sell: 0.05, buy: 0 },
  lisskins: { sell: 0.1, buy: 0 },
  // buyer pays price; seller receives price / 1.15 (5 % Steam + 10 % CS2) ≈ 13.04 % of the price
  steam: { sell: 0.1304, buy: 0 },
};

/** Sites without a public bulk price API — compared through direct links. */
export function externalLinks(name: string): { label: string; url: string }[] {
  const q = encodeURIComponent(name);
  return [
    { label: 'CS.MONEY', url: `https://cs.money/market/buy/?search=${q}` },
    { label: 'CSFloat', url: `https://csfloat.com/search?market_hash_name=${q}` },
    { label: 'BUFF163', url: `https://buff.163.com/market/csgo#tab=selling&page_num=1&search=${q}` },
  ];
}
