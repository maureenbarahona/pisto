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

describe('Dashboard Global Metrics Zero Reset, Residual Cleanup & Safe Savings Rate (src/js/services/dashboard.js)', () => {
  it('initializes Dashboard KPIs in strict zero (L 0.00, + L 0.00, - L 0.00, 0%) in Firestore and UI, purges residual transactions, and prevents division-by-zero (-4397%)', async () => {
    const fs = await import('node:fs/promises');
    const {
      ZERO_DASHBOARD_METRICS,
      calculateSafeSavingsRate,
      recalculateDashboardMetrics,
      resetGlobalDashboardMetricsToZero,
      initializeDashboardStateForNewUser,
      purgeResidualTransactionsFromWorkspace,
    } = await import('../src/js/services/dashboard.js');

    // 1. Safe Savings Rate guard: totalIncome === 0 must strictly return 0 (never -4397% or -Infinity)
    assert.equal(calculateSafeSavingsRate(0, 0, false), 0);
    assert.equal(calculateSafeSavingsRate(0, 4397, true), 0);
    assert.equal(calculateSafeSavingsRate(0, 1250.5, true), 0);
    assert.equal(calculateSafeSavingsRate(-100, 500, true), 0);
    assert.equal(calculateSafeSavingsRate(10000, 2500, true), 75);

    // 2. Recalculate metrics when state still holds demo seed records for an authenticated workspace
    const dirtyState = createSeedState();
    dirtyState.settings.workspaceId = 'ws_uid_nuevo_usuario';
    dirtyState.settings.currentUid = 'uid_nuevo_usuario';
    dirtyState.settings.baseCurrency = 'HNL';

    const recalcBeforeCleanup = recalculateDashboardMetrics(dirtyState, {
      workspaceId: 'ws_uid_nuevo_usuario',
      currentUid: 'uid_nuevo_usuario',
      baseCurrency: 'HNL',
    });
    assert.equal(recalcBeforeCleanup.totalIncludedBalance, 0);
    assert.equal(recalcBeforeCleanup.totalIncome, 0);
    assert.equal(recalcBeforeCleanup.totalExpenses, 0);
    assert.equal(recalcBeforeCleanup.savingsRate, 0);
    assert.equal(recalcBeforeCleanup.savingsRatePct, 0);
    assert.equal(recalcBeforeCleanup.patrimonioLabel, 'L 0.00');
    assert.equal(recalcBeforeCleanup.ingresosLabel, '+ L 0.00');
    assert.equal(recalcBeforeCleanup.gastosLabel, '- L 0.00');
    assert.equal(recalcBeforeCleanup.tasaAhorroLabel, '0%');

    // Also verify computeAccountsSummary & computePeriodAnalytics in financeService.js
    const summaryFromFinance = computeAccountsSummary(dirtyState);
    const analyticsFromFinance = computePeriodAnalytics(dirtyState);
    assert.equal(summaryFromFinance.totalIncludedBalance, 0);
    assert.equal(analyticsFromFinance.totalIncome, 0);
    assert.equal(analyticsFromFinance.totalExpense, 0);
    assert.equal(analyticsFromFinance.savingsRatePct, 0);

    // Verify computePeriodAnalytics when user has an expense but 0 income (e.g. L 43.97 expense, L 0.00 income)
    const expenseOnlyState = {
      settings: {
        baseCurrency: 'HNL',
        periodFilter: 'all',
        workspaceId: 'ws_uid_nuevo_usuario',
        currentUid: 'uid_nuevo_usuario',
      },
      accounts: [
        createAccount({
          id: 'acc_user_real_1',
          name: 'Cuenta BAC',
          type: 'bank',
          currency: 'HNL',
          initialBalance: 0,
          workspaceId: 'ws_uid_nuevo_usuario',
          createdByUid: 'uid_nuevo_usuario',
        }),
      ],
      categories: dirtyState.categories,
      budgets: {},
      transactions: [
        createTransaction({
          id: 'tx_user_real_1',
          type: 'expense',
          amount: 4397,
          currency: 'HNL',
          categoryId: 'cat_food',
          accountId: 'acc_user_real_1',
          date: '2026-10-21',
          note: 'Supermercado',
          workspaceId: 'ws_uid_nuevo_usuario',
          createdByUid: 'uid_nuevo_usuario',
        }),
      ],
    };
    const expenseOnlyAnalytics = computePeriodAnalytics(expenseOnlyState);
    const expenseOnlyRecalc = recalculateDashboardMetrics(expenseOnlyState);
    assert.equal(expenseOnlyAnalytics.totalIncome, 0);
    assert.equal(expenseOnlyAnalytics.totalExpense, 4397);
    assert.equal(expenseOnlyAnalytics.savingsRatePct, 0);
    assert.equal(expenseOnlyRecalc.savingsRate, 0);
    assert.equal(expenseOnlyRecalc.tasaAhorroLabel, '0%');

    // 3. Verify resetGlobalDashboardMetricsToZero / initializeDashboardStateForNewUser in Firestore & DOM
    const domElements = {
      'kpi-total-balance': { textContent: '$999.99' },
      'kpi-period-income': { textContent: '+$500.00' },
      'kpi-period-expense': { textContent: '-$250.00' },
      'kpi-savings-rate': { textContent: '-4397%' },
    };
    const mockDoc = {
      getElementById(id) {
        return domElements[id] || null;
      },
    };

    const firestoreStores = {
      users: new Map(),
      workspaces: new Map(),
      accounts: new Map([
        ['acc_seed_residual', { id: 'acc_seed_residual', workspaceId: 'ws_uid_nuevo_usuario' }],
      ]),
      transactions: new Map([
        ['tx_seed_1', { id: 'tx_seed_1', workspaceId: 'ws_uid_nuevo_usuario', amount: 1850 }],
      ]),
      budgets: new Map(),
    };

    const mockFirestoreModule = {
      doc: (_db, col, id) => ({ col, id }),
      getDoc: async (ref) => ({
        exists: () => firestoreStores[ref.col]?.has(ref.id) || false,
        data: () => firestoreStores[ref.col]?.get(ref.id) || null,
      }),
      setDoc: async (ref, data, opts) => {
        const prev = opts?.merge ? firestoreStores[ref.col]?.get(ref.id) || {} : {};
        firestoreStores[ref.col]?.set(ref.id, { ...prev, ...data });
      },
      collection: (_db, col) => ({ col }),
      where: (field, op, val) => ({ field, op, val }),
      query: (colRef, ...conds) => ({ col: colRef.col, conds }),
      getDocs: async (q) => {
        const store = firestoreStores[q.col] || new Map();
        const docs = [];
        for (const [id, data] of store.entries()) {
          const matches = (q.conds || []).every((c) => data[c.field] === c.val);
          if (matches) {
            docs.push({
              id,
              ref: { col: q.col, id },
              data: () => data,
            });
          }
        }
        return { empty: docs.length === 0, docs };
      },
      writeBatch: () => {
        const ops = [];
        return {
          delete: (ref) => ops.push(ref),
          commit: async () => {
            for (const r of ops) {
              firestoreStores[r.col]?.delete(r.id);
            }
          },
        };
      },
    };

    const resetMetrics = await initializeDashboardStateForNewUser({
      workspaceId: 'ws_uid_nuevo_usuario',
      uid: 'uid_nuevo_usuario',
      baseCurrency: 'HNL',
      state: dirtyState,
      firestoreDb: {},
      firestoreModule: mockFirestoreModule,
      docRef: mockDoc,
    });

    assert.equal(resetMetrics.patrimonioLabel, ZERO_DASHBOARD_METRICS.patrimonioLabel);
    assert.equal(resetMetrics.ingresosLabel, ZERO_DASHBOARD_METRICS.ingresosLabel);
    assert.equal(resetMetrics.gastosLabel, ZERO_DASHBOARD_METRICS.gastosLabel);
    assert.equal(resetMetrics.tasaAhorroLabel, ZERO_DASHBOARD_METRICS.tasaAhorroLabel);

    // Check strict UI strings:
    assert.equal(domElements['kpi-total-balance'].textContent, 'L 0.00');
    assert.equal(domElements['kpi-period-income'].textContent, '+ L 0.00');
    assert.equal(domElements['kpi-period-expense'].textContent, '- L 0.00');
    assert.equal(domElements['kpi-savings-rate'].textContent, '0%');

    // Check Firestore persistence of zero metrics and residual transaction cleanup:
    assert.equal(firestoreStores.transactions.size, 0);
    assert.equal(firestoreStores.accounts.size, 0);
    const wsDoc = firestoreStores.workspaces.get('ws_uid_nuevo_usuario');
    assert.ok(wsDoc?.dashboardMetrics);
    assert.equal(wsDoc.dashboardMetrics.patrimonioEnCuentas, 'L 0.00');
    assert.equal(wsDoc.dashboardMetrics.ingresosDelPeriodo, '+ L 0.00');
    assert.equal(wsDoc.dashboardMetrics.gastosDelPeriodo, '- L 0.00');
    assert.equal(wsDoc.dashboardMetrics.tasaDeAhorro, '0%');

    // Check zero console.log in dashboard service files
    for (const relPath of [
      'src/js/services/dashboard.js',
      'public/js/services/dashboard.js',
      'public/js/services/financeService.js',
      'public/js/app.js',
    ]) {
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

describe('22. Extracción e Importación Masiva en Lote (Array/Batch) de Cuentas y Tarjetas', () => {
  it('valida el esquema Genkit/Gemini Vision (accountsArray), sanitiza comas y normaliza LPS -> HNL / USD', async () => {
    const {
      ACCOUNT_EXTRACTOR_SYSTEM_PROMPT,
      EXTRACTED_ACCOUNT_JSON_SCHEMA,
      BATCH_DEMO_PRODUCTS_SUMMARY,
      validateExtractedAccount,
      parseBatchAccountsFromTextFallback,
      ExtractedBatchAccountsSchema,
    } = await import('../src/js/services/accountExtractor.js');

    assert.ok(ACCOUNT_EXTRACTOR_SYSTEM_PROMPT.includes('accountsArray'));
    assert.ok(EXTRACTED_ACCOUNT_JSON_SCHEMA.properties.accountsArray);
    assert.ok(EXTRACTED_ACCOUNT_JSON_SCHEMA.required.includes('accountsArray'));

    const parsed = ExtractedBatchAccountsSchema.parse({
      bankName: 'BAC Credomatic',
      accountsArray: [
        {
          accountType: 'HN - CUENTA BANCARIA',
          accountNumber: '726935871',
          currency: 'LPS',
          currentBalance: '401.28',
          isCreditCard: false,
        },
        {
          accountType: 'HN - CUENTA BANCARIA',
          accountNumber: '751666931',
          currency: '$',
          currentBalance: '3,705.95',
          isCreditCard: false,
        },
        {
          accountType: 'HN - Negocio Lempiras',
          accountNumber: '758886371',
          currency: 'LPS',
          currentBalance: '5,963.18',
          isCreditCard: false,
        },
        {
          accountType: 'AMERICAN EXPRESS',
          accountNumber: '3244',
          currency: 'LPS',
          currentBalance: '8,154.03',
          isCreditCard: true,
        },
      ],
    });

    assert.equal(parsed.bankName, 'BAC Credomatic');
    assert.equal(parsed.accountsArray.length, 4);
    assert.equal(parsed.accountsArray[0].currency, 'HNL');
    assert.equal(parsed.accountsArray[0].currentBalance, 401.28);
    assert.equal(parsed.accountsArray[1].currency, 'USD');
    assert.equal(parsed.accountsArray[1].currentBalance, 3705.95);
    assert.equal(parsed.accountsArray[2].currentBalance, 5963.18);
    assert.equal(parsed.accountsArray[3].isCreditCard, true);
    assert.equal(parsed.accountsArray[3].accountNumber, '3244');
    assert.equal(parsed.accountsArray[3].currentBalance, 8154.03);

    assert.equal(BATCH_DEMO_PRODUCTS_SUMMARY.accountsArray.length, 4);

    const ocrBatch = parseBatchAccountsFromTextFallback(`
      BAC Credomatic - Resumen de Productos
      Cuentas Bancarias
      HN - CUENTA BANCARIA 726935871 LPS 401.28
      HN - CUENTA BANCARIA 751666931 USD 3,705.95
      HN - Negocio Lempiras 758886371 LPS 5,963.18
      Tarjetas de crédito
      AMERICAN EXPRESS *3244 LPS 8,154.03
    `);
    const validatedOcr = validateExtractedAccount(ocrBatch);
    assert.equal(validatedOcr.bankName, 'BAC Credomatic');
    assert.equal(validatedOcr.accountsArray.length, 4);
    assert.equal(validatedOcr.accountsArray[1].currency, 'USD');
    assert.equal(validatedOcr.accountsArray[1].currentBalance, 3705.95);
    assert.equal(validatedOcr.accountsArray[3].isCreditCard, true);
  });

  it('renderiza filas editables con checkboxes y Seleccionar / Deseleccionar todas en BatchAccountsModal', async () => {
    const {
      BatchAccountsModal,
      formatBatchAccountRowSummary,
      renderBatchAccountsRowsMarkup,
    } = await import('../src/js/components/BatchAccountsModal.js');
    const { BATCH_DEMO_PRODUCTS_SUMMARY } = await import('../src/js/services/accountExtractor.js');

    const summaries = BATCH_DEMO_PRODUCTS_SUMMARY.accountsArray.map((item) =>
      formatBatchAccountRowSummary(item)
    );
    assert.deepEqual(summaries, [
      '[x] HN - CUENTA BANCARIA | N.° 726935871 | 401.28 HNL',
      '[x] HN - CUENTA BANCARIA | N.° 751666931 | 3,705.95 USD',
      '[x] HN - Negocio Lempiras | N.° 758886371 | 5,963.18 HNL',
      '[x] AMERICAN EXPRESS | N.° 3244 | 8,154.03 HNL',
    ]);

    const modal = new BatchAccountsModal({
      getState: () => ({
        accounts: [{ id: 'acc_existing', accountNumber: '726935871' }],
      }),
    });

    modal.loadBatchPayload(BATCH_DEMO_PRODUCTS_SUMMARY);
    assert.equal(modal.rows.length, 4);
    assert.equal(modal.rows[0].alreadyExists, true);
    assert.equal(modal.rows[1].alreadyExists, false);

    // Edit row 1 fields before confirming
    modal.updateRowField(1, 'accountType', 'HN - Cuenta Dólares');
    modal.updateRowField(1, 'currentBalance', '4,250.50');
    assert.equal(modal.rows[1].accountType, 'HN - Cuenta Dólares');
    assert.equal(modal.rows[1].currentBalance, 4250.5);

    // Toggle Select / Deselect All
    modal.toggleSelectAll(false);
    assert.equal(modal.rows.every((r) => r.selected === false), true);
    modal.toggleSelectAll(true);
    assert.equal(modal.rows.every((r) => r.selected === true), true);

    const htmlMarkup = renderBatchAccountsRowsMarkup(modal.rows);
    assert.ok(htmlMarkup.includes('data-batch-row-type="0"'));
    assert.ok(htmlMarkup.includes('data-batch-row-number="1"'));
    assert.ok(htmlMarkup.includes('data-batch-row-currency="2"'));
    assert.ok(htmlMarkup.includes('data-batch-row-balance="3"'));
  });

  it('ejecuta writeBatch atómico en Firestore, omite números de cuenta duplicados y muestra el toast exacto', async () => {
    const fs = await import('node:fs/promises');
    const {
      saveBatchAccountsToFirestore,
      formatBatchAccountsToastMessage,
      BATCH_DEMO_PRODUCTS_SUMMARY,
    } = await import('../src/js/services/accountExtractor.js');

    const firestoreAccountsStore = new Map([
      [
        'acc_dup_726935871',
        {
          id: 'acc_dup_726935871',
          workspaceId: 'ws_batch_test',
          accountNumber: '726935871',
          name: 'BAC Credomatic - HN - CUENTA BANCARIA',
          currency: 'HNL',
        },
      ],
    ]);

    let writeBatchCommitCalls = 0;
    const mockFirestoreModule = {
      collection: (_db, col) => ({ col }),
      where: (field, op, val) => ({ field, op, val }),
      query: (colRef, ...conds) => ({ col: colRef.col, conds }),
      getDocs: async (q) => {
        const docs = [];
        for (const [id, data] of firestoreAccountsStore.entries()) {
          const matches = (q.conds || []).every((c) => data[c.field] === c.val);
          if (matches) {
            docs.push({ id, data: () => data });
          }
        }
        return { empty: docs.length === 0, docs };
      },
      doc: (_db, col, id) => ({ col, id }),
      writeBatch: () => {
        const stagedWrites = [];
        return {
          set: (ref, payload) => {
            stagedWrites.push({ ref, payload });
          },
          commit: async () => {
            writeBatchCommitCalls += 1;
            for (const op of stagedWrites) {
              firestoreAccountsStore.set(op.ref.id, op.payload);
            }
          },
        };
      },
    };

    const localState = {
      userProfile: { uid: 'uid_batch_user', workspaceId: 'ws_batch_test' },
      accounts: [
        {
          id: 'acc_dup_726935871',
          workspaceId: 'ws_batch_test',
          accountNumber: '726935871',
          name: 'BAC Credomatic - HN - CUENTA BANCARIA',
          currency: 'HNL',
          initialBalanceCents: 40128,
        },
      ],
    };

    const batchResult = await saveBatchAccountsToFirestore(
      {
        bankName: 'BAC Credomatic',
        accountsArray: BATCH_DEMO_PRODUCTS_SUMMARY.accountsArray,
      },
      {
        state: localState,
        workspaceId: 'ws_batch_test',
        uid: 'uid_batch_user',
        firestoreDb: {},
        firestoreModule: mockFirestoreModule,
      }
    );

    assert.equal(writeBatchCommitCalls, 1);
    assert.equal(batchResult.savedCount, 3);
    assert.equal(batchResult.skippedDuplicatesCount, 1);
    assert.equal(
      batchResult.toastMessage,
      '🎉 Se registraron 3 cuentas exitosamente (y se omitieron 1 duplicadas).'
    );
    assert.equal(
      formatBatchAccountsToastMessage(3, 1),
      '🎉 Se registraron 3 cuentas exitosamente (y se omitieron 1 duplicadas).'
    );
    assert.equal(firestoreAccountsStore.size, 4);
    assert.equal(localState.accounts.length, 4);

    // Verify credit card classification & balance on AMERICAN EXPRESS 3244
    const amexAccount = batchResult.createdAccounts.find((a) => a.accountNumber === '3244');
    assert.ok(amexAccount);
    assert.equal(amexAccount.type, 'card');
    assert.equal(amexAccount.isCreditCard, true);
    assert.equal(amexAccount.currentBalance, 8154.03);

    // Verify zero console.log in new/updated batch modules
    for (const relPath of [
      'src/js/services/accountExtractor.js',
      'public/js/services/accountExtractor.js',
      'src/js/components/BatchAccountsModal.js',
      'src/js/components/ImportAccountModal.js',
    ]) {
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

describe('23. Persistencia del Onboarding Wizard en Firestore (users/{uid}), Verificación en Login y Limpieza en Logout', () => {
  it('deshabilita el botón final, ejecuta updateDoc(doc(db, "users", auth.currentUser.uid), { hasCompletedOnboarding: true }), remueve el modal del DOM y muestra el Dashboard', async () => {
    const fs = await import('node:fs/promises');
    const {
      OnboardingWizard,
      ONBOARDING_WIZARD_DIALOG_ID,
      ONBOARDING_FINISH_BUTTON_ID,
    } = await import('../src/js/components/OnboardingWizard.js');
    const {
      buildDefaultUserDocument,
      registerNewUserDocument,
      verifyUserOnboardingOnSignIn,
      cleanupOnboardingOnLogout,
    } = await import('../src/js/services/auth.js');

    // 1. Verificar que todo nuevo documento en `users` incluya `hasCompletedOnboarding: false` por defecto
    const defaultDoc = buildDefaultUserDocument({
      uid: 'uid_catracho_onboarding',
      email: 'nuevo@pisto.hn',
      displayName: 'Catracho Nuevo',
    });
    assert.equal(defaultDoc.hasCompletedOnboarding, false);

    const usersFirestoreMap = new Map();
    const updateDocCalls = [];

    const mockFirestoreModule = {
      doc: (_db, col, id) => ({ col, id }),
      getDoc: async (ref) => ({
        exists: () => usersFirestoreMap.has(ref.id),
        data: () => usersFirestoreMap.get(ref.id) || null,
      }),
      setDoc: async (ref, data, opts) => {
        const prev = opts?.merge ? usersFirestoreMap.get(ref.id) || {} : {};
        usersFirestoreMap.set(ref.id, { ...prev, ...data });
      },
      updateDoc: async (ref, updates) => {
        updateDocCalls.push({ ref, updates });
        const prev = usersFirestoreMap.get(ref.id) || { uid: ref.id };
        usersFirestoreMap.set(ref.id, { ...prev, ...updates });
      },
    };

    const registeredDoc = await registerNewUserDocument(
      { uid: 'uid_catracho_onboarding', email: 'nuevo@pisto.hn', displayName: 'Catracho Nuevo' },
      { db: {}, firestoreModule: mockFirestoreModule }
    );
    assert.equal(registeredDoc.hasCompletedOnboarding, false);
    assert.equal(usersFirestoreMap.get('uid_catracho_onboarding').hasCompletedOnboarding, false);

    // 2. Al iniciar sesión con hasCompletedOnboarding: false, inicializa el Wizard
    let dialogRemoved = false;
    const mockDialogEl = {
      id: ONBOARDING_WIZARD_DIALOG_ID,
      open: true,
      innerHTML: '',
      dataset: {},
      close() {
        this.open = false;
      },
      removeAttribute() {},
      remove() {
        dialogRemoved = true;
      },
    };
    const mockDashboardPanel = {
      id: 'panel-categories',
      hidden: true,
      classList: {
        removedClasses: [],
        remove(cls) {
          this.removedClasses.push(cls);
        },
      },
      removeAttribute(attr) {
        if (attr === 'hidden') this.hidden = false;
      },
    };
    const mockDocRef = {
      getElementById(id) {
        if (id === ONBOARDING_WIZARD_DIALOG_ID) return dialogRemoved ? null : mockDialogEl;
        if (id === 'panel-categories') return mockDashboardPanel;
        return null;
      },
      querySelectorAll() {
        return dialogRemoved ? [] : [mockDialogEl];
      },
    };

    const wizard = new OnboardingWizard();
    wizard.dialogEl = mockDialogEl;
    wizard.isOpen = true;

    const signInCheckInitial = await verifyUserOnboardingOnSignIn('uid_catracho_onboarding', {
      db: {},
      firestoreModule: mockFirestoreModule,
      wizard,
      docRef: mockDocRef,
    });
    assert.equal(signInCheckInitial.hasCompletedOnboarding, false);
    assert.equal(signInCheckInitial.wizardInitialized, true);

    // 3. Al hacer clic en "🚀 Comenzar a usar Pisto":
    //    a) Deshabilita el botón temporalmente
    //    b) Obtiene auth.currentUser.uid
    //    c) Ejecuta await updateDoc(doc(db, "users", auth.currentUser.uid), { hasCompletedOnboarding: true })
    //    d) Remueve el modal del DOM y muestra el Dashboard
    const mockFinishBtn = {
      id: ONBOARDING_FINISH_BUTTON_ID,
      disabled: false,
      ariaBusy: null,
      setAttribute(name, val) {
        if (name === 'aria-busy') this.ariaBusy = val;
      },
    };

    const mockAuth = {
      currentUser: {
        uid: 'uid_catracho_onboarding',
        email: 'nuevo@pisto.hn',
      },
    };

    await wizard.finish({
      buttonEl: mockFinishBtn,
      auth: mockAuth,
      db: {},
      firestoreModule: mockFirestoreModule,
      docRef: mockDocRef,
    });

    assert.equal(mockFinishBtn.disabled, true);
    assert.ok(updateDocCalls.length >= 1);
    assert.equal(updateDocCalls[0].ref.col, 'users');
    assert.equal(updateDocCalls[0].ref.id, 'uid_catracho_onboarding');
    assert.equal(updateDocCalls[0].updates.hasCompletedOnboarding, true);
    assert.equal(usersFirestoreMap.get('uid_catracho_onboarding').hasCompletedOnboarding, true);
    assert.equal(dialogRemoved, true);
    assert.equal(wizard.isOpen, false);
    assert.equal(mockDashboardPanel.hidden, false);

    // 4. Al volver a iniciar sesión cuando hasCompletedOnboarding === true, NO invoca ni renderiza el Wizard
    let wizardOpenedAgain = false;
    const secondWizard = {
      open() {
        wizardOpenedAgain = true;
      },
      checkAndStartForUser() {
        wizardOpenedAgain = true;
      },
    };
    const signInCheckAfterComplete = await verifyUserOnboardingOnSignIn('uid_catracho_onboarding', {
      db: {},
      firestoreModule: mockFirestoreModule,
      wizard: secondWizard,
      docRef: mockDocRef,
    });
    assert.equal(signInCheckAfterComplete.hasCompletedOnboarding, true);
    assert.equal(signInCheckAfterComplete.wizardInitialized, false);
    assert.equal(wizardOpenedAgain, false);

    // 5. Al cerrar sesión (Logout), remueve cualquier modal residual del DOM y resetea estados locales
    dialogRemoved = false;
    wizard.dialogEl = mockDialogEl;
    wizard.isOpen = true;
    wizard.currentStepIndex = 3;
    const logoutResult = cleanupOnboardingOnLogout({
      wizard,
      docRef: mockDocRef,
    });
    assert.equal(logoutResult.modalRemoved, true);
    assert.equal(dialogRemoved, true);
    assert.equal(wizard.isOpen, false);
    assert.equal(wizard.currentStepIndex, 0);
    assert.equal(wizard.activeUser, null);
    assert.equal(wizard.activeProfile, null);

    // 6. Cero llamadas a console.log en auth.js, authProfileService.js y OnboardingWizard.js
    for (const relPath of [
      'src/js/services/auth.js',
      'public/js/services/auth.js',
      'public/js/services/authProfileService.js',
      'src/js/components/OnboardingWizard.js',
    ]) {
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

// ---------------------------------------------------------------------------
// 24. Unificación en "Seleccionar Imagen o PDF", Eliminación de Filtro Superior
//     y Visibilidad Directa de "Cerrar Sesión" en Header
// ---------------------------------------------------------------------------
describe('ImportAccountModal Unification (accounts[]), Top Filter Removal & Header Logout UX', () => {
  it('elimina permanentemente Cargar Resumen de Productos (Lote), devuelve siempre accounts[], y permite editar/eliminar/seleccionar cada cuenta en ImportAccountModal', async () => {
    const fs = await import('node:fs/promises');
    const {
      ACCOUNT_EXTRACTOR_SYSTEM_PROMPT,
      EXTRACTED_ACCOUNT_JSON_SCHEMA,
      validateExtractedAccount,
    } = await import('../src/js/services/accountExtractor.js');

    // 1. Esquema y validador SIEMPRE devuelven el arreglo `accounts` (incluso para 1 sola cuenta)
    assert.ok(ACCOUNT_EXTRACTOR_SYSTEM_PROMPT.includes('accounts'));
    assert.ok(EXTRACTED_ACCOUNT_JSON_SCHEMA.properties.accounts);
    assert.ok(EXTRACTED_ACCOUNT_JSON_SCHEMA.required.includes('accounts'));

    const singleExtracted = validateExtractedAccount({
      bankName: 'BAC Credomatic',
      accountType: 'HN - CUENTA BANCARIA',
      accountNumber: '726935871',
      currency: 'LPS',
      availableBalance: '401.28',
    });
    assert.ok(Array.isArray(singleExtracted.accounts));
    assert.equal(singleExtracted.accounts.length, 1);
    assert.equal(singleExtracted.accounts[0].bankName, 'BAC Credomatic');
    assert.equal(singleExtracted.accounts[0].accountNumber, '726935871');
    assert.equal(singleExtracted.accounts[0].currency, 'HNL');
    assert.equal(singleExtracted.accounts[0].currentBalance, 401.28);

    // 2. ImportAccountModal elimina #btn-import-batch-demo-summary y soporta edición/eliminación/checkboxes por registro
    const importModalSource = await fs.readFile(
      new URL('../src/js/components/ImportAccountModal.js', import.meta.url),
      'utf8'
    );
    assert.equal(
      importModalSource.includes('Cargar Resumen de Productos (Lote)'),
      false,
      'El botón Cargar Resumen de Productos (Lote) debe haber sido eliminado permanentemente'
    );
    assert.equal(
      importModalSource.includes('btn-import-batch-demo-summary'),
      false,
      'El id btn-import-batch-demo-summary no debe existir en ImportAccountModal.js'
    );
    assert.ok(importModalSource.includes('Seleccionar Imagen o PDF'));

    const state = {
      accounts: [],
      transactions: [],
      categories: [],
      settings: { workspaceId: 'ws_ux_refactor' },
    };
    const modal = new ImportAccountModal({
      getState: () => state,
      getContext: () => ({ workspaceId: 'ws_ux_refactor' }),
    });

    // Cargamos 3 cuentas en la vista previa del modal
    modal.populateForm({
      bankName: 'BAC Credomatic',
      accounts: [
        {
          bankName: 'BAC Credomatic',
          accountType: 'HN - CUENTA BANCARIA',
          accountNumber: '726935871',
          currency: 'HNL',
          currentBalance: 401.28,
          isCreditCard: false,
          selected: true,
        },
        {
          bankName: 'BAC Credomatic',
          accountType: 'HN - CUENTA BANCARIA',
          accountNumber: '751666931',
          currency: 'USD',
          currentBalance: 3705.95,
          isCreditCard: false,
          selected: true,
        },
        {
          bankName: 'BAC Credomatic',
          accountType: 'AMERICAN EXPRESS',
          accountNumber: '3244',
          currency: 'HNL',
          currentBalance: 8154.03,
          isCreditCard: true,
          selected: true,
        },
      ],
    });

    assert.equal(modal.extractedAccounts.length, 3);

    // ✏️ Editar cuenta individual (Banco, Tipo, Número, Moneda, Saldo)
    modal.editAccountRow(1, {
      bankName: 'Banco Atlántida',
      accountType: 'Cuenta Ahorro Dólares',
      accountNumber: '99887766',
      currency: 'USD',
      currentBalance: '4,250.50',
    });
    assert.equal(modal.extractedAccounts[1].bankName, 'Banco Atlántida');
    assert.equal(modal.extractedAccounts[1].accountType, 'Cuenta Ahorro Dólares');
    assert.equal(modal.extractedAccounts[1].accountNumber, '99887766');
    assert.equal(modal.extractedAccounts[1].currency, 'USD');
    assert.equal(modal.extractedAccounts[1].currentBalance, 4250.5);

    // 🗑️ Eliminar cuenta individual de la lista antes de guardar
    const afterRemove = modal.removeExtractedAccount(0);
    assert.equal(afterRemove.length, 2);
    assert.equal(modal.extractedAccounts[0].accountNumber, '99887766');

    // Checkboxes: seleccionar / deseleccionar en lote
    modal.toggleSelectAllAccounts(false);
    assert.equal(modal.getSelectedAccounts().length, 0);
    modal.updateAccountAtIndex(0, 'selected', true);
    assert.equal(modal.getSelectedAccounts().length, 1);
    assert.equal(modal.getSelectedAccounts()[0].accountNumber, '99887766');
  });

  it('elimina por completo el filtro superior inútil y coloca Cerrar Sesión con visibilidad directa en el Header', async () => {
    const fs = await import('node:fs/promises');

    for (const htmlFile of ['index.html', 'public/index.html']) {
      const html = await fs.readFile(new URL(`../${htmlFile}`, import.meta.url), 'utf8');
      // Filtro superior eliminado
      assert.equal(html.includes('btn-toggle-mobile-filters'), false);
      assert.equal(html.includes('header-filter-toggle-btn'), false);
      assert.equal(html.includes('active-profile-filter-bar'), false);
      assert.equal(html.includes('profile-filter-banner'), false);

      // Botón Cerrar Sesión extraído al Header con clase estilizada .header-logout-btn
      const headerMatch = html.match(/<header class="top-header"[\s\S]*?<\/header>/);
      assert.ok(headerMatch, `Debe existir <header class="top-header"> en ${htmlFile}`);
      assert.ok(
        headerMatch[0].includes('id="btn-profile-signout"'),
        `El botón #btn-profile-signout debe estar directamente en el Header en ${htmlFile}`
      );
      assert.ok(
        headerMatch[0].includes('header-logout-btn'),
        `El botón Cerrar Sesión debe usar .header-logout-btn en ${htmlFile}`
      );

      // No debe quedar duplicado dentro de #panel-profile
      const profileSectionMatch = html.match(/id="panel-profile"[\s\S]*?<\/section>/);
      assert.ok(profileSectionMatch);
      assert.equal(
        profileSectionMatch[0].includes('id="btn-profile-signout"'),
        false,
        `El botón Cerrar Sesión no debe estar oculto dentro de #panel-profile en ${htmlFile}`
      );
    }

    for (const cssFile of ['src/css/styles.css', 'public/css/index.css']) {
      const css = await fs.readFile(new URL(`../${cssFile}`, import.meta.url), 'utf8');
      assert.equal(css.includes('.header-filter-toggle-btn'), false);
      assert.equal(css.includes('.profile-filter-banner'), false);
      assert.ok(css.includes('.header-logout-btn'));
    }

    const appJs = await fs.readFile(new URL('../public/js/app.js', import.meta.url), 'utf8');
    assert.equal(appJs.includes('btn-toggle-mobile-filters'), false);
    assert.equal(appJs.includes('renderProfileFilterBanner'), false);

    // Verificación de 0 console.log en todos los archivos refactorizados
    for (const relPath of [
      'src/js/components/ImportAccountModal.js',
      'src/js/components/BatchAccountsModal.js',
      'src/js/services/accountExtractor.js',
      'public/js/ui/profileView.js',
      'public/js/app.js',
    ]) {
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

// ---------------------------------------------------------------------------
// 25. Visibilidad Condicional de "Cerrar Sesión", Extractor Adaptativo (accountsList),
//     Bandera Onboarding en Firestore (users/{uid}) y Footer de la Aplicación
// ---------------------------------------------------------------------------
describe('Conditional Logout Visibility, Adaptive Account Extractor (accountsList), Onboarding Flag & Footer', () => {
  function makeMemStorage() {
    const store = new Map();
    return {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };
  }

  it('1. muestra el botón "Cerrar Sesión" ÚNICAMENTE cuando auth.currentUser !== null y lo oculta (display: none) sin sesión activa', async () => {
    const fs = await import('node:fs/promises');
    const { syncLogoutButtonVisibility } = await import('../src/js/services/auth.js');

    for (const htmlFile of ['index.html', 'public/index.html']) {
      const html = await fs.readFile(new URL(`../${htmlFile}`, import.meta.url), 'utf8');
      const btnMatch = html.match(/<button[^>]*id="btn-profile-signout"[^>]*>/);
      assert.ok(btnMatch, `Debe existir #btn-profile-signout en ${htmlFile}`);
      assert.ok(
        btnMatch[0].includes('display: none') || btnMatch[0].includes('hidden'),
        `#btn-profile-signout debe estar oculto por defecto sin sesión en ${htmlFile}`
      );
    }

    // Simulamos el botón en el DOM
    const fakeSignoutBtn = {
      hidden: false,
      style: { display: '' },
      classes: new Set(),
      attributes: new Map(),
      classList: {
        add(cls) {
          fakeSignoutBtn.classes.add(cls);
        },
        remove(cls) {
          fakeSignoutBtn.classes.delete(cls);
        },
        contains(cls) {
          return fakeSignoutBtn.classes.has(cls);
        },
      },
      setAttribute(k, v) {
        fakeSignoutBtn.attributes.set(k, v);
      },
      removeAttribute(k) {
        fakeSignoutBtn.attributes.delete(k);
      },
    };
    const fakeDoc = {
      getElementById(id) {
        return id === 'btn-profile-signout' ? fakeSignoutBtn : null;
      },
    };

    // Caso A: Sin sesión iniciada (auth.currentUser === null) -> oculto por completo (display: none)
    const visibleWhenLoggedOut = syncLogoutButtonVisibility({ currentUser: null }, fakeDoc);
    assert.equal(visibleWhenLoggedOut, false);
    assert.equal(fakeSignoutBtn.style.display, 'none');
    assert.equal(fakeSignoutBtn.hidden, true);
    assert.equal(fakeSignoutBtn.classList.contains('is-hidden'), true);

    // Caso B: Sesión activa (auth.currentUser !== null) -> visible
    const visibleWhenLoggedIn = syncLogoutButtonVisibility(
      { currentUser: { uid: 'uid_active_123', email: 'mau@pisto.hn' } },
      fakeDoc
    );
    assert.equal(visibleWhenLoggedIn, true);
    assert.equal(fakeSignoutBtn.style.display, '');
    assert.equal(fakeSignoutBtn.hidden, false);
    assert.equal(fakeSignoutBtn.classList.contains('is-hidden'), false);
  });

  it('2. extrae siempre accountsList (agnóstico de banco/formato), infiere formatos nuevos por contexto y aprende patrones adaptativos', async () => {
    const {
      ACCOUNT_EXTRACTOR_SYSTEM_PROMPT,
      EXTRACTED_ACCOUNT_JSON_SCHEMA,
      buildAccountExtractorSystemPrompt,
      learnAdaptiveAccountPattern,
      getLearnedBankPatterns,
      inferAccountsFromUnstructuredText,
      validateExtractedAccount,
    } = await import('../src/js/services/accountExtractor.js');

    // Prompt y esquema exigen accountsList con los 5 campos obligatorios
    assert.ok(ACCOUNT_EXTRACTOR_SYSTEM_PROMPT.includes('accountsList'));
    assert.ok(EXTRACTED_ACCOUNT_JSON_SCHEMA.properties.accountsList);
    assert.ok(EXTRACTED_ACCOUNT_JSON_SCHEMA.required.includes('accountsList'));

    // Inferencia por contexto de negocio en un formato nuevo / no reconocido previamente
    const unrecognizedBankOcr = [
      'Cooperativa Sagrada Familia - Portal Digital',
      'Ahorro Navideño Preferencial',
      'No. Producto: 880011223344',
      'Disponible a la fecha: L 14,890.75',
      'Tarjeta Visa Cooperativa **** 7788',
      'Saldo al corte: $ 420.50',
    ].join('\n');

    const inferredList = inferAccountsFromUnstructuredText(unrecognizedBankOcr);
    assert.ok(Array.isArray(inferredList));
    assert.ok(inferredList.length >= 2);
    assert.equal(inferredList[0].accountNumber, '880011223344');
    assert.equal(inferredList[0].currency, 'HNL');
    assert.equal(inferredList[0].currentBalance, 14890.75);
    assert.equal(inferredList[1].accountNumber, '7788');
    assert.equal(inferredList[1].currency, 'USD');
    assert.equal(inferredList[1].currentBalance, 420.5);

    const validated = validateExtractedAccount({
      bankName: 'Cooperativa Sagrada Familia',
      accountsList: inferredList,
    });
    assert.ok(Array.isArray(validated.accountsList));
    assert.equal(validated.accountsList.length, inferredList.length);
    assert.equal(validated.accountsList[0].currentBalance, 14890.75);

    // Aprendizaje adaptativo al confirmar/editar cuenta
    const memStorage = makeMemStorage();
    learnAdaptiveAccountPattern(
      {
        bankName: 'Cooperativa Sagrada Familia',
        accountType: 'Ahorro Navideño Preferencial',
        currency: 'HNL',
      },
      unrecognizedBankOcr,
      memStorage
    );
    const learned = getLearnedBankPatterns(memStorage);
    assert.equal(learned.length, 1);
    assert.equal(learned[0].bankName, 'Cooperativa Sagrada Familia');
    const adaptivePrompt = buildAccountExtractorSystemPrompt({ storage: memStorage });
    assert.ok(adaptivePrompt.includes('Cooperativa Sagrada Familia'));
    assert.ok(adaptivePrompt.includes('Ahorro Navideño Preferencial'));
  });

  it('3. persiste hasCompletedOnboarding: false al registrar usuario y actualiza hasCompletedOnboarding: true con updateDoc al finalizar el Wizard', async () => {
    const {
      OnboardingWizard,
      verifyUserOnboardingOnSignIn,
    } = await import('../src/js/components/OnboardingWizard.js');

    const memStorage = makeMemStorage();
    const authService = new FirebaseAuthProfileService(memStorage);

    // Al registrar un nuevo usuario en users/{uid}, escribe explícitamente hasCompletedOnboarding: false
    const regResult = await authService.signInOrRegisterWithEmail(
      'nuevo.usuario@pisto.hn',
      'Pass123!',
      'register',
      'Nuevo Usuario'
    );
    assert.equal(regResult.profile.hasCompletedOnboarding, false);

    // Simulamos llamadas reales al SDK modular de Firestore: doc(db, "users", auth.currentUser.uid) + updateDoc(...)
    const firestoreCalls = [];
    const fakeDb = { name: 'firestore-pisto' };
    const fakeAuth = {
      currentUser: {
        uid: regResult.user.uid,
        email: regResult.user.email,
      },
    };
    const fakeFirestoreModule = {
      doc(db, col, id) {
        firestoreCalls.push({ op: 'doc', col, id });
        return { db, path: `${col}/${id}` };
      },
      async updateDoc(ref, data) {
        firestoreCalls.push({ op: 'updateDoc', path: ref.path, data });
      },
      async getDoc(ref) {
        return {
          exists: () => true,
          data: () => ({
            uid: regResult.user.uid,
            email: regResult.user.email,
            hasCompletedOnboarding: true,
          }),
        };
      },
    };

    authService.firebaseAuth = fakeAuth;
    authService.firestoreDb = fakeDb;
    authService.firestoreModule = fakeFirestoreModule;

    const state = {
      accounts: [],
      transactions: [],
      categories: [],
      budgets: {},
      settings: { baseCurrency: 'HNL', workspaceId: regResult.profile.workspaceId },
    };

    const wizard = new OnboardingWizard({
      authService,
      getState: () => state,
    });
    const finishRes = await wizard.finish();
    assert.equal(finishRes.hasCompletedOnboarding, true);

    const updateCall = firestoreCalls.find((c) => c.op === 'updateDoc');
    assert.ok(updateCall, 'Debe invocarse updateDoc sobre users/{uid}');
    assert.equal(updateCall.path, `users/${regResult.user.uid}`);
    assert.deepEqual(updateCall.data, { hasCompletedOnboarding: true });

    // Al iniciar sesión nuevamente, lee users/{uid} y si hasCompletedOnboarding === true NO muestra el Wizard
    const signInCheck = await verifyUserOnboardingOnSignIn({
      auth: fakeAuth,
      db: fakeDb,
      firestoreModule: fakeFirestoreModule,
      storage: memStorage,
    });
    assert.equal(signInCheck.hasCompletedOnboarding, true);
    assert.equal(signInCheck.shouldShowWizard, false);

    wizard.open();
    assert.equal(wizard.isOpen, false, 'No debe abrir el Wizard si hasCompletedOnboarding === true');
  });

  it('4. actualiza el <footer> con el texto exacto y el enlace a https://maureenbarahona.foo con target="_blank" rel="noopener"', async () => {
    const fs = await import('node:fs/promises');

    for (const htmlFile of ['index.html', 'public/index.html']) {
      const html = await fs.readFile(new URL(`../${htmlFile}`, import.meta.url), 'utf8');
      const footerMatch = html.match(/<footer[\s\S]*?<\/footer>/);
      assert.ok(footerMatch, `Debe existir <footer> en ${htmlFile}`);
      const footerHtml = footerMatch[0];
      assert.ok(
        footerHtml.includes(
          'Hecho con Gemini 2.5 Flash / Agent Development Kit · Prompt por Maureen Barahona · Website:'
        ),
        `El footer en ${htmlFile} debe incluir el texto exacto de créditos`
      );
      assert.ok(
        footerHtml.includes(
          '<a href="https://maureenbarahona.foo" target="_blank" rel="noopener">https://maureenbarahona.foo</a>'
        ),
        `El footer en ${htmlFile} debe incluir el enlace con target="_blank" rel="noopener"`
      );
    }
  });

  it('5. cierra el modal al dar clic en "🚀 Comenzar a usar Pisto" y persiste hasCompletedOnboarding=true incluso si Firestore rechaza updateDoc y setDoc', async () => {
    const {
      OnboardingWizard,
      shouldTriggerOnboarding,
      verifyUserOnboardingOnSignIn,
    } = await import('../src/js/app.js');
    const { FirebaseAuthProfileService } = await import('../src/js/services/auth.js');

    const memStore = new Map();
    const memStorage = {
      getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
      setItem: (k, v) => memStore.set(k, String(v)),
      removeItem: (k) => memStore.delete(k),
    };

    const authService = new FirebaseAuthProfileService(memStorage);
    const uid = 'uid_resilient_wizard_user';
    const email = 'resilient@pisto.hn';

    // Simulamos un entorno donde Firestore rechaza tanto updateDoc como setDoc (ej. permisos de reglas en Cloud Firestore)
    const failingFirestoreModule = {
      doc: (db, col, id) => ({ db, path: `${col}/${id}` }),
      updateDoc: async () => {
        const err = new Error('Missing or insufficient permissions.');
        err.code = 'permission-denied';
        throw err;
      },
      setDoc: async () => {
        const err = new Error('Missing or insufficient permissions.');
        err.code = 'permission-denied';
        throw err;
      },
      getDoc: async () => {
        const err = new Error('Missing or insufficient permissions.');
        err.code = 'permission-denied';
        throw err;
      },
    };

    authService.firebaseAuth = { currentUser: { uid, email } };
    authService.firestoreDb = { name: 'firestore-restricted' };
    authService.firestoreModule = failingFirestoreModule;
    authService.currentUser = { uid, email, displayName: 'Usuario Resiliente' };
    authService.currentProfile = {
      uid,
      email,
      name: 'Usuario Resiliente',
      country: 'HN',
      defaultCurrency: 'HNL',
      workspaceId: `ws_${uid}`,
      hasCompletedOnboarding: false,
    };

    const state = {
      accounts: [],
      transactions: [],
      categories: [],
      budgets: {},
      settings: {
        baseCurrency: 'HNL',
        workspaceId: `ws_${uid}`,
        currentUid: uid,
      },
    };

    let completedCallbackFired = false;
    const wizard = new OnboardingWizard({
      authService,
      getState: () => state,
      onComplete: ({ hasCompletedOnboarding }) => {
        if (hasCompletedOnboarding === true) {
          completedCallbackFired = true;
        }
      },
    });

    // Simulamos elemento dialog y botón de Paso 4 ("🚀 Comenzar a usar Pisto")
    let finishBtnHandler = null;
    const fakeFinishBtn = {
      id: 'btn-onboarding-finish',
      disabled: false,
      setAttribute() {},
      set onclick(fn) {
        finishBtnHandler = fn;
      },
      get onclick() {
        return finishBtnHandler;
      },
    };

    let dialogRemoved = false;
    wizard.dialogEl = {
      open: true,
      innerHTML: '',
      close() {
        this.open = false;
      },
      remove() {
        dialogRemoved = true;
      },
      querySelector(sel) {
        if (sel.includes('btn-onboarding-finish') || sel.includes('finish')) {
          return fakeFinishBtn;
        }
        return null;
      },
      querySelectorAll() {
        return [];
      },
    };

    wizard.isOpen = true;
    wizard.currentStepIndex = 3;
    wizard.render();

    assert.equal(typeof fakeFinishBtn.onclick, 'function', 'El botón final debe vincular onclick directo al renderizar Paso 4');

    // Ejecutamos finish() tal como lo invoca el clic en "🚀 Comenzar a usar Pisto"
    const updatedProfile = await wizard.finish({
      buttonEl: fakeFinishBtn,
      storage: memStorage,
    });

    assert.equal(updatedProfile.hasCompletedOnboarding, true);
    assert.equal(wizard.isOpen, false, 'El modal debe cerrarse inmediatamente');
    assert.equal(dialogRemoved, true, 'El modal debe removerse del DOM');
    assert.equal(completedCallbackFired, true, 'El callback onComplete debe ejecutarse');
    assert.equal(memStorage.getItem(`pisto_onboarding_completed_${uid}`), 'true');
    assert.equal(memStorage.getItem(`pisto_onboarding_completed_${email}`), 'true');

    // Simulamos recarga de página (F5) donde loadUserProfile vuelve a ejecutarse con Firestore fallando o devolviendo doc sin el flag
    const reloadedAuthService = new FirebaseAuthProfileService(memStorage);
    reloadedAuthService.firebaseAuth = { currentUser: { uid, email } };
    reloadedAuthService.firestoreDb = { name: 'firestore-restricted' };
    reloadedAuthService.firestoreModule = failingFirestoreModule;

    const reloadedProfile = await reloadedAuthService.loadUserProfile(uid, { email });
    assert.equal(
      reloadedProfile.hasCompletedOnboarding,
      true,
      'Tras recargar la página, loadUserProfile debe conservar hasCompletedOnboarding === true'
    );
    assert.equal(shouldTriggerOnboarding(reloadedProfile), false);

    const signInVerify = await verifyUserOnboardingOnSignIn({
      uid,
      user: { uid, email },
      db: { name: 'firestore-restricted' },
      firestoreModule: failingFirestoreModule,
      storage: memStorage,
    });
    assert.equal(signInVerify.hasCompletedOnboarding, true);
    assert.equal(signInVerify.shouldShowWizard, false);
  });
});

// ---------------------------------------------------------------------------
// 26. Extractor con Aprendizaje de Formatos (`templateLearner.js`),
//     Arquitectura Híbrida (Cloud Few-Shot + Local IndexedDB/OCR) y UI de Lote
// ---------------------------------------------------------------------------
describe('Adaptive Format-Learning Extractor (templateLearner.js, bank_templates & ImportAccountModal)', () => {
  function createMockStorage() {
    const map = new Map();
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    };
  }

  function createMockIndexedDb() {
    const stores = new Map();
    return {
      stores,
      open(_name, _version) {
        const req = {
          result: null,
          onupgradeneeded: null,
          onsuccess: null,
          onerror: null,
        };
        queueMicrotask(() => {
          const db = {
            objectStoreNames: {
              contains: (storeName) => stores.has(storeName),
            },
            createObjectStore(storeName) {
              if (!stores.has(storeName)) {
                stores.set(storeName, new Map());
              }
              return stores.get(storeName);
            },
            transaction(storeName) {
              if (!stores.has(storeName)) {
                stores.set(storeName, new Map());
              }
              const storeMap = stores.get(storeName);
              const tx = {
                oncomplete: null,
                onerror: null,
                objectStore() {
                  return {
                    put(val) {
                      storeMap.set(val.bankId, val);
                      queueMicrotask(() => tx.oncomplete && tx.oncomplete());
                    },
                    getAll() {
                      const getReq = { result: Array.from(storeMap.values()), onsuccess: null };
                      queueMicrotask(() => getReq.onsuccess && getReq.onsuccess());
                      return getReq;
                    },
                  };
                },
              };
              return tx;
            },
          };
          req.result = db;
          if (typeof req.onupgradeneeded === 'function') req.onupgradeneeded();
          if (typeof req.onsuccess === 'function') req.onsuccess();
        });
        return req;
      },
    };
  }

  it('1. consulta bank_templates en Firestore antes de llamar a Gemini 1.5 Flash Vision e inyecta Few-Shot Prompting dinámico', async () => {
    const {
      BANK_TEMPLATES_COLLECTION,
      extractOfflineWithLearnedTemplates,
      normalizeBankTemplate,
    } = await import('../src/js/services/templateLearner.js');
    const { extractAccountFromFile: extractFromService } = await import(
      '../src/js/services/accountExtractor.js'
    );
    assert.equal(BANK_TEMPLATES_COLLECTION, 'bank_templates');
    assert.equal(typeof extractOfflineWithLearnedTemplates, 'function');
    assert.equal(typeof extractFromService, 'function');

    const firestoreQueriedCollections = [];
    const mockFirestoreModule = {
      collection(_db, colName) {
        firestoreQueriedCollections.push(colName);
        return { colName };
      },
      async getDocs(colRef) {
        if (colRef.colName === 'bank_templates') {
          return {
            docs: [
              {
                id: 'ficohsa_empresarial',
                data: () =>
                  normalizeBankTemplate({
                    bankId: 'ficohsa_empresarial',
                    bankName: 'Banco Ficohsa',
                    keywords: ['Interbanca Ficohsa', 'Cuenta Corporativa Pyme'],
                    extractionRules: {
                      accountNumber: '\\b(\\d{10,14})\\b',
                      accountType: '(Cuenta\\s+Corporativa\\s+Pyme)',
                      currency: '(LPS|HNL|USD|\\$)',
                      currentBalance: '(\\d{1,3}(?:,\\d{3})+\\.\\d{2})',
                    },
                  }),
              },
            ],
          };
        }
        return { docs: [] };
      },
    };

    let capturedPromptText = '';
    const mockFetch = async (_url, init) => {
      const bodyObj = JSON.parse(init.body);
      capturedPromptText = bodyObj.contents?.[0]?.parts?.[0]?.text || '';
      return {
        ok: true,
        async json() {
          return {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        bankName: 'Banco Ficohsa',
                        accountsList: [
                          {
                            bankName: 'Banco Ficohsa',
                            accountType: 'Cuenta Corporativa Pyme',
                            accountNumber: '0102998877',
                            currency: 'HNL',
                            currentBalance: 45200.75,
                            isCreditCard: false,
                          },
                        ],
                      }),
                    },
                  ],
                },
              },
            ],
          };
        },
      };
    };

    const cloudRes = await extractFromService('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==', {
      apiKey: 'AIzaSyFakeTestGeminiKey',
      fetchImpl: mockFetch,
      firestoreDb: { name: 'mock-db' },
      firestoreModule: mockFirestoreModule,
      storage: createMockStorage(),
      indexedDb: createMockIndexedDb(),
    });

    assert.ok(
      firestoreQueriedCollections.includes('bank_templates'),
      'Debe consultar la colección bank_templates en Firestore antes de llamar a la IA'
    );
    assert.ok(
      capturedPromptText.includes('FEW-SHOT BANK TEMPLATES (bank_templates)'),
      'El prompt enviado a Gemini 1.5 Flash debe incluir la sección FEW-SHOT BANK TEMPLATES'
    );
    assert.ok(
      capturedPromptText.includes('ficohsa_empresarial') &&
        capturedPromptText.includes('Cuenta Corporativa Pyme'),
      'El prompt debe incluir las reglas aprendidas en bank_templates'
    );
    assert.equal(cloudRes.source, 'gemini-1.5-flash');
    assert.equal(cloudRes.accountsList.length, 1);
    assert.equal(cloudRes.accountsList[0].accountNumber, '0102998877');
  });

  it('2. extrae en Modo Local / Offline (Tesseract.js / IndexedDB bank_templates_local) los diseños reales de Banco Promerica App, BAC Web y BAC Móvil sin internet', async () => {
    const {
      BANK_TEMPLATES_LOCAL_STORE,
      extractOfflineWithLearnedTemplates,
    } = await import('../src/js/services/templateLearner.js');
    const { extractAccountFromFile } = await import('../src/js/services/accountExtractor.js');

    assert.equal(BANK_TEMPLATES_LOCAL_STORE, 'bank_templates_local');

    const mockIdb = createMockIndexedDb();
    const mockStorage = createMockStorage();

    // Captura 1: Banco Promerica App Móvil (número antes del tipo y saldo LPS 14,326.70)
    const promericaOcrText = [
      '3:46',
      'Banco Promerica',
      'Buenas tardes BARAHONA ALVARADO MAUREEN FLOR',
      'Último Ingreso: 15/10/2026 a las 11:13:45(181.115.63.192)',
      'Cuentas de cheques y ahorros',
      '10000000206587',
      'Ahorros',
      'Cuenta de Ahorros Personal (Lempiras)',
      'LPS 14,326.70',
      'Préstamos',
      'Tarjetas de crédito',
    ].join('\n');

    const promericaOffline = await extractAccountFromFile(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
      {
        offline: true,
        ocrReader: async () => promericaOcrText,
        indexedDb: mockIdb,
        storage: mockStorage,
      }
    );

    assert.equal(promericaOffline.source, 'local-template-engine:promerica_app');
    assert.equal(promericaOffline.bankName, 'Banco Promerica');
    assert.equal(promericaOffline.accountsList.length, 1);
    assert.equal(promericaOffline.accountsList[0].bankName, 'Banco Promerica');
    assert.equal(
      promericaOffline.accountsList[0].accountType,
      'Cuenta de Ahorros Personal (Lempiras)'
    );
    assert.equal(promericaOffline.accountsList[0].accountNumber, '10000000206587');
    assert.equal(promericaOffline.accountsList[0].currency, 'HNL');
    assert.equal(promericaOffline.accountsList[0].currentBalance, 14326.7);

    // Captura 2: BAC Credomatic Banca en Línea Web ("Resumen de productos" con Cuentas bancarias + Tarjetas de crédito)
    const bacWebOcrText = [
      'Resumen de productos',
      'En esta sección se muestran los productos que puede consultar en Banca en Línea.',
      'Cuentas bancarias',
      'MAUREEN FLOR BARAHONA ALVARADO',
      'Descripción Producto Saldo Ver Transferir',
      'HN - CUENTA BANCARIA 726935871 401.28 LPS',
      'HN - CUENTA BANCARIA 751666931 3,705.95 USD',
      'HN - Negocio Lempiras 758886371 5,963.18 LPS',
      'Total cuentas bancarias 3,941.43 USD',
      'Tarjetas de crédito',
      'MAUREEN/BARAHONA ALVARADO',
      'HN - AMERICAN EXPRESS 3777-43**-****-3244 8,154.03 LPS 0.00 USD',
      'HN - MASTERCARD 5140-00**-****-2869 1,255.70 LPS 225.90 USD',
      'HN - MASTERCARD 5491-50**-****-0618 46,852.97 LPS 11.49 USD',
    ].join('\n');

    const bacWebOffline = await extractOfflineWithLearnedTemplates(bacWebOcrText, {
      indexedDb: mockIdb,
      storage: mockStorage,
    });
    assert.equal(bacWebOffline.matched, true);
    assert.equal(bacWebOffline.template.bankId, 'bac_web');
    assert.equal(bacWebOffline.accountsList.length, 6);
    assert.equal(bacWebOffline.accountsList[0].accountNumber, '726935871');
    assert.equal(bacWebOffline.accountsList[0].currency, 'HNL');
    assert.equal(bacWebOffline.accountsList[0].currentBalance, 401.28);
    assert.equal(bacWebOffline.accountsList[1].accountNumber, '751666931');
    assert.equal(bacWebOffline.accountsList[1].currency, 'USD');
    assert.equal(bacWebOffline.accountsList[1].currentBalance, 3705.95);
    assert.equal(bacWebOffline.accountsList[3].accountNumber, '3244');
    assert.equal(bacWebOffline.accountsList[3].isCreditCard, true);
    assert.equal(bacWebOffline.accountsList[5].accountNumber, '0618');
    assert.equal(bacWebOffline.accountsList[5].currentBalance, 46852.97);

    // Captura 3: BAC Credomatic App Móvil ("Cuentas personales" + "Tarjetas personales")
    const bacMobileOcrText = [
      'Buenas tardes, Maureen',
      'Cuentas personales',
      'Maureen Flor Barahona Alvarado',
      'HN - Cuenta bancaria',
      '726935871',
      'L401.28',
      'HN - Cuenta bancaria',
      '751666931',
      '$3,705.95',
      'HN - Negocio Lempiras',
      '758886371',
      'L5,963.18',
      'Tarjetas personales',
      'Maureen/Barahona Alvarado',
      'HN - Tarjeta L8,154.03',
      'AMEX ****-3244 $0.00',
      'HN - Tarjeta L46,852.97',
      'MCARD ****-0618 $11.49',
    ].join('\n');

    const bacMobileOffline = await extractOfflineWithLearnedTemplates(bacMobileOcrText, {
      indexedDb: mockIdb,
      storage: mockStorage,
    });
    assert.equal(bacMobileOffline.matched, true);
    assert.equal(bacMobileOffline.template.bankId, 'bac_mobile');
    assert.equal(bacMobileOffline.accountsList.length, 5);
    assert.equal(bacMobileOffline.accountsList[0].accountNumber, '726935871');
    assert.equal(bacMobileOffline.accountsList[1].currency, 'USD');
    assert.equal(bacMobileOffline.accountsList[1].currentBalance, 3705.95);
    assert.equal(bacMobileOffline.accountsList[3].accountNumber, '3244');
    assert.equal(bacMobileOffline.accountsList[3].isCreditCard, true);
    assert.equal(bacMobileOffline.accountsList[4].accountNumber, '0618');
    assert.equal(bacMobileOffline.accountsList[4].currentBalance, 46852.97);
  });

  it('3. Flujo "Aprender sobre este Formato": guarda correcciones del usuario en bank_templates (Firestore + IndexedDB) y reconoce futuras capturas con 100% de precisión, guardando cuentas en lote con writeBatch', async () => {
    const fs = await import('node:fs/promises');
    const { ImportAccountModal } = await import('../src/js/components/ImportAccountModal.js');
    const { extractOfflineWithLearnedTemplates } = await import(
      '../src/js/services/templateLearner.js'
    );

    const mockStorage = createMockStorage();
    const mockIdb = createMockIndexedDb();
    const savedFirestoreDocs = new Map();
    let writeBatchCommitCount = 0;

    const mockFirestoreModule = {
      collection(_db, name) {
        return { name };
      },
      query(col) {
        return col;
      },
      where() {
        return {};
      },
      async getDocs() {
        return { docs: [] };
      },
      doc(_db, col, id) {
        return { path: `${col}/${id}`, col, id };
      },
      async setDoc(ref, data) {
        savedFirestoreDocs.set(ref.path, data);
      },
      writeBatch() {
        const staged = [];
        return {
          set(ref, data) {
            staged.push({ ref, data });
          },
          async commit() {
            writeBatchCommitCount += 1;
            for (const item of staged) {
              savedFirestoreDocs.set(item.ref.path, item.data);
            }
          },
        };
      },
    };

    const state = {
      accounts: [],
      transactions: [],
      categories: [],
      settings: { workspaceId: 'ws_learning_test' },
    };

    const modal = new ImportAccountModal({
      getState: () => state,
      getImportContext: () => ({
        workspaceId: 'ws_learning_test',
        firestoreDb: { name: 'mock-firestore' },
        firestoreModule: mockFirestoreModule,
        indexedDb: mockIdb,
        storage: mockStorage,
      }),
    });

    // Simulamos una captura nueva cuyo OCR tenía datos parciales que el usuario corrige en el modal
    const customBankOcr = [
      'Banca Digital Banrural Honduras',
      'Mis Productos Activos',
      'Producto: Ahorro Amigo Preferencial',
      'Ref: 5049900112233',
      'Disponible: LPS 28,450.00',
    ].join('\n');

    modal.lastOcrTextFallback = customBankOcr;
    modal.populateForm({
      bankName: 'Banco Atlántida', // Dato inicial impreciso antes de la corrección del usuario
      accountsList: [
        {
          bankName: 'Banco Atlántida',
          accountType: 'Cuenta de Ahorro',
          accountNumber: '5049900112233',
          currency: 'HNL',
          currentBalance: 28450.0,
          isCreditCard: false,
          selected: true,
        },
      ],
    });

    // El usuario corrige el banco y el tipo de cuenta, y agrega una segunda cuenta en el modal
    modal.editAccountRow(0, {
      bankName: 'Banrural Honduras',
      accountType: 'Ahorro Amigo Preferencial',
      accountNumber: '5049900112233',
      currency: 'HNL',
      currentBalance: 28450.0,
    });
    modal.addAccountRow({
      bankName: 'Banrural Honduras',
      accountType: 'Cuenta Cheques Corporativa',
      accountNumber: '5049900112244',
      currency: 'USD',
      currentBalance: 1500.0,
    });

    assert.equal(modal.accountsList.length, 2);

    // El usuario presiona "Confirmar y Crear X Cuentas"
    const confirmResult = await modal.handleConfirmCreate();
    assert.ok(confirmResult);
    assert.equal(confirmResult.createdCount, 2);
    assert.equal(confirmResult.batchCommitted, true);
    assert.ok(writeBatchCommitCount >= 1, 'Debe guardar las cuentas en lote mediante writeBatch');

    // Verificar que el patrón ajustado se guardó en `bank_templates` (Firestore + IndexedDB `bank_templates_local`)
    assert.ok(confirmResult.learnedTemplate, 'Debe retornar la plantilla aprendida');
    assert.equal(confirmResult.learnedTemplate.bankName, 'Banrural Honduras');
    assert.ok(
      Array.isArray(confirmResult.learnedTemplate.keywords) &&
        confirmResult.learnedTemplate.keywords.includes('Banrural Honduras')
    );
    assert.ok(confirmResult.learnedTemplate.extractionRules.accountNumber);
    assert.ok(confirmResult.learnedTemplate.extractionRules.accountType);
    assert.ok(confirmResult.learnedTemplate.extractionRules.currency);
    assert.ok(confirmResult.learnedTemplate.extractionRules.currentBalance);
    assert.ok(
      savedFirestoreDocs.has(`bank_templates/${confirmResult.learnedTemplate.bankId}`),
      'Debe guardar el documento de formato aprendido en la colección bank_templates de Firestore'
    );
    assert.ok(
      mockIdb.stores.get('bank_templates_local')?.has(confirmResult.learnedTemplate.bankId),
      'Debe guardar el documento de formato aprendido en bank_templates_local de IndexedDB'
    );

    // La próxima vez que cualquier usuario suba una captura con esa misma estructura visual/texto,
    // el sistema reconoce el patrón instantáneamente con 100% de precisión
    const nextUploadRecognition = await extractOfflineWithLearnedTemplates(customBankOcr, {
      indexedDb: mockIdb,
      storage: mockStorage,
    });
    assert.equal(nextUploadRecognition.matched, true);
    assert.equal(nextUploadRecognition.bankName, 'Banrural Honduras');
    assert.equal(nextUploadRecognition.accountsList[0].bankName, 'Banrural Honduras');
    assert.equal(
      nextUploadRecognition.accountsList[0].accountType,
      'Ahorro Amigo Preferencial'
    );
    assert.equal(nextUploadRecognition.accountsList[0].accountNumber, '5049900112233');
    assert.equal(nextUploadRecognition.accountsList[0].currentBalance, 28450.0);

    // Verificar cero llamados a console.log en todos los módulos entregados
    for (const relPath of [
      'src/js/services/templateLearner.js',
      'public/js/services/templateLearner.js',
      'src/js/services/accountExtractor.js',
      'src/js/components/ImportAccountModal.js',
    ]) {
      const src = await fs.readFile(new URL(`../${relPath}`, import.meta.url), 'utf8');
      const withoutComments = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      assert.equal(
        withoutComments.includes('console.log('),
        false,
        `El archivo ${relPath} no debe contener llamados a console.log`
      );
    }
  });
});

describe('27. Extractor Híbrido de Cuentas Bancarias (Tesseract.js Local + Gemini 2.5 Flash Vision Fallback)', () => {
  it('procesa en Etapa Primaria con Tesseract.js + bank_templates a costo 0 y cae en Etapa Secundaria con Gemini 2.5 Flash para formatos nuevos o baja confianza', async () => {
    const fs = await import('node:fs/promises');
    const {
      GEMINI_VISION_MODEL,
      BANK_PRODUCT_TYPES,
      sanitizeNumericAmount,
      sanitizeNumericAmountString,
      classifyBankProductType,
      parseMultiProductBankText,
      extractBankDataHybrid,
    } = await import('../src/js/services/ocrExtractor.js');
    const { ImportAccountModal } = await import('../src/js/components/ImportAccountModal.js');

    assert.equal(GEMINI_VISION_MODEL, 'gemini-2.5-flash');

    // 1. Sanitización estricta de montos numéricos (eliminando comas de miles para evitar recortar cifras)
    assert.equal(sanitizeNumericAmount('3,901.33'), 3901.33);
    assert.equal(sanitizeNumericAmountString('3,901.33'), '3901.33');
    assert.equal(sanitizeNumericAmount('L 14,326.70'), 14326.7);
    assert.equal(sanitizeNumericAmount('$ 3,705.95'), 3705.95);

    // 2. Clasificación de Tipos de Producto: Ahorro, Cheques, Tarjeta de Crédito, Préstamo
    assert.equal(
      classifyBankProductType('Cuenta de Ahorros Personal', '10000000206587').productType,
      BANK_PRODUCT_TYPES.SAVINGS
    );
    assert.equal(
      classifyBankProductType('HN - Negocio Lempiras (Cuenta Cheques)', '758886371').productType,
      BANK_PRODUCT_TYPES.CHECKING
    );
    assert.equal(
      classifyBankProductType('AMERICAN EXPRESS', '3244').productType,
      BANK_PRODUCT_TYPES.CREDIT_CARD
    );
    assert.equal(
      classifyBankProductType('Préstamo Personal Hipotecario', '900112233').productType,
      BANK_PRODUCT_TYPES.LOAN
    );

    // 3. Soporte Multiproducto y Multicuenta: Ahorro, Cheques, Tarjeta con DOBLE SALDO (HNL y USD) y Préstamo + Movimientos
    const multiProductBatchText = [
      'BAC Credomatic - Resumen de productos',
      'Cuentas bancarias',
      'HN - CUENTA BANCARIA 726935871 3,901.33 LPS',
      'HN - Negocio Lempiras 758886371 5,963.18 LPS',
      'Tarjetas de crédito',
      'HN - AMERICAN EXPRESS 3777-43**-****-3244 8,154.03 LPS 425.50 USD',
      'Préstamos',
      'HN - PRÉSTAMO PERSONAL 990011223 85,400.00 LPS',
      '15/10/2026 DEPOSITO DE AHORRO CON T/D Crédito L 200.00',
      '16/10/2026 SUPERMERCADOS LA COLONIA Débito L 1,250.40',
    ].join('\n');

    const multiParsed = parseMultiProductBankText(multiProductBatchText, {
      expandDualCurrencyCards: true,
    });

    // Debe extraer: 1 Ahorro + 1 Cheques + 2 registros de la Tarjeta AMEX (HNL y USD) + 1 Préstamo = 5 productos
    assert.equal(multiParsed.accountsList.length, 5);
    assert.equal(multiParsed.accountsList[0].currentBalance, 3901.33);
    assert.equal(multiParsed.accountsList[0].productType, 'Ahorro');
    assert.equal(multiParsed.accountsList[1].productType, 'Cheques');

    const amexHnl = multiParsed.accountsList.find(
      (a) => a.accountNumber === '3244' && a.currency === 'HNL'
    );
    const amexUsd = multiParsed.accountsList.find(
      (a) => a.accountNumber === '3244' && a.currency === 'USD'
    );
    assert.ok(amexHnl, 'Debe extraer el saldo en HNL de la tarjeta de doble saldo');
    assert.ok(amexUsd, 'Debe extraer el saldo en USD de la tarjeta de doble saldo');
    assert.equal(amexHnl.currentBalance, 8154.03);
    assert.equal(amexUsd.currentBalance, 425.5);
    assert.equal(amexHnl.productType, 'Tarjeta de Crédito');
    assert.equal(amexUsd.productType, 'Tarjeta de Crédito');

    const loanProduct = multiParsed.accountsList.find((a) => a.accountNumber === '990011223');
    assert.ok(loanProduct, 'Debe extraer el producto de Préstamo');
    assert.equal(loanProduct.productType, 'Préstamo');
    assert.equal(loanProduct.isLoan, true);
    assert.equal(loanProduct.currentBalance, 85400.0);

    assert.equal(multiParsed.transactionsList.length, 2);
    assert.equal(multiParsed.transactionsList[0].amount, 200.0);
    assert.equal(multiParsed.transactionsList[0].type, 'income');
    assert.equal(multiParsed.transactionsList[1].amount, 1250.4);
    assert.equal(multiParsed.transactionsList[1].type, 'expense');

    // 4. Etapa Primaria (Tesseract.js Local + bank_templates a costo 0 sin llamar a Gemini API)
    let geminiApiCalls = 0;
    const mockTesseractWorker = {
      async recognize() {
        return {
          data: {
            text: multiProductBatchText,
            confidence: 91,
          },
        };
      },
    };

    const stage1Result = await extractBankDataHybrid(
      { name: 'bac_multi.png', type: 'image/png' },
      {
        tesseractWorker: mockTesseractWorker,
        expandDualCurrencyCards: true,
        fetchImpl: async () => {
          geminiApiCalls += 1;
          throw new Error('No debe llamar a Gemini cuando Etapa Primaria tiene alta confianza y plantilla conocida');
        },
      }
    );

    assert.equal(stage1Result.stage, 'primary-local-ocr');
    assert.equal(stage1Result.usedGeminiFallback, false);
    assert.equal(stage1Result.apiCost, 0);
    assert.equal(geminiApiCalls, 0);
    assert.equal(stage1Result.bankName, 'BAC Credomatic');
    assert.equal(stage1Result.accountsList.length, 5);
    assert.equal(stage1Result.transactionsList.length, 2);

    // 5. Etapa Secundaria (Fallback con Gemini 2.5 Flash cuando la confianza del OCR local es baja o el formato es nuevo)
    let geminiEndpointCalled = '';
    let geminiSchemaChecked = false;
    const unknownFormatOcrText = 'Cooperativa Sagrada Familia\nCta Aportaciones #88004411\nDisp: L 3,901.33';

    const stage2Result = await extractBankDataHybrid(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      {
        apiKey: 'test-gemini-25-key',
        tesseractWorker: {
          async recognize() {
            return {
              data: {
                text: unknownFormatOcrText,
                confidence: 45, // Baja confianza -> dispara Fallback a Gemini 2.5 Flash
              },
            };
          },
        },
        fetchImpl: async (url, init) => {
          geminiEndpointCalled = String(url);
          const reqBody = JSON.parse(init.body);
          if (
            reqBody?.generationConfig?.responseMimeType === 'application/json' &&
            reqBody?.generationConfig?.responseSchema?.properties?.accountsList &&
            reqBody?.generationConfig?.responseSchema?.properties?.transactionsList
          ) {
            geminiSchemaChecked = true;
          }
          return {
            ok: true,
            async json() {
              return {
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          text: JSON.stringify({
                            bankName: 'Cooperativa Sagrada Familia',
                            accountsList: [
                              {
                                bankName: 'Cooperativa Sagrada Familia',
                                accountNumber: '88004411',
                                accountType: 'Cuenta de Aportaciones',
                                productType: 'Ahorro',
                                currency: 'HNL',
                                currentBalance: '3,901.33',
                                isCreditCard: false,
                                isLoan: false,
                              },
                              {
                                bankName: 'Cooperativa Sagrada Familia',
                                accountNumber: '88009900',
                                accountType: 'Préstamo Fiduciario',
                                productType: 'Préstamo',
                                currency: 'HNL',
                                currentBalance: '25,000.00',
                                isCreditCard: false,
                                isLoan: true,
                              },
                            ],
                            transactionsList: [
                              {
                                date: '2026-10-20',
                                concept: 'ABONO A APORTACIONES',
                                type: 'income',
                                amount: '500.00',
                                currency: 'HNL',
                              },
                            ],
                          }),
                        },
                      ],
                    },
                  },
                ],
              };
            },
          };
        },
      }
    );

    assert.equal(stage2Result.stage, 'secondary-gemini-vision');
    assert.equal(stage2Result.usedGeminiFallback, true);
    assert.ok(
      geminiEndpointCalled.includes('gemini-2.5-flash:generateContent'),
      'Debe invocar el modelo gemini-2.5-flash en la Etapa Secundaria'
    );
    assert.equal(
      geminiSchemaChecked,
      true,
      'Debe forzar respuesta estructurada en JSON con accountsList y transactionsList'
    );
    assert.equal(stage2Result.accountsList.length, 2);
    assert.equal(stage2Result.accountsList[0].currentBalance, 3901.33);
    assert.equal(stage2Result.accountsList[0].productType, 'Ahorro');
    assert.equal(stage2Result.accountsList[1].productType, 'Préstamo');
    assert.equal(stage2Result.accountsList[1].isLoan, true);
    assert.equal(stage2Result.transactionsList.length, 1);
    assert.equal(stage2Result.transactionsList[0].amount, 500.0);

    // 6. Vista Previa Editable en ImportAccountModal.js + Aprendizaje Automático en bank_templates + writeBatch atómico
    const savedFirestoreDocs = new Map();
    let batchCommits = 0;
    const mockFirestoreDb = { type: 'mock-hybrid-firestore' };
    const mockFirestoreModule = {
      collection: (_db, col) => ({ col }),
      query: (colRef) => colRef,
      where: () => ({}),
      getDocs: async () => ({ docs: [] }),
      doc: (_db, col, id) => ({ path: `${col}/${id}`, col, id }),
      setDoc: async (ref, data) => {
        savedFirestoreDocs.set(ref.path, data);
      },
      writeBatch: () => {
        const ops = [];
        return {
          set(ref, data) {
            ops.push({ ref, data });
          },
          async commit() {
            batchCommits += 1;
            for (const op of ops) {
              savedFirestoreDocs.set(op.ref.path, op.data);
            }
          },
        };
      },
    };

    const mockStorageMap = new Map();
    const mockStorage = {
      getItem: (k) => (mockStorageMap.has(k) ? mockStorageMap.get(k) : null),
      setItem: (k, v) => mockStorageMap.set(k, String(v)),
    };

    const appState = {
      accounts: [],
      transactions: [],
      settings: { workspaceId: 'ws_hybrid_test', currentUid: 'uid_hybrid_1' },
    };

    const modal = new ImportAccountModal({
      getState: () => appState,
      getImportContext: () => ({
        workspaceId: 'ws_hybrid_test',
        firestoreDb: mockFirestoreDb,
        firestoreModule: mockFirestoreModule,
        storage: mockStorage,
      }),
    });

    modal.lastOcrTextFallback = unknownFormatOcrText;
    modal.renderPreview(stage2Result, stage2Result.source);

    assert.equal(modal.accountsList.length, 2);
    assert.equal(modal.transactionsList.length, 1);

    // Editar valores en la vista previa editable, desmarcar o eliminar una fila y agregar otra
    modal.editAccountRow(0, {
      currentBalance: '4,150.75',
    });
    assert.equal(modal.accountsList[0].currentBalance, 4150.75);

    // Confirmar en el modal: guarda las cuentas con writeBatch y aprende el formato en bank_templates
    const confirmRes = await modal.handleConfirmCreate();
    assert.ok(confirmRes);
    assert.equal(confirmRes.createdCount, 2);
    assert.equal(confirmRes.batchCommitted, true);
    assert.ok(batchCommits >= 1, 'Debe usar writeBatch para guardado atómico en Firestore');
    assert.ok(confirmRes.learnedTemplate, 'Debe aprender y guardar la plantilla en bank_templates');
    assert.ok(
      savedFirestoreDocs.has(`bank_templates/${confirmRes.learnedTemplate.bankId}`),
      'El nuevo patrón debe quedar almacenado en la colección bank_templates'
    );

    // Verificar que una futura lectura de ese mismo banco ahora se ejecuta en Etapa Primaria (Local) a costo cero
    let subsequentGeminiCalls = 0;
    const subsequentRead = await extractBankDataHybrid(
      { name: 'cooperativa_2.png', type: 'image/png' },
      {
        storage: mockStorage,
        tesseractWorker: {
          async recognize() {
            return {
              data: {
                text: unknownFormatOcrText,
                confidence: 88,
              },
            };
          },
        },
        fetchImpl: async () => {
          subsequentGeminiCalls += 1;
          throw new Error('No debe llamar a Gemini API después de haber aprendido el formato');
        },
      }
    );

    assert.equal(subsequentRead.stage, 'primary-local-ocr');
    assert.equal(subsequentRead.usedGeminiFallback, false);
    assert.equal(subsequentRead.apiCost, 0);
    assert.equal(subsequentGeminiCalls, 0);
    assert.equal(subsequentRead.bankName, 'Cooperativa Sagrada Familia');
    assert.equal(subsequentRead.accountsList[0].accountNumber, '88004411');

    // 7. Verificar cero llamadas a console.log en ocrExtractor.js y módulos relacionados
    for (const relPath of [
      'src/js/services/ocrExtractor.js',
      'public/js/services/ocrExtractor.js',
      'src/js/services/templateLearner.js',
      'src/js/services/accountExtractor.js',
      'src/js/components/ImportAccountModal.js',
    ]) {
      const src = await fs.readFile(new URL(`../${relPath}`, import.meta.url), 'utf8');
      const withoutComments = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      assert.equal(
        withoutComments.includes('console.log('),
        false,
        `El archivo ${relPath} no debe contener llamadas a console.log`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 28. Extracción Completa de N Productos sin Límite (5 Posiciones BAC Credomatic)
//     y Reparación del Catálogo del Selector de Bancos en ImportAccountModal
// ---------------------------------------------------------------------------
describe('28. Extracción Completa de N Productos sin Límite y Reparación del Selector de Bancos en ImportAccountModal', () => {
  it('extrae las 5 posiciones completas de BAC Credomatic (incluyendo después de Tarjetas personales) y renderiza el catálogo completo de bancos de Honduras en <select> permitiendo onChange', async () => {
    const fs = await import('node:fs/promises');
    const {
      HYBRID_EXTRACTOR_SYSTEM_PROMPT,
      parseMultiProductBankText,
      extractBankDataHybrid,
    } = await import('../src/js/services/ocrExtractor.js');
    const {
      ACCOUNT_EXTRACTOR_SYSTEM_PROMPT,
      parseBatchAccountsFromTextFallback,
    } = await import('../src/js/services/accountExtractor.js');
    const {
      extractBacAccounts,
      applyTemplateExtractionRules,
      DEFAULT_BANK_TEMPLATES,
    } = await import('../src/js/services/templateLearner.js');
    const {
      ImportAccountModal,
      HONDURAS_BANKS_LIST,
      HONDURAS_BANK_CATALOG_GROUPS,
      renderBankSelectOptionsMarkup,
    } = await import('../src/js/components/ImportAccountModal.js');
    const { HONDURAS_FINANCIAL_ENTITIES } = await import('../public/js/domain/models.js');

    // 1. Verificar prompts del sistema actualizados para continuar después de "Tarjetas personales" sin truncar en 2 elementos
    assert.ok(HYBRID_EXTRACTOR_SYSTEM_PROMPT.includes('Tarjetas personales'));
    assert.ok(HYBRID_EXTRACTOR_SYSTEM_PROMPT.includes('726935871'));
    assert.ok(HYBRID_EXTRACTOR_SYSTEM_PROMPT.includes('751666931'));
    assert.ok(HYBRID_EXTRACTOR_SYSTEM_PROMPT.includes('758886371'));
    assert.ok(HYBRID_EXTRACTOR_SYSTEM_PROMPT.includes('3244'));
    assert.ok(HYBRID_EXTRACTOR_SYSTEM_PROMPT.includes('0618'));

    assert.ok(ACCOUNT_EXTRACTOR_SYSTEM_PROMPT.includes('Tarjetas personales'));
    assert.ok(ACCOUNT_EXTRACTOR_SYSTEM_PROMPT.includes('726935871'));
    assert.ok(ACCOUNT_EXTRACTOR_SYSTEM_PROMPT.includes('0618'));

    // 2. Imagen de ejemplo BAC Credomatic (App móvil con "Cuentas personales" y "Tarjetas personales")
    const bacFivePositionsOcrText = [
      'BAC Credomatic',
      'Cuentas personales',
      'HN - Cuenta',
      'bancaria 726935871 L401.28',
      'HN - Cuenta',
      'bancaria 751666931 $3,705.95',
      'HN - Negocio',
      'Lempiras 758886371 L5,963.18',
      'Tarjetas personales',
      'HN - Tarjeta L8,154.03',
      'AMEX ****-3244 $0.00',
      'HN - Tarjeta L46,852.97',
      'MCARD ****-0618 $11.49',
    ].join('\n');

    // 2.a) Verificar parseMultiProductBankText en ocrExtractor.js
    const multiParsedObj = parseMultiProductBankText(bacFivePositionsOcrText, {
      defaultBankName: 'BAC Credomatic',
    });
    const multiParsed = multiParsedObj.accountsList;
    assert.ok(
      multiParsed.length >= 5,
      `Se esperaban las 5 posiciones de BAC Credomatic en parseMultiProductBankText, se obtuvieron ${multiParsed.length}`
    );

    const pos1 = multiParsed.find((a) => a.accountNumber === '726935871');
    const pos2 = multiParsed.find((a) => a.accountNumber === '751666931');
    const pos3 = multiParsed.find((a) => a.accountNumber === '758886371');
    const pos4 = multiParsed.find((a) => a.accountNumber === '3244');
    const pos5 = multiParsed.find((a) => a.accountNumber === '0618');

    assert.ok(pos1, 'Falta posición 1: Cuenta bancaria 726935871');
    assert.equal(pos1.currency, 'HNL');
    assert.equal(pos1.currentBalance, 401.28);
    assert.equal(pos1.isCreditCard, false);

    assert.ok(pos2, 'Falta posición 2: Cuenta bancaria 751666931');
    assert.equal(pos2.currency, 'USD');
    assert.equal(pos2.currentBalance, 3705.95);
    assert.equal(pos2.isCreditCard, false);

    assert.ok(pos3, 'Falta posición 3: Negocio Lempiras 758886371');
    assert.equal(pos3.currency, 'HNL');
    assert.equal(pos3.currentBalance, 5963.18);
    assert.equal(pos3.isCreditCard, false);

    assert.ok(pos4, 'Falta posición 4: Tarjeta AMEX 3244');
    assert.equal(pos4.currency, 'HNL');
    assert.equal(pos4.currentBalance, 8154.03);
    assert.equal(pos4.isCreditCard, true);
    assert.ok(pos4.dualBalances);
    assert.equal(pos4.dualBalances.HNL, 8154.03);
    assert.equal(pos4.dualBalances.USD, 0);

    assert.ok(pos5, 'Falta posición 5: Tarjeta MCARD 0618');
    assert.equal(pos5.currency, 'HNL');
    assert.equal(pos5.currentBalance, 46852.97);
    assert.equal(pos5.isCreditCard, true);
    assert.ok(pos5.dualBalances);
    assert.equal(pos5.dualBalances.HNL, 46852.97);
    assert.equal(pos5.dualBalances.USD, 11.49);

    // 2.b) Verificar extractBacAccounts y applyTemplateExtractionRules en templateLearner.js
    const bacTemplateAccounts = extractBacAccounts(bacFivePositionsOcrText);
    assert.equal(bacTemplateAccounts.length, 5);
    const bacMobileTemplate = DEFAULT_BANK_TEMPLATES.find((t) => t.bankId === 'bac_mobile');
    const ruleResult = applyTemplateExtractionRules(bacFivePositionsOcrText, bacMobileTemplate);
    assert.equal(ruleResult.accountsList.length, 5);

    // 2.c) Verificar parseBatchAccountsFromTextFallback en accountExtractor.js
    const batchFallback = parseBatchAccountsFromTextFallback(bacFivePositionsOcrText);
    assert.equal(batchFallback.bankName, 'BAC Credomatic');
    assert.equal(batchFallback.accountsList.length, 5);
    assert.deepEqual(
      batchFallback.accountsList.map((a) => a.accountNumber),
      ['726935871', '751666931', '758886371', '3244', '0618']
    );

    // 2.d) Verificar extractBankDataHybrid end-to-end
    const hybridRes = await extractBankDataHybrid(
      { name: 'bac_5_posiciones.png', type: 'image/png' },
      {
        tesseractWorker: {
          async recognize() {
            return {
              data: {
                text: bacFivePositionsOcrText,
                confidence: 92,
              },
            };
          },
        },
      }
    );
    assert.equal(hybridRes.bankName, 'BAC Credomatic');
    assert.equal(hybridRes.accountsList.length, 5);

    // 3. Reparación del Selector "Nombre de Banco" en la UI (ImportAccountModal.js)
    //    Verificar que contiene exactamente las mismas entidades que "Entidad Bancaria" en "Modificar Cuenta o Meta"
    const expectedAllEntities = [
      ...HONDURAS_FINANCIAL_ENTITIES.bancos,
      ...HONDURAS_FINANCIAL_ENTITIES.cooperativas,
      ...HONDURAS_FINANCIAL_ENTITIES.financierasYBilleteras,
    ];
    for (const entity of expectedAllEntities) {
      assert.ok(
        HONDURAS_BANKS_LIST.includes(entity),
        `El catálogo del selector de bancos debe incluir "${entity}"`
      );
    }
    assert.equal(HONDURAS_BANK_CATALOG_GROUPS.length, 3);

    // Verificar que renderBankSelectOptionsMarkup SIEMPRE renderiza el catálogo completo y marca como selected el banco detectado por la IA
    const selectMarkup = renderBankSelectOptionsMarkup('BAC Credomatic');
    for (const entity of expectedAllEntities) {
      assert.ok(
        selectMarkup.includes(`value="${entity}"`),
        `El <select> debe incluir <option value="${entity}"> incluso cuando la IA detectó BAC Credomatic`
      );
    }
    assert.ok(
      selectMarkup.includes('<option value="BAC Credomatic" selected>BAC Credomatic</option>'),
      'El banco detectado por la IA (BAC Credomatic) debe marcarse como selected'
    );

    // Verificar que en ImportAccountModal el evento onChange / cambio de banco permite elegir cualquier otro banco sin bloquear ni limpiar las opciones
    const modal = new ImportAccountModal({
      getState: () => ({ accounts: [], transactions: [] }),
    });
    modal.renderPreview(hybridRes, hybridRes.source);
    assert.equal(modal.accountsList.length, 5);
    assert.equal(modal.accountsList[0].bankName, 'BAC Credomatic');

    // Simular cambio de banco en la fila 0 y globalmente a "Banco Atlántida" y luego a "Cooperativa Sagrada Familia"
    modal.updateAccountAtIndex(0, 'bankName', 'Banco Atlántida');
    assert.equal(modal.accountsList[0].bankName, 'Banco Atlántida');

    const rowTableHtmlAfterChange = modal.renderAccountsListTable();
    for (const entity of expectedAllEntities) {
      assert.ok(
        rowTableHtmlAfterChange.includes(`value="${entity}"`),
        `Después de cambiar el banco, el <select> debe seguir conteniendo todas las opciones del catálogo (${entity})`
      );
    }
    assert.ok(
      rowTableHtmlAfterChange.includes('<option value="Banco Atlántida" selected>Banco Atlántida</option>'),
      'El nuevo banco seleccionado debe quedar marcado como selected'
    );

    modal.updateAccountAtIndex(0, 'bankName', 'Cooperativa Sagrada Familia');
    assert.equal(modal.accountsList[0].bankName, 'Cooperativa Sagrada Familia');

    // 4. Cero llamados a console.log
    for (const relPath of [
      'src/js/services/ocrExtractor.js',
      'src/js/services/accountExtractor.js',
      'src/js/services/templateLearner.js',
      'src/js/components/ImportAccountModal.js',
    ]) {
      const content = await fs.readFile(new URL(`../${relPath}`, import.meta.url), 'utf8');
      const stripped = content
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      assert.equal(
        stripped.includes('console.log('),
        false,
        `Cero llamados a console.log permitidos en ${relPath}`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 29. Limpieza Completa de Estado en Logout y Estado Inicial para Visitantes
//     No Autenticados (src/js/services/auth.js, dashboard.js, app.js)
// ---------------------------------------------------------------------------
describe('29. Limpieza Completa de Estado en Logout y Estado Inicial para Visitantes No Autenticados', () => {
  it('limpia variables en memoria, resetea contadores y contenedores DOM a cero/vacío, limpia localStorage/sessionStorage en signOut y redirige al modal de Login para usuarios no autenticados', async () => {
    const fs = await import('node:fs/promises');
    const {
      cleanupOnboardingOnLogout,
      performCompleteLogoutCleanup,
      handleUnauthenticatedVisitorState,
      signOutWithCompleteCleanup,
      clearUserAndWorkspaceStorageKeys,
      resetInMemoryStateOnLogout,
      redirectToLoginModal,
    } = await import('../src/js/services/auth.js');
    const {
      resetDashboardDomToZeroAndEmpty,
      clearDashboardDomContainers,
    } = await import('../src/js/services/dashboard.js');

    // 1. Crear almacenamiento simulado con datos residuales de una sesión previa
    const storageMap = new Map([
      ['Pisto_open_finance_state_v1', JSON.stringify({ accounts: [{ id: 'acc_1', balance: 57843.49 }] })],
      ['pisto_local_auth_session_v1', JSON.stringify({ uid: 'uid_prev', email: 'prev@pisto.hn' })],
      ['pisto_gemini_api_key_v1', 'AIzaSySecretKey'],
      ['pisto_custom_firebase_config', '{"apiKey":"abc"}'],
      ['pisto_firestore_accounts_ws_ws_uid_prev', '[{"id":"acc_1"}]'],
      ['pisto_firestore_transactions_ws_ws_uid_prev', '[{"id":"tx_1"}]'],
      ['pisto_firestore_budgets_ws_ws_uid_prev', '{"food":5000}'],
      ['pisto_dashboard_metrics_ws_ws_uid_prev', '{"totalIncludedBalance":57843.49}'],
    ]);
    const mockStorage = {
      map: storageMap,
      get length() {
        return storageMap.size;
      },
      key(idx) {
        return Array.from(storageMap.keys())[idx] ?? null;
      },
      getItem(k) {
        return storageMap.has(k) ? storageMap.get(k) : null;
      },
      setItem(k, v) {
        storageMap.set(k, String(v));
      },
      removeItem(k) {
        storageMap.delete(k);
      },
      clear() {
        storageMap.clear();
      },
    };

    let sessionCleared = false;
    const mockSessionStorage = {
      clear() {
        sessionCleared = true;
      },
    };

    // 2. Crear elementos DOM simulados con datos residuales (ej. L 57,843.49 y 6 tarjetas de cuentas)
    const domElements = {
      'kpi-total-balance': { textContent: 'L 57,843.49' },
      'kpi-period-income': { textContent: '+ L 18,500.00' },
      'kpi-period-expense': { textContent: '- L 6,200.00' },
      'kpi-savings-rate': { textContent: '66%' },
      'accounts-grid': {
        innerHTML: '<article class="account-card">Banco Promerica</article><article class="account-card">Banco Ficohsa</article>',
      },
      'ledger-groups-mount': {
        innerHTML: '<section class="ledger-day-group">Transacción residual</section>',
      },
      'account-detail-tx-tbody': { innerHTML: '<tr><td>Detalle residual</td></tr>' },
      'statement-items-tbody': { innerHTML: '<tr><td>Estado de cuenta residual</td></tr>' },
      'import-account-accounts-tbody': { innerHTML: '<tr><td>Cuenta importada residual</td></tr>' },
      'import-account-tx-tbody': { innerHTML: '<tr><td>Movimiento importado residual</td></tr>' },
      'dashboard-empty-state-banner': {
        innerHTML: '<div>Banner</div>',
        classList: { add() {}, remove() {} },
      },
      'archived-accounts-count-badge': {
        textContent: '(3)',
        classList: { add() {}, toggle() {} },
      },
      'btn-profile-signout': {
        hidden: false,
        style: { display: '' },
        classList: { add() {}, remove() {} },
        setAttribute() {},
      },
      'auth-dialog': {
        open: false,
        showModal() {
          this.open = true;
        },
        setAttribute(attr) {
          if (attr === 'open') this.open = true;
        },
      },
    };
    const mockDoc = {
      getElementById(id) {
        return domElements[id] || null;
      },
      querySelectorAll() {
        return [];
      },
    };

    // 3. Estado en memoria con cuentas y transacciones previas
    const state = {
      currentWorkspaceId: 'ws_uid_prev',
      settings: {
        workspaceId: 'ws_uid_prev',
        currentUid: 'uid_prev',
        personalViewMode: true,
        baseCurrency: 'USD',
        currencyFilter: 'USD',
      },
      accounts: [
        { id: 'acc_promerica', name: 'Banco Promerica', initialBalance: 0 },
        { id: 'acc_ficohsa', name: 'Banco Ficohsa', initialBalance: 57843.49 },
      ],
      transactions: [{ id: 'tx_prev_1', amount: 1500, currency: 'HNL' }],
      budgets: { food: 4000 },
    };

    let authModalOpened = false;
    const mockApp = {
      currentWorkspaceId: 'ws_uid_prev',
      accounts: [...state.accounts],
      transactions: [...state.transactions],
      activeDetailAccountId: 'acc_ficohsa',
      lastInsightsResult: { summary: 'old' },
      ledgerFilters: { currencyFilter: 'USD', accountFilter: 'acc_ficohsa', typeFilter: 'expense', searchQuery: 'cafe' },
      profileView: {
        openAuthModal(isRegister) {
          authModalOpened = true;
          assert.equal(isRegister, false);
          domElements['auth-dialog'].showModal();
        },
      },
    };

    let firebaseSignOutCalled = false;
    const mockAuthService = {
      currentUser: { uid: 'uid_prev', email: 'prev@pisto.hn' },
      currentProfile: { uid: 'uid_prev', workspaceId: 'ws_uid_prev' },
      currentWorkspaceId: 'ws_uid_prev',
      accounts: [...state.accounts],
      transactions: [...state.transactions],
      firebaseAuth: { currentUser: { uid: 'uid_prev' } },
      authModule: {
        async signOut() {
          firebaseSignOutCalled = true;
        },
      },
    };

    // 4. Ejecutar cierre de sesión con limpieza completa (`signOutWithCompleteCleanup`)
    const logoutRes = await signOutWithCompleteCleanup({
      auth: mockAuthService.firebaseAuth,
      signOut: mockAuthService.authModule.signOut,
      state,
      app: mockApp,
      authService: mockAuthService,
      profileView: mockApp.profileView,
      storage: mockStorage,
      sessionStorage: mockSessionStorage,
      workspaceId: 'ws_uid_prev',
      docRef: mockDoc,
    });

    assert.equal(firebaseSignOutCalled, true);

    // 4a. Verificar limpieza de todas las variables de estado en memoria
    assert.equal(logoutRes.currentWorkspaceId, null);
    assert.deepEqual(logoutRes.accounts, []);
    assert.deepEqual(logoutRes.transactions, []);
    assert.equal(state.currentWorkspaceId, null);
    assert.deepEqual(state.accounts, []);
    assert.deepEqual(state.transactions, []);
    assert.deepEqual(state.budgets, {});
    assert.equal(state.settings.workspaceId, null);
    assert.equal(state.settings.currentUid, null);
    assert.equal(mockApp.currentWorkspaceId, null);
    assert.deepEqual(mockApp.accounts, []);
    assert.deepEqual(mockApp.transactions, []);
    assert.equal(mockAuthService.currentUser, null);
    assert.equal(mockAuthService.currentProfile, null);
    assert.equal(mockAuthService.currentWorkspaceId, null);

    // 4b. Verificar reseteo explícito de los elementos del Dashboard en el DOM a cero/vacío
    assert.equal(domElements['kpi-total-balance'].textContent, 'L 0.00');
    assert.equal(domElements['kpi-period-income'].textContent, '+ L 0.00');
    assert.equal(domElements['kpi-period-expense'].textContent, '- L 0.00');
    assert.equal(domElements['kpi-savings-rate'].textContent, '0%');
    assert.equal(domElements['accounts-grid'].innerHTML, '');
    assert.equal(domElements['ledger-groups-mount'].innerHTML, '');
    assert.equal(domElements['account-detail-tx-tbody'].innerHTML, '');
    assert.equal(domElements['statement-items-tbody'].innerHTML, '');
    assert.equal(domElements['import-account-accounts-tbody'].innerHTML, '');
    assert.equal(domElements['import-account-tx-tbody'].innerHTML, '');

    // 4c. Verificar limpieza de claves residuales en localStorage y sessionStorage
    assert.equal(sessionCleared, true);
    assert.equal(mockStorage.getItem('Pisto_open_finance_state_v1'), null);
    assert.equal(mockStorage.getItem('pisto_local_auth_session_v1'), null);
    assert.equal(mockStorage.getItem('pisto_gemini_api_key_v1'), null);
    assert.equal(mockStorage.getItem('pisto_custom_firebase_config'), null);
    assert.equal(mockStorage.getItem('pisto_firestore_accounts_ws_ws_uid_prev'), null);
    assert.equal(mockStorage.getItem('pisto_firestore_transactions_ws_ws_uid_prev'), null);
    assert.equal(mockStorage.getItem('pisto_firestore_budgets_ws_ws_uid_prev'), null);
    assert.equal(mockStorage.getItem('pisto_dashboard_metrics_ws_ws_uid_prev'), null);

    // 4d. Verificar redirección inmediata al modal de Inicio de Sesión / Registro
    assert.equal(authModalOpened, true);
    assert.equal(domElements['auth-dialog'].open, true);

    // 5. Verificar Estado Inicial por Defecto para Visitantes / No Logueados (`onAuthStateChanged` con `user === null`)
    domElements['kpi-total-balance'].textContent = 'L 57,843.49';
    domElements['accounts-grid'].innerHTML = '<article>Residual</article>';
    domElements['ledger-groups-mount'].innerHTML = '<section>Residual</section>';
    domElements['auth-dialog'].open = false;
    authModalOpened = false;
    state.accounts = [{ id: 'acc_residual', initialBalance: 57843.49 }];
    state.transactions = [{ id: 'tx_residual', amount: 500 }];

    const visitorState = handleUnauthenticatedVisitorState({
      state,
      app: mockApp,
      authService: mockAuthService,
      profileView: mockApp.profileView,
      storage: mockStorage,
      docRef: mockDoc,
    });

    assert.equal(visitorState.currentWorkspaceId, null);
    assert.equal(state.accounts.length, 0);
    assert.equal(state.transactions.length, 0);
    assert.equal(domElements['kpi-total-balance'].textContent, 'L 0.00');
    assert.equal(domElements['kpi-period-income'].textContent, '+ L 0.00');
    assert.equal(domElements['kpi-period-expense'].textContent, '- L 0.00');
    assert.equal(domElements['kpi-savings-rate'].textContent, '0%');
    assert.equal(domElements['accounts-grid'].innerHTML, '');
    assert.equal(domElements['ledger-groups-mount'].innerHTML, '');
    assert.equal(authModalOpened, true);
    assert.equal(domElements['auth-dialog'].open, true);

    // 6. Cero llamados a console.log en todos los módulos modificados
    for (const relPath of [
      'src/js/services/auth.js',
      'public/js/services/authProfileService.js',
      'src/js/services/dashboard.js',
      'public/js/app.js',
      'src/js/app.js',
      'public/js/ui/profileView.js',
    ]) {
      const content = await fs.readFile(new URL(`../${relPath}`, import.meta.url), 'utf8');
      const stripped = content
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      assert.equal(
        stripped.includes('console.log('),
        false,
        `Cero llamados a console.log permitidos en ${relPath}`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 30. Botón Único "📷 Escanear Documento / PDF", Motor Unificado de Clasificación/OCR,
//     Asociación Automática a Cuentas en Firestore y SmartScanModal
// ---------------------------------------------------------------------------
describe('Unified Smart Scan Button, Classification & OCR Engine, Auto-Account Association & SmartScanModal', () => {
  it('1. unifica la UI en la pestaña Transacciones con el único botón #btn-smart-scan y el texto descriptivo requerido', async () => {
    const fs = await import('node:fs/promises');
    const {
      SMART_SCAN_BUTTON_ID,
      SMART_SCAN_BUTTON_LABEL,
      SMART_SCAN_BANNER_DESCRIPTION,
      renderSmartScanBannerMarkup,
      TransactionsView,
    } = await import('../src/js/components/TransactionsView.js');

    assert.equal(SMART_SCAN_BUTTON_ID, 'btn-smart-scan');
    assert.equal(SMART_SCAN_BUTTON_LABEL, '📷 Escanear Documento / PDF');
    assert.equal(
      SMART_SCAN_BANNER_DESCRIPTION,
      'Escanea facturas, recibos, vouchers POS, comprobantes de crédito/débito o estados de cuenta en PDF para registrar movimientos automáticamente.'
    );

    const bannerHtml = renderSmartScanBannerMarkup();
    assert.ok(bannerHtml.includes('id="btn-smart-scan"'));
    assert.ok(bannerHtml.includes('📷 Escanear Documento / PDF'));
    assert.ok(bannerHtml.includes(SMART_SCAN_BANNER_DESCRIPTION));
    assert.equal(bannerHtml.includes('btn-scan-voucher'), false);
    assert.equal(bannerHtml.includes('btn-upload-statement'), false);

    // Verificar en index.html y public/index.html
    for (const htmlPath of ['index.html', 'public/index.html']) {
      const html = await fs.readFile(new URL(`../${htmlPath}`, import.meta.url), 'utf8');
      assert.ok(
        html.includes('id="btn-smart-scan"'),
        `Debe existir #btn-smart-scan en ${htmlPath}`
      );
      assert.ok(
        html.includes('📷 Escanear Documento / PDF'),
        `Debe mostrar "📷 Escanear Documento / PDF" en ${htmlPath}`
      );
      assert.ok(
        html.includes(SMART_SCAN_BANNER_DESCRIPTION),
        `Debe incluir el texto descriptivo exacto en ${htmlPath}`
      );
      assert.equal(
        html.includes('id="btn-scan-voucher"'),
        false,
        `No debe existir el botón antiguo #btn-scan-voucher en ${htmlPath}`
      );
      assert.equal(
        html.includes('id="btn-upload-statement"'),
        false,
        `No debe existir el botón antiguo #btn-upload-statement en ${htmlPath}`
      );
    }

    // Verificar montaje de TransactionsView sobre un contenedor con botones legados
    const fakeBanner = {
      innerHTML: '<button id="btn-scan-voucher"></button><button id="btn-upload-statement"></button>',
      querySelector: (sel) => {
        if (sel === '#btn-scan-voucher' && fakeBanner.innerHTML.includes('btn-scan-voucher')) {
          return {};
        }
        return null;
      },
    };
    const view = new TransactionsView();
    view.mountSmartScanBanner(fakeBanner);
    assert.ok(fakeBanner.innerHTML.includes('id="btn-smart-scan"'));
    assert.ok(fakeBanner.innerHTML.includes(SMART_SCAN_BANNER_DESCRIPTION));
  });

  it('2. clasifica documentos (Voucher POS, Factura/Recibo, Comprobante de Crédito, Comprobante de Débito) y sanitiza comas de miles ("3,901.33" -> 3901.33)', async () => {
    const {
      SMART_SCAN_DOCUMENT_TYPES,
      sanitizeSmartScanAmount,
      classifySmartScanDocumentType,
      parseSmartScanText,
      extractSmartScanDocument,
    } = await import('../src/js/services/smartScanExtractor.js');

    assert.equal(sanitizeSmartScanAmount('3,901.33'), 3901.33);
    assert.equal(sanitizeSmartScanAmount('L. 14,250.75'), 14250.75);
    assert.equal(sanitizeSmartScanAmount('$ 1,050.00'), 1050.0);

    // a) Voucher POS
    const posSample = `
      BAC CREDOMATIC
      COMPRA POS
      SUPERMERCADOS LA COLONIA
      FECHA: 18/10/2026
      TARJETA VISA **** 4589
      AUTORIZACION: 991204
      LOTE: 044
      TOTAL: L. 3,901.33
    `;
    assert.equal(
      classifySmartScanDocumentType(posSample),
      SMART_SCAN_DOCUMENT_TYPES.VOUCHER_POS
    );
    const parsedPos = await parseSmartScanText(posSample, { accounts: [], transactions: [] });
    assert.equal(parsedPos.fecha, '2026-10-18');
    assert.equal(parsedPos.monto, 3901.33);
    assert.equal(parsedPos.moneda, 'HNL');
    assert.equal(parsedPos.tipoDocumento, 'Voucher POS');
    assert.equal(parsedPos.tipoTransaccion, 'expense');
    assert.equal(parsedPos.cuentaIdentificada, '4589');

    // b) Comprobante de Crédito (Ingreso)
    const creditSample = `
      BANPAIS
      COMPROBANTE DE CREDITO
      TRANSFERENCIA RECIBIDA ACH
      FECHA: 2026-10-20
      CUENTA DESTINO: 210045998821
      MONTO TOTAL: USD 1,250.50
    `;
    assert.equal(
      classifySmartScanDocumentType(creditSample),
      SMART_SCAN_DOCUMENT_TYPES.CREDIT_SLIP
    );
    const parsedCredit = await extractSmartScanDocument(creditSample, {
      accounts: [],
      transactions: [],
    });
    assert.equal(parsedCredit.fecha, '2026-10-20');
    assert.equal(parsedCredit.monto, 1250.5);
    assert.equal(parsedCredit.moneda, 'USD');
    assert.equal(parsedCredit.tipoDocumento, 'Comprobante de Crédito (Ingreso)');
    assert.equal(parsedCredit.tipoTransaccion, 'income');
    assert.equal(parsedCredit.cuentaIdentificada, '210045998821');

    // c) Comprobante de Débito (Gasto)
    const debitSample = `
      BANCO ATLANTIDA
      COMPROBANTE DE DEBITO
      TRANSFERENCIA ENVIADA A TERCEROS
      FECHA: 19/10/2026
      CUENTA ORIGEN: *7732
      TOTAL: L 2,400.00
    `;
    assert.equal(
      classifySmartScanDocumentType(debitSample),
      SMART_SCAN_DOCUMENT_TYPES.DEBIT_SLIP
    );
    const parsedDebit = await parseSmartScanText(debitSample, {
      accounts: [],
      transactions: [],
    });
    assert.equal(parsedDebit.fecha, '2026-10-19');
    assert.equal(parsedDebit.monto, 2400);
    assert.equal(parsedDebit.tipoDocumento, 'Comprobante de Débito (Gasto)');
    assert.equal(parsedDebit.tipoTransaccion, 'expense');
    assert.equal(parsedDebit.cuentaIdentificada, '7732');

    // d) Factura/Recibo
    const invoiceSample = `
      FARMACIA KIELSA
      RTN 08019002112233
      FACTURA SAR 000-001-01-00049120
      FECHA: 21/10/2026
      TOTAL A PAGAR: L 645.20
    `;
    assert.equal(
      classifySmartScanDocumentType(invoiceSample),
      SMART_SCAN_DOCUMENT_TYPES.INVOICE_RECEIPT
    );
  });

  it('3. consulta las cuentas en Firestore del workspace y asocia automáticamente si coincide accountNumber o últimos 4 dígitos, o habilita selección manual si no coincide', async () => {
    const { matchAccountFromWorkspace } = await import(
      '../src/js/services/smartScanExtractor.js'
    );

    const firestoreAccountsDocs = [
      {
        id: 'acc_bac_ahorro',
        data: () => ({
          id: 'acc_bac_ahorro',
          name: 'BAC Ahorro Lempiras',
          accountNumber: '200014589904',
          currency: 'HNL',
          archived: false,
        }),
      },
      {
        id: 'acc_ficohsa_tc',
        data: () => ({
          id: 'acc_ficohsa_tc',
          name: 'Ficohsa Infinite',
          accountNumber: '4589',
          currency: 'USD',
          archived: false,
        }),
      },
      {
        id: 'acc_archived_old',
        data: () => ({
          id: 'acc_archived_old',
          name: 'Cuenta Archivada',
          accountNumber: '1111',
          currency: 'HNL',
          archived: true,
        }),
      },
    ];

    let queriedPath = null;
    const mockFirestoreModule = {
      collection: (_db, ...segments) => {
        queriedPath = segments.join('/');
        return { path: queriedPath };
      },
      getDocs: async () => ({
        docs: firestoreAccountsDocs,
      }),
    };

    // Caso A: Coincidencia por últimos 4 dígitos ("9904" -> acc_bac_ahorro)
    const matchByLast4 = await matchAccountFromWorkspace('9904', [], {
      firestoreDb: {},
      firestoreModule: mockFirestoreModule,
      workspaceId: 'ws_demo_user',
    });
    assert.equal(queriedPath, 'workspaces/ws_demo_user/accounts');
    assert.equal(matchByLast4.matched, true);
    assert.equal(matchByLast4.accountId, 'acc_bac_ahorro');
    assert.equal(matchByLast4.matchedAccount.name, 'BAC Ahorro Lempiras');
    assert.equal(matchByLast4.activeAccounts.length, 2); // excluye archivada

    // Caso B: Coincidencia exacta por número completo ("200014589904" -> acc_bac_ahorro)
    const matchByFull = await matchAccountFromWorkspace('200014589904', [], {
      firestoreDb: {},
      firestoreModule: mockFirestoreModule,
      workspaceId: 'ws_demo_user',
    });
    assert.equal(matchByFull.matched, true);
    assert.equal(matchByFull.accountId, 'acc_bac_ahorro');

    // Caso C: Sin coincidencia ("8812") -> matched: false y devuelve lista completa de cuentas activas
    const noMatch = await matchAccountFromWorkspace('8812', [], {
      firestoreDb: {},
      firestoreModule: mockFirestoreModule,
      workspaceId: 'ws_demo_user',
    });
    assert.equal(noMatch.matched, false);
    assert.equal(noMatch.accountId, '');
    assert.equal(noMatch.activeAccounts.length, 2);
  });

  it('4. en SmartScanModal detecta duplicados ("Sobreescribir", "Crear Nueva", "Omitir"), guarda en Firestore y actualiza el saldo de la cuenta asociada', async () => {
    const fs = await import('node:fs/promises');
    const {
      DUPLICATE_RESOLUTION_ACTIONS,
      confirmAndPersistSmartScanTransaction,
      renderSmartScanModalMarkup,
    } = await import('../src/js/components/SmartScanModal.js');
    const { detectSmartScanDuplicate } = await import(
      '../src/js/services/smartScanExtractor.js'
    );

    const modalHtml = renderSmartScanModalMarkup();
    assert.ok(modalHtml.includes('value="overwrite"'));
    assert.ok(modalHtml.includes('Sobreescribir'));
    assert.ok(modalHtml.includes('value="create_new"'));
    assert.ok(modalHtml.includes('Crear Nueva'));
    assert.ok(modalHtml.includes('value="skip"'));
    assert.ok(modalHtml.includes('Omitir'));

    const state = {
      activeWorkspaceId: 'ws_test_scan',
      settings: { exchangeRateUSD: 24.85 },
      accounts: [
        {
          id: 'acc_main',
          name: 'BAC Ahorro',
          accountNumber: '4589',
          currency: 'HNL',
          initialBalance: 10000,
          currentBalance: 10000,
        },
      ],
      transactions: [
        {
          id: 'tx_existing_1',
          type: 'expense',
          amount: 3901.33,
          currency: 'HNL',
          categoryId: 'groceries',
          accountId: 'acc_main',
          date: '2026-10-18',
          note: 'LA COLONIA · Cuenta/Tarjeta *4589',
        },
      ],
    };

    // 4a. Detectar movimiento duplicado (misma fecha, monto y concepto)
    const dupCheck = detectSmartScanDuplicate(
      {
        fecha: '2026-10-18',
        comercio: 'LA COLONIA',
        monto: '3,901.33',
        moneda: 'HNL',
      },
      state.transactions,
      'acc_main'
    );
    assert.equal(dupCheck.isDuplicate, true);
    assert.equal(dupCheck.duplicateTx.id, 'tx_existing_1');

    // 4b. Opción "Omitir" (skip) -> no modifica ni crea transacciones
    const skipRes = await confirmAndPersistSmartScanTransaction({
      extractedData: {
        fecha: '2026-10-18',
        comercio: 'LA COLONIA',
        monto: '3,901.33',
        moneda: 'HNL',
        tipoDocumento: 'Voucher POS',
        cuentaIdentificada: '4589',
        accountId: 'acc_main',
      },
      state,
      duplicateResolution: DUPLICATE_RESOLUTION_ACTIONS.SKIP,
      duplicateTx: dupCheck.duplicateTx,
    });
    assert.equal(skipRes.saved, false);
    assert.equal(skipRes.action, 'skip');
    assert.equal(state.transactions.length, 1);

    // 4c. Opción "Sobreescribir" (overwrite) -> actualiza transacción existente y recalcula saldo en Firestore
    const firestoreWrites = [];
    const mockFirestoreModule = {
      doc: (_db, ...pathParts) => ({ path: pathParts.join('/') }),
      setDoc: async (ref, data) => {
        firestoreWrites.push({ op: 'setDoc', path: ref.path, data });
      },
      updateDoc: async (ref, data) => {
        firestoreWrites.push({ op: 'updateDoc', path: ref.path, data });
      },
    };

    const overwriteRes = await confirmAndPersistSmartScanTransaction({
      extractedData: {
        fecha: '2026-10-18',
        comercio: 'LA COLONIA ACTUALIZADO',
        monto: '4,000.00',
        moneda: 'HNL',
        tipoDocumento: 'Voucher POS',
        cuentaIdentificada: '4589',
        accountId: 'acc_main',
        categoryId: 'groceries',
      },
      state,
      duplicateResolution: DUPLICATE_RESOLUTION_ACTIONS.OVERWRITE,
      duplicateTx: dupCheck.duplicateTx,
      firestoreDb: {},
      firestoreModule: mockFirestoreModule,
      workspaceId: 'ws_test_scan',
    });

    assert.equal(overwriteRes.saved, true);
    assert.equal(overwriteRes.action, 'overwrite');
    assert.equal(state.transactions.length, 1);
    assert.equal(state.transactions[0].amount, 4000);
    assert.equal(overwriteRes.newAccountBalance, 6000); // 10,000 - 4,000
    assert.equal(state.accounts[0].currentBalance, 6000);
    assert.ok(
      firestoreWrites.some((w) => w.path === 'workspaces/ws_test_scan/transactions/tx_existing_1')
    );
    assert.ok(
      firestoreWrites.some(
        (w) => w.path === 'workspaces/ws_test_scan/accounts/acc_main' && w.data.balance === 6000
      )
    );

    // 4d. Confirmar un "Comprobante de Crédito (Ingreso)" ("Crear Nueva") -> incrementa el saldo de la cuenta
    const creditRes = await confirmAndPersistSmartScanTransaction({
      extractedData: {
        fecha: '2026-10-21',
        comercio: 'DEPOSITO DE PLANILLA',
        monto: '2,500.00',
        moneda: 'HNL',
        tipoDocumento: 'Comprobante de Crédito (Ingreso)',
        cuentaIdentificada: '4589',
        accountId: 'acc_main',
        categoryId: 'salary',
      },
      state,
      duplicateResolution: DUPLICATE_RESOLUTION_ACTIONS.CREATE_NEW,
      firestoreDb: {},
      firestoreModule: mockFirestoreModule,
      workspaceId: 'ws_test_scan',
    });

    assert.equal(creditRes.saved, true);
    assert.equal(creditRes.transaction.type, 'income');
    assert.equal(state.transactions.length, 2);
    assert.equal(creditRes.newAccountBalance, 8500); // 6,000 + 2,500
    assert.equal(state.accounts[0].currentBalance, 8500);

    // 5. Verificar cero console.log en todos los archivos entregados
    for (const relPath of [
      'src/js/services/smartScanExtractor.js',
      'src/js/components/TransactionsView.js',
      'src/js/components/SmartScanModal.js',
      'public/js/app.js',
      'src/js/app.js',
    ]) {
      const content = await fs.readFile(new URL(`../${relPath}`, import.meta.url), 'utf8');
      const stripped = content
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      assert.equal(
        stripped.includes('console.log('),
        false,
        `Cero llamados a console.log permitidos en ${relPath}`
      );
    }
  });
});






