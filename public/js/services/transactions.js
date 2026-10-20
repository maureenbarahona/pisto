/**
 * @fileoverview Workspace Transactions Data Service (ES Module companion `public/js/services/transactions.js`).
 *
 * Fixes shared family workspace synchronization:
 * 1. Firestore Query / Realtime Listener (`onSnapshot` & `getDocs`):
 *    - Queries `where("workspaceId", "==", currentUserProfile.workspaceId)` instead of restricting by `userId === auth.currentUser.uid`.
 *    - When `personalViewMode` is `false` (DESACTIVADO), fetches ALL transactions belonging to `workspaceId` regardless of creator.
 *    - When `personalViewMode` is `true` (ACTIVO), filters by `where("workspaceId", "==", workspaceId)` and `where("createdByUid", "==", currentUser.uid)`.
 * 2. Transaction Creation (`prepareTransactionForWorkspace` / `saveTransactionToWorkspace`):
 *    - Always attaches `workspaceId` (from `currentUserProfile.workspaceId`), `createdByUid` (`currentUser.uid`), and `createdByEmail` (`currentUser.email`).
 */

import { createTransaction } from '../domain/models.js';

export const WORKSPACE_TRANSACTIONS_CACHE_PREFIX = 'pisto_workspace_transactions_v1_';

function resolveStorage(customStorage) {
  if (customStorage !== undefined) return customStorage;
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

function attachResultProps(visibleTransactions, allWorkspaceTransactions) {
  const arr = [...visibleTransactions];
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

function extractSnapshotDocs(snap, workspaceId) {
  const docs = [];
  if (!snap) return docs;
  if (typeof snap.forEach === 'function') {
    snap.forEach((docSnap) => {
      const data = typeof docSnap.data === 'function' ? docSnap.data() : docSnap;
      docs.push(createTransaction({ ...data, id: docSnap.id || data.id, workspaceId }));
    });
  } else if (Array.isArray(snap.docs)) {
    for (const docSnap of snap.docs) {
      const data = typeof docSnap.data === 'function' ? docSnap.data() : docSnap;
      docs.push(createTransaction({ ...data, id: docSnap.id || data.id, workspaceId }));
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
  txInput,
  currentUser,
  currentUserProfile,
  fallbackWorkspaceId = 'ws_default'
) {
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
  });
}

/**
 * Builds the Firestore query for `transactions`:
 * - Always queries `where("workspaceId", "==", currentUserProfile.workspaceId)`
 * - If `personalViewMode` is `false` (DESACTIVADO), brings ALL transactions belonging to `workspaceId` regardless of creator.
 * - If `personalViewMode` is `true` (ACTIVO) and `currentUid` is present, adds `where("createdByUid", "==", currentUid)`.
 */
export function buildWorkspaceTransactionsQuery(arg1, arg2, options) {
  const isArg1Module = typeof arg1?.collection === 'function' && typeof arg1?.where === 'function';
  const firestoreModule = isArg1Module ? arg1 : arg2;
  const firestoreDb = isArg1Module ? arg2 : arg1;

  const workspaceId = String(options?.workspaceId || 'ws_default').trim() || 'ws_default';
  const personalViewMode = Boolean(options?.personalViewMode ?? false);
  const currentUid = options?.currentUid ? String(options.currentUid).trim() : '';

  const txCollection = firestoreModule.collection(firestoreDb, 'transactions');
  const constraints = [firestoreModule.where('workspaceId', '==', workspaceId)];

  if (personalViewMode && currentUid) {
    constraints.push(firestoreModule.where('createdByUid', '==', currentUid));
  }

  return firestoreModule.query(txCollection, ...constraints);
}

export function readLocalWorkspaceTransactions(workspaceId, storageBackend) {
  const storage = resolveStorage(storageBackend);
  if (!storage || !workspaceId) return [];

  try {
    const raw = storage.getItem(`${WORKSPACE_TRANSACTIONS_CACHE_PREFIX}${workspaceId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((tx) => createTransaction({ ...tx, workspaceId }));
  } catch {
    return [];
  }
}

export function writeLocalWorkspaceTransactions(workspaceId, transactions, storageBackend) {
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

export function mergeWorkspaceTransactions(...lists) {
  const byId = new Map();

  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const rawTx of list) {
      if (!rawTx || !rawTx.id) continue;
      const normalized = createTransaction(rawTx);
      byId.set(normalized.id, normalized);
    }
  }

  return Array.from(byId.values()).sort((a, b) => {
    if (b.date !== a.date) return String(b.date).localeCompare(String(a.date));
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
}

export function filterWorkspaceTransactions(transactions, options) {
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

export async function fetchWorkspaceTransactions(options) {
  const workspaceId = String(options.workspaceId || 'ws_default').trim() || 'ws_default';
  const personalViewMode = Boolean(options.personalViewMode ?? false);
  const currentUid = options.currentUid ?? null;
  const storage = resolveStorage(options.storage);

  const localWorkspaceTxs = readLocalWorkspaceTransactions(workspaceId, storage);
  const matchingSeedTxs = (options.seedTransactions || []).filter(
    (tx) => (tx.workspaceId || 'ws_default') === workspaceId
  );

  let remoteTxs = [];

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

export function subscribeWorkspaceTransactions(options, onUpdate) {
  const workspaceId = String(options.workspaceId || 'ws_default').trim() || 'ws_default';
  const personalViewMode = Boolean(options.personalViewMode ?? false);
  const currentUid = options.currentUid ?? null;
  const storage = resolveStorage(options.storage);

  let unsubscribed = false;
  let firestoreUnsubscribe = null;

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

  emitLocalSnapshot();

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
        (snapshot) => {
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
        (err) => {
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

export async function saveTransactionToWorkspace(
  txInput,
  contextOrUser,
  maybeProfile,
  maybeFirestoreCtx
) {
  const isPositional =
    maybeProfile !== undefined ||
    maybeFirestoreCtx !== undefined ||
    (contextOrUser && 'uid' in contextOrUser && !('currentUser' in contextOrUser));

  const context = isPositional
    ? {
        currentUser: contextOrUser || null,
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

  const existing = readLocalWorkspaceTransactions(tx.workspaceId || fallbackWs, storage);
  const merged = mergeWorkspaceTransactions(existing, [tx]);
  writeLocalWorkspaceTransactions(tx.workspaceId || fallbackWs, merged, storage);

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

export async function deleteTransactionFromWorkspace(
  txId,
  workspaceIdOrContext,
  maybeFirestoreCtx
) {
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

export async function migrateTransactionsToSharedWorkspace(
  paramsOrTargetWs,
  maybeMemberUids,
  maybeOldWorkspaceIds,
  maybeStorage,
  maybeFirestoreDb,
  maybeFirestoreModule
) {
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

  const collectedFromOldWorkspaces = [];
  for (const oldWs of oldWsSet) {
    const oldTxs = readLocalWorkspaceTransactions(oldWs, storage);
    for (const tx of oldTxs) {
      if (
        oldWs !== 'ws_default' ||
        memberUidSet.has(String(tx.createdByUid || tx.ownerUid || '')) ||
        tx.createdByUid === 'local_default_user'
      ) {
        collectedFromOldWorkspaces.push(
          createTransaction({ ...tx, workspaceId: targetWorkspaceId })
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
      });
    }
    return createTransaction(tx);
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

/**
 * Returns all transactions associated with `accountId` (either as origin `accountId` or transfer destination `toAccountId`).
 */
export function getTransactionsByAccountId(transactions, accountId) {
  const cleanId = String(accountId || '').trim();
  if (!cleanId || !Array.isArray(transactions)) return [];
  return transactions.filter((tx) => tx.accountId === cleanId || tx.toAccountId === cleanId);
}

/**
 * Executes an atomic Firestore `writeBatch` to delete the account document from `accounts/{accountId}`
 * AND cascade-delete all documents in `transactions` where `accountId === idDeLaCuenta` (plus local state/cache cleanup).
 */
export async function deleteAccountAndTransactionsWriteBatch(accountId, options = {}) {
  const cleanAccountId = String(accountId || '').trim();
  if (!cleanAccountId) {
    throw new Error('Se requiere un ID de cuenta válido para eliminar en cascada.');
  }

  const storage = resolveStorage(options.storage);
  const workspaceId = String(options.workspaceId || 'ws_default').trim() || 'ws_default';
  const localTxs = Array.isArray(options.transactions) ? [...options.transactions] : [];
  const cachedWsTxs = readLocalWorkspaceTransactions(workspaceId, storage);

  const deletedTxIdSet = new Set();
  for (const tx of [...localTxs, ...cachedWsTxs]) {
    if (tx && tx.id && (tx.accountId === cleanAccountId || tx.toAccountId === cleanAccountId)) {
      deletedTxIdSet.add(tx.id);
    }
  }

  let batchCommitted = false;

  if (
    options.firestoreDb &&
    options.firestoreModule &&
    typeof options.firestoreModule.writeBatch === 'function' &&
    typeof options.firestoreModule.doc === 'function'
  ) {
    try {
      const { firestoreDb, firestoreModule } = options;
      const batch = firestoreModule.writeBatch(firestoreDb);

      // 1. Delete account document from `accounts/{accountId}`
      const accountRef = firestoreModule.doc(firestoreDb, 'accounts', cleanAccountId);
      batch.delete(accountRef);

      // 2. Query Firestore `transactions` where `accountId === idDeLaCuenta`
      if (
        typeof firestoreModule.collection === 'function' &&
        typeof firestoreModule.query === 'function' &&
        typeof firestoreModule.where === 'function' &&
        typeof firestoreModule.getDocs === 'function'
      ) {
        const txCol = firestoreModule.collection(firestoreDb, 'transactions');
        const q = firestoreModule.query(
          txCol,
          firestoreModule.where('accountId', '==', cleanAccountId)
        );
        const snap = await firestoreModule.getDocs(q);
        if (snap) {
          if (typeof snap.forEach === 'function') {
            snap.forEach((docSnap) => {
              const txId = docSnap?.id || docSnap?.data?.()?.id;
              if (txId) deletedTxIdSet.add(txId);
              const ref =
                docSnap?.ref || firestoreModule.doc(firestoreDb, 'transactions', txId);
              if (ref) batch.delete(ref);
            });
          } else if (Array.isArray(snap.docs)) {
            for (const docSnap of snap.docs) {
              const txId = docSnap?.id || docSnap?.data?.()?.id;
              if (txId) deletedTxIdSet.add(txId);
              const ref =
                docSnap?.ref || firestoreModule.doc(firestoreDb, 'transactions', txId);
              if (ref) batch.delete(ref);
            }
          }
        }
      }

      // Ensure any known local transaction IDs for this account are also queued in the batch
      for (const txId of deletedTxIdSet) {
        const txRef = firestoreModule.doc(firestoreDb, 'transactions', txId);
        batch.delete(txRef);
      }

      await batch.commit();
      batchCommitted = true;
    } catch (err) {
      console.warn(
        '[TransactionsService] Fallback Local-First en writeBatch de eliminación en cascada:',
        err
      );
    }
  }

  // 3. Clean up Local-First workspace cache
  const remainingCached = cachedWsTxs.filter(
    (tx) =>
      tx.accountId !== cleanAccountId &&
      tx.toAccountId !== cleanAccountId &&
      !deletedTxIdSet.has(tx.id)
  );
  writeLocalWorkspaceTransactions(workspaceId, remainingCached, storage);

  const remainingTransactions = localTxs.filter(
    (tx) =>
      tx.accountId !== cleanAccountId &&
      tx.toAccountId !== cleanAccountId &&
      !deletedTxIdSet.has(tx.id)
  );

  const deletedTransactionIds = Array.from(deletedTxIdSet);

  return {
    deletedAccountId: cleanAccountId,
    deletedTransactionIds,
    deletedCount: deletedTransactionIds.length,
    remainingTransactions,
    batchCommitted,
  };
}
