import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { STEAM_CRAWL_LIMIT } from './config.ts';
import type { NamedQuote } from './types.ts';

/**
 * Steam Community Market.
 *
 * Steam has no bulk price list. The anonymous search endpoint returns 10 items per
 * request and rate-limits aggressively, so:
 *  - a background crawler walks the most popular items (STEAM_CRAWL_LIMIT, default 5000)
 *    at one request every few seconds and keeps a cache on disk;
 *  - priceoverview (lowest / median / sales in 24 h) is fetched on demand for item cards.
 * Every Steam request goes through one queue so the two never burst together.
 */

const CACHE_FILE = join(import.meta.dirname, '..', 'data', 'cache', 'steam.json');
const GAP_MS = 3_000;
const BACKOFF_429_MS = 120_000;
const CYCLE_PAUSE_MS = 10 * 60_000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) SteamGlazz/0.1';

export const steamUrl = (name: string): string =>
  `https://steamcommunity.com/market/listings/730/${encodeURIComponent(name)}`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── request queue ────────────────────────────────────────────────────────────

interface Task {
  run: () => Promise<unknown>;
  priority: number;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}
const queue: Task[] = [];
let pumping = false;
let lastAt = 0;
let pausedUntil = 0;

function schedule<T>(run: () => Promise<T>, priority: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({ run, priority, resolve: resolve as (v: unknown) => void, reject });
    void pump();
  });
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  while (queue.length) {
    queue.sort((a, b) => b.priority - a.priority);
    const task = queue.shift()!;
    const wait = Math.max(0, pausedUntil - Date.now(), lastAt + GAP_MS - Date.now());
    if (wait) await sleep(wait);
    lastAt = Date.now();
    try {
      task.resolve(await task.run());
    } catch (err) {
      task.reject(err);
    }
  }
  pumping = false;
}

async function steamJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (res.status === 429) {
    pausedUntil = Date.now() + BACKOFF_429_MS;
    throw new Error('Steam: слишком много запросов (429), пауза 2 мин');
  }
  if (!res.ok) throw new Error(`Steam: HTTP ${res.status}`);
  return res.json();
}

// ── crawler state ────────────────────────────────────────────────────────────

type SteamQuote = NamedQuote & { ts: number };
const quotes = new Map<string, SteamQuote>();
let fetchedAt: number | null = null;
let lastError: string | null = null;
let crawling = false;
let crawlPos = 0;
let total: number | null = null;

let rev = 0;

export function steamQuotes(): Iterable<SteamQuote> {
  return quotes.values();
}

/** Bumps whenever a Steam quote changes, so the store knows to rebuild. */
export function steamRevision(): number {
  return rev;
}

export function steamStatus() {
  return {
    id: 'steam',
    label: total ? `Steam (${Math.min(crawlPos, STEAM_CRAWL_LIMIT)}/${Math.min(total, STEAM_CRAWL_LIMIT)})` : 'Steam',
    fetchedAt,
    count: quotes.size,
    error: lastError,
    loading: crawling,
  };
}

let cacheLoaded = false;
export async function loadSteamCache(): Promise<SteamQuote[]> {
  if (cacheLoaded) return [];
  cacheLoaded = true;
  try {
    const raw = JSON.parse(await readFile(CACHE_FILE, 'utf8')) as { fetchedAt: number; data: SteamQuote[] };
    for (const q of raw.data) quotes.set(q.name, q);
    fetchedAt = raw.fetchedAt;
    rev++;
    return raw.data;
  } catch {
    return [];
  }
}

async function saveCache(): Promise<void> {
  await mkdir(join(CACHE_FILE, '..'), { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify({ fetchedAt, data: [...quotes.values()] }));
}

interface SearchResult {
  total_count: number;
  results: { hash_name: string; sell_listings: number; sell_price: number }[];
}

async function fetchPage(start: number): Promise<SearchResult> {
  const url =
    'https://steamcommunity.com/market/search/render/?appid=730&norender=1&count=10' +
    `&sort_column=popular&sort_dir=desc&start=${start}`;
  return (await steamJson(url)) as SearchResult;
}

/**
 * Walk popular items forever. `onBatch` receives freshly priced quotes every ~10 pages
 * (the store records them into the history and rebuilds its index).
 */
export function startSteamCrawler(onBatch: (batch: SteamQuote[]) => void): void {
  if (crawling) return;
  crawling = true;
  void (async () => {
    let batch: SteamQuote[] = [];
    const flush = async () => {
      if (!batch.length) return;
      rev++;
      onBatch(batch);
      batch = [];
      await saveCache().catch(() => undefined);
    };
    for (;;) {
      try {
        const page = await schedule(() => fetchPage(crawlPos), 0);
        total = page.total_count;
        const now = Date.now();
        for (const r of page.results) {
          if (!r.sell_price || r.sell_listings <= 0) continue;
          const q: SteamQuote = {
            name: r.hash_name,
            market: 'steam',
            price: r.sell_price / 100,
            count: r.sell_listings,
            volume: null,
            url: steamUrl(r.hash_name),
            ts: now,
          };
          quotes.set(q.name, q);
          batch.push(q);
        }
        fetchedAt = now;
        lastError = null;
        crawlPos += 10;
        if (batch.length >= 100) await flush();
        if (!page.results.length || crawlPos >= Math.min(STEAM_CRAWL_LIMIT, total)) {
          await flush();
          crawlPos = 0;
          crawling = false; // idle between cycles
          await sleep(CYCLE_PAUSE_MS);
          crawling = true;
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        await flush();
        await sleep(30_000);
      }
    }
  })();
}

// ── on-demand price overview ─────────────────────────────────────────────────

export interface SteamOverview {
  lowest: number | null;
  median: number | null;
  /** items sold in the last 24 h */
  volume24h: number;
  fetchedAt: number;
}

const overviewCache = new Map<string, SteamOverview>();
const OVERVIEW_TTL = 10 * 60_000;

const money = (s: unknown): number | null => {
  if (typeof s !== 'string') return null;
  const n = Number(s.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};

export async function steamOverview(name: string): Promise<SteamOverview | null> {
  const hit = overviewCache.get(name);
  if (hit && Date.now() - hit.fetchedAt < OVERVIEW_TTL) return hit;
  try {
    const url = `https://steamcommunity.com/market/priceoverview/?appid=730&currency=1&market_hash_name=${encodeURIComponent(name)}`;
    const j = (await schedule(() => steamJson(url), 10)) as {
      success: boolean;
      lowest_price?: string;
      median_price?: string;
      volume?: string;
    };
    if (!j.success) return null;
    const ov: SteamOverview = {
      lowest: money(j.lowest_price),
      median: money(j.median_price),
      volume24h: Number((j.volume ?? '0').replace(/\D/g, '')) || 0,
      fetchedAt: Date.now(),
    };
    overviewCache.set(name, ov);
    if (ov.lowest) {
      const prev = quotes.get(name);
      quotes.set(name, {
        name, market: 'steam', price: ov.lowest, count: prev?.count ?? null, volume: ov.volume24h,
        url: steamUrl(name), ts: ov.fetchedAt,
      });
      rev++;
    }
    return ov;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    return hit ?? null;
  }
}
