// app.js — application principale : login chiffré, routing, fiches, recherche.

import { decryptTextContainer, decryptBytesWithKey } from './crypto.js';
import { parseGedcom, formatDate, yearOf } from './gedcom.js';
import { renderTree } from './tree.js';

const DATA_URL = 'data/tree.enc';
const MEDIA_DIR = 'data/media/';
const MAX_GEN = 4; // générations affichées dans l'arbre ascendant

const state = {
  container: null,      // conteneur chiffré (JSON)
  key: null,            // clé AES dérivée (réutilisée pour les photos)
  individuals: null,    // Map id -> individu
  families: null,       // Map id -> famille
};

// Cache des URLs blob d'images déchiffrées (évite de re-déchiffrer).
const imageCache = new Map();

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------- utilitaires
function normalize(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function personLifespan(indi) {
  const b = indi.birth ? yearOf(indi.birth.date) : '';
  const d = indi.death ? yearOf(indi.death.date) : '';
  if (!b && !d) return '';
  return `(${b || '?'}–${d || (indi.death ? '?' : '')})`.replace('–)', ')').replace('(–', '(?–');
}

function mediaEncUrl(file) {
  // On résout toute référence (chemin local ou URL MyHeritage) vers le fichier
  // chiffré data/media/<nom>.enc généré par tools/build.mjs.
  const clean = file.split(/[?#]/)[0];      // retire query/fragment d'URL
  const base = clean.split(/[\\/]/).pop();  // dernier segment = nom de fichier
  return MEDIA_DIR + base + '.enc';
}

// --------------------------------------------------------------------- login
async function loadContainer() {
  const res = await fetch(DATA_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error('Impossible de charger les données (' + res.status + ').');
  return res.json();
}

async function unlock(passphrase, onStage = () => {}) {
  onStage('Chargement du fichier chiffré…');
  if (!state.container) state.container = await loadContainer();
  onStage('Dérivation de la clé + déchiffrement…');
  const { key, text } = await decryptTextContainer(state.container, passphrase);
  onStage('Analyse du GEDCOM…');
  const { individuals, families } = parseGedcom(text);
  if (!individuals.size) throw new Error('EMPTY');
  state.key = key;
  state.individuals = individuals;
  state.families = families;
  sessionStorage.setItem('gen_pass', passphrase);
  onStage('Terminé.');
}

// Déchiffre les images (<img data-enc="…">) présentes dans un conteneur DOM
// et les affiche via une URL blob. Silencieux en cas d'échec.
async function hydrateImages(root) {
  for (const img of root.querySelectorAll('img[data-enc]')) {
    const encPath = img.dataset.enc;
    try {
      if (imageCache.has(encPath)) {
        img.src = imageCache.get(encPath);
        continue;
      }
      const res = await fetch(encPath, { cache: 'no-store' });
      if (!res.ok) throw new Error('404');
      const bytes = await decryptBytesWithKey(state.key, await res.json());
      const url = URL.createObjectURL(new Blob([bytes]));
      imageCache.set(encPath, url);
      img.src = url;
    } catch (e) {
      // Image absente/illisible : on retire l'élément proprement.
      const ph = img.dataset.placeholder;
      if (ph) img.replaceWith(Object.assign(document.createElement('div'), { className: ph, textContent: img.dataset.icon || '' }));
      else img.remove();
    }
  }
}

function renderLogin(errorMsg) {
  $('#app').hidden = true;
  const login = $('#login');
  login.hidden = false;
  login.innerHTML = `
    <form id="login-form" class="login-card" autocomplete="off">
      <h1>🌳 Arbre généalogique</h1>
      <p class="muted">Accès protégé. Entrez le mot de passe.</p>
      <input type="password" id="pw" placeholder="Mot de passe" autocomplete="current-password" autofocus />
      <button type="submit">Déverrouiller</button>
      <p id="login-status" class="muted"></p>
      ${errorMsg ? `<p class="error">${errorMsg}</p>` : ''}
    </form>`;
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('#pw').value;
    const btn = $('#login-form button');
    const status = $('#login-status');
    btn.disabled = true; btn.textContent = 'Déchiffrement…';
    const setStage = (s) => { status.textContent = s; console.log('[unlock]', s); };
    try {
      await unlock(pw, setStage);
      showApp();
    } catch (err) {
      const msg = err.message === 'BAD_PASSWORD' ? 'Mot de passe incorrect.'
        : err.message === 'EMPTY' ? 'Aucun individu trouvé dans les données.'
        : (err && err.message) || String(err);
      console.error('[unlock] échec :', err);
      renderLogin('Bloqué à : « ' + status.textContent + ' » → ' + msg);
    }
  });
}

function logout() {
  sessionStorage.removeItem('gen_pass');
  for (const url of imageCache.values()) URL.revokeObjectURL(url);
  imageCache.clear();
  state.key = null;
  state.individuals = null;
  state.families = null;
  location.hash = '';
  renderLogin();
}

// ------------------------------------------------------------------ shell app
function showApp() {
  $('#login').hidden = true;
  const app = $('#app');
  app.hidden = false;
  app.innerHTML = `
    <header class="topbar">
      <a href="#/" class="brand">🌳 Généalogie</a>
      <form id="search-form" class="search">
        <input type="search" id="q" placeholder="Rechercher une personne…" autocomplete="off" />
      </form>
      <button id="logout" class="link-btn">Déconnexion</button>
    </header>
    <main id="view"></main>`;
  $('#logout').addEventListener('click', logout);
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    location.hash = '#/search/' + encodeURIComponent($('#q').value.trim());
  });
  route();
}

// -------------------------------------------------------------------- routing
function route() {
  if (!state.individuals) return;
  const view = $('#view');
  const hash = location.hash.replace(/^#\/?/, '');
  const [section, ...rest] = hash.split('/');
  const arg = rest.join('/');

  if (section === 'person') renderPerson(view, decodeURIComponent(arg));
  else if (section === 'tree') renderTreeView(view, decodeURIComponent(arg));
  else if (section === 'search') renderSearch(view, decodeURIComponent(arg || ''));
  else renderHome(view);
}

// ---------------------------------------------------------------------- vues
function renderHome(view) {
  const all = [...state.individuals.values()].sort((a, b) =>
    a.surname.localeCompare(b.surname, 'fr') || a.given.localeCompare(b.given, 'fr')
  );
  view.innerHTML = `
    <section class="panel">
      <h2>Bienvenue</h2>
      <p class="muted">${all.length} personnes dans l'arbre. Choisissez un point de départ ou utilisez la recherche.</p>
      <ul class="person-list">
        ${all.slice(0, 30).map(personListItem).join('')}
      </ul>
      ${all.length > 30 ? `<p class="muted">…et ${all.length - 30} autres. Utilisez la recherche.</p>` : ''}
    </section>`;
}

function personListItem(indi) {
  return `<li><a href="#/person/${encodeURIComponent(indi.id)}">
    ${escapeHtml(indi.name)} <span class="muted">${personLifespan(indi)}</span></a></li>`;
}

function renderSearch(view, query) {
  const q = normalize(query);
  const results = q
    ? [...state.individuals.values()].filter((i) => normalize(i.name).includes(q))
    : [];
  const qInput = $('#q');
  if (qInput) qInput.value = query;
  view.innerHTML = `
    <section class="panel">
      <h2>Recherche</h2>
      <p class="muted">${query ? `${results.length} résultat(s) pour « ${escapeHtml(query)} »` : 'Tapez un nom.'}</p>
      <ul class="person-list">${results.map(personListItem).join('')}</ul>
    </section>`;
}

function relatedFamilies(indi) {
  // Familles où l'individu est parent (fams) -> conjoints + enfants.
  return indi.fams.map((fid) => state.families.get(fid)).filter(Boolean);
}

function personCard(id) {
  const p = state.individuals.get(id);
  if (!p) return '';
  return `<a class="mini-card" href="#/person/${encodeURIComponent(id)}">
    <span class="mini-name">${escapeHtml(p.name)}</span>
    <span class="muted">${personLifespan(p)}</span></a>`;
}

function eventLine(label, ev) {
  if (!ev) return '';
  const parts = [];
  if (ev.date) parts.push(formatDate(ev.date));
  if (ev.place) parts.push(escapeHtml(ev.place));
  if (!parts.length) return '';
  return `<div class="event"><span class="event-label">${label}</span> ${parts.join(' · ')}</div>`;
}

function renderPerson(view, id) {
  const p = state.individuals.get(id);
  if (!p) { view.innerHTML = '<section class="panel"><p>Personne introuvable.</p></section>'; return; }

  // Parents & fratrie via la famille FAMC.
  let parents = [];
  let siblings = [];
  if (p.famc.length) {
    const fam = state.families.get(p.famc[0]);
    if (fam) {
      parents = [fam.husb, fam.wife].filter(Boolean);
      siblings = fam.chil.filter((c) => c !== id);
    }
  }

  const fams = relatedFamilies(p);
  const unionsHtml = fams.map((fam) => {
    const spouseId = fam.husb === id ? fam.wife : fam.husb;
    const spouse = spouseId ? personCard(spouseId) : '';
    const marr = eventLine('Mariage', fam.marr);
    const kids = fam.chil.map(personCard).join('');
    return `<div class="union">
      ${spouse ? `<div class="rel-block"><h4>Conjoint·e</h4>${spouse}</div>` : ''}
      ${marr}
      ${kids ? `<div class="rel-block"><h4>Enfants</h4><div class="card-row">${kids}</div></div>` : ''}
    </div>`;
  }).join('');

  const icon = p.sex === 'F' ? '👩' : p.sex === 'M' ? '👨' : '👤';
  const photo = p.media.length
    ? `<img class="portrait" data-enc="${escapeHtml(mediaEncUrl(p.media[0].file))}"
         data-placeholder="portrait placeholder" data-icon="${icon}" alt="${escapeHtml(p.name)}" />`
    : `<div class="portrait placeholder">${icon}</div>`;

  view.innerHTML = `
    <section class="panel person">
      <div class="person-head">
        ${photo}
        <div>
          <h2>${escapeHtml(p.name)} <span class="muted">${personLifespan(p)}</span></h2>
          ${eventLine('Naissance', p.birth)}
          ${eventLine('Décès', p.death)}
          <a class="btn" href="#/tree/${encodeURIComponent(id)}">Voir l'arbre ascendant</a>
        </div>
      </div>

      ${parents.length ? `<div class="rel-block"><h4>Parents</h4><div class="card-row">${parents.map(personCard).join('')}</div></div>` : ''}
      ${siblings.length ? `<div class="rel-block"><h4>Frères et sœurs</h4><div class="card-row">${siblings.map(personCard).join('')}</div></div>` : ''}
      ${unionsHtml}
      ${p.media.length > 1 ? `<div class="rel-block"><h4>Photos</h4><div class="gallery">${
        p.media.map((m) => `<img data-enc="${escapeHtml(mediaEncUrl(m.file))}" alt=""/>`).join('')
      }</div></div>` : ''}
    </section>`;

  hydrateImages(view);
}

function renderTreeView(view, id) {
  const p = state.individuals.get(id);
  view.innerHTML = `
    <section class="panel">
      <div class="tree-head">
        <h2>Arbre de ${p ? escapeHtml(p.name) : ''}</h2>
        <a class="btn" href="#/person/${encodeURIComponent(id)}">← Fiche</a>
      </div>
      <div id="tree-container" class="tree-scroll"></div>
    </section>`;
  renderTree($('#tree-container'), state, id, MAX_GEN, (pid) => {
    location.hash = '#/tree/' + encodeURIComponent(pid);
  });
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ------------------------------------------------------------------ démarrage
window.addEventListener('hashchange', () => {
  if (state.individuals) route();
});

// Fait remonter à l'écran toute erreur JS non gérée (sinon on ne voit rien).
function showGlobalError(what) {
  const status = document.querySelector('#login-status');
  if (status) status.innerHTML = `<span class="error">Erreur : ${escapeHtml(String(what))}</span>`;
  console.error('[global]', what);
}
window.addEventListener('error', (e) => showGlobalError(e.message || e.error));
window.addEventListener('unhandledrejection', (e) => showGlobalError(e.reason && e.reason.message || e.reason));

function renderInsecureContextError() {
  $('#app').hidden = true;
  const login = $('#login');
  login.hidden = false;
  login.innerHTML = `
    <div class="login-card">
      <h1>🌳 Arbre généalogique</h1>
      <p class="error"><strong>Ouverture impossible via un fichier local.</strong></p>
      <p class="muted">Le déchiffrement (WebCrypto) exige un « contexte sécurisé ».
      Il faut ouvrir le site via <code>http://localhost</code> ou <code>https://</code>,
      pas par un double-clic (<code>file://</code>).</p>
      <p class="muted">Lance le script <code>start.command</code> (double-clic), ou en terminal :
      <br><code>python3 -m http.server 8000</code> puis <code>http://localhost:8000</code></p>
    </div>`;
}

async function boot() {
  // WebCrypto (crypto.subtle) n'existe qu'en contexte sécurisé (localhost/https).
  // En file:// il est absent -> on l'explique au lieu de rester bloqué.
  if (!window.isSecureContext || !window.crypto || !crypto.subtle) {
    renderInsecureContextError();
    return;
  }

  // Token via l'URL : #token=... (le fragment n'est jamais envoyé au serveur).
  const tokenMatch = /(?:^#|&)token=([^&]+)/.exec(location.hash);
  const stored = sessionStorage.getItem('gen_pass');
  const auto = tokenMatch ? decodeURIComponent(tokenMatch[1]) : stored;

  if (auto) {
    try {
      await unlock(auto);
      // Nettoie le token de l'URL après usage.
      if (tokenMatch) history.replaceState(null, '', location.pathname + '#/');
      showApp();
      return;
    } catch (_) {
      sessionStorage.removeItem('gen_pass');
    }
  }
  renderLogin();
}

boot();
