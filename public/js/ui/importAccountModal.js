/**
 * @fileoverview Re-export limpio hacia el módulo Vanilla canónico `src/js/components/ImportAccountModal.js`.
 * Maximiza la reutilización de funciones (DRY) y evita duplicación de código.
 */

export {
  ImportAccountModal,
  HONDURAS_BANKS_LIST,
  cleanBankName,
  cleanAccountType,
  openImportModal,
  bindImportAccountTriggerButtons,
  promptDuplicateTransactionModal,
  useAccountAgentADK,
  ADK_INIT_LOG_MESSAGE,
  ADK_DEMO_ACCOUNT_DATA,
  DUPLICATE_TRANSACTION_ACTIONS,
  DUPLICATE_TRANSACTION_OPTION_LABELS,
  formatDuplicateTransactionWarning,
  findAccountDuplicateTransactions,
  checkAccountTransactionDuplicate,
  resolveDuplicateTransactionAction,
  extractAccountFromFile,
  persistImportedAccountAndTransactions,
  default,
} from '../../../src/js/components/ImportAccountModal.js';
