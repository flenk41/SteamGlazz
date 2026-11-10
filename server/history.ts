import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { HistoryResponse, SeriesKey } from './types.ts';

/**
 * Price history we collect ourselves: none of the free APIs expose a time series,
 * so every source refresh is sampled into SQLite.
 *
 * Storage rule (keeps the DB small — ~32k items × 4 series):
 *  - at most one point per item/series per hour;
 *  - a new point only when the price moved ≥ 0.5 %, or as a heartbeat every 6 h.
 * Charts therefore draw step lines: a price holds until the next point.
 */

const DATA_DIR = join(import.meta.dirname, '..', 'data');
const HOUR = 3_600_000;
const HEARTBEAT = 6 * HOUR;
const MIN_MOVE = 0.005;
const KEEP_DAYS = 180;

const CODES: Record<SeriesKey, number> = { skinport: 0, marketcsgo: 1, lisskins: 2, sales: 3, steam: 4 };
const KEYS = Object.fromEntries(Object.entries(CODES).map(([k, v]) => [v, k])) as Record<number, SeriesKey>;

export interface Sample {
  name: string;
  price: number;
  count: number | null;
}

let db: DatabaseSync | null = null;
let insertItem: StatementSync;
let insertPoint: StatementSync;
const itemIds = new Map<string, number>();
/** last stored point per `${itemId}:${code}` */
const last = new Map<string, { ts: number; price: number }>();

function open(): DatabaseSync {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(join(DATA_DIR, 'history.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS points (
      item_id INTEGER NOT NULL,
      market  INTEGER NOT NULL,
      ts      INTEGER NOT NULL,
      price   REAL    NOT NULL,
      count   INTEGER,
      PRIMARY KEY (item_id, market, ts)
    ) WITHOUT ROWID;
  `);
  insertItem = db.prepare('INSERT INTO items (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET name = name RETURNING id');
  insertPoint = db.prepare('INSERT OR REPLACE INTO points (item_id, market, ts, price, count) VALUES (?, ?, ?, ?, ?)');

  for (const r of db.prepare('SELECT id, name FROM items').all() as { id: number; name: string }[]) {
    itemIds.set(r.name, r.id);
  }
  // bare columns with MAX() return the row holding the max ts
  const rows = db
    .prepare('SELECT item_id, market, MAX(ts) AS ts, price FROM points GROUP BY item_id, market')
    .all() as { item_id: number; market: number; ts: number; price: number }[];
  for (const r of rows) last.set(`${r.item_id}:${r.market}`, { ts: r.ts, price: r.price });

  db.prepare('DELETE FROM points WHERE ts < ?').run(Date.now() - KEEP_DAYS * 24 * HOUR);
  return db;
}

function itemId(name: string): number {
  let id = itemIds.get(name);
  if (id == null) {
    id = (insertItem.get(name) as { id: number }).id;
    itemIds.set(name, id);
  }
  return id;
}

/** Store a snapshot of one source. Returns the number of points written. */
export function recordSnapshot(key: SeriesKey, samples: Sample[], at = Date.now()): number {
  const d = open();
  const code = CODES[key];
  const bucket = Math.floor(at / HOUR) * HOUR;
  let written = 0;
  d.exec('BEGIN');
  try {
    for (const s of samples) {
      if (!(s.price > 0)) continue;
      const id = itemId(s.name);
      const k = `${id}:${code}`;
      const prev = last.get(k);
      if (prev) {
        if (bucket <= prev.ts) continue; // already have this hour
        const moved = Math.abs(s.price - prev.price) / prev.price >= MIN_MOVE;
        if (!moved && bucket - prev.ts < HEARTBEAT) continue;
      }
      insertPoint.run(id, code, bucket, s.price, s.count);
      last.set(k, { ts: bucket, price: s.price });
      written++;
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
  return written;
}

let coverageCache: { at: number; value: number | null } | null = null;

/** Earliest stored snapshot across all items. */
export function coverageStart(): number | null {
  if (coverageCache && Date.now() - coverageCache.at < 60_000) return coverageCache.value;
  const r = open().prepare('SELECT MIN(ts) AS ts FROM points').get() as { ts: number | null };
  coverageCache = { at: Date.now(), value: r.ts };
  return r.ts;
}

const pricesCache = new Map<number, { at: number; map: Map<string, number> }>();

/**
 * Price in force at moment `ts` for every item/series: key `${name}\n${seriesKey}`.
 * Cached per hour bucket for a few minutes — it is one indexed query over the whole DB.
 */
export function pricesAt(ts: number): Map<string, number> {
  const bucket = Math.floor(ts / HOUR) * HOUR;
  const hit = pricesCache.get(bucket);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.map;
  const rows = open()
    .prepare(
      `SELECT i.name AS name, p.market AS market, p.price AS price
         FROM points p JOIN items i ON i.id = p.item_id
        WHERE (p.item_id, p.market, p.ts) IN (
          SELECT item_id, market, MAX(ts) FROM points WHERE ts <= ? GROUP BY item_id, market)`,
    )
    .all(ts) as { name: string; market: number; price: number }[];
  const map = new Map<string, number>();
  for (const r of rows) map.set(`${r.name}\n${KEYS[r.market]}`, r.price);
  pricesCache.clear(); // keep only the latest lookup in memory
  pricesCache.set(bucket, { at: Date.now(), map });
  return map;
}

export function getHistory(name: string, from: number, to = Date.now()): HistoryResponse {
  const d = open();
  const id = itemIds.get(name);
  const res: HistoryResponse = { name, from, to, series: [], firstAt: null };
  if (id == null) return res;

  const byKey = new Map<SeriesKey, [number, number][]>();
  // the point in force at `from`, so step lines start at the left edge
  const before = d
    .prepare('SELECT market, MAX(ts) AS ts, price FROM points WHERE item_id = ? AND ts < ? GROUP BY market')
    .all(id, from) as { market: number; ts: number; price: number }[];
  for (const r of before) byKey.set(KEYS[r.market]!, [[from, r.price]]);

  const rows = d
    .prepare('SELECT market, ts, price FROM points WHERE item_id = ? AND ts >= ? AND ts <= ? ORDER BY ts')
    .all(id, from, to) as { market: number; ts: number; price: number }[];
  for (const r of rows) {
    const key = KEYS[r.market]!;
    const arr = byKey.get(key) ?? [];
    arr.push([r.ts, r.price]);
    byKey.set(key, arr);
  }

  const first = d.prepare('SELECT MIN(ts) AS ts FROM points WHERE item_id = ?').get(id) as { ts: number | null };
  res.firstAt = first.ts;
  for (const key of ['skinport', 'marketcsgo', 'lisskins', 'steam', 'sales'] as SeriesKey[]) {
    const points = byKey.get(key);
    if (points?.length) res.series.push({ key, points });
  }
  return res;
}
