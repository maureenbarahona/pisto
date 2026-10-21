/**
 * @fileoverview Accounts & Relational Integrity Data Service (`public/js/services/accounts.js`).
 *
 * Implements:
 * 1. Option A — Soft-Archive Account (`archiveAccount` / `unarchiveAccount`):
 *    - Sets `isArchived: true` and `status: "archived"` on the account.
 *    - Hides the account from the active accounts grid and from new transaction form selectors (`filterActiveAccounts`).
 *    - Keeps 100% of historical transactions intact so Dashboard balances, budgets, and reports are unaltered.
 * 2. Option B — Cascade Delete Account & Transactions (`deleteAccountWithCascade`):
 *    - Executes an atomic Firestore `writeBatch` to delete `accounts/{accountId}` AND all documents in
 *      `transactions` where `accountId === idDeLaCuenta`.
 *    - Cleans up Local-First state (`state.accounts`, `state.transactions`, and workspace cache).
 */

import {
  createAccount,
  isAccountArchived,
  getActiveAccounts,
} from '../domain/models.js';
import {
  getTransactionsByAccountId,
  deleteAccountAndTransactionsWriteBatch,
} from './transactions.js';

export { isAccountArchived, getActiveAccounts };

/**
 * Returns only active (`!isArchived` and `status !== 'archived'`) accounts for new transaction form selectors.
 */
export function filterActiveAccounts(accounts = []) {
  return (Array.isArray(accounts) ? accounts : []).filter((acc) => !isAccountArchived(acc));
}

/**
 * Returns archived accounts (`isArchived === true` or `status === 'archived'`).
 */
export function filterArchivedAccounts(accounts = []) {
  return (Array.isArray(accounts) ? accounts : []).filter((acc) => isAccountArchived(acc));
}

/**
 * Filters accounts for the "Cuentas y Metas" tab based on the "Mostrar Cuentas Archivadas" toggle.
 */
export function filterAccountsForView(accounts = [], showArchived = false) {
  const list = Array.isArray(accounts) ? accounts : [];
  if (showArchived) {
    return [...list];
  }
  return list.filter((acc) => !isAccountArchived(acc));
}

/**
 * Persists an account document to Firestore `accounts/{account.id}` when connected.
 */
export async function saveAccountToFirestore(accountInput, context = {}) {
  const nowIso = new Date().toISOString();
  const normalized = createAccount({
    ...accountInput,
    workspaceId: accountInput.workspaceId || context.workspaceId || 'ws_default',
    createdByUid: accountInput.createdByUid || context.currentUid || 'local_default_user',
    createdAt: accountInput.createdAt || nowIso,
    updatedAt: nowIso,
  });

  if (
    context.firestoreDb &&
    context.firestoreModule &&
    typeof context.firestoreModule.doc === 'function' &&
    typeof context.firestoreModule.setDoc === 'function'
  ) {
    try {
      const accRef = context.firestoreModule.doc(context.firestoreDb, 'accounts', normalized.id);
      await context.firestoreModule.setDoc(accRef, normalized, { merge: true });
    } catch {
      // Fallback to local state when Firestore is offline
    }
  }

  return normalized;
}

/**
 * Option A: "📦 Archivar Cuenta (Recomendado)"
 * - Sets `isArchived: true` and `status: "archived"` on the target account.
 * - Hides the account from the active accounts grid and new transaction selectors.
 * - Keeps all historical transactions intact so financial history, budgets, and Dashboard reports are unaltered.
 */
export async function archiveAccount(accountId, state, context = {}) {
  const cleanId = String(accountId || '').trim();
  const idx = (state.accounts || []).findIndex((a) => a.id === cleanId);
  if (idx === -1) {
    throw new Error(`No se encontró la cuenta con ID "${cleanId}".`);
  }

  const nowIso = new Date().toISOString();
  const existing = state.accounts[idx];
  const archivedAccount = createAccount({
    ...existing,
    isArchived: true,
    status: 'archived',
    workspaceId:
      existing.workspaceId || context.workspaceId || state.settings?.workspaceId || 'ws_default',
    createdByUid:
      existing.createdByUid || context.currentUid || state.settings?.currentUid || 'local_default_user',
    updatedAt: nowIso,
  });

  state.accounts[idx] = archivedAccount;

  if (
    context.firestoreDb &&
    context.firestoreModule &&
    typeof context.firestoreModule.doc === 'function' &&
    typeof context.firestoreModule.setDoc === 'function'
  ) {
    try {
      const accRef = context.firestoreModule.doc(context.firestoreDb, 'accounts', cleanId);
      await context.firestoreModule.setDoc(
        accRef,
        {
          ...archivedAccount,
          isArchived: true,
          status: 'archived',
          updatedAt: nowIso,
        },
        { merge: true }
      );
    } catch {
      // Fallback to local state when Firestore is offline
    }
  }

  const associatedTxs = getTransactionsByAccountId(state.transactions || [], cleanId);

  return {
    account: archivedAccount,
    accounts: state.accounts,
    transactions: state.transactions || [],
    preservedTxCount: associatedTxs.length,
  };
}

/**
 * Reactivates / Unarchives a previously archived account (`isArchived: false`, `status: "active"`).
 */
export async function unarchiveAccount(accountId, state, context = {}) {
  const cleanId = String(accountId || '').trim();
  const idx = (state.accounts || []).findIndex((a) => a.id === cleanId);
  if (idx === -1) {
    throw new Error(`No se encontró la cuenta con ID "${cleanId}".`);
  }

  const nowIso = new Date().toISOString();
  const existing = state.accounts[idx];
  const activeAccount = createAccount({
    ...existing,
    isArchived: false,
    status: 'active',
    workspaceId:
      existing.workspaceId || context.workspaceId || state.settings?.workspaceId || 'ws_default',
    createdByUid:
      existing.createdByUid || context.currentUid || state.settings?.currentUid || 'local_default_user',
    updatedAt: nowIso,
  });

  state.accounts[idx] = activeAccount;

  if (
    context.firestoreDb &&
    context.firestoreModule &&
    typeof context.firestoreModule.doc === 'function' &&
    typeof context.firestoreModule.setDoc === 'function'
  ) {
    try {
      const accRef = context.firestoreModule.doc(context.firestoreDb, 'accounts', cleanId);
      await context.firestoreModule.setDoc(
        accRef,
        {
          ...activeAccount,
          isArchived: false,
          status: 'active',
          updatedAt: nowIso,
        },
        { merge: true }
      );
    } catch {
      // Fallback to local state when Firestore is offline
    }
  }

  return {
    account: activeAccount,
    accounts: state.accounts,
  };
}

/**
 * Option B: "⚠️ Borrar Cuenta y Transacciones (Eliminar en Cascada)"
 * - Executes an atomic Firestore `writeBatch` to delete `accounts/{accountId}` AND cascade-delete
 *   all documents in `transactions` where `accountId === idDeLaCuenta`.
 * - Removes the account and all associated transactions permanently from Local-First state.
 */
export async function deleteAccountWithCascade(accountId, state, context = {}) {
  const cleanId = String(accountId || '').trim();
  const deletedAccount = (state.accounts || []).find((a) => a.id === cleanId) || null;
  const workspaceId =
    context.workspaceId ||
    deletedAccount?.workspaceId ||
    state.settings?.workspaceId ||
    'ws_default';

  const batchResult = await deleteAccountAndTransactionsWriteBatch(cleanId, {
    workspaceId,
    transactions: state.transactions || [],
    firestoreDb: context.firestoreDb,
    firestoreModule: context.firestoreModule,
    storage: context.storage,
  });

  state.accounts = (state.accounts || []).filter((a) => a.id !== cleanId);
  state.transactions = batchResult.remainingTransactions;

  return {
    deletedAccount,
    deletedAccountId: cleanId,
    deletedTransactionsCount: batchResult.deletedCount,
    deletedTransactionIds: batchResult.deletedTransactionIds,
    accounts: state.accounts,
    transactions: state.transactions,
    batchCommitted: batchResult.batchCommitted,
  };
}
