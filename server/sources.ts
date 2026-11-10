import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import type { NamedQuote, SalesStats } from './types.ts';

const UA = 'SteamGlazz/0.1 (+price scanner)';
const run = promisify(execFile);

/**
 * Some APIs (Skinport) sit behind a Cloudflare rule that rejects Node's TLS client,
 * while ordinary HTTP clients such as curl are fine. Fall back to the system curl
 * and decode brotli ourselves (Windows' bundled curl has no brotli support).
 */
async function curlJson(url: string): Promise<unknown> {
  const { stdout } = await run(
    'curl',
    ['-s', '-S', '-f', '-m', '90', '-A', UA, '-H', 'Accept: application/json', '-H', 'Accept-Encoding: br', url],
    { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024, windowsHide: true },
  );
  let body: Buffer = stdout;
  if (body[0] === 0x1f && body[1] === 0x8b) body = gunzipSync(body);
  else if (body[0] !== 0x7b && body[0] !== 0x5b) body = brotliDecompressSync(body); // not '{' / '['
  return JSON.parse(body.toString('utf8'));
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Encoding': 'br, gzip, deflate' },
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 403 && res.headers.get('server') === 'cloudflare') {
    await res.body?.cancel();
    try {
      return await curlJson(url);
    } catch (err) {
      throw new Error(`HTTP 403 (Cloudflare), curl тоже не смог: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  return res.json();
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

export interface SourceDef<T> {
  id: string;
  label: string;
  /** How long fetched data stays fresh */
  ttlMs: number;
  load(): Promise<T[]>;
}

// ── Skinport ─────────────────────────────────────────────────────────────────
// Public API, cached on their side for 5 min, limit 8 requests / 5 min.
// https://docs.skinport.com/items

interface SkinportItem {
  market_hash_name: string;
  version: string | null;
  min_price: number | null;
  quantity: number;
  item_page: string;
  suggested_price: number | null;
}

export const skinportSuggested = new Map<string, number>();

export const skinport: SourceDef<NamedQuote> = {
  id: 'skinport',
  label: 'Skinport — лоты',
  ttlMs: 5 * 60_000,
  async load() {
    const data = (await fetchJson('https://api.skinport.com/v1/items?app_id=730&currency=USD&tradable=0')) as SkinportItem[];
    const out: NamedQuote[] = [];
    skinportSuggested.clear();
    for (const it of data) {
      if (it.version) continue; // Doppler phases etc. — no equivalent on other markets
      if (it.suggested_price) skinportSuggested.set(it.market_hash_name, it.suggested_price);
      if (it.min_price == null || it.quantity <= 0) continue;
      out.push({
        name: it.market_hash_name,
        market: 'skinport',
        price: it.min_price,
        count: it.quantity,
        volume: null,
        url: it.item_page,
      });
    }
    return out;
  },
};

interface SkinportPeriod {
  median: number | null;
  avg: number | null;
  volume: number;
}
interface SkinportHistory {
  market_hash_name: string;
  version: string | null;
  last_24_hours: SkinportPeriod;
  last_7_days: SkinportPeriod;
  last_30_days: SkinportPeriod;
  last_90_days: SkinportPeriod;
}

export const skinportHistory: SourceDef<SalesStats> = {
  id: 'skinport-history',
  label: 'Skinport — продажи',
  ttlMs: 15 * 60_000,
  async load() {
    const data = (await fetchJson('https://api.skinport.com/v1/sales/history?app_id=730&currency=USD')) as SkinportHistory[];
    const out: SalesStats[] = [];
    for (const it of data) {
      if (it.version || it.last_30_days.volume === 0) continue;
      out.push({
        name: it.market_hash_name,
        median24h: it.last_24_hours.median,
        volume24h: it.last_24_hours.volume,
        median7d: it.last_7_days.median,
        avg7d: it.last_7_days.avg,
        volume7d: it.last_7_days.volume,
        median30d: it.last_30_days.median,
        volume30d: it.last_30_days.volume,
        median90d: it.last_90_days?.median ?? null,
        volume90d: it.last_90_days?.volume ?? 0,
      });
    }
    return out;
  },
};

// ── Market.CSGO (market.csgo.com) ────────────────────────────────────────────
// Public price list: https://market.csgo.com/api/v2/prices/USD.json

interface McsgoResponse {
  success: boolean;
  items: { market_hash_name: string; volume: number | string; price: string }[];
}

export const marketcsgo: SourceDef<NamedQuote> = {
  id: 'marketcsgo',
  label: 'Market.CSGO',
  ttlMs: 3 * 60_000,
  async load() {
    const data = (await fetchJson('https://market.csgo.com/api/v2/prices/USD.json')) as McsgoResponse;
    if (!data.success) throw new Error('market.csgo.com: success=false');
    const out: NamedQuote[] = [];
    for (const it of data.items) {
      const price = num(it.price);
      if (!price) continue;
      out.push({
        name: it.market_hash_name,
        market: 'marketcsgo',
        price,
        count: null,
        volume: num(it.volume),
        url: `https://market.csgo.com/en/?search=${encodeURIComponent(it.market_hash_name)}`,
      });
    }
    return out;
  },
};

// ── LIS-SKINS ────────────────────────────────────────────────────────────────
// Public export: https://lis-skins.com/market_export_json/csgo.json

interface LisItem {
  name: string;
  price: number;
  unlocked_price: number | null;
  url: string;
  count: number;
}

export const lisskins: SourceDef<NamedQuote> = {
  id: 'lisskins',
  label: 'LIS-SKINS',
  ttlMs: 5 * 60_000,
  async load() {
    const data = (await fetchJson('https://lis-skins.com/market_export_json/csgo.json')) as LisItem[];
    const out: NamedQuote[] = [];
    for (const it of data) {
      // unlocked_price = can be traded right away, which is what a reseller needs
      const price = num(it.unlocked_price) ?? num(it.price);
      if (!price || it.count <= 0) continue;
      out.push({ name: it.name, market: 'lisskins', price, count: it.count, volume: null, url: it.url });
    }
    return out;
  },
};

export const QUOTE_SOURCES = [skinport, marketcsgo, lisskins];
