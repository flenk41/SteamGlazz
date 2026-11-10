import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { extname, join, normalize, sep } from 'node:path';
import {
  computeArbitrage,
  computeDeals,
  parseArbOptions,
  parseDealOptions,
  searchItems,
  toCsv,
} from './analytics.ts';
import { DEFAULT_FEES, MARKETS, PORT, SALES_SERIES, WALLET_ONLY, externalLinks } from './config.ts';
import { buildCard } from './card.ts';
import { usdRub } from './rates.ts';
import { steamOverview } from './steam.ts';
import { parseFees } from './analytics.ts';
import { buildStrategy, parseStrategyOptions } from './strategy.ts';

/** Money fields converted when an export is requested in roubles. */
const MONEY_KEYS = new Set([
  'price', 'ref', 'buyPrice', 'buyCost', 'sellPrice', 'sellNet', 'profit', 'median7d', 'was', 'now',
  'sellAt', 'net', 'cost', 'proceeds',
]);
import { coverageStart, getHistory, pricesAt } from './history.ts';
import { PERIOD_MS, computeMovers, parseMoverOptions } from './analytics.ts';
import type { MoverBasis, MoversResponse } from './types.ts';

function movers(p: URLSearchParams): MoversResponse {
  const o = parseMoverOptions(p);
  const now = Date.now();
  const target = now - PERIOD_MS[o.period];
  const cov = coverageStart();
  // our own snapshots are the true "price N hours ago"; until enough history exists,
  // fall back to Skinport's sale medians, which are available right away
  const enough = cov != null && cov <= target + 3_600_000;
  const basis: MoverBasis = o.basis === 'auto' ? (enough ? 'asks' : 'sales') : o.basis;
  let since: number | null = null;
  let past: Map<string, number> | null = null;
  if (basis === 'asks' && cov != null) {
    since = Math.max(target, cov);
    past = pricesAt(since);
  }
  const { up, down, total } = computeMovers(getItems(), o, basis, past);
  return { basis, period: o.period, since, coverageStart: cov, up, down, total };
}
import { ensureFresh, getItem, getItems, sourceStatus, startSteam } from './store.ts';

const RANGES: Record<string, number> = { '1d': 1, '7d': 7, '30d': 30, '90d': 90, all: 3650 };

const PUBLIC_DIR = join(import.meta.dirname, '..', 'public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

/** Browser TS modules are type-stripped on the fly — no bundler needed. */
const tsCache = new Map<string, { mtime: number; code: string }>();

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const rel = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + sep)) return send(res, 403, 'Forbidden');
  let st;
  try {
    st = await stat(file);
    if (!st.isFile()) throw new Error('not a file');
  } catch {
    return send(res, 404, 'Not found');
  }
  const ext = extname(file);
  let body: string | Buffer;
  if (ext === '.ts') {
    const hit = tsCache.get(file);
    if (hit && hit.mtime === st.mtimeMs) body = hit.code;
    else {
      body = stripTypeScriptTypes(await readFile(file, 'utf8'), { mode: 'strip' });
      tsCache.set(file, { mtime: st.mtimeMs, code: body });
    }
  } else {
    body = await readFile(file);
  }
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(body);
}

function send(res: ServerResponse, code: number, body: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(code, { 'Content-Type': type });
  res.end(body);
}

function json(res: ServerResponse, data: unknown, code = 200): void {
  send(res, code, JSON.stringify(data), 'application/json; charset=utf-8');
}

function stamp(): string {
  return new Date().toISOString().slice(0, 16).replace(':', '-');
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const p = url.searchParams;
  switch (url.pathname) {
    case '/api/meta':
      return json(res, {
        markets: MARKETS,
        defaultFees: DEFAULT_FEES,
        sales: SALES_SERIES,
        walletOnly: WALLET_ONLY,
        rate: await usdRub(),
      });

    case '/api/rate':
      return json(res, await usdRub());

    case '/api/card': {
      await ensureFresh();
      const name = p.get('name') ?? '';
      const item = getItem(name);
      if (!item) return json(res, { error: 'not found' }, 404);
      // live Steam overview costs a rate-limited request — only for the main card
      const steam = p.get('live') === '0' ? null : await steamOverview(name);
      return json(res, { card: buildCard(getItem(name) ?? item, parseFees(p.get('fees')), steam), links: externalLinks(name) });
    }

    case '/api/history': {
      const days = RANGES[p.get('range') ?? '7d'] ?? 7;
      const now = Date.now();
      return json(res, getHistory(p.get('name') ?? '', now - days * 86_400_000, now));
    }

    case '/api/status':
      await ensureFresh();
      return json(res, { sources: sourceStatus(), items: getItems().length, now: Date.now(), rate: await usdRub() });

    case '/api/refresh':
      if (req.method !== 'POST') return send(res, 405, 'POST only');
      await ensureFresh({ force: true, wait: true });
      return json(res, { sources: sourceStatus(), items: getItems().length, now: Date.now() });

    case '/api/deals':
      await ensureFresh();
      return json(res, computeDeals(getItems(), parseDealOptions(p)));

    case '/api/arbitrage':
      await ensureFresh();
      return json(res, computeArbitrage(getItems(), parseArbOptions(p)));

    case '/api/movers':
      await ensureFresh();
      return json(res, movers(p));

    case '/api/strategy':
      await ensureFresh();
      return json(res, buildStrategy(getItems(), parseStrategyOptions(p)));

    case '/api/search':
      await ensureFresh();
      return json(res, searchItems(getItems(), p.get('q') ?? '', 40));

    case '/api/item': {
      await ensureFresh();
      const name = p.get('name') ?? '';
      const item = getItem(name);
      if (!item) return json(res, { error: 'not found' }, 404);
      return json(res, { item, links: externalLinks(name) });
    }

    case '/api/export': {
      await ensureFresh();
      const t = p.get('type');
      const type = t === 'deals' || t === 'movers' || t === 'strategy' ? t : 'arbitrage';
      const format = p.get('format') === 'json' ? 'json' : 'csv';
      // exports ignore paging: everything that matches the filters, capped
      p.set('limit', p.get('exportLimit') ?? (type === 'movers' ? '1000' : '5000'));
      p.set('offset', '0');
      let rows: object[];
      if (type === 'deals') rows = computeDeals(getItems(), parseDealOptions(p)).rows;
      else if (type === 'arbitrage') rows = computeArbitrage(getItems(), parseArbOptions(p)).rows;
      else if (type === 'strategy') {
        rows = buildStrategy(getItems(), parseStrategyOptions(p)).steps.map((s, i) => ({ step: i + 1, ...s }));
      } else {
        const m = movers(p);
        rows = [...m.up, ...m.down].map((r) => ({ ...r, basis: m.basis, period: m.period }));
      }
      if (p.get('currency') === 'RUB') {
        const custom = Number(p.get('rate'));
        const rate = custom > 0 ? custom : (await usdRub()).rate;
        rows = rows.map((r) => {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(r)) out[k] = MONEY_KEYS.has(k) && typeof v === 'number' ? Math.round(v * rate * 100) / 100 : v;
          out.currency = 'RUB';
          return out;
        });
      }
      const filename = `steamglazz-${type}-${stamp()}.${format}`;
      const body =
        format === 'json'
          ? JSON.stringify({ generatedAt: new Date().toISOString(), type, rows }, null, 2)
          : toCsv(rows as unknown as Record<string, unknown>[], p.get('excel') !== '0');
      res.writeHead(200, {
        'Content-Type': format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      });
      return void res.end(body);
    }

    default:
      return json(res, { error: 'unknown endpoint' }, 404);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await serveStatic(url.pathname, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`SteamGlazz → http://localhost:${PORT}`);
  // warm the cache so the first page load is fast
  ensureFresh().then(
    () => console.log(`Загружено предметов: ${getItems().length}`),
    (e: unknown) => console.warn('Первичная загрузка не удалась:', e),
  );
  // keep sampling prices for the history even when nobody has the site open;
  // each source still refreshes only when its own TTL has expired
  setInterval(() => void ensureFresh().catch((e: unknown) => console.warn(e)), 60_000);
  void ensureFresh().then(() => startSteam());
  void usdRub();
});
