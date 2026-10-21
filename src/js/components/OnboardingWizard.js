/**
 * @fileoverview Flujo de "Primer Inicio / Onboarding Wizard" en JavaScript Vanilla (`src/js/components/OnboardingWizard.js`).
 *
 * Responsabilidades:
 * 1. Detección de Primer Inicio (`shouldTriggerOnboarding`):
 *    - Verifica en Firestore `users/{uid}` si `hasCompletedOnboarding` es `false` o no existe.
 *    - Garantiza que el estado inicial de Firestore y local para su `workspaceId` esté completamente LIMPIO
 *      (0 cuentas, 0 transacciones, 0 presupuestos).
 *    - Inicia automáticamente el Wizard interactivo de 4 pasos.
 * 2. Wizard ligero, intuitivo y responsive (4 pasos) sin librerías externas:
 *    - Paso 1: "👋 ¡Bienvenido a Pisto!" + selector de Moneda Principal (HNL por defecto) y País (Honduras por defecto).
 *    - Paso 2: "💳 Cuentas y Metas"
 *    - Paso 3: "📊 Transacciones y Espacio Familiar"
 *    - Paso 4: "🔒 Tus datos son tuyos" + botón principal "🚀 Comenzar a usar Pisto".
 * 3. Finalización del Wizard:
 *    - Cierra el modal `<dialog>`.
 *    - Actualiza en Firestore `users/{uid}` el campo `hasCompletedOnboarding: true`.
 *    - Deja al usuario en su Dashboard limpio con Empty State atractivo y botones principales resaltados
 *      ("➕ Crear Primera Cuenta" y "📷 Importar con Imagen/PDF").
 */

import { CURRENCIES } from '../../../public/js/domain/models.js';
import {
  SUPPORTED_COUNTRIES,
  shouldTriggerOnboarding,
  ensureCleanWorkspaceForFirstTimeUser,
  completeUserOnboarding,
  ZERO_DASHBOARD_METRICS,
  resetGlobalDashboardMetricsToZero,
  renderDashboardMetricsToDom,
  recalculateDashboardMetrics,
  calculateSafeSavingsRate,
} from '../services/firestore.js';
import {
  buildDefaultUserDocument,
  registerNewUserDocument,
  persistOnboardingCompletionInFirestore,
  removeOnboardingWizardFromDom,
  verifyUserOnboardingOnSignIn,
  cleanupOnboardingOnLogout,
} from '../services/auth.js';

export {
  SUPPORTED_COUNTRIES,
  shouldTriggerOnboarding,
  ensureCleanWorkspaceForFirstTimeUser,
  completeUserOnboarding,
  ZERO_DASHBOARD_METRICS,
  resetGlobalDashboardMetricsToZero,
  renderDashboardMetricsToDom,
  recalculateDashboardMetrics,
  calculateSafeSavingsRate,
  buildDefaultUserDocument,
  registerNewUserDocument,
  persistOnboardingCompletionInFirestore,
  removeOnboardingWizardFromDom,
  verifyUserOnboardingOnSignIn,
  cleanupOnboardingOnLogout,
};

export const ONBOARDING_WIZARD_DIALOG_ID = 'onboarding-wizard-dialog';
export const ONBOARDING_FINISH_BUTTON_ID = 'btn-onboarding-finish';
export const ONBOARDING_FINISH_BUTTON_LABEL = '🚀 Comenzar a usar Pisto';

export const EMPTY_STATE_CTA_LABELS = Object.freeze({
  CREATE_FIRST_ACCOUNT: '➕ Crear Primera Cuenta',
  IMPORT_WITH_IMAGE_PDF: '📷 Importar con Imagen/PDF',
});

export const ONBOARDING_STEPS = Object.freeze([
  Object.freeze({
    step: 1,
    id: 'welcome',
    badge: 'Paso 1 de 4 · Bienvenida',
    icon: '👋',
    title: '👋 ¡Bienvenido a Pisto!',
    description:
      'Tu plataforma de control financiero personal y familiar, privada y 100% adaptada a Honduras.',
    hasCurrencyAndCountrySelector: true,
    highlights: [
      '🇭🇳 Moneda Principal HNL (Lempiras) por defecto',
      '💱 Soporte multidivisa (HNL, USD, EUR y más)',
      '⚡ Rápida, privada y lista en segundos',
    ],
  }),
  Object.freeze({
    step: 2,
    id: 'accounts',
    badge: 'Paso 2 de 4 · Tu Patrimonio',
    icon: '💳',
    title: '💳 Cuentas y Metas',
    description:
      'Aquí puedes ver tu patrimonio. Crea manualmente tus cuentas bancarias (Banco Atlántida, BAC, Ficohsa, etc.) o simplemente sube una captura de pantalla / PDF para crearlas en segundos con IA.',
    hasCurrencyAndCountrySelector: false,
    highlights: [
      '🏦 Banco Atlántida, BAC Credomatic, Ficohsa, Banpaís, Davivienda',
      '📷 Importación inteligente desde captura de pantalla o estado de cuenta PDF',
      '🎯 Metas de ahorro y control de tarjetas de crédito',
    ],
  }),
  Object.freeze({
    step: 3,
    id: 'transactions',
    badge: 'Paso 3 de 4 · Control en Tiempo Real',
    icon: '📊',
    title: '📊 Transacciones y Espacio Familiar',
    description:
      'Registra tus gastos diarios o comparte un Token Único de Invitación para llevar las finanzas en pareja o familia en tiempo real.',
    hasCurrencyAndCountrySelector: false,
    highlights: [
      '⚡ Registro rápido en 1 clic o lenguaje natural (0 tokens)',
      '👨‍👩‍👧‍👦 Token Único de Invitación para finanzas compartidas en tiempo real',
      '🔒 Modo Vista Personal para alternar entre gastos propios y familiares',
    ],
  }),
  Object.freeze({
    step: 4,
    id: 'privacy',
    badge: 'Paso 4 de 4 · Privacidad Local-First',
    icon: '🔒',
    title: '🔒 Tus datos son tuyos',
    description:
      'Pisto usa una arquitectura Local-First. Puedes agregar tu Gemini API Key en el Perfil para usar análisis de IA sin costo.',
    hasCurrencyAndCountrySelector: false,
    primaryButtonLabel: ONBOARDING_FINISH_BUTTON_LABEL,
    highlights: [
      '🛡️ Arquitectura Local-First con sincronización segura en Firestore',
      '🔑 Tu Gemini API Key se guarda únicamente en tu navegador',
      '🚀 Empezá hoy con una base de datos 100% limpia y a tu medida',
    ],
  }),
]);

/**
 * Escapes HTML entities safely.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Renders the HTML markup for a specific step of the Onboarding Wizard.
 * @param {number} stepIndex 0-based index (0 to 3)
 * @param {object} [options]
 * @param {string} [options.selectedCurrency]
 * @param {string} [options.selectedCountry]
 * @param {'forward'|'backward'} [options.transitionDirection]
 * @returns {string}
 */
export function renderOnboardingStepMarkup(stepIndex = 0, options = {}) {
  const totalSteps = ONBOARDING_STEPS.length;
  const clampedIndex = Math.max(0, Math.min(totalSteps - 1, Number(stepIndex) || 0));
  const stepData = ONBOARDING_STEPS[clampedIndex];
  const isFirstStep = clampedIndex === 0;
  const isLastStep = clampedIndex === totalSteps - 1;
  const selectedCurrency =
    options.selectedCurrency && CURRENCIES[options.selectedCurrency]
      ? options.selectedCurrency
      : 'HNL';
  const selectedCountry = SUPPORTED_COUNTRIES.some((c) => c.code === options.selectedCountry)
    ? options.selectedCountry
    : 'HN';
  const direction = options.transitionDirection === 'backward' ? 'backward' : 'forward';

  const dotsHtml = ONBOARDING_STEPS.map((s, idx) => {
    const isActive = idx === clampedIndex;
    const isCompleted = idx < clampedIndex;
    return `
      <button
        type="button"
        class="onboarding-step-dot ${isActive ? 'is-active' : ''} ${isCompleted ? 'is-completed' : ''}"
        data-onboarding-step="${idx}"
        aria-label="Ir al paso ${s.step}: ${escapeHtml(s.title)}"
        aria-current="${isActive ? 'step' : 'false'}"
      >
        <span class="onboarding-step-dot-num">${isCompleted ? '✓' : s.step}</span>
      </button>
    `;
  }).join('');

  const selectorHtml = stepData.hasCurrencyAndCountrySelector
    ? `
      <div class="onboarding-selectors-grid" role="group" aria-label="Confirmación de País y Moneda Principal">
        <div class="field onboarding-field">
          <label for="onboarding-country-select">País</label>
          <select id="onboarding-country-select" class="control-select onboarding-select" name="country">
            ${SUPPORTED_COUNTRIES.map(
              (c) =>
                `<option value="${escapeHtml(c.code)}" ${c.code === selectedCountry ? 'selected' : ''}>${escapeHtml(c.flag)} ${escapeHtml(c.name)} (${escapeHtml(c.code)})</option>`
            ).join('')}
          </select>
        </div>
        <div class="field onboarding-field">
          <label for="onboarding-currency-select">Moneda Principal</label>
          <select id="onboarding-currency-select" class="control-select onboarding-select" name="defaultCurrency">
            ${Object.values(CURRENCIES)
              .map(
                (cur) =>
                  `<option value="${escapeHtml(cur.code)}" ${cur.code === selectedCurrency ? 'selected' : ''}>${escapeHtml(cur.code)} (${escapeHtml(cur.symbol)}) — ${escapeHtml(cur.name)}</option>`
              )
              .join('')}
          </select>
        </div>
      </div>
    `
    : '';

  const highlightsHtml = Array.isArray(stepData.highlights) && stepData.highlights.length > 0
    ? `
      <ul class="onboarding-highlights-list">
        ${stepData.highlights.map((item) => `<li class="onboarding-highlight-item">${escapeHtml(item)}</li>`).join('')}
      </ul>
    `
    : '';

  return `
    <div
      class="onboarding-wizard-card"
      data-rendered-component="OnboardingWizard"
      data-current-step="${stepData.step}"
      data-transition-direction="${direction}"
    >
      <div class="onboarding-wizard-topbar">
        <span class="onboarding-step-badge">${escapeHtml(stepData.badge)}</span>
        <div class="onboarding-step-dots" role="tablist" aria-label="Progreso de bienvenida">
          ${dotsHtml}
        </div>
      </div>

      <div class="onboarding-wizard-body">
        <div class="onboarding-hero-icon" aria-hidden="true">${escapeHtml(stepData.icon)}</div>
        <h2 id="onboarding-step-title" class="onboarding-step-title">${escapeHtml(stepData.title)}</h2>
        <p class="onboarding-step-description">${escapeHtml(stepData.description)}</p>
        ${selectorHtml}
        ${highlightsHtml}
      </div>

      <div class="onboarding-wizard-footer">
        <div class="onboarding-footer-left">
          ${
            !isFirstStep
              ? `<button
                  type="button"
                  id="btn-onboarding-prev"
                  class="btn-secondary onboarding-nav-btn"
                  data-onboarding-action="prev"
                >
                  ← Anterior
                </button>`
              : `<span class="onboarding-step-counter-hint">4 pasos rápidos</span>`
          }
        </div>
        <div class="onboarding-footer-right">
          ${
            !isLastStep
              ? `<button
                  type="button"
                  id="btn-onboarding-next"
                  class="btn-primary onboarding-nav-btn"
                  data-onboarding-action="next"
                >
                  Siguiente →
                </button>`
              : `<button
                  type="button"
                  id="${ONBOARDING_FINISH_BUTTON_ID}"
                  class="btn-primary onboarding-finish-btn"
                  data-onboarding-action="finish"
                >
                  ${escapeHtml(ONBOARDING_FINISH_BUTTON_LABEL)}
                </button>`
          }
        </div>
      </div>
    </div>
  `;
}

/**
 * Renders the attractive Dashboard / Accounts Empty State with highlighted primary action buttons
 * ("➕ Crear Primera Cuenta" and "📷 Importar con Imagen/PDF") for users with 0 accounts.
 *
 * @param {object} [options]
 * @param {number} [options.archivedCount]
 * @param {string} [options.baseCurrency]
 * @returns {string}
 */
export function renderDashboardEmptyStateMarkup(options = {}) {
  const archivedCount = Number(options.archivedCount || 0);
  const baseCurrency = String(options.baseCurrency || 'HNL');

  return `
    <div class="empty-state-box onboarding-empty-state-hero" data-empty-state="clean-workspace" style="grid-column: 1 / -1;">
      <div class="onboarding-empty-state-badge">✨ Espacio Financiero Limpio · Moneda ${escapeHtml(baseCurrency)}</div>
      <h3 class="onboarding-empty-state-title">¡Tu Dashboard está listo para tu primera cuenta!</h3>
      <p class="onboarding-empty-state-subtitle">
        ${
          archivedCount > 0
            ? `No tienes cuentas activas visibles. Tienes <strong>${archivedCount} cuenta(s) archivada(s)</strong> que conservan su historial intacto.`
            : 'Comienza creando manualmente tu primera cuenta bancaria o importa un estado de cuenta en Imagen/PDF con IA en segundos.'
        }
      </p>
      <div class="onboarding-empty-state-actions">
        ${
          archivedCount > 0
            ? `<button type="button" class="btn-secondary btn-sm" data-action="toggle-show-archived-accounts">📦 Mostrar Cuentas Archivadas (${archivedCount})</button>`
            : ''
        }
        <button
          type="button"
          id="btn-empty-create-first-account"
          class="btn-primary onboarding-cta-highlight"
          data-action="open-account-modal"
          aria-label="Crear Primera Cuenta bancaria o efectivo"
        >
          ${EMPTY_STATE_CTA_LABELS.CREATE_FIRST_ACCOUNT}
        </button>
        <button
          type="button"
          id="btn-empty-import-account"
          class="btn-primary onboarding-cta-highlight onboarding-cta-highlight-alt"
          data-action="open-import-account-modal"
          commandfor="import-account-dialog"
          command="show-modal"
          aria-label="Importar cuenta con Imagen o PDF"
        >
          ${EMPTY_STATE_CTA_LABELS.IMPORT_WITH_IMAGE_PDF}
        </button>
      </div>
    </div>
  `;
}

export class OnboardingWizard {
  /**
   * @param {object} [options]
   * @param {any} [options.authService]
   * @param {function} [options.getState]
   * @param {any} [options.repo]
   * @param {function} [options.onComplete]
   * @param {function} [options.showToast]
   */
  constructor(options = {}) {
    this.authService = options.authService || null;
    this.getState = typeof options.getState === 'function' ? options.getState : () => null;
    this.repo = options.repo || null;
    this.onComplete = typeof options.onComplete === 'function' ? options.onComplete : null;
    this.showToast = typeof options.showToast === 'function' ? options.showToast : null;

    this.currentStepIndex = 0;
    this.isOpen = false;
    this.isFinishing = false;
    this.selectedCurrency = 'HNL';
    this.selectedCountry = 'HN';
    this.transitionDirection = 'forward';
    this.activeUser = null;
    this.activeProfile = null;
    this.dialogEl = null;
    this._boundClickHandler = null;
    this._boundChangeHandler = null;
    globalThis.__PISTO_ONBOARDING_WIZARD_INSTANCE__ = this;
  }

  init(options = {}) {
    if (typeof document === 'undefined') return this;

    // Solo montar el elemento <dialog> en el DOM cuando se solicita explícitamente o al abrir el Wizard
    if (options.mountDom === false) {
      return this;
    }

    let dialog = document.getElementById(ONBOARDING_WIZARD_DIALOG_ID);
    if (!dialog && document.body) {
      dialog = document.createElement('dialog');
      dialog.id = ONBOARDING_WIZARD_DIALOG_ID;
      dialog.className = 'modal-dialog onboarding-wizard-dialog';
      dialog.setAttribute('closedby', 'any');
      dialog.setAttribute('aria-labelledby', 'onboarding-step-title');
      document.body.appendChild(dialog);
    }

    this.dialogEl = dialog;
    if (this.dialogEl && !this.dialogEl.dataset.onboardingBound) {
      this.dialogEl.dataset.onboardingBound = 'true';

      // Light-dismiss fallback for browsers without native dialog[closedby] support
      if (
        typeof HTMLDialogElement !== 'undefined' &&
        !('closedBy' in HTMLDialogElement.prototype)
      ) {
        this.dialogEl.addEventListener('click', (event) => {
          if (event.target !== this.dialogEl) return;
          const rect = this.dialogEl.getBoundingClientRect?.();
          if (!rect || (rect.width === 0 && rect.height === 0)) return;
          const clickedInDialog =
            rect.top <= event.clientY &&
            event.clientY <= rect.top + rect.height &&
            rect.left <= event.clientX &&
            event.clientX <= rect.left + rect.width;
          if (!clickedInDialog) {
            this.close();
          }
        });
      }

      this._boundClickHandler = (event) => {
        const finishBtn =
          event.target?.closest?.(`#${ONBOARDING_FINISH_BUTTON_ID}`) ||
          event.target?.closest?.('[data-onboarding-action="finish"]');
        if (finishBtn) {
          event.preventDefault();
          if (finishBtn.disabled || this.isFinishing) return;
          finishBtn.disabled = true;
          finishBtn.setAttribute?.('aria-busy', 'true');
          void this.finish({ buttonEl: finishBtn });
          return;
        }

        const actionBtn = event.target?.closest?.('[data-onboarding-action]');
        if (actionBtn) {
          event.preventDefault();
          const action = actionBtn.dataset.onboardingAction;
          if (action === 'next') {
            this.nextStep();
          } else if (action === 'prev') {
            this.prevStep();
          }
          return;
        }

        const stepDot = event.target?.closest?.('[data-onboarding-step]');
        if (stepDot) {
          event.preventDefault();
          const targetIdx = Number.parseInt(stepDot.dataset.onboardingStep, 10);
          if (Number.isFinite(targetIdx)) {
            this.goToStep(targetIdx);
          }
        }
      };

      this._boundChangeHandler = (event) => {
        const target = event.target;
        if (!target) return;
        if (target.id === 'onboarding-country-select') {
          this.setCountry(target.value);
        } else if (target.id === 'onboarding-currency-select') {
          this.setCurrency(target.value);
        }
      };

      this.dialogEl.addEventListener('click', this._boundClickHandler);
      this.dialogEl.addEventListener('change', this._boundChangeHandler);
      this.dialogEl.addEventListener('close', () => {
        this.isOpen = false;
      });
    }

    return this;
  }

  /**
   * Evaluates whether a newly authenticated or registered user requires first-time onboarding.
   * - If `hasCompletedOnboarding === true`: does NOT invoke or render the Wizard, and removes any mounted Wizard modal.
   * - If `hasCompletedOnboarding === false` or `undefined`: cleans workspace and opens the 4-step Wizard.
   *
   * @param {object|null} user
   * @param {object|null} profile
   * @param {object} [context]
   */
  async checkAndStartForUser(user, profile, context = {}) {
    if (!shouldTriggerOnboarding(profile)) {
      this.removeModalFromDom(context.docRef);
      return { triggered: false, cleaned: false };
    }

    this.activeUser = user || null;
    this.activeProfile = profile;
    const uid = user?.uid || profile?.uid || 'local_default_user';
    const workspaceId = profile?.workspaceId || `ws_${uid}`;
    const state = context.state || this.getState();
    const repo = context.repo || this.repo;
    const fsContext =
      context.firestoreContext ||
      (this.authService && typeof this.authService.getFirestoreContext === 'function'
        ? this.authService.getFirestoreContext()
        : {});

    const cleanResult = await ensureCleanWorkspaceForFirstTimeUser({
      workspaceId,
      uid,
      baseCurrency: profile?.defaultCurrency || 'HNL',
      state,
      repo,
      storage: context.storage ?? fsContext.storage,
      firestoreDb: context.firestoreDb ?? fsContext.firestoreDb,
      firestoreModule: context.firestoreModule ?? fsContext.firestoreModule,
      docRef: context.docRef,
    });

    this.open({
      user,
      profile,
      defaultCurrency: profile?.defaultCurrency || 'HNL',
      country: profile?.country || 'HN',
      skipAsyncReset: true,
    });

    return {
      triggered: true,
      cleaned: true,
      workspaceId,
      uid,
      dashboardMetrics: cleanResult.dashboardMetrics,
    };
  }

  open(options = {}) {
    this.init();
    if (options.user !== undefined) this.activeUser = options.user;
    if (options.profile !== undefined) this.activeProfile = options.profile;

    const initialCurrency =
      options.defaultCurrency || this.activeProfile?.defaultCurrency || 'HNL';
    const initialCountry = options.country || this.activeProfile?.country || 'HN';

    this.selectedCurrency = CURRENCIES[initialCurrency] ? initialCurrency : 'HNL';
    this.selectedCountry = SUPPORTED_COUNTRIES.some((c) => c.code === initialCountry)
      ? initialCountry
      : 'HN';
    this.currentStepIndex = 0;
    this.transitionDirection = 'forward';
    this.isOpen = true;
    globalThis.__PISTO_ONBOARDING_WIZARD_OPEN__ = true;

    renderDashboardMetricsToDom(ZERO_DASHBOARD_METRICS, this.selectedCurrency);

    if (!options.skipAsyncReset) {
      const uid =
        this.activeUser?.uid ||
        this.activeProfile?.uid ||
        this.authService?.getCurrentUser?.()?.uid ||
        'local_default_user';
      const workspaceId =
        this.activeProfile?.workspaceId ||
        this.getState()?.settings?.workspaceId ||
        `ws_${uid}`;
      const fsContext =
        this.authService && typeof this.authService.getFirestoreContext === 'function'
          ? this.authService.getFirestoreContext()
          : {};
      void resetGlobalDashboardMetricsToZero({
        workspaceId,
        uid,
        baseCurrency: this.selectedCurrency,
        state: this.getState(),
        repo: this.repo,
        storage: fsContext.storage,
        firestoreDb: fsContext.firestoreDb,
        firestoreModule: fsContext.firestoreModule,
      });
    }

    this.render();

    if (this.dialogEl) {
      if (typeof this.dialogEl.showModal === 'function') {
        try {
          if (!this.dialogEl.open) {
            this.dialogEl.showModal();
          }
        } catch {
          this.dialogEl.setAttribute?.('open', '');
        }
      } else {
        this.dialogEl.setAttribute?.('open', '');
      }
    }

    return this;
  }

  close() {
    this.isOpen = false;
    globalThis.__PISTO_ONBOARDING_WIZARD_OPEN__ = false;
    if (this.dialogEl) {
      if (typeof this.dialogEl.close === 'function' && this.dialogEl.open) {
        try {
          this.dialogEl.close();
        } catch {
          this.dialogEl.removeAttribute?.('open');
        }
      } else {
        this.dialogEl.removeAttribute?.('open');
      }
    }
    return this;
  }

  /**
   * Remueve completamente el modal `<dialog id="onboarding-wizard-dialog">` del DOM.
   * @param {Document} [docRef]
   */
  removeModalFromDom(docRef = typeof document !== 'undefined' ? document : null) {
    this.close();
    if (this.dialogEl) {
      if (typeof this.dialogEl.remove === 'function') {
        this.dialogEl.remove();
      } else if (this.dialogEl.parentNode) {
        this.dialogEl.parentNode.removeChild(this.dialogEl);
      }
      this.dialogEl = null;
    }
    removeOnboardingWizardFromDom(docRef);
    return this;
  }

  /**
   * Limpieza en Cierre de Sesión (`Logout`):
   * Remueve de forma segura cualquier modal del Wizard en el DOM y resetea todos los estados locales.
   * @param {Document} [docRef]
   */
  resetOnLogout(docRef = typeof document !== 'undefined' ? document : null) {
    this.removeModalFromDom(docRef);
    this.currentStepIndex = 0;
    this.isOpen = false;
    this.isFinishing = false;
    this.selectedCurrency = 'HNL';
    this.selectedCountry = 'HN';
    this.transitionDirection = 'forward';
    this.activeUser = null;
    this.activeProfile = null;
    return this;
  }

  /**
   * Muestra el Dashboard principal de la aplicación tras finalizar el Onboarding Wizard.
   * @param {Document} [docRef]
   */
  showDashboardView(docRef = typeof document !== 'undefined' ? document : null) {
    if (!docRef) return;
    const dashboardPanel =
      typeof docRef.getElementById === 'function'
        ? docRef.getElementById('panel-categories') || docRef.getElementById('main-content')
        : null;
    if (dashboardPanel) {
      dashboardPanel.classList?.remove?.('is-hidden');
      dashboardPanel.removeAttribute?.('hidden');
    }
    if (globalThis.pistoApp && typeof globalThis.pistoApp.switchTab === 'function') {
      globalThis.pistoApp.switchTab('categories');
    }
  }

  setCountry(countryCode) {
    const matched = SUPPORTED_COUNTRIES.find((c) => c.code === countryCode);
    if (!matched) return;
    this.selectedCountry = matched.code;
    if (matched.defaultCurrency && CURRENCIES[matched.defaultCurrency]) {
      this.selectedCurrency = matched.defaultCurrency;
      const currencySelect =
        typeof document !== 'undefined'
          ? document.getElementById('onboarding-currency-select')
          : null;
      if (currencySelect) {
        currencySelect.value = this.selectedCurrency;
      }
    }
  }

  setCurrency(currencyCode) {
    if (currencyCode && CURRENCIES[currencyCode]) {
      this.selectedCurrency = currencyCode;
    }
  }

  nextStep() {
    if (this.currentStepIndex < ONBOARDING_STEPS.length - 1) {
      this.transitionDirection = 'forward';
      this.currentStepIndex += 1;
      this.renderWithTransition();
    }
    return this.currentStepIndex;
  }

  prevStep() {
    if (this.currentStepIndex > 0) {
      this.transitionDirection = 'backward';
      this.currentStepIndex -= 1;
      this.renderWithTransition();
    }
    return this.currentStepIndex;
  }

  goToStep(stepIndex) {
    const target = Math.max(0, Math.min(ONBOARDING_STEPS.length - 1, Number(stepIndex) || 0));
    if (target === this.currentStepIndex) return this.currentStepIndex;
    this.transitionDirection = target > this.currentStepIndex ? 'forward' : 'backward';
    this.currentStepIndex = target;
    this.renderWithTransition();
    return this.currentStepIndex;
  }

  renderWithTransition() {
    if (typeof document !== 'undefined' && typeof document.startViewTransition === 'function') {
      document.documentElement.dataset.onboardingTransition = this.transitionDirection;
      const transition = document.startViewTransition(() => {
        this.render();
      });
      transition?.finished
        ?.finally?.(() => {
          delete document.documentElement.dataset.onboardingTransition;
        })
        ?.catch?.(() => {});
      return;
    }
    this.render();
  }

  render() {
    const markup = renderOnboardingStepMarkup(this.currentStepIndex, {
      selectedCurrency: this.selectedCurrency,
      selectedCountry: this.selectedCountry,
      transitionDirection: this.transitionDirection,
    });

    if (this.dialogEl) {
      this.dialogEl.innerHTML = markup;
    }
    return markup;
  }

  /**
   * Completes the Onboarding Wizard when the user clicks "🚀 Comenzar a usar Pisto":
   * a) Disables the button temporarily to prevent multiple clicks.
   * b) Obtains `uid` from Firebase Auth (`auth.currentUser.uid`).
   * c) Executes explicit async update in Firestore:
   *    `await updateDoc(doc(db, "users", auth.currentUser.uid), { hasCompletedOnboarding: true });`
   * d) Removes the modal from the DOM and shows the application Dashboard.
   */
  async finish(customContext = {}) {
    if (this.isFinishing && !customContext.force) {
      return this.activeProfile;
    }
    this.isFinishing = true;

    const finishBtn =
      customContext.buttonEl ||
      (typeof document !== 'undefined'
        ? document.getElementById(ONBOARDING_FINISH_BUTTON_ID)
        : null);
    if (finishBtn) {
      finishBtn.disabled = true;
      finishBtn.setAttribute?.('aria-busy', 'true');
    }

    try {
      const auth =
        customContext.auth ||
        this.authService?.firebaseAuth ||
        globalThis.__PISTO_FIREBASE_AUTH__ || {
          currentUser:
            this.authService?.getCurrentUser?.() ||
            this.activeUser || {
              uid:
                customContext.uid ||
                this.activeProfile?.uid ||
                this.authService?.getCurrentProfile?.()?.uid ||
                'local_default_user',
            },
        };

      const uid = String(
        auth?.currentUser?.uid ||
          customContext.uid ||
          this.activeUser?.uid ||
          this.activeProfile?.uid ||
          this.authService?.getCurrentUser?.()?.uid ||
          this.authService?.getCurrentProfile?.()?.uid ||
          'local_default_user'
      ).trim();

      const fsContext =
        customContext.firestoreContext ||
        (this.authService && typeof this.authService.getFirestoreContext === 'function'
          ? this.authService.getFirestoreContext()
          : {});

      const db = customContext.db ?? customContext.firestoreDb ?? fsContext.firestoreDb ?? null;
      const fsMod = customContext.firestoreModule ?? fsContext.firestoreModule ?? null;
      const doc = customContext.doc ?? fsMod?.doc;
      const updateDoc = customContext.updateDoc ?? fsMod?.updateDoc;

      // c) Actualización asíncrona explícita en Firestore:
      // await updateDoc(doc(db, "users", auth.currentUser.uid), { hasCompletedOnboarding: true });
      const activeAuthWithUser = auth?.currentUser?.uid
        ? auth
        : { ...auth, currentUser: { ...(auth?.currentUser || {}), uid } };

      if (db && typeof doc === 'function' && typeof updateDoc === 'function') {
        try {
          await updateDoc(doc(db, 'users', activeAuthWithUser.currentUser.uid), {
            hasCompletedOnboarding: true,
          });
        } catch {
          // Fallback manejado por completeUserOnboarding / setDoc
        }
      }

      const updatedProfile = await completeUserOnboarding(uid, {
        defaultCurrency: this.selectedCurrency,
        country: this.selectedCountry,
        authService: customContext.authService ?? this.authService,
        firestoreDb: db,
        firestoreModule: fsMod,
        storage: customContext.storage ?? fsContext.storage,
      });

      this.activeProfile = updatedProfile;

      const state = customContext.state || this.getState();
      if (state && typeof state === 'object') {
        if (state.settings && typeof state.settings === 'object') {
          state.settings.baseCurrency = this.selectedCurrency;
          state.settings.currencyFilter = this.selectedCurrency;
        }
        const repo = customContext.repo || this.repo;
        if (repo && typeof repo.saveState === 'function') {
          repo.saveState(state);
        }
      }

      // d) Remueve el modal del DOM y muestra el Dashboard de la aplicación
      this.removeModalFromDom(customContext.docRef);
      this.showDashboardView(customContext.docRef);

      if (this.onComplete) {
        await this.onComplete({
          uid,
          profile: updatedProfile,
          defaultCurrency: this.selectedCurrency,
          country: this.selectedCountry,
          hasCompletedOnboarding: true,
        });
      }

      if (this.showToast) {
        this.showToast('🚀 ¡Bienvenido a Pisto! Crea tu primera cuenta o importa con Imagen/PDF.');
      }

      return updatedProfile;
    } finally {
      this.isFinishing = false;
    }
  }
}

export function createOnboardingWizard(options = {}) {
  return new OnboardingWizard(options);
}

globalThis.__PISTO_ONBOARDING_WIZARD__ = OnboardingWizard;
