/**
 * @fileoverview Workspace Transactions Data Service (`src/services/transactions.ts`).
 *
 * Implements:
 * 1. Firestore & Local-First Realtime Queries (`onSnapshot` / `getDocs`):
 *    - Queries `where("workspaceId", "==", currentUserProfile.workspaceId)`
 *    - When `personalViewMode` is `false` (DESACTIVADO), brings ALL transactions belonging to `workspaceId`
 *      regardless of who created them.
 *    - When `personalViewMode` is `true` (ACTIVO), filters by `createdByUid == currentUser.uid`.
 * 2. Transaction Creation (`prepareTransactionForWorkspace` / `saveTransactionToWorkspace`):
 *    - Always attaches `workspaceId` (from `currentUserProfile.workspaceId`), `createdByUid` (`currentUser.uid`),
 *      and `createdByEmail` (`currentUser.email`).
 */

export {
  type WorkspaceTransactionQueryOptions,
  type CascadeDeleteAccountResult,
  WORKSPACE_TRANSACTIONS_CACHE_PREFIX,
  prepareTransactionForWorkspace,
  buildWorkspaceTransactionsQuery,
  readLocalWorkspaceTransactions,
  writeLocalWorkspaceTransactions,
  mergeWorkspaceTransactions,
  filterWorkspaceTransactions,
  fetchWorkspaceTransactions,
  subscribeWorkspaceTransactions,
  saveTransactionToWorkspace,
  deleteTransactionFromWorkspace,
  migrateTransactionsToSharedWorkspace,
  getTransactionsByAccountId,
  deleteAccountAndTransactionsWriteBatch,
} from '../../public/js/services/transactions.ts';
