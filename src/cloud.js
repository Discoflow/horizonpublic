import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './supabase-config.js';

const { createClient } = window.supabase || {};
if (!createClient) throw new Error('Le client Supabase ne s’est pas chargé. Rechargez la page.');

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

export async function searchSymbols(keywords) {
  const { data, error } = await supabase.functions.invoke('search-symbols', { body: { keywords } });
  if (error) throw error;
  return data?.results || [];
}

export async function fetchInitialAssetData(assetId) {
  const { data, error } = await supabase.functions.invoke('fetch-asset', { body: { assetId } });
  if (error) throw error;
  return data;
}

export async function signIn(email, password) {
  const normalizedEmail = email.trim().toLowerCase();
  const { data, error } = await supabase.auth.signInWithPassword({ email: normalizedEmail, password });
  if (error) throw error;
  return data.user;
}

export async function requestPasswordReset(email) {
  const normalizedEmail = email.trim().toLowerCase();
  const redirectTo = `${location.origin}${location.pathname}`;
  const { error } = await supabase.auth.resetPasswordForEmail(normalizedEmail, { redirectTo });
  if (error) throw error;
}

export async function updatePassword(password) {
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function loadAccount(user) {
  const { data: profile, error: profileError } = await supabase
    .from('profiles').select('id,email').eq('id', user.id).maybeSingle();
  if (profileError) throw profileError;
  if (!profile) {
    throw new Error('Ce compte n’a pas encore de profil Horizon autorisé. Contactez l’administrateur.');
  }

  const [prefsResult, itemsResult, alertsResult] = await Promise.all([
    supabase.from('user_preferences').select('*').eq('user_id', user.id).maybeSingle(),
    supabase.from('watchlist_items')
      .select('asset_id,priority,enabled,created_at,asset:assets(id,provider_symbol,asset_type,exchange,quote_currency,name,availability,last_price_at,last_synced_at)')
      .eq('user_id', user.id).order('created_at'),
    supabase.from('alert_rules').select('*').eq('user_id', user.id).order('created_at'),
  ]);
  for (const result of [prefsResult, itemsResult, alertsResult]) if (result.error) throw result.error;

  const itemRows = itemsResult.data || [];
  const assetIds = itemRows.map((row) => row.asset_id);
  const historyByAsset = new Map(assetIds.map((id) => [id, []]));
  const historyResults = await Promise.all(assetIds.map((id) =>
    supabase.from('price_history').select('observation_date,close')
      .eq('asset_id', id).eq('interval', 'daily').order('observation_date').limit(1000)));
  for (let i = 0; i < assetIds.length; i++) {
    const result = historyResults[i];
    if (result.error) throw result.error;
    historyByAsset.set(assetIds[i], (result.data || []).map((row) => ({ date: row.observation_date, close: Number(row.close) })));
  }

  const assets = itemRows.filter((row) => row.asset).map((row) => ({
    id: row.asset.id,
    symbol: row.asset.provider_symbol,
    name: row.asset.name,
    type: row.asset.asset_type,
    currency: row.asset.quote_currency,
    market: row.asset.exchange,
    priority: row.priority,
    enabled: row.enabled,
    available: row.asset.availability === 'available',
    history: historyByAsset.get(row.asset_id) || [],
    createdAt: row.created_at,
  }));
  const alerts = (alertsResult.data || []).map((row) => {
    const asset = assets.find((item) => item.id === row.asset_id);
    const metric = row.indicator === 'distance_sma' ? 'distance' : row.indicator;
    const labelMetric = metric === 'rsi' ? 'RSI' : metric === 'sma' ? 'Cours / SMA' : 'Distance SMA';
    return {
      id: row.id, assetId: row.asset_id, assetSymbol: asset?.symbol || '', metric,
      period: row.period_kind, operator: row.operator, threshold: Number(row.threshold),
      enabled: row.enabled, armed: row.armed, createdAt: row.created_at,
      label: `${labelMetric} ${row.operator === 'below' ? 'sous' : 'au-dessus'} ${row.threshold}`,
      periodLabel: row.period_kind === 'weekly' ? 'Hebdomadaire' : 'Mensuelle',
    };
  });
  const dbPrefs = prefsResult.data || {};
  const prefs = {
    weeklySma: dbPrefs.sma_weekly_period || 20,
    monthlySma: dbPrefs.sma_monthly_period || 12,
    rsiThreshold: Number(dbPrefs.rsi_threshold || 40),
    visible: dbPrefs.dashboard_widgets || ['summary', 'assets', 'alerts'],
    order: ['summary', 'assets', 'alerts'],
    currency: dbPrefs.currency || 'USD',
  };
  return { assets, alerts, prefs, email: profile.email };
}

async function findOrCreateAsset(asset) {
  const row = {
    provider: 'alpha_vantage',
    provider_symbol: asset.symbol.trim().toUpperCase(),
    asset_type: asset.type,
    exchange: asset.market || '',
    quote_currency: (asset.currency || 'USD').toUpperCase(),
  };
  const lookup = () => supabase.from('assets').select('id')
    .eq('provider', row.provider).eq('provider_symbol', row.provider_symbol)
    .eq('asset_type', row.asset_type).eq('exchange', row.exchange)
    .eq('quote_currency', row.quote_currency).maybeSingle();
  let { data, error } = await lookup();
  if (error) throw error;
  if (data) return data.id;
  const insert = await supabase.from('assets').insert({
    ...row, id: asset.id, name: asset.name, availability: 'unknown',
  }).select('id').single();
  if (!insert.error) return insert.data.id;
  if (insert.error.code === '23505') {
    const retry = await lookup();
    if (!retry.error && retry.data) return retry.data.id;
  }
  throw insert.error;
}

export async function saveAssets(user, assets) {
  const resolvedIds = new Set();
  for (const asset of assets) {
    const id = await findOrCreateAsset(asset);
    asset.id = id;
    resolvedIds.add(id);
    const { error } = await supabase.from('watchlist_items').upsert({
      user_id: user.id, asset_id: id, priority: asset.priority, enabled: asset.enabled !== false,
    }, { onConflict: 'user_id,asset_id' });
    if (error) throw error;
    if (!(asset.history || []).length) {
      try {
        const result = await fetchInitialAssetData(id);
        if (result?.history?.length) {
          asset.history = result.history;
          asset.available = true;
        }
      } catch (fetchError) {
        console.warn('Horizon initial market-data fetch deferred', fetchError);
      }
    }
  }
  const current = await supabase.from('watchlist_items').select('asset_id').eq('user_id', user.id);
  if (current.error) throw current.error;
  for (const row of current.data || []) if (!resolvedIds.has(row.asset_id)) {
    const { error } = await supabase.from('watchlist_items').delete()
      .eq('user_id', user.id).eq('asset_id', row.asset_id);
    if (error) throw error;
  }
  return assets;
}

export async function saveAlerts(user, alerts) {
  const current = await supabase.from('alert_rules').select('id').eq('user_id', user.id);
  if (current.error) throw current.error;
  const keep = new Set(alerts.map((alert) => alert.id));
  for (const row of current.data || []) if (!keep.has(row.id)) {
    const { error } = await supabase.from('alert_rules').delete().eq('user_id', user.id).eq('id', row.id);
    if (error) throw error;
  }
  if (!alerts.length) return;
  const rows = alerts.map((alert) => ({
    id: alert.id,
    user_id: user.id,
    asset_id: alert.assetId,
    indicator: alert.metric === 'distance' ? 'distance_sma' : alert.metric,
    period_kind: alert.period,
    operator: alert.operator,
    threshold: alert.threshold,
    enabled: alert.enabled,
    armed: alert.armed !== false,
  }));
  const { error } = await supabase.from('alert_rules').upsert(rows, { onConflict: 'id' });
  if (error) throw error;
}

export async function savePreferences(user, prefs) {
  const { error } = await supabase.from('user_preferences').update({
    currency: prefs.currency || 'USD',
    rsi_threshold: prefs.rsiThreshold || 40,
    sma_weekly_period: prefs.weeklySma || 20,
    sma_monthly_period: prefs.monthlySma || 12,
    dashboard_widgets: prefs.visible || ['summary', 'assets', 'alerts'],
    updated_at: new Date().toISOString(),
  }).eq('user_id', user.id);
  if (error) throw error;
}
