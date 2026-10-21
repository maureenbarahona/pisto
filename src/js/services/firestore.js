/**
 * @fileoverview Servicio unificado de Firestore y Firebase Web SDK (Vanilla ESNext).
 *
 * Implementa:
 * 1. Esquema de colecciones normalizado en Firestore (`accounts`, `transactions`, `workspaces`, `users`).
 * 2. Operaciones de lectura/escritura eficientes con cursores ligeros (`limit`, `startAfter`, paginación por cursor)
 *    para minimizar uso de CPU, memoria en cliente y consumo de tokens.
 * 3. Motor de Deduplicación Inteligente de Transacciones:
 *    - Criterio de coincidencia: Misma `accountId` + Misma `date` + Mismo `amount` + Concepto/Comercio similar (`concept`).
 *    - Mensaje de advertencia estandarizado:
 *      `"⚠️ Posible transacción duplicada detectada (Monto: L X.XX, Fecha: DD/MM/YYYY, Comercio: X)"`
 *    - Resolución con las 3 opciones explícitas del usuario:
 *      a) `"✏️ Sobreescribir / Actualizar Transacción Existente"` (`overwrite`)
 *      b) `"➕ Crear como Nueva Transacción"` (`create_new`)
 *      c) `"🚫 Omitir"` (`skip`)
 */

import {
  Money,
  createAccount,
  createTransaction,
  isAccountArchived,
  getActiveAccounts,
} from '../../../public/js/domain/models.js';
import {
  CUSTOM_FIREBASE_CONFIG_STORAGE_KEY,
  LEGACY_FIREBASE_CONFIG_STORAGE_KEY,
  defaultFirebaseConfig,
  getDefaultFirebaseConfig,
  isValidFirebaseConfig,
  normalizeFirebaseConfig,
  getCustomFirebaseConfig,
  getFirebaseConfigSource,
  getFirebaseConfig,
  isLiveFirebaseCredentials,
  registerFirebaseSdkAdapter,
  getApps,
  getApp,
  initializeFirebaseApp,
  onFirebaseConfigUpdated,
  updateFirebaseConfig,
} from '../../../public/js/services/firebase.js';
import {
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
} from '../../../public/js/services/transactions.js';
import {
  filterActiveAccounts,
  filterArchivedAccounts,
  filterAccountsForView,
  saveAccountToFirestore,
  archiveAccount,
  unarchiveAccount,
  deleteAccountWithCascade,
} from '../../../public/js/services/accounts.js';
import {
  FirebaseAuthProfileService,
  GeminiKeyLocalStore,
  SUPPORTED_COUNTRIES,
  createUserProfile,
  shouldTriggerOnboarding,
  ensureCleanWorkspaceForFirstTimeUser,
  completeUserOnboarding,
  buildWorkspaceTransactionIndex,
  filterTransactionsForUserView,
} from '../../../public/js/services/authProfileService.js';
import { createCleanWorkspaceState } from '../../../public/js/repositories/storageRepository.js';
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
} from './dashboard.js';

export {
  CUSTOM_FIREBASE_CONFIG_STORAGE_KEY,
  LEGACY_FIREBASE_CONFIG_STORAGE_KEY,
  defaultFirebaseConfig,
  getDefaultFirebaseConfig,
  isValidFirebaseConfig,
  normalizeFirebaseConfig,
  getCustomFirebaseConfig,
  getFirebaseConfigSource,
  getFirebaseConfig,
  isLiveFirebaseCredentials,
  registerFirebaseSdkAdapter,
  getApps,
  getApp,
  initializeFirebaseApp,
  onFirebaseConfigUpdated,
  updateFirebaseConfig,
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
  isAccountArchived,
  getActiveAccounts,
  filterActiveAccounts,
  filterArchivedAccounts,
  filterAccountsForView,
  saveAccountToFirestore,
  archiveAccount,
  unarchiveAccount,
  deleteAccountWithCascade,
  FirebaseAuthProfileService,
  GeminiKeyLocalStore,
  SUPPORTED_COUNTRIES,
  createUserProfile,
  shouldTriggerOnboarding,
  ensureCleanWorkspaceForFirstTimeUser,
  completeUserOnboarding,
  createCleanWorkspaceState,
  buildWorkspaceTransactionIndex,
  filterTransactionsForUserView,
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

/**
 * Colecciones normalizadas en Firestore para minimizar lecturas redundantes y memoria en cliente.
 */
export const FIRESTORE_COLLECTIONS = Object.freeze({
  ACCOUNTS: 'accounts',
  TRANSACTIONS: 'transactions',
  WORKSPACES: 'workspaces',
  USERS: 'users',
});

export const DEFAULT_CURSOR_PAGE_SIZE = 25;

/**
 * Opciones explícitas de resolución para el Modal/Banner de Deduplicación Inteligente.
 */
export const DUPLICATE_TRANSACTION_ACTIONS = Object.freeze({
  OVERWRITE: 'overwrite',
  CREATE_NEW: 'create_new',
  SKIP: 'skip',
});

export const DUPLICATE_TRANSACTION_OPTION_LABELS = Object.freeze({
  OVERWRITE: '✏️ Sobreescribir / Actualizar Transacción Existente',
  CREATE_NEW: '➕ Crear como Nueva Transacción',
  SKIP: '🚫 Omitir',
});

/**
 * Normaliza un documento antes de persistirlo en Firestore para evitar campos vacíos o redundantes.
 * @param {'accounts'|'transactions'|'workspaces'|'users'} collectionName
 * @param {object} rawDoc
 */
export function normalizeFirestoreDocument(collectionName, rawDoc = {}) {
  const nowIso = new Date().toISOString();
  if (collectionName === FIRESTORE_COLLECTIONS.ACCOUNTS) {
    return createAccount({
      ...rawDoc,
      updatedAt: rawDoc.updatedAt || nowIso,
    });
  }
  if (collectionName === FIRESTORE_COLLECTIONS.TRANSACTIONS) {
    return createTransaction({
      ...rawDoc,
      updatedAt: rawDoc.updatedAt || nowIso,
    });
  }
  const cleaned = {};
  for (const [key, value] of Object.entries(rawDoc)) {
    if (value !== undefined) {
      cleaned[key] = value;
    }
  }
  if (!cleaned.updatedAt) {
    cleaned.updatedAt = nowIso;
  }
  return cleaned;
}

/**
 * Construye y ejecuta una consulta paginada con cursores ligeros (`limit` + `startAfter`)
 * para minimizar lecturas de Firestore, uso de CPU y memoria en el cliente.
 *
 * @param {object} options
 * @param {string} options.collectionName
 * @param {string} [options.workspaceId]
 * @param {string} [options.accountId]
 * @param {number} [options.pageSize]
 * @param {any} [options.cursor]
 * @param {any} [options.firestoreDb]
 * @param {any} [options.firestoreModule]
 * @param {Array<object>} [options.localFallbackItems]
 */
export async function queryCollectionWithCursor(options = {}) {
  const {
    collectionName = FIRESTORE_COLLECTIONS.TRANSACTIONS,
    workspaceId = 'ws_default',
    accountId = '',
    pageSize = DEFAULT_CURSOR_PAGE_SIZE,
    cursor = null,
    firestoreDb = null,
    firestoreModule = null,
    localFallbackItems = [],
  } = options;

  const safeLimit = Math.max(1, Math.min(100, Number.parseInt(String(pageSize), 10) || DEFAULT_CURSOR_PAGE_SIZE));

  if (
    firestoreDb &&
    firestoreModule &&
    typeof firestoreModule.collection === 'function' &&
    typeof firestoreModule.query === 'function' &&
    typeof firestoreModule.getDocs === 'function'
  ) {
    try {
      const colRef = firestoreModule.collection(firestoreDb, collectionName);
      const constraints = [];

      if (workspaceId && typeof firestoreModule.where === 'function') {
        constraints.push(firestoreModule.where('workspaceId', '==', workspaceId));
      }
      if (accountId && typeof firestoreModule.where === 'function') {
        constraints.push(firestoreModule.where('accountId', '==', accountId));
      }
      if (typeof firestoreModule.orderBy === 'function') {
        constraints.push(firestoreModule.orderBy('date', 'desc'));
      }
      if (cursor && typeof firestoreModule.startAfter === 'function') {
        constraints.push(firestoreModule.startAfter(cursor));
      }
      if (typeof firestoreModule.limit === 'function') {
        constraints.push(firestoreModule.limit(safeLimit));
      }

      const q = firestoreModule.query(colRef, ...constraints);
      const snap = await firestoreModule.getDocs(q);
      const docs = Array.isArray(snap?.docs) ? snap.docs : [];
      const items = docs.map((d) => {
        const data = typeof d.data === 'function' ? d.data() : d;
        return normalizeFirestoreDocument(collectionName, { ...data, id: d.id || data.id });
      });
      const nextCursor = docs.length === safeLimit ? docs[docs.length - 1] : null;
      return {
        items,
        nextCursor,
        hasMore: Boolean(nextCursor),
        source: 'firestore-cursor',
      };
    } catch {
      // Fallback to local cursor pagination when offline
    }
  }

  const filtered = (Array.isArray(localFallbackItems) ? localFallbackItems : []).filter((item) => {
    if (workspaceId && item.workspaceId && item.workspaceId !== workspaceId) return false;
    if (accountId && item.accountId !== accountId) return false;
    return true;
  });

  let startIndex = 0;
  if (cursor) {
    const cursorId = typeof cursor === 'string' ? cursor : cursor?.id;
    const foundIdx = filtered.findIndex((it) => it.id === cursorId);
    if (foundIdx !== -1) {
      startIndex = foundIdx + 1;
    }
  }

  const slice = filtered.slice(startIndex, startIndex + safeLimit);
  const lastItem = slice.length === safeLimit ? slice[slice.length - 1] : null;

  return {
    items: slice,
    nextCursor: lastItem ? lastItem.id : null,
    hasMore: Boolean(lastItem && startIndex + safeLimit < filtered.length),
    source: 'local-cursor',
  };
}

/**
 * Normaliza un concepto o nombre de comercio para comparación semántica ligera (0 tokens).
 * @param {string} rawConcept
 * @returns {string}
 */
export function normalizeTransactionConcept(rawConcept = '') {
  return String(rawConcept || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(compra|pago|pos|tarjeta|ref|referencia|debito|credito|movimiento|bancario|en|de|el|la|los|las|con|por)\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Determina si dos conceptos/comercios de transacción son similares o equivalentes.
 * @param {string} conceptA
 * @param {string} conceptB
 * @returns {boolean}
 */
export function isSimilarTransactionConcept(conceptA = '', conceptB = '') {
  const normA = normalizeTransactionConcept(conceptA);
  const normB = normalizeTransactionConcept(conceptB);

  if (!normA && !normB) return true;
  if (!normA || !normB) return false;
  if (normA === normB) return true;
  if (normA.includes(normB) || normB.includes(normA)) return true;

  const tokensA = normA.split(' ').filter((t) => t.length >= 2);
  const tokensB = normB.split(' ').filter((t) => t.length >= 2);
  if (tokensA.length === 0 || tokensB.length === 0) {
    return normA.slice(0, 5) === normB.slice(0, 5);
  }

  const setB = new Set(tokensB);
  let shared = 0;
  for (const token of tokensA) {
    if (setB.has(token) || tokensB.some((b) => b.includes(token) || token.includes(b))) {
      shared += 1;
    }
  }

  const minLen = Math.min(tokensA.length, tokensB.length);
  return shared / minLen >= 0.5;
}

/**
 * Convierte una fecha ISO (`YYYY-MM-DD`) o `DD/MM/YYYY` al formato de presentación `DD/MM/YYYY`.
 * @param {string} rawDate
 * @returns {string}
 */
export function formatDateDdMmYyyy(rawDate = '') {
  const clean = String(rawDate || '').trim();
  const isoMatch = clean.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return `${isoMatch[3]}/${isoMatch[2]}/${isoMatch[1]}`;
  }
  const dmyMatch = clean.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (dmyMatch) {
    return `${dmyMatch[1].padStart(2, '0')}/${dmyMatch[2].padStart(2, '0')}/${dmyMatch[3]}`;
  }
  return clean || '01/01/2026';
}

/**
 * Genera el mensaje estandarizado de advertencia de transacción duplicada:
 * `"⚠️ Posible transacción duplicada detectada (Monto: L X.XX, Fecha: DD/MM/YYYY, Comercio: X)"`
 *
 * @param {object} txCandidate
 * @returns {string}
 */
export function formatDuplicateTransactionWarning(txCandidate = {}) {
  const amountNum = Number(txCandidate.amount) || 0;
  const formattedAmount = amountNum.toFixed(2);
  const currency = String(txCandidate.currency || 'HNL').toUpperCase();
  const symbol = currency === 'USD' ? '$' : 'L';
  const formattedDate = formatDateDdMmYyyy(txCandidate.date);
  const concept = String(
    txCandidate.concept || txCandidate.note || txCandidate.merchant || 'Comercio'
  ).trim() || 'Comercio';

  return `⚠️ Posible transacción duplicada detectada (Monto: ${symbol} ${formattedAmount}, Fecha: ${formattedDate}, Comercio: ${concept})`;
}

/**
 * Busca transacciones existentes duplicadas para una cuenta específica (`accountId`).
 * Criterio estricto de coincidencia:
 * - Misma `accountId`
 * - Misma `date` (normalizada a `YYYY-MM-DD`)
 * - Mismo `amount` (en centavos exactos)
 * - Concepto/comercio similar (`concept` / `note`)
 *
 * @param {object} candidateTx
 * @param {Array<object>} existingTransactions
 * @param {string} [explicitAccountId]
 */
export function findAccountDuplicateTransactions(
  candidateTx,
  existingTransactions = [],
  explicitAccountId = ''
) {
  if (!candidateTx || !Array.isArray(existingTransactions)) {
    return {
      isDuplicate: false,
      duplicateTransaction: null,
      matches: [],
      warningMessage: '',
    };
  }

  const targetAccountId = String(explicitAccountId || candidateTx.accountId || '').trim();
  const targetDate = String(candidateTx.date || '').trim().slice(0, 10);
  const targetCents = Money.toCents(Math.abs(Number(candidateTx.amount) || 0));
  const targetConcept = String(
    candidateTx.concept || candidateTx.note || candidateTx.merchant || ''
  ).trim();

  if (!targetAccountId || !targetDate || targetCents <= 0) {
    return {
      isDuplicate: false,
      duplicateTransaction: null,
      matches: [],
      warningMessage: '',
    };
  }

  const matches = existingTransactions.filter((existing) => {
    if (!existing) return false;
    if (candidateTx.id && existing.id === candidateTx.id) return false;

    const existingAccountId = String(existing.accountId || '').trim();
    if (existingAccountId !== targetAccountId) return false;

    const existingDate = String(existing.date || '').trim().slice(0, 10);
    if (existingDate !== targetDate) return false;

    const existingCents = Money.toCents(Math.abs(Number(existing.amount) || 0));
    if (existingCents !== targetCents) return false;

    const existingConcept = String(existing.note || existing.concept || '').trim();
    return isSimilarTransactionConcept(targetConcept, existingConcept);
  });

  const duplicateTransaction = matches[0] || null;
  return {
    isDuplicate: Boolean(duplicateTransaction),
    duplicateTransaction,
    matches,
    warningMessage: duplicateTransaction
      ? formatDuplicateTransactionWarning({
          amount: candidateTx.amount,
          currency: candidateTx.currency || duplicateTransaction.currency || 'HNL',
          date: targetDate,
          concept: targetConcept || duplicateTransaction.note,
        })
      : '',
  };
}

/**
 * Consulta Firestore (con cursor/límite ligero) y el estado local para verificar
 * si una transacción a importar o registrar ya existe en la cuenta (`accountId`).
 *
 * @param {object} candidateTx
 * @param {object} [context]
 */
export async function checkAccountTransactionDuplicate(candidateTx, context = {}) {
  const targetAccountId = String(context.accountId || candidateTx?.accountId || '').trim();
  const localTransactions = Array.isArray(context.transactions) ? context.transactions : [];
  let combinedTransactions = [...localTransactions];

  if (
    targetAccountId &&
    context.firestoreDb &&
    context.firestoreModule &&
    typeof context.firestoreModule.collection === 'function' &&
    typeof context.firestoreModule.query === 'function' &&
    typeof context.firestoreModule.where === 'function' &&
    typeof context.firestoreModule.getDocs === 'function'
  ) {
    try {
      const txCol = context.firestoreModule.collection(
        context.firestoreDb,
        FIRESTORE_COLLECTIONS.TRANSACTIONS
      );
      const constraints = [
        context.firestoreModule.where('accountId', '==', targetAccountId),
      ];
      if (candidateTx?.date) {
        constraints.push(
          context.firestoreModule.where('date', '==', String(candidateTx.date).slice(0, 10))
        );
      }
      if (typeof context.firestoreModule.limit === 'function') {
        constraints.push(context.firestoreModule.limit(DEFAULT_CURSOR_PAGE_SIZE));
      }
      const q = context.firestoreModule.query(txCol, ...constraints);
      const snap = await context.firestoreModule.getDocs(q);
      if (snap && Array.isArray(snap.docs)) {
        for (const docSnap of snap.docs) {
          const data = typeof docSnap.data === 'function' ? docSnap.data() : docSnap;
          combinedTransactions.push(
            createTransaction({ ...data, id: docSnap.id || data.id })
          );
        }
      }
    } catch {
      // Fallback to local state when Firestore is offline
    }
  }

  return findAccountDuplicateTransactions(candidateTx, combinedTransactions, targetAccountId);
}

/**
 * Aplica la decisión elegida por el usuario ante una transacción duplicada:
 * - `'overwrite'`: Actualiza el documento existente en Firestore y en el estado local.
 * - `'create_new'`: Registra un nuevo documento independiente en Firestore y en el estado local.
 * - `'skip'`: Cancela la inserción de esa transacción específica.
 *
 * @param {object} params
 * @param {'overwrite'|'create_new'|'skip'} params.action
 * @param {object} params.candidateTx
 * @param {object} [params.existingTx]
 * @param {object} [params.state]
 * @param {object} [params.context]
 */
export async function resolveDuplicateTransactionAction({
  action,
  candidateTx,
  existingTx = null,
  state = null,
  context = {},
}) {
  if (action === DUPLICATE_TRANSACTION_ACTIONS.SKIP) {
    return {
      action: DUPLICATE_TRANSACTION_ACTIONS.SKIP,
      savedTransaction: null,
      skipped: true,
      overwritten: false,
    };
  }

  const user = context.currentUser || null;
  const profile = context.currentUserProfile || context.currentProfile || null;
  const workspaceId =
    context.workspaceId ||
    profile?.workspaceId ||
    state?.settings?.workspaceId ||
    'ws_default';

  if (action === DUPLICATE_TRANSACTION_ACTIONS.OVERWRITE && existingTx && existingTx.id) {
    const updatedTx = prepareTransactionForWorkspace(
      {
        ...existingTx,
        ...candidateTx,
        id: existingTx.id,
        note: String(
          candidateTx.note || candidateTx.concept || existingTx.note || 'Movimiento actualizado'
        ).trim(),
        createdAt: existingTx.createdAt,
        updatedAt: new Date().toISOString(),
        workspaceId,
      },
      user,
      profile,
      workspaceId
    );

    await saveTransactionToWorkspace(updatedTx, user, profile, {
      firestoreDb: context.firestoreDb,
      firestoreModule: context.firestoreModule,
      storage: context.storage,
      workspaceId,
    });

    if (state && Array.isArray(state.transactions)) {
      const idx = state.transactions.findIndex((t) => t.id === existingTx.id);
      if (idx !== -1) {
        state.transactions[idx] = updatedTx;
      } else {
        state.transactions.unshift(updatedTx);
      }
    }

    return {
      action: DUPLICATE_TRANSACTION_ACTIONS.OVERWRITE,
      savedTransaction: updatedTx,
      skipped: false,
      overwritten: true,
    };
  }

  // Default / 'create_new': Crea un nuevo documento con ID único
  const freshInput = { ...candidateTx };
  if (existingTx && freshInput.id === existingTx.id) {
    delete freshInput.id;
  }

  const newTx = prepareTransactionForWorkspace(
    {
      ...freshInput,
      note: String(
        freshInput.note || freshInput.concept || 'Movimiento bancario'
      ).trim(),
      workspaceId,
    },
    user,
    profile,
    workspaceId
  );

  await saveTransactionToWorkspace(newTx, user, profile, {
    firestoreDb: context.firestoreDb,
    firestoreModule: context.firestoreModule,
    storage: context.storage,
    workspaceId,
  });

  if (state && Array.isArray(state.transactions)) {
    state.transactions.unshift(newTx);
  }

  return {
    action: DUPLICATE_TRANSACTION_ACTIONS.CREATE_NEW,
    savedTransaction: newTx,
    skipped: false,
    overwritten: false,
  };
}
