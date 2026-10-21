/**
 * @fileoverview Pure Business Logic Service for Personal Finance Management.
 *
 * Responsibilities:
 * - Calculates exact account balances across multi-currency ledgers.
 * - Computes Pisto-style category breakdowns for the interactive Donut Ring & Grid.
 * - Evaluates budget utilization and threshold alerts (healthy / warning / exceeded).
 * - Groups chronological transactions by date with daily net cashflow.
 */

import {
  Money,
  TRANSACTION_TYPES,
  ACCOUNT_TYPES,
  DEFAULT_CATEGORIES,
  isAccountArchived,
} from '../domain/models.js';
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
  recalculateDashboardMetrics,
  purgeResidualTransactionsFromWorkspace,
  resetGlobalDashboardMetricsToZero,
  initializeDashboardStateForNewUser,
} from './dashboard.js';

export {
  DEMO_SEED_ACCOUNT_IDS,
  ZERO_DASHBOARD_METRICS,
  isDemoOrResidualTransaction,
  isDemoOrResidualAccount,
  filterCleanUserTransactions,
  filterCleanUserAccounts,
  calculateSafeSavingsRate,
  formatDashboardKpiLabels,
  renderDashboardMetricsToDom,
  recalculateDashboardMetrics,
  purgeResidualTransactionsFromWorkspace,
  resetGlobalDashboardMetricsToZero,
  initializeDashboardStateForNewUser,
};

function resolveTransactionCategory(tx, categoryMap, stateCategories = []) {
  if (tx.type === TRANSACTION_TYPES.TRANSFER) {
    return {
      id: 'transfer',
      name: 'Transferencia',
      color: '#06b6d4',
      icon: 'transfer',
    };
  }
  return (
    categoryMap.get(tx.categoryId) ||
    DEFAULT_CATEGORIES.find((c) => c.id === tx.categoryId) ||
    stateCategories.find((c) => c.type === tx.type) || {
      id: tx.categoryId || 'other',
      name: 'Sin Categoría',
      color: '#64748b',
      icon: 'bag',
    }
  );
}

/**
 * Checks whether a YYYY-MM-DD date string falls within the selected period or explicit [startDate, endDate] range.
 * @param {string} txDateStr
 * @param {'today'|'week'|'month'|'all'|'custom'} period
 * @param {Date} [referenceDate]
 * @param {{ startDate?: string, endDate?: string }} [dateRange]
 * @returns {boolean}
 */
export function isDateInPeriod(
  txDateStr,
  period = 'month',
  referenceDate = new Date(),
  dateRange = {}
) {
  if (!txDateStr) return true;

  const startDate = String(dateRange?.startDate || '').trim();
  const endDate = String(dateRange?.endDate || '').trim();

  // If an explicit date range is active, filter by [startDate, endDate] inclusive
  if (startDate || endDate) {
    if (startDate && txDateStr < startDate) return false;
    if (endDate && txDateStr > endDate) return false;
    return true;
  }

  if (period === 'all' || period === 'custom') return true;

  const todayIso = referenceDate.toISOString().slice(0, 10);
  if (period === 'today') {
    return txDateStr === todayIso;
  }

  if (period === 'month') {
    return txDateStr.slice(0, 7) === todayIso.slice(0, 7);
  }

  if (period === 'week') {
    const txTime = new Date(`${txDateStr}T12:00:00Z`).getTime();
    const refTime = new Date(`${todayIso}T12:00:00Z`).getTime();
    const diffDays = (refTime - txTime) / (1000 * 60 * 60 * 24);
    return diffDays >= -1 && diffDays <= 7;
  }

  return true;
}

/**
 * Computes current balance for every account and overall Net Worth in baseCurrency.
 * Also counts total transactions and period-filtered transactions per account.
 * @param {object} state
 * @param {{ startDate?: string, endDate?: string, period?: string }} [options]
 * @returns {{
 *   accountsWithBalance: Array<object>,
 *   totalIncludedBalance: number,
 *   totalSavings: number,
 *   totalDebt: number
 * }}
 */
export function computeAccountsSummary(state, options = {}) {
  const baseCurrency = state.settings?.baseCurrency || 'USD';
  const period = options.period || state.settings?.periodFilter || 'month';
  const workspaceId = options.workspaceId ?? state.settings?.workspaceId ?? 'ws_default';
  const currentUid = options.currentUid ?? state.settings?.currentUid ?? null;
  const personalViewMode = Boolean(
    options.personalViewMode ?? state.settings?.personalViewMode ?? false
  );
  const startDate =
    options.startDate !== undefined ? options.startDate : (state.settings?.startDate || '');
  const endDate =
    options.endDate !== undefined ? options.endDate : (state.settings?.endDate || '');

  const visibleAccounts = filterCleanUserAccounts(state.accounts || [], {
    workspaceId,
    currentUid,
  });
  const visibleTransactions = filterCleanUserTransactions(state.transactions || [], {
    workspaceId,
    currentUid,
  }).filter((tx) =>
    isTransactionVisibleInWorkspace(tx, { workspaceId, personalViewMode, currentUid })
  );

  const balanceCentsByAccount = new Map();
  const txCountByAccount = new Map();
  const periodTxCountByAccount = new Map();

  for (const acc of visibleAccounts) {
    balanceCentsByAccount.set(acc.id, Money.toCents(acc.initialBalance));
    txCountByAccount.set(acc.id, 0);
    periodTxCountByAccount.set(acc.id, 0);
  }

  for (const tx of visibleTransactions) {
    const inPeriod = isDateInPeriod(tx.date, period, new Date(), { startDate, endDate });
    const originAccount = visibleAccounts.find((a) => a.id === tx.accountId);
    if (originAccount) {
      const amountInOrigin = Money.convert(tx.amount, tx.currency, originAccount.currency);
      const centsOrigin = Money.toCents(amountInOrigin);
      const prev = balanceCentsByAccount.get(originAccount.id) || 0;

      if (tx.type === TRANSACTION_TYPES.INCOME) {
        balanceCentsByAccount.set(originAccount.id, prev + centsOrigin);
      } else if (tx.type === TRANSACTION_TYPES.EXPENSE || tx.type === TRANSACTION_TYPES.TRANSFER) {
        balanceCentsByAccount.set(originAccount.id, prev - centsOrigin);
      }

      txCountByAccount.set(originAccount.id, (txCountByAccount.get(originAccount.id) || 0) + 1);
      if (inPeriod) {
        periodTxCountByAccount.set(
          originAccount.id,
          (periodTxCountByAccount.get(originAccount.id) || 0) + 1
        );
      }
    }

    if (tx.type === TRANSACTION_TYPES.TRANSFER && tx.toAccountId) {
      const destAccount = visibleAccounts.find((a) => a.id === tx.toAccountId);
      if (destAccount) {
        const amountInDest = Money.convert(tx.amount, tx.currency, destAccount.currency);
        const centsDest = Money.toCents(amountInDest);
        const prevDest = balanceCentsByAccount.get(destAccount.id) || 0;
        balanceCentsByAccount.set(destAccount.id, prevDest + centsDest);
        txCountByAccount.set(destAccount.id, (txCountByAccount.get(destAccount.id) || 0) + 1);
        if (inPeriod) {
          periodTxCountByAccount.set(
            destAccount.id,
            (periodTxCountByAccount.get(destAccount.id) || 0) + 1
          );
        }
      }
    }
  }

  let totalIncludedCents = 0;
  let totalSavingsCents = 0;
  let totalDebtCents = 0;

  const accountsWithBalance = visibleAccounts.map((acc) => {
    const currentBalance = Money.fromCents(balanceCentsByAccount.get(acc.id) || 0);
    const balanceInBase = Money.convert(currentBalance, acc.currency, baseCurrency);

    if (acc.includeInTotal) {
      totalIncludedCents += Money.toCents(balanceInBase);
    }
    if (acc.type === ACCOUNT_TYPES.SAVINGS && currentBalance > 0) {
      totalSavingsCents += Money.toCents(balanceInBase);
    }
    if ((acc.type === ACCOUNT_TYPES.DEBT || acc.type === ACCOUNT_TYPES.CARD) && currentBalance < 0) {
      totalDebtCents += Money.toCents(Math.abs(balanceInBase));
    }

    const goalProgressPct = acc.targetAmount > 0
      ? Math.min(100, Math.max(0, Math.round((Math.abs(currentBalance) / acc.targetAmount) * 100)))
      : 0;
    const archived = isAccountArchived(acc);

    return {
      ...acc,
      isArchived: archived,
      status: archived ? 'archived' : 'active',
      currentBalance,
      balanceInBase,
      goalProgressPct,
      txCount: txCountByAccount.get(acc.id) || 0,
      periodTxCount: periodTxCountByAccount.get(acc.id) || 0,
    };
  });

  const activeAccountsWithBalance = accountsWithBalance.filter((a) => !a.isArchived);
  const archivedAccountsWithBalance = accountsWithBalance.filter((a) => a.isArchived);

  return {
    accountsWithBalance,
    activeAccountsWithBalance,
    archivedAccountsWithBalance,
    totalIncludedBalance: Money.fromCents(totalIncludedCents),
    totalSavings: Money.fromCents(totalSavingsCents),
    totalDebt: Money.fromCents(totalDebtCents),
  };
}

/**
 * Checks whether a transaction belongs to the active `workspaceId` and satisfies `personalViewMode`.
 * - When `personalViewMode === false`: includes ALL transactions belonging to `workspaceId`, regardless of `createdByUid`.
 * - When `personalViewMode === true`: includes only transactions in `workspaceId` where `createdByUid === currentUid`.
 *
 * @param {object} tx
 * @param {{ workspaceId?: string, personalViewMode?: boolean, currentUid?: string | null }} context
 * @returns {boolean}
 */
export function isTransactionVisibleInWorkspace(
  tx,
  { workspaceId = 'ws_default', personalViewMode = false, currentUid = null } = {}
) {
  if (workspaceId && workspaceId !== 'all') {
    const txWorkspace = tx.workspaceId || 'ws_default';
    if (txWorkspace !== workspaceId) {
      return false;
    }
  }

  if (personalViewMode && currentUid) {
    const txCreator = tx.createdByUid || tx.ownerUid || currentUid;
    if (txCreator !== currentUid) {
      return false;
    }
  }

  return true;
}

/**
 * Computes period totals and Pisto category ring analytics.
 * @param {object} state
 * @param {object} [options]
 * @param {'today'|'week'|'month'|'all'|'custom'} [options.period]
 * @param {string} [options.accountFilter]
 * @param {string} [options.startDate]
 * @param {string} [options.endDate]
 */
export function computePeriodAnalytics(state, options = {}) {
  const baseCurrency = state.settings?.baseCurrency || 'USD';
  const period = options.period || state.settings?.periodFilter || 'month';
  const accountFilter = options.accountFilter || 'all';
  const currencyFilter = options.currencyFilter || 'all';
  const personalViewMode = Boolean(options.personalViewMode ?? state.settings?.personalViewMode ?? false);
  const currentUid = options.currentUid ?? state.settings?.currentUid ?? null;
  const workspaceId = options.workspaceId ?? state.settings?.workspaceId ?? 'ws_default';
  const startDate =
    options.startDate !== undefined ? options.startDate : (state.settings?.startDate || '');
  const endDate =
    options.endDate !== undefined ? options.endDate : (state.settings?.endDate || '');

  const periodTransactions = filterCleanUserTransactions(state.transactions || [], {
    workspaceId,
    currentUid,
  }).filter((tx) => {
    if (!isDateInPeriod(tx.date, period, new Date(), { startDate, endDate })) return false;
    if (accountFilter !== 'all' && tx.accountId !== accountFilter && tx.toAccountId !== accountFilter) {
      return false;
    }
    if (currencyFilter !== 'all' && tx.currency !== currencyFilter) {
      return false;
    }
    if (!isTransactionVisibleInWorkspace(tx, { workspaceId, personalViewMode, currentUid })) {
      return false;
    }
    return true;
  });

  let totalIncomeCents = 0;
  let totalExpenseCents = 0;
  const spentCentsByCategory = new Map();
  const txCountByCategory = new Map();

  for (const tx of periodTransactions) {
    const amountBase = Money.convert(tx.amount, tx.currency, baseCurrency);
    const cents = Money.toCents(amountBase);

    if (tx.type === TRANSACTION_TYPES.INCOME) {
      totalIncomeCents += cents;
      spentCentsByCategory.set(tx.categoryId, (spentCentsByCategory.get(tx.categoryId) || 0) + cents);
      txCountByCategory.set(tx.categoryId, (txCountByCategory.get(tx.categoryId) || 0) + 1);
    } else if (tx.type === TRANSACTION_TYPES.EXPENSE) {
      totalExpenseCents += cents;
      spentCentsByCategory.set(tx.categoryId, (spentCentsByCategory.get(tx.categoryId) || 0) + cents);
      txCountByCategory.set(tx.categoryId, (txCountByCategory.get(tx.categoryId) || 0) + 1);
    }
  }

  const hasTransactions = periodTransactions.length > 0;
  const totalIncome = hasTransactions ? Money.fromCents(totalIncomeCents) : 0;
  const totalExpenses = hasTransactions ? Money.fromCents(totalExpenseCents) : 0;
  const totalExpense = totalExpenses;
  const netCashflow = hasTransactions ? Money.fromCents(totalIncomeCents - totalExpenseCents) : 0;

  // Guardián matemático simple para Tasa de Ahorro:
  const savingsRate = totalIncome > 0 ? ((totalIncome - totalExpenses) / totalIncome) * 100 : 0;
  const savingsRatePct = calculateSafeSavingsRate(totalIncome, totalExpenses, hasTransactions);

  const expenseCategories = state.categories
    .filter((c) => c.type === TRANSACTION_TYPES.EXPENSE)
    .map((cat) => {
      const amount = Money.fromCents(spentCentsByCategory.get(cat.id) || 0);
      const budgetLimit = Number(state.budgets?.[cat.id] ?? cat.defaultBudget ?? 0);
      const sharePct = totalExpense > 0 ? Math.round((amount / totalExpense) * 100) : 0;
      const budgetPct = budgetLimit > 0 ? Math.round((amount / budgetLimit) * 100) : 0;
      const budgetStatus = budgetLimit <= 0
        ? 'none'
        : budgetPct >= 100
          ? 'exceeded'
          : budgetPct >= 75
            ? 'warning'
            : 'healthy';

      return {
        ...cat,
        amount,
        budgetLimit,
        sharePct,
        budgetPct,
        budgetStatus,
        txCount: txCountByCategory.get(cat.id) || 0,
      };
    });

  const incomeCategories = state.categories
    .filter((c) => c.type === TRANSACTION_TYPES.INCOME)
    .map((cat) => {
      const amount = Money.fromCents(spentCentsByCategory.get(cat.id) || 0);
      const sharePct = totalIncome > 0 ? Math.round((amount / totalIncome) * 100) : 0;
      return {
        ...cat,
        amount,
        sharePct,
        txCount: txCountByCategory.get(cat.id) || 0,
      };
    });

  const totalBudgetLimit = expenseCategories.reduce(
    (acc, c) => Money.add(acc, c.budgetLimit),
    0
  );

  return {
    baseCurrency,
    period,
    currencyFilter,
    personalViewMode,
    currentUid,
    workspaceId,
    totalIncome,
    totalExpense,
    totalExpenses,
    netCashflow,
    savingsRate: savingsRatePct,
    savingsRatePct,
    rawSavingsRate: Number.isFinite(savingsRate) ? savingsRate : 0,
    totalBudgetLimit,
    expenseCategories,
    incomeCategories,
    periodTransactions,
  };
}

/**
 * Groups and filters transactions by date (descending) for the Pisto Ledger view.
 * @param {object} state
 * @param {object} [filters]
 * @param {string} [filters.searchQuery]
 * @param {string} [filters.typeFilter]
 * @param {string} [filters.accountFilter]
 * @param {string} [filters.period]
 * @param {string} [filters.startDate]
 * @param {string} [filters.endDate]
 */
export function groupTransactionsByDay(state, filters = {}) {
  const baseCurrency = state.settings?.baseCurrency || 'USD';
  const query = String(filters.searchQuery || '').trim().toLowerCase();
  const typeFilter = filters.typeFilter || 'all';
  const accountFilter = filters.accountFilter || 'all';
  const currencyFilter = filters.currencyFilter || 'all';
  const personalViewMode = Boolean(filters.personalViewMode ?? state.settings?.personalViewMode ?? false);
  const currentUid = filters.currentUid ?? state.settings?.currentUid ?? null;
  const workspaceId = filters.workspaceId ?? state.settings?.workspaceId ?? 'ws_default';
  const period = filters.period || state.settings?.periodFilter || 'month';
  const startDate =
    filters.startDate !== undefined ? filters.startDate : (state.settings?.startDate || '');
  const endDate =
    filters.endDate !== undefined ? filters.endDate : (state.settings?.endDate || '');

  const categoryMap = new Map(state.categories.map((c) => [c.id, c]));
  const accountMap = new Map(state.accounts.map((a) => [a.id, a]));

  const filtered = state.transactions
    .filter((tx) => {
      if (!isDateInPeriod(tx.date, period, new Date(), { startDate, endDate })) return false;
      if (typeFilter !== 'all' && tx.type !== typeFilter) return false;
      if (accountFilter !== 'all' && tx.accountId !== accountFilter && tx.toAccountId !== accountFilter) {
        return false;
      }
      if (currencyFilter !== 'all' && tx.currency !== currencyFilter) {
        return false;
      }
      if (!isTransactionVisibleInWorkspace(tx, { workspaceId, personalViewMode, currentUid })) {
        return false;
      }
      if (query) {
        const catName = categoryMap.get(tx.categoryId)?.name || '';
        const accName = accountMap.get(tx.accountId)?.name || '';
        const authorTag = (tx.createdByEmail || '').split('@')[0] || '';
        const haystack = `${tx.note} ${catName} ${accName} ${tx.amount} ${authorTag}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (b.date !== a.date) return b.date.localeCompare(a.date);
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });

  const groupsMap = new Map();
  for (const tx of filtered) {
    if (!groupsMap.has(tx.date)) {
      groupsMap.set(tx.date, {
        date: tx.date,
        netCents: 0,
        items: [],
      });
    }
    const group = groupsMap.get(tx.date);
    const amountBase = Money.convert(tx.amount, tx.currency, baseCurrency);
    const cents = Money.toCents(amountBase);

    if (tx.type === TRANSACTION_TYPES.INCOME) {
      group.netCents += cents;
    } else if (tx.type === TRANSACTION_TYPES.EXPENSE) {
      group.netCents -= cents;
    }

    group.items.push({
      ...tx,
      amountBase,
      category: resolveTransactionCategory(tx, categoryMap, state.categories),
      account: accountMap.get(tx.accountId) || { name: 'Cuenta' },
      toAccount: tx.toAccountId ? accountMap.get(tx.toAccountId) : null,
    });
  }

  return Array.from(groupsMap.values()).map((g) => ({
    date: g.date,
    netAmount: Money.fromCents(g.netCents),
    items: g.items,
  }));
}

/**
 * Computes the complete transaction breakdown and period metrics for a single Account,
 * segmented by an optional [startDate, endDate] range or period preset.
 *
 * @param {object} state
 * @param {string} accountId
 * @param {{ startDate?: string, endDate?: string, period?: string, searchQuery?: string }} [filters]
 */
export function computeAccountDetailSummary(state, accountId, filters = {}) {
  const account = state.accounts.find((a) => a.id === accountId);
  if (!account) return null;

  const accountsSummary = computeAccountsSummary(state);
  const accWithBalance = accountsSummary.accountsWithBalance.find((a) => a.id === accountId) || account;

  const period = filters.period || 'all';
  const startDate = String(filters.startDate || '').trim();
  const endDate = String(filters.endDate || '').trim();
  const query = String(filters.searchQuery || '').trim().toLowerCase();

  const categoryMap = new Map(state.categories.map((c) => [c.id, c]));
  const accountMap = new Map(state.accounts.map((a) => [a.id, a]));

  const allAccountTxs = state.transactions.filter(
    (tx) => tx.accountId === accountId || tx.toAccountId === accountId
  );

  let periodIncomeCents = 0;
  let periodExpenseCents = 0;

  const filteredTransactions = allAccountTxs
    .filter((tx) => {
      if (!isDateInPeriod(tx.date, period, new Date(), { startDate, endDate })) return false;
      if (query) {
        const catName = categoryMap.get(tx.categoryId)?.name || '';
        const haystack = `${tx.note || ''} ${catName} ${tx.amount} ${tx.date}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (b.date !== a.date) return b.date.localeCompare(a.date);
      return String(b.createdAt).localeCompare(String(a.createdAt));
    })
    .map((tx) => {
      const amountInAccountCur = Money.convert(tx.amount, tx.currency, account.currency);
      const centsInAcc = Money.toCents(amountInAccountCur);

      const isTransfer = tx.type === TRANSACTION_TYPES.TRANSFER;
      const isIncomingTransfer = isTransfer && tx.toAccountId === accountId;
      const isIncome = tx.type === TRANSACTION_TYPES.INCOME || isIncomingTransfer;

      if (isIncome) {
        periodIncomeCents += centsInAcc;
      } else {
        periodExpenseCents += centsInAcc;
      }

      return {
        ...tx,
        isTransfer,
        isIncomingTransfer,
        isPositiveForAccount: isIncome,
        amountInAccountCur,
        amountInAccountCurrency: amountInAccountCur,
        category: resolveTransactionCategory(tx, categoryMap, state.categories),
        account: accountMap.get(tx.accountId) || { name: 'Cuenta' },
        toAccount: tx.toAccountId ? accountMap.get(tx.toAccountId) : null,
      };
    });

  return {
    account: accWithBalance,
    currentBalance: accWithBalance.currentBalance ?? 0,
    totalTxCount: allAccountTxs.length,
    filteredCount: filteredTransactions.length,
    periodIncome: Money.fromCents(periodIncomeCents),
    periodExpense: Money.fromCents(periodExpenseCents),
    periodNet: Money.fromCents(periodIncomeCents - periodExpenseCents),
    transactions: filteredTransactions,
  };
}

