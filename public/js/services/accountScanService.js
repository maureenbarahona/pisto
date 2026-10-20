/**
 * @fileoverview Smart Account Detail OCR + Gemini 1.5 Flash / Genkit Vision Service (`public/js/services/accountScanService.js`).
 */

import {
  Money,
  ACCOUNT_TYPES,
  TRANSACTION_TYPES,
  createAccount,
} from '../domain/models.js';
import {
  ACCOUNT_SCAN_RESPONSE_JSON_SCHEMA,
  validateAndNormalizeAccountScan,
} from '../schemas/accountScan.js';
import { prepareTransactionForWorkspace, saveTransactionToWorkspace } from './transactions.js';

export async function encodeImageToBase64(fileOrDataUrl) {
  if (typeof fileOrDataUrl === 'string') {
    const trimmed = fileOrDataUrl.trim();
    const match = trimmed.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      return {
        mimeType: match[1],
        base64Data: match[2],
        dataUrl: trimmed,
      };
    }
    return {
      mimeType: 'image/png',
      base64Data: trimmed,
      dataUrl: `data:image/png;base64,${trimmed}`,
    };
  }

  const mimeType = fileOrDataUrl.type || 'image/png';
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || '');
        const base64Data = dataUrl.replace(/^data:[^;]+;base64,/, '');
        resolve({ base64Data, mimeType, dataUrl });
      };
      reader.onerror = () => reject(new Error('No se pudo leer el archivo de imagen.'));
      reader.readAsDataURL(fileOrDataUrl);
    });
  }

  const arrayBuffer = await fileOrDataUrl.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64Data =
    typeof btoa === 'function'
      ? btoa(binary)
      : Buffer.from(arrayBuffer).toString('base64');
  return {
    base64Data,
    mimeType,
    dataUrl: `data:${mimeType};base64,${base64Data}`,
  };
}

export function formatAccountScanPreviewSummary(scan) {
  const bankLabel = String(scan.bankName || 'Banco General').trim();
  const rawType = String(scan.accountType || 'Cuenta de Ahorro').trim();
  const shortType =
    rawType
      .replace(/^Cuenta\s+de\s+/i, '')
      .replace(/^Cuenta\s+/i, '')
      .trim() || rawType;

  const currency = scan.currency === 'USD' ? 'USD' : 'HNL';
  const symbol = currency === 'USD' ? '$' : 'L';
  const formattedNumber = Number(scan.currentBalance || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const formattedBalance = `${symbol} ${formattedNumber}`;

  const txCount = Array.isArray(scan.detectedTransactions)
    ? scan.detectedTransactions.length
    : 0;
  const transactionsCountLabel =
    txCount === 1
      ? '1 Transacción encontrada'
      : `${txCount} Transacciones encontradas`;

  return {
    accountSummaryTitle: `Cuenta detectada: ${bankLabel} - ${shortType} ${formattedBalance}`,
    transactionsCountLabel,
    formattedBalance,
  };
}

export async function analyzeAccountScreenshotWithGemini(imageInput, options = {}) {
  const { base64Data, mimeType } = await encodeImageToBase64(imageInput);
  const fetchFn = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const apiKey = String(options.apiKey || '').trim();

  const promptText = [
    'Analiza esta captura de pantalla de detalle o estado de cuenta de banca móvil.',
    'Extrae estrictamente en JSON:',
    '- accountType: ej. "Cuenta de Ahorro", "Cuenta Cheques", "Tarjeta de Crédito"',
    '- accountNumber: número de cuenta (ej. "213130058771" o últimos 4 dígitos)',
    '- bankName: detecta si es "Atlántida", "BAC", "Ficohsa", "Banpais", "Davivienda", "Lafise", "Promerica", "Banco de Occidente" o "Banco General"',
    '- currency: "HNL" si muestra "L" o "Lempiras", "USD" si muestra "$" o "Dólares"',
    '- currentBalance: saldo actual/disponible numérico (ej. 3901.33)',
    '- status: "Activa" o "Inactiva"',
    '- detectedTransactions: lista de movimientos con date en formato YYYY-MM-DD (ej. "15/10/2026" -> "2026-10-15"), concept (ej. "DEPOSITO DE AHORRO CON T/D 37170597"), type ("income" si indica Crédito/Depósito, "expense" si indica Débito/Retiro) y amount numérico (ej. 200.00).',
  ].join('\n');

  if (apiKey && fetchFn) {
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
      const response = await fetchFn(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: promptText },
                {
                  inlineData: {
                    mimeType,
                    data: base64Data,
                  },
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
            responseSchema: ACCOUNT_SCAN_RESPONSE_JSON_SCHEMA,
          },
        }),
      });

      if (response.ok) {
        const payload = await response.json();
        const rawText = payload?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (rawText) {
          const parsed = JSON.parse(rawText);
          const validated = validateAndNormalizeAccountScan(parsed);
          return {
            scan: validated,
            preview: formatAccountScanPreviewSummary(validated),
            source: 'gemini-1.5-flash',
          };
        }
      }
    } catch (err) {
      console.warn('[AccountScanService] Gemini 1.5 Flash direct call fallback to server:', err);
    }
  }

  if (fetchFn) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) {
        headers['x-gemini-api-key'] = apiKey;
      }
      const res = await fetchFn('/api/ai/scan-account', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          imageBase64: base64Data,
          mimeType,
          ocrTextFallback: options.ocrTextFallback || '',
          apiKey: apiKey || undefined,
        }),
      });
      if (res.ok) {
        const body = await res.json();
        if (body?.ok && body?.data) {
          const validated = validateAndNormalizeAccountScan(body.data);
          return {
            scan: validated,
            preview: formatAccountScanPreviewSummary(validated),
            source: body.source || 'genkit:gemini-1.5-flash',
          };
        }
      }
    } catch (err) {
      console.warn('[AccountScanService] Server Genkit scan fallback:', err);
    }
  }

  throw new Error(
    'No se pudo analizar la captura con Gemini 1.5 Flash. Verifica tu Gemini API Key en la pestaña Perfil.'
  );
}

function resolveCanonicalInstitution(bankName) {
  const lower = String(bankName || '').toLowerCase();
  if (lower.includes('atlantida') || lower.includes('atlántida')) return 'Banco Atlántida';
  if (lower.includes('bac') || lower.includes('credomatic')) return 'BAC Credomatic Honduras';
  if (lower.includes('ficohsa')) return 'Banco Ficohsa';
  if (lower.includes('banpais') || lower.includes('banpaís')) return 'Banpaís (Banco del País)';
  if (lower.includes('occidente')) return 'Banco de Occidente';
  if (lower.includes('davivienda')) return 'Banco Davivienda Honduras';
  if (lower.includes('lafise')) return 'Banco Lafise Honduras';
  if (lower.includes('promerica')) return 'Banco Promerica Honduras';
  return bankName || 'Banco General';
}

function inferCategoryIdFromConcept(concept, type) {
  if (type === 'income') {
    if (/salario|planilla|nomina|n[oó]mina|sueldo/i.test(concept)) return 'salary';
    if (/freelance|honorarios|consultor/i.test(concept)) return 'freelance';
    if (/interes|inter[eé]s|rendimiento|dividendo/i.test(concept)) return 'investments';
    return 'salary';
  }
  const lower = String(concept || '').toLowerCase();
  if (/super|colonia|paiz|pricesmart|walmart|despensa/i.test(lower)) return 'groceries';
  if (/restaurante|cafe|caf[eé]|comida|almuerzo|burger|pizza/i.test(lower)) return 'food';
  if (/gasolin|puma|uno|texaco|uber|peaje|transporte/i.test(lower)) return 'transport';
  if (/claro|tigo|enee|sanaa|internet|luz|agua/i.test(lower)) return 'utilities';
  if (/farmacia|kielsa|hospital|medico|m[eé]dico|gym/i.test(lower)) return 'health';
  return 'groceries';
}

export async function createScannedAccountAndTransactionsAtomically(
  rawScan,
  state,
  context = {}
) {
  const scan = validateAndNormalizeAccountScan(rawScan);
  const user = context.currentUser || null;
  const profile = context.currentUserProfile || null;

  const workspaceId =
    String(
      context.workspaceId ||
        profile?.workspaceId ||
        state?.settings?.workspaceId ||
        user?.uid ||
        'ws_default'
    ).trim() || 'ws_default';

  const createdByUid =
    String(user?.uid || profile?.uid || state?.settings?.currentUid || 'local_default_user').trim() ||
    'local_default_user';

  const createdByEmail =
    String(user?.email || profile?.email || 'personal@pisto.hn')
      .trim()
      .toLowerCase() || 'personal@pisto.hn';

  const isCard = /tarjeta|cr[eé]dito/i.test(scan.accountType);
  const internalType = isCard ? ACCOUNT_TYPES.CARD : ACCOUNT_TYPES.BANK;
  const isArchived = /^inactiv/i.test(scan.status);

  let netTxCents = 0;
  for (const tx of scan.detectedTransactions) {
    const cents = Money.toCents(tx.amount);
    if (tx.type === 'income') {
      netTxCents += cents;
    } else {
      netTxCents -= cents;
    }
  }
  const targetBalanceCents = Money.toCents(scan.currentBalance);
  const computedInitialBalance = Money.fromCents(targetBalanceCents - netTxCents);

  const shortType =
    scan.accountType.replace(/^Cuenta\s+de\s+/i, '').replace(/^Cuenta\s+/i, '').trim() ||
    scan.accountType;
  const last4 = String(scan.accountNumber || '').slice(-4);
  const accountDisplayName = `${scan.bankName} - ${shortType}${last4 ? ` *${last4}` : ''}`.slice(0, 48);

  const nowIso = new Date().toISOString();
  const accountEntity = {
    ...createAccount({
      name: accountDisplayName,
      type: internalType,
      institution: resolveCanonicalInstitution(scan.bankName),
      accountNumber: scan.accountNumber,
      currency: scan.currency === 'USD' ? 'USD' : 'HNL',
      initialBalance: computedInitialBalance,
      targetAmount: 0,
      includeInTotal: !isArchived,
      color: isCard ? '#8b5cf6' : '#3b82f6',
      icon: isCard ? 'card' : 'bank',
      isArchived,
      status: isArchived ? 'archived' : 'active',
      workspaceId,
      createdByUid,
      createdAt: nowIso,
      updatedAt: nowIso,
    }),
    bankName: scan.bankName,
    accountType: scan.accountType,
    currentBalance: scan.currentBalance,
    scanStatus: scan.status,
  };

  const createdTransactions = scan.detectedTransactions.map((detTx) =>
    prepareTransactionForWorkspace(
      {
        type: detTx.type === 'income' ? TRANSACTION_TYPES.INCOME : TRANSACTION_TYPES.EXPENSE,
        amount: detTx.amount,
        currency: accountEntity.currency,
        categoryId: inferCategoryIdFromConcept(detTx.concept, detTx.type),
        accountId: accountEntity.id,
        date: detTx.date,
        note: detTx.concept,
        workspaceId,
        createdByUid,
        createdByEmail,
      },
      user,
      profile,
      workspaceId
    )
  );

  let batchCommitted = false;
  const { firestoreDb, firestoreModule, storage } = context;

  if (firestoreDb && firestoreModule && typeof firestoreModule.doc === 'function') {
    try {
      const accountRef = firestoreModule.doc(firestoreDb, 'accounts', accountEntity.id);
      if (typeof firestoreModule.writeBatch === 'function') {
        const batch = firestoreModule.writeBatch(firestoreDb);
        if (typeof batch.set === 'function') {
          batch.set(accountRef, accountEntity, { merge: true });
          for (const txDoc of createdTransactions) {
            const txRef = firestoreModule.doc(firestoreDb, 'transactions', txDoc.id);
            batch.set(txRef, txDoc, { merge: true });
          }
          await batch.commit();
          batchCommitted = true;
        }
      }
      if (!batchCommitted && typeof firestoreModule.setDoc === 'function') {
        await firestoreModule.setDoc(accountRef, accountEntity, { merge: true });
        for (const txDoc of createdTransactions) {
          const txRef = firestoreModule.doc(firestoreDb, 'transactions', txDoc.id);
          await firestoreModule.setDoc(txRef, txDoc, { merge: true });
        }
        batchCommitted = true;
      }
    } catch (err) {
      console.warn('[AccountScanService] Guardado atómico en caché local (Firestore offline):', err);
    }
  }

  for (const txDoc of createdTransactions) {
    await saveTransactionToWorkspace(txDoc, user, profile, {
      firestoreDb: batchCommitted ? null : firestoreDb,
      firestoreModule: batchCommitted ? null : firestoreModule,
      storage,
    });
  }

  if (state) {
    if (Array.isArray(state.accounts)) {
      state.accounts.push(accountEntity);
    }
    if (Array.isArray(state.transactions)) {
      for (const txDoc of [...createdTransactions].reverse()) {
        state.transactions.unshift(txDoc);
      }
    }
  }

  return {
    account: accountEntity,
    transactions: createdTransactions,
    batchCommitted,
    toastMessage: '🎉 Cuenta y transacciones creadas exitosamente',
  };
}
