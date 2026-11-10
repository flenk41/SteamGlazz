import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recordSnapshot, type Sample } from './history.ts';
import { QUOTE_SOURCES, skinportHistory, skinportSuggested, type SourceDef } from './sources.ts';
import { loadSteamCache, startSteamCrawler, steamQuotes, steamRevision, steamStatus } from './steam.ts';
import type { Category, Item, NamedQuote, SalesStats, SeriesKey, SourceStatus } from './types.ts';

/** Turn a fresh source payload into history samples. */
function toSamples(id: string, data: unknown[]): { key: SeriesKey; samples: Sample[] } | null {
  if (id === 'skinport-history') {
    const samples: Sample[] = [];
    for (const s of data as SalesStats[]) {
      if (s.median24h != null && s.volume24h > 0) samples.push({ name: s.name, price: s.median24h, count: s.volume24h });
    }
    return { key: 'sales', samples };
  }
  if (id === 'skinport' || id === 'marketcsgo' || id === 'lisskins') {
    return { key: id, samples: (data as NamedQuote[]).map((q) => ({ name: q.name, price: q.price, count: q.count ?? q.volume })) };
  }
  return null;
}

const CACHE_DIR = join(import.meta.dirname, '..', 'data', 'cache');

interface SourceState<T> {
  def: SourceDef<T>;
  data: T[] | null;
  fetchedAt: number | null;
  error: string | null;
  lastAttempt: number;
  inflight: Promise<void> | null;
}

function state<T>(def: SourceDef<T>): SourceState<T> {
  return { def, data: null, fetchedAt: null, error: null, lastAttempt: 0, inflight: null };
}

const quoteStates = QUOTE_SOURCES.map((d) => state(d));
const historyState = state(skinportHistory);
const allStates: SourceState<unknown>[] = [...quoteStates, historyState] as SourceState<unknown>[];

/** Never hit a source more often than this, even on manual refresh (Skinport: 8 req / 5 min). */
const MIN_INTERVAL_MS = 60_000;

let version = 0;
let builtVersion = '';
let items: Item[] = [];
let byName = new Map<string, Item>();

async function loadDisk<T>(s: SourceState<T>): Promise<void> {
  try {
    const raw = JSON.parse(await readFile(join(CACHE_DIR, `${s.def.id}.json`), 'utf8')) as {
      fetchedAt: number;
      data: T[];
      suggested?: [string, number][];
    };
    s.data = raw.data;
    s.fetchedAt = raw.fetchedAt;
    if (raw.suggested) for (const [k, v] of raw.suggested) skinportSuggested.set(k, v);
    version++;
    // the cached snapshot is real data with its real timestamp — keep it in the history
    const snap = toSamples(s.def.id, raw.data);
    if (snap) recordSnapshot(snap.key, snap.samples, raw.fetchedAt);
  } catch {
    // no cache yet
  }
}

async function refresh<T>(s: SourceState<T>): Promise<void> {
  if (s.inflight) return s.inflight;
  s.lastAttempt = Date.now();
  s.inflight = (async () => {
    try {
      const data = await s.def.load();
      s.data = data;
      s.fetchedAt = Date.now();
      s.error = null;
      version++;
      try {
        const snap = toSamples(s.def.id, data);
        if (snap) recordSnapshot(snap.key, snap.samples, s.fetchedAt);
      } catch (err) {
        console.warn(`[history:${s.def.id}]`, err instanceof Error ? err.message : err);
      }
      await mkdir(CACHE_DIR, { recursive: true });
      const payload: Record<string, unknown> = { fetchedAt: s.fetchedAt, data };
      if (s.def.id === 'skinport') payload.suggested = [...skinportSuggested];
      await writeFile(join(CACHE_DIR, `${s.def.id}.json`), JSON.stringify(payload));
    } catch (err) {
      s.error = err instanceof Error ? err.message : String(err);
      console.warn(`[${s.def.id}] ${s.error}`);
    } finally {
      s.inflight = null;
    }
  })();
  return s.inflight;
}

let diskLoaded: Promise<void> | null = null;

/**
 * Stale-while-revalidate: returns immediately when cached data exists and refreshes
 * stale sources in the background; waits only for sources that have no data at all.
 */
export async function ensureFresh(opts: { force?: boolean; wait?: boolean } = {}): Promise<void> {
  diskLoaded ??= Promise.all([
    ...allStates.map((s) => loadDisk(s)),
    loadSteamCache().then((cached) => {
      if (!cached.length) return;
      version++;
      // each cached quote keeps its own timestamp; group by hour (history dedups per hour)
      const byHour = new Map<number, Sample[]>();
      for (const q of cached) {
        const h = Math.floor(q.ts / 3_600_000) * 3_600_000;
        const arr = byHour.get(h) ?? [];
        arr.push({ name: q.name, price: q.price, count: q.count });
        byHour.set(h, arr);
      }
      for (const [h, samples] of [...byHour].sort((a, b) => a[0] - b[0])) recordSnapshot('steam', samples, h);
    }),
  ]).then(() => undefined);
  await diskLoaded;
  const now = Date.now();
  const waits: Promise<void>[] = [];
  for (const s of allStates) {
    if (s.inflight) {
      if (!s.data || opts.wait) waits.push(s.inflight);
      continue;
    }
    const age = s.fetchedAt ? now - s.fetchedAt : Infinity;
    const stale = age > (opts.force ? MIN_INTERVAL_MS : s.def.ttlMs);
    if (!stale) continue;
    if (now - s.lastAttempt < MIN_INTERVAL_MS) continue; // back off after errors
    const p = refresh(s);
    if (!s.data || opts.wait) waits.push(p);
  }
  await Promise.all(waits);
}

/** Start the Steam background crawler (web server only — the CLI uses the disk cache). */
export function startSteam(): void {
  startSteamCrawler((batch) => {
    version++;
    try {
      recordSnapshot('steam', batch.map((q) => ({ name: q.name, price: q.price, count: q.count })));
    } catch (err) {
      console.warn('[history:steam]', err instanceof Error ? err.message : err);
    }
  });
}

export function sourceStatus(): SourceStatus[] {
  return [...baseStatus(), steamStatus()];
}

function baseStatus(): SourceStatus[] {
  return allStates.map((s) => ({
    id: s.def.id,
    label: s.def.label,
    fetchedAt: s.fetchedAt,
    count: s.data?.length ?? 0,
    error: s.error,
    loading: s.inflight != null,
  }));
}

export function categorize(name: string): Category {
  if (name.startsWith('★')) return /Gloves|Hand Wraps/.test(name) ? 'gloves' : 'knife';
  if (name.startsWith('Sticker Slab') || name.startsWith('Charm |')) return 'charm';
  if (name.startsWith('Sticker |')) return 'sticker';
  if (name.startsWith('Patch |')) return 'patch';
  if (name.includes('Music Kit')) return 'music';
  if (name.includes('Graffiti |')) return 'graffiti';
  if (/\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/.test(name)) return 'weapon';
  if (!name.includes('|') && /(Case|Capsule|Package|Terminal|Pass|Key|Pin)/.test(name)) return 'container';
  if (name.includes('|')) return 'agent';
  return 'other';
}

function build(): void {
  const key = `${version}:${steamRevision()}`;
  if (builtVersion === key) return;
  const map = new Map<string, Item>();
  const get = (name: string): Item => {
    let it = map.get(name);
    if (!it) {
      it = {
        name,
        category: categorize(name),
        stattrak: name.includes('StatTrak™'),
        souvenir: name.startsWith('Souvenir '),
        quotes: {},
        stats: null,
        suggested: skinportSuggested.get(name) ?? null,
      };
      map.set(name, it);
    }
    return it;
  };
  for (const s of quoteStates) {
    for (const q of (s.data ?? []) as NamedQuote[]) {
      const { name, ...quote } = q;
      get(name).quotes[quote.market] = quote;
    }
  }
  for (const q of steamQuotes()) {
    const { name, ts: _ts, ...quote } = q;
    get(name).quotes.steam = quote;
  }
  for (const st of (historyState.data ?? []) as SalesStats[]) {
    const it = map.get(st.name);
    if (it) it.stats = st;
  }
  byName = map;
  items = [...map.values()];
  builtVersion = key;
}

export function getItems(): Item[] {
  build();
  return items;
}

export function getItem(name: string): Item | undefined {
  build();
  return byName.get(name);
}
