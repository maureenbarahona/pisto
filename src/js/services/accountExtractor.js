/**
 * @fileoverview Servicio de Extracción y Guardado Masivo en Lote (Array/Batch) de Cuentas y Tarjetas
 * mediante Genkit / Gemini Vision y Fallback OCR Determinista (`src/js/services/accountExtractor.js`).
 *
 * Implementa:
 * 1. Esquema de Extracción Genkit/Gemini Vision (`accountsArray`):
 *    - `bankName`: Banco detectado o seleccionable (ej. "BAC Credomatic", "Banco Atlántida").
 *    - `accountsArray`: Array de objetos donde cada elemento representa una cuenta o tarjeta detectada:
 *      - `accountType`: string (ej. "Cuenta Bancaria", "HN - CUENTA BANCARIA", "HN - Negocio Lempiras", "Tarjeta de Crédito - AMERICAN EXPRESS")
 *      - `accountNumber`: string (ej. "726935871" o "3244" en tarjetas)
 *      - `currency`: string ("HNL" si ve "LPS", "USD" si ve "USD" o "$")
 *      - `currentBalance`: number Float (Sanitizar comas y convertir a número Float, ej. "3,705.95" -> 3705.95)
 *      - `isCreditCard`: boolean (true si pertenece a la sección "Tarjetas de crédito")
 * 2. Guardado Atómico en Lote (`saveBatchAccountsToFirestore` / `persistBatchAccountsWriteBatch`):
 *    - Consulta la colección `accounts` en Firestore (y estado local) para filtrar y omitir números de cuenta
 *      que YA EXISTAN en el `workspaceId` actual.
 *    - Ejecuta un `writeBatch` para registrar todos los productos seleccionados de una sola vez en `accounts`.
 *    - Muestra el mensaje/toast: "🎉 Se registraron X cuentas exitosamente (y se omitieron N duplicadas)."
 * 3. Vanilla JS ESNext puro, cero llamadas a `console.log`.
 */

import {
  Money,
  ACCOUNT_TYPES,
  TRANSACTION_TYPES,
  createAccount,
} from '../../../public/js/domain/models.js';
import {
  cleanAmount,
  cleanMobileUiText,
  isMobileUiNoiseLine,
  normalizeScanDateToIso,
  normalizeBankName,
  normalizeScanCurrency,
  normalizeAccountOrCardNumber,
  classifyTransactionType,
} from '../../../public/js/schemas/accountScan.js';
import {
  prepareTransactionForWorkspace,
  saveTransactionToWorkspace,
} from '../../../public/js/services/transactions.js';

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

/**
 * Productos de demostración del "Resumen de Productos" de BAC Credomatic Honduras
 * para pruebas rápidas y validación determinista del modal de importación por lote.
 */
const DEMO_BATCH_ITEMS = Object.freeze([
  Object.freeze({
    bankName: 'BAC Credomatic',
    accountType: 'HN - CUENTA BANCARIA',
    accountNumber: '726935871',
    currency: 'HNL',
    currentBalance: 401.28,
    isCreditCard: false,
    selected: true,
  }),
  Object.freeze({
    bankName: 'BAC Credomatic',
    accountType: 'HN - CUENTA BANCARIA',
    accountNumber: '751666931',
    currency: 'USD',
    currentBalance: 3705.95,
    isCreditCard: false,
    selected: true,
  }),
  Object.freeze({
    bankName: 'BAC Credomatic',
    accountType: 'HN - Negocio Lempiras',
    accountNumber: '758886371',
    currency: 'HNL',
    currentBalance: 5963.18,
    isCreditCard: false,
    selected: true,
  }),
  Object.freeze({
    bankName: 'BAC Credomatic',
    accountType: 'AMERICAN EXPRESS',
    accountNumber: '3244',
    currency: 'HNL',
    currentBalance: 8154.03,
    isCreditCard: true,
    selected: true,
  }),
]);

export const BATCH_DEMO_PRODUCTS_SUMMARY = Object.freeze({
  bankName: 'BAC Credomatic',
  accounts: DEMO_BATCH_ITEMS,
  accountsArray: DEMO_BATCH_ITEMS,
});

export const ACCOUNT_EXTRACTOR_SYSTEM_PROMPT = [
  'Eres un sistema experto en visión artificial financiera para Honduras y Latinoamérica (Gemini Vision / Genkit).',
  'Tu tarea es analizar una imagen (PNG, JPG, WEBP) o un documento PDF de un "Resumen de Productos", Estado de Cuenta o Detalle de Cuenta de banca móvil y devolver únicamente un objeto JSON estructurado.',
  'REGLA CRÍTICA: La respuesta SIEMPRE debe incluir el arreglo `accounts` (y `accountsArray`), incluso si la captura contiene 1 sola cuenta o múltiples cuentas del resumen bancario.',
  '',
  '1. ARREGLO UNIFICADO DE CUENTAS Y TARJETAS (`bankName` + `accounts` / `accountsArray`):',
  '   - `bankName`: Detecta el nombre del banco en la imagen o encabezado (ej. "BAC Credomatic", "Banco Atlántida", "Banco Ficohsa", "Banpaís (Banco del País)", "Banco de Occidente", "Davivienda", "Promerica").',
  '   - `accounts` (y `accountsArray`): Arreglo de objetos donde cada elemento representa una cuenta bancaria o tarjeta de crédito detectada en la imagen/PDF (mínimo 1 elemento):',
  '     - `bankName`: string con el nombre del banco de esa cuenta (ej. "BAC Credomatic", "Banco Atlántida").',
  '     - `accountType`: string con el nombre o tipo del producto tal como aparece (ej. "HN - CUENTA BANCARIA", "HN - Negocio Lempiras", "Cuenta Bancaria", "Tarjeta de Crédito - AMERICAN EXPRESS", "AMERICAN EXPRESS").',
  '     - `accountNumber`: string con el número de cuenta completo (ej. "726935871", "751666931", "758886371") o los últimos 4 dígitos en tarjetas (ej. "3244").',
  '     - `currency`: string ("HNL" si ve "LPS", "L", "HNL" o "Lempiras"; "USD" si ve "USD" o "$").',
  '     - `currentBalance`: number Float sanitizando comas de miles antes de convertir a Float (ej. "3,705.95" -> 3705.95, "5,963.18" -> 5963.18, "8,154.03" -> 8154.03, "401.28" -> 401.28).',
  '     - `isCreditCard`: boolean (`true` si pertenece a la sección "Tarjetas de crédito" o es una tarjeta VISA / MASTERCARD / AMERICAN EXPRESS; `false` si pertenece a "Cuentas bancarias" / ahorro / cheques).',
  '',
  '2. MOVIMIENTOS / TRANSACCIONES DETECTADAS (`detectedTransactions` - Array opcional si el documento incluye movimientos de una cuenta):',
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

export const EXTRACTED_ACCOUNT_ITEM_JSON_SCHEMA = Object.freeze({
  type: 'OBJECT',
  properties: {
    bankName: {
      type: 'STRING',
      description: 'Nombre del banco para esta cuenta (ej. "BAC Credomatic", "Banco Atlántida")',
    },
    accountType: {
      type: 'STRING',
      description:
        'Nombre o tipo de la cuenta o tarjeta (ej. "HN - CUENTA BANCARIA", "HN - Negocio Lempiras", "Tarjeta de Crédito - AMERICAN EXPRESS")',
    },
    accountNumber: {
      type: 'STRING',
      description:
        'Número de cuenta (ej. "726935871") o últimos 4 dígitos en tarjetas (ej. "3244")',
    },
    currency: {
      type: 'STRING',
      enum: ['HNL', 'USD'],
      description: '"HNL" si ve "LPS", "L" o "Lempiras"; "USD" si ve "USD" o "$"',
    },
    currentBalance: {
      type: 'NUMBER',
      description:
        'Saldo actual/disponible como número Float sanitizando comas ("3,705.95" -> 3705.95)',
    },
    isCreditCard: {
      type: 'BOOLEAN',
      description: 'true si pertenece a la sección "Tarjetas de crédito", false si es cuenta bancaria',
    },
  },
  required: ['accountType', 'accountNumber', 'currency', 'currentBalance', 'isCreditCard'],
});

export const EXTRACTED_ACCOUNT_JSON_SCHEMA = Object.freeze({
  type: 'OBJECT',
  properties: {
    bankName: {
      type: 'STRING',
      description: 'Nombre del banco (ej. BAC Credomatic, Banco Atlántida, Banco Ficohsa, Banpaís)',
    },
    accounts: {
      type: 'ARRAY',
      description:
        'Arreglo obligatorio con todas las cuentas bancarias y tarjetas detectadas (incluso si es 1 sola cuenta)',
      items: EXTRACTED_ACCOUNT_ITEM_JSON_SCHEMA,
    },
    accountsArray: {
      type: 'ARRAY',
      description: 'Alias de lista de todas las cuentas bancarias y tarjetas de crédito detectadas en la imagen o PDF',
      items: EXTRACTED_ACCOUNT_ITEM_JSON_SCHEMA,
    },
    accountType: {
      type: 'STRING',
      description: 'Nombre o tipo de la cuenta principal (compatibilidad con vista individual)',
    },
    accountNumber: {
      type: 'STRING',
      description: 'Número de cuenta principal o últimos 4 dígitos en tarjeta',
    },
    currency: {
      type: 'STRING',
      enum: ['HNL', 'USD'],
      description: '"HNL" si detecta "LPS"/"L"; "USD" si detecta "USD"/"$"',
    },
    currentBalance: {
      type: 'NUMBER',
      description: 'Saldo numérico Float sanitizando comas ("3,705.95" -> 3705.95)',
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
            description: 'Descripción o concepto del movimiento',
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
  required: ['bankName', 'accounts', 'accountsArray'],
});

const BANK_UI_GARBAGE_REGEX =
  /[©®™=<>|_~^•*«»]|--|\b\d{1,2}:\d{2}\b|\b(?:4G|5G|LTE|WIFI|VOLTE)\b|\bdetalle\s+de\s+cuenta\b|\bbal\s*all\b|\bsaldo\s+disponible\b|\bconsulta\s+de\b/i;

export function normalizeExtractorBankName(rawBank, contextHint = '') {
  const raw = String(rawBank ?? '').trim();
  const hint = String(contextHint ?? '').trim();
  const combined = `${raw} ${hint}`.toLowerCase();

  if (combined.includes('atlantida') || combined.includes('atlántida')) return 'Banco Atlántida';
  if (
    /\bbac\b/.test(combined) ||
    combined.includes('credomatic') ||
    combined.includes('american express') ||
    /\bhn\s*-\s*(?:cuenta|negocio)\b/i.test(combined)
  ) {
    return 'BAC Credomatic';
  }
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
 * Determina si un producto detectado corresponde a una Tarjeta de Crédito (`isCreditCard: true`).
 * @param {object} item
 * @param {string} [sectionHint='']
 * @returns {boolean}
 */
export function inferIsCreditCard(item = {}, sectionHint = '') {
  if (typeof item?.isCreditCard === 'boolean') {
    return item.isCreditCard;
  }
  const combined = `${String(item?.accountType || '')} ${String(sectionHint || '')}`.toLowerCase();
  if (
    /tarjeta\s+de\s+cr[eé]dito|tarjetas\s+de\s+cr[eé]dito|american\s+express|\bamex\b|\bvisa\b|\bmastercard\b|\bcredomatic\s+card\b/i.test(
      combined
    )
  ) {
    return true;
  }
  const rawNum = String(item?.accountNumber || '').trim();
  const digits = rawNum.replace(/\D+/g, '');
  if (digits.length === 4 && !/cuenta/i.test(combined)) {
    return true;
  }
  return false;
}

/**
 * Normaliza un elemento individual de `accounts` / `accountsArray`.
 * @param {any} rawItem
 * @param {number} [index=0]
 * @param {string} [defaultBankName='']
 */
export function normalizeExtractedAccountItem(rawItem = {}, index = 0, defaultBankName = '') {
  const isCreditCard = inferIsCreditCard(rawItem);
  const fallbackType = isCreditCard ? 'Tarjeta de Crédito' : 'Cuenta de Ahorro';
  const accountType =
    String(rawItem?.accountType || rawItem?.name || fallbackType)
      .replace(/\s+/g, ' ')
      .trim() || fallbackType;

  const accountNumber = normalizeAccountOrCardNumber(
    rawItem?.accountNumber ?? '',
    isCreditCard ? `Tarjeta de Crédito ${accountType}` : accountType
  );
  const currency = normalizeScanCurrency(rawItem?.currency || 'HNL');
  const currentBalance = cleanAmount(rawItem?.currentBalance ?? rawItem?.balance ?? 0);
  const selected = rawItem?.selected !== undefined ? Boolean(rawItem.selected) : true;
  const statusRaw = String(rawItem?.status || 'Activa').trim();
  const status = /^inactiv/i.test(statusRaw) ? 'Inactiva' : 'Activa';
  const resolvedBankName = rawItem?.bankName
    ? normalizeExtractorBankName(rawItem.bankName, accountType)
    : defaultBankName
      ? normalizeExtractorBankName(defaultBankName, accountType)
      : normalizeExtractorBankName('', accountType);

  return {
    id: String(rawItem?.id || `batch_acc_${index}_${accountNumber || index}`),
    bankName: resolvedBankName,
    accountType,
    accountNumber,
    currency,
    currentBalance,
    isCreditCard,
    status,
    selected,
  };
}

/**
 * Valida y normaliza la respuesta de extracción devolviendo SIEMPRE el arreglo `accounts`
 * (además de `accountsArray` por compatibilidad), incluso si la captura contiene 1 sola cuenta.
 * @param {any} input
 */
export function validateExtractedAccount(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Los datos extraídos de la cuenta no son válidos.');
  }

  const rawArray = Array.isArray(input.accounts) && input.accounts.length > 0
    ? input.accounts
    : Array.isArray(input.accountsArray) && input.accountsArray.length > 0
      ? input.accountsArray
      : [];

  const firstItemHint =
    rawArray[0]?.accountType || input.accountType || 'Cuenta de Ahorro';
  const bankName = normalizeExtractorBankName(
    input.bankName || rawArray[0]?.bankName,
    firstItemHint
  );

  let accountsArray = rawArray
    .filter((item) => item && typeof item === 'object')
    .map((item, idx) => normalizeExtractedAccountItem(item, idx, bankName));

  const primaryInputType =
    String(input.accountType || accountsArray[0]?.accountType || 'Cuenta de Ahorro')
      .replace(/\s+/g, ' ')
      .trim() || 'Cuenta de Ahorro';

  const primaryIsCard =
    accountsArray[0]?.isCreditCard ?? inferIsCreditCard(input, primaryInputType);

  const accountNumber =
    input.accountNumber !== undefined
      ? normalizeAccountOrCardNumber(
          input.accountNumber,
          primaryIsCard ? `Tarjeta de Crédito ${primaryInputType}` : primaryInputType
        )
      : accountsArray[0]?.accountNumber || '';

  const currency = normalizeScanCurrency(
    input.currency ?? accountsArray[0]?.currency ?? 'HNL'
  );
  const currentBalance = cleanAmount(
    input.currentBalance ?? input.availableBalance ?? input.balance ?? accountsArray[0]?.currentBalance ?? 0
  );
  const statusRaw = String(input.status || accountsArray[0]?.status || 'Activa').trim();
  const status = /^inactiv/i.test(statusRaw) ? 'Inactiva' : 'Activa';

  if (accountsArray.length === 0) {
    accountsArray = [
      normalizeExtractedAccountItem(
        {
          bankName,
          accountType: primaryInputType,
          accountNumber,
          currency,
          currentBalance,
          isCreditCard: primaryIsCard,
          status,
          selected: true,
        },
        0,
        bankName
      ),
    ];
  }

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
    bankName: accountsArray[0]?.bankName || bankName,
    accounts: accountsArray,
    accountsArray,
    accountType: accountsArray[0]?.accountType || primaryInputType,
    accountNumber: accountsArray[0]?.accountNumber ?? accountNumber,
    currency: accountsArray[0]?.currency || currency,
    currentBalance: accountsArray[0]?.currentBalance ?? currentBalance,
    isCreditCard: Boolean(accountsArray[0]?.isCreditCard ?? primaryIsCard),
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

export const ExtractedBatchAccountsSchema = Object.freeze({
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
 * Analiza texto OCR de un "Resumen de Productos" (múltiples cuentas bancarias y tarjetas de crédito)
 * y extrae `accountsArray`.
 * @param {string} rawText
 * @returns {{ bankName: string, accountsArray: Array<object> }}
 */
export function parseBatchAccountsFromTextFallback(rawText) {
  const cleanedText = cleanMobileUiText(String(rawText || ''));
  const lines = cleanedText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const bankName = normalizeExtractorBankName(cleanedText, cleanedText);
  const detectedItems = [];
  let inCreditCardSection = false;

  // Patrón 1: Líneas compactas tipo "HN - CUENTA BANCARIA | N.° 726935871 | 401.28 HNL" o "HN - CUENTA BANCARIA 726935871 LPS 401.28"
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^tarjetas?\s+de\s+cr[eé]dito\b/i.test(line)) {
      inCreditCardSection = true;
      continue;
    }
    if (/^cuentas?\s+bancarias?\b/i.test(line)) {
      inCreditCardSection = false;
      continue;
    }

    // Formato con pipes o en una sola línea: Nombre | N.° 726935871 | LPS 401.28 (o 401.28 HNL)
    const inlineMatch = line.match(
      /^([A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9\s\-/()]+?)\s*(?:\||N\.?°?|#|-)\s*(?:N\.?°?\s*)?([*X•\s]*\d{4,20})\s*(?:\||-|\s)\s*(?:(LPS|HNL|USD|\$|L\.?)\s*([\d,]+\.\d{2})|([\d,]+\.\d{2})\s*(LPS|HNL|USD|\$|L\.?))$/i
    );
    if (inlineMatch) {
      const rawType = inlineMatch[1].trim();
      const rawNum = inlineMatch[2].trim();
      const rawCur = inlineMatch[3] || inlineMatch[6] || 'HNL';
      const rawBal = inlineMatch[4] || inlineMatch[5] || '0';
      const isCard =
        inCreditCardSection ||
        inferIsCreditCard({ accountType: rawType, accountNumber: rawNum });
      detectedItems.push(
        normalizeExtractedAccountItem(
          {
            accountType: rawType,
            accountNumber: rawNum,
            currency: normalizeScanCurrency(rawCur),
            currentBalance: cleanAmount(rawBal),
            isCreditCard: isCard,
            selected: true,
          },
          detectedItems.length,
          bankName
        )
      );
      continue;
    }

    // Formato multilínea de banca móvil (BAC / Atlántida):
    // Línea A: Nombre del producto (ej. "HN - CUENTA BANCARIA", "HN - Negocio Lempiras", "AMERICAN EXPRESS")
    // Línea B/C: Número de cuenta/tarjeta ("726935871" o "*3244" / "3244") y Saldo ("LPS 401.28" o "USD 3,705.95")
    const isProductHeader =
      /\b(?:HN\s*-\s*CUENTA\s+BANCARIA|HN\s*-\s*Negocio[^|0-9]*|AMERICAN\s+EXPRESS|VISA[^|0-9]*|MASTERCARD[^|0-9]*|CUENTA\s+DE\s+AHORRO(?:\s+SOS)?|CUENTA\s+BANCARIA|CUENTA\s+CHEQUES|TARJETA\s+DE\s+CR[EÉ]DITO[^|0-9]*)\b/i.test(
        line
      ) && !/^\d/.test(line);

    if (isProductHeader) {
      const windowLines = lines.slice(i, Math.min(lines.length, i + 4)).join(' ');
      const numMatch =
        windowLines.match(/(?:N\.?°?\s*|[*X•]{2,}\s*)(\d{4,20})\b/i) ||
        windowLines.match(/\b(\d{7,20})\b/) ||
        windowLines.match(/\b(\d{4})\b/);
      const balMatch =
        windowLines.match(/\b(LPS|HNL|USD|US\$|\$|L\.?)\s*(\d{1,3}(?:,\d{3})+\.\d{2}|\d+\.\d{2})\b/i) ||
        windowLines.match(/\b(\d{1,3}(?:,\d{3})+\.\d{2}|\d+\.\d{2})\s*(LPS|HNL|USD|US\$|\$|L\.?)\b/i);

      if (numMatch && balMatch) {
        const isFirstCur = /^(?:LPS|HNL|USD|US\$|\$|L\.?)$/i.test(balMatch[1]);
        const rawCur = isFirstCur ? balMatch[1] : balMatch[2];
        const rawBal = isFirstCur ? balMatch[2] : balMatch[1];
        const cleanHeader = line
          .replace(/\b(?:LPS|HNL|USD|US\$|\$)\s*[\d,]+\.\d{2}.*$/i, '')
          .replace(/\b\d{7,20}\b.*$/, '')
          .trim();
        const isCard =
          inCreditCardSection ||
          inferIsCreditCard({ accountType: cleanHeader, accountNumber: numMatch[1] });

        detectedItems.push(
          normalizeExtractedAccountItem(
            {
              accountType: cleanHeader || line,
              accountNumber: numMatch[1],
              currency: normalizeScanCurrency(rawCur),
              currentBalance: cleanAmount(rawBal),
              isCreditCard: isCard,
              selected: true,
            },
            detectedItems.length,
            bankName
          )
        );
      }
    }
  }

  return {
    bankName,
    accounts: detectedItems,
    accountsArray: detectedItems,
  };
}

/**
 * @param {string} rawText
 */
export function parseAccountDataFromTextFallback(rawText) {
  const cleanedText = cleanMobileUiText(String(rawText || ''));
  const batchCandidate = parseBatchAccountsFromTextFallback(rawText);

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
    if (/\bHN\s*-\s*CUENTA\s+BANCARIA\b/i.test(line)) {
      accountType = 'HN - CUENTA BANCARIA';
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
    if (/\bTARJETA\s+DE\s+CR[EÉ]DITO\b|\bAMERICAN\s+EXPRESS\b/i.test(line)) {
      accountType = /AMERICAN\s+EXPRESS/i.test(line)
        ? 'AMERICAN EXPRESS'
        : 'Tarjeta de Crédito';
      break;
    }
  }

  let accountNumber = '';
  const isCard = /tarjeta|american\s+express|amex|visa|mastercard/i.test(accountType);
  if (isCard) {
    const maskedMatch = cleanedText.match(/[*X•]{1,}(?:\s*[*X•]{1,})*\s*(\d{4})\b/);
    if (maskedMatch) accountNumber = maskedMatch[1];
  }
  if (!accountNumber) {
    const bankAccMatch = cleanedText.match(
      /(?:CUENTA\s+DE\s+AHORRO(?:\s+SOS)?|CUENTA\s+BANCARIA|CUENTA\s+CHEQUES|N[UÚ]MERO\s+DE\s+CUENTA|CUENTA)[^\d*X\n]{0,40}?(\d{6,22})\b/i
    );
    if (bankAccMatch) {
      accountNumber = bankAccMatch[1];
    } else {
      const standaloneDigits = cleanedText.match(/\b(\d{7,20})\b/);
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
    /(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|20\d{2}-\d{2}-\d{2})\s+([\s\S]+?)\s+(?:(Cr[eé]dito|D[eé]bito)\s+)?(?:L\.?|\$|HNL|USD|LPS)?\s*(\d{1,3}(?:,\d{3})+\.\d{2}|\d{1,9}\.\d{2})/gi;
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

  if (batchCandidate.accountsArray.length > 1) {
    return validateExtractedAccount({
      bankName: batchCandidate.bankName || bankName,
      accountsArray: batchCandidate.accountsArray,
      detectedTransactions,
    });
  }

  return validateExtractedAccount({
    bankName,
    accountType,
    accountNumber,
    currency,
    currentBalance,
    isCreditCard: isCard,
    status: 'Activa',
    accountsArray:
      batchCandidate.accountsArray.length === 1
        ? batchCandidate.accountsArray
        : [
            {
              accountType,
              accountNumber,
              currency,
              currentBalance,
              isCreditCard: isCard,
              selected: true,
            },
          ],
    detectedTransactions,
  });
}

/**
 * Extrae una o múltiples cuentas y tarjetas (`accountsArray`) desde una imagen o PDF
 * usando Gemini Vision / Genkit o fallback OCR local.
 *
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
 * Formatea el mensaje de confirmación tras guardar cuentas en lote:
 * `"🎉 Se registraron X cuentas exitosamente (y se omitieron N duplicadas)."`
 *
 * @param {number} createdCount
 * @param {number} skippedDuplicatesCount
 * @returns {string}
 */
export function formatBatchAccountsToastMessage(createdCount = 0, skippedDuplicatesCount = 0) {
  return `🎉 Se registraron ${Number(createdCount) || 0} cuentas exitosamente (y se omitieron ${Number(skippedDuplicatesCount) || 0} duplicadas).`;
}

/**
 * Consulta la colección `accounts` en Firestore (y en memoria `state.accounts`) para el `workspaceId`
 * actual y devuelve un `Set` de números de cuenta normalizados ya existentes.
 *
 * @param {{ workspaceId?: string, state?: object, firestoreDb?: any, firestoreModule?: any, storage?: any }} [context]
 * @returns {Promise<Set<string>>}
 */
export async function fetchExistingWorkspaceAccountNumbers(context = {}) {
  const workspaceId =
    String(
      context.workspaceId ||
        context.currentUserProfile?.workspaceId ||
        context.state?.settings?.workspaceId ||
        'ws_default'
    ).trim() || 'ws_default';

  const existingNumbers = new Set();

  // 1. Revisar cuentas en memoria (solo las del workspaceId activo y que no sean semillas demo en espacios autenticados)
  const localAccounts = Array.isArray(context.state?.accounts)
    ? context.state.accounts
    : Array.isArray(context.existingAccounts)
      ? context.existingAccounts
      : [];

  for (const acc of localAccounts) {
    if (!acc || typeof acc !== 'object') continue;
    const accWs = String(acc.workspaceId || 'ws_default').trim();
    if (workspaceId !== 'ws_default' && accWs !== workspaceId) continue;
    const cleanNum = String(acc.accountNumber || '').replace(/[\s-]/g, '').trim();
    if (cleanNum) {
      existingNumbers.add(cleanNum);
    }
  }

  // 2. Consultar la colección `accounts` en Firestore filtrando por `workspaceId`
  const { firestoreDb, firestoreModule } = context;
  if (
    firestoreDb &&
    firestoreModule &&
    typeof firestoreModule.collection === 'function' &&
    typeof firestoreModule.query === 'function' &&
    typeof firestoreModule.where === 'function' &&
    typeof firestoreModule.getDocs === 'function'
  ) {
    try {
      const colRef = firestoreModule.collection(firestoreDb, 'accounts');
      const q = firestoreModule.query(
        colRef,
        firestoreModule.where('workspaceId', '==', workspaceId)
      );
      const snap = await firestoreModule.getDocs(q);
      const docs = Array.isArray(snap?.docs) ? snap.docs : [];
      for (const docSnap of docs) {
        const data = typeof docSnap.data === 'function' ? docSnap.data() : docSnap;
        const cleanNum = String(data?.accountNumber || '').replace(/[\s-]/g, '').trim();
        if (cleanNum) {
          existingNumbers.add(cleanNum);
        }
      }
    } catch {
      // Fallback silencioso a cuentas en memoria si Firestore está offline
    }
  }

  return existingNumbers;
}

/**
 * Guardado Atómico en Lote (`writeBatch` en Firestore) & Deduplicación por `accountNumber` en `workspaceId`:
 * a) Consulta la colección `accounts` en Firestore para filtrar y omitir números de cuenta que YA EXISTAN en el `workspaceId` actual.
 * b) Ejecuta un `writeBatch` para registrar todos los productos seleccionados de una sola vez en la colección `accounts`.
 * c) Muestra el mensaje/toast: `"🎉 Se registraron X cuentas exitosamente (y se omitieron N duplicadas)."`
 *
 * @param {{ bankName?: string, accountsArray: Array<object> }} batchPayload
 * @param {object} [stateOrContext]
 * @param {object} [maybeContext]
 */
export async function saveBatchAccountsToFirestore(
  batchPayload,
  stateOrContext = {},
  maybeContext = {}
) {
  const isSecondArgState =
    stateOrContext &&
    (Array.isArray(stateOrContext.accounts) || Array.isArray(stateOrContext.transactions));
  const state = isSecondArgState ? stateOrContext : stateOrContext?.appState || stateOrContext?.state || null;
  const context = isSecondArgState ? maybeContext : stateOrContext || {};

  const validated = validateExtractedAccount(batchPayload);
  const bankName = validated.bankName;
  const candidateItems = (validated.accountsArray || []).filter(
    (item) => item && item.selected !== false
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

  // a) Consultar la colección `accounts` en Firestore para filtrar y omitir números de cuenta que YA EXISTAN en `workspaceId`
  const existingNumbers = await fetchExistingWorkspaceAccountNumbers({
    ...context,
    workspaceId,
    state,
  });

  const createdAccounts = [];
  const skippedAccounts = [];
  const nowIso = new Date().toISOString();

  for (let i = 0; i < candidateItems.length; i += 1) {
    const item = candidateItems[i];
    const cleanNum = String(item.accountNumber || '').replace(/[\s-]/g, '').trim();

    if (cleanNum && existingNumbers.has(cleanNum)) {
      skippedAccounts.push({
        ...item,
        reason: 'duplicate_account_number',
      });
      continue;
    }

    if (cleanNum) {
      existingNumbers.add(cleanNum);
    }

    const itemBankName = item.bankName || bankName || 'BAC Credomatic';
    const isCard = Boolean(item.isCreditCard || inferIsCreditCard(item));
    const internalType = isCard ? ACCOUNT_TYPES.CARD : ACCOUNT_TYPES.BANK;
    const rawLabel = String(item.accountType || '').trim();
    const displayName =
      rawLabel.toLowerCase().includes(itemBankName.toLowerCase()) ||
      /^HN\s*-/i.test(rawLabel) ||
      /AMERICAN\s+EXPRESS/i.test(rawLabel)
        ? rawLabel.slice(0, 48)
        : `${itemBankName} - ${rawLabel}`.slice(0, 48);

    const sanitizedBalance = cleanAmount(item.currentBalance);
    const accountEntity = {
      ...createAccount({
        id: `acc_batch_${Date.now().toString(36)}_${i}_${Math.random().toString(36).slice(2, 6)}`,
        name: displayName,
        type: internalType,
        institution: resolveCanonicalInstitution(itemBankName),
        accountNumber: cleanNum || item.accountNumber || '',
        currency: item.currency === 'USD' ? 'USD' : 'HNL',
        initialBalance: sanitizedBalance,
        targetAmount: 0,
        includeInTotal: true,
        color: isCard ? '#8b5cf6' : '#10b981',
        icon: isCard ? 'card' : 'bank',
        isArchived: false,
        status: 'active',
        workspaceId,
        createdByUid,
        createdAt: nowIso,
        updatedAt: nowIso,
      }),
      bankName: itemBankName,
      accountType: rawLabel || (isCard ? 'Tarjeta de Crédito' : 'Cuenta Bancaria'),
      currentBalance: sanitizedBalance,
      isCreditCard: isCard,
    };

    createdAccounts.push(accountEntity);
  }

  // b) Ejecutar un `writeBatch` en Firestore para registrar todos los productos seleccionados de una sola vez
  let batchCommitted = false;
  const { firestoreDb, firestoreModule, storage } = context;

  if (
    createdAccounts.length > 0 &&
    firestoreDb &&
    firestoreModule &&
    typeof firestoreModule.doc === 'function'
  ) {
    try {
      if (typeof firestoreModule.writeBatch === 'function') {
        const batch = firestoreModule.writeBatch(firestoreDb);
        if (typeof batch.set === 'function') {
          for (const accDoc of createdAccounts) {
            const accRef = firestoreModule.doc(firestoreDb, 'accounts', accDoc.id);
            batch.set(accRef, accDoc, { merge: true });
          }
          await batch.commit();
          batchCommitted = true;
        }
      }
      if (!batchCommitted && typeof firestoreModule.setDoc === 'function') {
        for (const accDoc of createdAccounts) {
          const accRef = firestoreModule.doc(firestoreDb, 'accounts', accDoc.id);
          await firestoreModule.setDoc(accRef, accDoc, { merge: true });
        }
        batchCommitted = true;
      }
    } catch {
      // Fallback a estado Local-First si Firestore está offline
    }
  }

  // Actualizar estado en memoria y caché local del workspace
  if (state && Array.isArray(state.accounts)) {
    for (const accDoc of createdAccounts) {
      state.accounts.push(accDoc);
    }
  }

  if (storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function') {
    try {
      const cacheKey = `pisto_firestore_accounts_ws_${workspaceId}`;
      const rawCache = storage.getItem(cacheKey);
      const cachedList = rawCache ? JSON.parse(rawCache) : [];
      const mergedList = Array.isArray(cachedList) ? [...cachedList, ...createdAccounts] : [...createdAccounts];
      storage.setItem(cacheKey, JSON.stringify(mergedList));
    } catch {
      // Ignore storage quota errors
    }
  }

  // c) Mostrar mensaje/toast: "🎉 Se registraron X cuentas exitosamente (y se omitieron N duplicadas)."
  const toastMessage = formatBatchAccountsToastMessage(
    createdAccounts.length,
    skippedAccounts.length
  );

  if (typeof context.notifyToast === 'function') {
    context.notifyToast(toastMessage);
  }

  return {
    createdAccounts,
    skippedAccounts,
    createdCount: createdAccounts.length,
    skippedCount: skippedAccounts.length,
    savedCount: createdAccounts.length,
    skippedDuplicatesCount: skippedAccounts.length,
    workspaceId,
    batchCommitted,
    toastMessage,
  };
}

export const persistBatchAccountsWriteBatch = saveBatchAccountsToFirestore;

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

  const isCard =
    Boolean(validated.isCreditCard) || /tarjeta|cr[eé]dito|american\s+express/i.test(validated.accountType);
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
    isCreditCard: isCard,
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
