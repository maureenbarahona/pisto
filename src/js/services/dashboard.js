/**
 * @fileoverview Servicio de Inicialización, Reseteo en Cero y Recálculo Seguro de Métricas
 * Globales del Dashboard (`src/js/services/dashboard.js`) en JavaScript Vanilla (ESNext).
 *
 * Implementa:
 * 1. Reset Completo de Métricas Globales (`resetGlobalDashboardMetricsToZero` / `initializeDashboardStateForNewUser`):
 *    - Inicializa en Firestore y en la UI los totales del Dashboard en cero estricto:
 *      - `Patrimonio en Cuentas`: L 0.00
 *      - `Ingresos del Período`: + L 0.00
 *      - `Gastos del Período`: - L 0.00
 *      - `Tasa de Ahorro`: 0%
 * 2. Limpieza de Transacciones de Prueba / Residuales (`purgeResidualTransactionsFromWorkspace`):
 *    - Verifica y limpia documentos heredados o de demostración (`tx_seed_*`, `acc_seed_*`, `ws_default`)
 *      en la colección `transactions` y `accounts` asociados al `workspaceId` de un usuario nuevo.
 *    - Si no existen transacciones registradas por el usuario, `recalculateDashboardMetrics` retorna `0`
 *      en todos los sumatorios sin calcular divisiones por cero (evitando porcentajes negativos anómalos como -4397%).
 * 3. Lógica de Cálculo Seguro para Tasa de Ahorro (`calculateSafeSavingsRate`):
 *    - Guardián matemático estricto:
 *      `const savingsRate = totalIncome > 0 ? ((totalIncome - totalExpenses) / totalIncome) * 100 : 0;`
 *    - Si `totalIncome` es `0` o no hay transacciones, `savingsRate` es estrictamente `0` (`0%`).
 * 4. Vanilla Stack puro, sin llamadas a `console.log` y optimizado para mínimo uso de CPU y memoria.
 */

import {
  Money,
  CURRENCIES,
  TRANSACTION_TYPES,
  ACCOUNT_TYPES,
  DEFAULT_CATEGORIES,
  isAccountArchived,
} from '../../../public/js/domain/models.js';

export const DEMO_SEED_ACCOUNT_IDS = Object.freeze([
  'acc_bank',
  'acc_cash',
  'acc_card',
  'acc_savings',
  'acc_debt',
]);

export const ZERO_DASHBOARD_METRICS = Object.freeze({
  baseCurrency: 'HNL',
  totalIncludedBalance: 0,
  totalSavings: 0,
  totalDebt: 0,
  totalIncome: 0,
  totalExpenses: 0,
  totalExpense: 0,
  netCashflow: 0,
  savingsRate: 0,
  savingsRatePct: 0,
  hasUserTransactions: false,
  transactionCount: 0,
  patrimonioLabel: 'L 0.00',
  ingresosLabel: '+ L 0.00',
  gastosLabel: '- L 0.00',
  tasaAhorroLabel: '0%',
});

/**
 * Determina si una transacción es un registro de prueba/demostración (`tx_seed_*`)
 * o un documento residual de `ws_default` / `local_default_user` que no pertenece al usuario autenticado.
 *
 * @param {object} tx
 * @param {{ workspaceId?: string, currentUid?: string | null, excludeDemoSeeds?: boolean }} [options]
 * @returns {boolean}
 */
export function isDemoOrResidualTransaction(tx, options = {}) {
  if (!tx || typeof tx !== 'object') return true;
  const id = String(tx.id || '').trim();
  const activeWorkspaceId = String(options.workspaceId || 'ws_default').trim();
  const isAuthenticatedWorkspace =
    Boolean(activeWorkspaceId) &&
    activeWorkspaceId !== 'ws_default' &&
    activeWorkspaceId !== 'all';
  const excludeDemoSeeds = Boolean(options.excludeDemoSeeds ?? isAuthenticatedWorkspace);

  if (excludeDemoSeeds && /^tx_seed_/i.test(id)) {
    return true;
  }

  if (isAuthenticatedWorkspace) {
    const txWorkspace = String(tx.workspaceId || 'ws_default').trim();
    if (txWorkspace !== activeWorkspaceId) {
      return true;
    }
    if (tx.isDemo === true) {
      return true;
    }
  }

  return false;
}

/**
 * Determina si una cuenta es una cuenta semilla de demostración (`acc_bank`, `acc_cash`, etc.)
 * o un documento residual de otro `workspaceId`.
 *
 * @param {object} acc
 * @param {{ workspaceId?: string, currentUid?: string | null, excludeDemoSeeds?: boolean }} [options]
 * @returns {boolean}
 */
export function isDemoOrResidualAccount(acc, options = {}) {
  if (!acc || typeof acc !== 'object') return true;
  const id = String(acc.id || '').trim();
  const activeWorkspaceId = String(options.workspaceId || 'ws_default').trim();
  const isAuthenticatedWorkspace =
    Boolean(activeWorkspaceId) &&
    activeWorkspaceId !== 'ws_default' &&
    activeWorkspaceId !== 'all';
  const excludeDemoSeeds = Boolean(options.excludeDemoSeeds ?? isAuthenticatedWorkspace);

  if (excludeDemoSeeds) {
    if (/^acc_seed_/i.test(id)) return true;
    if (
      DEMO_SEED_ACCOUNT_IDS.includes(id) &&
      (!acc.workspaceId ||
        acc.workspaceId === 'ws_default' ||
        acc.createdByUid === 'local_default_user')
    ) {
      return true;
    }
  }

  if (isAuthenticatedWorkspace && acc.workspaceId && acc.workspaceId !== activeWorkspaceId) {
    return true;
  }

  return false;
}

/**
 * Filtra únicamente las transacciones válidas del usuario para el `workspaceId` activo,
 * descartando cualquier documento heredado o de demostración.
 *
 * @param {Array<object>} transactions
 * @param {{ workspaceId?: string, currentUid?: string | null, excludeDemoSeeds?: boolean }} [options]
 * @returns {Array<object>}
 */
export function filterCleanUserTransactions(transactions = [], options = {}) {
  if (!Array.isArray(transactions) || transactions.length === 0) return [];
  return transactions.filter((tx) => !isDemoOrResidualTransaction(tx, options));
}

/**
 * Filtra únicamente las cuentas válidas del usuario para el `workspaceId` activo,
 * descartando cuentas semilla de demostración o residuales.
 *
 * @param {Array<object>} accounts
 * @param {{ workspaceId?: string, currentUid?: string | null, excludeDemoSeeds?: boolean }} [options]
 * @returns {Array<object>}
 */
export function filterCleanUserAccounts(accounts = [], options = {}) {
  if (!Array.isArray(accounts) || accounts.length === 0) return [];
  return accounts.filter((acc) => !isDemoOrResidualAccount(acc, options));
}

/**
 * Guardián matemático seguro para la Tasa de Ahorro (`savingsRate`).
 * Aplica estrictamente:
 * `const savingsRate = totalIncome > 0 ? ((totalIncome - totalExpenses) / totalIncome) * 100 : 0;`
 *
 * Si `totalIncome` es `0` (o menor) o no existen transacciones registradas, retorna estrictamente `0`.
 *
 * @param {number} totalIncome
 * @param {number} totalExpenses
 * @param {boolean} [hasTransactions=true]
 * @returns {number}
 */
export function calculateSafeSavingsRate(
  totalIncome = 0,
  totalExpenses = 0,
  hasTransactions = true
) {
  if (!hasTransactions) return 0;
  const safeIncome = Number.isFinite(Number(totalIncome)) ? Number(totalIncome) : 0;
  const safeExpenses = Number.isFinite(Number(totalExpenses)) ? Number(totalExpenses) : 0;

  const savingsRate =
    safeIncome > 0 ? ((safeIncome - safeExpenses) / safeIncome) * 100 : 0;

  if (!Number.isFinite(savingsRate) || safeIncome <= 0) {
    return 0;
  }

  const rounded = Math.round(savingsRate);
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Formatea las etiquetas de los 4 indicadores globales del Dashboard.
 * Para moneda `HNL` en cero produce exactamente:
 * - `Patrimonio en Cuentas`: `"L 0.00"`
 * - `Ingresos del Período`: `"+ L 0.00"`
 * - `Gastos del Período`: `"- L 0.00"`
 * - `Tasa de Ahorro`: `"0%"`
 *
 * @param {{ totalIncludedBalance?: number, totalIncome?: number, totalExpenses?: number, totalExpense?: number, savingsRatePct?: number, savingsRate?: number }} metrics
 * @param {string} [currencyCode='HNL']
 */
export function formatDashboardKpiLabels(metrics = {}, currencyCode = 'HNL') {
  const validCurrency = CURRENCIES[currencyCode] ? currencyCode : 'HNL';
  const balance = Number.isFinite(Number(metrics.totalIncludedBalance))
    ? Number(metrics.totalIncludedBalance)
    : 0;
  const income = Number.isFinite(Number(metrics.totalIncome))
    ? Math.max(0, Number(metrics.totalIncome))
    : 0;
  const expenses = Number.isFinite(Number(metrics.totalExpenses ?? metrics.totalExpense))
    ? Math.max(0, Number(metrics.totalExpenses ?? metrics.totalExpense))
    : 0;
  const rawRate = metrics.savingsRatePct ?? metrics.savingsRate ?? 0;
  const safeRate =
    income > 0 && Number.isFinite(Number(rawRate))
      ? Object.is(Math.round(Number(rawRate)), -0)
        ? 0
        : Math.round(Number(rawRate))
      : 0;

  return {
    patrimonioLabel: Money.format(balance, validCurrency),
    ingresosLabel: `+ ${Money.format(income, validCurrency)}`,
    gastosLabel: `- ${Money.format(expenses, validCurrency)}`,
    tasaAhorroLabel: `${safeRate}%`,
  };
}

/**
 * Actualiza en el DOM los 4 indicadores globales del Dashboard si los elementos existen.
 *
 * @param {object} metrics
 * @param {string} [currencyCode='HNL']
 * @param {Document|object|null} [docRef]
 */
export function renderDashboardMetricsToDom(
  metrics = ZERO_DASHBOARD_METRICS,
  currencyCode = 'HNL',
  docRef = typeof document !== 'undefined' ? document : null
) {
  if (!docRef || typeof docRef.getElementById !== 'function') return null;
  const labels = formatDashboardKpiLabels(
    metrics,
    currencyCode || metrics?.baseCurrency || 'HNL'
  );

  const netWorthEl = docRef.getElementById('kpi-total-balance');
  const incomeEl = docRef.getElementById('kpi-period-income');
  const expenseEl = docRef.getElementById('kpi-period-expense');
  const savingsRateEl = docRef.getElementById('kpi-savings-rate');

  if (netWorthEl) netWorthEl.textContent = labels.patrimonioLabel;
  if (incomeEl) incomeEl.textContent = labels.ingresosLabel;
  if (expenseEl) expenseEl.textContent = labels.gastosLabel;
  if (savingsRateEl) savingsRateEl.textContent = labels.tasaAhorroLabel;

  return labels;
}

/**
 * Función de recálculo seguro de métricas globales del Dashboard (`recalculateDashboardMetrics`).
 * - Filtra transacciones o cuentas residuales/demostración cuando hay un `workspaceId` de usuario activo.
 * - Si no existen transacciones registradas por el usuario, retorna `0` en todos los sumatorios
 *   sin calcular divisiones por cero (evitando porcentajes negativos anómalos como `-4397%`).
 * - Aplica el guardián matemático:
 *   `const savingsRate = totalIncome > 0 ? ((totalIncome - totalExpenses) / totalIncome) * 100 : 0;`
 *
 * @param {object} state
 * @param {object} [options]
 */
export function recalculateDashboardMetrics(state = {}, options = {}) {
  const settings = state?.settings || {};
  const baseCurrency =
    options.baseCurrency || settings.baseCurrency || 'HNL';
  const workspaceId =
    options.workspaceId ?? settings.workspaceId ?? 'ws_default';
  const currentUid =
    options.currentUid ?? settings.currentUid ?? null;
  const personalViewMode = Boolean(
    options.personalViewMode ?? settings.personalViewMode ?? false
  );
  const excludeDemoSeeds = Boolean(
    options.excludeDemoSeeds ?? (workspaceId && workspaceId !== 'ws_default')
  );

  const cleanAccounts = filterCleanUserAccounts(state?.accounts || [], {
    workspaceId,
    currentUid,
    excludeDemoSeeds,
  });

  const cleanTransactions = filterCleanUserTransactions(state?.transactions || [], {
    workspaceId,
    currentUid,
    excludeDemoSeeds,
  }).filter((tx) => {
    if (personalViewMode && currentUid) {
      const txCreator = tx.createdByUid || tx.ownerUid || currentUid;
      if (txCreator !== currentUid) return false;
    }
    return true;
  });

  // 1. Cálculo de Patrimonio en Cuentas (0 estricto si no hay cuentas del usuario)
  let totalIncludedCents = 0;
  let totalSavingsCents = 0;
  let totalDebtCents = 0;

  if (cleanAccounts.length > 0) {
    const balanceCentsByAccount = new Map();
    for (const acc of cleanAccounts) {
      balanceCentsByAccount.set(acc.id, Money.toCents(acc.initialBalance || 0));
    }

    for (const tx of cleanTransactions) {
      const originAcc = cleanAccounts.find((a) => a.id === tx.accountId);
      if (originAcc) {
        const amountInOrigin = Money.convert(tx.amount, tx.currency, originAcc.currency);
        const centsOrigin = Money.toCents(amountInOrigin);
        const prev = balanceCentsByAccount.get(originAcc.id) || 0;
        if (tx.type === TRANSACTION_TYPES.INCOME) {
          balanceCentsByAccount.set(originAcc.id, prev + centsOrigin);
        } else if (
          tx.type === TRANSACTION_TYPES.EXPENSE ||
          tx.type === TRANSACTION_TYPES.TRANSFER
        ) {
          balanceCentsByAccount.set(originAcc.id, prev - centsOrigin);
        }
      }
      if (tx.type === TRANSACTION_TYPES.TRANSFER && tx.toAccountId) {
        const destAcc = cleanAccounts.find((a) => a.id === tx.toAccountId);
        if (destAcc) {
          const amountInDest = Money.convert(tx.amount, tx.currency, destAcc.currency);
          const centsDest = Money.toCents(amountInDest);
          const prevDest = balanceCentsByAccount.get(destAcc.id) || 0;
          balanceCentsByAccount.set(destAcc.id, prevDest + centsDest);
        }
      }
    }

    for (const acc of cleanAccounts) {
      if (isAccountArchived(acc)) continue;
      const currentBalance = Money.fromCents(balanceCentsByAccount.get(acc.id) || 0);
      const balanceInBase = Money.convert(currentBalance, acc.currency, baseCurrency);
      if (acc.includeInTotal !== false) {
        totalIncludedCents += Money.toCents(balanceInBase);
      }
      if (acc.type === ACCOUNT_TYPES.SAVINGS && currentBalance > 0) {
        totalSavingsCents += Money.toCents(balanceInBase);
      }
      if (
        (acc.type === ACCOUNT_TYPES.DEBT || acc.type === ACCOUNT_TYPES.CARD) &&
        currentBalance < 0
      ) {
        totalDebtCents += Money.toCents(Math.abs(balanceInBase));
      }
    }
  }

  const totalIncludedBalance = Money.fromCents(totalIncludedCents);
  const totalSavings = Money.fromCents(totalSavingsCents);
  const totalDebt = Money.fromCents(totalDebtCents);

  // 2. Si no existen transacciones registradas por el usuario, retornar 0 en todos los sumatorios sin divisiones
  if (cleanTransactions.length === 0) {
    const labels = formatDashboardKpiLabels(
      {
        totalIncludedBalance,
        totalIncome: 0,
        totalExpenses: 0,
        savingsRate: 0,
      },
      baseCurrency
    );
    return {
      baseCurrency,
      workspaceId,
      totalIncludedBalance,
      totalSavings,
      totalDebt,
      totalIncome: 0,
      totalExpenses: 0,
      totalExpense: 0,
      netCashflow: 0,
      savingsRate: 0,
      savingsRatePct: 0,
      hasUserTransactions: false,
      transactionCount: 0,
      ...labels,
    };
  }

  let totalIncomeCents = 0;
  let totalExpenseCents = 0;

  for (const tx of cleanTransactions) {
    const amountBase = Money.convert(tx.amount, tx.currency, baseCurrency);
    const cents = Money.toCents(amountBase);
    if (tx.type === TRANSACTION_TYPES.INCOME) {
      totalIncomeCents += cents;
    } else if (tx.type === TRANSACTION_TYPES.EXPENSE) {
      totalExpenseCents += cents;
    }
  }

  const totalIncome = Money.fromCents(totalIncomeCents);
  const totalExpenses = Money.fromCents(totalExpenseCents);
  const netCashflow = Money.fromCents(totalIncomeCents - totalExpenseCents);

  // 3. Guardián matemático simple requerido:
  const savingsRate =
    totalIncome > 0 ? ((totalIncome - totalExpenses) / totalIncome) * 100 : 0;
  const savingsRatePct = calculateSafeSavingsRate(totalIncome, totalExpenses, true);

  const labels = formatDashboardKpiLabels(
    {
      totalIncludedBalance,
      totalIncome,
      totalExpenses,
      savingsRatePct,
    },
    baseCurrency
  );

  return {
    baseCurrency,
    workspaceId,
    totalIncludedBalance,
    totalSavings,
    totalDebt,
    totalIncome,
    totalExpenses,
    totalExpense: totalExpenses,
    netCashflow,
    savingsRate: savingsRatePct,
    savingsRatePct,
    rawSavingsRate: Number.isFinite(savingsRate) ? savingsRate : 0,
    hasUserTransactions: true,
    transactionCount: cleanTransactions.length,
    ...labels,
  };
}

/**
 * Limpia en Firestore y en `localStorage` cualquier transacción o cuenta de prueba / residual
 * asociada al `workspaceId` (o `ws_default`).
 *
 * @param {object} [options]
 */
export async function purgeResidualTransactionsFromWorkspace(options = {}) {
  const {
    workspaceId = 'ws_default',
    uid = 'local_default_user',
    state = null,
    repo = null,
    storage = typeof localStorage !== 'undefined' ? localStorage : null,
    firestoreDb = null,
    firestoreModule = null,
    wipeAllForNewUser = false,
  } = options;

  if (state && typeof state === 'object') {
    if (wipeAllForNewUser) {
      state.accounts = [];
      state.transactions = [];
      state.budgets = {};
      if (Array.isArray(state.categories)) {
        state.categories = state.categories.map((cat) => ({
          ...cat,
          defaultBudget: 0,
        }));
      }
    } else {
      state.accounts = filterCleanUserAccounts(state.accounts || [], {
        workspaceId,
        currentUid: uid,
        excludeDemoSeeds: true,
      });
      state.transactions = filterCleanUserTransactions(state.transactions || [], {
        workspaceId,
        currentUid: uid,
        excludeDemoSeeds: true,
      });
    }
    if (repo && typeof repo.saveState === 'function') {
      repo.saveState(state);
    }
  }

  if (storage && typeof storage.removeItem === 'function') {
    if (wipeAllForNewUser) {
      storage.removeItem(`pisto_firestore_accounts_ws_${workspaceId}`);
      storage.removeItem(`pisto_firestore_transactions_ws_${workspaceId}`);
      storage.removeItem(`pisto_firestore_budgets_ws_${workspaceId}`);
    }
    storage.removeItem('pisto_firestore_accounts_ws_ws_default');
    storage.removeItem('pisto_firestore_transactions_ws_ws_default');
    storage.removeItem('pisto_firestore_budgets_ws_ws_default');
  }

  let deletedDocsCount = 0;
  if (
    firestoreDb &&
    firestoreModule &&
    typeof firestoreModule.collection === 'function' &&
    typeof firestoreModule.query === 'function' &&
    typeof firestoreModule.where === 'function' &&
    typeof firestoreModule.getDocs === 'function'
  ) {
    const collectionsToCheck = ['transactions', 'accounts', 'budgets'];
    for (const colName of collectionsToCheck) {
      try {
        const colRef = firestoreModule.collection(firestoreDb, colName);
        const q = firestoreModule.query(
          colRef,
          firestoreModule.where('workspaceId', '==', workspaceId)
        );
        const snap = await firestoreModule.getDocs(q);
        const docs = Array.isArray(snap?.docs) ? snap.docs : [];
        const docsToDelete = docs.filter((d) => {
          if (wipeAllForNewUser) return true;
          const data = typeof d.data === 'function' ? d.data() : d;
          const record = { ...data, id: d.id || data?.id };
          if (colName === 'transactions') {
            return isDemoOrResidualTransaction(record, {
              workspaceId,
              currentUid: uid,
              excludeDemoSeeds: true,
            });
          }
          if (colName === 'accounts') {
            return isDemoOrResidualAccount(record, {
              workspaceId,
              currentUid: uid,
              excludeDemoSeeds: true,
            });
          }
          return false;
        });

        if (docsToDelete.length > 0) {
          if (typeof firestoreModule.writeBatch === 'function') {
            const batch = firestoreModule.writeBatch(firestoreDb);
            for (const d of docsToDelete) {
              const docRef =
                d.ref ||
                (typeof firestoreModule.doc === 'function'
                  ? firestoreModule.doc(firestoreDb, colName, d.id)
                  : null);
              if (docRef) {
                batch.delete(docRef);
                deletedDocsCount += 1;
              }
            }
            await batch.commit();
          } else if (typeof firestoreModule.deleteDoc === 'function') {
            for (const d of docsToDelete) {
              const docRef =
                d.ref ||
                (typeof firestoreModule.doc === 'function'
                  ? firestoreModule.doc(firestoreDb, colName, d.id)
                  : null);
              if (docRef) {
                await firestoreModule.deleteDoc(docRef);
                deletedDocsCount += 1;
              }
            }
          }
        }
      } catch {
        // Ignore offline Firestore cleanup errors
      }
    }
  }

  return {
    cleaned: true,
    workspaceId,
    deletedDocsCount,
  };
}

/**
 * Resetea e inicializa en cero estricto todas las métricas globales del Dashboard
 * en memoria, `localStorage`, Firestore (`workspaces/{workspaceId}` y `users/{uid}`) y el DOM:
 * - `Patrimonio en Cuentas`: L 0.00
 * - `Ingresos del Período`: + L 0.00
 * - `Gastos del Período`: - L 0.00
 * - `Tasa de Ahorro`: 0%
 *
 * @param {object} [options]
 */
export async function resetGlobalDashboardMetricsToZero(options = {}) {
  const {
    workspaceId = 'ws_default',
    uid = 'local_default_user',
    baseCurrency = 'HNL',
    state = null,
    repo = null,
    storage = typeof localStorage !== 'undefined' ? localStorage : null,
    firestoreDb = null,
    firestoreModule = null,
  } = options;

  const validCurrency = CURRENCIES[baseCurrency] ? baseCurrency : 'HNL';

  // 1. Limpiar cuentas, transacciones y presupuestos residuales/demostración
  const purgeResult = await purgeResidualTransactionsFromWorkspace({
    workspaceId,
    uid,
    state,
    repo,
    storage,
    firestoreDb,
    firestoreModule,
    wipeAllForNewUser: true,
  });

  // 2. Construir métricas en cero estricto
  const zeroLabels = formatDashboardKpiLabels(ZERO_DASHBOARD_METRICS, validCurrency);
  const zeroMetrics = {
    ...ZERO_DASHBOARD_METRICS,
    baseCurrency: validCurrency,
    workspaceId,
    ...zeroLabels,
  };

  if (state && typeof state === 'object') {
    state.accounts = [];
    state.transactions = [];
    state.budgets = {};
    state.categories = (
      Array.isArray(state.categories) && state.categories.length > 0
        ? state.categories
        : DEFAULT_CATEGORIES
    ).map((cat) => ({
      ...cat,
      defaultBudget: 0,
    }));
    if (!state.settings || typeof state.settings !== 'object') {
      state.settings = {};
    }
    state.settings.baseCurrency = validCurrency;
    state.settings.currencyFilter = validCurrency;
    state.settings.workspaceId = workspaceId;
    state.settings.currentUid = uid;
    state.dashboardMetrics = zeroMetrics;

    if (repo && typeof repo.saveState === 'function') {
      repo.saveState(state);
    }
  }

  // 3. Persistir métricas inicializadas en cero estricto en Firestore (`workspaces/{workspaceId}` y `users/{uid}`)
  const nowIso = new Date().toISOString();
  const firestoreZeroSummary = {
    workspaceId,
    baseCurrency: validCurrency,
    totalIncludedBalance: 0,
    totalIncome: 0,
    totalExpenses: 0,
    savingsRate: 0,
    patrimonioEnCuentas: zeroLabels.patrimonioLabel,
    ingresosDelPeriodo: zeroLabels.ingresosLabel,
    gastosDelPeriodo: zeroLabels.gastosLabel,
    tasaDeAhorro: zeroLabels.tasaAhorroLabel,
    updatedAt: nowIso,
  };

  if (
    firestoreDb &&
    firestoreModule &&
    typeof firestoreModule.doc === 'function' &&
    typeof firestoreModule.setDoc === 'function'
  ) {
    try {
      if (workspaceId) {
        const wsRef = firestoreModule.doc(firestoreDb, 'workspaces', workspaceId);
        await firestoreModule.setDoc(
          wsRef,
          {
            workspaceId,
            dashboardMetrics: firestoreZeroSummary,
            updatedAt: nowIso,
          },
          { merge: true }
        );
      }
      if (uid && uid !== 'local_default_user') {
        const userRef = firestoreModule.doc(firestoreDb, 'users', uid);
        await firestoreModule.setDoc(
          userRef,
          {
            dashboardMetrics: firestoreZeroSummary,
            updatedAt: nowIso,
          },
          { merge: true }
        );
      }
    } catch {
      // Fallback silencioso en modo offline
    }
  }

  if (storage && typeof storage.setItem === 'function') {
    try {
      storage.setItem(
        `pisto_dashboard_metrics_ws_${workspaceId}`,
        JSON.stringify(firestoreZeroSummary)
      );
    } catch {
      // Ignore storage quota errors
    }
  }

  // 4. Actualizar indicadores del DOM inmediatamente en cero estricto
  renderDashboardMetricsToDom(
    zeroMetrics,
    validCurrency,
    options.docRef ?? (typeof document !== 'undefined' ? document : null)
  );

  return {
    ...zeroMetrics,
    cleaned: true,
    deletedDocsCount: purgeResult.deletedDocsCount,
  };
}

export const initializeDashboardStateForNewUser = resetGlobalDashboardMetricsToZero;
export const renderDashboardKpiElementsToZero = renderDashboardMetricsToDom;

