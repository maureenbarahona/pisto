/**
 * @fileoverview Automated Unit & Integration Test Suite for Pisto Open-Finance.
 *
 * Tests:
 * 1. Exact integer-cents arithmetic (Money Value Object) & multi-currency conversion.
 * 2. Account balance computation (income, expense, transfers, includeInTotal).
 * 3. Pisto Category Donut & Budget threshold analytics.
 * 4. 0-Token Local Heuristic NLP Parser & Micro-Payload Token Compressor.
 * 5. Pisto Calculator Keypad arithmetic evaluator.
 * 6. Genkit AI Flows deterministic fallback & SHA-256 cache hits.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  Money,
  CURRENCIES,
  HONDURAS_FINANCIAL_ENTITIES,
  createTransaction,
  createAccount,
  createCategory,
  extractLast4Digits,
  TRANSACTION_TYPES,
  ACCOUNT_TYPES,
} from '../public/js/domain/models.js';
import {
  createSeedState,
  createCleanWorkspaceState,
} from '../public/js/repositories/storageRepository.js';
import {
  isDateInPeriod,
  computeAccountsSummary,
  computeAccountDetailSummary,
  computePeriodAnalytics,
  groupTransactionsByDay,
} from '../public/js/services/financeService.js';
import {
  parseNaturalLanguageLocal,
  buildMicroPayload,
} from '../public/js/services/tokenOptimizerService.js';
import {
  parseVoucherText,
  parseBankStatementText,
  findDuplicateTransaction,
} from '../public/js/services/voucherOcrService.js';
import { evaluateKeypadExpression } from '../public/js/ui/keypadModal.js';
import {
  executeSmartParse,
  executeFinancialInsights,
} from '../server/ai/genkitFlows.js';
import {
  FirebaseAuthProfileService,
  GeminiKeyLocalStore,
  createUserProfile,
  buildWorkspaceTransactionIndex,
  filterTransactionsForUserView,
  prepareTransactionForWorkspace,
  buildWorkspaceTransactionsQuery,
  fetchWorkspaceTransactions,
  subscribeWorkspaceTransactions,
  saveTransactionToWorkspace,
  getTransactionsByAccountId,
  deleteAccountAndTransactionsWriteBatch,
  filterActiveAccounts,
  filterArchivedAccounts,
  filterAccountsForView,
  archiveAccount,
  unarchiveAccount,
  deleteAccountWithCascade,
  FIRESTORE_COLLECTIONS,
  DUPLICATE_TRANSACTION_ACTIONS,
  DUPLICATE_TRANSACTION_OPTION_LABELS,
  normalizeFirestoreDocument,
  queryCollectionWithCursor,
  normalizeTransactionConcept,
  isSimilarTransactionConcept,
  formatDateDdMmYyyy,
  formatDuplicateTransactionWarning,
  findAccountDuplicateTransactions,
  checkAccountTransactionDuplicate,
  resolveDuplicateTransactionAction,
} from '../src/js/services/firestore.js';
import { DeleteAccountModal } from '../public/js/ui/deleteAccountModal.js';
import {
  AccountsView,
  createAccountsView,
  ImportAccountModal,
  IMPORT_ACCOUNT_BUTTON_ID,
  IMPORT_ACCOUNT_BUTTON_LABEL,
  getIsImportAccountModalOpen,
  setIsImportAccountModalOpen,
  sanitizeClickableAncestors,
  renderAccountsViewTemplate,
  openImportModal,
  bindImportAccountTriggerButtons,
  persistImportedAccountAndTransactions,
} from '../public/js/ui/accountsTab.js';
import {
  OnboardingWizard,
  createOnboardingWizard,
  shouldTriggerOnboarding,
  ensureCleanWorkspaceForFirstTimeUser,
  completeUserOnboarding,
  renderOnboardingStepMarkup,
  renderDashboardEmptyStateMarkup,
  ONBOARDING_STEPS,
  ONBOARDING_WIZARD_DIALOG_ID,
  ONBOARDING_FINISH_BUTTON_ID,
  ONBOARDING_FINISH_BUTTON_LABEL,
  EMPTY_STATE_CTA_LABELS,
} from '../src/js/components/OnboardingWizard.js';
import { handleRequest } from '../server/index.js';
import http from 'node:http';
import fs from 'node:fs/promises';

describe('Domain Models & Money Integer-Cents Math', () => {
  it('avoids IEEE-754 floating point drift on addition and subtraction', () => {
    assert.equal(Money.add(0.1, 0.2), 0.3);
    assert.equal(Money.subtract(10.0, 3.35), 6.65);
    assert.equal(Money.toCents('19,99'), 1999);
  });

  it('converts currencies accurately through USD base rate including HNL (Lempiras)', () => {
    assert.equal(CURRENCIES.HNL.symbol, 'L');
    const hnlToUsd = Money.convert(1000, 'HNL', 'USD');
    assert.equal(hnlToUsd, 40.3);
    const eurToUsd = Money.convert(100, 'EUR', 'USD');
    assert.equal(eurToUsd, 108);
    const sameCur = Money.convert(42.5, 'HNL', 'HNL');
    assert.equal(sameCur, 42.5);
  });

  it('validates transaction, account (with Honduran financial institutions & accountNumber) and category creation invariants', () => {
    assert.throws(() => createTransaction({ amount: 0, type: 'expense' }), /mayor que cero/);
    assert.throws(
      () => createTransaction({ amount: 50, type: 'transfer', accountId: 'acc_1', toAccountId: 'acc_1' }),
      /cuenta de destino distinta/
    );
    assert.throws(() => createCategory({ name: '' }), /obligatorio/);

    assert.ok(HONDURAS_FINANCIAL_ENTITIES.bancos.includes('Banco Atlántida'));
    assert.ok(HONDURAS_FINANCIAL_ENTITIES.bancos.includes('BAC Credomatic Honduras'));
    assert.ok(HONDURAS_FINANCIAL_ENTITIES.cooperativas.includes('Cooperativa Sagrada Familia'));
    assert.ok(HONDURAS_FINANCIAL_ENTITIES.cooperativas.includes('Cooperativa ELGA'));

    const hnAcc = createAccount({
      name: 'Ahorro Lempiras',
      type: ACCOUNT_TYPES.BANK,
      institution: 'Cooperativa Sagrada Familia',
      accountNumber: '200-010-0618',
      currency: 'HNL',
      initialBalance: 15000,
    });
    assert.equal(hnAcc.institution, 'Cooperativa Sagrada Familia');
    assert.equal(hnAcc.accountNumber, '200-010-0618');
    assert.equal(extractLast4Digits(hnAcc.accountNumber), '0618');
    assert.equal(hnAcc.currency, 'HNL');

    const customCat = createCategory({
      id: 'cat_remesas',
      name: 'Remesas Honduras',
      type: 'income',
      color: '#06b6d4',
      icon: 'gift',
      defaultBudget: 500,
    });
    assert.equal(customCat.id, 'cat_remesas');
    assert.equal(customCat.defaultBudget, 0); // Income category resets budget to 0
  });
});

describe('Open-Source ML Voucher & PDF Invoice Decoder (BAC Credomatic POS)', () => {
  it('decodes BAC Credomatic Honduras voucher (PRICE SMART TEG, *0618, OCT 15 26, L252.29) and associates category & account', () => {
    const state = createSeedState();
    const bacVoucherText = `
      BAC CREDOMATIC
      SW: CCREKPS020405 REV. 120226
      VENTAS
      PRICE SMART TEG
      GRACIAS POR PREFERIRNOS
      BAC
      CAJERO: 3316 / 3316
      COMPRA
      CREDOMATIC ************0618-L
      AUTO: 620880 FACT: 034074
      REF.: 69721072 FECHA: OCT 15, 26 - 11:55
      MONTO: L221.70
      ISV: L33.25
      DEVOL.ISV: -L2.66
      TOTAL L252.29
      ** VALIDO SIN FIRMA **
      MASTERCARD
    `;

    const decoded = parseVoucherText(bacVoucherText, state);
    assert.equal(decoded.merchant, 'PRICE SMART TEG');
    assert.equal(decoded.categoryId, 'groceries'); // Supermercado
    assert.equal(decoded.date, '2026-10-15');
    assert.equal(decoded.amount, 252.29);
    assert.equal(decoded.currency, 'HNL');
    assert.equal(decoded.cardLast4, '0618');
    assert.equal(decoded.accountId, 'acc_card'); // Matched via accountNumber '0618'
    assert.equal(decoded.accountMatchType, 'account_number');
    assert.equal(decoded.breakdown.subtotal, 221.7);
    assert.equal(decoded.breakdown.isv, 33.25);
    assert.equal(decoded.breakdown.devolIsv, 2.66);
  });

  it('reconciles noisy OCR where L is misread as 1 (1252.29 -> 252.29) and O6I8 -> 0618', () => {
    const state = createSeedState();
    const noisyOcrText = `
      VENTAS
      PRICE SHART TE6
      COMPRA
      CREDOMATIC ****O6I8-L
      FECHA: 0CT 15, 26 - 11:55
      MONTO: 1221.70
      ISV: L33.25
      DEVOL.ISV: -L2.66
      TOTAL 1252.29
    `;
    const decoded = parseVoucherText(noisyOcrText, state);
    assert.equal(decoded.merchant, 'PRICE SMART TEG');
    assert.equal(decoded.categoryId, 'groceries');
    assert.equal(decoded.cardLast4, '0618');
    assert.equal(decoded.accountId, 'acc_card');
    assert.equal(decoded.date, '2026-10-15');
    assert.equal(decoded.amount, 252.29);
    assert.equal(decoded.currency, 'HNL');
  });

  it('parses BAC Credomatic PDF Bank Statement rows (HNL & USD) and flags previously uploaded vouchers as duplicates', () => {
    const state = createSeedState();
    // Simulate a voucher already uploaded by the user on SEP/06 for RESTAURANTE PALACIO REAL (L 569.00) on acc_card
    const existingVoucherTx = createTransaction({
      type: TRANSACTION_TYPES.EXPENSE,
      amount: 569.0,
      currency: 'HNL',
      categoryId: 'food',
      accountId: 'acc_card',
      date: '2026-09-06',
      note: 'RESTAURANTE PALACIO REAL · Tarjeta *0618',
    });
    state.transactions.unshift(existingVoucherTx);

    const bacStatementPdfText = `
      BAC Credomatic jamás te solicitará contraseñas por redes sociales
      Tarjeta de crédito ****0618
      No. de referencia Fecha Concepto Lempiras Dólares
      11 0901101124149005 SEP/01 TUTIS MALL MULTIPLAZA 325.98
      11 0902101380549003 SEP/02 CLARO PI 88051487 18:11 969.00
      11 0903991008019056 SEP/03 TAQUERIA HIDALGO TEGUCIGALPA HND 343.38
      11 0903991008010077 SEP/03 DISNEYPLUS.COM BURBANK 02:13 $11.49
      11 0904991008019096 SEP/04 PLATINUM GYM AND FITNETEGUCIGA 23:23 592.75
      11 0906101989759001 SEP/06 RESTAURANTE PALACIO REAL 569.00
      11 0907101182529000 SEP/07 FARMACIA SIMAN TEG 21 23:09 376.90
      11 0908991008019078 SEP/08 Puma Energy HN PUMA SAHonduras 14:49 1,064.40
      11 0909101415279006 SEP/09 SUPERMERCADO DELIKATESSEN 805.68
      11 0910101653639026 SEP/10 UNAH MATRICULAS 23:58 270.00
      11 0913991008010087 SEP/13 TEMU.COM DUBLIN 2 IRL 365.72
      11 0914991008010054 SEP/14 SUPERMERCADOS LA COLONTegucigalpa HND 116.10
      Producto Monto Otorgado Cuota Aplicada No.Cuota Tasa % Plazo Saldo al Corte
      SEGUROS CREFISA EXT1 14,990.00 1,249.10 9 12 3,748.10
      DIUNSA METROMALL EXT 8,500.37 708.30 1 12 7,792.07
    `;

    const parsedStmt = parseBankStatementText(bacStatementPdfText, state, {
      targetAccountId: 'acc_card',
      fallbackYear: 2026,
    });

    assert.equal(parsedStmt.detectedBank, 'BAC Credomatic Honduras');
    assert.equal(parsedStmt.cardLast4, '0618');
    assert.equal(parsedStmt.targetAccountId, 'acc_card');
    assert.equal(parsedStmt.items.length, 12); // Excludes bottom installment summary rows

    const disneyRow = parsedStmt.items.find((it) => it.concept.includes('DISNEYPLUS.COM'));
    assert.ok(disneyRow);
    assert.equal(disneyRow.currency, 'USD');
    assert.equal(disneyRow.amount, 11.49);
    assert.equal(disneyRow.categoryId, 'entertainment');
    assert.equal(disneyRow.isDuplicate, false);
    assert.equal(disneyRow.selected, true);

    const pumaRow = parsedStmt.items.find((it) => it.concept.includes('Puma Energy'));
    assert.ok(pumaRow);
    assert.equal(pumaRow.currency, 'HNL');
    assert.equal(pumaRow.amount, 1064.4);
    assert.equal(pumaRow.categoryId, 'transport');

    const palacioRow = parsedStmt.items.find((it) => it.concept.includes('RESTAURANTE PALACIO REAL'));
    assert.ok(palacioRow);
    assert.equal(palacioRow.date, '2026-09-06');
    assert.equal(palacioRow.amount, 569.0);
    assert.equal(palacioRow.currency, 'HNL');
    assert.equal(palacioRow.isDuplicate, true);
    assert.equal(palacioRow.duplicateType, 'exact');
    assert.equal(palacioRow.selected, false); // Pre-unchecked to avoid duplicate!

    const directDupCheck = findDuplicateTransaction(palacioRow, state.transactions, 'acc_card');
    assert.equal(directDupCheck.isDuplicate, true);
    assert.equal(directDupCheck.duplicateTx.id, existingVoucherTx.id);
  });
});

describe('Finance Service: Balances, Transfers & Budgets', () => {
  it('computes multi-account balances and transfers accurately', () => {
    const customState = {
      settings: { baseCurrency: 'USD', periodFilter: 'all' },
      accounts: [
        createAccount({ id: 'a1', name: 'Banco', type: ACCOUNT_TYPES.BANK, initialBalance: 1000, includeInTotal: true }),
        createAccount({ id: 'a2', name: 'Ahorro', type: ACCOUNT_TYPES.SAVINGS, initialBalance: 500, targetAmount: 1000, includeInTotal: true }),
      ],
      categories: createSeedState().categories,
      budgets: { groceries: 300 },
      transactions: [
        createTransaction({ type: TRANSACTION_TYPES.EXPENSE, amount: 120.5, accountId: 'a1', categoryId: 'groceries' }),
        createTransaction({ type: TRANSACTION_TYPES.TRANSFER, amount: 200, accountId: 'a1', toAccountId: 'a2' }),
      ],
    };

    const summary = computeAccountsSummary(customState);
    const bank = summary.accountsWithBalance.find((a) => a.id === 'a1');
    const savings = summary.accountsWithBalance.find((a) => a.id === 'a2');

    assert.equal(bank.currentBalance, 679.5);
    assert.equal(savings.currentBalance, 700);
    assert.equal(savings.goalProgressPct, 70);
    assert.equal(summary.totalIncludedBalance, 1379.5);
  });

  it('computes Pisto category analytics and budget status', () => {
    const seed = createSeedState();
    const analytics = computePeriodAnalytics(seed, { period: 'all' });

    assert.ok(analytics.totalIncome > 0);
    assert.ok(analytics.totalExpense > 0);
    assert.equal(analytics.netCashflow, Money.subtract(analytics.totalIncome, analytics.totalExpense));

    const housing = analytics.expenseCategories.find((c) => c.id === 'housing');
    assert.equal(housing.amount, 850);
    assert.equal(housing.budgetStatus, 'warning'); // 850 / 950 = 89%

    const groups = groupTransactionsByDay(seed, { period: 'all' });
    assert.ok(groups.length >= 4);
  });
});

describe('Token Optimizer Service & Pisto Keypad Evaluator', () => {
  it('parses natural language transactions locally using 0 AI tokens', () => {
    const state = createSeedState();
    const parsed = parseNaturalLanguageLocal('24.50 almuerzo restaurante con tarjeta', state);

    assert.equal(parsed.parsed, true);
    assert.equal(parsed.confidence, 'high');
    assert.equal(parsed.transaction.amount, 24.5);
    assert.equal(parsed.transaction.categoryId, 'food');
    assert.equal(parsed.transaction.accountId, 'acc_card');
    assert.ok(parsed.tokensSaved > 40);
  });

  it('compresses ledger into a <75-token micro-payload for Genkit', () => {
    const state = createSeedState();
    const accountsSummary = computeAccountsSummary(state);
    const analytics = computePeriodAnalytics(state, { period: 'all' });
    const micro = buildMicroPayload(state, analytics, accountsSummary);

    assert.ok(micro.compactTokensEstimate < 75);
    assert.ok(micro.savingsPct > 70);
    assert.equal(micro.compactPayload.c, 'USD');
  });

  it('evaluates Pisto keypad arithmetic expressions safely', () => {
    assert.equal(evaluateKeypadExpression('12.50+7.50'), 20);
    assert.equal(evaluateKeypadExpression('10+5×4'), 30);
    assert.equal(evaluateKeypadExpression('100÷4-5'), 20);
  });
});

describe('Genkit Flows & SHA-256 Deduplication Cache', () => {
  it('parses multi-clause inputs and caches identical calls with 0 extra tokens', async () => {
    const res1 = await executeSmartParse({
      text: 'Gasté 45 en supermercado y 15 en uber',
    });
    assert.equal(res1.items.length, 2);
    assert.equal(res1.items[0].categoryId, 'groceries');
    assert.equal(res1.items[1].categoryId, 'transport');

    const res2 = await executeSmartParse({
      text: 'Gasté 45 en supermercado y 15 en uber',
    });
    assert.equal(res2.cached, true);
    assert.equal(res2.tokensUsed, 0);
  });

  it('generates financial insights from compressed micro-payload', async () => {
    const insights = await executeFinancialInsights({
      compactPayload: {
        c: 'USD',
        i: 3250,
        e: 1270,
        s: 61,
        cats: [['Vivienda', 850, 950], ['Supermercado', 165, 450]],
        d: 350,
        g: 3200,
      },
    });

    assert.ok(insights.score >= 70);
    assert.ok(Array.isArray(insights.tips));
    assert.ok(insights.tips.length > 0);
    assert.ok(insights.savingOpportunity.length > 10);
  });
});

describe('Cloud Run HTTP Server Endpoints', () => {
  it('serves /healthz, /api/ai/status and static index.html with security headers', async () => {
    const server = http.createServer(handleRequest);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const healthRes = await fetch(`${baseUrl}/healthz`);
      assert.equal(healthRes.status, 200);
      assert.equal(healthRes.headers.get('x-content-type-options'), 'nosniff');
      const healthJson = await healthRes.json();
      assert.equal(healthJson.status, 'ok');

      const statusRes = await fetch(`${baseUrl}/api/ai/status`);
      assert.equal(statusRes.status, 200);
      const statusJson = await statusRes.json();
      assert.equal(typeof statusJson.model, 'string');

      const htmlRes = await fetch(`${baseUrl}/`);
      assert.equal(htmlRes.status, 200);
      const htmlText = await htmlRes.text();
      assert.ok(htmlText.includes('Pisto'));
      assert.ok(htmlText.includes('tab-btn-profile'));

      // Verify that Vanilla ESNext modules and CSS3 from /src/ are served with proper MIME types
      const jsRes = await fetch(`${baseUrl}/src/js/services/firestore.js`);
      assert.equal(jsRes.status, 200);
      assert.ok((jsRes.headers.get('content-type') || '').includes('javascript'));
      const jsBody = await jsRes.text();
      assert.ok(jsBody.includes('checkAccountTransactionDuplicate'));

      const cssRes = await fetch(`${baseUrl}/src/css/styles.css`);
      assert.equal(cssRes.status, 200);
      assert.ok((cssRes.headers.get('content-type') || '').includes('css'));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('Account Detail View & Custom Date Range Filtering', () => {
  it('computes detailed account transactions and segments by custom date range', () => {
    const state = createSeedState();
    const bacCard = createAccount({
      id: 'acc_bac_plat',
      name: 'Economia- Platinum',
      type: ACCOUNT_TYPES.CARD,
      institution: 'BAC Credomatic Honduras',
      accountNumber: '0618',
      currency: 'HNL',
      initialBalance: 0,
    });
    state.accounts.push(bacCard);

    state.transactions.push(
      createTransaction({
        id: 'tx_sep_01',
        type: TRANSACTION_TYPES.EXPENSE,
        amount: 325.98,
        currency: 'HNL',
        categoryId: 'food',
        accountId: 'acc_bac_plat',
        date: '2026-09-01',
        note: '2953 RESTAURANTE EL MORITO',
      }),
      createTransaction({
        id: 'tx_sep_05',
        type: TRANSACTION_TYPES.EXPENSE,
        amount: 2149.1,
        currency: 'HNL',
        categoryId: 'groceries',
        accountId: 'acc_bac_plat',
        date: '2026-09-05',
        note: 'LA COLONIA NO 1 TGU',
      }),
      createTransaction({
        id: 'tx_sep_14',
        type: TRANSACTION_TYPES.EXPENSE,
        amount: 2443.4,
        currency: 'HNL',
        categoryId: 'groceries',
        accountId: 'acc_bac_plat',
        date: '2026-09-14',
        note: 'PAIZ MULTIPLAZA TGU',
      })
    );

    // 1. All transactions for the account
    const fullDetail = computeAccountDetailSummary(state, 'acc_bac_plat', { period: 'all' });
    assert.ok(fullDetail);
    assert.equal(fullDetail.totalTxCount, 3);
    assert.equal(fullDetail.filteredCount, 3);
    assert.equal(fullDetail.currentBalance, -4918.48);
    assert.equal(fullDetail.periodExpense, 4918.48);

    // 2. Filtered by custom date range (2026-09-01 to 2026-09-06)
    const rangeDetail = computeAccountDetailSummary(state, 'acc_bac_plat', {
      startDate: '2026-09-01',
      endDate: '2026-09-06',
    });
    assert.equal(rangeDetail.totalTxCount, 3);
    assert.equal(rangeDetail.filteredCount, 2);
    assert.equal(rangeDetail.periodExpense, 2475.08);
    // Overall card balance remains accurate while period KPIs reflect the range
    assert.equal(rangeDetail.currentBalance, -4918.48);

    // 3. Dashboard ledger segmentation with custom date range and accountFilter
    const ledgerGroups = groupTransactionsByDay(state, {
      accountFilter: 'acc_bac_plat',
      startDate: '2026-09-04',
      endDate: '2026-09-15',
    });
    const totalFilteredLedgerItems = ledgerGroups.reduce((sum, g) => sum + g.items.length, 0);
    assert.equal(totalFilteredLedgerItems, 2);
  });

  it('parses split-token PDF statement rows accurately', () => {
    const state = createSeedState();
    const rawSplitPdfText = `
      BAC Credomatic Honduras
      5491-33XX-XXXX-0618
      SEP / 01 112649809 2953 RESTAURANTE EL MORITO 325.98 0.00
      SEP / 02 25277867 9999 GOOGLE YouTubePremium 0.00 $ 11.49
      10 / SEP / 2026 26630429 9999 DLOCAL*DISNEY PLUS 420.99 0.00
    `;
    const parsed = parseBankStatementText(rawSplitPdfText, state, { fallbackYear: 2026 });
    assert.equal(parsed.items.length, 3);
    assert.equal(parsed.items[0].date, '2026-09-01');
    assert.equal(parsed.items[0].amount, 325.98);
    assert.equal(parsed.items[0].currency, 'HNL');
    assert.equal(parsed.items[1].date, '2026-09-02');
    assert.equal(parsed.items[1].amount, 11.49);
    assert.equal(parsed.items[1].currency, 'USD');
    assert.equal(parsed.items[2].date, '2026-09-10');
    assert.equal(parsed.items[2].amount, 420.99);
    assert.equal(parsed.items[2].currency, 'HNL');
  });

  it('updates existing transaction attributes in-place and resolves unmapped expense categories safely', () => {
    const state = createSeedState();
    const originalTx = createTransaction({
      id: 'tx_edit_target',
      type: TRANSACTION_TYPES.EXPENSE,
      amount: 252.29,
      currency: 'HNL',
      categoryId: 'groceries',
      accountId: 'acc_card',
      date: '2026-10-16',
      note: 'PRICE SMART TEG J',
      createdAt: '2026-10-16T10:00:00.000Z',
    });
    state.transactions.unshift(originalTx);

    // Modify attributes (amount, categoryId, date, note, accountId) preserving id and createdAt
    const updatedTx = createTransaction({
      ...originalTx,
      amount: 310.5,
      currency: 'HNL',
      categoryId: 'health',
      accountId: 'acc_bank',
      date: '2026-10-15',
      note: 'FARMACITY VILLAS DEL SOL',
      id: originalTx.id,
      createdAt: originalTx.createdAt,
    });
    state.transactions[0] = updatedTx;

    assert.equal(state.transactions[0].id, 'tx_edit_target');
    assert.equal(state.transactions[0].createdAt, '2026-10-16T10:00:00.000Z');
    assert.equal(state.transactions[0].amount, 310.5);
    assert.equal(state.transactions[0].categoryId, 'health');
    assert.equal(state.transactions[0].accountId, 'acc_bank');
    assert.equal(state.transactions[0].date, '2026-10-15');
    assert.equal(state.transactions[0].note, 'FARMACITY VILLAS DEL SOL');

    const groups = groupTransactionsByDay(state, { period: 'all' });
    const editedItem = groups.flatMap((g) => g.items).find((it) => it.id === 'tx_edit_target');
    assert.ok(editedItem);
    assert.equal(editedItem.category.name, 'Salud y Gym');
    assert.equal(editedItem.account.id, 'acc_bank');
  });
});

describe('Firebase Auth, Firestore Profile (users/{uid}) & Dashboard Currency/Personal View Filtering', () => {
  function createMemoryStorage() {
    const map = new Map();
    return {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, val) => map.set(key, String(val)),
      removeItem: (key) => map.delete(key),
    };
  }

  it('stores and retrieves Gemini API Key in localStorage without persisting it to Firestore profile', () => {
    const storage = createMemoryStorage();
    const keyStore = new GeminiKeyLocalStore(storage);

    assert.equal(keyStore.hasApiKey(), false);
    keyStore.setApiKey('  AIzaSyDemoBrowserKey123456789  ');
    assert.equal(keyStore.hasApiKey(), true);
    assert.equal(keyStore.getApiKey(), 'AIzaSyDemoBrowserKey123456789');

    keyStore.setApiKey('');
    assert.equal(keyStore.hasApiKey(), false);
  });

  it('supports Email/Password registration, Google Sign-In, and persists profile in users/{uid}', async () => {
    const storage = createMemoryStorage();
    const authService = new FirebaseAuthProfileService(storage);
    await authService.init();

    // 1. Register with Email & Password
    const registered = await authService.signInOrRegisterWithEmail({
      email: 'maureen@pisto.hn',
      password: 'segura123',
      name: 'Maureen Barahona',
      country: 'HN',
      defaultCurrency: 'HNL',
      isRegister: true,
    });
    assert.equal(registered.user.email, 'maureen@pisto.hn');
    assert.equal(registered.user.provider, 'password');
    assert.equal(registered.profile.name, 'Maureen Barahona');
    assert.equal(registered.profile.defaultCurrency, 'HNL');
    assert.equal(authService.getFirestoreUserPath(registered.user.uid), `users/${registered.user.uid}`);

    // 2. Edit profile fields (Name, Country, Default Currency, Personal View Mode) + Gemini API key in localStorage
    authService.geminiKeyStore.setApiKey('AIzaSyLocalGeminiKeyOnly');
    const updatedProfile = await authService.saveUserProfile(registered.user.uid, {
      name: 'Maureen B.',
      country: 'HN',
      defaultCurrency: 'USD',
      personalViewMode: true,
    });

    assert.equal(updatedProfile.uid, registered.user.uid);
    assert.equal(updatedProfile.name, 'Maureen B.');
    assert.equal(updatedProfile.country, 'HN');
    assert.equal(updatedProfile.defaultCurrency, 'USD');
    assert.equal(updatedProfile.personalViewMode, true);
    // Ensure Gemini key is ONLY in localStorage and NOT in users/{uid} document
    assert.equal('geminiApiKey' in updatedProfile, false);
    assert.equal(authService.geminiKeyStore.getApiKey(), 'AIzaSyLocalGeminiKeyOnly');

    // 3. Sign out and sign back in with Email/Password -> restores users/{uid} profile
    await authService.signOut();
    assert.equal(authService.getCurrentUser(), null);

    const signedIn = await authService.signInOrRegisterWithEmail({
      email: 'maureen@pisto.hn',
      password: 'segura123',
      isRegister: false,
    });
    assert.equal(signedIn.user.uid, registered.user.uid);
    assert.equal(signedIn.profile.name, 'Maureen B.');
    assert.equal(signedIn.profile.defaultCurrency, 'USD');
    assert.equal(signedIn.profile.personalViewMode, true);

    // 4. Sign in with Google (via Firebase Auth GoogleAuthProvider + signInWithPopup)
    authService.firebaseAuth = { name: 'mock_auth' };
    authService.firebaseAuthModule = {
      GoogleAuthProvider: class MockGoogleAuthProvider {
        setCustomParameters(params) {
          this.customParams = params;
        }
      },
      signInWithPopup: async () => ({
        user: {
          uid: 'uid_carlos_google',
          email: 'carlos.familia@gmail.com',
          displayName: 'Carlos Familia',
          photoURL: 'https://lh3.googleusercontent.com/a/carlos',
        },
      }),
    };
    const googleSession = await authService.signInWithGoogle();
    assert.equal(googleSession.user.provider, 'google');
    assert.equal(googleSession.profile.name, 'Carlos Familia');
  });

  it('filters Dashboard analytics and Ledger transactions by defaultCurrency and personalViewMode', () => {
    const state = createSeedState();
    state.settings.baseCurrency = 'HNL';
    state.transactions = [
      createTransaction({
        id: 'tx_hnl_mau',
        type: TRANSACTION_TYPES.EXPENSE,
        amount: 500,
        currency: 'HNL',
        categoryId: 'food',
        accountId: 'acc_cash',
        date: '2026-10-15',
        note: 'Baleadas Kennedy',
        ownerUid: 'uid_maureen',
        ownerName: 'Maureen',
      }),
      createTransaction({
        id: 'tx_usd_mau',
        type: TRANSACTION_TYPES.EXPENSE,
        amount: 40,
        currency: 'USD',
        categoryId: 'services',
        accountId: 'acc_card',
        date: '2026-10-15',
        note: 'Cloud Hosting',
        ownerUid: 'uid_maureen',
        ownerName: 'Maureen',
      }),
      createTransaction({
        id: 'tx_hnl_family',
        type: TRANSACTION_TYPES.EXPENSE,
        amount: 1200,
        currency: 'HNL',
        categoryId: 'groceries',
        accountId: 'acc_bank',
        date: '2026-10-15',
        note: 'Supermercado Familiar',
        ownerUid: 'uid_carlos',
        ownerName: 'Carlos',
      }),
    ];

    // 1. Filter by user's defaultCurrency (HNL) in family mode (personalViewMode = false)
    const hnlFamilyAnalytics = computePeriodAnalytics(state, {
      period: 'all',
      currencyFilter: 'HNL',
      personalViewMode: false,
      currentUid: 'uid_maureen',
    });
    assert.equal(hnlFamilyAnalytics.currencyFilter, 'HNL');
    assert.equal(hnlFamilyAnalytics.totalExpense, 1700); // 500 + 1200 HNL

    // 2. Enable "Modo Vista Personal" (personalViewMode = true) -> only Maureen's HNL transactions
    const hnlPersonalAnalytics = computePeriodAnalytics(state, {
      period: 'all',
      currencyFilter: 'HNL',
      personalViewMode: true,
      currentUid: 'uid_maureen',
    });
    assert.equal(hnlPersonalAnalytics.totalExpense, 500);

    // 3. Ledger day groups also honor currencyFilter and personalViewMode
    const ledgerPersonalGroups = groupTransactionsByDay(state, {
      period: 'all',
      currencyFilter: 'HNL',
      personalViewMode: true,
      currentUid: 'uid_maureen',
    });
    assert.equal(ledgerPersonalGroups.length, 1);
    assert.equal(ledgerPersonalGroups[0].items.length, 1);
    assert.equal(ledgerPersonalGroups[0].items[0].id, 'tx_hnl_mau');

    // 4. Direct helper verification
    const helperFiltered = filterTransactionsForUserView(state.transactions, {
      currencyFilter: 'USD',
      personalViewMode: true,
      currentUid: 'uid_maureen',
    });
    assert.equal(helperFiltered.length, 1);
    assert.equal(helperFiltered[0].id, 'tx_usd_mau');
  });
});

describe('Shared Family Finances (Finanzas Familiares Compartidas)', () => {
  it('stores createdByUid, createdByEmail, and workspaceId on Transaction domain model', () => {
    const tx = createTransaction({
      type: TRANSACTION_TYPES.EXPENSE,
      amount: 850,
      currency: 'HNL',
      categoryId: 'groceries',
      accountId: 'acc_bank',
      date: '2026-10-16',
      note: 'Compra familiar supermercado',
      createdByUid: 'uid_maureen_01',
      createdByEmail: 'maureen@familia.hn',
      workspaceId: 'ws_familia_barahona',
    });

    assert.equal(tx.createdByUid, 'uid_maureen_01');
    assert.equal(tx.createdByEmail, 'maureen@familia.hn');
    assert.equal(tx.workspaceId, 'ws_familia_barahona');
    assert.equal(`Por: ${tx.createdByEmail.split('@')[0]}`, 'Por: maureen');
  });

  it('links two registered family users to the same workspaceId via shareWorkspaceWithEmail', async () => {
    const mockStorage = {
      map: new Map(),
      getItem(k) {
        return this.map.has(k) ? this.map.get(k) : null;
      },
      setItem(k, v) {
        this.map.set(k, String(v));
      },
      removeItem(k) {
        this.map.delete(k);
      },
    };

    const authService = new FirebaseAuthProfileService(mockStorage);

    // 1. Register Family Member B (Carlos)
    const carlosReg = await authService.signInOrRegisterWithEmail({
      email: 'carlos@familia.hn',
      password: 'password123',
      name: 'Carlos',
      isRegister: true,
    });
    assert.ok(carlosReg.profile.workspaceId.startsWith('ws_'));

    // 2. Register Family Member A (Maureen)
    await authService.signOut();
    const maureenReg = await authService.signInOrRegisterWithEmail({
      email: 'maureen@familia.hn',
      password: 'password123',
      name: 'Maureen',
      isRegister: true,
    });

    // 3. Maureen shares her financial workspace with Carlos by email
    const shareRes = await authService.shareWorkspaceWithEmail('carlos@familia.hn');
    assert.equal(shareRes.linkedEmail, 'carlos@familia.hn');
    assert.ok(shareRes.profile.sharedWithEmails.includes('carlos@familia.hn'));
    assert.equal(shareRes.profile.workspaceId, shareRes.workspaceId);

    // 4. Verify Carlos now shares the exact same workspaceId when he signs in
    await authService.signOut();
    const carlosLogin = await authService.signInOrRegisterWithEmail({
      email: 'carlos@familia.hn',
      password: 'password123',
      isRegister: false,
    });
    assert.equal(carlosLogin.profile.workspaceId, shareRes.workspaceId);
    assert.ok(carlosLogin.profile.sharedWithEmails.includes('maureen@familia.hn'));
  });

  it('filters Dashboard and Ledger by workspaceId when personalViewMode is INACTIVE and by createdByUid when ACTIVE', () => {
    const state = createSeedState();
    state.settings.baseCurrency = 'HNL';
    state.transactions = [
      createTransaction({
        id: 'tx_fam_maureen',
        type: TRANSACTION_TYPES.EXPENSE,
        amount: 600,
        currency: 'HNL',
        categoryId: 'food',
        accountId: 'acc_cash',
        date: '2026-10-16',
        note: 'Almuerzo familiar',
        createdByUid: 'uid_maureen',
        createdByEmail: 'maureen@familia.hn',
        workspaceId: 'ws_shared_home',
      }),
      createTransaction({
        id: 'tx_fam_carlos',
        type: TRANSACTION_TYPES.EXPENSE,
        amount: 1400,
        currency: 'HNL',
        categoryId: 'groceries',
        accountId: 'acc_bank',
        date: '2026-10-16',
        note: 'Despensa mensual',
        createdByUid: 'uid_carlos',
        createdByEmail: 'carlos@familia.hn',
        workspaceId: 'ws_shared_home',
      }),
      createTransaction({
        id: 'tx_other_workspace',
        type: TRANSACTION_TYPES.EXPENSE,
        amount: 5000,
        currency: 'HNL',
        categoryId: 'housing',
        accountId: 'acc_bank',
        date: '2026-10-16',
        note: 'Otro grupo familiar ajeno',
        createdByUid: 'uid_externo',
        createdByEmail: 'externo@otro.hn',
        workspaceId: 'ws_other_family',
      }),
    ];

    // 1. Lightweight O(1) index check
    const idx = buildWorkspaceTransactionIndex(state.transactions);
    assert.equal(idx.byWorkspace.get('ws_shared_home')?.length, 2);
    assert.equal(idx.byCreator.get('uid_maureen')?.length, 1);

    // 2. personalViewMode INACTIVE (false): shows ALL transactions in `ws_shared_home` (600 + 1400 = 2000), excluding `ws_other_family`
    const sharedAnalytics = computePeriodAnalytics(state, {
      period: 'all',
      personalViewMode: false,
      currentUid: 'uid_maureen',
      workspaceId: 'ws_shared_home',
    });
    assert.equal(sharedAnalytics.totalExpense, 2000);

    const sharedGroups = groupTransactionsByDay(state, {
      period: 'all',
      personalViewMode: false,
      currentUid: 'uid_maureen',
      workspaceId: 'ws_shared_home',
    });
    assert.equal(sharedGroups[0].items.length, 2);

    // 3. personalViewMode ACTIVE (true): shows ONLY transactions where `createdByUid === 'uid_maureen'` (600)
    const personalAnalytics = computePeriodAnalytics(state, {
      period: 'all',
      personalViewMode: true,
      currentUid: 'uid_maureen',
      workspaceId: 'ws_shared_home',
    });
    assert.equal(personalAnalytics.totalExpense, 600);

    const personalGroups = groupTransactionsByDay(state, {
      period: 'all',
      personalViewMode: true,
      currentUid: 'uid_maureen',
      workspaceId: 'ws_shared_home',
    });
    assert.equal(personalGroups[0].items.length, 1);
    assert.equal(personalGroups[0].items[0].createdByUid, 'uid_maureen');
    assert.equal(personalGroups[0].items[0].createdByEmail.split('@')[0], 'maureen');
  });

  it('queries Firestore transactions by workspaceId (all members when personalViewMode is false) and attaches workspaceId/createdByUid/createdByEmail on creation', async () => {
    const capturedWhereConstraints = [];
    const mockFirestoreDocs = [];

    const mockFirestoreModule = {
      collection: (_db, name) => ({ type: 'collection', name }),
      where: (field, op, value) => {
        const constraint = { field, op, value };
        capturedWhereConstraints.push(constraint);
        return constraint;
      },
      query: (col, ...constraints) => ({ col, constraints }),
      getDocs: async (q) => {
        const matched = mockFirestoreDocs.filter((docData) =>
          q.constraints.every((c) => docData[c.field] === c.value)
        );
        return {
          empty: matched.length === 0,
          docs: matched.map((d) => ({ id: d.id, data: () => d })),
        };
      },
      onSnapshot: (q, onNext) => {
        const matched = mockFirestoreDocs.filter((docData) =>
          q.constraints.every((c) => docData[c.field] === c.value)
        );
        onNext({
          empty: matched.length === 0,
          docs: matched.map((d) => ({ id: d.id, data: () => d })),
        });
        return () => {};
      },
      doc: (_db, col, id) => ({ col, id }),
      setDoc: async (ref, data) => {
        const idx = mockFirestoreDocs.findIndex((d) => d.id === ref.id);
        if (idx >= 0) {
          mockFirestoreDocs[idx] = { ...mockFirestoreDocs[idx], ...data };
        } else {
          mockFirestoreDocs.push({ ...data, id: ref.id });
        }
      },
      deleteDoc: async () => {},
    };

    const mockDb = { name: 'mock_firestore_db' };

    // 1. User A creates a transaction in shared workspace `ws_fam_hogar123`
    const userA = { uid: 'uid_ana', email: 'ana@familia.hn', displayName: 'Ana' };
    const profileA = createUserProfile({
      uid: 'uid_ana',
      email: 'ana@familia.hn',
      workspaceId: 'ws_fam_hogar123',
      personalViewMode: false,
    });

    const txA = await saveTransactionToWorkspace(
      {
        id: 'tx_shared_ana',
        type: 'expense',
        amount: 850,
        currency: 'HNL',
        categoryId: 'groceries',
        accountId: 'acc_bank',
        date: '2026-10-16',
        note: 'Supermercado La Colonia',
      },
      userA,
      profileA,
      { firestoreDb: mockDb, firestoreModule: mockFirestoreModule, storage: null }
    );

    assert.equal(txA.workspaceId, 'ws_fam_hogar123');
    assert.equal(txA.createdByUid, 'uid_ana');
    assert.equal(txA.createdByEmail, 'ana@familia.hn');

    // 2. User B creates a transaction in the same shared workspace `ws_fam_hogar123`
    const userB = { uid: 'uid_luis', email: 'luis@familia.hn', displayName: 'Luis' };
    const profileB = createUserProfile({
      uid: 'uid_luis',
      email: 'luis@familia.hn',
      workspaceId: 'ws_fam_hogar123',
      personalViewMode: false,
    });

    const txB = await saveTransactionToWorkspace(
      {
        id: 'tx_shared_luis',
        type: 'expense',
        amount: 420,
        currency: 'HNL',
        categoryId: 'utilities',
        accountId: 'acc_bank',
        date: '2026-10-16',
        note: 'Recibo de internet',
      },
      userB,
      profileB,
      { firestoreDb: mockDb, firestoreModule: mockFirestoreModule, storage: null }
    );

    assert.equal(txB.workspaceId, 'ws_fam_hogar123');
    assert.equal(txB.createdByUid, 'uid_luis');
    assert.equal(txB.createdByEmail, 'luis@familia.hn');

    // 3. Verify `buildWorkspaceTransactionsQuery` when personalViewMode is FALSE:
    // Must ONLY filter by `where("workspaceId", "==", currentUserProfile.workspaceId)` (no createdByUid constraint!)
    capturedWhereConstraints.length = 0;
    const sharedQuery = buildWorkspaceTransactionsQuery(mockDb, mockFirestoreModule, {
      workspaceId: profileB.workspaceId,
      personalViewMode: false,
      currentUid: userB.uid,
    });
    assert.equal(sharedQuery.constraints.length, 1);
    assert.deepEqual(sharedQuery.constraints[0], {
      field: 'workspaceId',
      op: '==',
      value: 'ws_fam_hogar123',
    });

    // 4. Verify `fetchWorkspaceTransactions` (`getDocs`) and `subscribeWorkspaceTransactions` (`onSnapshot`) for User B
    // when personalViewMode is FALSE -> returns BOTH Ana's and Luis's transactions!
    const fetchedShared = await fetchWorkspaceTransactions({
      workspaceId: profileB.workspaceId,
      personalViewMode: false,
      currentUid: userB.uid,
      firestoreDb: mockDb,
      firestoreModule: mockFirestoreModule,
      storage: null,
    });
    assert.equal(fetchedShared.length, 2);

    let snapshotShared = [];
    const unsubscribe = subscribeWorkspaceTransactions(
      {
        workspaceId: profileB.workspaceId,
        personalViewMode: false,
        currentUid: userB.uid,
        firestoreDb: mockDb,
        firestoreModule: mockFirestoreModule,
        storage: null,
      },
      (txs) => {
        snapshotShared = txs;
      }
    );
    assert.equal(snapshotShared.length, 2);
    unsubscribe();

    // 5. Verify when personalViewMode is TRUE -> queries by workspaceId AND createdByUid === currentUser.uid
    const fetchedPersonalB = await fetchWorkspaceTransactions({
      workspaceId: profileB.workspaceId,
      personalViewMode: true,
      currentUid: userB.uid,
      firestoreDb: mockDb,
      firestoreModule: mockFirestoreModule,
      storage: null,
    });
    assert.equal(fetchedPersonalB.length, 1);
    assert.equal(fetchedPersonalB[0].id, 'tx_shared_luis');
    assert.equal(fetchedPersonalB[0].createdByUid, 'uid_luis');
  });

  it('persists Local-First privacy consent and cleans up sensitive API keys & custom Firebase configs on signOut', async () => {
    const map = new Map();
    const storage = {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, val) => map.set(key, String(val)),
      removeItem: (key) => map.delete(key),
    };
    const authService = new FirebaseAuthProfileService(storage);
    await authService.init();

    // 1. Default privacy consent state is unaccepted until confirmed
    assert.equal(authService.getPrivacyConsent().accepted, false);
    const savedConsent = authService.savePrivacyConsent(true);
    assert.equal(savedConsent.accepted, true);
    assert.equal(authService.getPrivacyConsent().accepted, true);

    // 2. Sign in and store sensitive Gemini API Key + custom Firebase config in localStorage
    await authService.signInWithDemoMode();
    authService.geminiKeyStore.setApiKey('AIzaSySensitiveGeminiKey_999');
    await authService.updateFirebaseConfig({
      apiKey: 'AIzaSyCustomFirebaseKey_123',
      authDomain: 'custom-pisto.firebaseapp.com',
      projectId: 'custom-pisto',
    });
    storage.setItem('Pisto_open_finance_v1', JSON.stringify({ nonSensitiveLedger: true }));

    assert.equal(authService.geminiKeyStore.hasApiKey(), true);
    assert.equal(Boolean(storage.getItem('pisto_custom_firebase_config')), true);

    // 3. Signing out automatically wipes sensitive API keys and custom Firebase credentials while keeping Local-First ledger data intact
    await authService.signOut();
    assert.equal(authService.getCurrentUser(), null);
    assert.equal(authService.geminiKeyStore.hasApiKey(), false);
    assert.equal(authService.geminiKeyStore.getApiKey(), '');
    assert.equal(storage.getItem('pisto_custom_firebase_config'), null);
    assert.equal(storage.getItem('pisto_firebase_web_config_v1'), null);
    assert.equal(Boolean(storage.getItem('Pisto_open_finance_v1')), true);
  });

  it('configures GoogleAuthProvider with prompt=select_account, surfaces error.code & error.message on signInWithPopup failures, and syncs users/{uid} in Firestore', async () => {
    const map = new Map();
    const storage = {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, val) => map.set(key, String(val)),
      removeItem: (key) => map.delete(key),
    };
    const authService = new FirebaseAuthProfileService(storage);
    await authService.init();

    // 1. Verify `auth/configuration-not-found` error when Firebase Auth is not configured
    await assert.rejects(
      async () => authService.signInWithGoogle(),
      (err) => {
        assert.equal(err.code, 'auth/configuration-not-found');
        assert.ok(err.message.includes('auth/configuration-not-found'));
        return true;
      }
    );

    // 2. Verify `signInWithPopup` error diagnostics (`auth/unauthorized-domain`, `auth/popup-blocked`)
    let capturedCustomParams = null;
    let simulatedPopupError = null;
    const firestoreDocs = new Map();

    authService.firebaseAuth = { name: 'mock_firebase_auth' };
    authService.firestoreDb = { name: 'mock_firestore_db' };
    authService.firestoreModule = {
      doc: (_db, col, id) => ({ col, id, path: `${col}/${id}` }),
      getDoc: async (ref) => ({
        exists: () => firestoreDocs.has(ref.path),
        data: () => firestoreDocs.get(ref.path),
      }),
      setDoc: async (ref, data, options) => {
        const prev = firestoreDocs.get(ref.path) || {};
        firestoreDocs.set(ref.path, options?.merge ? { ...prev, ...data } : { ...data });
      },
    };
    authService.firebaseAuthModule = {
      GoogleAuthProvider: class MockGoogleAuthProvider {
        setCustomParameters(params) {
          capturedCustomParams = params;
        }
      },
      signInWithPopup: async () => {
        if (simulatedPopupError) {
          throw simulatedPopupError;
        }
        return {
          user: {
            uid: 'uid_google_101',
            displayName: 'Maureen Google',
            email: 'maureen.google@gmail.com',
            photoURL: 'https://lh3.googleusercontent.com/a/maureen',
          },
        };
      },
    };

    simulatedPopupError = Object.assign(new Error('This domain is not authorized for OAuth operations.'), {
      code: 'auth/unauthorized-domain',
    });
    await assert.rejects(
      async () => authService.signInWithGoogle(),
      (err) => {
        assert.equal(err.code, 'auth/unauthorized-domain');
        assert.ok(err.message.includes('[auth/unauthorized-domain]'));
        assert.ok(err.message.includes('This domain is not authorized for OAuth operations.'));
        return true;
      }
    );
    assert.deepEqual(capturedCustomParams, { prompt: 'select_account' });

    simulatedPopupError = Object.assign(new Error('Unable to establish a connection with the popup.'), {
      code: 'auth/popup-blocked',
    });
    await assert.rejects(
      async () => authService.signInWithGoogle(),
      (err) => {
        assert.equal(err.code, 'auth/popup-blocked');
        assert.ok(err.message.includes('[auth/popup-blocked]'));
        return true;
      }
    );

    // 3. Successful Google login creates `users/{user.uid}` in Firestore when missing
    simulatedPopupError = null;
    capturedCustomParams = null;
    const loginResult = await authService.signInWithGoogle();

    assert.deepEqual(capturedCustomParams, { prompt: 'select_account' });
    assert.equal(loginResult.user.uid, 'uid_google_101');
    assert.equal(loginResult.user.displayName, 'Maureen Google');
    assert.equal(loginResult.user.email, 'maureen.google@gmail.com');
    assert.equal(loginResult.user.photoURL, 'https://lh3.googleusercontent.com/a/maureen');

    const savedDoc = firestoreDocs.get('users/uid_google_101');
    assert.ok(savedDoc);
    assert.equal(savedDoc.uid, 'uid_google_101');
    assert.equal(savedDoc.displayName, 'Maureen Google');
    assert.equal(savedDoc.email, 'maureen.google@gmail.com');
    assert.equal(savedDoc.photoURL, 'https://lh3.googleusercontent.com/a/maureen');
    assert.ok(savedDoc.createdAt);
    assert.equal(savedDoc.workspaceId, 'uid_google_101');

    // 4. If `users/{user.uid}` exists in Firestore but is missing fields (e.g. photoURL or workspaceId), it updates them while preserving existing shared workspaceId
    firestoreDocs.set('users/uid_google_101', {
      uid: 'uid_google_101',
      email: 'maureen.google@gmail.com',
      workspaceId: 'ws_shared_family_99',
    });
    const reloginResult = await authService.signInWithGoogle();
    const updatedDoc = firestoreDocs.get('users/uid_google_101');
    assert.equal(updatedDoc.displayName, 'Maureen Google');
    assert.equal(updatedDoc.photoURL, 'https://lh3.googleusercontent.com/a/maureen');
    assert.ok(updatedDoc.createdAt);
    assert.equal(updatedDoc.workspaceId, 'ws_shared_family_99');
    assert.equal(reloginResult.profile.workspaceId, 'ws_shared_family_99');
  });

  it('supports Family Workspace Invite Code / Token system: Host token generation/regeneration, Guest joining by inviteCode, and leaving shared workspace', async () => {
    const map = new Map();
    const storage = {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, val) => map.set(key, String(val)),
      removeItem: (key) => map.delete(key),
    };

    const firestoreWorkspaces = new Map();
    const firestoreUsers = new Map();
    const mockFirestoreModule = {
      doc: (_db, col, id) => ({ col, id, path: `${col}/${id}` }),
      getDoc: async (ref) => {
        const store = ref.col === 'workspaces' ? firestoreWorkspaces : firestoreUsers;
        return {
          exists: () => store.has(ref.id),
          data: () => store.get(ref.id),
        };
      },
      setDoc: async (ref, data, options) => {
        const store = ref.col === 'workspaces' ? firestoreWorkspaces : firestoreUsers;
        const prev = store.get(ref.id) || {};
        store.set(ref.id, options?.merge ? { ...prev, ...data } : { ...data });
      },
      collection: (_db, name) => ({ name }),
      where: (field, op, value) => ({ field, op, value }),
      query: (colRef, ...constraints) => ({ colRef, constraints }),
      getDocs: async (q) => {
        const matched = [];
        for (const [id, docData] of firestoreWorkspaces.entries()) {
          if (q.constraints.every((c) => docData[c.field] === c.value)) {
            matched.push({ id, data: () => docData });
          }
        }
        return {
          empty: matched.length === 0,
          docs: matched,
        };
      },
    };
    const mockDb = { name: 'mock_firestore_db' };

    // 1. Host user signs in and generates a Family Workspace Invite Code (6-8 alphanumeric chars)
    const hostAuth = new FirebaseAuthProfileService(storage);
    await hostAuth.init();
    hostAuth.setFirebaseRuntimeForTesting({
      firestoreDb: mockDb,
      firestoreModule: mockFirestoreModule,
    });
    const { user: hostUser } = await hostAuth.signInWithGoogle({
      email: 'host@familia.hn',
      name: 'Host Familiar',
    });

    const hostWs = await hostAuth.ensureOrGenerateWorkspaceToken({ regenerate: false });
    assert.equal(hostWs.workspaceId, hostUser.uid);
    assert.equal(hostWs.ownerUid, hostUser.uid);
    assert.match(hostWs.inviteCode, /^[A-Z0-9]{6,8}$/);
    assert.ok(hostWs.members.includes(hostUser.uid));
    assert.ok(hostWs.members.includes('host@familia.hn'));
    assert.ok(firestoreWorkspaces.has(hostUser.uid));

    // Regenerating the token produces a new valid 6-8 char alphanumeric inviteCode
    const regeneratedWs = await hostAuth.ensureOrGenerateWorkspaceToken({ regenerate: true });
    assert.match(regeneratedWs.inviteCode, /^[A-Z0-9]{6,8}$/);
    assert.equal(firestoreWorkspaces.get(hostUser.uid).inviteCode, regeneratedWs.inviteCode);

    // 2. Guest user signs in and attempts to join with an invalid token -> throws error
    const guestAuth = new FirebaseAuthProfileService(storage);
    await guestAuth.init();
    guestAuth.setFirebaseRuntimeForTesting({
      firestoreDb: mockDb,
      firestoreModule: mockFirestoreModule,
    });
    const { user: guestUser } = await guestAuth.signInWithGoogle({
      email: 'invitado@familia.hn',
      name: 'Invitado Familiar',
    });

    await assert.rejects(
      async () => guestAuth.joinWorkspaceByInviteCode('INVALID99'),
      (err) => {
        assert.equal(err.message, 'Código de invitación no válido o expirado');
        return true;
      }
    );

    // 3. Guest joins using the Host's valid inviteCode
    const joinResult = await guestAuth.joinWorkspaceByInviteCode(regeneratedWs.inviteCode);
    assert.equal(joinResult.message, '¡Te has unido exitosamente al Espacio Familiar!');
    assert.equal(joinResult.profile.workspaceId, hostUser.uid);
    assert.ok(joinResult.workspace.members.includes(guestUser.uid));
    assert.ok(joinResult.workspace.members.includes('invitado@familia.hn'));
    assert.equal(firestoreUsers.get(guestUser.uid).workspaceId, hostUser.uid);

    // 4. Guest leaves the shared workspace -> resets workspaceId to guestUser.uid
    const leaveResult = await guestAuth.leaveSharedWorkspace();
    assert.equal(leaveResult.workspaceId, guestUser.uid);
    assert.equal(leaveResult.profile.workspaceId, guestUser.uid);
    assert.equal(firestoreUsers.get(guestUser.uid).workspaceId, guestUser.uid);
    assert.equal(firestoreWorkspaces.get(hostUser.uid).members.includes(guestUser.uid), false);
  });
});

describe('Account Archiving, Cascade Deletion (writeBatch) & Relational Integrity', () => {
  it('Option A (Archive Account): sets isArchived=true / status="archived", hides from active selectors, preserves historical transactions/reports, and supports unarchiving', async () => {
    const state = createSeedState();
    const initialAnalytics = computePeriodAnalytics(state, { period: 'all' });
    const cardTxBefore = getTransactionsByAccountId(state.transactions, 'acc_card');
    assert.ok(cardTxBefore.length > 0);

    const firestoreAccounts = new Map();
    const mockFirestoreModule = {
      doc: (_db, col, id) => ({ col, id, path: `${col}/${id}` }),
      setDoc: async (ref, data, options) => {
        const prev = firestoreAccounts.get(ref.id) || {};
        firestoreAccounts.set(ref.id, options?.merge ? { ...prev, ...data } : { ...data });
      },
    };
    const mockDb = { name: 'mock_firestore_db' };

    // 1. Archive 'acc_card'
    const archiveRes = await archiveAccount('acc_card', state, {
      workspaceId: 'ws_default',
      currentUid: 'local_default_user',
      firestoreDb: mockDb,
      firestoreModule: mockFirestoreModule,
      storage: null,
    });

    assert.ok(archiveRes.account);
    assert.equal(archiveRes.account.isArchived, true);
    assert.equal(archiveRes.account.status, 'archived');
    assert.equal(archiveRes.preservedTxCount, cardTxBefore.length);
    assert.equal(firestoreAccounts.get('acc_card')?.isArchived, true);
    assert.equal(firestoreAccounts.get('acc_card')?.status, 'archived');

    // 2. Active account selectors exclude the archived account
    const activeAccounts = filterActiveAccounts(state.accounts);
    const archivedAccounts = filterArchivedAccounts(state.accounts);
    assert.equal(activeAccounts.some((a) => a.id === 'acc_card'), false);
    assert.equal(archivedAccounts.some((a) => a.id === 'acc_card'), true);

    // 3. View filter hides archived accounts by default and shows them when showArchived=true
    assert.equal(
      filterAccountsForView(state.accounts, false).some((a) => a.id === 'acc_card'),
      false
    );
    assert.equal(
      filterAccountsForView(state.accounts, true).some((a) => a.id === 'acc_card'),
      true
    );

    // 4. All historical transactions, budgets, and Dashboard analytics remain 100% intact
    const cardTxAfter = getTransactionsByAccountId(state.transactions, 'acc_card');
    assert.equal(cardTxAfter.length, cardTxBefore.length);
    const postArchiveAnalytics = computePeriodAnalytics(state, { period: 'all' });
    assert.equal(postArchiveAnalytics.totalIncome, initialAnalytics.totalIncome);
    assert.equal(postArchiveAnalytics.totalExpense, initialAnalytics.totalExpense);

    // 5. Unarchive / reactivate 'acc_card'
    const reactivatedRes = await unarchiveAccount('acc_card', state, {
      workspaceId: 'ws_default',
      currentUid: 'local_default_user',
      firestoreDb: mockDb,
      firestoreModule: mockFirestoreModule,
      storage: null,
    });
    assert.ok(reactivatedRes.account);
    assert.equal(reactivatedRes.account.isArchived, false);
    assert.equal(reactivatedRes.account.status, 'active');
    assert.equal(filterActiveAccounts(state.accounts).some((a) => a.id === 'acc_card'), true);
  });

  it('Option B (Cascade Delete with Firestore writeBatch): deletes account from accounts collection and all transactions where accountId === idDeLaCuenta', async () => {
    const state = createSeedState();
    const targetAccountId = 'acc_card';
    const associatedTxs = state.transactions.filter((tx) => tx.accountId === targetAccountId);
    assert.ok(associatedTxs.length > 0);

    const firestoreAccounts = new Map([
      ['acc_card', { id: 'acc_card', name: 'Tarjeta de Crédito', workspaceId: 'ws_default' }],
      ['acc_bank', { id: 'acc_bank', name: 'Cuenta Principal', workspaceId: 'ws_default' }],
    ]);
    const firestoreTransactions = new Map(
      state.transactions.map((tx) => [tx.id, { ...tx, workspaceId: 'ws_default' }])
    );

    const batchDeletedRefs = [];
    let batchCommitted = false;

    const mockFirestoreModule = {
      collection: (_db, name) => ({ name }),
      doc: (_db, col, id) => ({ col, id, path: `${col}/${id}` }),
      where: (field, op, value) => ({ field, op, value }),
      query: (colRef, ...constraints) => ({ colRef, constraints }),
      getDocs: async (q) => {
        const docs = [];
        for (const [id, data] of firestoreTransactions.entries()) {
          if (q.constraints.every((c) => data[c.field] === c.value)) {
            docs.push({
              id,
              ref: { col: 'transactions', id, path: `transactions/${id}` },
              data: () => data,
            });
          }
        }
        return {
          empty: docs.length === 0,
          docs,
        };
      },
      writeBatch: () => ({
        delete: (ref) => {
          batchDeletedRefs.push(ref);
          if (ref.col === 'accounts') {
            firestoreAccounts.delete(ref.id);
          } else if (ref.col === 'transactions') {
            firestoreTransactions.delete(ref.id);
          }
        },
        commit: async () => {
          batchCommitted = true;
        },
      }),
    };
    const mockDb = { name: 'mock_firestore_db' };

    const result = await deleteAccountWithCascade(targetAccountId, state, {
      workspaceId: 'ws_default',
      currentUid: 'local_default_user',
      firestoreDb: mockDb,
      firestoreModule: mockFirestoreModule,
      storage: null,
    });

    assert.equal(batchCommitted, true);
    assert.equal(result.deletedAccount?.id, 'acc_card');
    assert.equal(result.deletedTransactionsCount, associatedTxs.length);

    // Verify Firestore writeBatch deleted `accounts/acc_card` AND all `transactions` where `accountId === 'acc_card'`
    assert.equal(firestoreAccounts.has('acc_card'), false);
    assert.equal(firestoreAccounts.has('acc_bank'), true);
    assert.ok(batchDeletedRefs.some((r) => r.path === 'accounts/acc_card'));
    for (const tx of associatedTxs) {
      assert.equal(firestoreTransactions.has(tx.id), false);
      assert.ok(batchDeletedRefs.some((r) => r.path === `transactions/${tx.id}`));
    }

    // Verify local state also removed the account and its transactions
    assert.equal(state.accounts.some((a) => a.id === 'acc_card'), false);
    assert.equal(state.accounts.some((a) => a.id === 'acc_bank'), true);
    assert.equal(state.transactions.some((tx) => tx.accountId === 'acc_card'), false);
    assert.equal(typeof DeleteAccountModal, 'function');
  });
});

describe('AccountsView & ImportAccountModal Button Handler, Conditional Render & Multi-Env Fallback', () => {
  it('binds onClick to setIsImportAccountModalOpen(true), strips pointer-events-none/select-none on ancestors, and opens in local fallback mode without console.log', async () => {
    let closedCalled = 0;
    const toasts = [];
    const view = createAccountsView({
      showToast: (msg) => toasts.push(msg),
      onClose: () => {
        closedCalled += 1;
      },
    });

    assert.equal(IMPORT_ACCOUNT_BUTTON_ID, 'btn-import-account');
    assert.equal(IMPORT_ACCOUNT_BUTTON_LABEL, '➕ Importar Cuenta desde Imagen/PDF');
    assert.equal(view.isImportAccountModalOpen, false);

    // 1. Verify parent container class sanitization removes pointer-events-none and select-none
    const removedClasses = [];
    const mockParent = {
      classList: {
        remove: (...cls) => removedClasses.push(...cls),
      },
      style: { pointerEvents: 'none', userSelect: 'none' },
      parentElement: null,
    };
    const mockBtn = {
      classList: {
        remove: (...cls) => removedClasses.push(...cls),
      },
      style: { pointerEvents: 'none', userSelect: 'none' },
      parentElement: mockParent,
    };
    sanitizeClickableAncestors(mockBtn);
    assert.ok(removedClasses.includes('pointer-events-none'));
    assert.ok(removedClasses.includes('select-none'));
    assert.equal(mockBtn.style.pointerEvents, 'auto');
    assert.equal(mockParent.style.pointerEvents, 'auto');

    // 2. Verify opening modal synchronously without production env vars works and triggers local fallback
    view.setIsImportAccountModalOpen(true);
    assert.equal(view.isImportAccountModalOpen, true);
    assert.equal(getIsImportAccountModalOpen(), true);
    assert.equal(globalThis.__PISTO_IMPORT_ACCOUNT_MODAL_OPEN__, true);
    assert.ok(toasts.some((t) => t.includes('Agente ADK')));

    const demoData = view.modal.handleLoadDemoADK();
    assert.equal(demoData.bankName, 'Banco Atlántida');
    assert.equal(demoData.accountNumber, '213130058771');
    assert.equal(demoData.currentBalance, 3901.33);

    // 3. Verify conditional rendering markup and closing modal calls onClose
    assert.ok(renderAccountsViewTemplate(true).includes('data-rendered-component="ImportAccountModal"'));
    view.setIsImportAccountModalOpen(false);
    assert.equal(view.isImportAccountModalOpen, false);
    assert.equal(getIsImportAccountModalOpen(), false);
    assert.equal(closedCalled, 1);

    // 4. Verify anti-tree-shaking global registrations and zero console.log in Vanilla Stack files
    assert.equal(globalThis.__PISTO_ACCOUNTS_VIEW__, AccountsView);
    assert.equal(globalThis.__PISTO_IMPORT_ACCOUNT_MODAL__, ImportAccountModal);
    assert.equal(typeof openImportModal, 'function');
    assert.equal(typeof bindImportAccountTriggerButtons, 'function');

    const filesToCheck = [
      'index.html',
      'src/css/styles.css',
      'src/js/app.js',
      'src/js/services/firestore.js',
      'src/js/components/ImportAccountModal.js',
      'public/js/ui/accountsTab.js',
      'public/js/ui/importAccountModal.js',
    ];
    for (const relPath of filesToCheck) {
      const content = await fs.readFile(new URL(`../${relPath}`, import.meta.url), 'utf8');
      assert.ok(content.trim().length > 0, `Expected non-empty file: ${relPath}`);
      const codeWithoutComments = content
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      assert.equal(
        codeWithoutComments.includes('console.log('),
        false,
        `Expected no console.log in ${relPath}`
      );
    }
  });
});

describe('Smart Transaction Deduplication & Lightweight Firestore Cursor Pagination', () => {
  it('detects duplicate transactions (same accountId + same date + same amount + similar concept) and formats warning banner', async () => {
    const existingTransactions = [
      {
        id: 'tx_existing_colonia',
        accountId: 'acc_atlantida_1',
        date: '2026-10-21',
        amount: 1250.5,
        currency: 'HNL',
        type: 'expense',
        categoryId: 'cat_food',
        note: 'POS SUPERMERCADO LA COLONIA #12 TEGUCIGALPA',
      },
    ];

    assert.equal(
      normalizeTransactionConcept('Compra POS en Supermercado La Colonia #12'),
      'supermercado colonia 12'
    );
    assert.equal(
      isSimilarTransactionConcept('SUPERMERCADO LA COLONIA', 'POS SUPERMERCADO LA COLONIA #12'),
      true
    );
    assert.equal(formatDateDdMmYyyy('2026-10-21'), '21/10/2026');

    const checkResult = await checkAccountTransactionDuplicate(
      {
        accountId: 'acc_atlantida_1',
        date: '2026-10-21',
        amount: 1250.5,
        currency: 'HNL',
        concept: 'Supermercado La Colonia',
      },
      {
        accountId: 'acc_atlantida_1',
        transactions: existingTransactions,
      }
    );

    assert.equal(checkResult.isDuplicate, true);
    assert.equal(checkResult.duplicateTransaction.id, 'tx_existing_colonia');
    assert.equal(
      checkResult.warningMessage,
      '⚠️ Posible transacción duplicada detectada (Monto: L 1250.50, Fecha: 21/10/2026, Comercio: Supermercado La Colonia)'
    );
    assert.equal(
      DUPLICATE_TRANSACTION_OPTION_LABELS.OVERWRITE,
      '✏️ Sobreescribir / Actualizar Transacción Existente'
    );
    assert.equal(
      DUPLICATE_TRANSACTION_OPTION_LABELS.CREATE_NEW,
      '➕ Crear como Nueva Transacción'
    );
    assert.equal(DUPLICATE_TRANSACTION_OPTION_LABELS.SKIP, '🚫 Omitir');
  });

  it('executes all 3 user deduplication decisions (overwrite, create_new, skip) accurately in Firestore and local state', async () => {
    const state = createSeedState();
    const bankAcc = createAccount({
      id: 'acc_bac_hnl',
      name: 'BAC Credomatic — Ahorro',
      institution: 'BAC Credomatic',
      accountNumber: '99887766',
      type: 'bank',
      currency: 'HNL',
      initialBalance: 5000,
    });
    state.accounts.push(bankAcc);

    const existingTx = createTransaction({
      id: 'tx_dup_target',
      type: 'expense',
      amount: 450.0,
      currency: 'HNL',
      accountId: 'acc_bac_hnl',
      categoryId: 'cat_food',
      date: '2026-10-15',
      note: 'Espresso Americano',
    });
    state.transactions.push(existingTx);

    // 1. Test "skip" ("🚫 Omitir")
    const skipRes = await resolveDuplicateTransactionAction({
      action: DUPLICATE_TRANSACTION_ACTIONS.SKIP,
      candidateTx: {
        type: 'expense',
        amount: 450.0,
        currency: 'HNL',
        accountId: 'acc_bac_hnl',
        categoryId: 'cat_food',
        date: '2026-10-15',
        note: 'Espresso Americano Mall',
      },
      existingTx,
      state,
    });
    assert.equal(skipRes.skipped, true);
    assert.equal(skipRes.savedTransaction, null);
    assert.equal(state.transactions.filter((t) => t.accountId === 'acc_bac_hnl').length, 1);

    // 2. Test "overwrite" ("✏️ Sobreescribir / Actualizar Transacción Existente")
    const overwriteRes = await resolveDuplicateTransactionAction({
      action: DUPLICATE_TRANSACTION_ACTIONS.OVERWRITE,
      candidateTx: {
        type: 'expense',
        amount: 450.0,
        currency: 'HNL',
        accountId: 'acc_bac_hnl',
        categoryId: 'cat_food',
        date: '2026-10-15',
        note: 'Espresso Americano Actualizado',
      },
      existingTx,
      state,
    });
    assert.equal(overwriteRes.overwritten, true);
    assert.equal(overwriteRes.savedTransaction.id, 'tx_dup_target');
    assert.equal(
      state.transactions.find((t) => t.id === 'tx_dup_target').note,
      'Espresso Americano Actualizado'
    );
    assert.equal(state.transactions.filter((t) => t.accountId === 'acc_bac_hnl').length, 1);

    // 3. Test "create_new" ("➕ Crear como Nueva Transacción")
    const createNewRes = await resolveDuplicateTransactionAction({
      action: DUPLICATE_TRANSACTION_ACTIONS.CREATE_NEW,
      candidateTx: {
        type: 'expense',
        amount: 450.0,
        currency: 'HNL',
        accountId: 'acc_bac_hnl',
        categoryId: 'cat_food',
        date: '2026-10-15',
        note: 'Espresso Americano Segunda Compra',
      },
      existingTx,
      state,
    });
    assert.equal(createNewRes.action, DUPLICATE_TRANSACTION_ACTIONS.CREATE_NEW);
    assert.equal(createNewRes.skipped, false);
    assert.equal(createNewRes.overwritten, false);
    assert.notEqual(createNewRes.savedTransaction.id, 'tx_dup_target');
    assert.equal(state.transactions.filter((t) => t.accountId === 'acc_bac_hnl').length, 2);

    // 4. Test batch import deduplication in persistImportedAccountAndTransactions
    const importRes = await persistImportedAccountAndTransactions(
      {
        bankName: 'BAC Credomatic',
        accountType: 'Ahorro',
        accountNumber: '99887766',
        currency: 'HNL',
        currentBalance: 5000,
        detectedTransactions: [
          {
            date: '2026-10-15',
            concept: 'Espresso Americano Actualizado',
            amount: 450.0,
            type: 'expense',
            duplicateId: 'tx_dup_target',
            duplicateAction: DUPLICATE_TRANSACTION_ACTIONS.OVERWRITE,
          },
          {
            date: '2026-10-15',
            concept: 'Espresso Americano Segunda Compra',
            amount: 450.0,
            type: 'expense',
            duplicateId: createNewRes.savedTransaction.id,
            duplicateAction: DUPLICATE_TRANSACTION_ACTIONS.SKIP,
          },
        ],
      },
      {
        appState: state,
        workspaceId: 'ws_default',
      }
    );
    assert.equal(importRes.accountUpdated, true);
    assert.equal(importRes.overwrittenTransactions.length, 1);
    assert.equal(importRes.skippedTransactions.length, 1);
    assert.equal(importRes.createdTransactions.length, 0);
  });

  it('supports lightweight Firestore cursor pagination (limit + startAfter) and normalized document schema', async () => {
    assert.deepEqual(FIRESTORE_COLLECTIONS, {
      ACCOUNTS: 'accounts',
      TRANSACTIONS: 'transactions',
      WORKSPACES: 'workspaces',
      USERS: 'users',
    });

    const normalized = normalizeFirestoreDocument(FIRESTORE_COLLECTIONS.TRANSACTIONS, {
      id: 'tx_100',
      accountId: 'acc_1',
      categoryId: 'cat_food',
      type: 'expense',
      amount: 250.75,
      currency: 'HNL',
      date: '2026-10-21',
      note: 'Supermercado',
    });
    assert.equal(normalized.id, 'tx_100');
    assert.equal(normalized.amount, 250.75);
    assert.equal(normalized.date, '2026-10-21');

    const appliedConstraints = [];
    const mockDocs = [
      {
        id: 'doc_1',
        data: () => ({
          accountId: 'acc_1',
          categoryId: 'cat_food',
          type: 'expense',
          amount: 100,
          currency: 'HNL',
          date: '2026-10-21',
        }),
      },
      {
        id: 'doc_2',
        data: () => ({
          accountId: 'acc_1',
          categoryId: 'cat_food',
          type: 'expense',
          amount: 200,
          currency: 'HNL',
          date: '2026-10-20',
        }),
      },
    ];
    const page = await queryCollectionWithCursor({
      firestoreDb: { name: 'mock-db' },
      firestoreModule: {
        collection: (_db, col) => ({ col }),
        where: (f, op, v) => ({ type: 'where', f, op, v }),
        orderBy: (f, d) => ({ type: 'orderBy', f, d }),
        startAfter: (cursor) => ({ type: 'startAfter', cursor }),
        limit: (n) => ({ type: 'limit', n }),
        query: (_ref, ...constraints) => {
          appliedConstraints.push(...constraints);
          return { constraints };
        },
        getDocs: async () => ({ docs: mockDocs }),
      },
      collectionName: FIRESTORE_COLLECTIONS.TRANSACTIONS,
      workspaceId: 'ws_default',
      accountId: 'acc_1',
      pageSize: 2,
      cursor: { id: 'doc_0' },
    });

    assert.equal(page.items.length, 2);
    assert.equal(page.hasMore, true);
    assert.equal(page.nextCursor, mockDocs[1]);
    assert.ok(appliedConstraints.some((c) => c.type === 'startAfter'));
    assert.ok(appliedConstraints.some((c) => c.type === 'limit' && c.n === 2));
  });
});

describe('Primer Inicio / Onboarding Wizard & Clean Database Initialization (Vanilla JS)', () => {
  it('detects first-time users (hasCompletedOnboarding false/missing), cleans workspace (0 accounts, 0 transactions, 0 budgets), and launches the 4-step OnboardingWizard', async () => {
    const map = new Map();
    const storage = {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    };

    const firestoreStores = {
      users: new Map(),
      accounts: new Map([
        ['acc_seed_1', { id: 'acc_seed_1', workspaceId: 'ws_uid_new_user_1' }],
      ]),
      transactions: new Map([
        ['tx_seed_1', { id: 'tx_seed_1', workspaceId: 'ws_uid_new_user_1' }],
      ]),
      budgets: new Map([
        ['bud_seed_1', { id: 'bud_seed_1', workspaceId: 'ws_uid_new_user_1' }],
      ]),
    };

    const mockFirestoreModule = {
      doc: (_db, col, id) => ({ col, id, path: `${col}/${id}` }),
      getDoc: async (ref) => {
        const store = firestoreStores[ref.col] || new Map();
        return {
          exists: () => store.has(ref.id),
          data: () => store.get(ref.id),
        };
      },
      setDoc: async (ref, data, options) => {
        const store = firestoreStores[ref.col] || new Map();
        const prev = store.get(ref.id) || {};
        store.set(ref.id, options?.merge ? { ...prev, ...data } : { ...data });
      },
      collection: (_db, name) => ({ name }),
      where: (field, op, value) => ({ field, op, value }),
      query: (colRef, ...constraints) => ({ colRef, constraints }),
      getDocs: async (q) => {
        const store = firestoreStores[q.colRef.name] || new Map();
        const docs = [];
        for (const [id, data] of store.entries()) {
          if (q.constraints.every((c) => data[c.field] === c.value)) {
            docs.push({
              id,
              ref: { col: q.colRef.name, id, path: `${q.colRef.name}/${id}` },
              data: () => data,
            });
          }
        }
        return { empty: docs.length === 0, docs };
      },
      writeBatch: () => ({
        delete: (ref) => {
          firestoreStores[ref.col]?.delete(ref.id);
        },
        commit: async () => {},
      }),
    };
    const mockDb = { name: 'mock_firestore_db' };

    const authService = new FirebaseAuthProfileService(storage);
    await authService.init();
    authService.setFirebaseRuntimeForTesting({
      firestoreDb: mockDb,
      firestoreModule: mockFirestoreModule,
    });

    // 1. Register a brand-new user -> users/{uid} has hasCompletedOnboarding: false
    const { user, profile } = await authService.signInOrRegisterWithEmail({
      isRegister: true,
      name: 'Nuevo Usuario Honduras',
      email: 'nuevo@pisto.hn',
      password: 'Password123!',
    });

    assert.equal(profile.hasCompletedOnboarding, false);
    assert.equal(shouldTriggerOnboarding(profile), true);
    assert.equal(shouldTriggerOnboarding({ uid: 'u1' }), true);
    assert.equal(shouldTriggerOnboarding({ uid: 'u1', hasCompletedOnboarding: true }), false);

    // 2. Start with a state that has demo accounts, transactions, and budgets
    const state = createSeedState();
    assert.ok(state.accounts.length > 0);
    assert.ok(state.transactions.length > 0);
    assert.ok(Object.keys(state.budgets).length > 0);

    let completedPayload = null;
    const wizard = createOnboardingWizard({
      authService,
      getState: () => state,
      onComplete: (payload) => {
        completedPayload = payload;
      },
    });

    // Force workspaceId to match the seeded mock Firestore docs to verify Firestore cleanup as well
    profile.workspaceId = 'ws_uid_new_user_1';
    const checkRes = await wizard.checkAndStartForUser(user, profile, {
      state,
      firestoreDb: mockDb,
      firestoreModule: mockFirestoreModule,
      storage,
    });

    assert.equal(checkRes.triggered, true);
    assert.equal(checkRes.cleaned, true);
    assert.equal(wizard.isOpen, true);
    assert.equal(wizard.currentStepIndex, 0);

    // Verify 0 accounts, 0 transactions, 0 budgets in both local state and Firestore
    assert.equal(state.accounts.length, 0);
    assert.equal(state.transactions.length, 0);
    assert.deepEqual(state.budgets, {});
    assert.equal(firestoreStores.accounts.size, 0);
    assert.equal(firestoreStores.transactions.size, 0);
    assert.equal(firestoreStores.budgets.size, 0);

    // Verify createCleanWorkspaceState helper also produces 0 accounts, 0 transactions, 0 budgets
    const cleanHelperState = createCleanWorkspaceState({
      baseCurrency: 'HNL',
      workspaceId: profile.workspaceId,
      currentUid: user.uid,
    });
    assert.equal(cleanHelperState.accounts.length, 0);
    assert.equal(cleanHelperState.transactions.length, 0);
    assert.deepEqual(cleanHelperState.budgets, {});

    // 3. Verify all 4 Wizard Steps content & navigation
    assert.equal(ONBOARDING_STEPS.length, 4);
    assert.equal(ONBOARDING_STEPS[0].title, '👋 ¡Bienvenido a Pisto!');
    assert.equal(
      ONBOARDING_STEPS[0].description,
      'Tu plataforma de control financiero personal y familiar, privada y 100% adaptada a Honduras.'
    );
    const step1Html = renderOnboardingStepMarkup(0, {
      selectedCurrency: wizard.selectedCurrency,
      selectedCountry: wizard.selectedCountry,
    });
    assert.ok(step1Html.includes('👋 ¡Bienvenido a Pisto!'));
    assert.ok(step1Html.includes('onboarding-country-select'));
    assert.ok(step1Html.includes('onboarding-currency-select'));
    assert.equal(wizard.selectedCurrency, 'HNL');
    assert.equal(wizard.selectedCountry, 'HN');

    // Step 2: "💳 Cuentas y Metas"
    wizard.nextStep();
    assert.equal(wizard.currentStepIndex, 1);
    assert.equal(ONBOARDING_STEPS[1].title, '💳 Cuentas y Metas');
    assert.ok(ONBOARDING_STEPS[1].description.includes('Banco Atlántida, BAC, Ficohsa'));
    const step2Html = wizard.render();
    assert.ok(step2Html.includes('💳 Cuentas y Metas'));

    // Step 3: "📊 Transacciones y Espacio Familiar"
    wizard.nextStep();
    assert.equal(wizard.currentStepIndex, 2);
    assert.equal(ONBOARDING_STEPS[2].title, '📊 Transacciones y Espacio Familiar');
    assert.ok(ONBOARDING_STEPS[2].description.includes('Token Único de Invitación'));
    const step3Html = wizard.render();
    assert.ok(step3Html.includes('📊 Transacciones y Espacio Familiar'));

    // Step 4: "🔒 Tus datos son tuyos" + primary button "🚀 Comenzar a usar Pisto"
    wizard.nextStep();
    assert.equal(wizard.currentStepIndex, 3);
    assert.equal(ONBOARDING_STEPS[3].title, '🔒 Tus datos son tuyos');
    assert.ok(ONBOARDING_STEPS[3].description.includes('Local-First'));
    assert.ok(ONBOARDING_STEPS[3].description.includes('Gemini API Key'));
    const step4Html = wizard.render();
    assert.ok(step4Html.includes('🔒 Tus datos son tuyos'));
    assert.ok(step4Html.includes(ONBOARDING_FINISH_BUTTON_ID));
    assert.ok(step4Html.includes(ONBOARDING_FINISH_BUTTON_LABEL));

    // 4. Finish Wizard -> closes modal, updates Firestore users/{uid} hasCompletedOnboarding: true
    const finishedProfile = await wizard.finish({
      firestoreDb: mockDb,
      firestoreModule: mockFirestoreModule,
      storage,
    });

    assert.equal(wizard.isOpen, false);
    assert.equal(finishedProfile.hasCompletedOnboarding, true);
    assert.equal(finishedProfile.defaultCurrency, 'HNL');
    assert.equal(finishedProfile.country, 'HN');
    assert.equal(firestoreStores.users.get(user.uid)?.hasCompletedOnboarding, true);
    assert.equal(shouldTriggerOnboarding(finishedProfile), false);
    assert.ok(completedPayload);
    assert.equal(completedPayload.hasCompletedOnboarding, true);

    // 5. Verify Empty State markup contains highlighted primary action buttons
    const emptyStateHtml = renderDashboardEmptyStateMarkup({
      archivedCount: 0,
      baseCurrency: 'HNL',
    });
    assert.ok(emptyStateHtml.includes(EMPTY_STATE_CTA_LABELS.CREATE_FIRST_ACCOUNT));
    assert.ok(emptyStateHtml.includes(EMPTY_STATE_CTA_LABELS.IMPORT_WITH_IMAGE_PDF));
    assert.ok(emptyStateHtml.includes('➕ Crear Primera Cuenta'));
    assert.ok(emptyStateHtml.includes('📷 Importar con Imagen/PDF'));
    assert.ok(emptyStateHtml.includes('onboarding-cta-highlight'));

    // 6. Verify zero console.log in OnboardingWizard and refactored CSS/JS files
    const onboardingFiles = [
      'src/js/components/OnboardingWizard.js',
      'public/js/ui/onboardingWizard.js',
      'public/js/services/authProfileService.js',
      'public/js/repositories/storageRepository.js',
      'src/css/styles.css',
      'public/css/index.css',
    ];
    for (const relPath of onboardingFiles) {
      const content = await fs.readFile(new URL(`../${relPath}`, import.meta.url), 'utf8');
      const stripped = content
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      assert.equal(
        stripped.includes('console.log('),
        false,
        `Expected zero console.log in ${relPath}`
      );
    }
  });
});


