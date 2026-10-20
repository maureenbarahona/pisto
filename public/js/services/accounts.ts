/**
 * @fileoverview Accounts & Relational Integrity Data Service (`src/services/accounts.ts` / `public/js/services/accounts.ts`).
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
  type CascadeDeleteAccountResult,
} from './transactions.ts';
import type { TransactionRecord } from './authProfileService.ts';

export interface AccountRecord {
  id: string;
  name: string;
  type: string;
  institution?: string;
  accountNumber?: string;
  currency: string;
  initialBalance: number;
  targetAmount: number;
  includeInTotal: boolean;
  color: string;
  icon: string;
  isArchived: boolean;
  status: 'active' | 'archived';
  workspaceId?: string;
  createdByUid?: string;
  createdAt?: string;
  updatedAt?: string;
  currentBalance?: number;
  txCount?: number;
}

export interface AccountServiceContext {
  workspaceId?: string;
  currentUid?: string;
  firestoreDb?: any;
  firestoreModule?: any;
  storage?: Storage | null;
}

export { isAccountArchived, getActiveAccounts };

/**
 * Returns only active (`!isArchived` and `status !== 'archived'`) accounts for new transaction form selectors.
 */
export function filterActiveAccounts<T extends { isArchived?: boolean; status?: string }>(
  accounts: ReadonlyArray<T> = []
): T[] {
  return (Array.isArray(accounts) ? accounts : []).filter((acc) => !isAccountArchived(acc));
}

/**
 * Returns archived accounts (`isArchived === true` or `status === 'archived'`).
 */
export function filterArchivedAccounts<T extends { isArchived?: boolean; status?: string }>(
  accounts: ReadonlyArray<T> = []
): T[] {
  return (Array.isArray(accounts) ? accounts : []).filter((acc) => isAccountArchived(acc));
}

/**
 * Filters accounts for the "Cuentas y Metas" tab based on the "Mostrar Cuentas Archivadas" toggle.
 */
export function filterAccountsForView<T extends { isArchived?: boolean; status?: string }>(
  accounts: ReadonlyArray<T> = [],
  showArchived: boolean = false
): T[] {
  const list = Array.isArray(accounts) ? accounts : [];
  if (showArchived) {
    return [...list];
  }
  return list.filter((acc) => !isAccountArchived(acc));
}

/**
 * Persists an account document to Firestore `accounts/{account.id}` when connected.
 */
export async function saveAccountToFirestore(
  accountInput: Partial<AccountRecord> & { name: string },
  context: AccountServiceContext = {}
): Promise<AccountRecord> {
  const nowIso = new Date().toISOString();
  const normalized = createAccount({
    ...accountInput,
    workspaceId: accountInput.workspaceId || context.workspaceId || 'ws_default',
    createdByUid: accountInput.createdByUid || context.currentUid || 'local_default_user',
    createdAt: accountInput.createdAt || nowIso,
    updatedAt: nowIso,
  }) as AccountRecord;

  if (
    context.firestoreDb &&
    context.firestoreModule &&
    typeof context.firestoreModule.doc === 'function' &&
    typeof context.firestoreModule.setDoc === 'function'
  ) {
    try {
      const accRef = context.firestoreModule.doc(context.firestoreDb, 'accounts', normalized.id);
      await context.firestoreModule.setDoc(accRef, normalized, { merge: true });
    } catch (err) {
      console.warn('[AccountsService] Guardado local de cuenta (Firestore offline):', err);
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
export async function archiveAccount(
  accountId: string,
  state: {
    accounts: AccountRecord[];
    transactions?: TransactionRecord[];
    settings?: { workspaceId?: string; currentUid?: string };
  },
  context: AccountServiceContext = {}
): Promise<{
  account: AccountRecord;
  accounts: AccountRecord[];
  transactions: TransactionRecord[];
  preservedTxCount: number;
}> {
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
  }) as AccountRecord;

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
    } catch (err) {
      console.warn('[AccountsService] Cuenta archivada localmente (Firestore offline):', err);
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
export async function unarchiveAccount(
  accountId: string,
  state: {
    accounts: AccountRecord[];
    settings?: { workspaceId?: string; currentUid?: string };
  },
  context: AccountServiceContext = {}
): Promise<{
  account: AccountRecord;
  accounts: AccountRecord[];
}> {
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
  }) as AccountRecord;

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
    } catch (err) {
      console.warn('[AccountsService] Cuenta reactivada localmente (Firestore offline):', err);
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
export async function deleteAccountWithCascade(
  accountId: string,
  state: {
    accounts: AccountRecord[];
    transactions: TransactionRecord[];
    settings?: { workspaceId?: string; currentUid?: string };
  },
  context: AccountServiceContext = {}
): Promise<{
  deletedAccount: AccountRecord | null;
  deletedAccountId: string;
  deletedTransactionsCount: number;
  deletedTransactionIds: string[];
  accounts: AccountRecord[];
  transactions: TransactionRecord[];
  batchCommitted: boolean;
}> {
  const cleanId = String(accountId || '').trim();
  const deletedAccount = (state.accounts || []).find((a) => a.id === cleanId) || null;
  const workspaceId =
    context.workspaceId ||
    deletedAccount?.workspaceId ||
    state.settings?.workspaceId ||
    'ws_default';

  const batchResult: CascadeDeleteAccountResult = await deleteAccountAndTransactionsWriteBatch(
    cleanId,
    {
      workspaceId,
      transactions: state.transactions || [],
      firestoreDb: context.firestoreDb,
      firestoreModule: context.firestoreModule,
      storage: context.storage,
    }
  );

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
