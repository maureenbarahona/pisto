/**
 * @fileoverview Main Application Controller for Pisto Open-Source Personal Finance Manager.
 *
 * Implements:
 * - Clean Architecture UI orchestration across the 4 signature Pisto tabs.
 * - View Transitions API (document.startViewTransition) for smooth tab switching.
 * - Post-interaction form validation (:user-invalid + ARIA sync) per modern-web-guidance.
 * - Hybrid 0-Token Local NLP + On-Demand Firebase Genkit AI Coach with client hash cache.
 */

import {
  Money,
  TRANSACTION_TYPES,
  createTransaction,
  createAccount,
  createCategory,
  extractLast4Digits,
} from './domain/models.js?v=9';
import { StorageRepository } from './repositories/storageRepository.js?v=9';
import {
  computeAccountsSummary,
  computeAccountDetailSummary,
  computePeriodAnalytics,
  groupTransactionsByDay,
} from './services/financeService.js?v=9';
import {
  parseNaturalLanguageLocal,
  buildMicroPayload,
} from './services/tokenOptimizerService.js?v=9';
import {
  decodeVoucherFile,
  matchAccountForVoucher,
  decodeBankStatementPdf,
  parseBankStatementText,
  findDuplicateTransaction,
} from './services/voucherOcrService.js?v=9';
import { renderIcon, renderPistoDonutChart } from './ui/charts.js?v=9';
import {
  KeypadModalController,
  attachDialogLightDismissFallback,
} from './ui/keypadModal.js?v=9';
import { FirebaseAuthProfileService } from './services/authProfileService.js?v=11';
import {
  prepareTransactionForWorkspace,
  subscribeWorkspaceTransactions,
  saveTransactionToWorkspace,
  deleteTransactionFromWorkspace,
  migrateTransactionsToSharedWorkspace,
} from './services/transactions.js?v=12';
import {
  isAccountArchived,
  filterActiveAccounts,
  filterArchivedAccounts,
  filterAccountsForView,
  saveAccountToFirestore,
  archiveAccount,
  unarchiveAccount,
  deleteAccountWithCascade,
} from './services/accounts.js?v=12';
import { DeleteAccountModal } from './ui/deleteAccountModal.js?v=12';
import { ProfileViewController } from './ui/profileView.js?v=12';
import {
  AccountsView,
  setIsImportAccountModalOpen,
  openImportModal,
} from './ui/accountsTab.js?v=19';
import {
  promptDuplicateTransactionModal,
  findAccountDuplicateTransactions,
  resolveDuplicateTransactionAction,
  DUPLICATE_TRANSACTION_ACTIONS,
} from './ui/importAccountModal.js?v=19';
import {
  OnboardingWizard,
  createOnboardingWizard,
  shouldTriggerOnboarding,
  ensureCleanWorkspaceForFirstTimeUser,
  completeUserOnboarding,
  renderDashboardEmptyStateMarkup,
  ONBOARDING_STEPS,
  ONBOARDING_FINISH_BUTTON_LABEL,
  EMPTY_STATE_CTA_LABELS,
} from './ui/onboardingWizard.js?v=19';
import {
  DEMO_SEED_ACCOUNT_IDS,
  ZERO_DASHBOARD_METRICS,
  isDemoOrResidualTransaction,
  isDemoOrResidualAccount,
  filterCleanUserTransactions,
  filterCleanUserAccounts,
  calculateSafeSavingsRate,
  formatDashboardKpiLabels,
  renderDashboardMetricsToDom,
  renderDashboardKpiElementsToZero,
  recalculateDashboardMetrics,
  purgeResidualTransactionsFromWorkspace,
  resetGlobalDashboardMetricsToZero,
  initializeDashboardStateForNewUser,
} from './services/dashboard.js?v=20';

export {
  openImportModal,
  OnboardingWizard,
  createOnboardingWizard,
  shouldTriggerOnboarding,
  ensureCleanWorkspaceForFirstTimeUser,
  completeUserOnboarding,
  renderDashboardEmptyStateMarkup,
  ONBOARDING_STEPS,
  ONBOARDING_FINISH_BUTTON_LABEL,
  EMPTY_STATE_CTA_LABELS,
  DEMO_SEED_ACCOUNT_IDS,
  ZERO_DASHBOARD_METRICS,
  isDemoOrResidualTransaction,
  isDemoOrResidualAccount,
  filterCleanUserTransactions,
  filterCleanUserAccounts,
  calculateSafeSavingsRate,
  formatDashboardKpiLabels,
  renderDashboardMetricsToDom,
  renderDashboardKpiElementsToZero,
  recalculateDashboardMetrics,
  purgeResidualTransactionsFromWorkspace,
  resetGlobalDashboardMetricsToZero,
  initializeDashboardStateForNewUser,
};

export class FinanceAppController {
  constructor() {
    globalThis.pistoApp = this;
    this.repo = new StorageRepository();
    this.authService = new FirebaseAuthProfileService();
    this.workspaceTransactionsUnsubscribe = null;
    this.state = this.repo.loadState();
    if (this.state.settings.periodFilter !== 'custom') {
      this.state.settings.startDate = '';
      this.state.settings.endDate = '';
    } else {
      this.state.settings.startDate = this.state.settings.startDate || '';
      this.state.settings.endDate = this.state.settings.endDate || '';
    }
    this.activeTab = 'categories';
    this.showArchivedAccounts = Boolean(this.state.settings?.showArchivedAccounts ?? false);
    this.isImportAccountModalOpen = false;
    this.ledgerFilters = {
      searchQuery: '',
      typeFilter: 'all',
      accountFilter: 'all',
      currencyFilter: 'all',
    };
    this.activeDetailAccountId = null;
    this.accountDetailFilters = {
      startDate: '',
      endDate: '',
      period: 'all',
      searchQuery: '',
    };
    this.insightsCache = new Map();
    this.lastInsightsResult = null;
    this.pendingDeleteCallback = null;
    this.lastScannedVoucher = null;
    this.currentStatementData = null;
    this.preferredStatementAccountId = null;
    this.profileView = new ProfileViewController(this.authService, {
      onAuthAndProfileUpdated: (user, profile, reason) =>
        this.handleAuthAndProfileUpdated(user, profile, reason),
      showToast: (msg) => this.showToast(msg),
    });
    this.accountsView = null;
    this.onboardingWizard = new OnboardingWizard({
      authService: this.authService,
      getState: () => this.state,
      repo: this.repo,
      showToast: (msg) => this.showToast(msg),
      onComplete: ({ defaultCurrency }) => {
        if (defaultCurrency) {
          this.state.settings.baseCurrency = defaultCurrency;
          this.state.settings.currencyFilter = defaultCurrency;
          this.ledgerFilters.currencyFilter = defaultCurrency;
        }
        this.repo.saveState(this.state);
        this.profileView?.renderProfileTab?.();
        this.renderAll();
      },
    });
  }

  async init() {
    this.setupKeypadModal();
    this.setupAccountModal();
    this.setupImportAccountModal();
    this.setupAccountDetailModal();
    this.setupCategoryModal();
    this.setupDeleteWarningModal();
    this.setupVoucherScannerModal();
    this.setupStatementImportModal();
    this.setupValidationAriaSync();
    this.setupPrivacyConsentBanner();
    this.onboardingWizard.init();
    this.bindGlobalEvents();
    this.applyTheme(this.state.settings?.theme || 'system');
    this.profileView.init();

    const { user, profile } = await this.authService.init();
    if (user || profile) {
      this.handleAuthAndProfileUpdated(user, profile, 'init');
      this.profileView.renderProfileTab();
    } else {
      this.renderAll();
    }
    this.fetchServerAiStatus();
  }

  /**
   * Synchronizes Dashboard baseCurrency, automatic transaction currency filtering, Personal View Mode,
   * First-Time Onboarding Wizard (clean workspace: 0 accounts, 0 transactions, 0 budgets),
   * and Shared Family Workspace (`workspaceId`) realtime listener whenever the user logs in or updates their `users/{uid}` profile.
   */
  handleAuthAndProfileUpdated(user, profile, reason = '') {
    if (profile) {
      const nextUid = user?.uid || profile.uid || 'local_default_user';
      const nextEmail = user?.email || profile.email || 'personal@pisto.hn';
      const nextWorkspaceId = profile.workspaceId || 'ws_default';
      const isFirstTimeUser = shouldTriggerOnboarding(profile);

      this.state.settings.currentUid = nextUid;
      this.state.settings.personalViewMode = Boolean(profile.personalViewMode);
      this.state.settings.workspaceId = nextWorkspaceId;

      const { firestoreDb, firestoreModule, storage } = this.authService.getFirestoreContext();

      if (isFirstTimeUser && reason !== 'profile-saved') {
        // 1a. Guarantee initial workspace state & Dashboard KPIs are strictly ZERO (0 accounts, 0 transactions, 0 budgets)
        this.state.accounts = [];
        this.state.transactions = [];
        this.state.budgets = {};
        if (Array.isArray(this.state.categories)) {
          this.state.categories = this.state.categories.map((cat) => ({
            ...cat,
            defaultBudget: 0,
          }));
        }
        void resetGlobalDashboardMetricsToZero({
          workspaceId: nextWorkspaceId,
          uid: nextUid,
          baseCurrency: profile.defaultCurrency || this.state.settings.baseCurrency || 'HNL',
          state: this.state,
          repo: this.repo,
          storage,
          firestoreDb,
          firestoreModule,
        });
        // 1b. Automatically start the interactive Onboarding Wizard
        void this.onboardingWizard?.checkAndStartForUser(user, profile, {
          state: this.state,
          repo: this.repo,
        });
      } else {
        // Purge any demo/seed accounts or transactions (`tx_seed_*`, `acc_seed_*`) so authenticated workspaces stay clean
        if (nextWorkspaceId && nextWorkspaceId !== 'ws_default') {
          this.state.accounts = filterCleanUserAccounts(this.state.accounts || [], {
            workspaceId: nextWorkspaceId,
            currentUid: nextUid,
            excludeDemoSeeds: true,
          });
          this.state.transactions = (this.state.transactions || []).filter(
            (tx) => !/^tx_seed_/i.test(String(tx?.id || '')) && tx?.isDemo !== true
          );
        }

        if (Array.isArray(this.state.transactions)) {
          this.state.transactions.forEach((tx) => {
            if (/^tx_seed_/i.test(String(tx?.id || ''))) return;
            if (tx.workspaceId === 'ws_default' || tx.createdByUid === nextUid) {
              tx.workspaceId = nextWorkspaceId;
            }
            if (tx.createdByUid === 'local_default_user' && nextUid !== 'local_default_user') {
              tx.createdByUid = nextUid;
              tx.ownerUid = nextUid;
              if (!tx.createdByEmail || tx.createdByEmail === 'personal@pisto.hn') {
                tx.createdByEmail = nextEmail;
              }
            }
          });
        }
      }

      if (profile.defaultCurrency) {
        this.state.settings.baseCurrency = profile.defaultCurrency;
        if (reason === 'login' || reason === 'profile-saved' || reason === 'init') {
          this.ledgerFilters.currencyFilter = profile.defaultCurrency;
          this.state.settings.currencyFilter = profile.defaultCurrency;
        }
      }
      this.repo.saveState(this.state);

      // Ensure member transactions are migrated & subscribed via workspaceId query
      if (!isFirstTimeUser && nextWorkspaceId && nextWorkspaceId !== 'ws_default') {
        migrateTransactionsToSharedWorkspace(
          nextWorkspaceId,
          [nextUid],
          [nextEmail, ...(profile.sharedWithEmails || [])],
          storage,
          firestoreDb,
          firestoreModule
        ).catch(() => {});
      }
      this.syncWorkspaceSubscription(user, profile);
    } else if (reason === 'logout') {
      if (typeof this.workspaceTransactionsUnsubscribe === 'function') {
        this.workspaceTransactionsUnsubscribe();
        this.workspaceTransactionsUnsubscribe = null;
      }
      this.state.settings.currentUid = 'local_default_user';
      this.state.settings.personalViewMode = false;
      this.state.settings.workspaceId = 'ws_default';
      this.state.settings.currencyFilter = 'all';
      this.ledgerFilters.currencyFilter = 'all';
      this.repo.saveState(this.state);
    }
    this.renderAll();
  }

  /**
   * Subscribes to Firestore / Local-First workspace transactions using:
   * - `where("workspaceId", "==", currentUserProfile.workspaceId)` when `personalViewMode === false`
   * - `where("workspaceId", "==", currentUserProfile.workspaceId)` + `where("createdByUid", "==", currentUser.uid)` when `personalViewMode === true`
   */
  syncWorkspaceSubscription(user, profile) {
    if (typeof this.workspaceTransactionsUnsubscribe === 'function') {
      this.workspaceTransactionsUnsubscribe();
      this.workspaceTransactionsUnsubscribe = null;
    }
    if (!profile) return;

    const { firestoreDb, firestoreModule, storage } = this.authService.getFirestoreContext();
    const workspaceId = profile.workspaceId || 'ws_default';
    const personalViewMode = Boolean(profile.personalViewMode);
    const currentUid = user?.uid || profile.uid || this.state.settings.currentUid;

    this.workspaceTransactionsUnsubscribe = subscribeWorkspaceTransactions(
      {
        workspaceId,
        personalViewMode,
        currentUid,
        firestoreDb,
        firestoreModule,
        storage,
      },
      (workspaceTransactions) => {
        const excludeDemoSeeds = Boolean(workspaceId && workspaceId !== 'ws_default');
        const cleanExisting = filterCleanUserTransactions(this.state.transactions || [], {
          workspaceId,
          currentUid,
          excludeDemoSeeds,
        });
        const cleanIncoming = filterCleanUserTransactions(workspaceTransactions || [], {
          workspaceId,
          currentUid,
          excludeDemoSeeds,
        });

        if (cleanIncoming.length === 0) {
          if (cleanExisting.length !== (this.state.transactions || []).length) {
            this.state.transactions = cleanExisting;
            this.repo.saveState(this.state);
            this.renderAll();
          }
          return;
        }

        const mergedById = new Map();
        for (const tx of cleanExisting) {
          if (tx && tx.id) mergedById.set(tx.id, tx);
        }
        let hasChanges = cleanExisting.length !== (this.state.transactions || []).length;
        for (const incomingTx of cleanIncoming) {
          if (!incomingTx || !incomingTx.id) continue;
          const prev = mergedById.get(incomingTx.id);
          if (
            !prev ||
            prev.workspaceId !== incomingTx.workspaceId ||
            prev.amount !== incomingTx.amount ||
            prev.note !== incomingTx.note ||
            prev.createdByEmail !== incomingTx.createdByEmail
          ) {
            hasChanges = true;
          }
          mergedById.set(incomingTx.id, createTransaction({ ...prev, ...incomingTx }));
        }
        if (hasChanges || mergedById.size !== (this.state.transactions || []).length) {
          this.state.transactions = Array.from(mergedById.values()).sort((a, b) => {
            if (b.date !== a.date) return String(b.date).localeCompare(String(a.date));
            return String(b.createdAt).localeCompare(String(a.createdAt));
          });
          this.repo.saveState(this.state);
          this.renderAll();
        }
      }
    );
  }

  /**
   * Handles clicks on the Header "🔐 Iniciar Sesión" / User Profile button (#header-auth-btn).
   * Opens the Firebase Auth modal when unauthenticated, or navigates to the Profile tab when logged in.
   */
  handleHeaderAuthButtonClick() {
    const user = this.authService.getCurrentUser();
    if (user) {
      this.switchTab('profile');
    } else {
      this.profileView.openAuthModal(false);
    }
  }

  getActiveOwnerMetadata() {
    const user = this.authService.getCurrentUser();
    const profile = this.authService.getCurrentProfile();
    const createdByUid =
      user?.uid || profile?.uid || this.state.settings?.currentUid || 'local_default_user';
    const createdByEmail =
      user?.email || profile?.email || 'personal@pisto.hn';
    const workspaceId =
      profile?.workspaceId || this.state.settings?.workspaceId || 'ws_default';

    return {
      createdByUid,
      createdByEmail,
      workspaceId,
      ownerUid: createdByUid,
      ownerName: profile?.name || user?.displayName || createdByEmail.split('@')[0],
    };
  }

  /**
   * Creates or updates a transaction with mandatory workspace & author metadata
   * (`workspaceId`, `createdByUid`, `createdByEmail`) and syncs it to the shared workspace store & Firestore.
   */
  recordWorkspaceTransaction(txInput, existingTx = null) {
    const user = this.authService.getCurrentUser();
    const profile = this.authService.getCurrentProfile();
    const { firestoreDb, firestoreModule, storage } = this.authService.getFirestoreContext();

    let preparedTx;
    if (existingTx) {
      preparedTx = createTransaction({
        ...existingTx,
        ...txInput,
        id: existingTx.id,
        createdAt: existingTx.createdAt,
        workspaceId:
          existingTx.workspaceId && existingTx.workspaceId !== 'ws_default'
            ? existingTx.workspaceId
            : (profile?.workspaceId || this.state.settings?.workspaceId || 'ws_default'),
        createdByUid: existingTx.createdByUid || user?.uid || profile?.uid || 'local_default_user',
        createdByEmail: existingTx.createdByEmail || user?.email || profile?.email || 'personal@pisto.hn',
      });
    } else {
      preparedTx = prepareTransactionForWorkspace(
        {
          ...txInput,
          ...this.getActiveOwnerMetadata(),
        },
        user,
        profile
      );
    }

    saveTransactionToWorkspace(preparedTx, user, profile, {
      firestoreDb,
      firestoreModule,
      storage,
    }).catch(() => {});

    return preparedTx;
  }

  async registerTransactionWithDeduplication(txInput) {
    const dupCheck = findAccountDuplicateTransactions(
      txInput,
      this.state.transactions || [],
      txInput.accountId
    );

    if (dupCheck.isDuplicate && dupCheck.duplicateTransaction) {
      const action = await promptDuplicateTransactionModal(
        txInput,
        dupCheck.duplicateTransaction
      );
      const { firestoreDb, firestoreModule, storage } = this.authService.getFirestoreContext();
      const resolved = await resolveDuplicateTransactionAction({
        action,
        candidateTx: {
          ...txInput,
          ...this.getActiveOwnerMetadata(),
        },
        existingTx: dupCheck.duplicateTransaction,
        state: this.state,
        context: {
          currentUser: this.authService.getCurrentUser(),
          currentUserProfile: this.authService.getCurrentProfile(),
          workspaceId: this.state.settings?.workspaceId || 'ws_default',
          firestoreDb,
          firestoreModule,
          storage,
        },
      });

      this.repo.saveState(this.state);
      if (resolved.action === DUPLICATE_TRANSACTION_ACTIONS.SKIP) {
        this.showToast('🚫 Transacción duplicada omitida.');
      } else if (resolved.action === DUPLICATE_TRANSACTION_ACTIONS.OVERWRITE && resolved.savedTransaction) {
        this.showToast(
          `✏️ Transacción existente actualizada: ${Money.format(resolved.savedTransaction.amount, resolved.savedTransaction.currency)}`
        );
      } else if (resolved.savedTransaction) {
        this.showToast(
          `➕ Nueva transacción registrada: ${Money.format(resolved.savedTransaction.amount, resolved.savedTransaction.currency)}`
        );
      }
      this.renderAll();
      return resolved.savedTransaction;
    }

    const newTx = this.recordWorkspaceTransaction(txInput, null);
    this.state.transactions.unshift(newTx);
    this.repo.saveState(this.state);
    this.showToast(`Transacción registrada: ${Money.format(newTx.amount, newTx.currency)}`);
    this.renderAll();
    return newTx;
  }

  setupKeypadModal() {
    const dialogEl = document.getElementById('tx-dialog');
    this.keypadModal = new KeypadModalController({
      dialogEl,
      onSubmit: async (txInput) => {
        const existingIdx = txInput.id
          ? this.state.transactions.findIndex((t) => t.id === txInput.id)
          : -1;

        if (existingIdx !== -1) {
          const prevTx = this.state.transactions[existingIdx];
          const updatedTx = this.recordWorkspaceTransaction(txInput, prevTx);
          this.state.transactions[existingIdx] = updatedTx;
          this.repo.saveState(this.state);
          this.showToast(
            `Transacción actualizada: ${Money.format(updatedTx.amount, updatedTx.currency)}`
          );
          this.renderAll();
        } else {
          await this.registerTransactionWithDeduplication(txInput);
        }
      },
      onDelete: (txId) => {
        this.deleteTransaction(txId);
      },
    });
  }

  openTransactionDetail(txId) {
    if (!txId) return;
    const tx = this.state.transactions.find((t) => t.id === txId);
    if (!tx) return;
    this.keypadModal.open(this.state, tx);
  }

  deleteTransaction(txId) {
    if (!txId) return;
    const targetTx = this.state.transactions.find((t) => t.id === txId);
    const wsId =
      targetTx?.workspaceId ||
      this.authService.getCurrentProfile()?.workspaceId ||
      this.state.settings?.workspaceId ||
      'ws_default';
    this.state.transactions = this.state.transactions.filter((t) => t.id !== txId);
    this.repo.saveState(this.state);
    deleteTransactionFromWorkspace(txId, wsId, this.authService.getFirestoreContext()).catch(
      () => {}
    );
    this.showToast('Transacción eliminada.');
    this.renderAll();
  }

  syncColorSwatches(inputId, colorValue) {
    const normalized = String(colorValue || '#10b981').toLowerCase();
    const inputEl = document.getElementById(inputId);
    if (inputEl) {
      inputEl.value = normalized;
    }
    document.querySelectorAll(`[data-color-target="${inputId}"]`).forEach((btn) => {
      const swatchVal = String(btn.dataset.colorValue || '').toLowerCase();
      btn.classList.toggle('is-selected', swatchVal === normalized);
    });
  }

  getDefaultIconForAccountType(accType) {
    return accType === 'savings'
      ? 'piggy'
      : accType === 'debt'
        ? 'debt'
        : accType === 'cash'
          ? 'cash'
          : accType === 'card'
            ? 'card'
            : 'bank';
  }

  getDefaultColorForAccountType(accType) {
    return accType === 'savings'
      ? '#06b6d4'
      : accType === 'debt'
        ? '#f43f5e'
        : accType === 'cash'
          ? '#10b981'
          : accType === 'card'
            ? '#8b5cf6'
            : '#3b82f6';
  }

  setupAccountModal() {
    const accountDialog = document.getElementById('account-dialog');
    if (!accountDialog) return;

    attachDialogLightDismissFallback(accountDialog);

    const institutionSelect = document.getElementById('acc-institution-select');
    const nameInput = document.getElementById('acc-name-input');
    const typeSelect = document.getElementById('acc-type-select');
    const iconSelect = document.getElementById('acc-icon-select');
    const colorInput = document.getElementById('acc-color-input');
    const idInput = document.getElementById('acc-id-input');

    institutionSelect?.addEventListener('change', () => {
      const selectedEntity = institutionSelect.value;
      if (selectedEntity && nameInput && !nameInput.value.trim()) {
        nameInput.value = selectedEntity;
      }
    });

    typeSelect?.addEventListener('change', () => {
      if (!idInput?.value) {
        const nextType = typeSelect.value || 'bank';
        if (iconSelect) {
          iconSelect.value = this.getDefaultIconForAccountType(nextType);
        }
        this.syncColorSwatches('acc-color-input', this.getDefaultColorForAccountType(nextType));
      }
    });

    colorInput?.addEventListener('input', () => {
      this.syncColorSwatches('acc-color-input', colorInput.value);
    });

    accountDialog.addEventListener('click', (e) => {
      const swatchBtn = e.target.closest('[data-color-target="acc-color-input"]');
      if (swatchBtn) {
        this.syncColorSwatches('acc-color-input', swatchBtn.dataset.colorValue);
      }
    });

    const form = document.getElementById('account-modal-form');
    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!form.checkValidity()) return;

      const formData = new FormData(form);
      const existingId = String(formData.get('id') || '').trim();
      const existingAcc = existingId
        ? this.state.accounts.find((a) => a.id === existingId)
        : null;
      const accType = formData.get('type') || 'bank';
      const defaultIcon = this.getDefaultIconForAccountType(accType);

      const accEntity = createAccount({
        id: existingId || undefined,
        name: formData.get('name'),
        type: accType,
        institution: formData.get('institution') || '',
        accountNumber: formData.get('accountNumber') || '',
        currency: formData.get('currency'),
        initialBalance: Number.parseFloat(formData.get('initialBalance') || '0'),
        targetAmount: Number.parseFloat(formData.get('targetAmount') || '0'),
        includeInTotal: formData.get('includeInTotal') === 'on',
        color: formData.get('color') || '#10b981',
        icon: formData.get('icon') || defaultIcon,
        isArchived: existingAcc ? Boolean(existingAcc.isArchived) : false,
        status: existingAcc?.status || 'active',
        workspaceId: this.state.settings?.workspaceId || 'ws_default',
        createdByUid: this.state.settings?.currentUid || 'local_default_user',
      });

      if (existingId) {
        const idx = this.state.accounts.findIndex((a) => a.id === existingId);
        if (idx !== -1) {
          this.state.accounts[idx] = accEntity;
        }
        this.showToast(`Cuenta o meta "${accEntity.name}" actualizada.`);
      } else {
        this.state.accounts.push(accEntity);
        this.showToast(`Cuenta o meta "${accEntity.name}" creada correctamente.`);
      }

      saveAccountToFirestore(accEntity, this.getAccountServiceContext()).catch(() => {});
      this.repo.saveState(this.state);
      accountDialog.close();
      form.reset();
      this.renderAll();
    });
  }

  getAccountServiceContext() {
    const { firestoreDb, firestoreModule, storage } = this.authService.getFirestoreContext();
    const user = this.authService.getCurrentUser();
    const profile = this.authService.getCurrentProfile();
    return {
      workspaceId: profile?.workspaceId || this.state.settings?.workspaceId || 'ws_default',
      currentUid: user?.uid || profile?.uid || this.state.settings?.currentUid || 'local_default_user',
      firestoreDb,
      firestoreModule,
      storage,
    };
  }

  openAccountModal(accountId = null) {
    const accountDialog = document.getElementById('account-dialog');
    const form = document.getElementById('account-modal-form');
    const titleEl = document.getElementById('account-dialog-title');
    if (!accountDialog || !form) return;

    form.reset();
    const existing = accountId ? this.state.accounts.find((a) => a.id === accountId) : null;
    const resolvedType = existing ? existing.type : 'bank';
    const resolvedIcon = existing?.icon || this.getDefaultIconForAccountType(resolvedType);
    const resolvedColor = existing?.color || this.getDefaultColorForAccountType(resolvedType);

    document.getElementById('acc-id-input').value = existing ? existing.id : '';
    document.getElementById('acc-name-input').value = existing ? existing.name : '';
    const institutionSelect = document.getElementById('acc-institution-select');
    if (institutionSelect) {
      institutionSelect.value = existing?.institution || '';
    }
    const numberInput = document.getElementById('acc-number-input');
    if (numberInput) {
      numberInput.value = existing?.accountNumber || '';
    }
    document.getElementById('acc-type-select').value = resolvedType;
    document.getElementById('acc-currency-select').value =
      existing ? existing.currency : (this.state.settings?.baseCurrency || 'USD');
    document.getElementById('acc-initial-balance').value = existing ? existing.initialBalance : 0;
    document.getElementById('acc-target-amount').value = existing ? existing.targetAmount : 0;
    const iconSelect = document.getElementById('acc-icon-select');
    if (iconSelect) {
      iconSelect.value = resolvedIcon;
    }
    this.syncColorSwatches('acc-color-input', resolvedColor);
    document.getElementById('acc-include-checkbox').checked = existing ? Boolean(existing.includeInTotal) : true;

    if (titleEl) {
      titleEl.textContent = existing ? 'Modificar Cuenta o Meta' : 'Nueva Cuenta o Meta';
    }

    accountDialog.showModal();
  }

  setupDeleteWarningModal() {
    const warningDialog = document.getElementById('delete-warning-dialog');
    if (!warningDialog) return;

    this.deleteAccountModal = new DeleteAccountModal({
      dialogEl: warningDialog,
      onArchive: async (accountId) => {
        await this.archiveAccountById(accountId);
      },
      onCascadeDelete: async (accountId) => {
        await this.deleteAccountCascadeById(accountId);
      },
    });
  }

  promptDeleteAccount(accountId) {
    const target = this.state.accounts.find((a) => a.id === accountId);
    if (!target) return;

    const summary = this.currentAccountsSummary || computeAccountsSummary(this.state);
    const accWithBalance =
      summary.accountsWithBalance?.find((a) => a.id === accountId) || target;
    const currentBalance = accWithBalance.currentBalance ?? target.initialBalance ?? 0;
    const relatedTxCount = this.state.transactions.filter(
      (tx) => tx.accountId === accountId || tx.toAccountId === accountId
    ).length;

    if (this.deleteAccountModal) {
      this.deleteAccountModal.open({
        account: target,
        currentBalance,
        txCount: relatedTxCount,
      });
    } else {
      this.archiveAccountById(accountId);
    }
  }

  async archiveAccountById(accountId) {
    try {
      const { account, preservedTxCount } = await archiveAccount(
        accountId,
        this.state,
        this.getAccountServiceContext()
      );
      this.repo.saveState(this.state);
      this.showToast(
        `📦 Cuenta "${account.name}" archivada (${preservedTxCount} movimiento(s) históricos conservados).`
      );
      this.renderAll();
    } catch (err) {
      this.showToast(`⚠️ ${err?.message || 'Error al archivar la cuenta.'}`);
    }
  }

  async unarchiveAccountById(accountId) {
    try {
      const { account } = await unarchiveAccount(
        accountId,
        this.state,
        this.getAccountServiceContext()
      );
      this.repo.saveState(this.state);
      this.showToast(`♻️ Cuenta "${account.name}" reactivada y disponible en tus selectores.`);
      this.renderAll();
    } catch (err) {
      this.showToast(`⚠️ ${err?.message || 'Error al reactivar la cuenta.'}`);
    }
  }

  async deleteAccountCascadeById(accountId) {
    try {
      const { deletedAccount, deletedTransactionsCount } = await deleteAccountWithCascade(
        accountId,
        this.state,
        this.getAccountServiceContext()
      );
      if (this.activeDetailAccountId === accountId) {
        this.activeDetailAccountId = null;
        document.getElementById('account-detail-dialog')?.close();
      }
      this.repo.saveState(this.state);
      this.showToast(
        `🗑️ Cuenta "${deletedAccount?.name || accountId}" y ${deletedTransactionsCount} transacción(es) eliminadas permanentemente en cascada.`
      );
      this.renderAll();
    } catch (err) {
      this.showToast(`⚠️ ${err?.message || 'Error al eliminar la cuenta en cascada.'}`);
    }
  }

  /**
   * Configures Modal 7: Interactive Account Detail & Date-Range Transaction Explorer (#account-detail-dialog).
   */
  setupAccountDetailModal() {
    const dialogEl = document.getElementById('account-detail-dialog');
    if (!dialogEl) return;

    attachDialogLightDismissFallback(dialogEl);

    const startInput = document.getElementById('acc-detail-start-date');
    const endInput = document.getElementById('acc-detail-end-date');
    const allBtn = document.getElementById('btn-acc-detail-all');
    const monthBtn = document.getElementById('btn-acc-detail-month');
    const syncBtn = document.getElementById('btn-acc-detail-sync-dashboard');
    const searchInput = document.getElementById('acc-detail-search-input');
    const uploadStmtBtn = document.getElementById('btn-acc-detail-upload-stmt');
    const addTxBtn = document.getElementById('btn-acc-detail-add-tx');
    const viewInLedgerBtn = document.getElementById('btn-acc-detail-view-in-ledger');
    const editAccBtn = document.getElementById('btn-acc-detail-edit-account');

    editAccBtn?.addEventListener('click', () => {
      if (this.activeDetailAccountId) {
        this.openAccountModal(this.activeDetailAccountId);
      }
    });

    const handleDateChange = () => {
      this.accountDetailFilters.startDate = startInput?.value || '';
      this.accountDetailFilters.endDate = endInput?.value || '';
      this.accountDetailFilters.period =
        this.accountDetailFilters.startDate || this.accountDetailFilters.endDate ? 'custom' : 'all';
      this.renderAccountDetailModal();
    };

    startInput?.addEventListener('change', handleDateChange);
    endInput?.addEventListener('change', handleDateChange);

    allBtn?.addEventListener('click', () => {
      this.accountDetailFilters.startDate = '';
      this.accountDetailFilters.endDate = '';
      this.accountDetailFilters.period = 'all';
      if (startInput) startInput.value = '';
      if (endInput) endInput.value = '';
      this.renderAccountDetailModal();
    });

    monthBtn?.addEventListener('click', () => {
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const lastDay = new Date(yyyy, now.getMonth() + 1, 0).getDate();
      this.accountDetailFilters.startDate = `${yyyy}-${mm}-01`;
      this.accountDetailFilters.endDate = `${yyyy}-${mm}-${String(lastDay).padStart(2, '0')}`;
      this.accountDetailFilters.period = 'custom';
      if (startInput) startInput.value = this.accountDetailFilters.startDate;
      if (endInput) endInput.value = this.accountDetailFilters.endDate;
      this.renderAccountDetailModal();
    });

    syncBtn?.addEventListener('click', () => {
      this.state.settings.startDate = this.accountDetailFilters.startDate || '';
      this.state.settings.endDate = this.accountDetailFilters.endDate || '';
      this.state.settings.periodFilter =
        this.state.settings.startDate || this.state.settings.endDate ? 'custom' : 'all';
      this.repo.saveState(this.state);
      this.renderAll();
      const rangeLabel =
        this.state.settings.startDate || this.state.settings.endDate
          ? `${this.state.settings.startDate || '...'} → ${this.state.settings.endDate || '...'}`
          : 'Todo el historial';
      this.showToast(`📅 Rango sincronizado con el Dashboard (${rangeLabel}).`);
    });

    searchInput?.addEventListener('input', () => {
      this.accountDetailFilters.searchQuery = searchInput.value || '';
      this.renderAccountDetailModal();
    });

    uploadStmtBtn?.addEventListener('click', () => {
      this.preferredStatementAccountId = this.activeDetailAccountId;
      document.getElementById('statement-file-input')?.click();
    });

    addTxBtn?.addEventListener('click', () => {
      const targetAccId = this.activeDetailAccountId;
      dialogEl.close();
      this.keypadModal.open(this.state, {
        type: TRANSACTION_TYPES.EXPENSE,
        accountId: targetAccId || this.state.accounts[0]?.id,
      });
    });

    viewInLedgerBtn?.addEventListener('click', () => {
      const targetAccId = this.activeDetailAccountId;
      if (targetAccId) {
        this.ledgerFilters.accountFilter = targetAccId;
      }
      if (this.accountDetailFilters.startDate || this.accountDetailFilters.endDate) {
        this.state.settings.startDate = this.accountDetailFilters.startDate;
        this.state.settings.endDate = this.accountDetailFilters.endDate;
        this.state.settings.periodFilter = 'custom';
      } else {
        this.state.settings.periodFilter = 'all';
        this.state.settings.startDate = '';
        this.state.settings.endDate = '';
      }
      this.repo.saveState(this.state);
      dialogEl.close();
      this.renderAll();
      this.switchTab('transactions');
    });
  }

  /**
   * Opens the Account Detail Modal (#account-detail-dialog) for a given account ID.
   * @param {string} accountId
   */
  openAccountDetailModal(accountId) {
    const dialogEl = document.getElementById('account-detail-dialog');
    if (!dialogEl) return;

    const acc = this.state.accounts.find((a) => a.id === accountId);
    if (!acc) return;

    this.activeDetailAccountId = accountId;
    // Inherit custom date range from dashboard if active; otherwise default to 'all' so all account movements are visible
    this.accountDetailFilters = {
      startDate: this.state.settings.startDate || '',
      endDate: this.state.settings.endDate || '',
      period: this.state.settings.startDate || this.state.settings.endDate ? 'custom' : 'all',
      searchQuery: '',
    };

    const startInput = document.getElementById('acc-detail-start-date');
    const endInput = document.getElementById('acc-detail-end-date');
    const searchInput = document.getElementById('acc-detail-search-input');

    if (startInput) startInput.value = this.accountDetailFilters.startDate;
    if (endInput) endInput.value = this.accountDetailFilters.endDate;
    if (searchInput) searchInput.value = '';

    this.renderAccountDetailModal();
    if (!dialogEl.open) {
      dialogEl.showModal();
    }
  }

  /**
   * Renders the contents of the Account Detail Modal (#account-detail-dialog).
   */
  renderAccountDetailModal() {
    if (!this.activeDetailAccountId) return;

    const detail = computeAccountDetailSummary(
      this.state,
      this.activeDetailAccountId,
      this.accountDetailFilters
    );
    if (!detail) return;

    const { account } = detail;
    const typeLabels = {
      bank: 'Cuenta Bancaria',
      cash: 'Efectivo',
      card: 'Tarjeta de Crédito',
      savings: 'Meta de Ahorro',
      debt: 'Deuda / Préstamo',
    };

    const titleEl = document.getElementById('account-detail-title');
    const subtitleEl = document.getElementById('account-detail-subtitle');
    const kpisEl = document.getElementById('account-detail-kpis');
    const tbody = document.getElementById('account-detail-tx-tbody');

    if (titleEl) {
      titleEl.textContent = account.name;
    }
    if (subtitleEl) {
      const inst = account.institution ? `${account.institution} · ` : '';
      const num = account.accountNumber
        ? `N.º *${extractLast4Digits(account.accountNumber) || account.accountNumber} · `
        : '';
      subtitleEl.textContent = `${inst}${num}${typeLabels[account.type] || account.type} · Moneda: ${account.currency}`;
    }

    const isNegative = detail.currentBalance < 0;
    const isNetPositive = detail.periodNet >= 0;
    const hasDateFilter = Boolean(
      this.accountDetailFilters.startDate || this.accountDetailFilters.endDate
    );
    const rangeTag = hasDateFilter
      ? `${this.accountDetailFilters.startDate || 'Inicio'} → ${this.accountDetailFilters.endDate || 'Hoy'}`
      : 'Todo el historial';

    if (kpisEl) {
      kpisEl.innerHTML = `
        <div class="statement-kpi-pill">
          <span>Saldo Actual Cuenta</span>
          <strong class="${isNegative ? 'text-danger' : 'text-income'}">
            ${Money.format(detail.currentBalance, account.currency)}
          </strong>
        </div>
        <div class="statement-kpi-pill">
          <span>Ingresos (${rangeTag})</span>
          <strong class="text-income">+ ${Money.format(detail.periodIncome, account.currency)}</strong>
        </div>
        <div class="statement-kpi-pill">
          <span>Gastos (${rangeTag})</span>
          <strong class="text-expense">- ${Money.format(detail.periodExpense, account.currency)}</strong>
        </div>
        <div class="statement-kpi-pill">
          <span>Flujo Neto (${rangeTag})</span>
          <strong class="${isNetPositive ? 'text-income' : 'text-danger'}">
            ${isNetPositive ? '+' : ''}${Money.format(detail.periodNet, account.currency)}
          </strong>
        </div>
        <div class="statement-kpi-pill">
          <span>Transacciones Asociadas</span>
          <strong>${detail.filteredCount} de ${detail.totalTxCount} mov.</strong>
        </div>
      `;
    }

    if (!tbody) return;

    if (detail.transactions.length === 0) {
      const emptyReason =
        detail.totalTxCount > 0
          ? `Esta cuenta tiene ${detail.totalTxCount} movimiento(s) en total, pero ninguno coincide con el rango de fechas o búsqueda actual.`
          : `Aún no hay transacciones registradas en "${account.name}". Puedes subir un Estado de Cuenta PDF o registrar un gasto.`;
      tbody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align: center; padding: 2rem; color: var(--text-secondary);">
            ${emptyReason}
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = detail.transactions
      .map((tx) => {
        const sign = tx.isPositiveForAccount ? '+' : '-';
        const amountClass = tx.isPositiveForAccount ? 'text-income' : 'text-expense';
        const typeBadge = tx.isTransfer
          ? tx.isIncomingTransfer
            ? `⇄ Recibido de ${tx.account.name}`
            : `⇄ Enviado a ${tx.toAccount?.name || 'Destino'}`
          : tx.type === TRANSACTION_TYPES.INCOME
            ? 'Ingreso'
            : 'Gasto / Cargo';

        const conceptText = tx.note
          ? tx.note
          : tx.isTransfer
            ? 'Transferencia entre cuentas'
            : tx.category.name;

        const convertedHint =
          tx.currency !== account.currency
            ? `<small style="display:block; color: var(--text-secondary);">≈ ${Money.format(tx.amountInAccountCurrency, account.currency)}</small>`
            : '';

        return `
          <tr
            class="tx-table-row-clickable"
            role="button"
            tabindex="0"
            data-action="edit-transaction"
            data-tx-id="${tx.id}"
            title="Haz clic para ver el detalle y modificar esta transacción"
            aria-label="Ver detalle y modificar ${conceptText} por ${Money.format(tx.amount, tx.currency)}"
          >
            <td style="white-space: nowrap; font-variant-numeric: tabular-nums;">${tx.date}</td>
            <td>
              <span class="voucher-pill" style="border-color: ${tx.category.color}55;">
                <span style="color: ${tx.category.color}; display:inline-flex; vertical-align:middle;">
                  ${renderIcon(tx.category.icon, 13)}
                </span>
                ${tx.isTransfer ? 'Transferencia' : tx.category.name}
              </span>
            </td>
            <td class="stmt-concept-cell">
              <div class="tx-title-row">
                <strong>${conceptText}</strong>
                <span class="tx-author-badge">Por: ${String(tx.createdByEmail || 'personal@pisto.hn').split('@')[0]}</span>
              </div>
              <small>${typeBadge}</small>
            </td>
            <td class="num-col">
              <strong class="${amountClass}">${sign} ${Money.format(tx.amount, tx.currency)}</strong>
            </td>
            <td class="num-col">
              <strong class="${amountClass}">${sign} ${Money.format(tx.amountInAccountCurrency, account.currency)}</strong>
              ${convertedHint}
            </td>
            <td style="text-align: right; white-space: nowrap;">
              <div class="tx-row-actions">
                <button
                  type="button"
                  class="btn-icon-edit"
                  data-action="edit-transaction"
                  data-tx-id="${tx.id}"
                  aria-label="Editar transacción"
                  title="Ver detalle / Modificar"
                >
                  ${renderIcon('edit', 14)}
                </button>
                <button
                  type="button"
                  class="btn-icon-delete"
                  data-action="delete-transaction"
                  data-tx-id="${tx.id}"
                  aria-label="Eliminar transacción"
                  title="Eliminar transacción"
                >
                  ${renderIcon('trash', 14)}
                </button>
              </div>
            </td>
          </tr>
        `;
      })
      .join('');
  }

  setupCategoryModal() {
    const categoryDialog = document.getElementById('category-dialog');
    if (!categoryDialog) return;

    attachDialogLightDismissFallback(categoryDialog);

    const typeSelect = document.getElementById('cat-type-select');
    const budgetField = document.getElementById('cat-budget-field');
    const catColorInput = document.getElementById('cat-color-input');

    typeSelect?.addEventListener('change', () => {
      budgetField?.classList.toggle('is-hidden', typeSelect.value === TRANSACTION_TYPES.INCOME);
    });

    catColorInput?.addEventListener('input', () => {
      this.syncColorSwatches('cat-color-input', catColorInput.value);
    });

    categoryDialog.addEventListener('click', (e) => {
      const swatchBtn = e.target.closest('[data-color-target="cat-color-input"]');
      if (swatchBtn) {
        this.syncColorSwatches('cat-color-input', swatchBtn.dataset.colorValue);
      }
    });

    const form = document.getElementById('category-modal-form');
    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!form.checkValidity()) return;

      const formData = new FormData(form);
      const existingId = String(formData.get('id') || '').trim();
      const catEntity = createCategory({
        id: existingId || undefined,
        name: formData.get('name'),
        type: formData.get('type'),
        icon: formData.get('icon') || 'cart',
        color: formData.get('color') || '#10b981',
        defaultBudget: Number.parseFloat(formData.get('defaultBudget') || '0'),
      });

      if (existingId) {
        const idx = this.state.categories.findIndex((c) => c.id === existingId);
        if (idx !== -1) {
          this.state.categories[idx] = catEntity;
        }
        if (catEntity.type === TRANSACTION_TYPES.EXPENSE) {
          this.state.budgets[catEntity.id] = catEntity.defaultBudget;
        } else {
          delete this.state.budgets[catEntity.id];
        }
        this.showToast(`Categoría "${catEntity.name}" actualizada.`);
      } else {
        this.state.categories.push(catEntity);
        if (catEntity.type === TRANSACTION_TYPES.EXPENSE && catEntity.defaultBudget > 0) {
          this.state.budgets[catEntity.id] = catEntity.defaultBudget;
        }
        this.showToast(`Categoría "${catEntity.name}" creada.`);
      }

      this.repo.saveState(this.state);
      categoryDialog.close();
      form.reset();
      this.renderAll();
    });
  }

  openCategoryModal(categoryId = null, defaultType = TRANSACTION_TYPES.EXPENSE) {
    const categoryDialog = document.getElementById('category-dialog');
    const form = document.getElementById('category-modal-form');
    const titleEl = document.getElementById('category-dialog-title');
    const budgetField = document.getElementById('cat-budget-field');
    if (!categoryDialog || !form) return;

    form.reset();
    const existing = categoryId ? this.state.categories.find((c) => c.id === categoryId) : null;
    const resolvedType = existing ? existing.type : defaultType;
    const resolvedColor = existing?.color || '#10b981';

    document.getElementById('cat-id-input').value = existing ? existing.id : '';
    document.getElementById('cat-name-input').value = existing ? existing.name : '';
    document.getElementById('cat-type-select').value = resolvedType;
    document.getElementById('cat-icon-select').value = existing?.icon || 'cart';
    this.syncColorSwatches('cat-color-input', resolvedColor);
    document.getElementById('cat-budget-input').value = existing
      ? (this.state.budgets?.[existing.id] ?? existing.defaultBudget ?? 0)
      : 150;

    budgetField?.classList.toggle('is-hidden', resolvedType === TRANSACTION_TYPES.INCOME);
    if (titleEl) {
      titleEl.textContent = existing ? 'Modificar Categoría' : 'Nueva Categoría';
    }

    categoryDialog.showModal();
  }

  deleteCategory(categoryId) {
    const target = this.state.categories.find((c) => c.id === categoryId);
    if (!target) return;

    const sameTypeCats = this.state.categories.filter((c) => c.type === target.type);
    if (sameTypeCats.length <= 1) {
      this.showToast(`Debe conservar al menos una categoría de ${target.type === 'income' ? 'ingresos' : 'gastos'}.`);
      return;
    }

    this.state.categories = this.state.categories.filter((c) => c.id !== categoryId);
    delete this.state.budgets[categoryId];

    const fallbackCat = this.state.categories.find((c) => c.type === target.type);
    if (fallbackCat) {
      this.state.transactions = this.state.transactions.map((tx) =>
        tx.categoryId === categoryId ? { ...tx, categoryId: fallbackCat.id } : tx
      );
    }

    this.repo.saveState(this.state);
    this.showToast(`Categoría "${target.name}" eliminada.`);
    this.renderAll();
  }

  /**
   * Configures the Open-Source ML Voucher & PDF Invoice Scanner Modal (#voucher-scanner-dialog).
   */
  setupVoucherScannerModal() {
    const scannerDialog = document.getElementById('voucher-scanner-dialog');
    const fileInput = document.getElementById('voucher-file-input');
    const confirmForm = document.getElementById('voucher-confirm-form');
    const last4Input = document.getElementById('voucher-card-last4-input');
    const accountSelect = document.getElementById('voucher-account-select');

    if (scannerDialog) {
      attachDialogLightDismissFallback(scannerDialog);
    }

    fileInput?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) {
        this.handleVoucherFileSelected(file);
      }
      fileInput.value = '';
    });

    // Live re-matching when user edits the last 4 digits field
    last4Input?.addEventListener('input', () => {
      const digits = extractLast4Digits(last4Input.value);
      if (digits.length === 4 && accountSelect) {
        const match = matchAccountForVoucher(
          this.state.accounts,
          digits,
          this.lastScannedVoucher?.detectedBank
        );
        if (match.accountId) {
          accountSelect.value = match.accountId;
        }
      }
    });

    confirmForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!confirmForm.checkValidity()) return;

      const formData = new FormData(confirmForm);
      const merchant = String(formData.get('merchant') || 'Comercio').trim();
      const amount = Number.parseFloat(formData.get('amount') || '0');
      const currency = String(formData.get('currency') || 'HNL');
      const date = String(formData.get('date') || new Date().toISOString().slice(0, 10));
      const categoryId = String(formData.get('categoryId') || 'groceries');
      const accountId = String(formData.get('accountId') || this.state.accounts[0]?.id);
      const cardLast4 = extractLast4Digits(formData.get('cardLast4') || '');
      const saveDigits = formData.get('saveDigitsToAccount') === 'on';

      // Optionally associate the cardLast4 digits with the chosen account if requested
      if (saveDigits && cardLast4) {
        const targetAcc = this.state.accounts.find((a) => a.id === accountId);
        if (targetAcc && !targetAcc.accountNumber) {
          targetAcc.accountNumber = cardLast4;
        }
      }

      const noteParts = [merchant];
      if (cardLast4) noteParts.push(`Tarjeta *${cardLast4}`);

      const newTx = this.recordWorkspaceTransaction({
        type: TRANSACTION_TYPES.EXPENSE,
        amount,
        currency,
        categoryId,
        accountId,
        date,
        note: noteParts.join(' · '),
      });

      this.state.transactions.unshift(newTx);
      const currentMonthPrefix = new Date().toISOString().slice(0, 7);
      if (!date.startsWith(currentMonthPrefix) && this.state.settings.periodFilter === 'month') {
        this.state.settings.periodFilter = 'all';
        this.state.settings.startDate = '';
        this.state.settings.endDate = '';
      }
      this.state.aiTelemetry.localParsesSaved = (this.state.aiTelemetry.localParsesSaved || 0) + 1;
      this.repo.saveState(this.state);

      scannerDialog?.close();
      this.showToast(
        `📷 Voucher de "${merchant}" registrado (${Money.format(newTx.amount, newTx.currency)})`
      );
      this.renderAll();
    });
  }

  /**
   * Processes an uploaded/captured voucher image or PDF invoice with Open-Source ML OCR.
   * Automatically redirects to the Bank Statement importer if the uploaded document is a multi-row statement.
   * @param {File} file
   */
  async handleVoucherFileSelected(file) {
    const scannerDialog = document.getElementById('voucher-scanner-dialog');
    const progressBox = document.getElementById('voucher-progress-box');
    const progressStatus = document.getElementById('voucher-progress-status');
    const progressPct = document.getElementById('voucher-progress-pct');
    const progressBar = document.getElementById('voucher-progress-bar');
    const saveBtn = document.getElementById('btn-save-voucher-tx');

    this.populateVoucherSelectOptions();

    if (scannerDialog && !scannerDialog.open) {
      scannerDialog.showModal();
    }

    if (progressBox) progressBox.classList.remove('is-hidden');
    if (saveBtn) saveBtn.disabled = true;

    try {
      const decoded = await decodeVoucherFile(file, this.state, (status, pct) => {
        if (progressStatus) progressStatus.textContent = status;
        if (progressPct) progressPct.textContent = `${pct}%`;
        if (progressBar) progressBar.value = pct;
      });

      // Check if the uploaded file is actually a Bank / Credit Card Statement with multiple rows
      const stmtCheck = parseBankStatementText(decoded.rawText || '', this.state);
      const hasStatementHeader =
        /ESTADO\s+DE\s+CUENTA|FECHA\s+DE\s+CORTE|PAGO\s+DE\s+CONTADO|DETALLE\s+DE\s+TRANSACCIONES|SALDO\s+ANTERIOR/i.test(
          decoded.rawText || ''
        );

      if (stmtCheck.items.length >= 2 || (file.type === 'application/pdf' && hasStatementHeader)) {
        scannerDialog?.close();
        this.showToast(
          '📄 Estado de Cuenta detectado. Abriendo conciliador detallado de transacciones...'
        );
        await this.handleStatementFileSelected(file);
        return;
      }

      this.lastScannedVoucher = decoded;

      const previewImg = document.getElementById('voucher-preview-img');
      if (previewImg && decoded.originalDataUrl) {
        previewImg.src = decoded.originalDataUrl;
      }

      document.getElementById('voucher-merchant-input').value = decoded.merchant || '';
      document.getElementById('voucher-amount-input').value = decoded.amount > 0 ? decoded.amount : '';
      document.getElementById('voucher-currency-select').value = decoded.currency || 'HNL';
      document.getElementById('voucher-date-input').value = decoded.date;
      document.getElementById('voucher-card-last4-input').value = decoded.cardLast4 || '';
      document.getElementById('voucher-category-select').value = decoded.categoryId;
      document.getElementById('voucher-account-select').value = decoded.accountId;

      // Render match badges
      const badgesEl = document.getElementById('voucher-match-badges');
      if (badgesEl) {
        const matchBadgeText =
          decoded.accountMatchType === 'account_number'
            ? `✅ Asociada por N.º *${decoded.cardLast4} → ${decoded.matchedAccountName}`
            : decoded.accountMatchType === 'institution'
              ? `🏦 Asociada por Entidad (${decoded.detectedBank}) → ${decoded.matchedAccountName}`
              : decoded.cardLast4
                ? `💳 Tarjeta detectada: *${decoded.cardLast4} (seleccione cuenta para vincular)`
                : `ℹ️ Sin dígitos de tarjeta visibles en voucher`;

        badgesEl.innerHTML = `
          <div class="voucher-pill">${matchBadgeText}</div>
          ${decoded.detectedBank ? `<div class="voucher-pill">Entidad POS: <strong>${decoded.detectedBank}</strong></div>` : ''}
        `;
      }

      // Render tax breakdown if present on voucher
      const taxSummaryEl = document.getElementById('voucher-tax-summary');
      if (taxSummaryEl) {
        const { subtotal, isv, devolIsv } = decoded.breakdown || {};
        if (subtotal > 0 || isv > 0) {
          taxSummaryEl.classList.remove('is-hidden');
          taxSummaryEl.innerHTML = `
            <strong>Desglose detectado en voucher:</strong>
            Subtotal: ${Money.format(subtotal, decoded.currency)} ·
            ISV: ${Money.format(isv, decoded.currency)}
            ${devolIsv > 0 ? ` · Devolución ISV: -${Money.format(devolIsv, decoded.currency)}` : ''} ·
            <strong>Total: ${Money.format(decoded.amount, decoded.currency)}</strong>
          `;
        } else {
          taxSummaryEl.classList.add('is-hidden');
        }
      }
    } catch (error) {
      this.showToast(`Aviso al escanear voucher: ${error.message}`);
    } finally {
      if (progressBox) progressBox.classList.add('is-hidden');
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  populateVoucherSelectOptions() {
    const catSelect = document.getElementById('voucher-category-select');
    const accSelect = document.getElementById('voucher-account-select');

    if (catSelect) {
      const expenseCats = this.state.categories.filter((c) => c.type === TRANSACTION_TYPES.EXPENSE);
      catSelect.innerHTML = expenseCats
        .map((c) => `<option value="${c.id}">${c.name}</option>`)
        .join('');
    }

    if (accSelect) {
      const activeAccounts = filterActiveAccounts(this.state.accounts);
      accSelect.innerHTML = activeAccounts
        .map((a) => {
          const numBadge = a.accountNumber ? ` (N.º *${extractLast4Digits(a.accountNumber) || a.accountNumber})` : '';
          const instBadge = a.institution ? ` · ${a.institution}` : '';
          return `<option value="${a.id}">${a.name}${numBadge}${instBadge} [${a.currency}]</option>`;
        })
        .join('');
    }
  }

  /**
   * Configures the Bank Statement PDF Importer & Anti-Duplicate Reconciliation Modal (#statement-import-dialog).
   */
  setupStatementImportModal() {
    const dialogEl = document.getElementById('statement-import-dialog');
    const fileInput = document.getElementById('statement-file-input');
    const formEl = document.getElementById('statement-import-form');
    const accountSelect = document.getElementById('statement-account-select');
    const yearSelect = document.getElementById('statement-year-select');
    const selectNewBtn = document.getElementById('btn-stmt-select-new');
    const selectAllBtn = document.getElementById('btn-stmt-select-all');
    const tbody = document.getElementById('statement-items-tbody');

    if (dialogEl) {
      attachDialogLightDismissFallback(dialogEl);
    }

    fileInput?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) {
        this.handleStatementFileSelected(file);
      }
      fileInput.value = '';
    });

    accountSelect?.addEventListener('change', () => {
      this.reconcileStatementDuplicates();
      this.renderStatementPreviewTable();
    });

    yearSelect?.addEventListener('change', () => {
      if (!this.currentStatementData?.rawText) return;
      const fallbackYear = Number.parseInt(yearSelect.value, 10) || new Date().getFullYear();
      const targetAccountId = accountSelect?.value || this.state.accounts[0]?.id;
      const reparsed = parseBankStatementText(this.currentStatementData.rawText, this.state, {
        targetAccountId,
        fallbackYear,
      });
      this.currentStatementData = {
        ...this.currentStatementData,
        ...reparsed,
      };
      this.renderStatementPreviewTable();
    });

    selectNewBtn?.addEventListener('click', () => {
      if (!this.currentStatementData?.items) return;
      this.currentStatementData.items.forEach((item) => {
        item.selected = !item.isDuplicate;
      });
      this.renderStatementPreviewTable();
    });

    selectAllBtn?.addEventListener('click', () => {
      if (!this.currentStatementData?.items) return;
      this.currentStatementData.items.forEach((item) => {
        item.selected = true;
      });
      this.renderStatementPreviewTable();
    });

    tbody?.addEventListener('change', (e) => {
      if (!this.currentStatementData?.items) return;
      const checkEl = e.target.closest('[data-stmt-check-id]');
      if (checkEl) {
        const rowId = checkEl.dataset.stmtCheckId;
        const targetItem = this.currentStatementData.items.find((it) => it.id === rowId);
        if (targetItem) {
          targetItem.selected = Boolean(checkEl.checked);
          this.renderStatementSummaryStrip();
        }
        return;
      }

      const catEl = e.target.closest('[data-stmt-cat-id]');
      if (catEl) {
        const rowId = catEl.dataset.stmtCatId;
        const targetItem = this.currentStatementData.items.find((it) => it.id === rowId);
        if (targetItem) {
          targetItem.categoryId = catEl.value;
        }
      }
    });

    formEl?.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!this.currentStatementData?.items?.length) {
        dialogEl?.close();
        return;
      }

      const selectedItems = this.currentStatementData.items.filter((it) => it.selected);
      if (selectedItems.length === 0) {
        this.showToast('⚠️ Selecciona al menos un movimiento para importar.');
        return;
      }

      const targetAccountId = accountSelect?.value || this.state.accounts[0]?.id;
      const skippedDuplicates = this.currentStatementData.items.filter(
        (it) => it.isDuplicate && !it.selected
      ).length;

      // If the user previously scanned the statement as a single lump-sum voucher (e.g. L 29,592.80),
      // remove that single summary transaction so the detailed rows replace it cleanly without doubling the balance.
      const allStmtTotalHnl = this.currentStatementData.items
        .filter((it) => it.currency === 'HNL')
        .reduce((sum, it) => Money.add(sum, it.amount), 0);
      if (this.currentStatementData.items.length >= 2 && allStmtTotalHnl > 0) {
        this.state.transactions = this.state.transactions.filter((tx) => {
          if (tx.accountId !== targetAccountId) return true;
          const isLumpSumMatch = Math.abs(Number(tx.amount) - allStmtTotalHnl) <= 0.05;
          const isIndividualRow = this.currentStatementData.items.some(
            (it) => Math.abs(Number(it.amount) - Number(tx.amount)) <= 0.05
          );
          return !(isLumpSumMatch && !isIndividualRow);
        });
      }

      for (const item of [...selectedItems].reverse()) {
        const noteText = item.reference
          ? `${item.concept} · Ref ${item.reference}`
          : item.concept;

        const newTx = this.recordWorkspaceTransaction({
          type: TRANSACTION_TYPES.EXPENSE,
          amount: item.amount,
          currency: item.currency,
          categoryId: item.categoryId,
          accountId: targetAccountId,
          date: item.date,
          note: noteText,
        });
        this.state.transactions.unshift(newTx);
      }

      // Reset period/date filters so all imported statement transactions (including prior months like SEP) are visible
      this.state.settings.periodFilter = 'all';
      this.state.settings.startDate = '';
      this.state.settings.endDate = '';
      this.ledgerFilters.searchQuery = '';
      this.ledgerFilters.typeFilter = 'all';
      this.ledgerFilters.accountFilter = 'all';

      this.state.aiTelemetry.localParsesSaved =
        (this.state.aiTelemetry.localParsesSaved || 0) + selectedItems.length;
      this.repo.saveState(this.state);

      dialogEl?.close();
      const dupMsg =
        skippedDuplicates > 0 ? ` (${skippedDuplicates} duplicado(s) evitado(s))` : '';
      this.showToast(
        `📄 ${selectedItems.length} movimiento(s) importado(s) del Estado de Cuenta${dupMsg}.`
      );
      this.renderAll();

      const accountDetailDialog = document.getElementById('account-detail-dialog');
      if (accountDetailDialog?.open && this.activeDetailAccountId === targetAccountId) {
        this.accountDetailFilters.startDate = '';
        this.accountDetailFilters.endDate = '';
        this.accountDetailFilters.period = 'all';
        this.renderAccountDetailModal();
      } else {
        this.switchTab('transactions');
      }
    });
  }

  populateStatementAccountSelect(preferredAccountId = null) {
    const accountSelect = document.getElementById('statement-account-select');
    if (!accountSelect) return;

    const activeAccounts = filterActiveAccounts(this.state.accounts);
    accountSelect.innerHTML = activeAccounts
      .map((a) => {
        const numBadge = a.accountNumber
          ? ` (N.º *${extractLast4Digits(a.accountNumber) || a.accountNumber})`
          : '';
        const instBadge = a.institution ? ` · ${a.institution}` : '';
        return `<option value="${a.id}">${a.name}${numBadge}${instBadge} [${a.currency}]</option>`;
      })
      .join('');

    if (preferredAccountId && activeAccounts.some((a) => a.id === preferredAccountId)) {
      accountSelect.value = preferredAccountId;
    }
  }

  /**
   * Re-runs anti-duplicate detection across the currently loaded statement items
   * when the user changes the target Account in the modal.
   */
  reconcileStatementDuplicates() {
    if (!this.currentStatementData?.items) return;
    const accountSelect = document.getElementById('statement-account-select');
    const targetAccountId = accountSelect?.value || this.currentStatementData.targetAccountId;
    this.currentStatementData.targetAccountId = targetAccountId;

    for (const item of this.currentStatementData.items) {
      const dupCheck = findDuplicateTransaction(item, this.state.transactions, targetAccountId);
      item.isDuplicate = dupCheck.isDuplicate;
      item.duplicateType = dupCheck.matchType;
      item.duplicateTx = dupCheck.duplicateTx;
      item.selected = !dupCheck.isDuplicate;
    }
  }

  /**
   * Processes an uploaded Bank / Credit Card Statement PDF (or image) and opens the reconciliation modal.
   * @param {File} file
   */
  async handleStatementFileSelected(file) {
    const dialogEl = document.getElementById('statement-import-dialog');
    const progressBox = document.getElementById('statement-progress-box');
    const progressStatus = document.getElementById('statement-progress-status');
    const progressPct = document.getElementById('statement-progress-pct');
    const progressBar = document.getElementById('statement-progress-bar');
    const confirmBtn = document.getElementById('btn-confirm-statement-import');
    const yearSelect = document.getElementById('statement-year-select');

    const explicitAccountId = this.preferredStatementAccountId;
    this.preferredStatementAccountId = null;

    this.populateStatementAccountSelect(explicitAccountId);

    if (dialogEl && !dialogEl.open) {
      dialogEl.showModal();
    }

    if (progressBox) progressBox.classList.remove('is-hidden');
    if (confirmBtn) confirmBtn.disabled = true;

    try {
      const fallbackYear = Number.parseInt(yearSelect?.value || '2026', 10) || new Date().getFullYear();
      const decoded = await decodeBankStatementPdf(
        file,
        this.state,
        {
          fallbackYear,
          targetAccountId: explicitAccountId || undefined,
        },
        (status, pct) => {
          if (progressStatus) progressStatus.textContent = status;
          if (progressPct) progressPct.textContent = `${pct}%`;
          if (progressBar) progressBar.value = pct;
        }
      );

      this.currentStatementData = decoded;
      this.populateStatementAccountSelect(explicitAccountId || decoded.targetAccountId);
      this.reconcileStatementDuplicates();

      const subtitleEl = document.getElementById('statement-institution-subtitle');
      if (subtitleEl) {
        const bankLabel = decoded.detectedBank
          ? `Entidad detectada: ${decoded.detectedBank}`
          : 'Estado de Cuenta Bancario / Tarjeta';
        const cardLabel = decoded.cardLast4 ? ` · Tarjeta *${decoded.cardLast4}` : '';
        subtitleEl.textContent = `${bankLabel}${cardLabel} — Conciliación automática contra vouchers registrados.`;
      }

      this.renderStatementPreviewTable();
    } catch (error) {
      this.showToast(`Aviso al procesar Estado de Cuenta: ${error.message}`);
    } finally {
      if (progressBox) progressBox.classList.add('is-hidden');
      if (confirmBtn) confirmBtn.disabled = false;
    }
  }

  renderStatementSummaryStrip() {
    const summaryEl = document.getElementById('statement-summary-strip');
    const confirmBtn = document.getElementById('btn-confirm-statement-import');
    const items = this.currentStatementData?.items || [];

    const totalCount = items.length;
    const duplicateCount = items.filter((it) => it.isDuplicate).length;
    const selectedItems = items.filter((it) => it.selected);
    const totalHnl = selectedItems
      .filter((it) => it.currency === 'HNL')
      .reduce((acc, it) => Money.add(acc, it.amount), 0);
    const totalUsd = selectedItems
      .filter((it) => it.currency === 'USD')
      .reduce((acc, it) => Money.add(acc, it.amount), 0);

    if (summaryEl) {
      summaryEl.innerHTML = `
        <div class="statement-kpi-pill">
          <span>Movimientos en PDF</span>
          <strong>${totalCount} fila(s)</strong>
        </div>
        <div class="statement-kpi-pill is-new-ok">
          <span>Seleccionados a Importar</span>
          <strong class="text-income">${selectedItems.length} nuevo(s)</strong>
        </div>
        <div class="statement-kpi-pill ${duplicateCount > 0 ? 'is-dup-alert' : ''}">
          <span>Duplicados (Voucher Previo)</span>
          <strong style="color: ${duplicateCount > 0 ? '#f59e0b' : 'var(--text-primary)'};">
            ${duplicateCount > 0 ? `⚠️ ${duplicateCount} detectado(s)` : '0 duplicados'}
          </strong>
        </div>
        <div class="statement-kpi-pill">
          <span>Total Seleccionado HNL</span>
          <strong>${Money.format(totalHnl, 'HNL')}</strong>
        </div>
        <div class="statement-kpi-pill">
          <span>Total Seleccionado USD</span>
          <strong>${Money.format(totalUsd, 'USD')}</strong>
        </div>
      `;
    }

    if (confirmBtn) {
      confirmBtn.textContent = `Importar Movimientos Seleccionados (${selectedItems.length})`;
      confirmBtn.disabled = selectedItems.length === 0;
    }
  }

  renderStatementPreviewTable() {
    const tbody = document.getElementById('statement-items-tbody');
    if (!tbody) return;

    this.renderStatementSummaryStrip();

    const items = this.currentStatementData?.items || [];
    if (items.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align: center; padding: 1.75rem; color: var(--text-secondary);">
            No se encontraron filas con formato de Estado de Cuenta (Fecha, Concepto, Monto por Moneda).
          </td>
        </tr>
      `;
      return;
    }

    const expenseCats = this.state.categories.filter((c) => c.type === TRANSACTION_TYPES.EXPENSE);

    tbody.innerHTML = items
      .map((item) => {
        const dupBadge = item.isDuplicate
          ? `<span class="stmt-badge-dup" title="Ya existe un voucher/movimiento en esta cuenta con el mismo monto y fecha">
               ⚠️ Posible Duplicado
             </span>
             <span class="stmt-dup-detail">
               Ya registrado: "${item.duplicateTx?.note || 'Voucher'}" (${item.duplicateTx?.date})
             </span>`
          : `<span class="stmt-badge-new">✨ Nuevo</span>`;

        const catOptions = expenseCats
          .map(
            (c) =>
              `<option value="${c.id}" ${c.id === item.categoryId ? 'selected' : ''}>${c.name}</option>`
          )
          .join('');

        const hnlCell =
          item.currency === 'HNL' ? Money.format(item.amount, 'HNL') : '<span style="color:var(--text-secondary);">—</span>';
        const usdCell =
          item.currency === 'USD' ? Money.format(item.amount, 'USD') : '<span style="color:var(--text-secondary);">—</span>';

        return `
          <tr class="${item.isDuplicate ? 'stmt-row-duplicate' : ''}">
            <td>
              <input
                type="checkbox"
                data-stmt-check-id="${item.id}"
                ${item.selected ? 'checked' : ''}
                aria-label="Importar ${item.concept}"
              />
            </td>
            <td>${dupBadge}</td>
            <td style="white-space: nowrap; font-variant-numeric: tabular-nums;">${item.date}</td>
            <td class="stmt-concept-cell">
              <strong>${item.concept}</strong>
              ${item.reference ? `<small>Ref: ${item.reference}</small>` : ''}
            </td>
            <td>
              <select class="stmt-cat-select" data-stmt-cat-id="${item.id}" aria-label="Categoría para ${item.concept}">
                ${catOptions}
              </select>
            </td>
            <td class="num-col">${hnlCell}</td>
            <td class="num-col">${usdCell}</td>
          </tr>
        `;
      })
      .join('');
  }

  /**
   * Synchronizes aria-invalid with native :user-invalid state per modern-web-guidance.
   */
  setupValidationAriaSync() {
    const syncAria = (el) => {
      if (!el || typeof el.matches !== 'function') return;
      try {
        el.setAttribute('aria-invalid', el.matches(':user-invalid') ? 'true' : 'false');
      } catch {
        // Fallback if selector not supported
      }
    };

    document.addEventListener('blur', (e) => syncAria(e.target), true);
    document.addEventListener('input', (e) => {
      if (e.target?.hasAttribute?.('aria-invalid')) syncAria(e.target);
    });
  }

  /**
   * Configures the non-invasive Privacy & LocalStorage Notice Banner (#privacy-consent-banner)
   * and footer privacy controls for inspecting or clearing sensitive API keys/configs.
   */
  setupPrivacyConsentBanner() {
    const bannerEl = document.getElementById('privacy-consent-banner');
    const acceptBtn = document.getElementById('btn-accept-privacy-banner');
    const clearBannerBtn = document.getElementById('btn-privacy-clear-sensitive');
    const openFooterBtn = document.getElementById('btn-open-privacy-banner');
    const clearFooterBtn = document.getElementById('btn-footer-clear-sensitive');

    const consent = this.authService.getPrivacyConsent();
    if (bannerEl && !consent.accepted) {
      bannerEl.classList.remove('is-hidden');
    }

    acceptBtn?.addEventListener('click', () => {
      this.authService.savePrivacyConsent(true);
      bannerEl?.classList.add('is-hidden');
      this.showToast('🛡️ Preferencia de almacenamiento Local-First confirmada.');
    });

    const handleClearSensitive = () => {
      this.authService.clearSensitiveLocalStorage();
      this.profileView.renderProfileTab();
      this.renderTelemetryBadge();
      bannerEl?.classList.add('is-hidden');
      this.showToast('🧹 Claves sensibles de Gemini IA y Firebase eliminadas de LocalStorage.');
    };

    clearBannerBtn?.addEventListener('click', handleClearSensitive);
    clearFooterBtn?.addEventListener('click', handleClearSensitive);

    openFooterBtn?.addEventListener('click', () => {
      if (bannerEl) {
        bannerEl.classList.remove('is-hidden');
        acceptBtn?.focus();
      }
    });
  }

  bindGlobalEvents() {
    // Mobile Filter Drawer Toggle (#btn-toggle-mobile-filters)
    const mobileFiltersBtn = document.getElementById('btn-toggle-mobile-filters');
    const filtersDrawer = document.getElementById('header-filters-drawer');
    mobileFiltersBtn?.addEventListener('click', () => {
      if (!filtersDrawer) return;
      const isOpen = filtersDrawer.classList.toggle('is-mobile-open');
      mobileFiltersBtn.setAttribute('aria-expanded', String(isOpen));
    });

    // Navigation Tabs with View Transitions API
    document.addEventListener('click', (e) => {
      const tabBtn = e.target.closest('[data-tab-target]');
      if (tabBtn) {
        this.switchTab(tabBtn.dataset.tabTarget);
        return;
      }

      const actionEl = e.target.closest('[data-action]');
      if (!actionEl) return;

      const action = actionEl.dataset.action;

      if (action === 'open-keypad') {
        this.keypadModal.open(this.state, {
          type: actionEl.dataset.txType || TRANSACTION_TYPES.EXPENSE,
        });
      } else if (action === 'open-category-keypad') {
        const catId = actionEl.dataset.categoryId;
        const cat = this.state.categories.find((c) => c.id === catId);
        this.keypadModal.open(this.state, {
          type: cat?.type || TRANSACTION_TYPES.EXPENSE,
          categoryId: catId,
        });
      } else if (action === 'open-category-modal') {
        this.openCategoryModal(null, actionEl.dataset.catType || TRANSACTION_TYPES.EXPENSE);
      } else if (action === 'edit-category') {
        this.openCategoryModal(actionEl.dataset.categoryId);
      } else if (action === 'delete-category') {
        this.deleteCategory(actionEl.dataset.categoryId);
      } else if (action === 'open-account-transfer') {
        const fromId = actionEl.dataset.accountId;
        this.keypadModal.open(this.state, {
          type: TRANSACTION_TYPES.TRANSFER,
          accountId: fromId,
        });
      } else if (action === 'open-account-modal') {
        this.openAccountModal(null);
      } else if (action === 'open-import-account-modal') {
        this.openImportAccountModal();
      } else if (action === 'open-account-detail') {
        this.openAccountDetailModal(actionEl.dataset.accountId);
      } else if (action === 'edit-account') {
        this.openAccountModal(actionEl.dataset.accountId);
      } else if (action === 'delete-account') {
        this.promptDeleteAccount(actionEl.dataset.accountId);
      } else if (action === 'unarchive-account') {
        this.unarchiveAccountById(actionEl.dataset.accountId);
      } else if (action === 'toggle-show-archived-accounts') {
        this.showArchivedAccounts = !this.showArchivedAccounts;
        const toggleCheckbox = document.getElementById('toggle-show-archived-accounts');
        if (toggleCheckbox) {
          toggleCheckbox.checked = this.showArchivedAccounts;
        }
        this.renderAll();
      } else if (action === 'toggle-account-include') {
        const accId = actionEl.dataset.accountId;
        const acc = this.state.accounts.find((a) => a.id === accId);
        if (acc) {
          acc.includeInTotal = !acc.includeInTotal;
          this.repo.saveState(this.state);
          this.renderAll();
        }
      } else if (action === 'edit-transaction') {
        this.openTransactionDetail(actionEl.dataset.txId);
      } else if (action === 'delete-transaction') {
        this.deleteTransaction(actionEl.dataset.txId);
      } else if (action === 'show-all-history') {
        this.state.settings.periodFilter = 'all';
        this.state.settings.startDate = '';
        this.state.settings.endDate = '';
        this.repo.saveState(this.state);
        this.renderAll();
      } else if (action === 'trigger-voucher-upload') {
        document.getElementById('voucher-file-input')?.click();
      } else if (action === 'trigger-statement-upload') {
        document.getElementById('statement-file-input')?.click();
      } else if (action === 'smart-parse-ai') {
        this.handleGenkitSmartParse();
      } else if (action === 'generate-ai-insights') {
        this.handleGenkitInsights();
      } else if (action === 'export-csv') {
        this.downloadCsv();
      } else if (action === 'export-json') {
        this.downloadJson();
      } else if (action === 'reset-demo') {
        this.state = this.repo.resetToDemo();
        this.lastInsightsResult = null;
        this.showToast('Datos de demostración restaurados.');
        this.renderAll();
      } else if (action === 'open-profile-or-auth') {
        this.handleHeaderAuthButtonClick();
      } else if (action === 'open-auth-modal') {
        this.profileView.openAuthModal(false);
      } else if (action === 'clear-currency-filter') {
        this.ledgerFilters.currencyFilter = 'all';
        this.state.settings.currencyFilter = 'all';
        this.repo.saveState(this.state);
        this.renderAll();
      }
    });

    // Direct binding on Header "Iniciar Sesión" button (#header-auth-btn)
    const headerAuthBtn = document.getElementById('header-auth-btn');
    headerAuthBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.handleHeaderAuthButtonClick();
    });

    // Keyboard accessibility (WCAG 2.1 AA) for Navigation Tabs (ArrowLeft/ArrowRight/Home/End)
    // and clickable cards, category rings, donut segments, and transaction rows (Enter / Space)
    document.addEventListener('keydown', (e) => {
      const tabEl = e.target.closest?.('[role="tab"][data-tab-target]');
      if (tabEl && ['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) {
        const tabs = Array.from(document.querySelectorAll('.nav-tabs [role="tab"][data-tab-target]'));
        const idx = tabs.indexOf(tabEl);
        if (idx !== -1 && tabs.length > 0) {
          e.preventDefault();
          let nextIdx = idx;
          if (e.key === 'ArrowRight') nextIdx = (idx + 1) % tabs.length;
          else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + tabs.length) % tabs.length;
          else if (e.key === 'Home') nextIdx = 0;
          else if (e.key === 'End') nextIdx = tabs.length - 1;
          const nextTab = tabs[nextIdx];
          nextTab?.focus();
          if (nextTab?.dataset?.tabTarget) {
            this.switchTab(nextTab.dataset.tabTarget);
          }
          return;
        }
      }

      if (e.key !== 'Enter' && e.key !== ' ') return;
      const cardEl = e.target.closest?.('.account-card-clickable[data-action="open-account-detail"]');
      if (cardEl && e.target === cardEl) {
        e.preventDefault();
        this.openAccountDetailModal(cardEl.dataset.accountId);
        return;
      }
      const catEl = e.target.closest?.('[data-action="open-category-keypad"]');
      if (catEl && e.target === catEl) {
        e.preventDefault();
        const catId = catEl.dataset.categoryId;
        const cat = this.state.categories.find((c) => c.id === catId);
        this.keypadModal.open(this.state, {
          type: cat?.type || TRANSACTION_TYPES.EXPENSE,
          categoryId: catId,
        });
        return;
      }
      const txEl = e.target.closest?.('[data-action="edit-transaction"]');
      if (txEl && e.target === txEl) {
        e.preventDefault();
        this.openTransactionDetail(txEl.dataset.txId);
      }
    });

    // Period Filter & Custom Date Range Switchers in Dashboard Header
    document.getElementById('period-filter-select')?.addEventListener('change', (e) => {
      const val = e.target.value;
      this.state.settings.periodFilter = val;
      if (val !== 'custom') {
        this.state.settings.startDate = '';
        this.state.settings.endDate = '';
      }
      this.repo.saveState(this.state);
      this.renderAll();
      if (val === 'custom') {
        document.getElementById('global-start-date')?.focus();
      }
    });

    const globalStartInput = document.getElementById('global-start-date');
    const globalEndInput = document.getElementById('global-end-date');
    const clearGlobalDatesBtn = document.getElementById('btn-clear-global-dates');

    const handleGlobalDateRangeChange = () => {
      if (this.state.settings.periodFilter !== 'custom') return;
      this.state.settings.startDate = globalStartInput?.value || '';
      this.state.settings.endDate = globalEndInput?.value || '';
      this.repo.saveState(this.state);
      this.renderAll();
    };

    globalStartInput?.addEventListener('change', handleGlobalDateRangeChange);
    globalEndInput?.addEventListener('change', handleGlobalDateRangeChange);

    clearGlobalDatesBtn?.addEventListener('click', () => {
      this.state.settings.startDate = '';
      this.state.settings.endDate = '';
      this.state.settings.periodFilter = 'all';
      this.repo.saveState(this.state);
      this.renderAll();
    });

    document.getElementById('base-currency-select')?.addEventListener('change', (e) => {
      this.state.settings.baseCurrency = e.target.value;
      this.repo.saveState(this.state);
      this.renderAll();
    });

    document.getElementById('theme-select')?.addEventListener('change', (e) => {
      this.state.settings.theme = e.target.value;
      this.repo.saveState(this.state);
      this.applyTheme(e.target.value);
    });

    // Toggle for showing archived accounts in the "Cuentas y Metas" tab
    const archivedToggle = document.getElementById('toggle-show-archived-accounts');
    archivedToggle?.addEventListener('change', (e) => {
      this.showArchivedAccounts = Boolean(e.target.checked);
      this.renderAll();
    });

    // Quick NLP Input Live Preview & 0-Token Submit
    const quickForm = document.getElementById('quick-nlp-form');
    const quickInput = document.getElementById('quick-nlp-input');

    quickInput?.addEventListener('input', () => {
      this.updateQuickNlpPreview(quickInput.value);
    });

    quickForm?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.handleLocalQuickEntry();
    });

    // Ledger Filters
    document.getElementById('ledger-search-input')?.addEventListener('input', (e) => {
      this.ledgerFilters.searchQuery = e.target.value;
      this.renderLedgerSection();
    });

    document.getElementById('ledger-account-select')?.addEventListener('change', (e) => {
      this.ledgerFilters.accountFilter = e.target.value;
      this.renderLedgerSection();
    });

    document.getElementById('ledger-type-select')?.addEventListener('change', (e) => {
      this.ledgerFilters.typeFilter = e.target.value;
      this.renderLedgerSection();
    });

    document.getElementById('ledger-currency-select')?.addEventListener('change', (e) => {
      this.ledgerFilters.currencyFilter = e.target.value;
      this.state.settings.currencyFilter = e.target.value;
      this.repo.saveState(this.state);
      this.renderAll();
    });

    // Budget Inline Changes
    document.addEventListener('change', (e) => {
      const budgetInput = e.target.closest('[data-budget-category]');
      if (budgetInput) {
        const catId = budgetInput.dataset.budgetCategory;
        const val = Math.max(0, Number.parseFloat(budgetInput.value || '0'));
        this.state.budgets[catId] = Number.isFinite(val) ? val : 0;
        this.repo.saveState(this.state);
        this.showToast('Presupuesto actualizado.');
        this.renderAll();
      }
    });
  }

  switchTab(tabName) {
    if (this.activeTab === tabName) return;

    const updateDom = () => {
      this.activeTab = tabName;
      document.querySelectorAll('[data-tab-target]').forEach((btn) => {
        const active = btn.dataset.tabTarget === tabName;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', String(active));
      });

      document.querySelectorAll('[data-tab-panel]').forEach((panel) => {
        const active = panel.dataset.tabPanel === tabName;
        panel.classList.toggle('is-hidden', !active);
      });
    };

    if (typeof document.startViewTransition === 'function') {
      document.startViewTransition(updateDom);
    } else {
      updateDom();
    }
  }

  applyTheme(theme) {
    const root = document.documentElement;
    if (theme === 'dark' || theme === 'light') {
      root.setAttribute('data-theme', theme);
    } else {
      root.removeAttribute('data-theme');
    }
  }

  renderAll() {
    const currentPeriod = this.state.settings.periodFilter || 'month';
    const isCustomPeriod = currentPeriod === 'custom';
    const activeCurrencyFilter = this.ledgerFilters.currencyFilter || this.state.settings.currencyFilter || 'all';
    const personalViewMode = Boolean(this.state.settings.personalViewMode);
    const currentUid = this.state.settings.currentUid || null;
    const workspaceId = this.state.settings.workspaceId || 'ws_default';

    const filterOpts = {
      period: currentPeriod,
      startDate: isCustomPeriod ? (this.state.settings.startDate || '') : '',
      endDate: isCustomPeriod ? (this.state.settings.endDate || '') : '',
      currencyFilter: activeCurrencyFilter,
      personalViewMode,
      currentUid,
      workspaceId,
    };
    const accountsSummary = computeAccountsSummary(this.state, filterOpts);
    const analytics = computePeriodAnalytics(this.state, filterOpts);
    const micro = buildMicroPayload(this.state, analytics, accountsSummary);

    this.currentAccountsSummary = accountsSummary;
    this.currentAnalytics = analytics;
    this.currentMicroPayload = micro;

    this.renderHeaderKpis(accountsSummary, analytics);
    this.renderProfileFilterBanner(activeCurrencyFilter, personalViewMode);
    this.renderCategoriesView(analytics);
    this.renderAccountsView(accountsSummary);
    this.renderLedgerSection();
    this.renderBudgetsAndAiView(analytics, micro);
    this.renderTelemetryBadge();

    const accountDetailDialog = document.getElementById('account-detail-dialog');
    if (accountDetailDialog?.open && this.activeDetailAccountId) {
      this.renderAccountDetailModal();
    }
  }

  renderProfileFilterBanner(activeCurrencyFilter, personalViewMode) {
    const bannerEl = document.getElementById('active-profile-filter-bar');
    if (!bannerEl) return;

    const currencySelectEl = document.getElementById('ledger-currency-select');
    if (currencySelectEl) {
      currencySelectEl.value = activeCurrencyFilter || 'all';
    }

    const hasCurrencyFilter = activeCurrencyFilter && activeCurrencyFilter !== 'all';
    if (!hasCurrencyFilter && !personalViewMode) {
      bannerEl.classList.add('is-hidden');
      bannerEl.innerHTML = '';
      return;
    }

    const badges = [];
    if (hasCurrencyFilter) {
      badges.push(`💱 Moneda filtrada: <strong>${activeCurrencyFilter}</strong>`);
    }
    if (personalViewMode) {
      const profileName = this.authService.getCurrentProfile()?.name || 'Mis movimientos';
      badges.push(`🔒 Modo Vista Personal activo (<strong>${profileName}</strong>)`);
    }

    bannerEl.classList.remove('is-hidden');
    bannerEl.innerHTML = `
      <span>${badges.join(' · ')}</span>
      <div style="display: flex; gap: 0.45rem; flex-wrap: wrap;">
        ${
          hasCurrencyFilter
            ? `<button type="button" class="btn-secondary btn-sm" data-action="clear-currency-filter" aria-label="Quitar filtro de moneda y ver todas las monedas">Ver Todas las Monedas</button>`
            : ''
        }
        <button type="button" class="btn-secondary btn-sm" data-tab-target="profile" aria-label="Ir a la pestaña de Perfil para ajustar preferencias">Ajustar en Perfil →</button>
      </div>
    `;
  }

  renderHeaderKpis(accountsSummary, analytics) {
    const cur = analytics?.baseCurrency || this.state?.settings?.baseCurrency || 'HNL';
    const safeIncome = Number(analytics?.totalIncome || 0);
    const safeExpenses = Number(analytics?.totalExpense ?? analytics?.totalExpenses ?? 0);
    const safeSavingsRate = calculateSafeSavingsRate(
      safeIncome,
      safeExpenses,
      safeIncome > 0 || safeExpenses > 0
    );
    const labels = formatDashboardKpiLabels(
      {
        totalIncludedBalance: accountsSummary?.totalIncludedBalance || 0,
        totalIncome: safeIncome,
        totalExpenses: safeExpenses,
        savingsRatePct: safeSavingsRate,
      },
      cur
    );

    const netWorthEl = document.getElementById('kpi-total-balance');
    const incomeEl = document.getElementById('kpi-period-income');
    const expenseEl = document.getElementById('kpi-period-expense');
    const savingsRateEl = document.getElementById('kpi-savings-rate');

    if (netWorthEl) netWorthEl.textContent = labels.patrimonioLabel;
    if (incomeEl) incomeEl.textContent = labels.ingresosLabel;
    if (expenseEl) expenseEl.textContent = labels.gastosLabel;
    if (savingsRateEl) savingsRateEl.textContent = labels.tasaAhorroLabel;

    const periodSelect = document.getElementById('period-filter-select');
    const globalDateRangeGroup = document.getElementById('global-date-range-group');
    const globalStartInput = document.getElementById('global-start-date');
    const globalEndInput = document.getElementById('global-end-date');
    const clearGlobalDatesBtn = document.getElementById('btn-clear-global-dates');
    const currencySelect = document.getElementById('base-currency-select');
    const themeSelect = document.getElementById('theme-select');

    const currentPeriod = this.state.settings.periodFilter || 'month';
    const isCustomPeriod = currentPeriod === 'custom';
    const startDate = isCustomPeriod ? (this.state.settings.startDate || '') : '';
    const endDate = isCustomPeriod ? (this.state.settings.endDate || '') : '';

    if (periodSelect) periodSelect.value = currentPeriod;
    if (globalDateRangeGroup) {
      globalDateRangeGroup.classList.toggle('is-hidden', !isCustomPeriod);
    }
    if (globalStartInput) {
      globalStartInput.disabled = !isCustomPeriod;
      globalStartInput.value = startDate;
    }
    if (globalEndInput) {
      globalEndInput.disabled = !isCustomPeriod;
      globalEndInput.value = endDate;
    }
    if (clearGlobalDatesBtn) {
      clearGlobalDatesBtn.classList.toggle('is-hidden', !(isCustomPeriod && (startDate || endDate)));
    }
    if (currencySelect) currencySelect.value = cur;
    if (themeSelect) themeSelect.value = this.state.settings.theme || 'system';
  }

  /**
   * Renders Tab 1: Pisto Signature Interactive Donut + Category Grid with Edit/Delete actions,
   * plus the clean workspace Empty State hero when the user has 0 accounts.
   */
  renderCategoriesView(analytics) {
    const emptyStateBanner = document.getElementById('dashboard-empty-state-banner');
    const activeAccountsCount = filterActiveAccounts(this.state.accounts || []).length;
    if (emptyStateBanner) {
      if (activeAccountsCount === 0) {
        const archivedCount = filterArchivedAccounts(this.state.accounts || []).length;
        emptyStateBanner.classList.remove('is-hidden');
        emptyStateBanner.innerHTML = renderDashboardEmptyStateMarkup({
          archivedCount,
          baseCurrency: analytics.baseCurrency || this.state.settings?.baseCurrency || 'HNL',
        });
      } else {
        emptyStateBanner.classList.add('is-hidden');
        emptyStateBanner.innerHTML = '';
      }
    }

    const donutMount = document.getElementById('donut-chart-mount');
    if (donutMount) {
      donutMount.innerHTML = renderPistoDonutChart(analytics);
    }

    const expenseGrid = document.getElementById('expense-categories-grid');
    if (expenseGrid) {
      expenseGrid.innerHTML = analytics.expenseCategories
        .map((cat) => {
          const progressDeg = Math.min(360, Math.round((cat.sharePct / 100) * 360));
          const budgetBadge =
            cat.budgetLimit > 0
              ? `<span class="cat-budget-pill status-${cat.budgetStatus}" title="Presupuesto mensual: ${Money.format(cat.budgetLimit, analytics.baseCurrency)}">${cat.budgetPct}% pres.</span>`
              : '';

          return `
            <div class="cat-card-wrapper">
              <article class="cat-card">
                <div
                  class="cat-card-main"
                  role="button"
                  tabindex="0"
                  data-action="open-category-keypad"
                  data-category-id="${cat.id}"
                  aria-label="${cat.name}: gastado ${Money.format(cat.amount, analytics.baseCurrency)}, pulsar para añadir gasto"
                >
                  <div
                    class="cat-ring-avatar"
                    style="--cat-color: ${cat.color}; --ring-deg: ${progressDeg}deg;"
                  >
                    <div class="cat-ring-inner" style="color: ${cat.color}">
                      ${renderIcon(cat.icon, 22)}
                    </div>
                  </div>
                  <div class="cat-card-info">
                    <div class="cat-card-header">
                      <span class="cat-name">${cat.name}</span>
                      <span class="cat-share">${cat.sharePct}%</span>
                    </div>
                    <strong class="cat-amount">${Money.format(cat.amount, analytics.baseCurrency)}</strong>
                  </div>
                </div>
                <div class="cat-card-footer">
                  <div class="cat-meta-row" style="gap: 0.4rem;">
                    <span class="cat-tx-count">${cat.txCount} mov.</span>
                    ${budgetBadge}
                  </div>
                  <div class="card-crud-group">
                    <button
                      type="button"
                      class="btn-card-icon"
                      data-action="edit-category"
                      data-category-id="${cat.id}"
                      title="Modificar categoría ${cat.name}"
                      aria-label="Modificar categoría ${cat.name}"
                    >
                      ${renderIcon('edit', 13)}
                    </button>
                    <button
                      type="button"
                      class="btn-card-icon is-danger"
                      data-action="delete-category"
                      data-category-id="${cat.id}"
                      title="Eliminar categoría ${cat.name}"
                      aria-label="Eliminar categoría ${cat.name}"
                    >
                      ${renderIcon('trash', 13)}
                    </button>
                  </div>
                </div>
              </article>
            </div>
          `;
        })
        .join('');
    }

    const incomeGrid = document.getElementById('income-categories-grid');
    if (incomeGrid) {
      incomeGrid.innerHTML = analytics.incomeCategories
        .map(
          (cat) => `
            <div class="cat-card-wrapper">
              <article class="cat-card cat-card-income">
                <div
                  class="cat-card-main"
                  role="button"
                  tabindex="0"
                  data-action="open-category-keypad"
                  data-category-id="${cat.id}"
                  aria-label="${cat.name}: ingreso ${Money.format(cat.amount, analytics.baseCurrency)}, pulsar para añadir ingreso"
                >
                  <div class="cat-ring-avatar" style="--cat-color: ${cat.color}; --ring-deg: 360deg;">
                    <div class="cat-ring-inner" style="color: ${cat.color}">
                      ${renderIcon(cat.icon, 20)}
                    </div>
                  </div>
                  <div class="cat-card-info">
                    <span class="cat-name">${cat.name}</span>
                    <strong class="cat-amount text-income">+ ${Money.format(cat.amount, analytics.baseCurrency)}</strong>
                  </div>
                </div>
                <div class="cat-card-footer">
                  <span class="cat-tx-count">${cat.txCount} mov.</span>
                  <div class="card-crud-group">
                    <button
                      type="button"
                      class="btn-card-icon"
                      data-action="edit-category"
                      data-category-id="${cat.id}"
                      title="Modificar categoría ${cat.name}"
                      aria-label="Modificar categoría ${cat.name}"
                    >
                      ${renderIcon('edit', 13)}
                    </button>
                    <button
                      type="button"
                      class="btn-card-icon is-danger"
                      data-action="delete-category"
                      data-category-id="${cat.id}"
                      title="Eliminar categoría ${cat.name}"
                      aria-label="Eliminar categoría ${cat.name}"
                    >
                      ${renderIcon('trash', 13)}
                    </button>
                  </div>
                </div>
              </article>
            </div>
          `
        )
        .join('');
    }
  }

  /**
   * Renders Tab 2: Accounts, Wallets, Savings Goals & Debts with Clickable Detail View,
   * Archived Accounts Toggle, Unarchive Action, and Edit/Delete actions.
   */
  setupImportAccountModal() {
    this.accountsView = new AccountsView({
      getState: () => this.state,
      getImportContext: () => {
        const runtime = this.authService?.getFirebaseRuntime?.() || {};
        return {
          apiKey: this.authService?.geminiKeyStore?.getApiKey?.() || '',
          workspaceId: this.authService?.getActiveWorkspaceId?.() || this.state?.settings?.workspaceId || 'ws_default',
          currentUser: this.authService?.currentUser || null,
          currentUserProfile: this.authService?.currentProfile || null,
          firestoreDb: runtime.firestoreDb || null,
          firestoreModule: runtime.firestoreModule || null,
          storage: typeof localStorage !== 'undefined' ? localStorage : null,
        };
      },
      showToast: (msg) => this.showToast(msg),
      onCreated: () => {
        this.repo.saveState(this.state);
        this.renderAll();
      },
      onClose: () => {
        this.isImportAccountModalOpen = false;
      },
    });
    this.accountsView.init();
    document.getElementById('btn-import-account')?.addEventListener('click', openImportModal);
    globalThis.__PISTO_ACCOUNTS_VIEW_INSTANCE__ = this.accountsView;
  }

  openImportAccountModal() {
    this.isImportAccountModalOpen = true;
    if (this.accountsView) {
      this.accountsView.setIsImportAccountModalOpen(true);
    } else {
      setIsImportAccountModalOpen(true);
    }
  }

  renderAccountsView(accountsSummary) {
    this.accountsView?.bindImportAccountButton();
    document.getElementById('btn-import-account')?.addEventListener('click', openImportModal);
    const accountsGrid = document.getElementById('accounts-grid');
    if (!accountsGrid) return;

    const allAccounts = accountsSummary.accountsWithBalance || [];
    const archivedCount = filterArchivedAccounts(allAccounts).length;
    const visibleAccounts = filterAccountsForView(allAccounts, this.showArchivedAccounts);

    const archivedToggle = document.getElementById('toggle-show-archived-accounts');
    if (archivedToggle) {
      archivedToggle.checked = Boolean(this.showArchivedAccounts);
    }

    const archivedCountBadge = document.getElementById('archived-accounts-count-badge');
    if (archivedCountBadge) {
      archivedCountBadge.textContent = `(${archivedCount})`;
      archivedCountBadge.classList.toggle('is-hidden', archivedCount === 0);
    }

    const typeLabels = {
      bank: 'Cuenta Bancaria',
      cash: 'Efectivo',
      card: 'Tarjeta de Crédito',
      savings: 'Meta de Ahorro',
      debt: 'Deuda / Préstamo',
    };

    const hasDateRange = Boolean(
      this.state.settings.periodFilter === 'custom' &&
        (this.state.settings.startDate || this.state.settings.endDate)
    );

    if (visibleAccounts.length === 0) {
      accountsGrid.innerHTML = renderDashboardEmptyStateMarkup({
        archivedCount,
        baseCurrency: this.state.settings?.baseCurrency || 'HNL',
      });
      return;
    }

    accountsGrid.innerHTML = visibleAccounts
      .map((acc) => {
        const isArchived = Boolean(acc.isArchived || acc.status === 'archived');
        const accColor = acc.color || '#10b981';
        const isNegative = acc.currentBalance < 0;
        const hasGoal = acc.targetAmount > 0;
        const goalHtml = hasGoal
          ? `
            <div class="account-goal-bar">
              <div class="goal-labels">
                <span>Meta: ${Money.format(acc.targetAmount, acc.currency)}</span>
                <strong>${acc.goalProgressPct}%</strong>
              </div>
              <progress class="native-progress" max="100" value="${acc.goalProgressPct}"></progress>
            </div>
          `
          : '';

        const txBadgeLabel = hasDateRange
          ? `📋 ${acc.periodTxCount ?? 0} de ${acc.txCount ?? 0} mov. · Ver detalle →`
          : `📋 ${acc.txCount || 0} mov. · Ver detalle →`;

        const archivedBadgeHtml = isArchived
          ? `<span class="voucher-pill" style="background: rgba(245, 158, 11, 0.14); border-color: rgba(245, 158, 11, 0.4); color: #f59e0b; font-size: 0.72rem;" title="Cuenta archivada: su historial de transacciones sigue intacto">📦 Archivada</span>`
          : '';

        return `
          <div class="account-card-container">
            <article
              class="account-card account-card-clickable ${isArchived ? 'is-archived-account' : ''}"
              style="--acc-accent: ${accColor}; ${isArchived ? 'opacity: 0.84; border-style: dashed;' : ''}"
              role="button"
              tabindex="0"
              data-action="open-account-detail"
              data-account-id="${acc.id}"
              aria-label="Ver detalle de transacciones de la cuenta ${acc.name}${isArchived ? ' (Archivada)' : ''}"
            >
              <div class="account-card-top">
                <div class="account-icon-box" style="background-color: ${accColor}20; color: ${accColor}">
                  ${renderIcon(acc.icon, 22)}
                </div>
                <div class="account-title-group">
                  <div style="display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap;">
                    <h3 class="account-name">${acc.name}</h3>
                    ${archivedBadgeHtml}
                  </div>
                  <span class="account-type-badge">
                    ${acc.institution ? `${acc.institution} · ` : ''}${acc.accountNumber ? `N.º *${extractLast4Digits(acc.accountNumber) || acc.accountNumber} · ` : ''}${typeLabels[acc.type] || acc.type} · ${acc.currency}
                  </span>
                </div>
                ${
                  isArchived
                    ? `<button
                        type="button"
                        class="btn-secondary btn-sm"
                        data-action="unarchive-account"
                        data-account-id="${acc.id}"
                        aria-label="Desarchivar o reactivar la cuenta ${acc.name}"
                        title="Reactivar cuenta para que vuelva a la vista principal y a los selectores de transacciones"
                      >
                        ♻️ Reactivar
                      </button>`
                    : `<button
                        type="button"
                        class="btn-include-toggle ${acc.includeInTotal ? 'is-included' : ''}"
                        data-action="toggle-account-include"
                        data-account-id="${acc.id}"
                        aria-pressed="${acc.includeInTotal ? 'true' : 'false'}"
                        aria-label="${acc.includeInTotal ? `Excluir ${acc.name} del Patrimonio Total` : `Incluir ${acc.name} en el Patrimonio Total`}"
                        title="${acc.includeInTotal ? 'Incluida en el Patrimonio Total' : 'Excluida del Patrimonio Total'}"
                      >
                        ${acc.includeInTotal ? 'En Total ✓' : 'Oculta'}
                      </button>`
                }
              </div>

              <div class="account-balance-row">
                <div style="display: flex; flex-direction: column; gap: 0.25rem;">
                  <span class="account-balance-label">${isArchived ? 'Saldo histórico' : 'Saldo actual'}</span>
                  <span class="account-tx-count-pill">${txBadgeLabel}</span>
                </div>
                <strong class="account-balance-value ${isNegative ? 'text-danger' : ''}">
                  ${Money.format(acc.currentBalance, acc.currency)}
                </strong>
              </div>

              ${goalHtml}

              <div class="account-actions-row">
                ${
                  isArchived
                    ? `<button
                        type="button"
                        class="btn-secondary btn-sm"
                        data-action="unarchive-account"
                        data-account-id="${acc.id}"
                        aria-label="Desarchivar la cuenta ${acc.name}"
                      >
                        ♻️ Desarchivar Cuenta
                      </button>`
                    : `<button
                        type="button"
                        class="btn-secondary btn-sm"
                        data-action="open-account-transfer"
                        data-account-id="${acc.id}"
                      >
                        ${renderIcon('transfer', 14)} Transferir
                      </button>`
                }

                <div class="card-crud-group">
                  <button
                    type="button"
                    class="btn-card-icon"
                    data-action="edit-account"
                    data-account-id="${acc.id}"
                    title="Editar cuenta, icono y color de ${acc.name}"
                    aria-label="Editar cuenta y color de ${acc.name}"
                  >
                    <span class="account-color-dot" style="background-color: ${accColor};" aria-hidden="true"></span>
                    ${renderIcon('edit', 15)}
                  </button>
                  <button
                    type="button"
                    class="btn-card-icon is-danger"
                    data-action="delete-account"
                    data-account-id="${acc.id}"
                    title="Archivar o borrar cuenta ${acc.name}"
                    aria-label="Archivar o borrar cuenta ${acc.name}"
                  >
                    ${renderIcon('trash', 15)}
                  </button>
                </div>
              </div>
            </article>
          </div>
        `;
      })
      .join('');
  }

  /**
   * Renders Tab 3: Chronological Transaction Ledger & Local NLP Preview.
   */
  renderLedgerSection() {
    const accountFilterEl = document.getElementById('ledger-account-select');
    if (accountFilterEl) {
      const currentVal = this.ledgerFilters.accountFilter || 'all';
      accountFilterEl.innerHTML = [
        `<option value="all">Todas las cuentas</option>`,
        ...this.state.accounts.map((acc) => {
          const last4 = extractLast4Digits(acc.accountNumber);
          const suffix = last4 ? ` (*${last4})` : '';
          return `<option value="${acc.id}">${acc.name}${suffix}</option>`;
        }),
      ].join('');
      accountFilterEl.value = this.state.accounts.some((a) => a.id === currentVal)
        ? currentVal
        : 'all';
      this.ledgerFilters.accountFilter = accountFilterEl.value;
    }

    const isCustomPeriod = this.state.settings.periodFilter === 'custom';
    const personalViewMode = Boolean(this.state.settings.personalViewMode);
    const currentUid = this.state.settings.currentUid || null;
    const workspaceId = this.state.settings.workspaceId || 'ws_default';

    const groups = groupTransactionsByDay(this.state, {
      ...this.ledgerFilters,
      period: this.state.settings.periodFilter,
      startDate: isCustomPeriod ? this.state.settings.startDate : '',
      endDate: isCustomPeriod ? this.state.settings.endDate : '',
      personalViewMode,
      currentUid,
      workspaceId,
    });
    const allHistoryGroups = groupTransactionsByDay(this.state, {
      ...this.ledgerFilters,
      period: 'all',
      startDate: '',
      endDate: '',
      personalViewMode,
      currentUid,
      workspaceId,
    });

    const shownCount = groups.reduce((acc, g) => acc + g.items.length, 0);
    const totalHistoryCount = allHistoryGroups.reduce((acc, g) => acc + g.items.length, 0);
    const hiddenByDateCount = Math.max(0, totalHistoryCount - shownCount);

    const baseCur = this.state.settings.baseCurrency || 'USD';
    const ledgerMount = document.getElementById('ledger-groups-mount');
    if (!ledgerMount) return;

    const hiddenBannerHtml =
      hiddenByDateCount > 0
        ? `
          <div class="ledger-hidden-banner">
            <span>
              📅 Hay <strong>${hiddenByDateCount} movimiento(s)</strong> de otras fechas ocultos por el filtro de periodo activo.
            </span>
            <button type="button" class="btn-secondary btn-sm" data-action="show-all-history">
              Ver Todo el Historial (${totalHistoryCount})
            </button>
          </div>
        `
        : '';

    if (groups.length === 0) {
      ledgerMount.innerHTML = `
        ${hiddenBannerHtml}
        <div class="empty-state-box">
          <p>No se encontraron transacciones para los filtros seleccionados.</p>
        </div>
      `;
      return;
    }

    ledgerMount.innerHTML =
      hiddenBannerHtml +
      groups
        .map((group) => {
          const netSign = group.netAmount >= 0 ? '+' : '';
          const itemsHtml = group.items
            .map((tx) => {
              const isIncome = tx.type === TRANSACTION_TYPES.INCOME;
              const isTransfer = tx.type === TRANSACTION_TYPES.TRANSFER;
              const sign = isIncome ? '+' : isTransfer ? '⇄' : '-';
              const amountClass = isIncome ? 'text-income' : isTransfer ? 'text-transfer' : 'text-expense';
              const authorHandle = String(tx.createdByEmail || tx.ownerName || 'personal@pisto.hn')
                .split('@')[0]
                .trim();
              const subtitle = isTransfer
                ? `${tx.account.name} → ${tx.toAccount?.name || 'Destino'}`
                : `${tx.account.name}${tx.note ? ` · ${tx.note}` : ''}`;

              return `
                <div
                  class="tx-row tx-row-clickable"
                  role="button"
                  tabindex="0"
                  data-action="edit-transaction"
                  data-tx-id="${tx.id}"
                  title="Haz clic para ver el detalle y modificar los atributos de esta transacción"
                  aria-label="Ver detalle y modificar ${isTransfer ? 'Transferencia' : tx.category.name} por ${Money.format(tx.amount, tx.currency)}"
                >
                  <div class="tx-icon" style="background-color: ${tx.category.color}22; color: ${tx.category.color}">
                    ${renderIcon(tx.category.icon, 18)}
                  </div>
                  <div class="tx-details">
                    <div class="tx-title-row">
                      <strong class="tx-cat-title">${isTransfer ? 'Transferencia entre cuentas' : tx.category.name}</strong>
                      <span class="tx-author-badge" title="Ingresado por ${tx.createdByEmail || authorHandle}">Por: ${authorHandle}</span>
                    </div>
                    <span class="tx-subtitle">${subtitle}</span>
                  </div>
                  <div class="tx-amount-col">
                    <strong class="tx-amount ${amountClass}">
                      ${sign} ${Money.format(tx.amount, tx.currency)}
                    </strong>
                    <div class="tx-row-actions">
                      <button
                        type="button"
                        class="btn-icon-edit"
                        data-action="edit-transaction"
                        data-tx-id="${tx.id}"
                        aria-label="Modificar transacción"
                        title="Ver detalle / Modificar"
                      >
                        ${renderIcon('edit', 15)}
                      </button>
                      <button
                        type="button"
                        class="btn-icon-delete"
                        data-action="delete-transaction"
                        data-tx-id="${tx.id}"
                        aria-label="Eliminar transacción"
                        title="Eliminar"
                      >
                        ${renderIcon('trash', 15)}
                      </button>
                    </div>
                  </div>
                </div>
              `;
            })
            .join('');

          return `
            <section class="ledger-day-group">
              <header class="ledger-day-header">
                <span class="ledger-date">${group.date}</span>
                <span class="ledger-day-net ${group.netAmount >= 0 ? 'text-income' : 'text-muted'}">
                  Neto: ${netSign}${Money.format(group.netAmount, baseCur)}
                </span>
              </header>
              <div class="ledger-day-items">
                ${itemsHtml}
              </div>
            </section>
          `;
        })
        .join('');
  }

  /**
   * Renders Tab 4: Category Budgets & Genkit Financial Coach with Token Audit.
   */
  renderBudgetsAndAiView(analytics, micro) {
    const budgetsMount = document.getElementById('budgets-list-mount');
    const cur = analytics.baseCurrency;

    if (budgetsMount) {
      budgetsMount.innerHTML = analytics.expenseCategories
        .map((cat) => {
          const pct = Math.min(100, cat.budgetPct);
          return `
            <div class="budget-item-card status-border-${cat.budgetStatus}">
              <div class="budget-item-header">
                <div class="budget-cat-title">
                  <span class="budget-dot" style="background-color: ${cat.color}"></span>
                  <strong>${cat.name}</strong>
                </div>
                <div class="budget-input-group">
                  <label for="budget-input-${cat.id}" class="sr-only">Límite mensual para ${cat.name}</label>
                  <span class="currency-prefix">${cur}</span>
                  <input
                    type="number"
                    id="budget-input-${cat.id}"
                    class="budget-inline-input"
                    min="0"
                    step="10"
                    value="${cat.budgetLimit}"
                    data-budget-category="${cat.id}"
                  />
                </div>
              </div>
              <progress class="native-progress progress-${cat.budgetStatus}" max="100" value="${pct}"></progress>
              <div class="budget-item-footer">
                <span>Gastado: <strong>${Money.format(cat.amount, cur)}</strong></span>
                <span class="budget-status-text status-${cat.budgetStatus}">
                  ${
                    cat.budgetLimit <= 0
                      ? 'Sin límite asignado'
                      : cat.amount <= cat.budgetLimit
                        ? `Disponible: ${Money.format(cat.budgetLimit - cat.amount, cur)} (${cat.budgetPct}%)`
                        : `Excedido por ${Money.format(cat.amount - cat.budgetLimit, cur)} (${cat.budgetPct}%)`
                  }
                </span>
              </div>
            </div>
          `;
        })
        .join('');
    }

    // Token Compression Audit Panel
    const auditMount = document.getElementById('token-compression-stats');
    if (auditMount) {
      auditMount.innerHTML = `
        <div class="token-stat-pill">
          <span>Historial bruto:</span>
          <strong>~${micro.rawTokensEstimate} tokens</strong>
        </div>
        <div class="token-stat-pill highlight">
          <span>Micro-Payload Genkit:</span>
          <strong>${micro.compactTokensEstimate} tokens (-${micro.savingsPct}%)</strong>
        </div>
        <div class="token-stat-pill">
          <span>Parses locales (0 tokens):</span>
          <strong>${this.state.aiTelemetry?.localParsesSaved || 0}</strong>
        </div>
      `;
    }

    const payloadPreview = document.getElementById('micro-payload-preview');
    if (payloadPreview) {
      payloadPreview.textContent = micro.fingerprint;
    }

    if (this.lastInsightsResult) {
      this.renderInsightsOutput(this.lastInsightsResult);
    }
  }

  /**
   * Live 0-token heuristic preview while user types in the Quick NLP bar.
   */
  updateQuickNlpPreview(text) {
    const previewEl = document.getElementById('quick-nlp-preview');
    if (!previewEl) return;

    if (!text.trim()) {
      previewEl.innerHTML = '<span>💡 Ejemplo: <code>25.50 almuerzo con tarjeta</code> (0 tokens) o frase múltiple con Genkit IA.</span>';
      return;
    }

    const result = parseNaturalLanguageLocal(text, this.state);
    if (!result.parsed) {
      previewEl.innerHTML = '<span>Escriba un monto o pulse <strong>✨ Analizar con Genkit IA</strong> para frases complejas.</span>';
      return;
    }

    const cat = this.state.categories.find((c) => c.id === result.transaction.categoryId);
    const acc = this.state.accounts.find((a) => a.id === result.transaction.accountId);

    if (result.isMultiClause) {
      previewEl.innerHTML = `
        <span class="preview-badge ai-suggested">
          Detectadas múltiples cláusulas · Pulse <strong>✨ Genkit IA</strong> para separar varios gastos de una vez.
        </span>
      `;
    } else {
      previewEl.innerHTML = `
        <span class="preview-badge local-zero-token">
          ⚡ Motor Local (0 Tokens): <strong>${Money.format(result.transaction.amount, result.transaction.currency)}</strong>
          → Categoría: <strong>${cat?.name || result.transaction.categoryId}</strong>
          → Cuenta: <strong>${acc?.name || 'Principal'}</strong>
        </span>
      `;
    }
  }

  /**
   * Executes the 0-token local heuristic parser on Enter / Submit.
   */
  handleLocalQuickEntry() {
    const input = document.getElementById('quick-nlp-input');
    if (!input || !input.value.trim()) return;

    const result = parseNaturalLanguageLocal(input.value, this.state);
    if (!result.parsed || !result.transaction) {
      this.showToast('No se detectó un monto claro. Probando con el analizador inteligente...');
      this.handleGenkitSmartParse();
      return;
    }

    const tx = this.recordWorkspaceTransaction(result.transaction);
    this.state.transactions.unshift(tx);
    this.state.aiTelemetry.localParsesSaved = (this.state.aiTelemetry.localParsesSaved || 0) + 1;
    this.repo.saveState(this.state);

    input.value = '';
    this.updateQuickNlpPreview('');
    this.showToast(`⚡ Registrado localmente (0 tokens): ${Money.format(tx.amount, tx.currency)}`);
    this.renderAll();
  }

  /**
   * Calls the server's Genkit parseTransactionsFlow (/api/ai/parse) on explicit user request.
   * Forwards the user's localStorage Gemini API key via x-gemini-api-key header when configured.
   */
  async handleGenkitSmartParse() {
    const input = document.getElementById('quick-nlp-input');
    const text = input?.value?.trim();
    if (!text) {
      this.showToast('Escriba una frase con uno o varios movimientos primero.');
      return;
    }

    const btn = document.querySelector('[data-action="smart-parse-ai"]');
    if (btn) btn.disabled = true;

    const localGeminiKey = this.authService?.geminiKeyStore?.getApiKey() || '';
    const headers = { 'Content-Type': 'application/json' };
    if (localGeminiKey) {
      headers['x-gemini-api-key'] = localGeminiKey;
    }

    try {
      const response = await fetch('/api/ai/parse', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          text,
          categories: this.state.categories.map((c) => c.id),
        }),
      });
      const data = await response.json();
      if (!data.ok || !Array.isArray(data.items) || data.items.length === 0) {
        throw new Error(data.error || 'No se pudieron extraer transacciones del texto.');
      }

      const defaultActiveAccountId =
        filterActiveAccounts(this.state.accounts)[0]?.id || this.state.accounts[0]?.id || 'acc_bank';
      for (const item of data.items) {
        const tx = this.recordWorkspaceTransaction({
          type: item.type || TRANSACTION_TYPES.EXPENSE,
          amount: item.amount,
          currency: this.state.settings.baseCurrency || 'USD',
          categoryId: item.categoryId || 'food',
          accountId: defaultActiveAccountId,
          note: item.note || 'Genkit Smart Parse',
        });
        this.state.transactions.unshift(tx);
      }

      this.state.aiTelemetry.aiCallsCount += data.tokensUsed > 0 ? 1 : 0;
      this.state.aiTelemetry.totalTokensUsed += data.tokensUsed || 0;
      if (data.cached) this.state.aiTelemetry.cacheHits += 1;

      this.repo.saveState(this.state);
      input.value = '';
      this.updateQuickNlpPreview('');
      this.showToast(`✨ ${data.items.length} movimiento(s) procesados (${data.tokensUsed || 0} tokens).`);
      this.renderAll();
    } catch (error) {
      this.showToast(`Aviso: ${error.message}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /**
   * Calls the server's Genkit financialInsightsFlow (/api/ai/insights) with the compressed micro-payload.
   * Forwards the user's localStorage Gemini API key via x-gemini-api-key header when configured.
   */
  async handleGenkitInsights() {
    const micro = this.currentMicroPayload;
    if (!micro) return;

    // Client-side fingerprint cache check (0 tokens if state hasn't changed!)
    if (this.insightsCache.has(micro.fingerprint)) {
      const cachedResult = this.insightsCache.get(micro.fingerprint);
      this.state.aiTelemetry.cacheHits = (this.state.aiTelemetry.cacheHits || 0) + 1;
      this.repo.saveState(this.state);
      this.lastInsightsResult = { ...cachedResult, cached: true, tokensUsed: 0 };
      this.renderInsightsOutput(this.lastInsightsResult);
      this.renderTelemetryBadge();
      this.showToast('⚡ Diagnóstico recuperado de caché local (0 tokens consumidos).');
      return;
    }

    const btn = document.querySelector('[data-action="generate-ai-insights"]');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Analizando micro-payload...';
    }

    const localGeminiKey = this.authService?.geminiKeyStore?.getApiKey() || '';
    const headers = { 'Content-Type': 'application/json' };
    if (localGeminiKey) {
      headers['x-gemini-api-key'] = localGeminiKey;
    }

    try {
      const response = await fetch('/api/ai/insights', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          compactPayload: micro.compactPayload,
          lang: 'es',
        }),
      });
      const data = await response.json();
      if (!data.ok) {
        throw new Error(data.error || 'Error al consultar Genkit.');
      }

      this.insightsCache.set(micro.fingerprint, data);
      this.lastInsightsResult = data;

      if (data.tokensUsed > 0) {
        this.state.aiTelemetry.aiCallsCount = (this.state.aiTelemetry.aiCallsCount || 0) + 1;
        this.state.aiTelemetry.totalTokensUsed = (this.state.aiTelemetry.totalTokensUsed || 0) + data.tokensUsed;
      }
      this.repo.saveState(this.state);

      this.renderInsightsOutput(data);
      this.renderTelemetryBadge();
    } catch (error) {
      this.showToast(`Error: ${error.message}`);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '✨ Generar Diagnóstico con Genkit';
      }
    }
  }

  renderInsightsOutput(result) {
    const mount = document.getElementById('ai-insights-result-mount');
    if (!mount) return;

    const tipsHtml = (result.tips || [])
      .map((tip) => `<li>${tip}</li>`)
      .join('');

    mount.innerHTML = `
      <div class="ai-insight-card status-border-${result.status || 'healthy'}">
        <div class="ai-insight-header">
          <div class="ai-score-circle">
            <strong>${result.score}</strong>
            <span>/100</span>
          </div>
          <div class="ai-headline-box">
            <span class="ai-source-tag">
              Fuente: ${result.source} · ${result.cached ? 'Caché (0 tokens)' : `${result.tokensUsed || 0} tokens`}
            </span>
            <h4>${result.headline}</h4>
          </div>
        </div>
        <ul class="ai-tips-list">
          ${tipsHtml}
        </ul>
        <div class="ai-opportunity-banner">
          <strong>🎯 Oportunidad de ahorro:</strong> ${result.savingOpportunity}
        </div>
      </div>
    `;
  }

  async fetchServerAiStatus() {
    try {
      const res = await fetch('/api/ai/status');
      if (!res.ok) return;
      this.serverStatus = await res.json();
      this.renderTelemetryBadge();
    } catch {
      // Offline / static mode
    }
  }

  renderTelemetryBadge() {
    const badgeEl = document.getElementById('header-token-telemetry');
    if (!badgeEl) return;

    const used = this.state.aiTelemetry?.totalTokensUsed || 0;
    const saved = this.state.aiTelemetry?.localParsesSaved || 0;
    const hasLocalKey = Boolean(this.authService?.geminiKeyStore?.hasApiKey());
    const isGenkitActive = Boolean(this.serverStatus?.genkitConfigured || hasLocalKey);
    const modeLabel = isGenkitActive ? 'Genkit Ready' : 'Modo 0-Tokens';

    badgeEl.innerHTML = `
      <span class="telemetry-dot ${isGenkitActive ? 'is-live' : ''}"></span>
      <span>${modeLabel}: <strong>${used} tok</strong> · Ahorrados: <strong>${saved}</strong></span>
    `;
  }

  downloadCsv() {
    const csv = this.repo.exportTransactionsCsv(this.state);
    this.triggerDownload(csv, `Pisto_transacciones_${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv;charset=utf-8;');
    this.showToast('Archivo CSV exportado.');
  }

  downloadJson() {
    const json = JSON.stringify(this.state, null, 2);
    this.triggerDownload(json, `Pisto_backup_${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
    this.showToast('Respaldo JSON exportado.');
  }

  triggerDownload(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  showToast(message) {
    const toast = document.getElementById('app-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('is-visible');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      toast.classList.remove('is-visible');
    }, 3200);
  }
}

export function bootstrapPistoApp() {
  if (typeof document === 'undefined') return null;
  document.getElementById('btn-import-account')?.addEventListener('click', openImportModal);
  if (globalThis.pistoApp) {
    return globalThis.pistoApp;
  }
  const app = new FinanceAppController();
  app.init();
  return app;
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrapPistoApp, { once: true });
  } else {
    bootstrapPistoApp();
  }
}

