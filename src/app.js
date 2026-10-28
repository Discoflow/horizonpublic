import { calculateIndicators, distancePercent } from './indicators.js';
import { rankRefreshCandidates } from './planner.js';
import { supabase, signIn, requestPasswordReset, updatePassword, signOut, loadAccount, saveAssets, saveAlerts, savePreferences } from './cloud.js';

const $ = (s) => document.querySelector(s);
const store = { assets: 'horizon.assets.v1', alerts: 'horizon.alerts.v1', prefs: 'horizon.prefs.v1' };
const defaultPrefs = () => ({ weeklySma: 20, monthlySma: 12, rsiThreshold: 40, visible: ['summary', 'assets', 'alerts'], order: ['summary', 'assets', 'alerts'], currency: 'USD' });
let currentUser = null; let syncQueue = Promise.resolve();
const cacheKey = (key) => `${key}.${currentUser?.id || 'guest'}`;
const load = (key, fallback) => { try { return JSON.parse(localStorage.getItem(cacheKey(key))) ?? fallback; } catch { return fallback; } };
let assets = []; let alerts = []; let prefs = defaultPrefs();
function syncStatus(label, failed = false) { const card = $('.sync-card'); if (!card) return; card.querySelector('strong').textContent = currentUser ? currentUser.email : 'Connexion sécurisée'; card.querySelector('span').textContent = label; card.querySelector('.sync-indicator').classList.toggle('sync-error', failed); }
function save(key, value) {
  localStorage.setItem(cacheKey(key), JSON.stringify(value));
  if (!currentUser) return;
  const user = currentUser;
  syncStatus('Synchronisation…');
  syncQueue = syncQueue.catch(() => {}).then(async () => {
    if (key === store.assets) await saveAssets(user, value);
    else if (key === store.alerts) await saveAlerts(user, value);
    else if (key === store.prefs) await savePreferences(user, value);
    localStorage.setItem(cacheKey(key), JSON.stringify(value));
    syncStatus('Données synchronisées');
  }).catch((error) => { console.error('Horizon cloud sync failed', error); syncStatus('Synchronisation à vérifier', true); });
}
const safe = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const money = (x, currency = 'USD') => x == null ? '—' : new Intl.NumberFormat('fr-FR', { style: 'currency', currency, maximumFractionDigits: 2 }).format(x);
const date = (d) => d ? new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d.slice(0,10)}T00:00:00Z`)) : 'Indisponible';
const priorityLabel = { high: 'Haute', medium: 'Moyenne', low: 'Basse' };
const typeLabel = { stock: 'Action', etf: 'ETF', crypto: 'Crypto' };
const links = { dashboard: 'Vue d’ensemble', assets: 'Mes actifs', alerts: 'Alertes', data: 'État des données', settings: 'Paramètres', detail: 'Fiche actif' };

function metrics(asset) {
  const daily = [...(asset.history || [])].sort((a,b) => a.date.localeCompare(b.date));
  const result = calculateIndicators({ daily, smaWeekly: asset.smaWeekly || prefs.weeklySma, smaMonthly: asset.smaMonthly || prefs.monthlySma });
  const latest = daily.at(-1)?.close ?? null;
  return { latest, result, weeklyDistance: distancePercent(latest, result.weekly.sma.value), monthlyDistance: distancePercent(latest, result.monthly.sma.value) };
}
function priceState(a) { if (!a.history?.length) return 'Aucun cours'; const hours = (Date.now() - new Date(`${a.history.at(-1).date}T23:59:59Z`)) / 36e5; return hours < 120 ? 'Récent' : 'En retard'; }
function render() {
  const page = location.hash.slice(1).split('/')[0] || 'dashboard';
  document.querySelectorAll('[data-page]').forEach((x) => x.classList.toggle('active', x.dataset.page === page));
  $('#page-crumb').textContent = links[page] || 'Vue d’ensemble'; $('#nav-asset-count').textContent = assets.length;
  const root = $('#page-content');
  if (page === 'dashboard') root.innerHTML = dashboard();
  else if (page === 'assets') root.innerHTML = assetPage();
  else if (page === 'alerts') root.innerHTML = alertPage();
  else if (page === 'data') root.innerHTML = dataPage();
  else if (page === 'settings') root.innerHTML = settingsPage();
  else if (page === 'detail') root.innerHTML = detailPage(decodeURIComponent(location.hash.split('/')[1] || ''));
  bindPageEvents();
  if (page === 'dashboard') applyDashboardPreferences();
}
function applyDashboardPreferences() {
  const page = $('#page-content .page-container'); if (!page) return;
  const blocks = { summary: page.querySelector('.summary-grid'), assets: page.querySelector('.assets-card'), alerts: page.querySelector('.bottom-grid') };
  const visible = new Set(prefs.visible || ['summary','assets','alerts']);
  for (const [key, element] of Object.entries(blocks)) if (element) element.hidden = !visible.has(key);
  for (const key of (prefs.order || ['summary','assets','alerts'])) if (visible.has(key) && blocks[key]) page.append(blocks[key]);
}
function pageHeader(kicker, title, subtitle, button = '') { return `<div class="page-heading"><div><div class="eyebrow">${kicker}</div><h1>${title}</h1><p>${subtitle}</p></div>${button}</div>`; }
function assetRows(rows) { if (!rows.length) return `<tr><td colspan="7"><div class="empty-table"><span class="empty-icon">◈</span><strong>Votre univers commence ici</strong><p>Ajoutez un actif pour suivre ses indicateurs et créer des alertes.</p><button class="button primary add-asset">Ajouter un actif <span>→</span></button></div></td></tr>`;
  return rows.map((a) => { const m = metrics(a); const rsi = m.result.weekly.rsi40.value; return `<tr><td><a class="asset-identity" href="#detail/${encodeURIComponent(a.id)}"><span class="ticker-icon ${a.type}">${safe(a.symbol.slice(0,1))}</span><span><strong>${safe(a.symbol)}</strong><small>${safe(a.name)}</small></span></a></td><td><span class="type-pill">${typeLabel[a.type]}</span></td><td><span class="priority-pill ${a.priority}"><i></i>${priorityLabel[a.priority]}</span></td><td>${money(m.latest, a.currency)}</td><td>${rsi == null ? '<span class="muted">—</span>' : `<span class="rsi-chip ${rsi < 40 ? 'low-rsi' : ''}">${rsi.toFixed(1)}</span>`}</td><td><span class="status-pill ${priceState(a) === 'Récent' ? 'status-good' : 'status-muted'}"><i></i>${priceState(a)}</span></td><td><button class="icon-button row-menu" data-remove="${safe(a.id)}" aria-label="Supprimer ${safe(a.symbol)}">···</button></td></tr>`; }).join('');
}
function dashboard() { const stale = assets.filter((a) => priceState(a) !== 'Récent').length; const button = `<button class="button primary add-asset">＋ <span>Ajouter un actif</span></button>`;
  return `<div class="page-container">${pageHeader('MERCREDI 28 OCTOBRE', 'Une vue claire de vos investissements', 'Vos actifs, leurs tendances et les points qui méritent votre attention.', button)}
  <section class="welcome-banner"><div class="welcome-copy"><span class="banner-label"><i></i> VOTRE ESPACE INVESTISSEUR</span><h2>Investir à son rythme.<br/><em>Voir plus loin.</em></h2><p>Un suivi pensé pour le long terme, sans le bruit des marchés.</p></div><div class="banner-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="orb-core">H</div><span class="art-star star-a">✳</span><span class="art-star star-b">✦</span><div class="art-caption">PATIENCE <span>×</span> PERSPECTIVE</div></div><div class="banner-glow"></div></section>
  <section class="summary-grid"><article class="summary-card"><div class="summary-top"><span>Actifs suivis</span><span class="summary-icon green-icon">◈</span></div><div class="summary-number">${assets.length}<small> / 50</small></div><div class="summary-foot"><span>${assets.filter(a=>a.enabled).length} surveillance${assets.filter(a=>a.enabled).length===1?'':'s'} active${assets.filter(a=>a.enabled).length===1?'':'s'}</span><span class="sparkline">⌁</span></div></article><article class="summary-card"><div class="summary-top"><span>Valeur du portefeuille</span><span class="summary-icon purple-icon">◌</span></div><div class="summary-number">—</div><div class="summary-foot"><span class="muted">Suivi des actifs uniquement</span></div></article><article class="summary-card"><div class="summary-top"><span>Alertes actives</span><span class="summary-icon amber-icon">⌁</span></div><div class="summary-number">${alerts.filter(a=>a.enabled).length}<small> règle${alerts.filter(a=>a.enabled).length===1?'':'s'}</small></div><div class="summary-foot"><a href="#alerts">Gérer mes alertes <span>→</span></a></div></article><article class="summary-card"><div class="summary-top"><span>Qualité des données</span><span class="summary-icon blue-icon">◷</span></div><div class="summary-number ${stale?'number-warn':''}">${assets.length ? `${assets.length-stale}<small> / ${assets.length}</small>` : '—'}</div><div class="summary-foot"><span>${stale ? `${stale} actif${stale === 1 ? '' : 's'} à actualiser` : 'Aucun cours à actualiser'}</span><i class="quality-dot ${stale?'warn':''}"></i></div></article></section>
  <section class="content-card assets-card"><div class="card-heading"><div><div class="eyebrow">VOTRE SÉLECTION</div><h2>Actifs surveillés <span class="inline-count">${assets.length}</span></h2></div><a class="text-link" href="#assets">Voir tous les actifs <span>→</span></a></div><div class="table-wrap"><table><thead><tr><th>ACTIF</th><th>TYPE</th><th>PRIORITÉ</th><th>DERNIER COURS</th><th>RSI 40 · SEM.</th><th>DONNÉES</th><th></th></tr></thead><tbody>${assetRows(assets.slice(0,5))}</tbody></table></div>${assets.length ? `<div class="table-bottom"><span>Affichage de ${Math.min(assets.length,5)} actifs sur ${assets.length}</span><a href="#assets">Gérer mon univers <span>→</span></a></div>` : ''}</section>
  <section class="bottom-grid"><article class="content-card insight-card"><div class="eyebrow">VOTRE REPÈRE HEBDOMADAIRE</div><h3>Les bonnes décisions<br/>aiment le temps long.</h3><p>Le RSI hebdomadaire met en perspective les mouvements récents sur 40 semaines clôturées. Aucun signal quotidien ne vient perturber votre lecture.</p><div class="insight-meta"><span class="mini-icon">⌁</span><span>Indicateur prioritaire</span><b>RSI 40 · Hebdomadaire</b></div></article><article class="content-card setup-card"><div class="setup-visual"><span>◉</span><div class="setup-ring"></div></div><div><div class="eyebrow">PROCHAINE ÉTAPE</div><h3>Connectez vos données</h3><p>${assets.length ? 'Configurez le fournisseur pour importer vos premiers cours.' : 'Ajoutez un actif et configurez Alpha Vantage pour commencer.'}</p><a class="text-link" href="#data">Voir l’état de configuration <span>→</span></a></div></article></section></div>`;
}
function assetPage() { const button = `<button class="button primary add-asset">＋ <span>Ajouter un actif</span></button>`; return `<div class="page-container">${pageHeader('VOTRE UNIVERS', 'Mes actifs', `Suivez jusqu’à 50 actions, ETF et cryptomonnaies. ${assets.length} actif${assets.length===1?'':'s'} dans votre liste.`, button)}<div class="toolbar"><div class="search-box"><span>⌕</span><input id="asset-search" placeholder="Rechercher un actif…" aria-label="Rechercher un actif" /></div><div class="toolbar-right"><select id="asset-sort" aria-label="Trier les actifs"><option value="priority">Priorité d’abord</option><option value="symbol">Nom de l’actif</option><option value="freshness">Fraîcheur des données</option></select><span class="result-count">${assets.length} / 50</span></div></div><section class="content-card assets-card"><div class="table-wrap"><table><thead><tr><th>ACTIF</th><th>TYPE</th><th>PRIORITÉ</th><th>DERNIER COURS</th><th>RSI 40 · SEM.</th><th>DONNÉES</th><th></th></tr></thead><tbody id="asset-table-body">${assetRows(assets)}</tbody></table></div></section><div class="priority-legend"><span><i class="legend-dot high"></i>Haute <small>objectif : 1 jour de marché</small></span><span><i class="legend-dot medium"></i>Moyenne <small>objectif : 2 jours de marché</small></span><span><i class="legend-dot low"></i>Basse <small>objectif : 3 jours de marché</small></span></div></div>`; }
function alertPage() { const button = `<button class="button primary" id="add-alert">＋ <span>Créer une alerte</span></button>`; return `<div class="page-container">${pageHeader('RESTER ATTENTIF, SANS BRUIT', 'Vos alertes', 'Des notifications quand une condition importante se réalise.', button)}${!alerts.length ? `<section class="content-card empty-state"><div class="empty-state-icon">⌁</div><div class="eyebrow">VOTRE ATTENTION, AU BON MOMENT</div><h2>Aucune règle pour le moment</h2><p>Créez une alerte sur le RSI, la SMA ou la distance du cours à sa moyenne mobile.</p><button class="button primary" id="empty-add-alert">Créer ma première alerte <span>→</span></button></section>` : `<section class="content-card alert-list">${alerts.map((a,i)=>`<article class="alert-row"><div class="alert-mark">⌁</div><div class="alert-main"><strong>${safe(a.assetSymbol)} <span>·</span> ${safe(a.label)}</strong><small>${safe(a.periodLabel)} · Seuil ${safe(a.threshold)}</small></div><label class="switch"><input type="checkbox" data-alert-toggle="${i}" ${a.enabled?'checked':''}/><span></span></label><button class="icon-button" data-alert-delete="${i}" aria-label="Supprimer l’alerte">×</button></article>`).join('')}</section>`}</div>`; }
function dataPage() { const stale = rankRefreshCandidates(assets.map(a=>({ ...a, lastSyncedAt: a.lastSyncedAt, available: a.available, enabled: a.enabled }))); return `<div class="page-container">${pageHeader('TRANSPARENCE DES DONNÉES', 'État des données', 'Suivez la fraîcheur des cours, la file d’actualisation et la consommation de votre quota.')}
<section class="summary-grid data-summary"><article class="summary-card"><div class="summary-top"><span>Fournisseur</span><span class="summary-icon blue-icon">◉</span></div><div class="data-number">Alpha Vantage</div><div class="summary-foot"><span>Clé API requise côté serveur</span></div></article><article class="summary-card"><div class="summary-top"><span>Quota journalier</span><span class="summary-icon amber-icon">◷</span></div><div class="data-number">0 <small>/ 20</small></div><div class="summary-foot"><span>25 appels gratuits annoncés · marge de sécurité 5</span></div></article><article class="summary-card"><div class="summary-top"><span>Prochaine actualisation</span><span class="summary-icon green-icon">↻</span></div><div class="data-number">Non planifiée</div><div class="summary-foot"><span>Planificateur à configurer sur Supabase</span></div></article></section>
<section class="content-card data-status-card"><div class="card-heading"><div><div class="eyebrow">SYNCHRONISATION</div><h2>File d’actualisation <span class="inline-count">${stale.length}</span></h2></div><span class="status-pill status-muted"><i></i>Backend non configuré</span></div>${stale.length ? `<div class="queue-list">${stale.map(a=>`<div class="queue-row"><span class="ticker-icon ${a.type}">${safe(a.symbol.slice(0,1))}</span><div><strong>${safe(a.symbol)} · ${safe(a.name)}</strong><small>${Math.floor(a.ageDays)} j sans donnée · priorité ${priorityLabel[a.priority].toLowerCase()}</small></div><span class="status-pill status-warn">En attente</span></div>`).join('')}</div>` : `<div class="empty-state compact"><span class="empty-state-icon">◷</span><h3>Rien dans la file</h3><p>Les actifs en attente apparaîtront ici après configuration du fournisseur.</p></div>`}</section>
<section class="notice-card"><span>ⓘ</span><p><strong>La source n’est pas encore reliée.</strong> Aucun cours n’est affiché tant que le secret Alpha Vantage et le projet Supabase ne sont pas configurés. Consultez <a href="https://www.alphavantage.co/support/#api-key" target="_blank" rel="noreferrer">le site officiel Alpha Vantage</a> pour créer une clé gratuite.</p></section></div>`; }
function settingsPage() { return `<div class="page-container">${pageHeader('VOTRE ESPACE, VOS REPÈRES', 'Paramètres', 'Ajustez les indicateurs et organisez votre tableau de bord.')}
<section class="settings-section"><div class="settings-intro"><div class="eyebrow">INDICATEURS</div><h2>Vos moyennes mobiles</h2><p>Les périodes utilisent des observations hebdomadaires ou mensuelles clôturées.</p></div><div class="content-card settings-card"><label class="setting-row"><span><strong>SMA hebdomadaire</strong><small>Nombre de semaines clôturées</small></span><div class="setting-control"><input type="number" min="2" max="260" value="${prefs.weeklySma}" id="weekly-sma"><span>semaines</span></div></label><label class="setting-row"><span><strong>SMA mensuelle</strong><small>Nombre de mois clôturés</small></span><div class="setting-control"><input type="number" min="2" max="120" value="${prefs.monthlySma}" id="monthly-sma"><span>mois</span></div></label><label class="setting-row"><span><strong>Seuil RSI</strong><small>Valeur de référence pour vos alertes</small></span><div class="setting-control"><input type="number" min="1" max="99" value="${prefs.rsiThreshold || 40}" id="rsi-threshold"><span>points</span></div></label><div class="settings-save"><span id="settings-saved" class="muted">Les changements sont enregistrés automatiquement.</span></div></div></section>
<section class="settings-section"><div class="settings-intro"><div class="eyebrow">TABLEAU DE BORD</div><h2>Votre vue d’ensemble</h2><p>Affichez, masquez et réorganisez les principaux blocs.</p></div><div class="content-card settings-card"><div class="setting-row"><span><strong>Résumé de portefeuille</strong><small>Repères et statut général</small></span><label class="switch"><input type="checkbox" data-widget="summary" ${prefs.visible.includes('summary')?'checked':''}><span></span></label><button class="icon-button order-button" data-move="summary" data-dir="-1" aria-label="Monter le résumé">↑</button><button class="icon-button order-button" data-move="summary" data-dir="1" aria-label="Descendre le résumé">↓</button></div><div class="setting-row"><span><strong>Actifs surveillés</strong><small>Votre sélection et ses indicateurs</small></span><label class="switch"><input type="checkbox" data-widget="assets" ${prefs.visible.includes('assets')?'checked':''}><span></span></label><button class="icon-button order-button" data-move="assets" data-dir="-1" aria-label="Monter les actifs">↑</button><button class="icon-button order-button" data-move="assets" data-dir="1" aria-label="Descendre les actifs">↓</button></div><div class="setting-row"><span><strong>Repères et configuration</strong><small>Informations d’aide et de mise en route</small></span><label class="switch"><input type="checkbox" data-widget="alerts" ${prefs.visible.includes('alerts')?'checked':''}><span></span></label><button class="icon-button order-button" data-move="alerts" data-dir="-1" aria-label="Monter les repères">↑</button><button class="icon-button order-button" data-move="alerts" data-dir="1" aria-label="Descendre les repères">↓</button></div></div></section>
<section class="settings-section"><div class="settings-intro"><div class="eyebrow">NOTIFICATIONS</div><h2>Rester informé</h2><p>Recevez une notification lorsqu’une condition est franchie.</p></div><div class="content-card settings-card push-card"><div><strong>Notifications sur cet appareil</strong><small>Les notifications push nécessitent l’installation de la PWA et la configuration du backend.</small></div><button class="button secondary" id="enable-push">Activer les notifications</button><span id="push-status" class="muted"></span></div></section></div>`; }
function detailPage(id) { const a = assets.find(x=>x.id===id); if(!a) return `<div class="page-container">${pageHeader('FICHE ACTIF','Actif introuvable','Cet actif n’est plus dans votre liste.')}<a href="#assets" class="text-link">← Retour à mes actifs</a></div>`; const m=metrics(a); const cell=(value,suffix='')=>value==null?'—':`${value.toFixed(2)}${suffix}`; return `<div class="page-container">${pageHeader(`${typeLabel[a.type].toUpperCase()} · ${safe(a.market||'MARCHÉ NON PRÉCISÉ')}`, `${safe(a.name)} <span class="detail-symbol">${safe(a.symbol)}</span>`, `${safe(a.market||a.currency)} · ${safe(a.currency)} · Dernière cotation : ${date(a.history?.at(-1)?.date)}`,`<a href="#assets" class="button secondary">← <span>Mes actifs</span></a>`)}<section class="detail-price-card"><div><div class="eyebrow">DERNIER COURS DISPONIBLE</div><div class="detail-price">${money(m.latest,a.currency)}</div><div class="detail-date">${date(a.history?.at(-1)?.date)} <span class="dot-sep">·</span> ${priceState(a)}</div></div><span class="detail-ticker-icon ${a.type}">${safe(a.symbol.slice(0,1))}</span></section><div class="detail-period-grid"><section class="content-card indicator-card"><div class="eyebrow">TENDANCE HEBDOMADAIRE</div><h2>RSI <span>40 semaines</span></h2><div class="indicator-value">${cell(m.result.weekly.rsi40.value)}<small>/ 100</small></div><div class="indicator-rule"></div><div class="indicator-subrow"><span>SMA ${prefs.weeklySma} semaines</span><strong>${money(m.result.weekly.sma.value,a.currency)}</strong></div><div class="indicator-subrow"><span>Distance du cours à la SMA</span><strong>${cell(m.weeklyDistance.value,'%')}</strong></div><div class="indicator-note">${m.result.weekly.rsi40.reason==='insufficient_history'?'40 périodes hebdomadaires clôturées sont nécessaires.':m.latest==null?'Aucun cours enregistré.':'Calculé sur des semaines clôturées.'}</div></section><section class="content-card indicator-card"><div class="eyebrow">TENDANCE MENSUELLE</div><h2>RSI <span>40 mois</span></h2><div class="indicator-value">${cell(m.result.monthly.rsi40.value)}<small>/ 100</small></div><div class="indicator-rule"></div><div class="indicator-subrow"><span>SMA ${prefs.monthlySma} mois</span><strong>${money(m.result.monthly.sma.value,a.currency)}</strong></div><div class="indicator-subrow"><span>Distance du cours à la SMA</span><strong>${cell(m.monthlyDistance.value,'%')}</strong></div><div class="indicator-note">${m.result.monthly.rsi40.reason==='insufficient_history'?'40 périodes mensuelles clôturées sont nécessaires.':m.latest==null?'Aucun cours enregistré.':'Calculé sur des mois clôturés.'}</div></section></div><section class="content-card history-card"><div class="card-heading"><div><div class="eyebrow">SUIVI DANS LE TEMPS</div><h2>Historique des alertes</h2></div><button class="button secondary" data-create-alert-for="${safe(a.id)}">Créer une alerte</button></div>${alerts.filter(x=>x.assetId===a.id).length?alerts.filter(x=>x.assetId===a.id).map(x=>`<div class="history-row"><span class="alert-mark">⌁</span><span><strong>${safe(x.label)}</strong><small>${safe(x.periodLabel)} · ${date(x.createdAt)}</small></span><span class="status-pill status-muted">En attente</span></div>`).join(''):'<div class="empty-state compact"><p>Aucune alerte configurée pour cet actif.</p></div>'}</section></div>`; }
function bindPageEvents() {
  document.querySelectorAll('.add-asset').forEach(b=>b.addEventListener('click',()=>$('#asset-dialog').showModal()));
  document.querySelectorAll('[data-remove]').forEach(b=>b.addEventListener('click',()=>{const a=assets.find(x=>x.id===b.dataset.remove);if(a&&confirm(`Supprimer ${a.symbol} de votre liste ?`)){assets=assets.filter(x=>x.id!==a.id);save(store.assets,assets);render();}}));
  const search=$('#asset-search'), sort=$('#asset-sort'); if(search) {const filter=()=>{let list=assets.filter(a=>`${a.symbol} ${a.name} ${a.type}`.toLowerCase().includes(search.value.toLowerCase()));if(sort.value==='symbol')list.sort((a,b)=>a.symbol.localeCompare(b.symbol));if(sort.value==='priority')list.sort((a,b)=>({high:0,medium:1,low:2}[a.priority]-{high:0,medium:1,low:2}[b.priority]));$('#asset-table-body').innerHTML=assetRows(list);bindPageEvents();}; search.addEventListener('input',filter);sort.addEventListener('change',filter); }
  document.querySelectorAll('[data-alert-toggle]').forEach(el=>el.addEventListener('change',()=>{alerts[Number(el.dataset.alertToggle)].enabled=el.checked;save(store.alerts,alerts);render();}));
  document.querySelectorAll('[data-alert-delete]').forEach(el=>el.addEventListener('click',()=>{alerts.splice(Number(el.dataset.alertDelete),1);save(store.alerts,alerts);render();}));
  ['weekly-sma','monthly-sma','rsi-threshold'].forEach(id=>{const el=$(`#${id}`);if(el)el.addEventListener('change',()=>{const n=Number(el.value);if(!Number.isFinite(n)||n<1)return; prefs[id==='weekly-sma'?'weeklySma':id==='monthly-sma'?'monthlySma':'rsiThreshold']=n;save(store.prefs,prefs);$('#settings-saved').textContent='Préférences enregistrées.';});});
  document.querySelectorAll('[data-widget]').forEach(el=>el.addEventListener('change',()=>{prefs.visible=el.checked?[...new Set([...prefs.visible,el.dataset.widget])]:prefs.visible.filter(x=>x!==el.dataset.widget);save(store.prefs,prefs);}));
  document.querySelectorAll('[data-move]').forEach(el=>el.addEventListener('click',()=>{const order=prefs.order||['summary','assets','alerts'];const i=order.indexOf(el.dataset.move),j=i+Number(el.dataset.dir);if(j<0||j>=order.length)return;[order[i],order[j]]=[order[j],order[i]];prefs.order=order;save(store.prefs,prefs);applyDashboardPreferences();}));
  const addAlert=$('#add-alert')||$('#empty-add-alert'); if(addAlert)addAlert.addEventListener('click',()=>openAlertForm());
  document.querySelectorAll('[data-create-alert-for]').forEach(b=>b.addEventListener('click',()=>{location.hash=`alerts?asset=${encodeURIComponent(b.dataset.createAlertFor)}`;}));
  const push=$('#enable-push');if(push)push.addEventListener('click',enablePush);
}
function openAlertForm() { if(!assets.length){alert('Ajoutez un actif avant de créer une alerte.');return;} const dialog=document.createElement('dialog');dialog.className='modal';dialog.innerHTML=`<form method="dialog" id="alert-form"><div class="modal-heading"><div><span class="eyebrow">ALERTE PERSONNELLE</span><h2>Nouvelle alerte</h2></div><button class="icon-button" value="cancel">×</button></div><label>Actif<select name="assetId">${assets.map(a=>`<option value="${safe(a.id)}">${safe(a.symbol)} · ${safe(a.name)}</option>`).join('')}</select></label><label>Indicateur<select name="metric"><option value="rsi">RSI</option><option value="sma">Cours et SMA</option><option value="distance">Distance à la SMA</option></select></label><div class="form-row"><label>Période<select name="period"><option value="weekly">Hebdomadaire</option><option value="monthly">Mensuelle</option></select></label><label>Condition<select name="operator"><option value="below">Inférieur à</option><option value="above">Supérieur à</option></select></label></div><label>Seuil<input type="number" name="threshold" value="40" step="0.1" required /></label><p class="form-note">Une alerte sera inscrite dans l’application. Les notifications push nécessitent un backend configuré.</p><div class="modal-actions"><button class="button secondary" value="cancel">Annuler</button><button class="button primary" id="alert-submit" value="default">Créer l’alerte <span>→</span></button></div></form>`;document.body.append(dialog);dialog.showModal();dialog.addEventListener('close',()=>dialog.remove());dialog.querySelector('form').addEventListener('submit',e=>{if(!e.submitter||e.submitter.id!=='alert-submit')return;e.preventDefault();const d=new FormData(e.currentTarget),a=assets.find(x=>x.id===d.get('assetId'));const metric=d.get('metric'),period=d.get('period'),operator=d.get('operator'),threshold=Number(d.get('threshold'));if(!a||!Number.isFinite(threshold))return;alerts.push({id:crypto.randomUUID(),assetId:a.id,assetSymbol:a.symbol,metric,period,operator,threshold,enabled:true,createdAt:new Date().toISOString(),label:`${metric==='rsi'?'RSI':metric==='sma'?'Cours / SMA':'Distance SMA'} ${operator==='below'?'sous':'au-dessus'} ${threshold}`,periodLabel:period==='weekly'?'Hebdomadaire':'Mensuelle',armed:true});save(store.alerts,alerts);dialog.close();render();}); }
async function enablePush(){const status=$('#push-status');if(!('Notification'in window)||!('serviceWorker'in navigator)){status.textContent='Notifications non disponibles dans ce navigateur.';return;}try{const permission=await Notification.requestPermission();status.textContent=permission==='granted'?'Autorisation accordée · configuration serveur requise.':`Autorisation ${permission==='denied'?'refusée':'non accordée'}.`;if(permission==='granted')new Notification('Horizon est prêt',{body:'Les notifications apparaîtront lorsque le backend sera configuré.',icon:new URL('icon.svg',location.href).href});}catch{status.textContent='Impossible d’activer les notifications.';}}
$('#asset-form').addEventListener('submit',e=>{if(!e.submitter||e.submitter.id!=='asset-submit')return;e.preventDefault();const d=new FormData(e.currentTarget),symbol=String(d.get('symbol')).trim().toUpperCase(),name=String(d.get('name')).trim();if(!symbol||!name||assets.length>=50)return;const asset={id:crypto.randomUUID(),symbol,name,type:d.get('type'),currency:String(d.get('currency')).trim().toUpperCase(),market:String(d.get('market')).trim(),priority:d.get('priority'),enabled:true,available:true,history:[],createdAt:new Date().toISOString()};if(assets.some(a=>a.symbol===asset.symbol&&a.market===asset.market&&a.type===asset.type)){alert('Cet actif est déjà présent avec le même marché et le même type.');return;}assets.push(asset);save(store.assets,assets);$('#asset-dialog').close();location.hash='#assets';});
function authMessage(text, failed = false) { const el = $('#auth-message'); el.textContent = text; el.classList.toggle('error', failed); }
function showAuthMode(mode = 'login', message = '') {
  document.body.classList.add('auth-locked');
  $('#login-form').hidden = mode !== 'login';
  $('#forgot-password').hidden = mode !== 'login';
  $('#password-reset-form').hidden = mode !== 'reset';
  $('#auth-title').textContent = mode === 'reset' ? 'Choisissez un mot de passe' : 'Bienvenue sur Horizon';
  authMessage(message);
}
async function enterWorkspace(user) {
  try {
    const account = await loadAccount(user);
    currentUser = user;
    assets = account.assets;
    alerts = account.alerts;
    prefs = account.prefs;
    localStorage.setItem(cacheKey(store.assets), JSON.stringify(assets));
    localStorage.setItem(cacheKey(store.alerts), JSON.stringify(alerts));
    localStorage.setItem(cacheKey(store.prefs), JSON.stringify(prefs));
    $('#account-email').textContent = account.email;
    $('.avatar').textContent = account.email.split('@')[0].slice(0, 2).toUpperCase();
    document.body.classList.remove('auth-locked');
    syncStatus('Données synchronisées');
    authMessage('');
    render();
  } catch (error) {
    currentUser = null;
    showAuthMode('login', error.message || 'Connexion impossible. Vérifiez votre compte et réessayez.');
  }
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget, button = form.querySelector('button[type="submit"]');
  button.disabled = true; authMessage('Vérification de votre accès…');
  try { const user = await signIn(form.elements.email.value, form.elements.password.value); await enterWorkspace(user); }
  catch (error) { authMessage(error.message || 'Connexion impossible. Vérifiez votre adresse et votre mot de passe.', true); }
  finally { button.disabled = false; }
});
$('#forgot-password').addEventListener('click', async () => {
  const email = $('#auth-email').value;
  if (!email) { authMessage('Saisissez d’abord votre adresse e-mail.'); $('#auth-email').focus(); return; }
  try { await requestPasswordReset(email); authMessage('Si cette adresse est autorisée, un lien de réinitialisation vient d’être envoyé.'); }
  catch (error) { authMessage(error.message || 'Impossible d’envoyer le lien de réinitialisation.', true); }
});
$('#password-reset-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget, password = form.elements.password.value;
  if (password !== form.elements.confirm.value) { authMessage('Les deux mots de passe ne correspondent pas.', true); return; }
  const button = form.querySelector('button[type="submit"]'); button.disabled = true;
  try {
    await updatePassword(password);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Votre session a expiré. Reconnectez-vous.');
    await enterWorkspace(user);
  } catch (error) { authMessage(error.message || 'Le mot de passe n’a pas pu être modifié.', true); }
  finally { button.disabled = false; }
});
$('#sign-out').addEventListener('click', async () => { try { await signOut(); } catch (error) { console.error(error); syncStatus('Déconnexion à vérifier', true); } });
supabase.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY') showAuthMode('reset', 'Saisissez votre nouveau mot de passe.');
  if (event === 'SIGNED_OUT') {
    currentUser = null; assets = []; alerts = []; prefs = defaultPrefs();
    $('#account-email').textContent = 'Mon espace'; $('.avatar').textContent = 'H';
    showAuthMode('login'); syncStatus('Déconnecté'); render();
  }
});
async function initializeAuth() {
  showAuthMode('login', '');
  const { data, error } = await supabase.auth.getSession();
  if (error) { authMessage('Impossible de vérifier la session. Rechargez la page.', true); return; }
  if (data.session?.user) await enterWorkspace(data.session.user);
}

addEventListener('hashchange',render);$('#year').textContent=new Date().getFullYear();render();void initializeAuth();
if('serviceWorker'in navigator)navigator.serviceWorker.register(new URL('../sw.js',import.meta.url)).catch(()=>{});
