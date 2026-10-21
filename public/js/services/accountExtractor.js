/**
 * @fileoverview Browser JS Mirror of `src/services/accountExtractor.ts`.
 */

import {
  Money,
  ACCOUNT_TYPES,
  TRANSACTION_TYPES,
  createAccount,
} from '../domain/models.js';
import {
  cleanAmount,
  cleanMobileUiText,
  isMobileUiNoiseLine,
  normalizeScanDateToIso,
  normalizeBankName,
  normalizeScanCurrency,
  normalizeAccountOrCardNumber,
  classifyTransactionType,
} from '../schemas/accountScan.js';
import {
  prepareTransactionForWorkspace,
  saveTransactionToWorkspace,
} from './transactions.js';

export {
  cleanAmount,
  cleanMobileUiText,
  isMobileUiNoiseLine,
  normalizeScanDateToIso,
  normalizeBankName,
  normalizeScanCurrency,
  normalizeAccountOrCardNumber,
  classifyTransactionType,
};

export const ACCOUNT_EXTRACTOR_SYSTEM_PROMPT = [
  'Eres un sistema experto en visión artificial financiera para Honduras y Latinoamérica (Gemini Vision / Genkit).',
  'Tu tarea es analizar una imagen (PNG, JPG, WEBP) o un documento PDF de un Estado de Cuenta o Detalle de Cuenta de banca móvil y devolver únicamente un objeto JSON estructurado.',
  '',
  '1. ENCABEZADO DE CUENTA:',
  '   - `bankName`: Nombre del banco detectado (ej. "Banco Atlántida", "BAC Credomatic", "Ficohsa", "Banpais", "Banco de Occidente", "Davivienda", "Lafise", "Promerica" o "Banco General").',
  '   - `accountType`: Nombre o tipo exacto de la cuenta visible (ej. "CUENTA DE AHORRO SOS", "Cuenta de Ahorro", "Cuenta Cheques", "Tarjeta de Crédito").',
  '   - `accountNumber`: Para cuentas bancarias (Ahorro, Cheques, SOS, etc.) extrae el NÚMERO DE CUENTA COMPLETO (ej. "213130058771"). Reserva los "últimos 4 dígitos" ÚNICAMENTE si es una Tarjeta de Crédito o Débito enmascarada (ej. "**** **** **** 0618" -> "0618").',
  '   - `currency`: "HNL" si detecta el símbolo "L" o la palabra "Lempiras"; "USD" si detecta "$" o "USD" / "Dólares".',
  '   - `currentBalance`: Saldo actual o disponible como número Float. IMPORTANTE: limpia las comas separadoras de miles ANTES de convertir a Float para no perder dígitos (ej. "3,901.33" -> 3901.33, nunca "901.33").',
  '',
  '2. MOVIMIENTOS / TRANSACCIONES DETECTADAS (`detectedTransactions` - Array opcional):',
  '   - `date`: Fecha del movimiento en formato YYYY-MM-DD (ej. "15/10/2026" -> "2026-10-15").',
  '   - `concept`: Descripción o concepto limpio del movimiento (ej. "DEPOSITO DE AHORRO CON T/D 37170597").',
  '   - `type`: "income" si indica Crédito, Depósito o Abono; "expense" si indica Débito, Retiro, Compra o Cargo.',
  '   - `amount`: Monto numérico Float sin comas de miles (ej. 200.00).',
  '',
  '3. FILTRADO DE INTERFAZ Y BARRA DE ESTADO:',
  '   - Ignora horas de la barra de estado del teléfono (ej. `5:30`), iconos de batería/WiFi/señal (4G, 5G, LTE) y botones de navegación ("Transferir", "Pagar", "Compartir", "Detalle de cuenta").',
].join('\n');

export function buildAccountExtractorSystemPrompt() {
  return ACCOUNT_EXTRACTOR_SYSTEM_PROMPT;
}

export const EXTRACTED_ACCOUNT_JSON_SCHEMA = Object.freeze({
  type: 'OBJECT',
  properties: {
    bankName: {
      type: 'STRING',
      description: 'Nombre del banco (ej. Banco Atlántida, BAC Credomatic, Ficohsa, Banpais)',
    },
    accountType: {
      type: 'STRING',
      description: 'Nombre o tipo de la cuenta (ej. "CUENTA DE AHORRO SOS", "Cuenta Cheques")',
    },
    accountNumber: {
      type: 'STRING',
      description:
        'Número completo de cuenta bancaria (ej. "213130058771") o últimos 4 dígitos únicamente en tarjetas ("0618")',
    },
    currency: {
      type: 'STRING',
      enum: ['HNL', 'USD'],
      description: '"HNL" si detecta "L" o "Lempiras"; "USD" si detecta "$" o "Dólares"',
    },
    currentBalance: {
      type: 'NUMBER',
      description: 'Saldo actual/disponible numérico Float sanitizando comas de miles ("3,901.33" -> 3901.33)',
    },
    status: {
      type: 'STRING',
      enum: ['Activa', 'Inactiva'],
      description: 'Estado de la cuenta ("Activa" o "Inactiva")',
    },
    detectedTransactions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          date: {
            type: 'STRING',
            description: 'Fecha del movimiento en formato YYYY-MM-DD',
          },
          concept: {
            type: 'STRING',
            description: 'Descripción o concepto del movimiento (ej. "DEPOSITO DE AHORRO CON T/D 37170597")',
          },
          type: {
            type: 'STRING',
            enum: ['income', 'expense'],
            description: '"income" si dice Crédito/Depósito; "expense" si dice Débito/Retiro',
          },
          amount: {
            type: 'NUMBER',
            description: 'Monto numérico Float sin comas de miles (ej. 200.00)',
          },
        },
        required: ['date', 'concept', 'type', 'amount'],
      },
    },
  },
  required: [
    'bankName',
    'accountType',
    'accountNumber',
    'currency',
    'currentBalance',
    'detectedTransactions',
  ],
});

const BANK_UI_GARBAGE_REGEX =
  /[©®™=<>|_~^•*«»]|--|\b\d{1,2}:\d{2}\b|\b(?:4G|5G|LTE|WIFI|VOLTE)\b|\bdetalle\s+de\s+cuenta\b|\bbal\s*all\b|\bsaldo\s+disponible\b|\bconsulta\s+de\b/i;

export function normalizeExtractorBankName(rawBank, contextHint = '') {
  const raw = String(rawBank ?? '').trim();
  const hint = String(contextHint ?? '').trim();
  const combined = `${raw} ${hint}`.toLowerCase();

  if (combined.includes('atlantida') || combined.includes('atlántida')) return 'Banco Atlántida';
  if (/\bbac\b/.test(combined) || combined.includes('credomatic')) return 'BAC Credomatic';
  if (combined.includes('ficohsa')) {
    return raw.toLowerCase() === 'ficohsa' ? 'Ficohsa' : 'Banco Ficohsa';
  }
  if (
    combined.includes('banpais') ||
    combined.includes('banpaís') ||
    combined.includes('banco del pais') ||
    combined.includes('banco del país')
  ) {
    return 'Banpaís (Banco del País)';
  }
  if (combined.includes('occidente')) return 'Banco de Occidente';
  if (combined.includes('davivienda')) return 'Davivienda';
  if (combined.includes('promerica')) return 'Promerica';
  if (/\bsos\b/i.test(combined)) return 'Banco Atlántida';

  if (
    !raw ||
    raw.toLowerCase() === 'banco general' ||
    BANK_UI_GARBAGE_REGEX.test(raw) ||
    isMobileUiNoiseLine(raw)
  ) {
    if (/\b(?:ahorro|sos)\b/i.test(combined)) return 'Banco Atlántida';
    return 'Banco Atlántida';
  }

  const stripped = raw
    .replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9().\-\s/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const alphaCount = (stripped.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g) || []).length;
  if (alphaCount < 3 || BANK_UI_GARBAGE_REGEX.test(stripped)) {
    return 'Banco Atlántida';
  }
  return stripped;
}

/**
 * @param {any} input
 */
export function validateExtractedAccount(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Los datos extraídos de la cuenta no son válidos.');
  }

  const accountType =
    String(input.accountType || 'Cuenta de Ahorro')
      .replace(/\s+/g, ' ')
      .trim() || 'Cuenta de Ahorro';

  const bankName = normalizeExtractorBankName(input.bankName, accountType);
  const accountNumber = normalizeAccountOrCardNumber(input.accountNumber, accountType);
  const currency = normalizeScanCurrency(input.currency);
  const currentBalance = cleanAmount(input.currentBalance);
  const statusRaw = String(input.status || 'Activa').trim();
  const status = /^inactiv/i.test(statusRaw) ? 'Inactiva' : 'Activa';

  const rawTxs = Array.isArray(input.detectedTransactions)
    ? input.detectedTransactions
    : Array.isArray(input.transactions)
      ? input.transactions
      : [];

  const detectedTransactions = rawTxs
    .map((tx, idx) => {
      const concept = String(tx?.concept || tx?.description || 'Movimiento bancario')
        .replace(/\s+/g, ' ')
        .trim();
      const amount = Math.abs(cleanAmount(tx?.amount));
      const type = classifyTransactionType(tx?.type, concept);
      const date = normalizeScanDateToIso(tx?.date);
      const selected = tx?.selected !== undefined ? Boolean(tx.selected) : true;
      const duplicateAction = tx?.duplicateAction || null;
      const duplicateTxId = tx?.duplicateTxId || null;
      return {
        id: String(tx?.id || `imp_tx_${idx}_${Date.now().toString(36)}`),
        date,
        concept,
        type,
        amount,
        selected,
        ...(duplicateAction ? { duplicateAction } : {}),
        ...(duplicateTxId ? { duplicateTxId } : {}),
      };
    })
    .filter((tx) => tx.amount > 0 && !isMobileUiNoiseLine(tx.concept));

  return {
    bankName,
    accountType,
    accountNumber,
    currency,
    currentBalance,
    status,
    detectedTransactions,
  };
}

export const ExtractedTransactionSchema = Object.freeze({
  parse(input) {
    const res = validateExtractedAccount({ detectedTransactions: [input] });
    if (res.detectedTransactions.length === 0) {
      throw new Error('Transacción extraída inválida.');
    }
    return res.detectedTransactions[0];
  },
  safeParse(input) {
    try {
      return { success: true, data: this.parse(input) };
    } catch (error) {
      return { success: false, error };
    }
  },
});

export const ExtractedAccountSchema = Object.freeze({
  parse(input) {
    return validateExtractedAccount(input);
  },
  safeParse(input) {
    try {
      return { success: true, data: validateExtractedAccount(input) };
    } catch (error) {
      return { success: false, error };
    }
  },
});

/**
 * @param {File | Blob | string} fileOrDataUrl
 */
export async function encodeFileToBase64(fileOrDataUrl) {
  if (typeof fileOrDataUrl === 'string') {
    const trimmed = fileOrDataUrl.trim();
    const match = trimmed.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      const mimeType = match[1];
      return {
        mimeType,
        base64Data: match[2],
        dataUrl: trimmed,
        isPdf: mimeType === 'application/pdf',
      };
    }
    return {
      mimeType: 'image/png',
      base64Data: trimmed,
      dataUrl: `data:image/png;base64,${trimmed}`,
      isPdf: false,
    };
  }

  const fileName = fileOrDataUrl.name || '';
  const isPdf =
    fileOrDataUrl.type === 'application/pdf' || /\.pdf$/i.test(fileName);
  const mimeType = isPdf
    ? 'application/pdf'
    : fileOrDataUrl.type || 'image/png';

  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || '');
        const base64Data = dataUrl.replace(/^data:[^;]+;base64,/, '');
        resolve({ base64Data, mimeType, dataUrl, isPdf });
      };
      reader.onerror = () => reject(new Error('No se pudo leer el archivo seleccionado.'));
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
    isPdf,
  };
}

/**
 * @param {string} rawText
 */
export function parseAccountDataFromTextFallback(rawText) {
  const cleanedText = cleanMobileUiText(String(rawText || ''));
  const lines = cleanedText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const bankName = normalizeBankName(cleanedText);
  const currency = normalizeScanCurrency(cleanedText);

  let accountType = 'Cuenta de Ahorro';
  for (const line of lines) {
    if (/\bCUENTA\s+DE\s+AHORRO\s+SOS\b/i.test(line)) {
      accountType = 'CUENTA DE AHORRO SOS';
      break;
    }
    if (/\bCUENTA\s+DE\s+AHORRO\b/i.test(line)) {
      accountType = line.length <= 42 ? line : 'Cuenta de Ahorro';
      break;
    }
    if (/\bCUENTA\s+CHEQUES\b|\bCUENTA\s+CORRIENTE\b/i.test(line)) {
      accountType = 'Cuenta Cheques';
      break;
    }
    if (/\bTARJETA\s+DE\s+CR[EÉ]DITO\b/i.test(line)) {
      accountType = 'Tarjeta de Crédito';
      break;
    }
  }

  let accountNumber = '';
  const isCard = /tarjeta/i.test(accountType);
  if (isCard) {
    const maskedMatch = cleanedText.match(/[*X•]{3,}(?:\s*[*X•]{3,})*\s*(\d{4})\b/);
    if (maskedMatch) accountNumber = maskedMatch[1];
  }
  if (!accountNumber) {
    const bankAccMatch = cleanedText.match(
      /(?:CUENTA\s+DE\s+AHORRO(?:\s+SOS)?|CUENTA\s+CHEQUES|N[UÚ]MERO\s+DE\s+CUENTA|CUENTA)[^\d*X\n]{0,40}?(\d{6,22})\b/i
    );
    if (bankAccMatch) {
      accountNumber = bankAccMatch[1];
    } else {
      const standaloneDigits = cleanedText.match(/\b(\d{8,20})\b/);
      if (standaloneDigits) {
        accountNumber = normalizeAccountOrCardNumber(standaloneDigits[1], accountType);
      }
    }
  }

  const allAmounts = [
    ...cleanedText.matchAll(
      /(?:L\.?|\$|HNL|USD|LPS)?\s*(\d{1,3}(?:,\d{3})+\.\d{2}|\d{1,9}\.\d{2})\b/gi
    ),
  ].map((m) => cleanAmount(m[1]));

  const currentBalance = allAmounts.length > 0 ? Math.max(...allAmounts) : 0;

  const detectedTransactions = [];
  const rowRegex =
    /(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|20\d{2}-\d{2}-\d{2})\s+([\s\S]+?)\s+(?:(Cr[eé]dito|D[eé]bito)\s+)?(?:L\.?|\$|HNL|USD)?\s*(\d{1,3}(?:,\d{3})+\.\d{2}|\d{1,9}\.\d{2})/gi;
  let match;
  while ((match = rowRegex.exec(cleanedText)) !== null) {
    const date = normalizeScanDateToIso(match[1]);
    const rawConcept = match[2]
      .replace(/\r?\n/g, ' ')
      .replace(/\b(?:Cr[eé]dito|D[eé]bito)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    const labelType = match[3] || '';
    const amount = cleanAmount(match[4]);
    const type = classifyTransactionType(labelType, rawConcept);
    if (amount > 0 && rawConcept && !isMobileUiNoiseLine(rawConcept)) {
      detectedTransactions.push({
        id: `imp_tx_${detectedTransactions.length}_${Date.now().toString(36)}`,
        date,
        concept: rawConcept,
        type,
        amount,
        selected: true,
      });
    }
  }

  return validateExtractedAccount({
    bankName,
    accountType,
    accountNumber,
    currency,
    currentBalance,
    status: 'Activa',
    detectedTransactions,
  });
}

/**
 * @param {File | Blob | string} fileOrDataUrl
 * @param {{ apiKey?: string, ocrTextFallback?: string, fetchImpl?: typeof fetch }} [options]
 */
export async function extractAccountFromFile(fileOrDataUrl, options = {}) {
  const { base64Data, mimeType } = await encodeFileToBase64(fileOrDataUrl);
  const fetchFn = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const apiKey = String(options.apiKey || '').trim();
  const fallbackText = String(options.ocrTextFallback || options.ocrFallbackText || '');

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
                { text: ACCOUNT_EXTRACTOR_SYSTEM_PROMPT },
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
            responseSchema: EXTRACTED_ACCOUNT_JSON_SCHEMA,
          },
        }),
      });

      if (response.ok) {
        const payload = await response.json();
        const rawJson = payload?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (rawJson) {
          const parsed = JSON.parse(rawJson);
          const validated = ExtractedAccountSchema.parse(parsed);
          return {
            ...validated,
            data: validated,
            source: 'gemini-1.5-flash',
          };
        }
      }
    } catch {
      // Fallback to server Genkit or local OCR
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
          ocrTextFallback: fallbackText,
          apiKey: apiKey || undefined,
        }),
      });
      if (res.ok) {
        const body = await res.json();
        if (body?.ok && body?.data) {
          const validated = ExtractedAccountSchema.parse(body.data);
          return {
            ...validated,
            data: validated,
            source: body.source || 'genkit:gemini-1.5-flash',
          };
        }
      }
    } catch {
      // Fallback to local OCR parser
    }
  }

  if (fallbackText && fallbackText.trim().length > 0) {
    const validated = parseAccountDataFromTextFallback(fallbackText);
    return {
      ...validated,
      data: validated,
      source: 'local-ocr-fallback',
    };
  }

  throw new Error(
    'No se pudo extraer la información de la cuenta. Configura tu Gemini API Key en la pestaña Perfil o sube una imagen/PDF legible.'
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
 * @param {object} rawAccountData
 * @param {object} [state]
 * @param {object} [context]
 */
export async function persistImportedAccountAndTransactions(
  rawAccountData,
  stateOrContext,
  maybeContext = {}
) {
  const isSecondArgState =
    stateOrContext &&
    (Array.isArray(stateOrContext.accounts) || Array.isArray(stateOrContext.transactions));
  const state = isSecondArgState ? stateOrContext : stateOrContext?.appState || null;
  const context = isSecondArgState ? maybeContext : stateOrContext || {};

  const rawTxs = Array.isArray(rawAccountData?.detectedTransactions)
    ? rawAccountData.detectedTransactions.map((tx) => ({
        ...tx,
        duplicateTxId: tx.duplicateTxId || tx.duplicateId || '',
      }))
    : [];

  const validated = ExtractedAccountSchema.parse({
    ...rawAccountData,
    detectedTransactions: rawTxs,
  });

  const skippedTransactions = validated.detectedTransactions.filter(
    (tx) => tx.selected === false || tx.duplicateAction === 'skip'
  );
  const selectedTxs = validated.detectedTransactions.filter(
    (tx) => tx.selected !== false && tx.duplicateAction !== 'skip'
  );

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
    String(
      context.createdByUid ||
        user?.uid ||
        profile?.uid ||
        state?.settings?.currentUid ||
        'local_default_user'
    ).trim() || 'local_default_user';

  const createdByEmail =
    String(context.createdByEmail || user?.email || profile?.email || 'personal@pisto.hn')
      .trim()
      .toLowerCase() || 'personal@pisto.hn';

  const isCard = /tarjeta|cr[eé]dito/i.test(validated.accountType);
  const internalType = isCard ? ACCOUNT_TYPES.CARD : ACCOUNT_TYPES.BANK;
  const isArchived = /^inactiv/i.test(validated.status || 'Activa');

  let netSelectedTxCents = 0;
  for (const tx of selectedTxs) {
    if (tx.duplicateAction === 'overwrite') continue;
    const cents = Money.toCents(cleanAmount(tx.amount));
    if (tx.type === 'income') {
      netSelectedTxCents += cents;
    } else {
      netSelectedTxCents -= cents;
    }
  }
  const targetBalanceCents = Money.toCents(cleanAmount(validated.currentBalance));
  const computedInitialBalance = Money.fromCents(targetBalanceCents - netSelectedTxCents);

  const shortType =
    validated.accountType.replace(/^Cuenta\s+de\s+/i, '').replace(/^Cuenta\s+/i, '').trim() ||
    validated.accountType;
  const accountDisplayName = `${validated.bankName} - ${shortType}`.slice(0, 48);

  const normAccNum = String(validated.accountNumber || '').replace(/[\s-]/g, '');
  const existingAccount =
    (context.existingAccountId
      ? (state?.accounts || []).find((a) => a.id === context.existingAccountId)
      : null) ||
    (normAccNum
      ? (state?.accounts || []).find(
          (a) => String(a.accountNumber || '').replace(/[\s-]/g, '') === normAccNum
        )
      : null) ||
    null;

  const nowIso = new Date().toISOString();
  const accountEntity = {
    ...createAccount({
      id: existingAccount?.id || undefined,
      name: accountDisplayName,
      type: internalType,
      institution: resolveCanonicalInstitution(validated.bankName),
      accountNumber: validated.accountNumber,
      currency: validated.currency === 'USD' ? 'USD' : 'HNL',
      initialBalance: existingAccount ? existingAccount.initialBalance : computedInitialBalance,
      targetAmount: existingAccount?.targetAmount || 0,
      includeInTotal: !isArchived,
      color: isCard ? '#8b5cf6' : '#10b981',
      icon: isCard ? 'card' : 'bank',
      isArchived,
      status: isArchived ? 'archived' : 'active',
      workspaceId,
      createdByUid,
      createdAt: existingAccount?.createdAt || nowIso,
      updatedAt: nowIso,
    }),
    bankName: validated.bankName,
    accountType: validated.accountType,
    currentBalance: validated.currentBalance,
  };

  const overwrittenTransactions = [];
  const newlyCreatedTransactions = [];

  const persistedTransactions = selectedTxs.map((detTx) => {
    const existingDupId =
      detTx.duplicateAction === 'overwrite' && detTx.duplicateTxId
        ? String(detTx.duplicateTxId)
        : undefined;
    const txDoc = prepareTransactionForWorkspace(
      {
        id: existingDupId,
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
    );
    if (existingDupId) {
      overwrittenTransactions.push(txDoc);
    } else {
      newlyCreatedTransactions.push(txDoc);
    }
    return txDoc;
  });

  let batchCommitted = false;
  const { firestoreDb, firestoreModule, storage } = context;

  if (firestoreDb && firestoreModule && typeof firestoreModule.doc === 'function') {
    try {
      const accountRef = firestoreModule.doc(firestoreDb, 'accounts', accountEntity.id);
      if (typeof firestoreModule.writeBatch === 'function') {
        const batch = firestoreModule.writeBatch(firestoreDb);
        if (typeof batch.set === 'function') {
          batch.set(accountRef, accountEntity, { merge: true });
          for (const txDoc of persistedTransactions) {
            const txRef = firestoreModule.doc(firestoreDb, 'transactions', txDoc.id);
            batch.set(txRef, txDoc, { merge: true });
          }
          await batch.commit();
          batchCommitted = true;
        }
      }
      if (!batchCommitted && typeof firestoreModule.setDoc === 'function') {
        await firestoreModule.setDoc(accountRef, accountEntity, { merge: true });
        for (const txDoc of persistedTransactions) {
          const txRef = firestoreModule.doc(firestoreDb, 'transactions', txDoc.id);
          await firestoreModule.setDoc(txRef, txDoc, { merge: true });
        }
        batchCommitted = true;
      }
    } catch {
      // Fallback to local workspace storage when Firestore is offline
    }
  }

  for (const txDoc of persistedTransactions) {
    await saveTransactionToWorkspace(txDoc, user, profile, {
      firestoreDb: batchCommitted ? null : firestoreDb,
      firestoreModule: batchCommitted ? null : firestoreModule,
      storage,
    });
  }

  if (state) {
    if (Array.isArray(state.accounts)) {
      const existingAccIdx = state.accounts.findIndex((a) => a.id === accountEntity.id);
      if (existingAccIdx !== -1) {
        state.accounts[existingAccIdx] = accountEntity;
      } else {
        state.accounts.push(accountEntity);
      }
    }
    if (Array.isArray(state.transactions)) {
      for (const txDoc of [...persistedTransactions].reverse()) {
        const existingTxIdx = state.transactions.findIndex((t) => t.id === txDoc.id);
        if (existingTxIdx !== -1) {
          state.transactions[existingTxIdx] = txDoc;
        } else {
          state.transactions.unshift(txDoc);
        }
      }
    }
  }

  const toastMessage = '🎉 Cuenta y movimientos creados correctamente';
  if (typeof context.notifyToast === 'function') {
    context.notifyToast(toastMessage);
  }

  return {
    account: accountEntity,
    accountUpdated: Boolean(existingAccount),
    transactions: persistedTransactions,
    createdTransactions: newlyCreatedTransactions,
    overwrittenTransactions,
    skippedTransactions,
    batchCommitted,
    toastMessage,
  };
}
