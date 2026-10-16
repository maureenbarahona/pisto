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
import { createSeedState } from '../public/js/repositories/storageRepository.js';
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
  filterTransactionsForUserView,
} from '../public/js/services/authProfileService.ts';
import { handleRequest } from '../server/index.js';
import http from 'node:http';

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

      // Also verify that TypeScript modules are transpiled and served as JavaScript
      const tsRes = await fetch(`${baseUrl}/js/services/authProfileService.ts`);
      assert.equal(tsRes.status, 200);
      assert.ok((tsRes.headers.get('content-type') || '').includes('javascript'));
      const tsBody = await tsRes.text();
      assert.ok(tsBody.includes('FirebaseAuthProfileService'));
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

    // 4. Sign in with Google
    const googleSession = await authService.signInWithGoogle({
      email: 'carlos.familia@gmail.com',
      name: 'Carlos Familia',
    });
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





