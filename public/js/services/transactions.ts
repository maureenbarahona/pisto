/**
 * @fileoverview Workspace Transactions Data Service (`src/services/transactions.ts` / `public/js/services/transactions.ts`).
 *
 * Fixes shared family workspace synchronization:
 * 1. Firestore Query / Realtime Listener (`onSnapshot` & `getDocs`):
 *    - Queries `where("workspaceId", "==", currentUserProfile.workspaceId)` instead of restricting by `userId === auth.currentUser.uid`.
 *    - When `personalViewMode` is `false` (DESACTIVADO), fetches ALL transactions belonging to `workspaceId` regardless of creator.
 *    - When `personalViewMode` is `true` (ACTIVO), filters by `where("workspaceId", "==", workspaceId)` and `where("createdByUid", "==", currentUser.uid)`.
 * 2. Transaction Creation (`prepareTransactionForWorkspace` / `saveTransactionToWorkspace`):
 *    - Always attaches `workspaceId` (from `currentUserProfile.workspaceId`), `createdByUid` (`currentUser.uid`), and `createdByEmail` (`currentUser.email`).
 * 3. Local-First + Firestore Synchronization:
 *    - Persists and merges transactions across `transactions/{txId}` in Firestore and the Local-First workspace cache.
 */

import { createTransaction } from '../domain/models.js';
import type { AuthUser, UserProfile, TransactionRecord } from './authProfileService.ts';

export const WORKSPACE_TRANSACTIONS_CACHE_PREFIX = 'pisto_workspace_transactions_v1_';

export interface WorkspaceTransactionQueryOptions {
  workspaceId: string;
  personalViewMode?: boolean;
  currentUid?: string | null;
  firestoreDb?: any;
  firestoreModule?: any;
  storage?: Storage | null;
  seedTransactions?: ReadonlyArray<TransactionRecord>;
}

export type WorkspaceTransactionsResult = TransactionRecord[] & {
  allWorkspaceTransactions: TransactionRecord[];
  visibleTransactions: TransactionRecord[];
};

function resolveStorage(customStorage?: Storage | null): Storage | null {
  if (customStorage !== undefined) return customStorage;
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

function attachResultProps(
  visibleTransactions: TransactionRecord[],
  allWorkspaceTransactions: TransactionRecord[]
): WorkspaceTransactionsResult {
  const arr = [...visibleTransactions] as WorkspaceTransactionsResult;
  Object.defineProperty(arr, 'visibleTransactions', {
    value: visibleTransactions,
    enumerable: false,
  });
  Object.defineProperty(arr, 'allWorkspaceTransactions', {
    value: allWorkspaceTransactions,
    enumerable: false,
  });
  return arr;
}

function extractSnapshotDocs(
  snap: any,
  workspaceId: string
): TransactionRecord[] {
  const docs: TransactionRecord[] = [];
  if (!snap) return docs;
  if (typeof snap.forEach === 'function') {
    snap.forEach((docSnap: any) => {
      const data = typeof docSnap.data === 'function' ? docSnap.data() : docSnap;
      docs.push(
        createTransaction({ ...data, id: docSnap.id || data.id, workspaceId }) as TransactionRecord
      );
    });
  } else if (Array.isArray(snap.docs)) {
    for (const docSnap of snap.docs) {
      const data = typeof docSnap.data === 'function' ? docSnap.data() : docSnap;
      docs.push(
        createTransaction({ ...data, id: docSnap.id || data.id, workspaceId }) as TransactionRecord
      );
    }
  }
  return docs;
}

/**
 * Ensures a newly created or updated transaction always carries:
 * - `workspaceId`: active/shared workspace ID from `currentUserProfile.workspaceId`
 * - `createdByUid`: `currentUser.uid`
 * - `createdByEmail`: `currentUser.email`
 */
export function prepareTransactionForWorkspace(
  txInput: Partial<TransactionRecord> & { amount: number | string },
  currentUser: AuthUser | null | undefined,
  currentUserProfile: UserProfile | null | undefined,
  fallbackWorkspaceId: string = 'ws_default'
): TransactionRecord {
  const workspaceId =
    String(
      txInput.workspaceId && txInput.workspaceId !== 'ws_default'
        ? txInput.workspaceId
        : currentUserProfile?.workspaceId || txInput.workspaceId || fallbackWorkspaceId
    ).trim() || 'ws_default';

  const createdByUid =
    String(
      txInput.createdByUid && txInput.createdByUid !== 'local_default_user'
        ? txInput.createdByUid
        : currentUser?.uid || currentUserProfile?.uid || txInput.createdByUid || 'local_default_user'
    ).trim() || 'local_default_user';

  const createdByEmail =
    String(
      txInput.createdByEmail && txInput.createdByEmail !== 'personal@pisto.hn'
        ? txInput.createdByEmail
        : currentUser?.email || currentUserProfile?.email || txInput.createdByEmail || 'personal@pisto.hn'
    )
      .trim()
      .toLowerCase() || 'personal@pisto.hn';

  const ownerName =
    String(
      txInput.ownerName ||
        currentUserProfile?.name ||
        currentUser?.displayName ||
        createdByEmail.split('@')[0]
    ).trim();

  return createTransaction({
    ...txInput,
    workspaceId,
    createdByUid,
    createdByEmail,
    ownerUid: createdByUid,
    ownerName,
  }) as TransactionRecord;
}

/**
 * Builds the Firestore query for `transactions`:
 * - Always queries `where("workspaceId", "==", currentUserProfile.workspaceId)`
 * - If `personalViewMode` is `false` (DESACTIVADO), brings ALL transactions belonging to `workspaceId` regardless of creator.
 * - If `personalViewMode` is `true` (ACTIVO) and `currentUid` is present, adds `where("createdByUid", "==", currentUid)`.
 */
export function buildWorkspaceTransactionsQuery(
  arg1: any,
  arg2: any,
  options: {
    workspaceId: string;
    personalViewMode?: boolean;
    currentUid?: string | null;
  }
): any {
  const isArg1Module = typeof arg1?.collection === 'function' && typeof arg1?.where === 'function';
  const firestoreModule = isArg1Module ? arg1 : arg2;
  const firestoreDb = isArg1Module ? arg2 : arg1;

  const workspaceId = String(options?.workspaceId || 'ws_default').trim() || 'ws_default';
  const personalViewMode = Boolean(options?.personalViewMode ?? false);
  const currentUid = options?.currentUid ? String(options.currentUid).trim() : '';

  const txCollection = firestoreModule.collection(firestoreDb, 'transactions');
  const constraints: any[] = [firestoreModule.where('workspaceId', '==', workspaceId)];

  if (personalViewMode && currentUid) {
    constraints.push(firestoreModule.where('createdByUid', '==', currentUid));
  }

  return firestoreModule.query(txCollection, ...constraints);
}

/**
 * Reads cached transactions for a given `workspaceId` from Local-First storage.
 */
export function readLocalWorkspaceTransactions(
  workspaceId: string,
  storageBackend?: Storage | null
): TransactionRecord[] {
  const storage = resolveStorage(storageBackend);
  if (!storage || !workspaceId) return [];

  try {
    const raw = storage.getItem(`${WORKSPACE_TRANSACTIONS_CACHE_PREFIX}${workspaceId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((tx) => createTransaction({ ...tx, workspaceId }) as TransactionRecord);
  } catch {
    return [];
  }
}

/**
 * Writes the transaction list for a given `workspaceId` to Local-First storage.
 */
export function writeLocalWorkspaceTransactions(
  workspaceId: string,
  transactions: ReadonlyArray<TransactionRecord>,
  storageBackend?: Storage | null
): void {
  const storage = resolveStorage(storageBackend);
  if (!storage || !workspaceId) return;

  try {
    const normalized = transactions.map((tx) =>
      createTransaction({
        ...tx,
        workspaceId: tx.workspaceId && tx.workspaceId !== 'ws_default' ? tx.workspaceId : workspaceId,
      })
    );
    storage.setItem(
      `${WORKSPACE_TRANSACTIONS_CACHE_PREFIX}${workspaceId}`,
      JSON.stringify(normalized)
    );
  } catch {
    // Ignore quota errors
  }
}

/**
 * Merges multiple transaction arrays by `id`, preserving newest `updatedAt`/`createdAt` and sorting descending by date.
 */
export function mergeWorkspaceTransactions(
  ...lists: ReadonlyArray<ReadonlyArray<TransactionRecord>>
): TransactionRecord[] {
  const byId = new Map<string, TransactionRecord>();

  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const rawTx of list) {
      if (!rawTx || !rawTx.id) continue;
      const normalized = createTransaction(rawTx) as TransactionRecord;
      byId.set(normalized.id, normalized);
    }
  }

  return Array.from(byId.values()).sort((a, b) => {
    if (b.date !== a.date) return String(b.date).localeCompare(String(a.date));
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
}

/**
 * Filters a merged workspace transaction list according to `workspaceId` and `personalViewMode`:
 * - `personalViewMode === false`: returns ALL transactions in `workspaceId` regardless of `createdByUid`.
 * - `personalViewMode === true`: returns ONLY transactions in `workspaceId` where `createdByUid === currentUid`.
 */
export function filterWorkspaceTransactions(
  transactions: ReadonlyArray<TransactionRecord>,
  options: {
    workspaceId: string;
    personalViewMode?: boolean;
    currentUid?: string | null;
  }
): TransactionRecord[] {
  const workspaceId = String(options.workspaceId || 'ws_default').trim() || 'ws_default';
  const personalViewMode = Boolean(options.personalViewMode ?? false);
  const currentUid = options.currentUid ? String(options.currentUid).trim() : '';

  return (transactions || []).filter((tx) => {
    const txWs = String(tx.workspaceId || 'ws_default');
    if (txWs !== workspaceId) return false;

    if (personalViewMode && currentUid) {
      const creator = String(tx.createdByUid || tx.ownerUid || '');
      return creator === currentUid;
    }

    return true;
  });
}

/**
 * One-shot fetch (`getDocs`) for transactions belonging to `workspaceId`.
 * Queries `where("workspaceId", "==", workspaceId)` (and `where("createdByUid", "==", currentUid)` only if `personalViewMode` is active).
 */
export async function fetchWorkspaceTransactions(
  options: WorkspaceTransactionQueryOptions
): Promise<WorkspaceTransactionsResult> {
  const workspaceId = String(options.workspaceId || 'ws_default').trim() || 'ws_default';
  const personalViewMode = Boolean(options.personalViewMode ?? false);
  const currentUid = options.currentUid ?? null;
  const storage = resolveStorage(options.storage);

  const localWorkspaceTxs = readLocalWorkspaceTransactions(workspaceId, storage);
  const matchingSeedTxs = (options.seedTransactions || []).filter(
    (tx) => (tx.workspaceId || 'ws_default') === workspaceId
  );

  let remoteTxs: TransactionRecord[] = [];

  if (options.firestoreDb && options.firestoreModule) {
    try {
      const q = buildWorkspaceTransactionsQuery(options.firestoreModule, options.firestoreDb, {
        workspaceId,
        personalViewMode,
        currentUid,
      });
      const snap = await options.firestoreModule.getDocs(q);
      remoteTxs = extractSnapshotDocs(snap, workspaceId);
    } catch (err) {
      console.warn('[TransactionsService] Fallback Local-First en getDocs(workspaceId):', err);
    }
  }

  const allWorkspaceTransactions = mergeWorkspaceTransactions(
    matchingSeedTxs,
    localWorkspaceTxs,
    remoteTxs
  );

  writeLocalWorkspaceTransactions(workspaceId, allWorkspaceTransactions, storage);

  const visibleTransactions = filterWorkspaceTransactions(allWorkspaceTransactions, {
    workspaceId,
    personalViewMode,
    currentUid,
  });

  return attachResultProps(visibleTransactions, allWorkspaceTransactions);
}

/**
 * Realtime listener (`onSnapshot`) for transactions belonging to `currentUserProfile.workspaceId`.
 * - Queries `where("workspaceId", "==", currentUserProfile.workspaceId)`.
 * - If `personalViewMode` is `false`, streams ALL transactions of the family workspace regardless of who created them.
 * - If `personalViewMode` is `true`, filters by `createdByUid == currentUser.uid`.
 * Returns an `unsubscribe` function.
 */
export function subscribeWorkspaceTransactions(
  options: WorkspaceTransactionQueryOptions,
  onUpdate: (payload: WorkspaceTransactionsResult) => void
): () => void {
  const workspaceId = String(options.workspaceId || 'ws_default').trim() || 'ws_default';
  const personalViewMode = Boolean(options.personalViewMode ?? false);
  const currentUid = options.currentUid ?? null;
  const storage = resolveStorage(options.storage);

  let unsubscribed = false;
  let firestoreUnsubscribe: (() => void) | null = null;

  const emitLocalSnapshot = () => {
    if (unsubscribed) return;
    const localWorkspaceTxs = readLocalWorkspaceTransactions(workspaceId, storage);
    const matchingSeedTxs = (options.seedTransactions || []).filter(
      (tx) => (tx.workspaceId || 'ws_default') === workspaceId
    );
    const allWorkspaceTransactions = mergeWorkspaceTransactions(matchingSeedTxs, localWorkspaceTxs);
    writeLocalWorkspaceTransactions(workspaceId, allWorkspaceTransactions, storage);
    const visibleTransactions = filterWorkspaceTransactions(allWorkspaceTransactions, {
      workspaceId,
      personalViewMode,
      currentUid,
    });
    onUpdate(attachResultProps(visibleTransactions, allWorkspaceTransactions));
  };

  // Emit immediate Local-First state so UI is responsive with 0 latency
  emitLocalSnapshot();

  // Attach Firestore realtime `onSnapshot` listener when Firestore SDK is active
  if (
    options.firestoreDb &&
    options.firestoreModule &&
    typeof options.firestoreModule.onSnapshot === 'function'
  ) {
    try {
      const q = buildWorkspaceTransactionsQuery(options.firestoreModule, options.firestoreDb, {
        workspaceId,
        personalViewMode,
        currentUid,
      });

      firestoreUnsubscribe = options.firestoreModule.onSnapshot(
        q,
        (snapshot: any) => {
          if (unsubscribed) return;
          const remoteTxs = extractSnapshotDocs(snapshot, workspaceId);

          const localWorkspaceTxs = readLocalWorkspaceTransactions(workspaceId, storage);
          const allWorkspaceTransactions = mergeWorkspaceTransactions(localWorkspaceTxs, remoteTxs);
          writeLocalWorkspaceTransactions(workspaceId, allWorkspaceTransactions, storage);

          const visibleTransactions = filterWorkspaceTransactions(allWorkspaceTransactions, {
            workspaceId,
            personalViewMode,
            currentUid,
          });
          onUpdate(attachResultProps(visibleTransactions, allWorkspaceTransactions));
        },
        (err: unknown) => {
          console.warn('[TransactionsService] Fallback Local-First en onSnapshot(workspaceId):', err);
        }
      );
    } catch (err) {
      console.warn('[TransactionsService] No se pudo iniciar onSnapshot:', err);
    }
  }

  return () => {
    unsubscribed = true;
    if (typeof firestoreUnsubscribe === 'function') {
      firestoreUnsubscribe();
    }
  };
}

/**
 * Persists a new or edited transaction to both the Local-First workspace cache and Firestore `transactions/{tx.id}`,
 * ensuring `workspaceId`, `createdByUid`, and `createdByEmail` are always attached.
 */
export async function saveTransactionToWorkspace(
  txInput: Partial<TransactionRecord> & { amount: number | string },
  contextOrUser?: any,
  maybeProfile?: UserProfile | null,
  maybeFirestoreCtx?: {
    workspaceId?: string;
    firestoreDb?: any;
    firestoreModule?: any;
    storage?: Storage | null;
  }
): Promise<TransactionRecord> {
  const isPositional =
    maybeProfile !== undefined ||
    maybeFirestoreCtx !== undefined ||
    (contextOrUser && 'uid' in contextOrUser && !('currentUser' in contextOrUser));

  const context = isPositional
    ? {
        currentUser: contextOrUser as AuthUser | null,
        currentProfile: maybeProfile ?? null,
        ...(maybeFirestoreCtx || {}),
      }
    : (contextOrUser || {});

  const storage = resolveStorage(context.storage);
  const fallbackWs = context.workspaceId || context.currentProfile?.workspaceId || 'ws_default';
  const tx = prepareTransactionForWorkspace(
    txInput,
    context.currentUser,
    context.currentProfile,
    fallbackWs
  );

  // 1. Update Local-First workspace cache immediately
  const existing = readLocalWorkspaceTransactions(tx.workspaceId || fallbackWs, storage);
  const merged = mergeWorkspaceTransactions(existing, [tx]);
  writeLocalWorkspaceTransactions(tx.workspaceId || fallbackWs, merged, storage);

  // 2. Persist to Firestore `transactions/{tx.id}` if connected
  if (context.firestoreDb && context.firestoreModule) {
    try {
      const txDocRef = context.firestoreModule.doc(context.firestoreDb, 'transactions', tx.id);
      await context.firestoreModule.setDoc(txDocRef, tx, { merge: true });
    } catch (err) {
      console.warn('[TransactionsService] Guardado en caché local de workspace (Firestore offline):', err);
    }
  }

  return tx;
}

/**
 * Deletes a transaction from both the Local-First workspace cache and Firestore `transactions/{txId}`.
 */
export async function deleteTransactionFromWorkspace(
  txId: string,
  workspaceIdOrContext:
    | string
    | {
        workspaceId: string;
        firestoreDb?: any;
        firestoreModule?: any;
        storage?: Storage | null;
      },
  maybeFirestoreCtx?: {
    firestoreDb?: any;
    firestoreModule?: any;
    storage?: Storage | null;
  }
): Promise<void> {
  if (!txId) return;
  const context =
    typeof workspaceIdOrContext === 'string'
      ? { workspaceId: workspaceIdOrContext, ...(maybeFirestoreCtx || {}) }
      : workspaceIdOrContext || { workspaceId: 'ws_default' };

  const storage = resolveStorage(context.storage);
  const workspaceId = String(context.workspaceId || 'ws_default').trim() || 'ws_default';

  const existing = readLocalWorkspaceTransactions(workspaceId, storage);
  const remaining = existing.filter((t) => t.id !== txId);
  writeLocalWorkspaceTransactions(workspaceId, remaining, storage);

  if (context.firestoreDb && context.firestoreModule && typeof context.firestoreModule.deleteDoc === 'function') {
    try {
      const txDocRef = context.firestoreModule.doc(context.firestoreDb, 'transactions', txId);
      await context.firestoreModule.deleteDoc(txDocRef);
    } catch (err) {
      console.warn('[TransactionsService] Eliminado localmente (Firestore offline):', err);
    }
  }
}

/**
 * Migrates transactions belonging to `memberUids` or previous workspaces (`oldWorkspaceIds`) into `targetWorkspaceId`
 * when family members link their financial space ("Compartir Finanzas").
 */
export async function migrateTransactionsToSharedWorkspace(
  paramsOrTargetWs:
    | string
    | {
        targetWorkspaceId: string;
        memberUids: string[];
        oldWorkspaceIds?: string[];
        localTransactions?: TransactionRecord[];
        firestoreDb?: any;
        firestoreModule?: any;
        storage?: Storage | null;
      },
  maybeMemberUids?: string[],
  maybeOldWorkspaceIds?: string[],
  maybeStorage?: Storage | null,
  maybeFirestoreDb?: any,
  maybeFirestoreModule?: any
): Promise<TransactionRecord[]> {
  const params =
    typeof paramsOrTargetWs === 'string'
      ? {
          targetWorkspaceId: paramsOrTargetWs,
          memberUids: maybeMemberUids || [],
          oldWorkspaceIds: maybeOldWorkspaceIds || [],
          storage: maybeStorage,
          firestoreDb: maybeFirestoreDb,
          firestoreModule: maybeFirestoreModule,
        }
      : paramsOrTargetWs;

  const storage = resolveStorage(params.storage);
  const targetWorkspaceId = String(params.targetWorkspaceId || '').trim();
  if (!targetWorkspaceId) return params.localTransactions || [];

  const memberUidSet = new Set((params.memberUids || []).filter(Boolean));
  const oldWsSet = new Set(['ws_default', ...(params.oldWorkspaceIds || []).filter(Boolean)]);

  const collectedFromOldWorkspaces: TransactionRecord[] = [];
  for (const oldWs of oldWsSet) {
    const oldTxs = readLocalWorkspaceTransactions(oldWs, storage);
    for (const tx of oldTxs) {
      if (
        oldWs !== 'ws_default' ||
        memberUidSet.has(String(tx.createdByUid || tx.ownerUid || '')) ||
        tx.createdByUid === 'local_default_user'
      ) {
        collectedFromOldWorkspaces.push(
          createTransaction({ ...tx, workspaceId: targetWorkspaceId }) as TransactionRecord
        );
      }
    }
  }

  const updatedLocal = (params.localTransactions || []).map((tx) => {
    const creator = String(tx.createdByUid || tx.ownerUid || '');
    const txWs = String(tx.workspaceId || 'ws_default');
    if (memberUidSet.has(creator) || oldWsSet.has(txWs)) {
      return createTransaction({
        ...tx,
        workspaceId: targetWorkspaceId,
      }) as TransactionRecord;
    }
    return createTransaction(tx) as TransactionRecord;
  });

  const targetExisting = readLocalWorkspaceTransactions(targetWorkspaceId, storage);
  const allShared = mergeWorkspaceTransactions(
    targetExisting,
    collectedFromOldWorkspaces,
    updatedLocal.filter((tx) => tx.workspaceId === targetWorkspaceId)
  );
  writeLocalWorkspaceTransactions(targetWorkspaceId, allShared, storage);

  if (params.firestoreDb && params.firestoreModule) {
    for (const tx of allShared) {
      try {
        const txDocRef = params.firestoreModule.doc(params.firestoreDb, 'transactions', tx.id);
        await params.firestoreModule.setDoc(txDocRef, tx, { merge: true });
      } catch {
        // Ignore individual offline sync errors
      }
    }
  }

  return mergeWorkspaceTransactions(updatedLocal, allShared);
}
