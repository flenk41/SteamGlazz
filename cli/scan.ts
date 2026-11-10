/**
 * Arbitrage scanner — the "program" side of SteamGlazz.
 *
 *   npm run scan                                  one scan, prints the top and writes exports/
 *   npm run scan -- --watch 300                   rescan every 5 minutes, alert on new opportunities
 *   npm run scan -- --min-profit 2 --min-roi 8 --buy lisskins,skinport --sell marketcsgo
 *
 * All flags: --min-profit $  --min-roi %  --min-volume N  --min-price $  --max-price $
 *            --buy list  --sell list  --mode safe|ask  --top N  --watch SEC  --out DIR
 *            --fees '{"skinport":{"sell":0.08}}'  --no-export
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { computeArbitrage, parseArbOptions, toCsv } from '../server/analytics.ts';
import { MARKETS, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, WALLET_ONLY } from '../server/config.ts';
import { ensureFresh, getItems, sourceStatus } from '../server/store.ts';
import { loadSteamCache } from '../server/steam.ts';
import { buildStrategy, parseStrategyOptions } from '../server/strategy.ts';
import type { ArbRow } from '../server/types.ts';

const { values: args } = parseArgs({
  options: {
    'min-profit': { type: 'string', default: '0.5' },
    'min-roi': { type: 'string', default: '5' },
    'min-volume': { type: 'string', default: '10' },
    'min-price': { type: 'string', default: '1' },
    'max-price': { type: 'string', default: '' },
    buy: { type: 'string', default: '' },
    sell: { type: 'string', default: '' },
    mode: { type: 'string', default: 'safe' },
    top: { type: 'string', default: '25' },
    watch: { type: 'string', default: '' },
    out: { type: 'string', default: 'exports' },
    fees: { type: 'string', default: '' },
    'no-export': { type: 'boolean', default: false },
    budget: { type: 'string', default: '' },
    goal: { type: 'string', default: 'cash' },
    horizon: { type: 'string', default: '7' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help) {
  console.log(`Сканер арбитража SteamGlazz

  --min-profit $    минимальный профит в долларах (0.5)
  --min-roi %       минимальный ROI в процентах (5)
  --min-volume N    минимум продаж за 7 дней на Skinport (10)
  --min-price $     --max-price $   диапазон цены покупки
  --buy  a,b        где покупать: ${Object.keys(MARKETS).join(', ')}
  --sell a,b        где продавать
  --mode safe|ask   safe = цена продажи не выше медианы 7д (по умолчанию)
  --top N           сколько строк вывести (25)
  --watch SEC       повторять каждые SEC секунд и уведомлять о новых связках
  --out DIR         куда писать CSV/JSON (exports)
  --fees JSON       комиссии, напр. '{"lisskins":{"sell":0.07}}'
  --no-export       не писать файлы

  Стратегия под бюджет (вместо списка связок):
  --budget $        бюджет в долларах — программа сама составит план сделок
  --goal G          cash (деньги→деньги), steam-out (вывод баланса Steam), steam-in (пополнение Steam)
  --horizon D       за сколько дней всё должно продаться (7)`);
  process.exit(0);
}

const params = new URLSearchParams({
  minProfit: args['min-profit'],
  minRoi: String(Number(args['min-roi']) / 100),
  minVolume: args['min-volume'],
  minPrice: args['min-price'],
  sellMode: args.mode === 'ask' ? 'ask' : 'safe',
  hideSuspicious: '1',
  sort: 'profit',
  limit: '5000',
});
if (args['max-price']) params.set('maxPrice', args['max-price']);
if (args.buy) params.set('buy', args.buy);
// by default sell only where money can be withdrawn (not to the Steam wallet)
params.set('sell', args.sell || Object.keys(MARKETS).filter((m) => !WALLET_ONLY.includes(m as never)).join(','));
if (args.fees) params.set('fees', args.fees);

const label = (m: string): string => MARKETS[m as keyof typeof MARKETS]?.label ?? m;
const money = (x: number): string => `$${x.toFixed(2)}`;
const pad = (s: string, n: number, right = false): string =>
  s.length > n ? s.slice(0, n - 1) + '…' : right ? s.padStart(n) : s.padEnd(n);

function printTable(rows: ArbRow[]): void {
  const top = rows.slice(0, Number(args.top) || 25);
  console.log(
    [pad('Предмет', 46), pad('Купить', 22), pad('Продать', 22), pad('Профит', 9, true), pad('ROI', 7, true), pad('7д', 5, true)].join('  '),
  );
  console.log('─'.repeat(121));
  for (const r of top) {
    console.log(
      [
        pad(r.name, 46),
        pad(`${label(r.buyMarket)} ${money(r.buyPrice)}`, 22),
        pad(`${label(r.sellMarket)} ${money(r.sellPrice)}`, 22),
        pad(`+${money(r.profit)}`, 9, true),
        pad(`${(r.roi * 100).toFixed(1)}%`, 7, true),
        pad(String(r.volume7d), 5, true),
      ].join('  '),
    );
  }
}

async function notify(rows: ArbRow[]): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !rows.length) return;
  const text = [
    `🟢 Новые связки: ${rows.length}`,
    ...rows
      .slice(0, 10)
      .map((r) => `• ${r.name}\n  ${label(r.buyMarket)} ${money(r.buyPrice)} → ${label(r.sellMarket)} ${money(r.sellPrice)} | +${money(r.profit)} (${(r.roi * 100).toFixed(1)}%)`),
  ].join('\n');
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
    if (!res.ok) console.warn(`Telegram: HTTP ${res.status}`);
  } catch (err) {
    console.warn('Telegram:', err instanceof Error ? err.message : err);
  }
}

const seen = new Set<string>();

async function scanOnce(first: boolean): Promise<void> {
  await ensureFresh({ wait: true });
  for (const s of sourceStatus()) if (s.error) console.warn(`⚠ ${s.label}: ${s.error}`);

  const { total, rows } = computeArbitrage(getItems(), parseArbOptions(params));
  const time = new Date().toLocaleString('ru-RU');
  console.log(`\n[${time}] Предметов: ${getItems().length} · выгодных связок: ${total}\n`);
  printTable(rows);

  if (!args['no-export'] && rows.length) {
    await mkdir(args.out, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 16).replace(':', '-');
    const base = join(args.out, `arbitrage-${stamp}`);
    await writeFile(`${base}.csv`, toCsv(rows as unknown as Record<string, unknown>[]));
    await writeFile(`${base}.json`, JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2));
    console.log(`\nВыгружено: ${base}.csv и .json`);
  }

  const fresh = rows.filter((r) => !seen.has(`${r.name}|${r.buyMarket}|${r.sellMarket}`));
  for (const r of rows) seen.add(`${r.name}|${r.buyMarket}|${r.sellMarket}`);
  if (!first && fresh.length) {
    console.log(`\n🔔 Новых связок с прошлого скана: ${fresh.length}`);
    await notify(fresh);
  }
}

async function planOnce(): Promise<void> {
  await ensureFresh({ wait: true });
  await loadSteamCache();
  const p = new URLSearchParams({
    mode: args.goal,
    budget: args.budget,
    horizon: args.horizon,
    minPerDay: '1',
    minRoi: String(Number(args['min-roi']) / 100),
    minPrice: args['min-price'],
  });
  if (args.fees) p.set('fees', args.fees);
  const s = buildStrategy(getItems(), parseStrategyOptions(p));
  const time = new Date().toLocaleString('ru-RU');
  console.log(`\n[${time}] Стратегия «${args.goal}», бюджет ${money(s.budget)} · подходящих скинов: ${s.candidates}\n`);
  if (!s.steps.length) {
    console.log('Под эти условия выгодных сделок нет.');
    return;
  }
  const top = s.routes.find((r) => r.inPlan > 0);
  if (top) console.log(`Лучшая связка: ${label(top.buyMarket)} → ${label(top.sellMarket)} (${top.inPlan} скинов, ${money(top.planProfit)})\n`);
  console.log([pad('#', 3, true), pad('Скин', 44), pad('Купить', 22), pad('Шт', 3, true), pad('Выставить', 22), pad('Прибыль', 9, true), pad('Дней', 5, true)].join('  '));
  console.log('─'.repeat(118));
  s.steps.forEach((x, i) => {
    console.log(
      [
        pad(String(i + 1), 3, true),
        pad(x.name, 44),
        pad(`${label(x.buyMarket)} ${money(x.buyPrice)}`, 22),
        pad(String(x.qty), 3, true),
        pad(`${label(x.sellMarket)} ${money(x.sellAt)}`, 22),
        pad(`${x.profit >= 0 ? '+' : ''}${money(x.profit)}`, 9, true),
        pad(String(x.daysToSell), 5, true),
      ].join('  '),
    );
  });
  console.log(
    `\nВложить ${money(s.spent)} → получить ${money(s.proceeds)} (${((s.ratio - 1) * 100).toFixed(1)}%), срок ~${s.days} дн.` +
      (s.leftover >= 0.5 ? ` Остаток бюджета ${money(s.leftover)}.` : ''),
  );
  if (!args['no-export']) {
    await mkdir(args.out, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 16).replace(':', '-');
    const base = join(args.out, `strategy-${args.goal}-${stamp}`);
    await writeFile(`${base}.csv`, toCsv(s.steps as unknown as Record<string, unknown>[]));
    await writeFile(`${base}.json`, JSON.stringify({ generatedAt: new Date().toISOString(), ...s }, null, 2));
    console.log(`Выгружено: ${base}.csv и .json`);
  }
}

if (args.budget) {
  await planOnce();
  process.exit(0);
}

const every = Number(args.watch);
await scanOnce(true);
if (every > 0) {
  const ms = Math.max(every, 60) * 1000; // sources refresh every 3–15 min anyway
  console.log(`\nРежим наблюдения: каждые ${ms / 1000} с. Ctrl+C — выход.`);
  setInterval(() => void scanOnce(false).catch((e: unknown) => console.error(e)), ms);
}
