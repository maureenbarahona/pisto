/**
 * @fileoverview Módulo Principal Vanilla ESNext de Pisto (`src/js/app.js`).
 *
 * Orquesta:
 * - Inicialización de la aplicación Vanilla JS (HTML5 semántico + CSS3 + ESNext Modules).
 * - Vinculación directa del botón `#btn-import-account` (`document.getElementById('btn-import-account')?.addEventListener('click', openImportModal);`).
 * - Integración del motor de Deduplicación Inteligente de Transacciones y persistencia eficiente en Firestore.
 */

import {
  FIRESTORE_COLLECTIONS,
  DUPLICATE_TRANSACTION_ACTIONS,
  DUPLICATE_TRANSACTION_OPTION_LABELS,
  queryCollectionWithCursor,
  formatDuplicateTransactionWarning,
  findAccountDuplicateTransactions,
  checkAccountTransactionDuplicate,
  resolveDuplicateTransactionAction,
  saveBatchAccountsToFirestore,
  fetchExistingWorkspaceAccountNumbers,
  formatBatchAccountsToastMessage,
  BATCH_DEMO_PRODUCTS_SUMMARY,
  ExtractedBatchAccountsSchema,
} from './services/firestore.js';
import {
  ImportAccountModal,
  openImportModal,
  bindImportAccountTriggerButtons,
  promptDuplicateTransactionModal,
} from './components/ImportAccountModal.js';
import {
  BatchAccountsModal,
  formatBatchAccountRowSummary,
  renderBatchAccountsRowsMarkup,
} from './components/BatchAccountsModal.js';
import {
  OnboardingWizard,
  createOnboardingWizard,
  shouldTriggerOnboarding,
  ensureCleanWorkspaceForFirstTimeUser,
  completeUserOnboarding,
  renderOnboardingStepMarkup,
  renderDashboardEmptyStateMarkup,
  ONBOARDING_STEPS,
  ONBOARDING_WIZARD_DIALOG_ID,
  ONBOARDING_FINISH_BUTTON_ID,
  ONBOARDING_FINISH_BUTTON_LABEL,
  EMPTY_STATE_CTA_LABELS,
  buildDefaultUserDocument,
  registerNewUserDocument,
  persistOnboardingCompletionInFirestore,
  removeOnboardingWizardFromDom,
  verifyUserOnboardingOnSignIn,
  cleanupOnboardingOnLogout,
} from './components/OnboardingWizard.js';
import {
  FinanceAppController,
  bootstrapPistoApp,
} from '../../public/js/app.js';

export {
  FinanceAppController,
  bootstrapPistoApp,
  ImportAccountModal,
  BatchAccountsModal,
  formatBatchAccountRowSummary,
  renderBatchAccountsRowsMarkup,
  openImportModal,
  bindImportAccountTriggerButtons,
  promptDuplicateTransactionModal,
  OnboardingWizard,
  createOnboardingWizard,
  shouldTriggerOnboarding,
  ensureCleanWorkspaceForFirstTimeUser,
  completeUserOnboarding,
  renderOnboardingStepMarkup,
  renderDashboardEmptyStateMarkup,
  ONBOARDING_STEPS,
  ONBOARDING_WIZARD_DIALOG_ID,
  ONBOARDING_FINISH_BUTTON_ID,
  ONBOARDING_FINISH_BUTTON_LABEL,
  EMPTY_STATE_CTA_LABELS,
  buildDefaultUserDocument,
  registerNewUserDocument,
  persistOnboardingCompletionInFirestore,
  removeOnboardingWizardFromDom,
  verifyUserOnboardingOnSignIn,
  cleanupOnboardingOnLogout,
  FIRESTORE_COLLECTIONS,
  DUPLICATE_TRANSACTION_ACTIONS,
  DUPLICATE_TRANSACTION_OPTION_LABELS,
  queryCollectionWithCursor,
  formatDuplicateTransactionWarning,
  findAccountDuplicateTransactions,
  checkAccountTransactionDuplicate,
  resolveDuplicateTransactionAction,
  saveBatchAccountsToFirestore,
  fetchExistingWorkspaceAccountNumbers,
  formatBatchAccountsToastMessage,
  BATCH_DEMO_PRODUCTS_SUMMARY,
  ExtractedBatchAccountsSchema,
};

if (typeof document !== 'undefined') {
  document.getElementById('btn-import-account')?.addEventListener('click', openImportModal);
  bindImportAccountTriggerButtons(openImportModal);
}
