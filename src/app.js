import { calculateIndicators, distancePercent } from './indicators.js';
import { supabase, signIn, requestPasswordReset, updatePassword, signOut, loadAccount, saveAssets, saveAlerts, savePreferences, searchSymbols } from './cloud.js';

const $ = (selector) => document.querySelector(selector);
const store = { assets: 'horizon.assets.v1', alerts: 'horizon.alerts.v1', prefs: 'horizon.prefs.v1' };
const defaultPrefs = () => ({ weeklySma: 20, monthlySma: 12, rsiThreshold: 40, visible: ['summary', 'assets', 'alerts'], order: ['summary', 'assets', 'alerts'], currency: 'USD' });
const links = { dashboard: 'Vue d’ensemble', assets: 'Actions suivies', alerts: 'Alertes', data: 'Données', settings: 'Réglages', detail: 'Fiche action' };
const priorityLabel = { high: 'Haute', medium: 'Moyenne', low: 'Basse' };
const typeLabel = { stock: 'Action', etf: 'ETF', crypto: 'Crypto' };
let currentUser = null;
let syncQueue = Promise.resolve();
let assets = [];
let alerts = [];
let prefs = defaultPrefs();
let chartRange = '3M';
let tickerSelection = null;
let tickerTimer = 0;
let tickerRequest = 0;
let tickerMatches = [];
const tickerCache = new Map();
const cacheKey = (key) => `${key}.${currentUser?.id || 'guest'}`;
const safe = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const money = (value, currency = 'USD') => {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  try { return new Intl.NumberFormat('fr-FR', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value); }
  catch { return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(value); }
};
const date = (value) => value ? new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value.slice(0,10)}T00:00:00Z`)) : '—';
const formatPercent = (value) => value == null || !Number.isFinite(value) ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;

function syncStatus(label, failed = false) {
  const card = $('.sync-card');
  if (!card) return;
  card.querySelector('strong').textContent = currentUser ? 'Synchronisé' : 'Compte déconnecté';
  card.querySelector('span').textContent = label;
  card.querySelector('.sync-indicator').classList.toggle('sync-error', failed);
}
function save(key, value) {
  localStorage.setItem(cacheKey(key), JSON.stringify(value));
  if (!currentUser) return;
  const user = currentUser;
  syncStatus('Enregistrement…');
  syncQueue = syncQueue.catch(() => {}).then(async () => {
    if (key === store.assets) await saveAssets(user, value);
    else if (key === store.alerts) await saveAlerts(user, value);
    else if (key === store.prefs) await savePreferences(user, value);
    localStorage.setItem(cacheKey(key), JSON.stringify(value));
    syncStatus('À jour');
    if (key === store.assets) render();
  }).catch((error) => {
    console.error('Horizon cloud sync failed', error);
    syncStatus('À vérifier', true);
    showToast('La synchronisation a échoué.');
  });
}
function showToast(message) {
  const toast = $('#toast');
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 2600);
}

function metrics(asset) {
  const daily = [...(asset.history || [])].sort((a,b) => a.date.localeCompare(b.date));
  const result = calculateIndicators({ daily, smaWeekly: asset.smaWeekly || prefs.weeklySma, smaMonthly: asset.smaMonthly || prefs.monthlySma });
  const latest = daily.at(-1)?.close ?? null;
  return { daily, latest, result, weeklyDistance: distancePercent(latest, result.weekly.sma.value), monthlyDistance: distancePercent(latest, result.monthly.sma.value) };
}
function priceState(asset) {
  if (!asset.history?.length) return 'En attente';
  const hours = (Date.now() - new Date(`${asset.history.at(-1).date}T23:59:59Z`)) / 36e5;
  return hours < 120 ? 'Récent' : 'Ancien';
}
function changeSincePrevious(history) {
  if (!history || history.length < 2) return null;
  const last = Number(history.at(-1).close);
  const previous = Number(history.at(-2).close);
  return previous ? ((last - previous) / previous) * 100 : null;
}
function pageHeader(title, action = '') {
  return `<div class="page-heading"><div><h1>${title}</h1></div>${action}</div>`;
}
function summaryCard(label, value, note, tone = 'green') {
  return `<article class="summary-card"><div class="summary-top"><span>${label}</span><span class="summary-mark ${tone}"></span></div><div class="summary-number">${value}</div><div class="summary-foot">${note}</div></article>`;
}
function assetRows(rows) {
  if (!rows.length) return `<tr><td colspan="7"><div class="empty-table"><div class="empty-icon">＋</div><strong>Aucune action suivie</strong><button class="button primary add-asset">Rechercher une action</button></div></td></tr>`;
  return rows.map((asset) => {
    const data = metrics(asset);
    const rsi = data.result.weekly.rsi40.value;
    const change = changeSincePrevious(data.daily);
    const priceTone = priceState(asset) === 'Récent' ? 'status-good' : 'status-muted';
    return `<tr><td data-label="Action"><a class="asset-identity" href="#detail/${encodeURIComponent(asset.id)}"><span class="ticker-icon ${asset.type}">${safe(asset.symbol.slice(0,2))}</span><span><strong>${safe(asset.symbol)}</strong><small>${safe(asset.name)}</small></span></a></td><td data-label="Type"><span class="type-pill">${typeLabel[asset.type] || 'Actif'}</span></td><td data-label="Dernier cours"><strong>${money(data.latest,asset.currency)}</strong><small class="change-text ${change != null && change >= 0 ? 'positive' : 'negative'}">${formatPercent(change)}</small></td><td data-label="RSI · sem.">${rsi == null ? '<span class="muted">—</span>' : `<span class="rsi-chip ${rsi < 40 ? 'low-rsi' : ''}">${rsi.toFixed(1)}</span>`}</td><td data-label="Marché"><span class="market-label">${safe(asset.market || asset.currency)}</span></td><td data-label="Cours"><span class="status-pill ${priceTone}"><i></i>${priceState(asset)}</span></td><td data-label="Actions"><button class="icon-button row-menu" data-remove="${safe(asset.id)}" aria-label="Retirer ${safe(asset.symbol)}">×</button></td></tr>`;
  }).join('');
}
function dashboard() {
  const activeAlerts = alerts.filter((alert) => alert.enabled).length;
  const recent = assets.filter((asset) => priceState(asset) === 'Récent').length;
  const types = new Set(assets.map((asset) => asset.type)).size;
  const button = '<button class="button primary add-asset">＋ <span>Ajouter une action</span></button>';
  const freshness = assets.length ? recent + ' / ' + assets.length : '—';
  return `<div class="page-container">${pageHeader('Vue d’ensemble',button)}<section class="summary-grid">${summaryCard('Actions suivies',assets.length,assets.length + ' sur 50')}${summaryCard('Alertes actives',activeAlerts,'Règles enregistrées','blue')}${summaryCard('Types d’actifs',types,assets.length ? 'Actions, ETF ou crypto' : 'Aucun actif','purple')}${summaryCard('Cours récents',freshness,assets.length ? 'Historique disponible' : 'Ajoutez une action',recent === assets.length ? 'green' : 'amber')}</section><section class="content-card assets-card"><div class="card-heading"><h2>Mes actions <span class="inline-count">${assets.length}</span></h2><a class="text-link" href="#assets">Tout voir <span>→</span></a></div><div class="table-wrap"><table><thead><tr><th>ACTIF</th><th>TYPE</th><th>DERNIER COURS</th><th>RSI · SEM.</th><th>MARCHÉ</th><th>COURS</th><th></th></tr></thead><tbody>${assetRows(assets.slice(0,6))}</tbody></table></div></section></div>`;
}
function assetPage() {
  const button = '<button class="button primary add-asset">＋ <span>Ajouter une action</span></button>';
  return `<div class="page-container">${pageHeader('Actions suivies',button)}<div class="toolbar"><div class="search-box"><span>⌕</span><input id="asset-search" placeholder="Rechercher dans ma liste" aria-label="Rechercher une action" /></div><div class="toolbar-right"><select id="asset-sort" aria-label="Trier les actifs"><option value="priority">Priorité</option><option value="symbol">Nom</option><option value="freshness">Plus récent</option></select><span class="result-count">${assets.length} / 50</span></div></div><section class="content-card assets-card"><div class="table-wrap"><table><thead><tr><th>ACTIF</th><th>TYPE</th><th>DERNIER COURS</th><th>RSI · SEM.</th><th>MARCHÉ</th><th>COURS</th><th></th></tr></thead><tbody id="asset-table-body">${assetRows(assets)}</tbody></table></div></section></div>`;
}
function alertPage() {
  const button = '<button class="button primary" id="add-alert">＋ <span>Créer une alerte</span></button>';
  if (!alerts.length) return `<div class="page-container">${pageHeader('Alertes',button)}<section class="content-card empty-state"><div class="empty-state-icon">⌁</div><h2>Aucune alerte</h2><button class="button primary" id="empty-add-alert">Créer une alerte</button></section></div>`;
  return `<div class="page-container">${pageHeader('Alertes',button)}<section class="content-card alert-list">${alerts.map((alert,index) => `<article class="alert-row"><div class="alert-mark">⌁</div><div class="alert-main"><strong>${safe(alert.assetSymbol)} · ${safe(alert.label)}</strong><small>${safe(alert.periodLabel)} · ${safe(alert.threshold)}</small></div><label class="switch"><input type="checkbox" data-alert-toggle="${index}" ${alert.enabled ? 'checked' : ''}/><span></span></label><button class="icon-button" data-alert-delete="${index}" aria-label="Supprimer l’alerte">×</button></article>`).join('')}</section></div>`;
}
function dataPage() {
  const items = assets.map((asset) => `<div class="queue-row"><span class="ticker-icon ${asset.type}">${safe(asset.symbol.slice(0,2))}</span><div><strong>${safe(asset.symbol)} · ${safe(asset.name)}</strong><small>Dernier cours : ${date(asset.history?.at(-1)?.date)}</small></div><span class="status-pill ${priceState(asset) === 'Récent' ? 'status-good' : 'status-muted'}"><i></i>${priceState(asset)}</span></div>`).join('');
  const recent = assets.filter((asset) => priceState(asset) === 'Récent').length;
  return `<div class="page-container">${pageHeader('Données')}<section class="summary-grid data-summary">${summaryCard('Source','Alpha Vantage','Cours de clôture','blue')}${summaryCard('Actions suivies',assets.length,'Historique partagé','purple')}${summaryCard('Cours récents',recent,'Historique reçu','green')}</section><section class="content-card data-status-card"><div class="card-heading"><h2>Derniers cours</h2></div><div class="queue-list">${items || '<div class="empty-state compact"><p>Aucun cours disponible.</p></div>'}</div></section></div>`;
}
function settingsPage() {
  return `<div class="page-container">${pageHeader('Réglages')}<section class="settings-section"><div class="settings-intro"><h2>Indicateurs</h2></div><div class="content-card settings-card"><label class="setting-row"><span><strong>SMA hebdomadaire</strong><small>Période de calcul</small></span><div class="setting-control"><input type="number" min="2" max="260" value="${prefs.weeklySma}" id="weekly-sma"><span>semaines</span></div></label><label class="setting-row"><span><strong>SMA mensuelle</strong><small>Période de calcul</small></span><div class="setting-control"><input type="number" min="2" max="120" value="${prefs.monthlySma}" id="monthly-sma"><span>mois</span></div></label><label class="setting-row"><span><strong>Seuil RSI</strong><small>Valeur de référence</small></span><div class="setting-control"><input type="number" min="1" max="99" value="${prefs.rsiThreshold || 40}" id="rsi-threshold"><span>points</span></div></label></div></section><section class="settings-section"><div class="settings-intro"><h2>Notifications</h2></div><div class="content-card settings-card push-card"><div><strong>Notifications sur cet appareil</strong><small>Les alertes push ne sont pas encore reliées.</small></div><button class="button secondary" id="enable-push">Autoriser</button><span id="push-status" class="muted"></span></div></section></div>`;
}

function chartPoints(asset, range = chartRange) {
  const history = [...(asset.history || [])].sort((a,b) => a.date.localeCompare(b.date));
  const count = range === '1M' ? 22 : range === '3M' ? 66 : Number.POSITIVE_INFINITY;
  return history.slice(-count);
}
function priceChart(asset) {
  const points = chartPoints(asset);
  if (points.length < 2) return '<div class="chart-empty">Les cours apparaîtront ici après la première synchronisation.</div>';
  const width = 860, height = 240, pad = 8;
  const values = points.map((point) => Number(point.close));
  const minimum = Math.min(...values), maximum = Math.max(...values);
  const span = maximum - minimum || Math.max(Math.abs(maximum) * 0.02, 1);
  const coordinates = values.map((value,index) => [pad + index * (width - 2*pad) / (values.length - 1), height - pad - (value - minimum) * (height - 2*pad) / span]);
  const line = coordinates.map((point,index) => `${index ? 'L' : 'M'}${point[0].toFixed(1)} ${point[1].toFixed(1)}`).join(' ');
  const area = `${line} L ${coordinates.at(-1)[0].toFixed(1)} ${height} L ${coordinates[0][0].toFixed(1)} ${height} Z`;
  return `<svg class="price-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Évolution du cours de ${safe(asset.symbol)}"><defs><linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#4eaa70" stop-opacity=".22"/><stop offset="100%" stop-color="#4eaa70" stop-opacity="0"/></linearGradient></defs><path class="chart-area" d="${area}"/><path class="chart-line" d="${line}"/></svg><div class="chart-axis"><span>${date(points[0].date)}</span><span>${date(points.at(-1).date)}</span></div>`;
}
function detailPage(id) {
  const asset = assets.find((item) => item.id === id);
  if (!asset) return `<div class="page-container">${pageHeader('Fiche action')}<section class="content-card empty-state"><h2>Action introuvable</h2><a class="text-link" href="#assets">Retour aux actions</a></section></div>`;
  const data = metrics(asset);
  const history = data.daily;
  const latest = history.at(-1);
  const dailyChange = changeSincePrevious(history);
  const changeAmount = history.length > 1 ? Number(latest.close) - Number(history.at(-2).close) : null;
  const weeklyRsi = data.result.weekly.rsi40.value;
  const monthlyRsi = data.result.monthly.rsi40.value;
  const valueCell = (value,suffix = '') => value == null ? '—' : Number(value).toFixed(2) + suffix;
  const periods = ['1M','3M','Tout'];
  const chartTabs = periods.map((period) => `<button class="chart-tab ${period === chartRange ? 'active' : ''}" data-chart-range="${period}">${period}</button>`).join('');
  const matchingAlerts = alerts.filter((alert) => alert.assetId === asset.id);
  return `<div class="page-container"><div class="detail-head"><a class="back-link" href="#assets">← Actions</a><div class="detail-title"><span class="detail-ticker-icon ${asset.type}">${safe(asset.symbol.slice(0,2))}</span><div><div class="detail-subtitle">${typeLabel[asset.type] || 'Actif'} · ${safe(asset.market || 'Marché')}</div><h1>${safe(asset.name)}</h1><div class="detail-symbol-line">${safe(asset.symbol)} · ${safe(asset.currency)}</div></div></div><button class="button primary add-alert-for" data-create-alert-for="${safe(asset.id)}">Créer une alerte</button></div><section class="detail-price-card"><div class="price-main"><div class="eyebrow">DERNIER COURS DE CLÔTURE</div><div class="detail-price">${money(data.latest,asset.currency)}</div><div class="price-move ${dailyChange != null && dailyChange >= 0 ? 'positive' : 'negative'}">${changeAmount == null ? '—' : money(changeAmount,asset.currency)} <span>(${formatPercent(dailyChange)})</span></div></div><div class="price-date"><span>Mis à jour</span><strong>${date(latest?.date)}</strong></div></section><section class="content-card chart-card"><div class="card-heading"><div><h2>Évolution du cours</h2><span class="muted">Clôture quotidienne</span></div><div class="chart-tabs">${chartTabs}</div></div><div class="chart-body">${priceChart(asset)}</div></section><section class="detail-stat-grid"><article class="content-card stat-card"><span>Devise</span><strong>${safe(asset.currency)}</strong></article><article class="content-card stat-card"><span>Marché</span><strong>${safe(asset.market || '—')}</strong></article><article class="content-card stat-card"><span>Type</span><strong>${typeLabel[asset.type] || '—'}</strong></article><article class="content-card stat-card"><span>Variation jour</span><strong class="${dailyChange != null && dailyChange >= 0 ? 'positive' : 'negative'}">${formatPercent(dailyChange)}</strong></article></section><div class="detail-period-grid"><section class="content-card indicator-card"><div class="eyebrow">HEBDOMADAIRE</div><h2>RSI <span>40 semaines</span></h2><div class="indicator-value">${valueCell(weeklyRsi)}<small>/ 100</small></div><div class="indicator-rule"></div><div class="indicator-subrow"><span>SMA ${prefs.weeklySma} semaines</span><strong>${money(data.result.weekly.sma.value,asset.currency)}</strong></div><div class="indicator-subrow"><span>Distance à la SMA</span><strong>${valueCell(data.weeklyDistance.value,'%')}</strong></div></section><section class="content-card indicator-card"><div class="eyebrow">MENSUELLE</div><h2>RSI <span>40 mois</span></h2><div class="indicator-value">${valueCell(monthlyRsi)}<small>/ 100</small></div><div class="indicator-rule"></div><div class="indicator-subrow"><span>SMA ${prefs.monthlySma} mois</span><strong>${money(data.result.monthly.sma.value,asset.currency)}</strong></div><div class="indicator-subrow"><span>Distance à la SMA</span><strong>${valueCell(data.monthlyDistance.value,'%')}</strong></div></section></div><section class="content-card history-card"><div class="card-heading"><h2>Alertes sur ${safe(asset.symbol)}</h2></div>${matchingAlerts.length ? matchingAlerts.map((alert) => `<div class="history-row"><span class="alert-mark">⌁</span><span><strong>${safe(alert.label)}</strong><small>${safe(alert.periodLabel)}</small></span><span class="status-pill ${alert.enabled ? 'status-good' : 'status-muted'}">${alert.enabled ? 'Active' : 'Pause'}</span></div>`).join('') : '<div class="history-row muted">Aucune alerte</div>'}</section></div>`;
}

function render() {
  const page = location.hash.slice(1).split('/')[0] || 'dashboard';
  document.querySelectorAll('[data-page]').forEach((element) => element.classList.toggle('active',element.dataset.page === page));
  $('#page-crumb').textContent = links[page] || links.dashboard;
  $('#nav-asset-count').textContent = assets.length;
  const root = $('#page-content');
  if (page === 'dashboard') root.innerHTML = dashboard();
  else if (page === 'assets') root.innerHTML = assetPage();
  else if (page === 'alerts') root.innerHTML = alertPage();
  else if (page === 'data') root.innerHTML = dataPage();
  else if (page === 'settings') root.innerHTML = settingsPage();
  else if (page === 'detail') root.innerHTML = detailPage(decodeURIComponent(location.hash.split('/')[1] || ''));
  else root.innerHTML = dashboard();
  bindPageEvents();
}

function bindPageEvents() {
  document.querySelectorAll('.add-asset').forEach((button) => button.addEventListener('click',() => {
    resetAssetForm();
    $('#asset-dialog').showModal();
    setTimeout(() => $('#ticker-search')?.focus(),50);
  }));
  document.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click',() => {
    const asset = assets.find((item) => item.id === button.dataset.remove);
    if (asset && confirm(`Retirer ${asset.symbol} de vos suivis ?`)) {
      assets = assets.filter((item) => item.id !== asset.id);
      save(store.assets,assets);
      render();
      showToast(`${asset.symbol} retiré de vos suivis`);
    }
  }));
  const search = $('#asset-search');
  const sort = $('#asset-sort');
  if (search && sort) {
    const filter = () => {
      let list = assets.filter((asset) => (asset.symbol + ' ' + asset.name + ' ' + asset.type).toLowerCase().includes(search.value.toLowerCase()));
      if (sort.value === 'symbol') list.sort((a,b) => a.symbol.localeCompare(b.symbol));
      if (sort.value === 'priority') list.sort((a,b) => ({high:0,medium:1,low:2}[a.priority] - {high:0,medium:1,low:2}[b.priority]));
      if (sort.value === 'freshness') list.sort((a,b) => (b.history?.at(-1)?.date || '').localeCompare(a.history?.at(-1)?.date || ''));
      $('#asset-table-body').innerHTML = assetRows(list);
      $('#asset-table-body').querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click',() => {
        const asset = assets.find((item) => item.id === button.dataset.remove);
        if (asset && confirm(`Retirer ${asset.symbol} de vos suivis ?`)) {
          assets = assets.filter((item) => item.id !== asset.id);
          save(store.assets,assets);
          render();
        }
      }));
    };
    search.addEventListener('input',filter);
    sort.addEventListener('change',filter);
  }
  document.querySelectorAll('[data-alert-toggle]').forEach((element) => element.addEventListener('change',() => {
    alerts[Number(element.dataset.alertToggle)].enabled = element.checked;
    save(store.alerts,alerts);
    render();
  }));
  document.querySelectorAll('[data-alert-delete]').forEach((element) => element.addEventListener('click',() => {
    alerts.splice(Number(element.dataset.alertDelete),1);
    save(store.alerts,alerts);
    render();
  }));
  ['weekly-sma','monthly-sma','rsi-threshold'].forEach((id) => {
    const input = $('#' + id);
    if (input) input.addEventListener('change',() => {
      const value = Number(input.value);
      if (!Number.isFinite(value) || value < 1) return;
      prefs[id === 'weekly-sma' ? 'weeklySma' : id === 'monthly-sma' ? 'monthlySma' : 'rsiThreshold'] = value;
      save(store.prefs,prefs);
      showToast('Réglages enregistrés');
    });
  });
  const addAlert = $('#add-alert') || $('#empty-add-alert');
  if (addAlert) addAlert.addEventListener('click',() => openAlertForm());
  document.querySelectorAll('[data-create-alert-for]').forEach((button) => button.addEventListener('click',() => openAlertForm(button.dataset.createAlertFor)));
  document.querySelectorAll('[data-chart-range]').forEach((button) => button.addEventListener('click',() => {
    chartRange = button.dataset.chartRange;
    render();
  }));
  const push = $('#enable-push');
  if (push) push.addEventListener('click',enablePush);
}

function wireDialog(dialog) {
  dialog.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click',() => dialog.close()));
  dialog.addEventListener('click',(event) => { if (event.target === dialog) dialog.close(); });
}
function openAlertForm(defaultAssetId = '') {
  if (!assets.length) { showToast('Ajoutez une action avant de créer une alerte.'); return; }
  const dialog = document.createElement('dialog');
  dialog.className = 'modal';
  dialog.innerHTML = `<form id="alert-form"><div class="modal-heading"><div><span class="eyebrow">ALERTE</span><h2>Nouvelle alerte</h2></div><button type="button" class="icon-button" data-close-dialog aria-label="Fermer">×</button></div><label>Action<select name="assetId">${assets.map((asset) => `<option value="${safe(asset.id)}" ${asset.id === defaultAssetId ? 'selected' : ''}>${safe(asset.symbol)} · ${safe(asset.name)}</option>`).join('')}</select></label><label>Indicateur<select name="metric"><option value="rsi">RSI</option><option value="sma">Cours et SMA</option><option value="distance">Distance à la SMA</option></select></label><div class="form-row"><label>Période<select name="period"><option value="weekly">Hebdomadaire</option><option value="monthly">Mensuelle</option></select></label><label>Condition<select name="operator"><option value="below">Inférieur à</option><option value="above">Supérieur à</option></select></label></div><label>Seuil<input type="number" name="threshold" value="40" step="0.1" required /></label><div class="modal-actions"><button type="button" class="button secondary" data-close-dialog>Annuler</button><button class="button primary" type="submit">Créer l’alerte</button></div></form>`;
  document.body.append(dialog);
  wireDialog(dialog);
  dialog.showModal();
  dialog.querySelector('form').addEventListener('submit',(event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const asset = assets.find((item) => item.id === data.get('assetId'));
    const metric = data.get('metric'), period = data.get('period'), operator = data.get('operator'), threshold = Number(data.get('threshold'));
    if (!asset || !Number.isFinite(threshold)) return;
    alerts.push({ id: crypto.randomUUID(), assetId: asset.id, assetSymbol: asset.symbol, metric, period, operator, threshold, enabled: true, createdAt: new Date().toISOString(), label: `${metric === 'rsi' ? 'RSI' : metric === 'sma' ? 'Cours / SMA' : 'Distance SMA'} ${operator === 'below' ? 'sous' : 'au-dessus'} ${threshold}`, periodLabel: period === 'weekly' ? 'Hebdomadaire' : 'Mensuelle', armed: true });
    save(store.alerts,alerts);
    dialog.close();
    dialog.remove();
    render();
    showToast('Alerte créée');
  });
  dialog.addEventListener('close',() => dialog.remove(),{ once: true });
}
async function enablePush() {
  const status = $('#push-status');
  if (!('Notification' in window) || !('serviceWorker' in navigator)) { status.textContent = 'Non disponible'; return; }
  try {
    const permission = await Notification.requestPermission();
    status.textContent = permission === 'granted' ? 'Autorisé' : 'Non autorisé';
  } catch { status.textContent = 'Impossible à activer'; }
}

function resetAssetForm() {
  $('#asset-form').reset();
  tickerSelection = null;
  $('#ticker-results').hidden = true;
  $('#ticker-search').setAttribute('aria-expanded','false');
  $('#selected-security').hidden = true;
  $('#ticker-search-status').textContent = 'Recherchez une action ou un ETF.';
  document.querySelector('.manual-entry').open = false;
}
const tickerSearch = $('#ticker-search');
if (tickerSearch) {
  const resultBox = $('#ticker-results');
  const status = $('#ticker-search-status');
  tickerSearch.addEventListener('keydown',(event) => { if (event.key === 'Enter' && !resultBox.hidden) { event.preventDefault(); resultBox.querySelector('[data-ticker-index]')?.click(); } });
  const showMatches = (matches) => {
    tickerMatches = matches;
    if (!matches.length) {
      resultBox.hidden = true;
      tickerSearch.setAttribute('aria-expanded','false');
      status.textContent = 'Aucun résultat. Essayez un autre nom ou ticker.';
      return;
    }
    resultBox.innerHTML = matches.map((item,index) => `<button type="button" class="ticker-result" role="option" data-ticker-index="${index}"><strong>${safe(item.symbol)}</strong><span>${safe(item.name)}</span><small>${safe(item.typeLabel)} · ${safe(item.region)} · ${safe(item.currency)}</small></button>`).join('');
    resultBox.hidden = false;
    tickerSearch.setAttribute('aria-expanded','true');
    status.textContent = 'Choisissez un résultat.';
  };
  tickerSearch.addEventListener('input',() => {
    clearTimeout(tickerTimer);
    const term = tickerSearch.value.trim();
    resultBox.hidden = true;
    tickerSearch.setAttribute('aria-expanded','false');
    tickerSelection = null;
    $('#selected-security').hidden = true;
    if (term.length < 2) { status.textContent = 'Saisissez au moins deux caractères.'; return; }
    const key = term.toLocaleLowerCase();
    if (tickerCache.has(key)) { showMatches(tickerCache.get(key)); return; }
    const request = ++tickerRequest;
    status.textContent = 'Recherche…';
    tickerTimer = setTimeout(async () => {
      try {
        const matches = await searchSymbols(term);
        if (request !== tickerRequest) return;
        tickerCache.set(key,matches);
        showMatches(matches);
      } catch (error) {
        if (request !== tickerRequest) return;
        status.textContent = 'Recherche indisponible. Utilisez la saisie manuelle.';
        console.warn('Horizon symbol search unavailable',error);
      }
    },450);
  });
  resultBox.addEventListener('click',(event) => {
    const button = event.target.closest('[data-ticker-index]');
    if (!button) return;
    const match = tickerMatches[Number(button.dataset.tickerIndex)];
    if (!match) return;
    tickerSelection = match;
    resultBox.hidden = true;
    tickerSearch.setAttribute('aria-expanded','false');
    $('#selected-security').innerHTML = `<span class="ticker-icon ${match.type}">${safe(match.symbol.slice(0,2))}</span><span><strong>${safe(match.name)}</strong><small>${safe(match.symbol)} · ${safe(match.typeLabel)} · ${safe(match.region)} · ${safe(match.currency)}</small></span><button type="button" class="icon-button" id="clear-selection" aria-label="Changer la sélection">×</button>`;
    $('#selected-security').hidden = false;
    status.textContent = 'Sélection prête à ajouter.';
    $('#clear-selection').addEventListener('click',() => { tickerSelection = null; $('#selected-security').hidden = true; tickerSearch.focus(); });
  });
}
document.querySelector('.manual-entry summary')?.addEventListener('click',() => { tickerSelection = null; $('#selected-security').hidden = true; });

wireDialog($('#asset-dialog'));
$('#asset-form').addEventListener('submit',(event) => {
  if (!event.submitter || event.submitter.id !== 'asset-submit') { event.preventDefault(); return; }
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const manual = (name) => event.currentTarget.querySelector(`[data-manual="${name}"]`).value.trim();
  const chosen = tickerSelection;
  const symbol = String(chosen?.symbol || manual('symbol')).trim().toUpperCase();
  const name = String(chosen?.name || manual('name')).trim();
  const type = chosen?.type || event.currentTarget.querySelector('[data-manual="type"]').value;
  const currency = String(chosen?.currency || manual('currency') || 'USD').trim().toUpperCase();
  const market = String(chosen?.region || manual('market')).trim();
  if (!symbol || !name) {
    $('#ticker-search-status').textContent = 'Choisissez un résultat ou complétez la saisie manuelle.';
    if (!chosen) document.querySelector('.manual-entry').open = true;
    return;
  }
  if (assets.length >= 50) { showToast('La liste est limitée à 50 actifs.'); return; }
  const asset = { id: crypto.randomUUID(), symbol, name, type, currency, market, priority: data.get('priority'), enabled: true, available: true, history: [], createdAt: new Date().toISOString() };
  if (assets.some((item) => item.symbol === asset.symbol && item.market === asset.market && item.type === asset.type)) {
    $('#ticker-search-status').textContent = 'Cet actif figure déjà dans vos suivis.';
    return;
  }
  assets.push(asset);
  save(store.assets,assets);
  $('#asset-dialog').close();
  location.hash = '#assets';
  showToast(`${asset.symbol} ajouté · chargement du cours`);
});

function authMessage(text, failed = false) {
  const element = $('#auth-message');
  element.textContent = text;
  element.classList.toggle('error',failed);
}
function showAuthMode(mode = 'login', message = '') {
  document.body.classList.add('auth-locked');
  $('#login-form').hidden = mode !== 'login';
  $('#forgot-password').hidden = mode !== 'login';
  $('#password-reset-form').hidden = mode !== 'reset';
  $('#auth-title').textContent = mode === 'reset' ? 'Choisissez un mot de passe' : 'Connexion';
  authMessage(message);
}
async function enterWorkspace(user) {
  try {
    const account = await loadAccount(user);
    currentUser = user;
    assets = account.assets;
    alerts = account.alerts;
    prefs = account.prefs;
    localStorage.setItem(cacheKey(store.assets),JSON.stringify(assets));
    localStorage.setItem(cacheKey(store.alerts),JSON.stringify(alerts));
    localStorage.setItem(cacheKey(store.prefs),JSON.stringify(prefs));
    $('#account-email').textContent = account.email;
    $('.avatar').textContent = account.email.split('@')[0].slice(0,2).toUpperCase();
    $('.top-avatar').textContent = account.email.split('@')[0].slice(0,2).toUpperCase();
    document.body.classList.remove('auth-locked');
    syncStatus('À jour');
    authMessage('');
    render();
  } catch (error) {
    currentUser = null;
    showAuthMode('login',error.message || 'Connexion impossible.');
  }
}
$('#login-form').addEventListener('submit',async (event) => {
  event.preventDefault();
  const form = event.currentTarget, button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  authMessage('Vérification…');
  try { const user = await signIn(form.elements.email.value,form.elements.password.value); await enterWorkspace(user); }
  catch (error) { authMessage(error.message || 'Connexion impossible.',true); }
  finally { button.disabled = false; }
});
$('#forgot-password').addEventListener('click',async () => {
  const email = $('#auth-email').value;
  if (!email) { authMessage('Saisissez votre adresse e-mail.'); $('#auth-email').focus(); return; }
  try { await requestPasswordReset(email); authMessage('Si le compte existe, un lien vient d’être envoyé.'); }
  catch (error) { authMessage(error.message || 'Envoi impossible.',true); }
});
$('#password-reset-form').addEventListener('submit',async (event) => {
  event.preventDefault();
  const form = event.currentTarget, password = form.elements.password.value;
  if (password !== form.elements.confirm.value) { authMessage('Les mots de passe ne correspondent pas.',true); return; }
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await updatePassword(password);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Session expirée. Reconnectez-vous.');
    await enterWorkspace(user);
  } catch (error) { authMessage(error.message || 'Modification impossible.',true); }
  finally { button.disabled = false; }
});
$('#sign-out').addEventListener('click',async () => { try { await signOut(); } catch (error) { console.error(error); syncStatus('À vérifier',true); } });
supabase.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY') showAuthMode('reset','Saisissez votre nouveau mot de passe.');
  if (event === 'SIGNED_OUT') {
    currentUser = null;
    assets = [];
    alerts = [];
    prefs = defaultPrefs();
    $('#account-email').textContent = 'Mon espace';
    $('.avatar').textContent = 'H';
    $('.top-avatar').textContent = 'MV';
    showAuthMode('login');
    syncStatus('Déconnecté');
    render();
  }
});
async function initializeAuth() {
  showAuthMode('login','');
  const { data, error } = await supabase.auth.getSession();
  if (error) { authMessage('Impossible de vérifier la session. Rechargez la page.',true); return; }
  if (data.session?.user) await enterWorkspace(data.session.user);
}
addEventListener('hashchange',render);
$('#year').textContent = new Date().getFullYear();
render();
void initializeAuth();
if ('serviceWorker' in navigator) navigator.serviceWorker.register(new URL('../sw.js',import.meta.url)).catch(() => {});
