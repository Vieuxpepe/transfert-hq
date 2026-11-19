/**
 * Transfert HQ — Users & PINs Security Management Client Module
 */
(function () {
  'use strict';

  const root = document.getElementById('hq-users-root');
  if (!root) return;

  let usersList = [];

  function esc(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showToast(msg, isErr = false) {
    if (typeof window.toast === 'function') {
      window.toast(msg, isErr ? 'err' : 'ok');
    } else {
      alert(msg);
    }
  }

  async function apiFetch(url, options = {}) {
    const headers = options.headers ? { ...options.headers } : {};
    if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    options.headers = headers;

    const res = await fetch(url, options);
    let data = {};
    try {
      data = await res.json();
    } catch (_) {}

    if (!res.ok) {
      const err = data.error || `Erreur serveur (${res.status})`;
      throw new Error(err);
    }
    return data;
  }

  function openModal(title, contentHtml, onConfirm) {
    const existing = document.querySelector('.hq-modal-backdrop');
    if (existing) existing.remove();

    const backdrop = document.createElement('div');
    backdrop.className = 'hq-modal-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');

    backdrop.innerHTML = `
      <div class="hq-modal-card">
        <div class="hq-modal-head">
          <h3>${esc(title)}</h3>
          <button type="button" class="hq-modal-close" aria-label="Fermer">&times;</button>
        </div>
        <form id="hqModalForm">
          ${contentHtml}
          <div class="hq-modal-actions">
            <button type="button" class="secondary hq-modal-cancel">Annuler</button>
            <button type="submit" class="btn-primary-hq">Confirmer</button>
          </div>
        </form>
      </div>
    `;

    document.body.appendChild(backdrop);

    const close = () => backdrop.remove();
    backdrop.querySelector('.hq-modal-close').addEventListener('click', close);
    backdrop.querySelector('.hq-modal-cancel').addEventListener('click', close);
    backdrop.addEventListener('click', (ev) => {
      if (ev.target === backdrop) close();
    });

    const keyListener = (ev) => {
      if (ev.key === 'Escape') {
        close();
        document.removeEventListener('keydown', keyListener);
      }
    };
    document.addEventListener('keydown', keyListener);

    const form = backdrop.querySelector('#hqModalForm');
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        await onConfirm(form, close);
      } catch (err) {
        showToast(err.message, true);
        submitBtn.disabled = false;
      }
    });

    const firstInput = form.querySelector('input, select');
    if (firstInput) firstInput.focus();
  }

  function renderUsers() {
    if (!usersList || !usersList.length) {
      root.innerHTML = '<p class="hint">Aucun utilisateur configuré.</p>';
      return;
    }

    const total = usersList.length;
    const admins = usersList.filter((u) => u.role === 'admin' && u.enabled).length;
    const uploads = usersList.filter((u) => u.role === 'upload' && u.enabled).length;

    let html = `
      <div class="hq-users-metrics">
        <div class="hq-users-metric-chip">Total : <strong>${total}</strong></div>
        <div class="hq-users-metric-chip">Administrateurs : <strong>${admins}</strong></div>
        <div class="hq-users-metric-chip">Envoi : <strong>${uploads}</strong></div>
      </div>
      <div class="hq-users-bar">
        <p class="sec-hint">Comptes avec accès direct ou téléversement</p>
        <button type="button" class="btn-primary-hq" id="btnAddUser">+ Ajouter un compte</button>
      </div>
      <div class="hq-users-grid">
    `;

    usersList.forEach((user) => {
      const isCur = user.is_current;
      const isAdmin = user.role === 'admin';
      const isEnabled = user.enabled;
      const initial = (user.name || 'U').charAt(0).toUpperCase();
      const sess = user.active_sessions || 0;

      html += `
        <div class="hq-user-card ${isCur ? 'is-current' : ''} ${!isEnabled ? 'is-disabled' : ''}" data-uid="${esc(user.id)}">
          <div class="hq-user-main">
            <div class="hq-user-identity">
              <div class="hq-user-avatar" aria-hidden="true">${esc(initial)}</div>
              <div class="hq-user-details">
                <h3>
                  ${esc(user.name)}
                  ${isCur ? '<span class="hq-badge-you">Toi</span>' : ''}
                </h3>
                <div class="hq-user-badges">
                  <span class="hq-badge-role ${isAdmin ? 'role-admin' : 'role-upload'}">
                    ${isAdmin ? 'Administrateur' : 'Envoi'}
                  </span>
                  <span class="hq-badge-status ${isEnabled ? 'status-active' : 'status-disabled'}">
                    ${isEnabled ? 'Actif' : 'Désactivé'}
                  </span>
                </div>
              </div>
            </div>
            <div class="hq-user-meta">
              <span>ID: <code>${esc(user.id)}</code></span>
              <span>Sessions actives: <strong>${sess}</strong></span>
            </div>
          </div>
          <div class="hq-user-actions">
            <button type="button" class="btn-edit-user">Modifier</button>
            <button type="button" class="btn-change-pin">Changer PIN</button>
            <button type="button" class="btn-revoke-sessions" ${sess === 0 ? 'disabled' : ''}>Révoquer sessions</button>
            <button type="button" class="btn-danger btn-delete-user" ${isAdmin && admins <= 1 && isEnabled ? 'disabled title="Dernier administrateur actif"' : ''}>Supprimer</button>
          </div>
        </div>
      `;
    });

    html += '</div>';

    html += `
      <div class="hq-passkeys-box" style="margin-top:32px;padding:22px 24px;border-radius:18px;background:rgba(255,255,255,0.02);border:1px solid var(--border);">
        <div class="hq-users-bar" style="margin-bottom:14px">
          <div>
            <h3 style="font-size:17px;font-weight:700;color:var(--text);margin-bottom:4px">Clés d'accès biométriques (Passkeys / Face ID)</h3>
            <p class="sec-hint" style="margin:0">Déverrouillage instantané sans PIN via Face ID, Touch ID ou Windows Hello</p>
          </div>
          <button type="button" class="btn-primary-hq" id="btnRegisterPasskey" style="background:linear-gradient(135deg, #a855f7 0%, #ec4899 100%)">
            + Enregistrer cet appareil
          </button>
        </div>
        <div id="hqPasskeysList">
          <p class="hint">Chargement des clés...</p>
        </div>
      </div>
    `;

    root.innerHTML = html;

    // Attach handlers
    root.querySelector('#btnAddUser')?.addEventListener('click', onAddUser);
    root.querySelector('#btnRegisterPasskey')?.addEventListener('click', onRegisterPasskey);
    loadPasskeys();

    root.querySelectorAll('.btn-edit-user').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        const uid = ev.target.closest('.hq-user-card').dataset.uid;
        onEditUser(uid);
      });
    });

    root.querySelectorAll('.btn-change-pin').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        const uid = ev.target.closest('.hq-user-card').dataset.uid;
        onChangePin(uid);
      });
    });

    root.querySelectorAll('.btn-revoke-sessions').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        const uid = ev.target.closest('.hq-user-card').dataset.uid;
        onRevokeSessions(uid);
      });
    });

    root.querySelectorAll('.btn-delete-user').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        const uid = ev.target.closest('.hq-user-card').dataset.uid;
        onDeleteUser(uid);
      });
    });
  }

  function onAddUser() {
    const content = `
      <div class="field">
        <label for="newUserName">Nom d'affichage</label>
        <input id="newUserName" type="text" maxlength="40" placeholder="Ex. iPhone Atelier" required/>
      </div>
      <div class="field">
        <label for="newUserRole">Permissions</label>
        <select id="newUserRole">
          <option value="upload">Envoi uniquement (photos / notes)</option>
          <option value="admin">Administrateur (accès complet)</option>
        </select>
      </div>
      <div class="field">
        <label for="newUserPin">Nouveau code PIN (min 8 chiffres)</label>
        <input id="newUserPin" type="password" inputmode="numeric" minlength="8" maxlength="128" placeholder="••••••••" required/>
      </div>
      <div class="field">
        <label for="adminAuthPin">Ton code PIN administrateur actuel</label>
        <input id="adminAuthPin" type="password" inputmode="numeric" placeholder="Vérification de sécurité" required/>
      </div>
    `;

    openModal('Nouveau compte utilisateur', content, async (form, close) => {
      const name = form.querySelector('#newUserName').value.trim();
      const role = form.querySelector('#newUserRole').value;
      const pin = form.querySelector('#newUserPin').value.trim();
      const adminPin = form.querySelector('#adminAuthPin').value.trim();

      const res = await apiFetch('/api/admin/users', {
        method: 'POST',
        body: { name, role, pin, admin_pin: adminPin },
      });

      showToast(`Compte « ${res.user.name} » créé avec succès.`);
      close();
      await loadUsers();
    });
  }

  function onEditUser(uid) {
    const user = usersList.find((u) => u.id === uid);
    if (!user) return;

    const content = `
      <div class="field">
        <label for="editUserName">Nom d'affichage</label>
        <input id="editUserName" type="text" maxlength="40" value="${esc(user.name)}" required/>
      </div>
      <div class="field">
        <label for="editUserRole">Permissions</label>
        <select id="editUserRole">
          <option value="upload" ${user.role === 'upload' ? 'selected' : ''}>Envoi uniquement</option>
          <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Administrateur</option>
        </select>
      </div>
      <div class="field">
        <label for="editUserEnabled">Statut du compte</label>
        <select id="editUserEnabled">
          <option value="true" ${user.enabled ? 'selected' : ''}>Actif (accès autorisé)</option>
          <option value="false" ${!user.enabled ? 'selected' : ''}>Désactivé (accès bloqué)</option>
        </select>
      </div>
      <div class="field">
        <label for="adminAuthPin">Ton code PIN administrateur actuel</label>
        <input id="adminAuthPin" type="password" inputmode="numeric" placeholder="Vérification de sécurité" required/>
      </div>
    `;

    openModal(`Modifier « ${user.name} »`, content, async (form, close) => {
      const name = form.querySelector('#editUserName').value.trim();
      const role = form.querySelector('#editUserRole').value;
      const enabled = form.querySelector('#editUserEnabled').value === 'true';
      const adminPin = form.querySelector('#adminAuthPin').value.trim();

      const res = await apiFetch(`/api/admin/users/${encodeURIComponent(uid)}/update`, {
        method: 'POST',
        body: { name, role, enabled, admin_pin: adminPin },
      });

      showToast(`Compte « ${res.user.name} » mis à jour.`);
      close();
      await loadUsers();
    });
  }

  function onChangePin(uid) {
    const user = usersList.find((u) => u.id === uid);
    if (!user) return;

    const content = `
      <p class="sec-hint">La modification du PIN déconnectera immédiatement les sessions existantes de cet utilisateur.</p>
      <div class="field">
        <label for="rotatePinVal">Nouveau code PIN (min 8 chiffres)</label>
        <input id="rotatePinVal" type="password" inputmode="numeric" minlength="8" maxlength="128" placeholder="••••••••" required/>
      </div>
      <div class="field">
        <label for="adminAuthPin">Ton code PIN administrateur actuel</label>
        <input id="adminAuthPin" type="password" inputmode="numeric" placeholder="Vérification de sécurité" required/>
      </div>
    `;

    openModal(`Changer le PIN de « ${user.name} »`, content, async (form, close) => {
      const newPin = form.querySelector('#rotatePinVal').value.trim();
      const adminPin = form.querySelector('#adminAuthPin').value.trim();

      await apiFetch(`/api/admin/users/${encodeURIComponent(uid)}/pin`, {
        method: 'POST',
        body: { new_pin: newPin, admin_pin: adminPin },
      });

      showToast(`PIN de « ${user.name} » mis à jour.`);
      close();
      await loadUsers();
    });
  }

  function onRevokeSessions(uid) {
    const user = usersList.find((u) => u.id === uid);
    if (!user) return;

    const content = `
      <div class="hq-modal-warn">
        Attention : Cette action déconnecte immédiatement tous les appareils et navigateurs connectés avec ce compte.
      </div>
      <div class="field">
        <label for="adminAuthPin">Ton code PIN administrateur actuel</label>
        <input id="adminAuthPin" type="password" inputmode="numeric" placeholder="Vérification de sécurité" required/>
      </div>
    `;

    openModal(`Révoquer les sessions de « ${user.name} »`, content, async (form, close) => {
      const adminPin = form.querySelector('#adminAuthPin').value.trim();

      const res = await apiFetch(`/api/admin/users/${encodeURIComponent(uid)}/revoke-sessions`, {
        method: 'POST',
        body: { admin_pin: adminPin },
      });

      showToast(`${res.revoked || 0} session(s) révoquée(s).`);
      close();
      await loadUsers();
    });
  }

  function onDeleteUser(uid) {
    const user = usersList.find((u) => u.id === uid);
    if (!user) return;

    const content = `
      <div class="hq-modal-warn">
        Irréversible : Le compte « ${esc(user.name)} » sera définitivement supprimé et ses sessions révoquées.
      </div>
      <div class="field">
        <label for="adminAuthPin">Ton code PIN administrateur actuel</label>
        <input id="adminAuthPin" type="password" inputmode="numeric" placeholder="Vérification de sécurité" required/>
      </div>
    `;

    openModal(`Supprimer le compte « ${user.name} »`, content, async (form, close) => {
      const adminPin = form.querySelector('#adminAuthPin').value.trim();

      await apiFetch(`/api/admin/users/${encodeURIComponent(uid)}/delete`, {
        method: 'POST',
        body: { admin_pin: adminPin },
      });

      showToast(`Compte « ${user.name} » supprimé.`);
      close();
      await loadUsers();
    });
  }

  function b64urlToBuf(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function bufToB64url(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  async function loadPasskeys() {
    const listEl = document.getElementById('hqPasskeysList');
    if (!listEl) return;
    try {
      const data = await apiFetch('/api/admin/passkeys');
      const keys = data.passkeys || [];
      if (!keys.length) {
        listEl.innerHTML = '<p class="hint">Aucun appareil biométrique enregistré pour le moment.</p>';
        return;
      }
      let html = '<div class="hq-passkeys-grid" style="display:grid;gap:10px;margin-top:10px">';
      keys.forEach((k) => {
        html += `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:12px">
            <div>
              <div style="font-weight:600;color:var(--text);font-size:15px">${esc(k.name)}</div>
              <div style="font-size:13px;color:var(--text-muted);margin-top:2px">Ajoutée le ${esc(k.created_at || 'inconnu')} ${k.last_used_at ? '· Utilisée le ' + esc(k.last_used_at) : ''}</div>
            </div>
            <button type="button" class="btn-danger btn-del-passkey" data-kid="${esc(k.id)}" style="padding:6px 12px;font-size:13px">Supprimer</button>
          </div>
        `;
      });
      html += '</div>';
      listEl.innerHTML = html;

      listEl.querySelectorAll('.btn-del-passkey').forEach((btn) => {
        btn.addEventListener('click', (ev) => {
          const kid = ev.target.dataset.kid;
          onDeletePasskey(kid);
        });
      });
    } catch (err) {
      listEl.innerHTML = `<p class="hint" style="color:var(--err-text)">${esc(err.message)}</p>`;
    }
  }

  async function onRegisterPasskey() {
    if (!window.PublicKeyCredential) {
      showToast("La biométrie WebAuthn n'est pas supportée sur ce navigateur.", true);
      return;
    }

    try {
      const opts = await apiFetch('/api/auth/webauthn/register/options', { method: 'POST' });
      const cred = await navigator.credentials.create({
        publicKey: {
          challenge: b64urlToBuf(opts.challenge),
          rp: opts.rp,
          user: {
            id: b64urlToBuf(bufToB64url(new TextEncoder().encode(opts.user.id))),
            name: opts.user.name,
            displayName: opts.user.displayName,
          },
          pubKeyCredParams: opts.pubKeyCredParams,
          authenticatorSelection: {
            userVerification: 'preferred',
            residentKey: 'preferred',
          },
        },
      });

      if (!cred) throw new Error('Enregistrement annulé');

      let pubkeyB64 = '';
      if (typeof cred.response.getPublicKey === 'function') {
        const pkBuf = cred.response.getPublicKey();
        if (pkBuf) pubkeyB64 = bufToB64url(pkBuf);
      }
      if (!pubkeyB64 && cred.response.attestationObject) {
        pubkeyB64 = bufToB64url(cred.response.attestationObject);
      }

      const devName = navigator.userAgent.includes('iPhone')
        ? 'iPhone (Safari)'
        : navigator.userAgent.includes('Mac')
        ? 'Mac (Touch ID)'
        : navigator.userAgent.includes('Windows')
        ? 'Windows PC (Hello)'
        : 'Appareil Biométrique';

      await apiFetch('/api/auth/webauthn/register/verify', {
        method: 'POST',
        body: {
          challenge: opts.challenge,
          cred_id: bufToB64url(cred.rawId),
          public_key: pubkeyB64,
          name: devName,
        },
      });

      showToast(`Appareil « ${devName} » enregistré pour la connexion biométrique !`);
      await loadPasskeys();
    } catch (err) {
      showToast(err.message || 'Erreur lors de la capture biométrique', true);
    }
  }

  async function onDeletePasskey(kid) {
    if (!confirm('Voulez-vous révoquer cette clé biométrique ?')) return;
    try {
      await apiFetch(`/api/admin/passkeys/${encodeURIComponent(kid)}`, { method: 'DELETE' });
      showToast('Clé biométrique supprimée.');
      await loadPasskeys();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  async function loadUsers() {
    try {
      const data = await apiFetch('/api/admin/users');
      usersList = data.users || [];
      renderUsers();
    } catch (err) {
      root.innerHTML = `<p class="toast err" style="position:static">${esc(err.message)}</p>`;
    }
  }

  function dropForUpload() {
    const sec = document.getElementById('system-security');
    if (sec) sec.remove();
    const jump = document.querySelector('[data-jump="system-security"]');
    if (jump) jump.remove();
  }

  // The session role decides whether the section exists at all; it is not section data.
  // The users list itself waits until the section is revealed, so entering Plus costs no request.
  function whenRevealed(fn) {
    const host = document.getElementById('system-security') || root;
    if (typeof window.hqWhenRevealed === 'function') window.hqWhenRevealed(host, 'users', fn);
    else fn();
  }

  function init() {
    const role = document.body.dataset.role || '';
    if (role === 'admin') {
      whenRevealed(loadUsers);
      return;
    }
    if (role === 'upload') {
      dropForUpload();
      return;
    }
    // APP_JS publishes the role once /api/me answers; wait for that instead of asking again.
    window.addEventListener('hq:session-role', () => {
      if (document.body.dataset.role === 'admin') whenRevealed(loadUsers);
      else dropForUpload();
    }, { once: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
