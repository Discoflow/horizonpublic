const TARGET_DAYS = { high: 1, medium: 2, low: 3 };
export function rankRefreshCandidates(items, now = new Date()) {
  return items.filter((x) => x.enabled && x.available !== false).map((item) => {
    const last = item.lastSyncedAt ? new Date(item.lastSyncedAt) : null;
    const ageDays = last ? Math.max(0, (now - last) / 86_400_000) : 3650;
    const overdue = ageDays / (TARGET_DAYS[item.priority] || 2);
    return { ...item, ageDays, overdue, due: overdue >= 1 };
  }).filter((x) => x.due).sort((a, b) => b.overdue - a.overdue || ({ high: 0, medium: 1, low: 2 }[a.priority] - { high: 0, medium: 1, low: 2 }[b.priority]));
}
export function selectWithinQuota(items, remainingCalls, cost = () => 1) {
  let left = Math.max(0, remainingCalls);
  const chosen = [];
  for (const item of items) { const calls = cost(item); if (!Number.isInteger(calls) || calls < 1) throw new RangeError('Coût de requête invalide.'); if (calls <= left) { chosen.push({ item, calls }); left -= calls; } }
  return { chosen, remainingCalls: left, deferred: items.filter((item) => !chosen.some((x) => x.item.id === item.id)) };
}
