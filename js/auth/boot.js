// Écran d'authentification passkey + inscription auto (option B).

import { loadSiteConfig } from './site.js';
import { registerPasskey, authenticatePasskey, wrapMkRawWithPrf, unwrapMkWithPrfRaw } from './webauthn.js';
import { validatePin, wrapMkRawWithPin, unwrapMkWithPin } from './pin.js';
import {
  loadRegistry, saveRegistry, loadPending, appendPending,
  findBootstrapAdmin, findUserByCredential, ROLES,
} from './registry.js';
import { authSession, setAuthSession, clearAuthSession, isAdmin } from './session.js';
import { decryptTreeContainer, isMkTree } from './tree-lock.js';
import { githubErrorMessage } from '../github.js';

const $ = (sel) => document.querySelector(sel);

export async function authModeAvailable() {
  try {
    await loadSiteConfig();
    return true;
  } catch (_) {
    return false;
  }
}

async function unwrapUserMk(user, pin) {
  if (!user.pinWrap) throw new Error('NO_PIN_WRAP');
  return unwrapMkWithPin(user.pinWrap, user.id, pin);
}

async function ensurePrfWrap(user, mkRaw, registry) {
  if (user.prfWrap || !user.credentialId) return user;
  try {
    const auth = await authenticatePasskey(user.credentialId);
    if (!auth.prfBytes) return user;
    user.prfWrap = await wrapMkRawWithPrf(mkRaw, auth.prfBytes);
    const idx = registry.users.findIndex((u) => u.id === user.id);
    if (idx >= 0) registry.users[idx] = user;
    await saveRegistry(registry);
  } catch (_) { /* PRF optionnel — PIN secours reste disponible */ }
  return user;
}

async function loginWithPasskey(registry, statusEl, escapeHtml, onUnlocked) {
  const auth = await authenticatePasskey();
  const user = findUserByCredential(registry, auth.credentialId);
  if (!user) throw new Error('Compte non reconnu.');
  if (!user.prfWrap) {
    throw new Error('Utilisez votre PIN secours une fois pour activer la connexion passkey.');
  }
  if (!auth.prfKey) throw new Error('Passkey sans PRF — utilisez le PIN secours.');
  const { mkKey, mkRaw } = await unwrapMkWithPrfRaw(user.prfWrap, auth.prfKey);
  setAuthSession(user, mkKey, registry, mkRaw);
  if (statusEl) statusEl.textContent = 'Connecté.';
  await onUnlocked(mkKey);
}

export async function unlockMkForUser(user, pin) {
  const { mkKey } = await unwrapUserMk(user, pin);
  return mkKey;
}

export function renderAuthGate(escapeHtml, onUnlocked) {
  $('#app').hidden = true;
  const login = $('#login');
  login.hidden = false;

  const show = (html) => { login.innerHTML = html; };

  const screenHome = () => {
    show(`
      <div class="login-card">
        <h1>🌳 Généalogie</h1>
        <p class="muted">Connexion sécurisée par passkey.</p>
        <button type="button" class="btn" id="btn-login" style="width:100%;margin-top:1rem">Se connecter</button>
        <button type="button" class="link-btn" id="btn-register" style="width:100%;margin-top:.6rem">Créer un compte</button>
        <p id="auth-status" class="muted" style="margin-top:1rem"></p>
      </div>`);
    $('#btn-login').addEventListener('click', screenLogin);
    $('#btn-register').addEventListener('click', screenRegister);
  };

  const screenLogin = async () => {
    const registry = await loadRegistry();
    const bootstrap = findBootstrapAdmin(registry);
    show(`
      <div class="login-card">
        <h1>Connexion</h1>
        ${bootstrap
          ? '<p class="muted">Première connexion admin : utilisez votre PIN secours (8 chiffres), puis créez votre passkey.</p>'
          : `<button type="button" class="btn" id="btn-passkey" style="width:100%">Se connecter avec passkey</button>
             <p class="muted" style="text-align:center;margin:.8rem 0">ou PIN secours</p>`}
        <form id="auth-form">
          <label>PIN secours (8 chiffres)<input name="pin" inputmode="numeric" pattern="[0-9]{8}" maxlength="8" autocomplete="off" required></label>
          <button type="submit" class="btn" style="width:100%;margin-top:.8rem">${bootstrap ? 'Continuer' : 'Connexion PIN'}</button>
        </form>
        <button type="button" class="link-btn" id="back" style="margin-top:.6rem">← Retour</button>
        <p id="auth-status" class="muted"></p>
      </div>`);
    $('#back').addEventListener('click', screenHome);
    const passkeyBtn = $('#btn-passkey');
    if (passkeyBtn) {
      passkeyBtn.addEventListener('click', async () => {
        const status = $('#auth-status');
        passkeyBtn.disabled = true;
        status.textContent = 'Passkey…';
        try {
          await loginWithPasskey(registry, status, escapeHtml, onUnlocked);
        } catch (err) {
          status.innerHTML = `<span class="error">${escapeHtml(err.message || String(err))}</span>`;
          passkeyBtn.disabled = false;
        }
      });
    }
    $('#auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const pin = new FormData(e.target).get('pin');
      const status = $('#auth-status');
      try {
        if (bootstrap) {
          const { mkKey, mkRaw } = await unwrapUserMk(bootstrap, pin);
          setAuthSession(bootstrap, mkKey, registry, mkRaw);
          screenAdminPasskeySetup(bootstrap, mkKey, mkRaw, pin, registry, onUnlocked);
          return;
        }
        const users = registry.users.filter((u) => u.status === 'approved' && u.pinWrap);
        let user = null;
        let mkKey = null;
        let mkRaw = null;
        for (const u of users) {
          try {
            ({ mkKey, mkRaw } = await unwrapUserMk(u, pin));
            user = u;
            break;
          } catch (_) { /* PIN incorrect pour cet utilisateur */ }
        }
        if (!user) throw new Error('PIN inconnu.');
        status.textContent = user.prfWrap ? 'Connecté.' : 'Activation passkey…';
        user = await ensurePrfWrap(user, mkRaw, registry);
        setAuthSession(user, mkKey, registry, mkRaw);
        status.textContent = 'Connecté.';
        await onUnlocked(mkKey);
      } catch (err) {
        status.innerHTML = `<span class="error">${escapeHtml(err.message || String(err))}</span>`;
      }
    });
  };

  const screenRegister = () => {
    show(`
      <form id="reg-form" class="login-card">
        <h1>Créer un compte</h1>
        <p class="muted">Votre demande sera envoyée automatiquement à l'administrateur.</p>
        <label>Votre prénom / nom<input name="displayName" required autofocus></label>
        <label>PIN secours (8 chiffres)<input name="pin" inputmode="numeric" pattern="[0-9]{8}" maxlength="8" required></label>
        <button type="submit" class="btn" style="width:100%;margin-top:.8rem">Créer passkey et envoyer</button>
        <button type="button" class="link-btn" id="back" style="margin-top:.6rem">← Retour</button>
        <p id="auth-status" class="muted"></p>
      </form>`);
    $('#back').addEventListener('click', screenHome);
    $('#reg-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const displayName = fd.get('displayName').trim();
      const pin = fd.get('pin');
      const status = $('#auth-status');
      const btn = e.target.querySelector('button[type=submit]');
      if (!validatePin(pin)) { status.textContent = 'PIN : 8 chiffres requis.'; return; }
      btn.disabled = true;
      status.textContent = 'Création passkey…';
      try {
        const reg = await registerPasskey(displayName);
        status.textContent = 'Envoi de la demande sur GitHub…';
        await appendPending({
          id: reg.userId,
          displayName: reg.displayName,
          credentialId: reg.credentialId,
          publicKey: reg.publicKey,
          pinHint: true,
          createdAt: new Date().toISOString(),
          status: 'pending',
        });
        show(`
          <div class="login-card">
            <h1>Demande envoyée</h1>
            <p class="muted">Un administrateur validera votre compte. Revenez après validation pour vous connecter.</p>
            <button type="button" class="btn" id="ok" style="width:100%;margin-top:1rem">OK</button>
          </div>`);
        $('#ok').addEventListener('click', screenHome);
      } catch (err) {
        status.innerHTML = `<span class="error">${escapeHtml(githubErrorMessage(err) || err.message)}</span>`;
        btn.disabled = false;
      }
    });
  };

  const screenAdminPasskeySetup = async (user, mkKey, mkRaw, loginPin, registry, onUnlocked) => {
    show(`
      <div class="login-card">
        <h1>Passkey administrateur</h1>
        <p class="muted">Créez votre passkey pour remplacer le PIN comme méthode principale.</p>
        <button type="button" class="btn" id="mk-passkey" style="width:100%">Créer passkey admin</button>
        <p id="auth-status" class="muted"></p>
      </div>`);
    $('#mk-passkey').addEventListener('click', async () => {
      const status = $('#auth-status');
      try {
        const reg = await registerPasskey(user.displayName, user.id);
        user.credentialId = reg.credentialId;
        user.publicKey = reg.publicKey;
        user.needsPasskey = false;
        user.pinWrap = await wrapMkRawWithPin(mkRaw, user.id, loginPin);
        if (reg.prfBytes) user.prfWrap = await wrapMkRawWithPrf(mkRaw, reg.prfBytes);
        const idx = registry.users.findIndex((u) => u.id === user.id);
        registry.users[idx] = user;
        status.textContent = 'Publication registry…';
        await saveRegistry(registry);
        setAuthSession(user, mkKey, registry, mkRaw);
        await onUnlocked(mkKey);
      } catch (err) {
        status.innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
      }
    });
  };

  screenHome();
}

export async function renderAdminPanel(view, escapeHtml, state, persist) {
  if (!isAdmin()) {
    view.innerHTML = '<section class="panel"><p>Accès réservé à l\'administrateur.</p></section>';
    return;
  }
  const pending = (await loadPending()).pending;
  view.innerHTML = `
    <section class="panel">
      <h2>Validation des comptes</h2>
      <p class="muted">${pending.length} demande(s) en attente.</p>
      ${pending.length ? pending.map((p) => `
        <div class="mini-card" style="margin-bottom:.8rem;min-width:100%">
          <strong>${escapeHtml(p.displayName)}</strong>
          <span class="muted">${escapeHtml(p.createdAt)}</span>
          <div style="margin-top:.5rem">
            <select id="role-${escapeHtml(p.id)}">
              ${ROLES.filter((r) => r !== 'admin').map((r) => `<option value="${r}">${r}</option>`).join('')}
            </select>
            <button class="btn" data-approve="${escapeHtml(p.id)}" style="margin-left:.5rem">Approuver</button>
          </div>
        </div>`).join('') : '<p class="muted">Aucune demande.</p>'}
    </section>`;

  view.querySelectorAll('[data-approve]').forEach((btn) => {
      btn.addEventListener('click', async () => {
      const id = btn.dataset.approve;
      const role = view.querySelector('#role-' + id)?.value || 'viewer';
      const doc = await loadPending();
      const req = doc.pending.find((p) => p.id === id);
      if (!req) return;
      const pin = window.prompt(`PIN secours (8 chiffres) choisi par ${req.displayName} lors de l'inscription :`);
      if (!pin || !validatePin(pin)) { alert('PIN invalide (8 chiffres).'); return; }
      const registry = await loadRegistry();
      if (!authSession.mkRaw) { alert('Session expirée — reconnectez-vous.'); return; }
      const pinWrap = await wrapMkRawWithPin(authSession.mkRaw, req.id, pin);
      registry.users.push({
        id: req.id,
        displayName: req.displayName,
        credentialId: req.credentialId,
        publicKey: req.publicKey,
        role,
        status: 'approved',
        personId: null,
        pinWrap,
        createdAt: new Date().toISOString(),
      });
      doc.pending = doc.pending.filter((p) => p.id !== id);
      await saveRegistry(registry);
      await import('./registry.js').then((m) => m.savePending(doc));
      alert('Compte approuvé et publié.');
      renderAdminPanel(view, escapeHtml, state, persist);
    });
  });
}

export function renderPersonLink(view, escapeHtml, state, persist) {
  const u = authSession.user;
  const people = [...state.individuals.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  view.innerHTML = `
    <section class="panel">
      <h2>Qui êtes-vous dans l'arbre ?</h2>
      <p class="muted">Choisissez votre fiche. Vous pourrez modifier vos informations si l'admin vous a accordé ce droit.</p>
      <ul class="person-list">
        ${people.map((p) => `<li><button type="button" class="link-btn person-pick" data-id="${escapeHtml(p.id)}">${escapeHtml(p.name)}</button></li>`).join('')}
      </ul>
    </section>`;
  view.querySelectorAll('.person-pick').forEach((btn) => {
    btn.addEventListener('click', async () => {
      u.personId = btn.dataset.id;
      const registry = await loadRegistry();
      const idx = registry.users.findIndex((x) => x.id === u.id);
      if (idx >= 0) registry.users[idx].personId = u.personId;
      await saveRegistry(registry);
      authSession.user.personId = u.personId;
      location.hash = '#/person/' + encodeURIComponent(u.personId);
    });
  });
}

export { clearAuthSession } from './session.js';
export { isMkTree, decryptTreeContainer } from './tree-lock.js';
