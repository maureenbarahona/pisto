/**
 * @fileoverview Browser JS Mirror of `public/js/services/accountScanService.ts`.
 */

import {
  Money,
  ACCOUNT_TYPES,
  TRANSACTION_TYPES,
  createAccount,
} from '../domain/models.js';
import {
  ACCOUNT_SCAN_RESPONSE_JSON_SCHEMA,
  cleanAmount,
  cleanMobileUiText,
  validateAndNormalizeAccountScan,
} from '../schemas/accountScan.js';
import { prepareTransactionForWorkspace, saveTransactionToWorkspace } from './transactions.js';

export { cleanAmount, cleanMobileUiText };

/**
 * Builds the Gemini Vision (`gemini-1.5-flash`) prompt with explicit rules for Honduras
 * Mobile Banking Screenshots, Account Detail Views, and Vouchers.
 * @returns {string}
 */
export function buildGeminiVisionPrompt() {
  return [
    'Analiza esta captura de pantalla de banca móvil o detalle de cuenta bancaria y extrae la información en JSON estructurado.',
    '',
    'REGLAS ESTRICTAS DE EXTRACCIÓN:',
    '1. PARSER DE MONTOS (`cleanAmount`):',
    '   - Limpia los separadores de miles (comas `,`) ANTES de convertir a número FLOAT.',
    '   - Ejemplo: "3,901.33" -> remover comas -> "3901.33" -> 3901.33 (NUNCA recortes el primer dígito antes de la coma dejando "901.33").',
    '2. REGLAS DE EXTRACCIÓN DE NÚMERO DE CUENTA:',
    '   - Para cuentas bancarias (Ahorro, Cheques, SOS, etc.), extrae y almacena el NÚMERO DE CUENTA COMPLETO (ej. "213130058771").',
    '   - Reserva la regla de "últimos 4 dígitos" ÚNICAMENTE si se detecta explícitamente una Tarjeta de Crédito / Débito enmascarada (ej. "**** **** **** 0618").',
    '3. DETECCIÓN DE MONEDA Y TIPO DE TRANSACCIÓN (Honduras Context):',
    '   - Mapea el símbolo "L" o la palabra "Lempiras" a la moneda "HNL".',
    '   - Mapea el símbolo "$" o las palabras "USD" / "Dólares" a la moneda "USD".',
    '   - Si en el detalle de la pantalla aparece un movimiento con la etiqueta "Crédito" o "Depósito" (ej. "DEPOSITO DE AHORRO CON T/D L 200.00"), clasifícalo automáticamente como una Transacción de Ingreso (`type: "income"`).',
    '4. FILTRADO DE UI / BARRA DE ESTADO (Clean Text):',
    '   - Ignora en el análisis de texto los elementos de la interfaz del teléfono (hora `5:30`, iconos de batería/WiFi, botones de navegación "Transferir" / "Pagar").',
    '   - El "Comercio" o "Concepto" en este tipo de vista debe tomarse de la descripción de la cuenta (ej. "CUENTA DE AHORRO SOS") o de la descripción de la transacción inferior ("DEPOSITO DE AHORRO CON T/D").',
  ].join('\n');
}

/**
 * @param {File | Blob | string} fileOrDataUrl
 */
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

/**
 * @param {object} scan
 */
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
  const numericBalance = cleanAmount(scan.currentBalance);
  const formattedNumber = numericBalance.toLocaleString('en-US', {
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

/**
 * @param {File | Blob | string} imageInput
 * @param {{ apiKey?: string, ocrTextFallback?: string, fetchImpl?: typeof fetch }} [options]
 */
export async function analyzeAccountScreenshotWithGemini(imageInput, options = {}) {
  const { base64Data, mimeType } = await encodeImageToBase64(imageInput);
  const fetchFn = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const apiKey = String(options.apiKey || '').trim();
  const promptText = buildGeminiVisionPrompt();

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
    } catch {
      // Fallback to server Genkit scan
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
    } catch {
      // Fallback when server scan is unavailable
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

/**
 * @param {object} rawScan
 * @param {object} [state]
 * @param {object} [context]
 */
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
    const cents = Money.toCents(cleanAmount(tx.amount));
    if (tx.type === 'income') {
      netTxCents += cents;
    } else {
      netTxCents -= cents;
    }
  }
  const targetBalanceCents = Money.toCents(cleanAmount(scan.currentBalance));
  const computedInitialBalance = Money.fromCents(targetBalanceCents - netTxCents);

  const shortType =
    scan.accountType.replace(/^Cuenta\s+de\s+/i, '').replace(/^Cuenta\s+/i, '').trim() ||
    scan.accountType;
  const accIdentifierSuffix = isCard
    ? String(scan.accountNumber || '').slice(-4)
    : String(scan.accountNumber || '');
  const accountDisplayName = `${scan.bankName} - ${shortType}${
    accIdentifierSuffix ? ` (${accIdentifierSuffix})` : ''
  }`.slice(0, 48);

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
        amount: cleanAmount(detTx.amount),
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
    } catch {
      // Fallback to local workspace storage when Firestore is offline
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

