/** Pure calculation engine. Closes are oldest-first and contain only finalized observations. */
export function rsiWilder(closes, period = 40) {
  if (!Number.isInteger(period) || period < 1) throw new RangeError('La période RSI doit être un entier positif.');
  if (!Array.isArray(closes) || closes.some((v) => !Number.isFinite(v))) return { value: null, reason: 'missing_data' };
  if (closes.length < period + 1) return { value: null, reason: 'insufficient_history' };
  const deltas = closes.slice(1).map((v, i) => v - closes[i]);
  let gain = deltas.slice(0, period).reduce((s, d) => s + Math.max(d, 0), 0) / period;
  let loss = deltas.slice(0, period).reduce((s, d) => s + Math.max(-d, 0), 0) / period;
  for (const d of deltas.slice(period)) {
    gain = ((gain * (period - 1)) + Math.max(d, 0)) / period;
    loss = ((loss * (period - 1)) + Math.max(-d, 0)) / period;
  }
  if (gain === 0 && loss === 0) return { value: 50, reason: null };
  if (loss === 0) return { value: 100, reason: null };
  return { value: 100 - 100 / (1 + gain / loss), reason: null };
}

export function sma(values, period = 20) {
  if (!Number.isInteger(period) || period < 1) throw new RangeError('La période SMA doit être un entier positif.');
  if (!Array.isArray(values) || values.some((v) => !Number.isFinite(v))) return { value: null, reason: 'missing_data' };
  if (values.length < period) return { value: null, reason: 'insufficient_history' };
  return { value: values.slice(-period).reduce((sum, v) => sum + v, 0) / period, reason: null };
}

export function distancePercent(price, average) {
  if (!Number.isFinite(price) || !Number.isFinite(average)) return { value: null, reason: 'missing_data' };
  if (average === 0) return { value: null, reason: 'division_by_zero' };
  return { value: ((price - average) / average) * 100, reason: null };
}

/** Aggregate dated daily closes into finalized ISO-week (Monday–Sunday) or calendar-month closes. */
export function aggregateCloses(rows, period, asOf = new Date()) {
  const buckets = new Map();
  for (const row of rows) {
    const date = new Date(`${row.date}T00:00:00Z`);
    if (!Number.isFinite(row.close) || Number.isNaN(date.valueOf())) continue;
    let key;
    if (period === 'weekly') {
      const monday = new Date(date); monday.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
      key = monday.toISOString().slice(0, 10);
    } else if (period === 'monthly') key = row.date.slice(0, 7);
    else throw new RangeError('La période doit être weekly ou monthly.');
    const list = buckets.get(key) || []; list.push(row); buckets.set(key, list);
  }
  return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([key, values]) => {
    const end = period === 'weekly' ? new Date(`${key}T00:00:00Z`) : new Date(`${key}-01T00:00:00Z`);
    if (period === 'weekly') end.setUTCDate(end.getUTCDate() + 6);
    else end.setUTCMonth(end.getUTCMonth() + 1, 0);
    if (end >= asOf) return [];
    values.sort((a, b) => a.date.localeCompare(b.date));
    return [{ period: key, date: values.at(-1).date, close: values.at(-1).close, finalized: true }];
  });
}

export function calculateIndicators({ daily, smaWeekly = 20, smaMonthly = 12 }) {
  const weekly = aggregateCloses(daily, 'weekly');
  const monthly = aggregateCloses(daily, 'monthly');
  return {
    weekly: { rsi40: rsiWilder(weekly.map((x) => x.close), 40), sma: sma(weekly.map((x) => x.close), smaWeekly) },
    monthly: { rsi40: rsiWilder(monthly.map((x) => x.close), 40), sma: sma(monthly.map((x) => x.close), smaMonthly) },
  };
}
