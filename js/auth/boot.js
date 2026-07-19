// Écran d'authentification passkey + inscription auto (option B).

import { loadSiteConfig } from './site.js';
import { registerPasskey, authenticatePasskey, wrapMkRawWithPrf, unwrapMkWithPrfRaw } from './webauthn.js';
import { validatePin, wrapMkRawWithPin, unwrapMkWithPin } from './pin.js';
import {
  loadRegistry, saveRegistry, loadPending, savePending, appendPending,
  findBootstrapAdmin, findUserByCredential, ROLES, ROLE_LABELS,
} from './registry.js';
import { authSession, setAuthSession, clearAuthSession, isAdmin, needsSetupFinalize } from './session.js';
import {
  createSetupKeyPair, storeSetupPrivateKey, loadSetupPrivateKey, clearSetupPrivateKey,
  hasLocalSetupForUser, wrapMkForSetup, unwrapMkFromSetup,
} from './setup-handoff.js';
import { importRawAesKey } from '../crypto.js';
import { decryptTreeContainer, isMkTree } from './tree-lock.js';
import { githubErrorMessage } from '../github.js';
import {
  loadEditLock, releaseEditLock, setGlobalTreeLock, isLockActive, isGlobalTreeLocked,
} from './edit-lock.js';

const $ = (sel) => document.querySelector(sel);

function normalizeSearch(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function filterPeopleForLink(people, query, limit = 40) {
  const q = normalizeSearch(query.trim());
  if (!q) return [];
  return people.filter((p) =>
    normalizeSearch(p.name).includes(q)
    || normalizeSearch(p.surname).includes(q)
    || normalizeSearch(p.marriedSurname).includes(q),
  ).slice(0, limit);
}

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

async function ensurePrfWrap(user, mkRaw, registry, saveOpts) {
  if (user.prfWrap || !user.credentialId) return user;
  try {
    const auth = await authenticatePasskey(user.credentialId);
    if (!auth.prfBytes) return user;
    user.prfWrap = await wrapMkRawWithPrf(mkRaw, auth.prfBytes);
    const idx = registry.users.findIndex((u) => u.id === user.id);
    if (idx >= 0) registry.users[idx] = user;
    await saveRegistry(registry, saveOpts);
  } catch (_) { /* PRF optionnel — PIN secours reste disponible */ }
  return user;
}

async function loginWithPasskey(registry, statusEl, escapeHtml, onUnlocked) {
  const passkeyUsers = registry.users.filter(
    (u) => u.status === 'approved' && u.credentialId && u.prfWrap,
  );
  if (!passkeyUsers.length) {
    throw new Error('Aucune passkey activée — connectez-vous une fois avec votre PIN secours.');
  }
  const auth = await authenticatePasskey(null, passkeyUsers.map((u) => u.credentialId));
  const user = findUserByCredential(registry, auth.credentialId);
  if (!user) {
    throw new Error('Passkey non enregistrée — supprimez les anciennes passkeys « Généalogie » dans Réglages, puis reconnectez-vous avec le PIN.');
  }
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

async function finalizeUserAccount(user, pin, registry, onUnlocked, statusEl) {
  const setupPk = loadSetupPrivateKey(user.id);
  if (!setupPk) {
    throw new Error('Clé de finalisation introuvable — utilisez le même appareil et navigateur que lors de l\'inscription.');
  }
  if (statusEl) statusEl.textContent = 'Déverrouillage…';
  const mkRaw = await unwrapMkFromSetup(user.setupWrap, setupPk);
  const mkKey = await importRawAesKey(mkRaw);
  setAuthSession(user, mkKey, registry, mkRaw);
  user.pinWrap = await wrapMkRawWithPin(mkRaw, user.id, pin);
  if (statusEl) statusEl.textContent = 'Activation passkey…';
  user = await ensurePrfWrap(user, mkRaw, registry, { registrationToken: true });
  const idx = registry.users.findIndex((u) => u.id === user.id);
  if (idx < 0) throw new Error('Utilisateur introuvable.');
  registry.users[idx] = {
    ...registry.users[idx],
    pinWrap: user.pinWrap,
    ...(user.prfWrap ? { prfWrap: user.prfWrap } : {}),
    setupRequired: false,
  };
  delete registry.users[idx].setupWrap;
  if (statusEl) statusEl.textContent = 'Publication…';
  await saveRegistry(registry, { registrationToken: true });
  clearSetupPrivateKey(user.id);
  setAuthSession(registry.users[idx], mkKey, registry, mkRaw);
  if (statusEl) statusEl.textContent = 'Compte activé.';
  await onUnlocked(mkKey);
}

export function renderAuthGate(escapeHtml, onUnlocked) {
  $('#app').hidden = true;
  const login = $('#login');
  login.hidden = false;

  const show = (html) => { login.innerHTML = html; };

  const showAuthError = (err) => {
    show(`
      <div class="login-card">
        <p class="error">${escapeHtml(err?.message || String(err))}</p>
        <button type="button" class="link-btn" id="back-err">← Retour</button>
      </div>`);
    $('#back-err').addEventListener('click', screenHomeSync);
  };

  const screenHome = async () => {
    const registry = await loadRegistry();
    const canFinalize = registry.users.some(
      (u) => needsSetupFinalize(u) && hasLocalSetupForUser(u.id),
    );
    show(`
      <div class="login-card">
        <h1>🌳 Généalogie</h1>
        <p class="muted">Connexion sécurisée par passkey.</p>
        ${canFinalize ? `<button type="button" class="btn" id="btn-finalize" style="width:100%;margin-top:1rem">Finaliser mon compte</button>` : ''}
        <button type="button" class="btn" id="btn-login" style="width:100%;margin-top:${canFinalize ? '.6' : '1'}rem">Se connecter</button>
        <button type="button" class="link-btn" id="btn-register" style="width:100%;margin-top:.6rem">Créer un compte</button>
        <p id="auth-status" class="muted" style="margin-top:1rem"></p>
      </div>`);
    $('#btn-finalize')?.addEventListener('click', screenFinalizeSetup);
    $('#btn-login').addEventListener('click', screenLogin);
    $('#btn-register').addEventListener('click', screenRegister);
  };

  const screenFinalizeSetup = async () => {
    const registry = await loadRegistry();
    const candidates = registry.users.filter(
      (u) => needsSetupFinalize(u) && hasLocalSetupForUser(u.id),
    );
    if (!candidates.length) {
      show(`
        <div class="login-card">
          <h1>Finaliser mon compte</h1>
          <p class="error">Aucun compte en attente de finalisation sur cet appareil.</p>
          <p class="muted">Revenez sur le navigateur où vous vous êtes inscrit, ou créez une nouvelle demande.</p>
          <button type="button" class="link-btn" id="back" style="margin-top:.8rem">← Retour</button>
        </div>`);
      $('#back').addEventListener('click', screenHomeSync);
      return;
    }
    show(`
      <div class="login-card">
        <h1>Finaliser mon compte</h1>
        <p class="muted">Votre compte a été approuvé. Choisissez votre PIN secours (8 chiffres) — seul vous le connaîtrez.</p>
        <button type="button" class="btn" id="btn-finalize-passkey" style="width:100%">Vérifier ma passkey</button>
        <form id="finalize-form" hidden style="margin-top:1rem">
          <label>PIN secours (8 chiffres)<input name="pin" inputmode="numeric" pattern="[0-9]{8}" maxlength="8" required></label>
          <label>Confirmer le PIN<input name="pin2" inputmode="numeric" pattern="[0-9]{8}" maxlength="8" required></label>
          <button type="submit" class="btn" style="width:100%;margin-top:.8rem">Activer mon compte</button>
        </form>
        <button type="button" class="link-btn" id="back" style="margin-top:.6rem">← Retour</button>
        <p id="auth-status" class="muted"></p>
      </div>`);
    $('#back').addEventListener('click', screenHomeSync);
    let matchedUser = null;
    $('#btn-finalize-passkey').addEventListener('click', async () => {
      const status = $('#auth-status');
      const btn = $('#btn-finalize-passkey');
      btn.disabled = true;
      status.textContent = 'Passkey…';
      try {
        const auth = await authenticatePasskey(null, candidates.map((u) => u.credentialId));
        matchedUser = candidates.find((u) => u.credentialId === auth.credentialId);
        if (!matchedUser) throw new Error('Passkey non reconnue.');
        status.textContent = `Compte : ${matchedUser.displayName}`;
        $('#finalize-form').hidden = false;
      } catch (err) {
        status.innerHTML = `<span class="error">${escapeHtml(err.message || String(err))}</span>`;
        btn.disabled = false;
      }
    });
    $('#finalize-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const pin = fd.get('pin');
      const pin2 = fd.get('pin2');
      const status = $('#auth-status');
      if (!matchedUser) { status.textContent = 'Vérifiez d\'abord votre passkey.'; return; }
      if (!validatePin(pin)) { status.textContent = 'PIN : 8 chiffres requis.'; return; }
      if (pin !== pin2) { status.textContent = 'Les PIN ne correspondent pas.'; return; }
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await finalizeUserAccount(matchedUser, pin, registry, onUnlocked, status);
      } catch (err) {
        status.innerHTML = `<span class="error">${escapeHtml(githubErrorMessage(err) || err.message || String(err))}</span>`;
        btn.disabled = false;
      }
    });
  };

  const screenHomeSync = () => { screenHome().catch(showAuthError); };

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
    $('#back').addEventListener('click', screenHomeSync);
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
        if (!user) throw new Error('PIN incorrect.');
        setAuthSession(user, mkKey, registry, mkRaw);
        if (!user.prfWrap) status.textContent = 'Activation passkey…';
        user = await ensurePrfWrap(user, mkRaw, registry);
        authSession.user = user;
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
        <p class="muted">Créez votre passkey. Après validation par l'administrateur, vous choisirez votre PIN secours sur <strong>ce même appareil</strong>.</p>
        <label>Votre prénom / nom<input name="displayName" required autofocus></label>
        <button type="submit" class="btn" style="width:100%;margin-top:.8rem">Créer passkey et envoyer</button>
        <button type="button" class="link-btn" id="back" style="margin-top:.6rem">← Retour</button>
        <p id="auth-status" class="muted"></p>
      </form>`);
    $('#back').addEventListener('click', screenHomeSync);
    $('#reg-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const displayName = fd.get('displayName').trim();
      const status = $('#auth-status');
      const btn = e.target.querySelector('button[type=submit]');
      if (!displayName) { status.textContent = 'Nom requis.'; return; }
      btn.disabled = true;
      status.textContent = 'Création passkey…';
      try {
        const setupKeys = await createSetupKeyPair();
        const reg = await registerPasskey(displayName);
        storeSetupPrivateKey(reg.userId, setupKeys.privateKeyB64);
        status.textContent = 'Envoi de la demande…';
        await appendPending({
          id: reg.userId,
          displayName: reg.displayName,
          credentialId: reg.credentialId,
          publicKey: reg.publicKey,
          setupPublicKey: setupKeys.publicKeyB64,
          createdAt: new Date().toISOString(),
          status: 'pending',
        });
        show(`
          <div class="login-card">
            <h1>Demande envoyée</h1>
            <p class="muted">Un administrateur validera votre compte. Revenez ensuite sur <strong>ce navigateur</strong> et cliquez « Finaliser mon compte » pour choisir votre PIN secours.</p>
            <button type="button" class="btn" id="ok" style="width:100%;margin-top:1rem">OK</button>
          </div>`);
        $('#ok').addEventListener('click', screenHomeSync);
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
        status.textContent = 'Publication registry…';
        const freshRegistry = await saveUserPasskey({ ...user, pinWrap: user.pinWrap }, mkRaw);
        setAuthSession(freshRegistry.users.find((x) => x.id === user.id), mkKey, freshRegistry, mkRaw);
        await onUnlocked(mkKey);
      } catch (err) {
        status.innerHTML = `<span class="error">${escapeHtml(err.message)}</span>`;
      }
    });
  };

  screenHomeSync();
}

async function saveUserPasskey(user, mkRaw) {
  const freshRegistry = await loadRegistry();
  const idx = freshRegistry.users.findIndex((u) => u.id === user.id);
  if (idx < 0) throw new Error('Utilisateur introuvable dans le registry.');
  freshRegistry.users[idx] = {
    ...freshRegistry.users[idx],
    credentialId: user.credentialId,
    publicKey: user.publicKey,
    needsPasskey: false,
    ...(user.pinWrap ? { pinWrap: user.pinWrap } : {}),
  };
  if (user.prfWrap) freshRegistry.users[idx].prfWrap = user.prfWrap;
  else delete freshRegistry.users[idx].prfWrap;
  await saveRegistry(freshRegistry);
  return freshRegistry;
}

function passkeySectionHtml() {
  return `
    <section class="panel">
      <h2>Ma passkey</h2>
      <p class="muted">Recréez votre passkey après un changement d'appareil ou si l'ancienne a été supprimée des Réglages.</p>
      <button type="button" class="btn" id="recreate-passkey">Recréer ma passkey</button>
      <p id="passkey-status" class="muted" style="margin-top:.6rem"></p>
    </section>`;
}

function wireRecreatePasskey(view, escapeHtml) {
  view.querySelector('#recreate-passkey')?.addEventListener('click', async () => {
    const status = view.querySelector('#passkey-status');
    const btn = view.querySelector('#recreate-passkey');
    if (!authSession.mkRaw) {
      alert('Session expirée — reconnectez-vous avec votre PIN secours.');
      return;
    }
    btn.disabled = true;
    status.textContent = 'Création passkey…';
    try {
      const u = { ...authSession.user };
      const reg = await registerPasskey(u.displayName, u.id);
      u.credentialId = reg.credentialId;
      u.publicKey = reg.publicKey;
      u.needsPasskey = false;
      if (reg.prfBytes) u.prfWrap = await wrapMkRawWithPrf(authSession.mkRaw, reg.prfBytes);
      else delete u.prfWrap;
      status.textContent = 'Publication…';
      const freshRegistry = await saveUserPasskey(u, authSession.mkRaw);
      const saved = freshRegistry.users.find((x) => x.id === u.id);
      setAuthSession(saved, authSession.mkKey, freshRegistry, authSession.mkRaw);
      status.textContent = 'Passkey enregistrée. Vous pouvez vous connecter avec passkey.';
    } catch (err) {
      status.innerHTML = `<span class="error">${escapeHtml(err.message || String(err))}</span>`;
    } finally {
      btn.disabled = false;
    }
  });
}

function formatAccountPersonLink(user, state, escapeHtml) {
  if (needsSetupFinalize(user)) {
    return '<span class="muted">— (finalisation PIN en attente)</span>';
  }
  if (!user.pinWrap && user.needsPasskey) {
    return '<span class="muted">— (passkey admin à créer)</span>';
  }
  if (!user.personId) {
    return '<span class="muted">Non associé</span>';
  }
  const indi = state.individuals?.get(user.personId);
  if (!indi) {
    return `<span class="muted">Fiche introuvable</span> <code>${escapeHtml(user.personId)}</code>`;
  }
  const href = '#/person/' + encodeURIComponent(user.personId);
  return `<a href="${href}">${escapeHtml(indi.name)}</a>`;
}

export function renderAccountPanel(view, escapeHtml, state) {
  const u = authSession.user;
  if (!u) {
    view.innerHTML = '<section class="panel"><p>Non connecté.</p></section>';
    return;
  }
  view.innerHTML = `
    ${passkeySectionHtml()}
    <section class="panel">
      <h2>Mon compte</h2>
      <p><strong>${escapeHtml(u.displayName)}</strong></p>
      <p class="muted">Rôle : ${escapeHtml(ROLE_LABELS[u.role] || u.role)}</p>
      <p class="muted">Personne dans l'arbre : ${formatAccountPersonLink(u, state, escapeHtml)}</p>
      ${needsSetupFinalize(u)
        ? '<p class="muted">Finalisez d\'abord votre compte depuis l\'écran de connexion.</p>'
        : `<p class="muted">PIN secours : disponible si la passkey est perdue.</p>`}
    </section>`;
  wireRecreatePasskey(view, escapeHtml);
}

export async function renderAdminPanel(view, escapeHtml, state, persist) {
  if (!isAdmin()) {
    view.innerHTML = '<section class="panel"><p>Accès réservé à l\'administrateur.</p></section>';
    return;
  }
  const pending = (await loadPending()).pending;
  const registry = await loadRegistry();
  const editLock = await loadEditLock();
  const globalLocked = isGlobalTreeLocked(registry);
  const accounts = registry.users
    .filter((u) => u.status === 'approved')
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'fr'));
  view.innerHTML = `
    ${passkeySectionHtml()}
    <section class="panel">
      <h2>Verrouillage de l'arbre</h2>
      <p class="muted">Verrou global : tous les éditeurs passent en lecture seule (vous pouvez toujours éditer).
      Verrou exclusif : un seul éditeur à la fois via le bandeau en haut de l'écran.</p>
      <p class="muted">${globalLocked
        ? `🔒 Verrou global actif${registry.treeEditLockedReason ? ` — ${escapeHtml(registry.treeEditLockedReason)}` : ''}.`
        : 'Verrou global inactif.'}</p>
      <p class="muted">${isLockActive(editLock)
        ? `✏️ Verrou exclusif : ${escapeHtml(editLock.displayName)} (jusqu'à ${escapeHtml(new Date(editLock.expiresAt).toLocaleString('fr-FR'))}).`
        : 'Aucun verrou exclusif actif.'}</p>
      <label>Raison du verrou global (optionnel)
        <input type="text" id="global-lock-reason" value="${escapeHtml(registry.treeEditLockedReason || '')}" placeholder="ex. Import GEDCOM en cours">
      </label>
      <div class="actions-row" style="margin-top:.75rem">
        <button type="button" class="btn" id="toggle-global-lock">${globalLocked ? 'Déverrouiller l\'arbre' : 'Verrouiller l\'arbre (global)'}</button>
        ${isLockActive(editLock) ? '<button type="button" class="btn btn-ghost" id="admin-release-edit-lock">Libérer le verrou exclusif</button>' : ''}
      </div>
    </section>
    <section class="panel">
      <h2>Comptes</h2>
      <p class="muted">${accounts.length} compte(s) approuvé(s).</p>
      ${accounts.length ? `
        <table class="admin-table">
          <thead>
            <tr>
              <th>Compte</th>
              <th>Rôle</th>
              <th>Personne dans l'arbre</th>
            </tr>
          </thead>
          <tbody>
            ${accounts.map((u) => `
              <tr>
                <td><strong>${escapeHtml(u.displayName)}</strong></td>
                <td>${escapeHtml(ROLE_LABELS[u.role] || u.role)}</td>
                <td>${formatAccountPersonLink(u, state, escapeHtml)}</td>
              </tr>`).join('')}
          </tbody>
        </table>` : '<p class="muted">Aucun compte.</p>'}
    </section>
    <section class="panel">
      <h2>Validation des comptes</h2>
      <p class="muted">Rôles : <strong>Lecture seule</strong> — consulter l'arbre ;
      <strong>Sa fiche uniquement</strong> — modifier sa propre personne (après lien dans l'arbre) ;
      <strong>Éditeur</strong> — modifier tout l'arbre et publier les modifications en ligne.</p>
      <p class="muted">Après approbation, la personne finalise son PIN secours sur son appareil (sans que vous le connaissiez).</p>
      <p class="muted">${pending.length} demande(s) en attente.</p>
      ${pending.length ? pending.map((p) => `
        <div class="mini-card" style="margin-bottom:.8rem;min-width:100%">
          <strong>${escapeHtml(p.displayName)}</strong>
          <span class="muted">${escapeHtml(p.createdAt)}</span>
          <div style="margin-top:.5rem">
            <select id="role-${escapeHtml(p.id)}">
              ${ROLES.filter((r) => r !== 'admin').map((r) => `<option value="${r}">${escapeHtml(ROLE_LABELS[r] || r)}</option>`).join('')}
            </select>
            <button class="btn" data-approve="${escapeHtml(p.id)}" style="margin-left:.5rem">Approuver</button>
            <button type="button" class="btn btn-danger" data-reject="${escapeHtml(p.id)}">Refuser</button>
          </div>
        </div>`).join('') : '<p class="muted">Aucune demande.</p>'}
    </section>`;

  wireRecreatePasskey(view, escapeHtml);

  view.querySelector('#toggle-global-lock')?.addEventListener('click', async () => {
    const reason = view.querySelector('#global-lock-reason')?.value || '';
    const btn = view.querySelector('#toggle-global-lock');
    btn.disabled = true;
    try {
      await setGlobalTreeLock(!globalLocked, reason, authSession.user);
      window.dispatchEvent(new Event('gen-edit-lock-changed'));
      renderAdminPanel(view, escapeHtml, state, persist);
    } catch (err) {
      alert(githubErrorMessage(err) || err.message || String(err));
      btn.disabled = false;
    }
  });

  view.querySelector('#admin-release-edit-lock')?.addEventListener('click', async () => {
    if (!confirm('Libérer le verrou exclusif de force ?')) return;
    const btn = view.querySelector('#admin-release-edit-lock');
    btn.disabled = true;
    try {
      await releaseEditLock(authSession.mkKey || state.key);
      window.dispatchEvent(new Event('gen-edit-lock-changed'));
      renderAdminPanel(view, escapeHtml, state, persist);
    } catch (err) {
      alert(githubErrorMessage(err) || err.message || String(err));
      btn.disabled = false;
    }
  });

  view.querySelectorAll('[data-approve]').forEach((btn) => {
      btn.addEventListener('click', async () => {
      const id = btn.dataset.approve;
      const role = view.querySelector('#role-' + id)?.value || 'viewer';
      const doc = await loadPending();
      const req = doc.pending.find((p) => p.id === id);
      if (!req) return;
      if (!req.setupPublicKey) {
        alert('Demande obsolète — demandez à la personne de s\'inscrire à nouveau.');
        return;
      }
      const registry = await loadRegistry();
      if (!authSession.mkRaw) { alert('Session expirée — reconnectez-vous.'); return; }
      btn.disabled = true;
      try {
        const setupWrap = await wrapMkForSetup(authSession.mkRaw, req.setupPublicKey);
        registry.users.push({
          id: req.id,
          displayName: req.displayName,
          credentialId: req.credentialId,
          publicKey: req.publicKey,
          role,
          status: 'approved',
          personId: null,
          setupRequired: true,
          setupWrap,
          createdAt: new Date().toISOString(),
        });
        doc.pending = doc.pending.filter((p) => p.id !== id);
        await saveRegistry(registry);
        await savePending(doc);
        alert('Compte approuvé. La personne peut finaliser son PIN sur son appareil.');
        renderAdminPanel(view, escapeHtml, state, persist);
      } catch (err) {
        alert(githubErrorMessage(err) || err.message || String(err));
        btn.disabled = false;
      }
    });
  });

  view.querySelectorAll('[data-reject]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.reject;
      const doc = await loadPending();
      const req = doc.pending.find((p) => p.id === id);
      if (!req) return;
      if (!confirm(`Refuser la demande de ${req.displayName} ?`)) return;
      btn.disabled = true;
      try {
        doc.pending = doc.pending.filter((p) => p.id !== id);
        await savePending(doc);
        alert('Demande refusée.');
        renderAdminPanel(view, escapeHtml, state, persist);
      } catch (err) {
        alert(githubErrorMessage(err) || err.message || String(err));
        btn.disabled = false;
      }
    });
  });
}

export function renderPersonLink(view, escapeHtml, state, persist) {
  const u = authSession.user;
  const people = [...state.individuals.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr'));

  const pickPerson = async (personId) => {
    u.personId = personId;
    const registry = await loadRegistry();
    const idx = registry.users.findIndex((x) => x.id === u.id);
    if (idx >= 0) registry.users[idx].personId = u.personId;
    await saveRegistry(registry);
    authSession.user.personId = u.personId;
    location.hash = '#/person/' + encodeURIComponent(u.personId);
  };

  const renderResults = (query) => {
    const results = filterPeopleForLink(people, query);
    const hint = view.querySelector('#person-link-hint');
    const list = view.querySelector('#person-link-results');
    if (!hint || !list) return;
    const trimmed = query.trim();
    if (!trimmed) {
      hint.textContent = 'Tapez un nom ou un prénom pour trouver votre fiche.';
      list.innerHTML = '';
      return;
    }
    hint.textContent = results.length
      ? `${results.length} résultat(s) pour « ${trimmed} » — cliquez sur votre nom.`
      : `Aucun résultat pour « ${trimmed} ».`;
    list.innerHTML = results.map((p) =>
      `<li><button type="button" class="link-btn person-pick" data-id="${escapeHtml(p.id)}">${escapeHtml(p.name)}</button></li>`,
    ).join('');
    list.querySelectorAll('.person-pick').forEach((btn) => {
      btn.addEventListener('click', () => pickPerson(btn.dataset.id));
    });
  };

  view.innerHTML = `
    <section class="panel">
      <h2>Qui êtes-vous dans l'arbre ?</h2>
      <p class="muted">Recherchez votre fiche pour vous y associer. Vous pourrez modifier vos informations si l'admin vous a accordé ce droit.</p>
      <form id="person-link-form" class="person-link-search">
        <input type="search" id="person-link-q" placeholder="Rechercher un nom…" autocomplete="off" autofocus />
      </form>
      <p id="person-link-hint" class="muted">Tapez un nom ou un prénom pour trouver votre fiche.</p>
      <ul id="person-link-results" class="person-list"></ul>
    </section>`;

  const input = view.querySelector('#person-link-q');
  view.querySelector('#person-link-form').addEventListener('submit', (e) => e.preventDefault());
  input.addEventListener('input', () => renderResults(input.value));
}

export { clearAuthSession } from './session.js';
export { isMkTree, decryptTreeContainer } from './tree-lock.js';
