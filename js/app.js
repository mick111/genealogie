// app.js — application principale : login chiffré, routing, fiches, recherche.

import { decryptTextContainer, decryptBytesWithKey, encryptText } from './crypto.js';
import { parseGedcom, serializeGedcom, formatDate, yearOf, parseGedcomDateParts, mergeDatePartsFormValue, buildPersonName } from './gedcom.js';
import { renderTree, computeTreeExtents } from './tree.js';
import {
  detectGithubRepo, loadGithubMeta, hasGithubToken, saveGithubSettings,
  clearGithubSettings, publishTree, githubErrorMessage, loadBundledGithubConfig,
} from './github.js';
import {
  authModeAvailable, renderAuthGate, renderAdminPanel, renderAccountPanel, renderPersonLink,
  clearAuthSession, decryptTreeContainer, isMkTree,
} from './auth/boot.js';
import { authSession, canEditPerson, canEditTree, canPublish, needsPersonLink, isAdmin } from './auth/session.js';
import {
  TREE_ID, treeEncUrl, treeMediaDir, storageKey, defaultGithubPath,
} from './trees.js';

const MAX_GEN = 4; // générations affichées dans l'arbre ascendant
let authMode = false;

const state = {
  container: null,      // conteneur chiffré (JSON)
  key: null,            // clé AES dérivée (réutilisée pour les photos)
  individuals: null,    // Map id -> individu
  families: null,       // Map id -> famille
};

// Cache des URLs blob d'images déchiffrées (évite de re-déchiffrer).
const imageCache = new Map();

// Présentation de l'arbre : mode + nombre de générations (ajustables).
const treeView = { mode: 'family', up: 2, down: 2, fit: false };

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
  const clean = file.split(/[?#]/)[0];
  const base = clean.split(/[\\/]/).pop();
  return treeMediaDir(TREE_ID) + base + '.enc';
}

// Une photo est soit intégrée (data URI, ajoutée dans l'app), soit un fichier
// chiffré externe (data/media/*.enc, issu du build initial).
function isInlineMedia(m) { return typeof m?.file === 'string' && m.file.startsWith('data:'); }

function mediaImgTag(m, cls) {
  const c = cls ? ` class="${cls}"` : '';
  return isInlineMedia(m)
    ? `<img${c} src="${escapeHtml(m.file)}" alt="">`
    : `<img${c} data-enc="${escapeHtml(mediaEncUrl(m.file))}" alt="">`;
}

// Redimensionne une image (fichier) en data URI JPEG compact, pour l'intégrer
// dans le GEDCOM sans faire exploser la taille du fichier chiffré.
function fileToDownscaledDataUrl(file, maxDim = 900, quality = 0.78) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('decode'));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function migrateLegacyStorage(treeId) {
  const legacy = localStorage.getItem('gen_data_v1');
  const key = storageKey(treeId);
  if (legacy && !localStorage.getItem(key) && treeId === 'principal') {
    localStorage.setItem(key, legacy);
    localStorage.removeItem('gen_data_v1');
  }
  localStorage.removeItem('gen_tree_id');
}

// --------------------------------------------------------------------- login
async function loadContainer() {
  const key = storageKey(TREE_ID);
  const fetchRemote = async () => {
    const res = await fetch(treeEncUrl(TREE_ID), { cache: 'no-store' });
    if (!res.ok) throw new Error('Impossible de charger les données (' + res.status + ').');
    return res.json();
  };

  const rawLocal = localStorage.getItem(key);
  if (rawLocal) {
    try {
      const local = JSON.parse(rawLocal);
      if (authMode) {
        // Brouillon local : valide seulement s'il est v2 MK et déchiffrable avec la session courante.
        if (!isMkTree(local)) {
          localStorage.removeItem(key);
        } else if (authSession.mkKey) {
          try {
            await decryptTreeContainer(authSession.mkKey, local);
            return local;
          } catch (_) {
            localStorage.removeItem(key);
          }
        }
      } else {
        return local;
      }
    } catch (_) {
      localStorage.removeItem(key);
    }
  }
  return fetchRemote();
}

function hasLocalEdits() {
  return !!localStorage.getItem(storageKey(TREE_ID));
}

// Télécharge le fichier chiffré courant (secours si la publication GitHub échoue).
async function exportData() {
  const text = serializeGedcom(state.individuals, state.families);
  const container = await encryptText(state.key, state.container.kdf, text);
  const blob = new Blob([JSON.stringify(container)], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), {
    href: url, download: 'tree.enc',
  });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  alert('Fichier « tree.enc » téléchargé.');
}

async function publishData() {
  const saved = loadGithubMeta();
  if (!saved?.owner || !saved?.repo || !hasGithubToken()) {
    openGithubSettings(() => publishData());
    return;
  }
  if (!confirm('Publier les modifications en ligne ?\n\nElles deviendront visibles pour les autres après quelques instants.')) return;

  const btn = $('#publish');
  const prev = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Publication…'; }
  try {
    await persist();
    await publishTree(state.key, state.container, (s) => { if (btn) btn.textContent = s; }, TREE_ID);
    localStorage.removeItem(storageKey(TREE_ID));
    updateSyncStatus();
    alert('Modifications publiées en ligne.\n\nLe site sera à jour dans quelques instants.');
  } catch (err) {
    alert('Publication impossible :\n' + githubErrorMessage(err));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = prev || 'Publier'; }
  }
}

function openGithubSettings(onSaved) {
  const detected = detectGithubRepo();
  const saved = loadGithubMeta() || {};
  const meta = {
    owner: saved.owner || detected?.owner || '',
    repo: saved.repo || detected?.repo || '',
    branch: saved.branch || 'main',
    path: defaultGithubPath(TREE_ID),
  };
  const wrap = document.createElement('div');
  wrap.className = 'modal-overlay';
  wrap.innerHTML = `
    <form class="modal-card">
      <h3>Réglages de publication</h3>
      <p class="muted modal-hint">Réglages techniques (à faire une seule fois). La clé d'accès est chiffrée
      (AES-256) avec ta clé de mot de passe et stockée localement ; elle ne quitte ton navigateur que pour publier.</p>
      <label>Propriétaire<input name="owner" value="${escapeHtml(meta.owner || '')}" placeholder="ex. mick111" required></label>
      <label>Dépôt<input name="repo" value="${escapeHtml(meta.repo || '')}" placeholder="ex. genealogie" required></label>
      <label>Branche<input name="branch" value="${escapeHtml(meta.branch || 'main')}"></label>
      <label>Fichier<input name="path" value="${escapeHtml(meta.path || defaultGithubPath(TREE_ID))}"></label>
      <label>Token GitHub (PAT)
        <input name="token" type="password" autocomplete="off"
          placeholder="${hasGithubToken() ? '••••••••  (laisser vide pour conserver)' : 'ghp_… ou github_pat_…'}"
          ${hasGithubToken() ? '' : 'required'}>
      </label>
      <p class="muted modal-hint">Crée un token avec accès en écriture au dépôt
      (<a href="https://github.com/settings/tokens" target="_blank" rel="noopener">github.com/settings/tokens</a>,
      scope <code>repo</code> ou permission « Contents : Read and write »).</p>
      <div class="modal-actions">
        ${hasGithubToken() ? '<button type="button" class="link-btn" data-clear>Oublier le token</button>' : ''}
        <button type="button" class="link-btn" data-cancel>Annuler</button>
        <button type="submit" class="btn">Enregistrer</button>
      </div>
    </form>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelector('[data-cancel]').addEventListener('click', close);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  const clearBtn = wrap.querySelector('[data-clear]');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    if (!confirm('Supprimer le token GitHub enregistré ?')) return;
    clearGithubSettings();
    close();
    updateSyncStatus();
  });
  wrap.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = Object.fromEntries(fd.entries());
    if (!data.token && !hasGithubToken()) {
      alert('Indique un token GitHub.');
      return;
    }
    try {
      await saveGithubSettings(state.key, state.container.kdf, data);
      close();
      updateSyncStatus();
      if (onSaved) onSaved();
    } catch (err) {
      alert(githubErrorMessage(err));
    }
  });
}

function updateSyncStatus() {
  const el = $('#sync-status');
  if (!el) return;
  if (hasLocalEdits()) {
    el.textContent = 'Modifs locales';
    el.className = 'sync-badge unsynced';
    el.title = 'Sauvegardées dans ce navigateur ; publie pour mettre le site en ligne à jour.';
  } else if (hasGithubToken()) {
    el.textContent = 'À jour';
    el.className = 'sync-badge synced';
    el.title = 'Synchronisé avec la version publiée.';
  } else {
    el.textContent = '';
    el.className = 'sync-badge';
    el.title = '';
  }
}

// Re-sérialise + re-chiffre les données et les enregistre en local (localStorage).
async function persist() {
  const text = serializeGedcom(state.individuals, state.families);
  if (isMkTree(state.container) || authSession.mkKey) {
    const { encryptTreeContainer } = await import('./auth/tree-lock.js');
    state.container = await encryptTreeContainer(state.key, text);
  } else {
    if (!state.container?.kdf?.salt) {
      throw new Error('Conteneur chiffré invalide (kdf manquant). Rechargez l’arbre depuis GitHub.');
    }
    state.container = await encryptText(state.key, state.container.kdf, text);
  }
  localStorage.setItem(storageKey(TREE_ID), JSON.stringify(state.container));
}

// ---- modifications du modèle -----------------------------------------------
function nextId(prefix, map) {
  let max = 0;
  const re = new RegExp('^@' + prefix + '(\\d+)@$');
  for (const key of map.keys()) { const m = re.exec(key); if (m) max = Math.max(max, +m[1]); }
  return '@' + prefix + (max + 1) + '@';
}
function makePerson({ given, surname, marriedSurname, sex, birthDate, birthPlace, deathDate, deathPlace }) {
  const id = nextId('I', state.individuals);
  const ms = marriedSurname || '';
  const p = {
    id, given: given || '', surname: surname || '', marriedSurname: ms, sex: sex || '',
    name: buildPersonName({ given, surname, marriedSurname: ms, sex }),
    birth: (birthDate || birthPlace) ? { date: birthDate || '', place: birthPlace || '' } : null,
    death: (deathDate || deathPlace) ? { date: deathDate || '', place: deathPlace || '' } : null,
    famc: [], fams: [], media: [],
  };
  state.individuals.set(id, p);
  return p;
}
function makeFamily(husb, wife) {
  const id = nextId('F', state.families);
  const f = { id, husb: husb || null, wife: wife || null, chil: [], marr: null, div: null };
  state.families.set(id, f);
  return f;
}
function addParent(childId, data) {
  const child = state.individuals.get(childId);
  const parent = makePerson(data);
  let fam = child.famc.length ? state.families.get(child.famc[0]) : null;
  if (!fam) { fam = makeFamily(); fam.chil.push(childId); child.famc.push(fam.id); }
  if (parent.sex === 'F' && !fam.wife) fam.wife = parent.id;
  else if (parent.sex === 'M' && !fam.husb) fam.husb = parent.id;
  else if (!fam.husb) fam.husb = parent.id;
  else if (!fam.wife) fam.wife = parent.id;
  else fam.husb = parent.id; // les deux pris : remplace le père
  parent.fams.push(fam.id);
  return parent.id;
}
function addSpouse(personId, data) {
  const person = state.individuals.get(personId);
  const spouse = makePerson(data);
  const fam = person.sex === 'F' ? makeFamily(spouse.id, personId) : makeFamily(personId, spouse.id);
  person.fams.push(fam.id); spouse.fams.push(fam.id);
  return spouse.id;
}
// familyId : union existante à laquelle rattacher l'enfant, ou null pour créer
// une nouvelle union (enfant d'une autre relation / parent seul).
function addChild(personId, familyId, data) {
  const person = state.individuals.get(personId);
  const child = makePerson(data);
  let fam = familyId ? state.families.get(familyId) : null;
  if (!fam) {
    fam = person.sex === 'F' ? makeFamily(null, personId) : makeFamily(personId, null);
    person.fams.push(fam.id);
  }
  fam.chil.push(child.id); child.famc.push(fam.id);
  return child.id;
}
function editPerson(id, d) {
  const p = state.individuals.get(id);
  p.given = d.given || '';
  p.surname = d.surname || '';
  p.marriedSurname = d.marriedSurname || '';
  p.sex = d.sex || '';
  p.name = buildPersonName(p);
  p.birth = (d.birthDate || d.birthPlace) ? { date: d.birthDate || '', place: d.birthPlace || '' } : null;
  p.death = (d.deathDate || d.deathPlace) ? { date: d.deathDate || '', place: d.deathPlace || '' } : null;
}

// Retire une famille de tous les famc/fams des individus.
function removeFamilyRefs(fid) {
  for (const p of state.individuals.values()) {
    p.fams = p.fams.filter((f) => f !== fid);
    p.famc = p.famc.filter((f) => f !== fid);
  }
}
// Supprime un individu et nettoie toutes les références.
function deletePerson(id) {
  const person = state.individuals.get(id);
  if (!person) return;
  const affected = new Set([...person.fams, ...person.famc]);
  for (const fid of affected) {
    const fam = state.families.get(fid);
    if (!fam) continue;
    if (fam.husb === id) fam.husb = null;
    if (fam.wife === id) fam.wife = null;
    fam.chil = fam.chil.filter((c) => c !== id);
  }
  state.individuals.delete(id);
  // Supprime les familles devenues inutiles (aucun enfant + au plus un conjoint).
  for (const fid of affected) {
    const fam = state.families.get(fid);
    if (!fam) continue;
    const spouses = (fam.husb ? 1 : 0) + (fam.wife ? 1 : 0);
    if (fam.chil.length === 0 && spouses <= 1) {
      state.families.delete(fid);
      removeFamilyRefs(fid);
    }
  }
}
// ---- photos ----------------------------------------------------------------
function addPhoto(id, dataUrl) {
  const p = state.individuals.get(id);
  if (!p) return;
  (p.media ||= []).push({ file: dataUrl, title: '' });
}
function removePhoto(id, index) {
  const p = state.individuals.get(id);
  if (p?.media) p.media.splice(index, 1);
}
function setPortrait(id, index) {
  const p = state.individuals.get(id);
  if (p?.media && index > 0 && index < p.media.length) {
    const [m] = p.media.splice(index, 1);
    p.media.unshift(m);
  }
}

const MONTH_LABELS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

function monthSelectOptions(selected) {
  let html = '<option value="">Mois</option>';
  for (let i = 0; i < 12; i++) {
    const v = String(i + 1).padStart(2, '0');
    html += `<option value="${v}"${selected === v ? ' selected' : ''}>${MONTH_LABELS[i]}</option>`;
  }
  return html;
}

function dateFieldHint(gedDate) {
  const p = parseGedcomDateParts(gedDate);
  if (!p.unparsed) return '';
  return `<span class="date-hint muted">Enregistré : ${escapeHtml(formatDate(gedDate))} — format non éditable ici ; remplis les champs pour la remplacer.</span>`;
}

function dateFields(label, prefix, gedDate) {
  const p = parseGedcomDateParts(gedDate || '');
  return `<label class="date-label">${label}
        <div class="date-row">
          <input type="number" name="${prefix}Day" min="1" max="31" step="1" placeholder="Jour"
            value="${escapeHtml(p.day)}" aria-label="Jour">
          <select name="${prefix}Month" aria-label="Mois">${monthSelectOptions(p.month)}</select>
          <input type="number" name="${prefix}Year" min="1" max="9999" step="1" placeholder="Année"
            value="${escapeHtml(p.year)}" aria-label="Année">
          <button type="button" class="date-cal-btn" data-date-group="${prefix}" title="Calendrier" aria-label="Ouvrir le calendrier">📅</button>
          <input type="date" class="date-cal-native" data-date-group="${prefix}" tabindex="-1" aria-hidden="true">
        </div>
        ${dateFieldHint(gedDate)}
      </label>`;
}

function wireDatePickers(form) {
  form.querySelectorAll('.date-cal-btn').forEach((btn) => {
    const prefix = btn.dataset.dateGroup;
    const native = form.querySelector(`.date-cal-native[data-date-group="${prefix}"]`);
    const dayEl = form.querySelector(`[name="${prefix}Day"]`);
    const monthEl = form.querySelector(`[name="${prefix}Month"]`);
    const yearEl = form.querySelector(`[name="${prefix}Year"]`);
    btn.addEventListener('click', () => {
      const y = yearEl.value.trim();
      const m = monthEl.value;
      const d = dayEl.value.trim();
      if (y && m && d) native.value = `${y}-${m}-${String(d).padStart(2, '0')}`;
      else if (y && m) native.value = `${y}-${m}-01`;
      else native.value = '';
      if (native.showPicker) native.showPicker();
      else { native.focus(); native.click(); }
    });
    native.addEventListener('change', () => {
      if (!native.value) return;
      const [y, m, d] = native.value.split('-');
      yearEl.value = y;
      monthEl.value = m;
      dayEl.value = String(parseInt(d, 10));
    });
  });
}

// ---- modale d'édition ------------------------------------------------------
function openForm(title, initial, onSubmit, extraHtml = '') {
  const i = initial || {};
  const wrap = document.createElement('div');
  wrap.className = 'modal-overlay';
  wrap.innerHTML = `
    <form class="modal-card">
      <h3>${escapeHtml(title)}</h3>
      ${extraHtml}
      <label>Prénom(s)<input name="given" value="${escapeHtml(i.given || '')}" autofocus></label>
      <label>Nom de naissance<input name="surname" value="${escapeHtml(i.surname || '')}"></label>
      <label>Nom marital <span class="muted">(optionnel)</span><input name="marriedSurname" value="${escapeHtml(i.marriedSurname || '')}" placeholder="ex. Dupont"></label>
      <label>Sexe
        <select name="sex">
          <option value=""${!i.sex ? ' selected' : ''}>—</option>
          <option value="M"${i.sex === 'M' ? ' selected' : ''}>Homme</option>
          <option value="F"${i.sex === 'F' ? ' selected' : ''}>Femme</option>
        </select>
      </label>
      ${dateFields('Naissance', 'birth', i.birthDate)}
      <label>Naissance (lieu)<input name="birthPlace" value="${escapeHtml(i.birthPlace || '')}"></label>
      ${dateFields('Décès', 'death', i.deathDate)}
      <label>Décès (lieu)<input name="deathPlace" value="${escapeHtml(i.deathPlace || '')}"></label>
      <div class="modal-actions">
        <button type="button" class="link-btn" data-cancel>Annuler</button>
        <button type="submit" class="btn">Enregistrer</button>
      </div>
    </form>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelector('[data-cancel]').addEventListener('click', close);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  wireDatePickers(wrap.querySelector('form'));
  wrap.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = Object.fromEntries(fd.entries());
    data.birthDate = mergeDatePartsFormValue(data.birthDay, data.birthMonth, data.birthYear, i.birthDate);
    data.deathDate = mergeDatePartsFormValue(data.deathDay, data.deathMonth, data.deathYear, i.deathDate);
    delete data.birthDay; delete data.birthMonth; delete data.birthYear;
    delete data.deathDay; delete data.deathMonth; delete data.deathYear;
    close();
    await onSubmit(data);
  });
}

// Applique une modification puis persiste et navigue vers `goId`.
async function applyEdit(fn, goId) {
  const id = fn();
  await persist();
  updateSyncStatus();
  const target = goId || id;
  if (location.hash === '#/person/' + encodeURIComponent(target)) route();
  else location.hash = '#/person/' + encodeURIComponent(target);
}

async function unlock(passphrase, onStage = () => {}) {
  onStage('Chargement du fichier chiffré…');
  if (!state.container) state.container = await loadContainer();
  let text;
  if (isMkTree(state.container) && authSession.mkKey) {
    onStage('Déchiffrement (clé maître)…');
    text = await decryptTreeContainer(authSession.mkKey, state.container);
    state.key = authSession.mkKey;
  } else {
    onStage('Dérivation de la clé + déchiffrement…');
    const res = await decryptTextContainer(state.container, passphrase);
    text = res.text;
    state.key = res.key;
  }
  onStage('Analyse du GEDCOM…');
  const { individuals, families } = parseGedcom(text);
  if (!individuals.size) throw new Error('EMPTY');
  state.individuals = individuals;
  state.families = families;
  await loadBundledGithubConfig();
  if (!authSession.mkKey) sessionStorage.setItem('gen_pass', passphrase);
  onStage('Terminé.');
}

async function unlockWithMk(mkKey, onStage = () => {}) {
  authSession.mkKey = mkKey;
  authSession.treeKey = mkKey;
  state.container = null;
  await unlock('', onStage);
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
      ${errorMsg ? `<pre class="error err-detail">${escapeHtml(errorMsg)}</pre>` : ''}
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
        : (err && (err.stack || err.message)) || String(err);
      console.error('[unlock] échec :', err);
      renderLogin('Bloqué à : « ' + status.textContent + ' » →\n' + msg);
    }
  });
}

function logout() {
  sessionStorage.removeItem('gen_pass');
  clearAuthSession();
  for (const url of imageCache.values()) URL.revokeObjectURL(url);
  imageCache.clear();
  state.key = null;
  state.individuals = null;
  state.families = null;
  state.container = null;
  location.hash = '';
  if (authMode) renderAuthGate(escapeHtml, afterAuthUnlock);
  else renderLogin();
}

async function afterAuthUnlock(mkKey) {
  try {
    await unlockWithMk(mkKey);
    showApp();
  } catch (err) {
    if (authMode && (err.message === 'BAD_PASSWORD' || err.message === 'LEGACY_TREE')) {
      localStorage.removeItem(storageKey(TREE_ID));
      state.container = null;
      try {
        await unlockWithMk(mkKey);
        showApp();
        return;
      } catch (_) { /* retry échoué */ }
    }
    alert('Impossible de déverrouiller l\'arbre : ' + (err.message === 'BAD_PASSWORD'
      ? 'données locales obsolètes — rechargez la page et réessayez.'
      : (err.message || err)));
    renderAuthGate(escapeHtml, afterAuthUnlock);
  }
}

function topbarMenuItems({ allowPublish, allowExport, withSearch }) {
  const items = [];
  if (authMode) items.push('<a href="#/account" class="topbar-menu-item">Mon compte</a>');
  if (isAdmin()) items.push('<a href="#/admin" class="topbar-menu-item">Administration</a>');
  if (allowPublish) {
    items.push('<button type="button" id="publish" class="topbar-menu-item">Publier les modifications</button>');
    items.push('<button type="button" id="github-settings" class="topbar-menu-item">Réglages de publication</button>');
  }
  if (allowExport) {
    items.push('<button type="button" id="export" class="topbar-menu-item">Télécharger une copie</button>');
  }
  items.push('<button type="button" id="logout" class="topbar-menu-item topbar-menu-danger">Déconnexion</button>');
  const menu = items.length
    ? `<div class="topbar-menu-wrap">
        <button type="button" id="topbar-menu-btn" class="topbar-menu-btn" aria-expanded="false" aria-controls="topbar-menu" aria-label="Menu">☰</button>
        <nav id="topbar-menu" class="topbar-menu" hidden>${items.join('')}</nav>
      </div>`
    : '';
  const search = withSearch
    ? `<form id="search-form" class="search">
        <input type="search" id="q" placeholder="Rechercher…" autocomplete="off" />
      </form>`
    : '';
  return { search, menu };
}

function wireTopbar({ allowPublish, allowExport, withSearch }) {
  const menuBtn = $('#topbar-menu-btn');
  const menu = $('#topbar-menu');
  const closeMenu = () => {
    if (!menu || !menuBtn) return;
    menu.hidden = true;
    menuBtn.setAttribute('aria-expanded', 'false');
  };
  if (menuBtn && menu) {
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menu.hidden;
      menu.hidden = !open;
      menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    if (window._topbarDocClick) document.removeEventListener('click', window._topbarDocClick);
    window._topbarDocClick = (e) => {
      if (menu.hidden) return;
      if (e.target.closest('.topbar-menu-wrap')) return;
      closeMenu();
    };
    document.addEventListener('click', window._topbarDocClick);
  }
  $('#logout')?.addEventListener('click', logout);
  $('#export')?.addEventListener('click', exportData);
  if (allowPublish) {
    $('#publish')?.addEventListener('click', publishData);
    $('#github-settings')?.addEventListener('click', () => openGithubSettings());
  }
  if (withSearch) {
    updateSyncStatus();
    $('#search-form').addEventListener('submit', (e) => {
      e.preventDefault();
      location.hash = '#/search/' + encodeURIComponent($('#q').value.trim());
    });
  }
}

// ------------------------------------------------------------------ shell app
function showApp() {
  if (needsPersonLink()) {
    $('#login').hidden = true;
    const app = $('#app');
    app.hidden = false;
    app.innerHTML = `<header class="topbar">
      <a href="#/" class="brand">🌳 Généalogie</a>
      <span class="topbar-spacer"></span>
      ${authMode ? '<a href="#/account" class="link-btn">Mon compte</a>' : ''}
    </header><main id="view"></main>`;
    renderPersonLink($('#view'), escapeHtml, state, persist);
    return;
  }
  const allowPublish = !authMode || canPublish();
  const allowExport = allowPublish || hasLocalEdits();
  const treeName = 'Généalogie';
  const { search, menu } = topbarMenuItems({ allowPublish, allowExport, withSearch: true });
  $('#login').hidden = true;
  const app = $('#app');
  app.hidden = false;
  app.innerHTML = `
    <header class="topbar">
      <a href="#/" class="brand" title="${treeName}">🌳 <span class="brand-text">${treeName}</span></a>
      ${search}
      <span id="sync-status" class="sync-badge"></span>
      ${menu}
    </header>
    <main id="view"></main>`;
  wireTopbar({ allowPublish, allowExport, withSearch: true });
  route();
}

// -------------------------------------------------------------------- routing
function route() {
  if (!state.individuals) return;
  const view = $('#view');
  const hash = location.hash.replace(/^#\/?/, '');
  const [section, ...rest] = hash.split('/');
  const arg = rest.join('/');

  if (section === 'admin') renderAdminPanel(view, escapeHtml, state, persist);
  else if (section === 'account') renderAccountPanel(view, escapeHtml, state);
  else if (section === 'link-person') renderPersonLink(view, escapeHtml, state, persist);
  else if (section === 'person') renderPerson(view, decodeURIComponent(arg));
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
    ? [...state.individuals.values()].filter((i) =>
      normalize(i.name).includes(q)
      || normalize(i.surname).includes(q)
      || normalize(i.marriedSurname).includes(q))
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
  const first = p.media[0];
  const photo = first
    ? (isInlineMedia(first)
      ? `<img class="portrait" src="${escapeHtml(first.file)}" alt="${escapeHtml(p.name)}" />`
      : `<img class="portrait" data-enc="${escapeHtml(mediaEncUrl(first.file))}"
           data-placeholder="portrait placeholder" data-icon="${icon}" alt="${escapeHtml(p.name)}" />`)
    : `<div class="portrait placeholder">${icon}</div>`;

  const canEdit = !authMode || canEditPerson(id);
  const canEditFam = !authMode || canEditTree();

  view.innerHTML = `
    <section class="panel person">
      <div class="person-head">
        ${photo}
        <div>
          <h2>${escapeHtml(p.name)} <span class="muted">${personLifespan(p)}</span></h2>
          ${eventLine('Naissance', p.birth)}
          ${eventLine('Décès', p.death)}
          <a class="btn" href="#/tree/${encodeURIComponent(id)}">Voir l'arbre</a>
          ${canEdit ? '<button class="btn btn-ghost" data-act="edit">Modifier</button>' : ''}
          ${canEditFam ? '<button class="btn btn-danger" data-act="delete">Supprimer</button>' : ''}
        </div>
      </div>

      <div class="rel-block">
        <h4>Parents ${canEditFam && parents.length < 2 ? '<button class="add-btn" data-act="add-parent">+ ajouter</button>' : ''}</h4>
        <div class="card-row">${parents.map(personCard).join('') || '<span class="muted">Aucun parent renseigné.</span>'}</div>
      </div>
      ${siblings.length ? `<div class="rel-block"><h4>Frères et sœurs</h4><div class="card-row">${siblings.map(personCard).join('')}</div></div>` : ''}
      ${unionsHtml}
      ${canEditFam ? `<div class="rel-block actions-row">
        <button class="add-btn" data-act="add-spouse">+ Conjoint·e</button>
        <button class="add-btn" data-act="add-child">+ Enfant</button>
      </div>` : ''}
      ${(p.media.length || canEdit) ? `<div class="rel-block">
        <h4>Photos ${canEdit ? '<button class="add-btn" data-act="add-photo">+ ajouter</button>' : ''}</h4>
        <div class="gallery">${
          p.media.map((m, idx) => `<figure class="photo">${mediaImgTag(m)}${canEdit ? `<span class="photo-tools">${
            idx > 0 ? `<button class="photo-btn" data-photo-portrait="${idx}" title="Définir comme portrait">★</button>` : ''
          }<button class="photo-btn" data-photo-del="${idx}" title="Supprimer">×</button></span>` : ''}</figure>`).join('')
          || '<span class="muted">Aucune photo.</span>'
        }</div>
      </div>` : ''}
    </section>`;

  hydrateImages(view);

  // Actions d'édition
  const act = (sel, fn) => { const b = view.querySelector(`[data-act="${sel}"]`); if (b) b.addEventListener('click', fn); };
  act('edit', () => openForm('Modifier ' + p.name, {
    given: p.given, surname: p.surname, marriedSurname: p.marriedSurname || '', sex: p.sex,
    birthDate: p.birth?.date, birthPlace: p.birth?.place,
    deathDate: p.death?.date, deathPlace: p.death?.place,
  }, (d) => applyEdit(() => { editPerson(id, d); return id; }, id)));
  act('delete', async () => {
    if (!confirm(`Supprimer « ${p.name} » de l'arbre ?\nLes liens familiaux vers cette personne seront retirés.`)) return;
    deletePerson(id);
    await persist();
    updateSyncStatus();
    location.hash = '#/';
  });
  act('add-parent', () => openForm('Ajouter un parent', {}, (d) => applyEdit(() => addParent(id, d), id)));
  act('add-spouse', () => openForm('Ajouter un·e conjoint·e', {}, (d) => applyEdit(() => addSpouse(id, d), id)));
  act('add-child', () => {
    // Rôle de l'autre parent selon le sexe du focus (comme MyHeritage).
    const role = p.sex === 'M' ? 'mère' : p.sex === 'F' ? 'père' : 'autre parent';
    const Role = role.charAt(0).toUpperCase() + role.slice(1);
    // Unions existantes (autre parent nommé).
    const opts = p.fams.map((fid) => {
      const fam = state.families.get(fid);
      const otherId = fam ? (fam.husb === id ? fam.wife : fam.husb) : null;
      const other = otherId ? state.individuals.get(otherId) : null;
      return `<option value="${fid}">${other ? escapeHtml(other.name) : role + ' non renseigné·e'}</option>`;
    }).join('');
    const extra = `<label>${Role}
      <select name="coparent">
        ${opts}
        <option value="new">${role === 'mère' ? 'Nouvelle mère' : role === 'père' ? 'Nouveau père' : 'Nouveau parent'}…</option>
        <option value="none">Pas de ${role}</option>
      </select>
    </label>`;
    openForm('Ajouter un enfant', {}, (d) => applyEdit(() => {
      // "new" et "none" créent une nouvelle union (l'autre parent pourra être
      // ajouté ensuite via la fiche de l'enfant). Une union existante = son id.
      const famId = (d.coparent === 'new' || d.coparent === 'none') ? null : d.coparent;
      return addChild(id, famId, d);
    }, id), extra);
  });

  // Photos
  act('add-photo', () => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*' });
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const dataUrl = await fileToDownscaledDataUrl(file);
        await applyEdit(() => { addPhoto(id, dataUrl); return id; }, id);
      } catch (_) {
        alert('Image illisible ou format non supporté.');
      }
    });
    input.click();
  });
  view.querySelectorAll('[data-photo-del]').forEach((b) => b.addEventListener('click', () => {
    if (!confirm('Supprimer cette photo ?')) return;
    applyEdit(() => { removePhoto(id, Number(b.dataset.photoDel)); return id; }, id);
  }));
  view.querySelectorAll('[data-photo-portrait]').forEach((b) => b.addEventListener('click', () =>
    applyEdit(() => { setPortrait(id, Number(b.dataset.photoPortrait)); return id; }, id)));
}

function stepper(kind, label, min, max) {
  return `<span class="step" data-min="${min}" data-max="${max}">
    <span class="step-label">${label}</span>
    <button class="step-btn" data-gen="${kind}" data-delta="-1" aria-label="moins">−</button>
    <b id="gen-${kind}">${treeView[kind]}</b>
    <button class="step-btn" data-gen="${kind}" data-delta="1" aria-label="plus">+</button>
  </span>`;
}

const TREE_MODES = [
  { id: 'family', label: 'Famille' },
  { id: 'pedigree', label: 'Pedigree' },
  { id: 'fan', label: 'Éventail' },
];

function applyTreeFit(container) {
  const svg = container?.querySelector('.tree-svg');
  if (!svg) return;
  container.classList.toggle('is-fit', treeView.fit);
  if (treeView.fit) {
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  } else {
    const vb = svg.getAttribute('viewBox');
    if (vb) {
      const [, , w, h] = vb.split(/\s+/).map(Number);
      if (w && h) {
        svg.setAttribute('width', String(w));
        svg.setAttribute('height', String(h));
      }
    }
    svg.removeAttribute('preserveAspectRatio');
  }
}

function renderTreeView(view, id) {
  const p = state.individuals.get(id);
  const extents = () => computeTreeExtents(state, id);

  const updateFullscreenBtn = () => {
    const btn = view.querySelector('#tree-fullscreen');
    const stage = view.querySelector('#tree-stage');
    if (!btn || !stage) return;
    const on = document.fullscreenElement === stage || stage.classList.contains('is-pseudo-fullscreen');
    btn.textContent = on ? 'Quitter le plein écran' : 'Plein écran';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  };

  const toggleFullscreen = () => {
    const stage = view.querySelector('#tree-stage');
    if (!stage) return;
    if (document.fullscreenElement === stage || stage.classList.contains('is-pseudo-fullscreen')) {
      if (document.fullscreenElement === stage) document.exitFullscreen();
      stage.classList.remove('is-pseudo-fullscreen');
    } else {
      const req = stage.requestFullscreen || stage.webkitRequestFullscreen;
      if (req) {
        req.call(stage).catch(() => stage.classList.add('is-pseudo-fullscreen'));
      } else {
        stage.classList.add('is-pseudo-fullscreen');
      }
    }
    updateFullscreenBtn();
  };

  const showAllTree = () => {
    const ext = extents();
    if (treeView.mode === 'family') {
      treeView.up = ext.maxUp;
      treeView.down = ext.maxDown;
    } else {
      treeView.up = Math.max(1, ext.maxUp);
    }
    treeView.fit = true;
    draw();
  };

  const draw = () => {
    const ext = extents();
    view.querySelectorAll('.tree-tab').forEach((t) =>
      t.classList.toggle('active', t.dataset.mode === treeView.mode));

    const controls = view.querySelector('#tree-controls');
    controls.innerHTML =
      (treeView.mode === 'family'
        ? stepper('up', 'Ancêtres', 0, ext.maxUp) + stepper('down', 'Descendants', 0, ext.maxDown)
        : stepper('up', 'Générations', 1, Math.max(1, ext.maxUp))) +
      `<button type="button" class="btn btn-ghost tree-action" id="tree-show-all">Tout l'arbre</button>` +
      `<button type="button" class="btn btn-ghost tree-action${treeView.fit ? ' active' : ''}" id="tree-fit" aria-pressed="${treeView.fit ? 'true' : 'false'}">Ajuster à l'écran</button>` +
      `<button type="button" class="btn btn-ghost tree-action" id="tree-fullscreen" aria-pressed="false">Plein écran</button>` +
      `<span class="muted">Cliquez une personne pour recentrer l'arbre.</span>`;

    controls.querySelectorAll('.step-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const k = btn.dataset.gen;
        const step = btn.closest('.step');
        const min = Number(step.dataset.min), max = Number(step.dataset.max);
        treeView[k] = Math.max(min, Math.min(max, treeView[k] + Number(btn.dataset.delta)));
        controls.querySelector('#gen-' + k).textContent = treeView[k];
        treeView.fit = false;
        drawTree();
      });
    });
    controls.querySelector('#tree-show-all').addEventListener('click', showAllTree);
    controls.querySelector('#tree-fit').addEventListener('click', () => {
      treeView.fit = !treeView.fit;
      drawTree();
    });
    controls.querySelector('#tree-fullscreen').addEventListener('click', toggleFullscreen);
    updateFullscreenBtn();
    drawTree();
  };

  const drawTree = () => {
    const container = $('#tree-container');
    renderTree(
      container, state, id,
      (pid) => { location.hash = '#/tree/' + encodeURIComponent(pid); },
      { mode: treeView.mode, up: treeView.up, down: treeView.down },
    );
    applyTreeFit(container);
    view.querySelector('#tree-fit')?.classList.toggle('active', treeView.fit);
    view.querySelector('#tree-fit')?.setAttribute('aria-pressed', treeView.fit ? 'true' : 'false');
  };

  view.innerHTML = `
    <section class="panel tree-panel">
      <div class="tree-head">
        <h2>${p ? escapeHtml(p.name) : ''}</h2>
        <a class="btn" href="#/person/${encodeURIComponent(id)}">← Fiche</a>
      </div>
      <div id="tree-stage" class="tree-stage">
        <div class="tree-tabs">
          ${TREE_MODES.map((m) => `<button class="tree-tab" data-mode="${m.id}">${m.label}</button>`).join('')}
        </div>
        <div id="tree-controls" class="tree-controls"></div>
        <div id="tree-container" class="tree-scroll"></div>
      </div>
    </section>`;

  view.querySelectorAll('.tree-tab').forEach((t) => {
    t.addEventListener('click', () => { treeView.mode = t.dataset.mode; treeView.fit = false; draw(); });
  });
  view.querySelector('#tree-stage').addEventListener('fullscreenchange', updateFullscreenBtn);
  draw();
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
  if (!window.isSecureContext || !window.crypto || !crypto.subtle) {
    renderInsecureContextError();
    return;
  }

  renderSiteVersion();
  migrateLegacyStorage(TREE_ID);

  authMode = await authModeAvailable();

  if (authMode) {
    renderAuthGate(escapeHtml, afterAuthUnlock);
    return;
  }

  const tokenMatch = /(?:^#|&)token=([^&]+)/.exec(location.hash);
  const stored = sessionStorage.getItem('gen_pass');
  const auto = tokenMatch ? decodeURIComponent(tokenMatch[1]) : stored;

  if (auto) {
    try {
      await unlock(auto);
      if (tokenMatch) history.replaceState(null, '', location.pathname + '#/');
      showApp();
      return;
    } catch (_) {
      sessionStorage.removeItem('gen_pass');
    }
  }
  renderLogin();
}

async function renderSiteVersion() {
  const el = document.getElementById('site-version');
  if (!el) return;
  try {
    const res = await fetch('version.json', { cache: 'no-store' });
    if (!res.ok) return;
    const { commit } = await res.json();
    if (!commit) return;
    const detected = detectGithubRepo();
    let owner = detected?.owner;
    let repo = detected?.repo;
    if (!owner || !repo) {
      const meta = loadGithubMeta();
      owner = meta?.owner;
      repo = meta?.repo;
    }
    if (!owner || !repo) {
      const metaRes = await fetch('data/github_meta.json', { cache: 'no-store' });
      if (metaRes.ok) {
        const meta = await metaRes.json();
        owner = meta.owner;
        repo = meta.repo;
      }
    }
    if (owner && repo) {
      const url = `https://github.com/${owner}/${repo}/commit/${encodeURIComponent(commit)}`;
      el.innerHTML = `Version <a href="${url}" target="_blank" rel="noopener">${escapeHtml(commit)}</a>`;
    } else {
      el.textContent = `Version ${commit}`;
    }
    el.hidden = false;
  } catch (_) { /* version.json absent */ }
}

boot();
