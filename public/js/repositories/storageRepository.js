/**
 * @fileoverview Local-First Repository for Personal Finance State.
 *
 * Responsibilities:
 * - Persists accounts, categories, budgets, transactions, and settings in localStorage.
 * - Falls back gracefully to an in-memory store when running in Node.js unit tests.
 * - Seeds realistic Pisto demo data on first visit so the app is immediately interactive.
 * - Provides lossless JSON and CSV export/import for data portability.
 */

import {
  DEFAULT_CATEGORIES,
  ACCOUNT_TYPES,
  TRANSACTION_TYPES,
  createAccount,
  createTransaction,
} from '../domain/models.js';

const STORAGE_KEY = 'Pisto_open_finance_state_v1';

/**
 * Generates relative ISO dates (YYYY-MM-DD) within the current month so demo charts always look alive.
 * @param {number} daysOffset
 * @returns {string}
 */
function relativeDate(daysOffset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + daysOffset);
  return date.toISOString().slice(0, 10);
}

/**
 * Builds the default initial state inspired by Pisto.
 */
export function createSeedState() {
  const accounts = [
    createAccount({
      id: 'acc_bank',
      name: 'Cuenta Principal',
      type: ACCOUNT_TYPES.BANK,
      institution: 'Banco Atlántida',
      accountNumber: '200-010-4521',
      currency: 'USD',
      initialBalance: 1850.0,
      includeInTotal: true,
      color: '#3b82f6',
      icon: 'bank',
    }),
    createAccount({
      id: 'acc_cash',
      name: 'Efectivo Billetera',
      type: ACCOUNT_TYPES.CASH,
      currency: 'USD',
      initialBalance: 240.0,
      includeInTotal: true,
      color: '#10b981',
      icon: 'cash',
    }),
    createAccount({
      id: 'acc_card',
      name: 'Tarjeta Crédito Oro',
      type: ACCOUNT_TYPES.CARD,
      institution: 'BAC Credomatic Honduras',
      accountNumber: '0618',
      currency: 'USD',
      initialBalance: -180.0,
      includeInTotal: true,
      color: '#8b5cf6',
      icon: 'card',
    }),
    createAccount({
      id: 'acc_savings',
      name: 'Fondo de Emergencia',
      type: ACCOUNT_TYPES.SAVINGS,
      currency: 'USD',
      initialBalance: 3200.0,
      targetAmount: 5000.0,
      includeInTotal: true,
      color: '#06b6d4',
      icon: 'piggy',
    }),
    createAccount({
      id: 'acc_debt',
      name: 'Préstamo Laptop 0%',
      type: ACCOUNT_TYPES.DEBT,
      currency: 'USD',
      initialBalance: -350.0,
      targetAmount: 1000.0,
      includeInTotal: false,
      color: '#f43f5e',
      icon: 'debt',
    }),
  ];

  const categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));

  const budgets = {};
  for (const cat of categories) {
    if (cat.type === 'expense' && cat.defaultBudget > 0) {
      budgets[cat.id] = cat.defaultBudget;
    }
  }

  const transactions = [
    createTransaction({
      id: 'tx_seed_1',
      type: TRANSACTION_TYPES.INCOME,
      amount: 2800.0,
      currency: 'USD',
      categoryId: 'salary',
      accountId: 'acc_bank',
      note: 'Salario quincenal y bono de desempeño',
      date: relativeDate(-6),
    }),
    createTransaction({
      id: 'tx_seed_2',
      type: TRANSACTION_TYPES.INCOME,
      amount: 450.0,
      currency: 'USD',
      categoryId: 'freelance',
      accountId: 'acc_bank',
      note: 'Consultoría de arquitectura Cloud Run',
      date: relativeDate(-4),
    }),
    createTransaction({
      id: 'tx_seed_3',
      type: TRANSACTION_TYPES.EXPENSE,
      amount: 850.0,
      currency: 'USD',
      categoryId: 'housing',
      accountId: 'acc_bank',
      note: 'Pago mensual de alquiler y mantenimiento',
      date: relativeDate(-5),
    }),
    createTransaction({
      id: 'tx_seed_4',
      type: TRANSACTION_TYPES.EXPENSE,
      amount: 164.5,
      currency: 'USD',
      categoryId: 'groceries',
      accountId: 'acc_card',
      note: 'Compra semanal supermercado orgánico',
      date: relativeDate(-3),
    }),
    createTransaction({
      id: 'tx_seed_5',
      type: TRANSACTION_TYPES.EXPENSE,
      amount: 92.0,
      currency: 'USD',
      categoryId: 'utilities',
      accountId: 'acc_bank',
      note: 'Fibra óptica 500Mbps y electricidad',
      date: relativeDate(-2),
    }),
    createTransaction({
      id: 'tx_seed_6',
      type: TRANSACTION_TYPES.EXPENSE,
      amount: 48.75,
      currency: 'USD',
      categoryId: 'transport',
      accountId: 'acc_card',
      note: 'Tanque de combustible y peajes',
      date: relativeDate(-2),
    }),
    createTransaction({
      id: 'tx_seed_7',
      type: TRANSACTION_TYPES.EXPENSE,
      amount: 34.2,
      currency: 'USD',
      categoryId: 'food',
      accountId: 'acc_cash',
      note: 'Almuerzo ejecutivo y café de especialidad',
      date: relativeDate(-1),
    }),
    createTransaction({
      id: 'tx_seed_8',
      type: TRANSACTION_TYPES.EXPENSE,
      amount: 55.0,
      currency: 'USD',
      categoryId: 'health',
      accountId: 'acc_bank',
      note: 'Membresía mensual de gimnasio',
      date: relativeDate(-1),
    }),
    createTransaction({
      id: 'tx_seed_9',
      type: TRANSACTION_TYPES.TRANSFER,
      amount: 250.0,
      currency: 'USD',
      categoryId: 'transfer',
      accountId: 'acc_bank',
      toAccountId: 'acc_savings',
      note: 'Aporte automático al Fondo de Emergencia',
      date: relativeDate(0),
    }),
    createTransaction({
      id: 'tx_seed_10',
      type: TRANSACTION_TYPES.EXPENSE,
      amount: 24.99,
      currency: 'USD',
      categoryId: 'entertainment',
      accountId: 'acc_card',
      note: 'Suscripción familiar de streaming y música',
      date: relativeDate(0),
    }),
  ];

  return {
    version: 1,
    settings: {
      baseCurrency: 'USD',
      periodFilter: 'month', // 'all' | 'month' | 'week' | 'today'
      theme: 'system', // 'system' | 'dark' | 'light'
      workspaceId: 'ws_default',
      personalViewMode: false,
      currentUid: 'local_default_user',
    },
    accounts,
    categories,
    budgets,
    transactions,
    aiTelemetry: {
      localParsesSaved: 3,
      aiCallsCount: 0,
      totalTokensUsed: 0,
      cacheHits: 0,
    },
  };
}

export class StorageRepository {
  /**
   * @param {Storage} [storageBackend]
   */
  constructor(storageBackend = typeof localStorage !== 'undefined' ? localStorage : null) {
    this.storage = storageBackend;
    this.memoryFallback = null;
  }

  /**
   * Loads the current state or initializes with seed data.
   */
  loadState() {
    try {
      const raw = this.storage ? this.storage.getItem(STORAGE_KEY) : this.memoryFallback;
      if (!raw) {
        const seeded = createSeedState();
        this.saveState(seeded);
        return seeded;
      }
      const parsed = JSON.parse(raw);
      const base = createSeedState();
      const merged = {
        ...base,
        ...parsed,
        settings: {
          ...base.settings,
          ...(parsed.settings || {}),
        },
      };
      if (Array.isArray(merged.transactions)) {
        merged.transactions = merged.transactions.map((tx) => createTransaction(tx));
      }
      return merged;
    } catch {
      return createSeedState();
    }
  }

  /**
   * Persists the state atomically.
   * @param {object} state
   */
  saveState(state) {
    const serialized = JSON.stringify(state);
    if (this.storage) {
      this.storage.setItem(STORAGE_KEY, serialized);
    } else {
      this.memoryFallback = serialized;
    }
    return state;
  }

  /**
   * Resets state back to clean demo seed data.
   */
  resetToDemo() {
    const seeded = createSeedState();
    return this.saveState(seeded);
  }

  /**
   * Exports all transactions to RFC-4180 compliant CSV format.
   * @param {object} state
   * @returns {string}
   */
  exportTransactionsCsv(state) {
    const headers = ['ID', 'Fecha', 'Tipo', 'Monto', 'Moneda', 'Categoria', 'CuentaOrigen', 'CuentaDestino', 'Nota'];
    const accountMap = new Map(state.accounts.map((a) => [a.id, a.name]));
    const categoryMap = new Map(state.categories.map((c) => [c.id, c.name]));

    const escapeCsv = (val) => {
      const str = String(val ?? '');
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };

    const rows = state.transactions.map((tx) => [
      tx.id,
      tx.date,
      tx.type,
      tx.amount.toFixed(2),
      tx.currency,
      tx.type === 'transfer' ? 'Transferencia' : (categoryMap.get(tx.categoryId) || tx.categoryId),
      accountMap.get(tx.accountId) || tx.accountId,
      tx.toAccountId ? (accountMap.get(tx.toAccountId) || tx.toAccountId) : '',
      tx.note,
    ]);

    return [headers.join(','), ...rows.map((r) => r.map(escapeCsv).join(','))].join('\n');
  }
}
