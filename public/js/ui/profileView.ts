/**
 * @fileoverview Profile View & Firebase Auth UI Controller (TypeScript).
 *
 * Manages:
 * - Tab 5 ("Perfil") form rendering & bindings (Name, Country, Default Currency,
 *   Gemini API Key in localStorage, Personal View Mode checkbox).
 * - Firebase Auth Login / Register Modal (`#auth-dialog`) supporting Google Sign-In
 *   and Email/Password authentication.
 * - Optional Firebase Project Credentials configuration for live Cloud Firestore `users/{uid}`.
 */

import {
  FirebaseAuthProfileService,
  SUPPORTED_COUNTRIES,
  type AuthUser,
  type UserProfile,
} from '../services/authProfileService.ts';
import { attachDialogLightDismissFallback } from './keypadModal.js';

export interface ProfileViewCallbacks {
  onAuthAndProfileUpdated: (user: AuthUser | null, profile: UserProfile | null, reason?: string) => void;
  showToast: (msg: string) => void;
}

export class ProfileViewController {
  private authService: FirebaseAuthProfileService;
  private callbacks: ProfileViewCallbacks;
  private isRegisterMode: boolean = false;

  constructor(authService: FirebaseAuthProfileService, callbacks: ProfileViewCallbacks) {
    this.authService = authService;
    this.callbacks = callbacks;
  }

  init(): void {
    this.setupAuthDialog();
    this.setupProfileForm();
    this.renderProfileTab();
  }

  private setupAuthDialog(): void {
    const authDialog = document.getElementById('auth-dialog') as HTMLDialogElement | null;
    if (!authDialog) return;

    attachDialogLightDismissFallback(authDialog);

    const modeTabs = authDialog.querySelectorAll('[data-auth-mode]');
    modeTabs.forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = (btn as HTMLElement).dataset.authMode;
        this.setAuthModalMode(mode === 'register');
      });
    });

    const googleBtn = document.getElementById('btn-auth-google');
    googleBtn?.addEventListener('click', async () => {
      try {
        (googleBtn as HTMLButtonElement).disabled = true;
        const { user, profile } = await this.authService.signInWithGoogle();
        authDialog.close();
        this.callbacks.showToast(
          `✅ Sesión iniciada con Google (${user.displayName}). Moneda activa: ${profile.defaultCurrency}`
        );
        this.renderProfileTab();
        this.callbacks.onAuthAndProfileUpdated(user, profile, 'login');
      } catch (err: any) {
        this.showAuthModalError(err?.message || 'Error al iniciar sesión con Google.');
      } finally {
        (googleBtn as HTMLButtonElement).disabled = false;
      }
    });

    const emailForm = document.getElementById('auth-email-form') as HTMLFormElement | null;
    emailForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      this.hideAuthModalError();

      const formData = new FormData(emailForm);
      const email = String(formData.get('email') || '').trim();
      const password = String(formData.get('password') || '');
      const name = String(formData.get('name') || '').trim();

      const submitBtn = document.getElementById('btn-auth-submit') as HTMLButtonElement | null;
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
      } catch (err: any) {
        this.showAuthModalError(err?.message || 'Error de autenticación.');
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  setAuthModalMode(isRegister: boolean): void {
    this.isRegisterMode = isRegister;
    const authDialog = document.getElementById('auth-dialog');
    if (!authDialog) return;

    this.hideAuthModalError();

    authDialog.querySelectorAll('[data-auth-mode]').forEach((btn) => {
      const active = ((btn as HTMLElement).dataset.authMode === 'register') === isRegister;
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

  openAuthModal(registerMode: boolean = false): void {
    const authDialog = document.getElementById('auth-dialog') as HTMLDialogElement | null;
    if (!authDialog) return;
    this.setAuthModalMode(registerMode);
    if (!authDialog.open) {
      if (typeof authDialog.showModal === 'function') {
        authDialog.showModal();
      } else {
        authDialog.setAttribute('open', '');
      }
    }
    const emailInput = document.getElementById('auth-email-input') as HTMLInputElement | null;
    emailInput?.focus();
  }

  private showAuthModalError(message: string): void {
    const errEl = document.getElementById('auth-modal-error');
    if (!errEl) return;
    errEl.textContent = message;
    errEl.classList.remove('is-hidden');
  }

  private hideAuthModalError(): void {
    const errEl = document.getElementById('auth-modal-error');
    if (!errEl) return;
    errEl.textContent = '';
    errEl.classList.add('is-hidden');
  }

  private setupProfileForm(): void {
    const profileForm = document.getElementById('profile-settings-form') as HTMLFormElement | null;
    const toggleKeyBtn = document.getElementById('btn-toggle-gemini-key-visibility');
    const clearKeyBtn = document.getElementById('btn-clear-gemini-key');
    const signOutBtn = document.getElementById('btn-profile-signout');
    const openAuthBtn = document.getElementById('btn-profile-open-auth');
    const countrySelect = document.getElementById('profile-country-select') as HTMLSelectElement | null;
    const currencySelect = document.getElementById('profile-currency-select') as HTMLSelectElement | null;
    const personalViewCheckbox = document.getElementById('profile-personal-view-checkbox') as HTMLInputElement | null;

    if (countrySelect && countrySelect.options.length === 0) {
      countrySelect.innerHTML = SUPPORTED_COUNTRIES.map(
        (c) => `<option value="${c.code}">${c.flag} ${c.name} (${c.defaultCurrency})</option>`
      ).join('');
    }

    toggleKeyBtn?.addEventListener('click', () => {
      const keyInput = document.getElementById('profile-gemini-key-input') as HTMLInputElement | null;
      if (!keyInput) return;
      const isPassword = keyInput.type === 'password';
      keyInput.type = isPassword ? 'text' : 'password';
      toggleKeyBtn.textContent = isPassword ? '🙈 Ocultar' : '👁️ Mostrar';
    });

    clearKeyBtn?.addEventListener('click', () => {
      const keyInput = document.getElementById('profile-gemini-key-input') as HTMLInputElement | null;
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
      this.callbacks.showToast('Sesión cerrada.');
      this.renderProfileTab();
      this.callbacks.onAuthAndProfileUpdated(null, null, 'logout');
    });

    // Live toggle for Personal View Mode checkbox
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

      const nameInput = document.getElementById('profile-name-input') as HTMLInputElement | null;
      const geminiKeyInput = document.getElementById('profile-gemini-key-input') as HTMLInputElement | null;
      const fbApiKeyInput = document.getElementById('profile-fb-apikey-input') as HTMLInputElement | null;
      const fbProjectIdInput = document.getElementById('profile-fb-projectid-input') as HTMLInputElement | null;
      const fbAuthDomainInput = document.getElementById('profile-fb-authdomain-input') as HTMLInputElement | null;

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

      // 1. Save Gemini API Key strictly in browser localStorage
      this.authService.geminiKeyStore.setApiKey(geminiApiKey);

      // 2. Save optional Firebase Cloud credentials if provided
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

      // 3. Persist profile to Firestore collection `users/{uid}`
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
    const shareBtn = document.getElementById('btn-share-workspace') as HTMLButtonElement | null;
    const shareEmailInput = document.getElementById('profile-share-email-input') as HTMLInputElement | null;
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
      } catch (err: any) {
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
      const unlinkBtn = (e.target as HTMLElement).closest('[data-unlink-email]') as HTMLElement | null;
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

  renderProfileTab(): void {
    const user = this.authService.getCurrentUser();
    const profile = this.authService.getCurrentProfile();
    const hasGeminiKey = this.authService.geminiKeyStore.hasApiKey();
    const savedGeminiKey = this.authService.geminiKeyStore.getApiKey();

    // Update header auth button pill
    const headerAuthBtn = document.getElementById('header-auth-btn');
    if (headerAuthBtn) {
      if (user) {
        const initials = (profile?.name || user.displayName || 'U')
          .split(/\s+/)
          .map((w) => w[0])
          .join('')
          .slice(0, 2)
          .toUpperCase();
        headerAuthBtn.innerHTML = `
          <span class="user-avatar-chip">${initials}</span>
          <span>${profile?.name || user.displayName}</span>
        `;
      } else {
        headerAuthBtn.innerHTML = `
          <span>🔐 Iniciar Sesión</span>
        `;
      }
    }

    // Update Profile Tab Card UI
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

    const nameInput = document.getElementById('profile-name-input') as HTMLInputElement | null;
    const countrySelect = document.getElementById('profile-country-select') as HTMLSelectElement | null;
    const currencySelect = document.getElementById('profile-currency-select') as HTMLSelectElement | null;
    const geminiKeyInput = document.getElementById('profile-gemini-key-input') as HTMLInputElement | null;
    const geminiKeyBadge = document.getElementById('profile-gemini-key-status');
    const personalViewCheckbox = document.getElementById('profile-personal-view-checkbox') as HTMLInputElement | null;

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

    const fbCfg = this.authService.getFirebaseConfig();
    const fbApiKeyInput = document.getElementById('profile-fb-apikey-input') as HTMLInputElement | null;
    const fbProjectIdInput = document.getElementById('profile-fb-projectid-input') as HTMLInputElement | null;
    const fbAuthDomainInput = document.getElementById('profile-fb-authdomain-input') as HTMLInputElement | null;
    if (fbCfg) {
      if (fbApiKeyInput) fbApiKeyInput.value = fbCfg.apiKey || '';
      if (fbProjectIdInput) fbProjectIdInput.value = fbCfg.projectId || '';
      if (fbAuthDomainInput) fbAuthDomainInput.value = fbCfg.authDomain || '';
    }
  }
}
