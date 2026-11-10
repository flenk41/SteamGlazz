import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** USD → RUB from the Central Bank of Russia (daily), cached for an hour and on disk. */

const FILE = join(import.meta.dirname, '..', 'data', 'cache', 'usdrub.json');
const TTL = 60 * 60_000;

export interface Rate {
  rate: number;
  date: string;
  fetchedAt: number;
  source: 'cbr' | 'cache' | 'fallback';
}

let current: Rate | null = null;
let inflight: Promise<Rate> | null = null;

async function fetchCbr(): Promise<Rate> {
  const res = await fetch('https://www.cbr-xml-daily.ru/daily_json.js', { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`ЦБ: HTTP ${res.status}`);
  const j = (await res.json()) as { Date: string; Valute: { USD: { Value: number; Nominal: number } } };
  const rate = j.Valute.USD.Value / (j.Valute.USD.Nominal || 1);
  if (!(rate > 0)) throw new Error('ЦБ: нет курса USD');
  return { rate, date: j.Date, fetchedAt: Date.now(), source: 'cbr' };
}

export async function usdRub(): Promise<Rate> {
  if (current && Date.now() - current.fetchedAt < TTL) return current;
  inflight ??= (async () => {
    try {
      current = await fetchCbr();
      await mkdir(join(FILE, '..'), { recursive: true });
      await writeFile(FILE, JSON.stringify(current));
    } catch (err) {
      console.warn('[usdrub]', err instanceof Error ? err.message : err);
      if (!current) {
        try {
          current = { ...(JSON.parse(await readFile(FILE, 'utf8')) as Rate), source: 'cache' };
        } catch {
          current = { rate: 90, date: new Date().toISOString(), fetchedAt: Date.now(), source: 'fallback' };
        }
      }
    } finally {
      inflight = null;
    }
    return current!;
  })();
  return inflight;
}
