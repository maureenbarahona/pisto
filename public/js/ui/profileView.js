/**
 * @fileoverview Profile View & Firebase Auth UI Controller.
 *
 * Manages:
 * - Tab 5 ("Perfil") form rendering & bindings (Name, Country, Default Currency,
 *   Gemini API Key in localStorage, Personal View Mode checkbox).
 * - Firebase Auth Login / Register Modal (`#auth-dialog`) supporting Google Sign-In
 *   and Email/Password authentication.
 * - Optional Firebase Project Credentials configuration for live Cloud Firestore `users/{uid}`.
 */

import {
  SUPPORTED_COUNTRIES,
} from '../services/authProfileService.js';
import { attachDialogLightDismissFallback } from './keypadModal.js';

export class ProfileViewController {
  constructor(authService, callbacks) {
    this.authService = authService;
    this.callbacks = callbacks;
    this.isRegisterMode = false;
  }

  init() {
    this.setupAuthDialog();
    this.setupProfileForm();
    this.renderProfileTab();
  }

  setupAuthDialog() {
    const authDialog = document.getElementById('auth-dialog');
    if (!authDialog) return;

    attachDialogLightDismissFallback(authDialog);

    const modeTabs = authDialog.querySelectorAll('[data-auth-mode]');
    modeTabs.forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.authMode;
        this.setAuthModalMode(mode === 'register');
      });
    });

    const googleBtn = document.getElementById('btn-auth-google');
    googleBtn?.addEventListener('click', async () => {
      try {
        googleBtn.disabled = true;
        this.hideAuthModalError();
        const { user, profile } = await this.authService.signInWithGoogle();
        authDialog.close();
        this.callbacks.showToast(
          `✅ Sesión iniciada con Google (${user.displayName}). Moneda activa: ${profile.defaultCurrency}`
        );
        this.renderProfileTab();
        this.callbacks.onAuthAndProfileUpdated(user, profile, 'login');
      } catch (err) {
        const errorCode = String(err?.code || 'auth/unknown-error');
        const rawMessage = String(err?.originalMessage || err?.message || 'Error al iniciar sesión con Google.');
        const formattedMessage =
          typeof err?.message === 'string' && err.message.includes(errorCode)
            ? err.message
            : `[${errorCode}] ${rawMessage}`;
        console.error('[AuthModal - Google Sign-In Error]', {
          code: errorCode,
          message: rawMessage,
          error: err,
        });
        this.showAuthModalError(formattedMessage);
        this.callbacks.showToast(`⚠️ Error Google Auth (${errorCode}): ${rawMessage}`);
      } finally {
        googleBtn.disabled = false;
      }
    });

    const demoBtn = document.getElementById('btn-auth-demo-mode');
    demoBtn?.addEventListener('click', async () => {
      try {
        demoBtn.disabled = true;
        this.hideAuthModalError();
        const { user, profile } = await this.authService.signInWithDemoMode();
        authDialog.close();
        this.callbacks.showToast(
          `🚀 Modo Demo activado (${user.displayName}). Moneda activa: ${profile.defaultCurrency}`
        );
        this.renderProfileTab();
        this.callbacks.onAuthAndProfileUpdated(user, profile, 'login');
      } catch (err) {
        this.showAuthModalError(err?.message || 'Error al activar el Modo Demo.');
      } finally {
        demoBtn.disabled = false;
      }
    });

    const emailForm = document.getElementById('auth-email-form');
    emailForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      this.hideAuthModalError();

      const formData = new FormData(emailForm);
      const email = String(formData.get('email') || '').trim();
      const password = String(formData.get('password') || '');
      const name = String(formData.get('name') || '').trim();

      const submitBtn = document.getElementById('btn-auth-submit');
      try {
        if (submitBtn) submitBtn.disabled = true;
        const { user, profile } = await this.authService.signInOrRegisterWithEmail({
          email,
          password,
          name: name || undefined,
          isRegister: this.isRegisterMode,
        });
        authDialog.close();
        emailForm.reset();
        this.callbacks.showToast(
          `✅ Bienvenido, ${profile.name}. Moneda filtrada: ${profile.defaultCurrency}`
        );
        this.renderProfileTab();
        this.callbacks.onAuthAndProfileUpdated(user, profile, 'login');
      } catch (err) {
        this.showAuthModalError(err?.message || 'Error de autenticación.');
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  setAuthModalMode(isRegister) {
    this.isRegisterMode = isRegister;
    const authDialog = document.getElementById('auth-dialog');
    if (!authDialog) return;

    this.hideAuthModalError();

    authDialog.querySelectorAll('[data-auth-mode]').forEach((btn) => {
      const active = (btn.dataset.authMode === 'register') === isRegister;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', String(active));
    });

    const nameGroup = document.getElementById('auth-register-name-group');
    nameGroup?.classList.toggle('is-hidden', !isRegister);

    const submitBtn = document.getElementById('btn-auth-submit');
    if (submitBtn) {
      submitBtn.textContent = isRegister ? 'Crear Cuenta con Correo' : 'Iniciar Sesión con Correo';
    }
  }

  openAuthModal(registerMode = false) {
    const authDialog = document.getElementById('auth-dialog');
    if (!authDialog) return;
    this.setAuthModalMode(registerMode);
    if (!authDialog.open) {
      if (typeof authDialog.showModal === 'function') {
        authDialog.showModal();
      } else {
        authDialog.setAttribute('open', '');
      }
    }
    const emailInput = document.getElementById('auth-email-input');
    emailInput?.focus();
  }

  showAuthModalError(message) {
    const errEl = document.getElementById('auth-modal-error');
    if (!errEl) return;
    errEl.textContent = message;
    errEl.classList.remove('is-hidden');
  }

  hideAuthModalError() {
    const errEl = document.getElementById('auth-modal-error');
    if (!errEl) return;
    errEl.textContent = '';
    errEl.classList.add('is-hidden');
  }

  setupProfileForm() {
    const profileForm = document.getElementById('profile-settings-form');
    const toggleKeyBtn = document.getElementById('btn-toggle-gemini-key-visibility');
    const clearKeyBtn = document.getElementById('btn-clear-gemini-key');
    const signOutBtn = document.getElementById('btn-profile-signout');
    const openAuthBtn = document.getElementById('btn-profile-open-auth');
    const countrySelect = document.getElementById('profile-country-select');
    const currencySelect = document.getElementById('profile-currency-select');
    const personalViewCheckbox = document.getElementById('profile-personal-view-checkbox');

    if (countrySelect && countrySelect.options.length === 0) {
      countrySelect.innerHTML = SUPPORTED_COUNTRIES.map(
        (c) => `<option value="${c.code}">${c.flag} ${c.name} (${c.defaultCurrency})</option>`
      ).join('');
    }

    toggleKeyBtn?.addEventListener('click', () => {
      const keyInput = document.getElementById('profile-gemini-key-input');
      if (!keyInput) return;
      const isPassword = keyInput.type === 'password';
      keyInput.type = isPassword ? 'text' : 'password';
      toggleKeyBtn.textContent = isPassword ? '🙈 Ocultar' : '👁️ Mostrar';
      toggleKeyBtn.setAttribute('aria-label', isPassword ? 'Ocultar Gemini API Key' : 'Mostrar Gemini API Key');
    });

    clearKeyBtn?.addEventListener('click', () => {
      const keyInput = document.getElementById('profile-gemini-key-input');
      if (keyInput) keyInput.value = '';
      this.authService.geminiKeyStore.setApiKey('');
      this.callbacks.showToast('🔑 Gemini API Key eliminada de localStorage.');
      this.renderProfileTab();
      this.callbacks.onAuthAndProfileUpdated(
        this.authService.getCurrentUser(),
        this.authService.getCurrentProfile(),
        'gemini-key'
      );
    });

    openAuthBtn?.addEventListener('click', () => {
      this.openAuthModal(false);
    });

    signOutBtn?.addEventListener('click', async () => {
      await this.authService.signOut();
      const keyInput = document.getElementById('profile-gemini-key-input');
      const fbApiKeyInput = document.getElementById('profile-fb-apikey-input');
      const fbProjectIdInput = document.getElementById('profile-fb-projectid-input');
      const fbAuthDomainInput = document.getElementById('profile-fb-authdomain-input');
      if (keyInput) keyInput.value = '';
      if (fbApiKeyInput) fbApiKeyInput.value = '';
      if (fbProjectIdInput) fbProjectIdInput.value = '';
      if (fbAuthDomainInput) fbAuthDomainInput.value = '';
      this.callbacks.showToast('🔒 Sesión cerrada y credenciales sensibles limpiadas de localStorage.');
      this.renderProfileTab();
      this.callbacks.onAuthAndProfileUpdated(null, null, 'logout');
    });

    personalViewCheckbox?.addEventListener('change', async () => {
      const user = this.authService.getCurrentUser();
      const uid = user?.uid || 'local_default_user';
      const updated = await this.authService.saveUserProfile(uid, {
        personalViewMode: personalViewCheckbox.checked,
      });
      this.renderProfileTab();
      this.callbacks.onAuthAndProfileUpdated(user, updated, 'personal-view-toggle');
    });

    profileForm?.addEventListener('submit', async (e) => {
      e.preventDefault();

      const nameInput = document.getElementById('profile-name-input');
      const geminiKeyInput = document.getElementById('profile-gemini-key-input');
      const fbApiKeyInput = document.getElementById('profile-fb-apikey-input');
      const fbProjectIdInput = document.getElementById('profile-fb-projectid-input');
      const fbAuthDomainInput = document.getElementById('profile-fb-authdomain-input');

      const name = String(nameInput?.value || '').trim();
      if (name.length < 2) {
        this.callbacks.showToast('⚠️ El nombre debe tener al menos 2 caracteres.');
        nameInput?.focus();
        return;
      }

      const country = countrySelect?.value || 'HN';
      const defaultCurrency = currencySelect?.value || 'HNL';
      const personalViewMode = Boolean(personalViewCheckbox?.checked);
      const geminiApiKey = String(geminiKeyInput?.value || '').trim();

      this.authService.geminiKeyStore.setApiKey(geminiApiKey);

      const fbApiKey = String(fbApiKeyInput?.value || '').trim();
      const fbProjectId = String(fbProjectIdInput?.value || '').trim();
      const fbAuthDomain = String(fbAuthDomainInput?.value || '').trim() || (fbProjectId ? `${fbProjectId}.firebaseapp.com` : '');

      if (fbApiKey && fbProjectId) {
        this.authService.saveFirebaseConfig({
          apiKey: fbApiKey,
          projectId: fbProjectId,
          authDomain: fbAuthDomain,
        });
      }

      const currentUser = this.authService.getCurrentUser();
      const targetUid = currentUser?.uid || 'local_default_user';
      const savedProfile = await this.authService.saveUserProfile(targetUid, {
        name,
        country,
        defaultCurrency,
        personalViewMode,
        filterByDefaultCurrency: true,
      });

      this.renderProfileTab();
      this.callbacks.showToast(
        `💾 Perfil guardado en users/${targetUid} · Moneda por defecto: ${savedProfile.defaultCurrency}`
      );
      this.callbacks.onAuthAndProfileUpdated(currentUser, savedProfile, 'profile-saved');
    });

    // Shared Family Finances ("Compartir Finanzas") handlers
    const shareBtn = document.getElementById('btn-share-workspace');
    const shareEmailInput = document.getElementById('profile-share-email-input');
    const sharedMembersList = document.getElementById('profile-shared-members-list');

    const handleShareSubmit = async () => {
      const targetEmail = String(shareEmailInput?.value || '').trim();
      if (!targetEmail) {
        this.callbacks.showToast('⚠️ Ingresa el correo electrónico del miembro familiar a vincular.');
        shareEmailInput?.focus();
        return;
      }

      try {
        if (shareBtn) shareBtn.disabled = true;
        const { workspaceId, profile, linkedEmail } = await this.authService.shareWorkspaceWithEmail(targetEmail);
        if (shareEmailInput) shareEmailInput.value = '';
        this.renderProfileTab();
        this.callbacks.showToast(
          `👨‍👩‍👧‍👦 Espacio familiar (${workspaceId}) vinculado con ${linkedEmail}`
        );
        this.callbacks.onAuthAndProfileUpdated(
          this.authService.getCurrentUser(),
          profile,
          'workspace-shared'
        );
      } catch (err) {
        this.callbacks.showToast(`⚠️ ${err?.message || 'Error al vincular el espacio familiar.'}`);
      } finally {
        if (shareBtn) shareBtn.disabled = false;
      }
    };

    shareBtn?.addEventListener('click', handleShareSubmit);
    shareEmailInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleShareSubmit();
      }
    });

    sharedMembersList?.addEventListener('click', async (e) => {
      const unlinkBtn = e.target.closest('[data-unlink-email]');
      if (!unlinkBtn) return;
      const emailToRemove = unlinkBtn.dataset.unlinkEmail || '';
      if (!emailToRemove) return;

      const updatedProfile = await this.authService.unlinkSharedMember(emailToRemove);
      this.renderProfileTab();
      this.callbacks.showToast(`Vínculo removido: ${emailToRemove}`);
      this.callbacks.onAuthAndProfileUpdated(
        this.authService.getCurrentUser(),
        updatedProfile,
        'workspace-unlinked'
      );
    });
  }

  renderProfileTab() {
    const user = this.authService.getCurrentUser();
    const profile = this.authService.getCurrentProfile();
    const hasGeminiKey = this.authService.geminiKeyStore.hasApiKey();
    const savedGeminiKey = this.authService.geminiKeyStore.getApiKey();

    const headerAuthBtn = document.getElementById('header-auth-btn');
    if (headerAuthBtn) {
      if (user) {
        const displayName = profile?.name || user.displayName || 'Usuario';
        const initials = displayName
          .split(/\s+/)
          .map((w) => w[0])
          .join('')
          .slice(0, 2)
          .toUpperCase();
        headerAuthBtn.innerHTML = `
          <span class="user-avatar-chip" aria-hidden="true">${initials}</span>
          <span>${displayName}</span>
        `;
        headerAuthBtn.setAttribute('aria-label', `Ver perfil de ${displayName}`);
      } else {
        headerAuthBtn.innerHTML = `
          <span aria-hidden="true">🔐</span>
          <span>Iniciar Sesión</span>
        `;
        headerAuthBtn.setAttribute('aria-label', 'Iniciar sesión o crear cuenta');
      }
    }

    const statusBadgeEl = document.getElementById('profile-auth-status-badge');
    const uidPathEl = document.getElementById('profile-firestore-path');
    const workspaceBadgeEl = document.getElementById('profile-workspace-id-badge');
    const emailDisplayEl = document.getElementById('profile-user-email');
    const signOutBtn = document.getElementById('btn-profile-signout');
    const openAuthBtn = document.getElementById('btn-profile-open-auth');

    const activeUid = user?.uid || profile?.uid || 'local_default_user';
    const activeWorkspaceId = profile?.workspaceId || 'ws_default';
    if (statusBadgeEl) {
      if (user) {
        const providerLabel = user.provider === 'google' ? 'Google Auth' : 'Correo / Contraseña';
        statusBadgeEl.textContent = `Conectado (${providerLabel})`;
        statusBadgeEl.className = 'stmt-badge-new';
      } else {
        statusBadgeEl.textContent = 'Sesión Local (Sin autenticar)';
        statusBadgeEl.className = 'stmt-badge-dup';
      }
    }

    if (uidPathEl) {
      uidPathEl.textContent = `users/${activeUid}`;
    }

    if (workspaceBadgeEl) {
      workspaceBadgeEl.textContent = activeWorkspaceId;
    }

    if (emailDisplayEl) {
      emailDisplayEl.textContent = user?.email || profile?.email || 'Modo sin cuenta (Inicia sesión con Google o Correo)';
    }

    signOutBtn?.classList.toggle('is-hidden', !user);
    openAuthBtn?.classList.toggle('is-hidden', Boolean(user));

    const nameInput = document.getElementById('profile-name-input');
    const countrySelect = document.getElementById('profile-country-select');
    const currencySelect = document.getElementById('profile-currency-select');
    const geminiKeyInput = document.getElementById('profile-gemini-key-input');
    const geminiKeyBadge = document.getElementById('profile-gemini-key-status');
    const personalViewCheckbox = document.getElementById('profile-personal-view-checkbox');

    if (nameInput && profile?.name) {
      nameInput.value = profile.name;
    }
    if (countrySelect && profile?.country) {
      countrySelect.value = profile.country;
    }
    if (currencySelect && profile?.defaultCurrency) {
      currencySelect.value = profile.defaultCurrency;
    }
    if (geminiKeyInput) {
      geminiKeyInput.value = savedGeminiKey;
    }
    if (geminiKeyBadge) {
      geminiKeyBadge.textContent = hasGeminiKey
        ? '✅ Guardada en localStorage (0 costo backend)'
        : '⚪ No configurada (Usando motor 0-Tokens / Servidor)';
      geminiKeyBadge.className = hasGeminiKey ? 'stmt-badge-new' : 'voucher-pill';
    }
    if (personalViewCheckbox) {
      personalViewCheckbox.checked = Boolean(profile?.personalViewMode);
    }

    // Render shared family members list
    const sharedMembersList = document.getElementById('profile-shared-members-list');
    if (sharedMembersList) {
      const sharedEmails = profile?.sharedWithEmails || [];
      if (sharedEmails.length === 0) {
        sharedMembersList.innerHTML = `
          <div class="shared-member-empty">
            Espacio actual: <code>${activeWorkspaceId}</code> · Aún no has vinculado otros correos familiares.
          </div>
        `;
      } else {
        sharedMembersList.innerHTML = sharedEmails
          .map(
            (email) => `
              <div class="shared-member-pill">
                <span>👤 <strong>${email.split('@')[0]}</strong> <small>(${email})</small> · <code>${activeWorkspaceId}</code></span>
                <button
                  type="button"
                  class="btn-secondary btn-sm"
                  data-unlink-email="${email}"
                  aria-label="Desvincular miembro familiar ${email}"
                  title="Desvincular ${email}"
                >
                  ✕ Quitar
                </button>
              </div>
            `
          )
          .join('');
      }
    }

    const customFbCfg = typeof this.authService.getCustomFirebaseConfig === 'function'
      ? this.authService.getCustomFirebaseConfig()
      : null;
    const fbApiKeyInput = document.getElementById('profile-fb-apikey-input');
    const fbProjectIdInput = document.getElementById('profile-fb-projectid-input');
    const fbAuthDomainInput = document.getElementById('profile-fb-authdomain-input');
    if (fbApiKeyInput) fbApiKeyInput.value = customFbCfg?.apiKey || '';
    if (fbProjectIdInput) fbProjectIdInput.value = customFbCfg?.projectId || '';
    if (fbAuthDomainInput) fbAuthDomainInput.value = customFbCfg?.authDomain || '';
  }
}
