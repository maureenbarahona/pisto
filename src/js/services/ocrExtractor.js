/**
 * @fileoverview Motor Híbrido de Extracción de Cuentas Bancarias (`src/js/services/ocrExtractor.js`).
 *
 * combina Tesseract.js (OCR de código abierto local) con Gemini 2.5 Flash Vision para procesar
 * cualquier formato bancario (imágenes o PDF) en cuentas de ahorro, débito/cheques, tarjetas de
 * crédito (incluyendo doble saldo HNL/USD) y préstamos:
 *
 * 1. Etapa Primaria (Motor Local Open-Source - Local-First, Costo API $0):
 *    - Ejecuta Tesseract.js (y PDF.js para PDFs) localmente en el navegador.
 *    - Compara el texto extraído contra los patrones y huellas en `bank_templates`
 *      (IndexedDB `bank_templates_local` / Firestore `bank_templates`).
 *    - Extrae: Nombre del Banco (`bankName`), Número de Cuenta/Tarjeta (`accountNumber`),
 *      Moneda (`HNL`/`USD`), Saldo/Monto (`currentBalance`) y Tipo de Producto
 *      (`productType`: `Ahorro`, `Cheques`, `Tarjeta de Crédito`, `Préstamo`).
 *
 * 2. Etapa Secundaria (Fallback con Gemini 2.5 Flash Vision API):
 *    - Si la confianza del OCR local es baja o el formato es totalmente nuevo,
 *      envía la imagen/PDF a la API de Gemini 2.5 Flash (`gemini-2.5-flash`).
 *    - Fuerza una respuesta estructurada en JSON con los arreglos `accountsList` y `transactionsList`.
 *
 * 3. Soporte Multiproducto y Multicuenta + Sanitización Estricta:
 *    - Soporta cuentas individuales, listas de movimientos y resúmenes de productos por lote
 *      (ahorros, cheques, tarjetas de crédito con doble saldo HNL/USD y préstamos).
 *    - Sanitización estricta de montos numéricos eliminando comas de miles `,` antes de parsear
 *      (ej. `"3,901.33"` -> `3901.33`).
 *
 * 4. Reglas del Stack:
 *    - JavaScript Vanilla (ESNext) puro, cero llamadas a `console.log`.
 */

import {
  cleanAmount,
  cleanMobileUiText,
  isMobileUiNoiseLine,
  normalizeScanDateToIso,
  normalizeScanCurrency,
  normalizeAccountOrCardNumber,
  classifyTransactionType,
} from '../../../public/js/schemas/accountScan.js';
import {
  BANK_TEMPLATES_COLLECTION,
  BANK_TEMPLATES_LOCAL_STORE,
  normalizeTemplateCurrency,
  computeLayoutFingerprint,
  filterBankTemplatesByCountry,
  fetchBankTemplatesFromFirestore,
  getAllLocalBankTemplates,
  extractOfflineWithLearnedTemplates,
  buildFewShotPromptWithTemplates,
  learnBankTemplateFromConfirmation,
} from './templateLearner.js';
import {
  DEFAULT_USER_COUNTRY,
  normalizeUserCountryCode,
  getCountryRegionalConfig,
  getActiveUserCountry,
} from './user.js';
import { detectCountryTaxAndCurrency } from './bankTemplateMatcher.js';

export const GEMINI_VISION_MODEL = 'gemini-2.5-flash';
export const GEMINI_VISION_FALLBACK_MODEL = 'gemini-1.5-flash';
export const DEFAULT_OCR_CONFIDENCE_THRESHOLD = 65;

export const BANK_PRODUCT_TYPES = Object.freeze({
  SAVINGS: 'Ahorro',
  CHECKING: 'Cheques',
  CREDIT_CARD: 'Tarjeta de Crédito',
  LOAN: 'Préstamo',
});

/**
 * Sanitiza estrictamente un monto numérico eliminando comas de miles `,` y símbolos monetarios
 * para evitar recortar cifras (ej. de `"3,901.33"` a `3901.33`).
 *
 * @param {string|number|null|undefined} rawValue
 * @returns {number}
 */
export function sanitizeNumericAmount(rawValue) {
  return cleanAmount(rawValue);
}

/**
 * Devuelve la representación en cadena limpia sin comas de miles (ej. `"3,901.33"` -> `"3901.33"`).
 *
 * @param {string|number|null|undefined} rawValue
 * @returns {string}
 */
export function sanitizeNumericAmountString(rawValue) {
  const numeric = cleanAmount(rawValue);
  return numeric.toFixed(2);
}

/**
 * Clasifica el Tipo de Producto bancario en una de las 4 categorías canónicas:
 * `Ahorro`, `Cheques`, `Tarjeta de Crédito` o `Préstamo`.
 *
 * @param {string} rawTypeOrLine
 * @param {string} [accountNumber='']
 * @returns {{
 *   productType: 'Ahorro' | 'Cheques' | 'Tarjeta de Crédito' | 'Préstamo',
 *   productKey: 'savings' | 'checking' | 'credit_card' | 'loan',
 *   isCreditCard: boolean,
 *   isLoan: boolean
 * }}
 */
export function classifyBankProductType(rawTypeOrLine = '', accountNumber = '') {
  const combined = `${String(rawTypeOrLine || '')} ${String(accountNumber || '')}`.toLowerCase();
  const digits = String(accountNumber || '').replace(/\D+/g, '');

  if (
    /\b(?:pr[eé]stamo|prestamos|cr[eé]dito\s+hipotecario|cr[eé]dito\s+personal|cr[eé]dito\s+fiduciario|cr[eé]dito\s+veh[ií]culo|cr[eé]dito\s+automotriz|extrafinanciamiento|financiamiento|hipoteca|loan)\b/i.test(
      combined
    )
  ) {
    return {
      productType: BANK_PRODUCT_TYPES.LOAN,
      productKey: 'loan',
      isCreditCard: false,
      isLoan: true,
    };
  }

  if (
    /\b(?:tarjeta\s+de\s+cr[eé]dito|tarjetas\s+de\s+cr[eé]dito|tarjeta\s+personales|hn\s*-\s*tarjeta|american\s+express|amex|mastercard|mcard|visa|credomatic\s+card|cashback|lifemiles|blue\s+amex)\b/i.test(
      combined
    ) ||
    (digits.length === 4 && !/\b(?:cuenta|ahorro|cheque|pr[eé]stamo)\b/i.test(combined))
  ) {
    return {
      productType: BANK_PRODUCT_TYPES.CREDIT_CARD,
      productKey: 'credit_card',
      isCreditCard: true,
      isLoan: false,
    };
  }

  if (
    /\b(?:cheques?|cuenta\s+corriente|corriente|checking|negocio\s+lempiras|negocio\s+d[oó]lares|cuenta\s+de\s+cheques)\b/i.test(
      combined
    )
  ) {
    return {
      productType: BANK_PRODUCT_TYPES.CHECKING,
      productKey: 'checking',
      isCreditCard: false,
      isLoan: false,
    };
  }

  return {
    productType: BANK_PRODUCT_TYPES.SAVINGS,
    productKey: 'savings',
    isCreditCard: false,
    isLoan: false,
  };
}

export const HYBRID_ACCOUNT_ITEM_JSON_SCHEMA = Object.freeze({
  type: 'OBJECT',
  properties: {
    bankName: {
      type: 'STRING',
      description: 'Nombre del banco detectado (ej. "BAC Credomatic", "Banco Atlántida", "Banco Promerica", "Ficohsa", "Banpaís")',
    },
    accountNumber: {
      type: 'STRING',
      description: 'Número completo de cuenta/préstamo o últimos 4 dígitos en tarjeta de crédito',
    },
    accountType: {
      type: 'STRING',
      description: 'Nombre descriptivo del producto (ej. "CUENTA DE AHORRO SOS", "HN - CUENTA BANCARIA", "AMERICAN EXPRESS", "Préstamo Personal")',
    },
    productType: {
      type: 'STRING',
      enum: ['Ahorro', 'Cheques', 'Tarjeta de Crédito', 'Préstamo'],
      description: 'Clasificación canónica del producto: "Ahorro", "Cheques", "Tarjeta de Crédito" o "Préstamo"',
    },
    currency: {
      type: 'STRING',
      enum: ['HNL', 'USD'],
      description: 'Moneda en código ISO: "HNL" (Lempiras/LPS/L) o "USD" (Dólares/$)',
    },
    currentBalance: {
      type: 'NUMBER',
      description: 'Saldo o monto numérico Float sin comas de miles (ej. 3901.33)',
    },
    isCreditCard: {
      type: 'BOOLEAN',
      description: 'true si es Tarjeta de Crédito',
    },
    isLoan: {
      type: 'BOOLEAN',
      description: 'true si es Préstamo o Financiamiento',
    },
  },
  required: ['bankName', 'accountNumber', 'accountType', 'productType', 'currency', 'currentBalance'],
});

export const HYBRID_TRANSACTION_ITEM_JSON_SCHEMA = Object.freeze({
  type: 'OBJECT',
  properties: {
    date: {
      type: 'STRING',
      description: 'Fecha del movimiento en formato YYYY-MM-DD',
    },
    concept: {
      type: 'STRING',
      description: 'Descripción o concepto del movimiento bancario',
    },
    type: {
      type: 'STRING',
      enum: ['income', 'expense'],
      description: '"income" para créditos/depósitos; "expense" para débitos/retiros/compras',
    },
    amount: {
      type: 'NUMBER',
      description: 'Monto numérico Float sin comas de miles (ej. 200.00)',
    },
    currency: {
      type: 'STRING',
      enum: ['HNL', 'USD'],
      description: 'Moneda del movimiento ("HNL" o "USD")',
    },
  },
  required: ['date', 'concept', 'type', 'amount'],
});

export const HYBRID_EXTRACTOR_JSON_SCHEMA = Object.freeze({
  type: 'OBJECT',
  properties: {
    bankName: {
      type: 'STRING',
      description: 'Nombre del banco principal detectado en el documento',
    },
    accountsList: {
      type: 'ARRAY',
      description: 'Lista estructurada de cuentas bancarias, tarjetas de crédito (incluyendo doble saldo HNL/USD) y préstamos detectados',
      items: HYBRID_ACCOUNT_ITEM_JSON_SCHEMA,
    },
    transactionsList: {
      type: 'ARRAY',
      description: 'Lista estructurada de movimientos o transacciones detectadas en el estado de cuenta o captura',
      items: HYBRID_TRANSACTION_ITEM_JSON_SCHEMA,
    },
  },
  required: ['bankName', 'accountsList', 'transactionsList'],
});

export const HYBRID_EXTRACTOR_SYSTEM_PROMPT = [
  'Eres un motor experto de visión artificial financiera (Gemini 2.5 Flash Vision) especializado en extraer cuentas de ahorro, débito, cheques, tarjetas de crédito y préstamos de cualquier banco (BAC Credomatic, Banco Atlántida, Banco Promerica, Ficohsa, Banpaís, Davivienda, Banco de Occidente, Lafise, Banrural o cualquier institución).',
  '',
  'REGLAS ESTRICTAS DE SALIDA JSON (`accountsList` y `transactionsList` — EXTRACCIÓN COMPLETA DE N ELEMENTOS SIN LÍMITE):',
  '1. Devuelve SIEMPRE un JSON válido con los arreglos `accountsList` y `transactionsList`.',
  '2. PROCESA TODOS LOS BLOQUES PRESENTES EN LA IMAGEN O PDF SIN TRUNCAR AL LLEGAR A 2 ELEMENTOS:',
  '   - Continúa escaneando después de los encabezados "Cuentas personales", "Cuentas bancarias", "Tarjetas personales", "Tarjetas de crédito" y "Préstamos", agregando CADA fila o bloque encontrado al arreglo `accountsList`.',
  '   - Ejemplo de referencia (BAC Credomatic - 5 posiciones completas que DEBEN extraerse en su totalidad):',
  '     1) Cuenta bancaria `726935871` -> L 401.28 HNL',
  '     2) Cuenta bancaria `751666931` -> $ 3,705.95 USD',
  '     3) Negocio Lempiras `758886371` -> L 5,963.18 HNL',
  '     4) Tarjeta AMEX `3244` -> L 8,154.03 HNL (y $ 0.00 USD)',
  '     5) Tarjeta MCARD `0618` -> L 46,852.97 HNL (y $ 11.49 USD)',
  '3. Para cada producto en `accountsList`, extrae:',
  '   - `bankName`: Nombre del banco.',
  '   - `accountNumber`: Número de cuenta/préstamo completo o últimos 4 dígitos de la tarjeta.',
  '   - `accountType`: Nombre completo del producto.',
  '   - `productType`: Uno de ["Ahorro", "Cheques", "Tarjeta de Crédito", "Préstamo"].',
  '   - `currency`: "HNL" (si dice L, LPS, HNL, Lempiras) o "USD" (si dice $, US$, USD, Dólares).',
  '   - `currentBalance`: Número Float sanitizando obligatoriamente las comas de miles `,` (ej. "3,901.33" -> 3901.33).',
  '4. SOPORTE MULTIPRODUCTO Y DOBLE SALDO (HNL / USD):',
  '   - Si una tarjeta de crédito muestra saldo en Lempiras (HNL/LPS) y en Dólares (USD/$), extrae la tarjeta sin omitir ninguna fila después de "Tarjetas personales" o "Tarjetas de crédito".',
  '   - Si el resumen incluye préstamos ("Préstamo Personal", "Préstamo Hipotecario", "Financiamiento"), clasifícalos con `productType: "Préstamo"` e `isLoan: true`.',
  '5. Si existen movimientos o transacciones, devuélvelos en `transactionsList` con `date` (YYYY-MM-DD), `concept`, `type` ("income"|"expense") y `amount` (Float sin comas).',
].join('\n');

/**
 * Resuelve un nombre de banco a partir de una cadena individual sin mezclar pistas de contexto.
 * @param {string} text
 * @returns {string}
 */
function matchCanonicalBankFromString(text) {
  const lower = String(text ?? '').trim().toLowerCase();
  if (!lower) return '';

  if (lower.includes('atlantida') || lower.includes('atlántida')) return 'Banco Atlántida';
  if (/\bbac\b/.test(lower) || lower.includes('credomatic')) return 'BAC Credomatic';
  if (lower.includes('promerica')) return 'Banco Promerica';
  if (lower.includes('ficohsa')) return 'Banco Ficohsa';
  if (
    lower.includes('banpais') ||
    lower.includes('banpaís') ||
    lower.includes('banco del pais') ||
    lower.includes('banco del país')
  ) {
    return 'Banpaís (Banco del País)';
  }
  if (lower.includes('occidente')) return 'Banco de Occidente';
  if (lower.includes('davivienda')) return 'Davivienda';
  if (lower.includes('lafise')) return 'Banco Lafise';
  if (lower.includes('banrural')) return 'Banrural';
  if (lower.includes('banhcafe') || lower.includes('banhcafé')) {
    return 'Banco Hondureño del Café (Banhcafé)';
  }
  if (lower.includes('azteca')) return 'Banco Azteca';
  if (lower.includes('popular')) return 'Banco Popular';
  if (lower.includes('banhprovi')) return 'Banhprovi';

  if (lower.includes('industrial') || /\bbi\s+en\s+l[ií]nea\b/.test(lower)) {
    return 'Banco Industrial';
  }
  if (lower.includes('g&t') || lower.includes('continental')) {
    return 'Banco G&T Continental';
  }
  if (lower.includes('agricola') || lower.includes('agrícola')) {
    return 'Banco Agrícola';
  }
  if (lower.includes('general')) {
    return 'Banco General';
  }
  if (lower.includes('bbva')) {
    return 'BBVA México';
  }
  if (lower.includes('banorte')) {
    return 'Banorte';
  }

  return '';
}

/**
 * Normaliza el nombre del banco a su nombre canónico o conserva el nombre personalizado,
 * priorizando los bancos de la región seleccionada (`country`).
 *
 * @param {string} rawBank
 * @param {string} [contextHint='']
 * @param {string} [country='']
 * @returns {string}
 */
export function normalizeHybridBankName(rawBank, contextHint = '', country = '') {
  const raw = String(rawBank ?? '').trim();
  const hint = String(contextHint ?? '').trim();
  const targetCountry = normalizeUserCountryCode(country || DEFAULT_USER_COUNTRY);
  const regionalConfig = getCountryRegionalConfig(targetCountry);

  // 1. Si `raw` es un nombre de banco explícito de una sola línea, priorizarlo sin que `contextHint` lo sobreescriba
  if (raw && !/\r?\n/.test(raw) && raw !== hint) {
    const directCanonical = matchCanonicalBankFromString(raw);
    if (directCanonical) return directCanonical;

    const isLikelyBankOrEntityName =
      /\b(?:banco|cooperativa|financiera|billetera|credomatic|banpa[ií]s|ficohsa|davivienda|promerica|lafise|banrural|industrial|continental|banhcaf[eé]|banhprovi|azteca|popular|tigo\s+money|tenge|kash|paypal|efectivo)\b/i.test(
        raw
      );
    if (isLikelyBankOrEntityName) {
      return raw.replace(/\s+/g, ' ').trim();
    }
  }

  const combined = `${raw} ${hint}`.toLowerCase();

  // Priorización regional cuando `country === "HN"` (Atlántida, BAC, Ficohsa, Promerica, Banpaís)
  if (targetCountry === 'HN') {
    if (combined.includes('atlantida') || combined.includes('atlántida')) return 'Banco Atlántida';
    if (
      /\bbac\b/.test(combined) ||
      combined.includes('credomatic') ||
      combined.includes('cuentas personales') ||
      combined.includes('tarjetas personales') ||
      combined.includes('resumen de productos') ||
      /\bhn\s*-\s*(?:cuenta|negocio|tarjeta|american\s+express|mastercard|visa|pr[eé]stamo)/i.test(
        combined
      )
    ) {
      return 'BAC Credomatic';
    }
    if (combined.includes('ficohsa')) return 'Banco Ficohsa';
    if (combined.includes('promerica')) return 'Banco Promerica';
    if (
      combined.includes('banpais') ||
      combined.includes('banpaís') ||
      combined.includes('banco del pais') ||
      combined.includes('banco del país')
    ) {
      return 'Banpaís (Banco del País)';
    }
  }

  if (combined.includes('industrial') || /\bbi\s+en\s+l[ií]nea\b/.test(combined)) {
    return 'Banco Industrial';
  }
  if (combined.includes('banrural')) return 'Banrural';
  if (combined.includes('g&t') || combined.includes('continental')) return 'Banco G&T Continental';
  if (combined.includes('atlantida') || combined.includes('atlántida')) return 'Banco Atlántida';
  if (
    /\bbac\b/.test(combined) ||
    combined.includes('credomatic') ||
    combined.includes('cuentas personales') ||
    combined.includes('tarjetas personales') ||
    combined.includes('resumen de productos') ||
    /\bhn\s*-\s*(?:cuenta|negocio|tarjeta|american\s+express|mastercard|visa|pr[eé]stamo)/i.test(
      combined
    )
  ) {
    return 'BAC Credomatic';
  }
  if (combined.includes('promerica')) return 'Banco Promerica';
  if (combined.includes('ficohsa')) return 'Banco Ficohsa';
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
  if (combined.includes('lafise')) return 'Banco Lafise';

  if (raw && raw.length >= 3 && !/^\d+$/.test(raw) && !/\n/.test(raw)) {
    return raw.replace(/\s+/g, ' ').trim();
  }

  const customMatch = `${raw}\n${hint}`.match(
    /\b((?:Banco|Cooperativa|Financiera)\s+[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9 ]{2,30})/i
  );
  if (customMatch?.[1]) {
    return customMatch[1].replace(/\s+/g, ' ').trim();
  }

  return regionalConfig.priorityBanks?.[0] || 'Banco Atlántida';
}

/**
 * Normaliza un registro de cuenta/producto bancario garantizando sanitización numérica
 * y clasificación de `productType` (`Ahorro`, `Cheques`, `Tarjeta de Crédito`, `Préstamo`).
 *
 * @param {object} rawItem
 * @param {number} [index=0]
 * @param {string} [defaultBankName='']
 */
export function normalizeHybridAccountItem(rawItem = {}, index = 0, defaultBankName = '') {
  const rawType = String(
    rawItem?.accountType || rawItem?.productType || rawItem?.name || 'Cuenta de Ahorro'
  )
    .replace(/\s+/g, ' ')
    .trim();

  const classification = classifyBankProductType(
    `${rawType} ${rawItem?.productType || ''} ${rawItem?.isLoan ? 'Préstamo' : ''} ${rawItem?.isCreditCard ? 'Tarjeta de Crédito' : ''}`,
    rawItem?.accountNumber
  );

  const isCreditCard =
    typeof rawItem?.isCreditCard === 'boolean'
      ? rawItem.isCreditCard
      : classification.isCreditCard;
  const isLoan =
    typeof rawItem?.isLoan === 'boolean' ? rawItem.isLoan : classification.isLoan;

  const productType = isLoan
    ? BANK_PRODUCT_TYPES.LOAN
    : isCreditCard
      ? BANK_PRODUCT_TYPES.CREDIT_CARD
      : rawItem?.productType &&
          Object.values(BANK_PRODUCT_TYPES).includes(rawItem.productType)
        ? rawItem.productType
        : classification.productType;

  const accountNumber = normalizeAccountOrCardNumber(
    rawItem?.accountNumber ?? '',
    isCreditCard ? `Tarjeta de Crédito ${rawType}` : rawType
  );

  const targetCountry = normalizeUserCountryCode(rawItem?.country || DEFAULT_USER_COUNTRY);
  const regionalConfig = getCountryRegionalConfig(targetCountry);
  const currency = normalizeTemplateCurrency(
    rawItem?.currency || regionalConfig.currency || 'HNL',
    targetCountry
  );
  const currentBalance = sanitizeNumericAmount(
    rawItem?.currentBalance ?? rawItem?.balance ?? rawItem?.amount ?? 0
  );
  const bankName = normalizeHybridBankName(
    rawItem?.bankName || defaultBankName,
    rawType,
    targetCountry
  );
  const selected = rawItem?.selected !== undefined ? Boolean(rawItem.selected) : true;
  const status = /^inactiv/i.test(String(rawItem?.status || 'Activa'))
    ? 'Inactiva'
    : 'Activa';

  return {
    id: String(rawItem?.id || `hyb_acc_${index}_${accountNumber || index}_${currency}`),
    bankName,
    accountType: rawType || productType,
    productType,
    accountNumber,
    currency,
    country: targetCountry,
    currentBalance,
    isCreditCard,
    isLoan,
    status,
    selected,
    ...(rawItem?.dualBalances ? { dualBalances: rawItem.dualBalances } : {}),
  };
}

/**
 * Normaliza un movimiento/transacción garantizando sanitización estricta de montos.
 *
 * @param {object} rawTx
 * @param {number} [index=0]
 * @param {string} [defaultCurrency='HNL']
 * @param {string} [country='HN']
 */
export function normalizeHybridTransactionItem(
  rawTx = {},
  index = 0,
  defaultCurrency = 'HNL',
  country = 'HN'
) {
  const targetCountry = normalizeUserCountryCode(rawTx?.country || country || DEFAULT_USER_COUNTRY);
  const concept = String(rawTx?.concept || rawTx?.description || 'Movimiento bancario')
    .replace(/\s+/g, ' ')
    .trim();
  const amount = Math.abs(sanitizeNumericAmount(rawTx?.amount));
  const type = classifyTransactionType(rawTx?.type, concept);
  const date = normalizeScanDateToIso(rawTx?.date);
  const currency = normalizeTemplateCurrency(rawTx?.currency || defaultCurrency, targetCountry);
  const selected = rawTx?.selected !== undefined ? Boolean(rawTx.selected) : true;

  return {
    id: String(rawTx?.id || `hyb_tx_${index}_${Date.now().toString(36)}`),
    date,
    concept,
    type,
    amount,
    currency,
    country: targetCountry,
    selected,
  };
}

/**
 * Parsea facturas, recibos (vouchers POS) o comprobantes bancarios adaptando
 * el impuesto (`ISV` en HN, `IVA` en GT/SV/CR/NI/MX, `ITBMS` en PA), la moneda
 * (`HNL` / Lempiras para HN, `GTQ` / Quetzales para GT, etc.) y priorizando
 * los bancos de la región seleccionada.
 *
 * @param {string} rawText
 * @param {{ country?: string, storage?: Storage }} [options]
 */
export function parseRegionalInvoiceOrVoucher(rawText, options = {}) {
  const targetCountry = normalizeUserCountryCode(
    options.country || getActiveUserCountry({ storage: options.storage })
  );
  const taxAndCurrency = detectCountryTaxAndCurrency(rawText, targetCountry);
  const bankName = normalizeHybridBankName('', rawText, targetCountry);

  const totalMatch =
    String(rawText || '').match(
      /\b(?:total(?:\s+a\s+pagar|\s+factura|\s+recibo)?|monto(?:\s+total)?|importe\s+total)\s*[:|-]?\s*(?:LPS|HNL|GTQ|USD|US\$|\$|L\.?|Q\.?|C\$|₡)?\s*(\d{1,3}(?:,\d{3})+\.\d{2}|\d{1,9}\.\d{2})/i
    ) ||
    String(rawText || '').match(
      /(?:LPS|HNL|GTQ|USD|US\$|\$|L\.?|Q\.?|C\$|₡)\s*(\d{1,3}(?:,\d{3})+\.\d{2}|\d{1,9}\.\d{2})/i
    );

  const totalAmount = totalMatch ? sanitizeNumericAmount(totalMatch[1]) : 0;
  const subtotalMatch = String(rawText || '').match(
    /(?:subtotal|importe\s+gravado|base\s+imponible)\s*[:|-]?\s*(?:LPS|HNL|GTQ|USD|US\$|\$|L\.?|Q\.?|C\$|₡)?\s*(\d{1,3}(?:,\d{3})+\.\d{2}|\d{1,9}\.\d{2})/i
  );
  const subtotalAmount = subtotalMatch
    ? sanitizeNumericAmount(subtotalMatch[1])
    : totalAmount > 0 && taxAndCurrency.taxAmount > 0
      ? Number((totalAmount - taxAndCurrency.taxAmount).toFixed(2))
      : totalAmount;

  return {
    country: targetCountry,
    bankName,
    currency: taxAndCurrency.currency,
    currencySymbol: taxAndCurrency.currencySymbol,
    taxType: taxAndCurrency.taxType,
    taxLabel: taxAndCurrency.taxLabel,
    taxRate: taxAndCurrency.taxRate,
    taxAmount: taxAndCurrency.taxAmount,
    subtotalAmount,
    totalAmount,
  };
}

/**
 * Estima la confianza (0..100) del texto OCR extraído localmente por Tesseract.js.
 *
 * @param {string} text
 * @param {number|null|undefined} rawConfidence
 * @returns {number}
 */
export function computeOcrTextConfidence(text, rawConfidence = null) {
  const cleaned = String(text || '').trim();
  if (!cleaned) return 0;

  if (typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)) {
    return Math.max(0, Math.min(100, Math.round(rawConfidence)));
  }

  let score = 40;
  if (cleaned.length >= 25) score += 15;
  if (/\b\d{4,20}\b/.test(cleaned)) score += 15;
  if (/(?:^|[^\w])(?:LPS|HNL|USD|US\$|\$|L\.?)\b/i.test(cleaned)) score += 15;
  if (/\d{1,3}(?:,\d{3})*\.\d{2}/.test(cleaned)) score += 15;

  return Math.min(98, score);
}

/**
 * Ejecuta la Etapa Primaria de extracción de texto OCR local con Tesseract.js (y PDF.js si es PDF).
 * Soporta inyección de `ocrReader`, `tesseractWorker`, `globalThis.Tesseract` o carga dinámica WASM.
 *
 * @param {File | Blob | string | object} fileOrDataUrl
 * @param {{
 *   ocrTextFallback?: string,
 *   ocrFallbackText?: string,
 *   ocrConfidence?: number,
 *   ocrReader?: Function,
 *   tesseractWorker?: { recognize: Function },
 *   onProgress?: (status: string, progress?: number) => void
 * }} [options]
 * @returns {Promise<{ text: string, confidence: number, engine: string }>}
 */
export async function runTesseractLocalOcr(fileOrDataUrl, options = {}) {
  const explicitText = String(
    options.ocrTextFallback ||
      options.ocrFallbackText ||
      fileOrDataUrl?.extractedText ||
      fileOrDataUrl?.ocrText ||
      ''
  ).trim();

  if (explicitText) {
    return {
      text: explicitText,
      confidence: computeOcrTextConfidence(explicitText, options.ocrConfidence),
      engine: 'tesseract-local-text',
    };
  }

  if (typeof options.ocrReader === 'function') {
    try {
      const res = await options.ocrReader(fileOrDataUrl);
      if (res && typeof res === 'object' && 'text' in res) {
        const text = String(res.text || '').trim();
        return {
          text,
          confidence: computeOcrTextConfidence(text, res.confidence ?? options.ocrConfidence),
          engine: 'tesseract-custom-reader',
        };
      }
      if (typeof res === 'string' && res.trim()) {
        const text = res.trim();
        return {
          text,
          confidence: computeOcrTextConfidence(text, options.ocrConfidence),
          engine: 'tesseract-custom-reader',
        };
      }
    } catch {
      // Fallback a worker o globalThis.Tesseract
    }
  }

  if (options.tesseractWorker && typeof options.tesseractWorker.recognize === 'function') {
    try {
      const result = await options.tesseractWorker.recognize(fileOrDataUrl);
      const text = String(result?.data?.text || result?.text || '').trim();
      const rawConf = result?.data?.confidence ?? result?.confidence ?? options.ocrConfidence;
      return {
        text,
        confidence: computeOcrTextConfidence(text, rawConf),
        engine: 'tesseract-worker',
      };
    } catch {
      // Continúa al siguiente método
    }
  }

  if (
    typeof globalThis !== 'undefined' &&
    globalThis.Tesseract &&
    typeof globalThis.Tesseract.recognize === 'function'
  ) {
    try {
      const result = await globalThis.Tesseract.recognize(fileOrDataUrl, 'spa+eng');
      const text = String(result?.data?.text || '').trim();
      const rawConf = result?.data?.confidence ?? options.ocrConfidence;
      return {
        text,
        confidence: computeOcrTextConfidence(text, rawConf),
        engine: 'tesseract-global',
      };
    } catch {
      // Continúa a importación dinámica en navegador
    }
  }

  // En navegador: importar dinámicamente PDF.js (si es PDF) o Tesseract.js v5
  const isBrowserRuntime = typeof window !== 'undefined' && typeof document !== 'undefined';
  if (isBrowserRuntime && fileOrDataUrl) {
    const isPdf =
      fileOrDataUrl?.type === 'application/pdf' ||
      /\.pdf$/i.test(String(fileOrDataUrl?.name || '')) ||
      (typeof fileOrDataUrl === 'string' &&
        fileOrDataUrl.trim().startsWith('data:application/pdf'));

    if (isPdf && typeof fileOrDataUrl?.arrayBuffer === 'function') {
      try {
        options.onProgress?.('Extrayendo texto de PDF con PDF.js...', 25);
        const pdfjsLib = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/+esm');
        pdfjsLib.GlobalWorkerOptions.workerSrc =
          'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs';
        const arrayBuffer = await fileOrDataUrl.arrayBuffer();
        const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const pageTexts = [];
        const maxPages = Math.min(pdfDoc.numPages || 1, 5);
        for (let p = 1; p <= maxPages; p += 1) {
          const page = await pdfDoc.getPage(p);
          const content = await page.getTextContent();
          const lineStr = (content.items || []).map((it) => it.str).join(' ');
          if (lineStr.trim()) pageTexts.push(lineStr.trim());
        }
        const joinedPdfText = pageTexts.join('\n').trim();
        if (joinedPdfText.length >= 15) {
          return {
            text: joinedPdfText,
            confidence: computeOcrTextConfidence(joinedPdfText, 92),
            engine: 'pdfjs-local',
          };
        }
      } catch {
        // Fallback a Tesseract WASM
      }
    }

    try {
      options.onProgress?.('Ejecutando OCR local con Tesseract.js...', 40);
      const TesseractModule = await import(
        'https://cdn.jsdelivr.net/npm/tesseract.js@5/+esm'
      );
      const Tesseract = TesseractModule.default || TesseractModule;
      const worker = await Tesseract.createWorker('spa+eng', 1);
      try {
        const recognition = await worker.recognize(fileOrDataUrl);
        const text = String(recognition?.data?.text || '').trim();
        const rawConf = recognition?.data?.confidence;
        return {
          text,
          confidence: computeOcrTextConfidence(text, rawConf),
          engine: 'tesseract-wasm',
        };
      } finally {
        await worker.terminate();
      }
    } catch {
      // Sin red para CDN o entorno restringido
    }
  }

  return {
    text: '',
    confidence: 0,
    engine: 'none',
  };
}

/**
 * Extrae cuentas multiproducto (Ahorro, Cheques, Tarjetas de Crédito con doble saldo HNL/USD y Préstamos)
 * y transacciones (`transactionsList`) a partir de texto OCR sin truncar ningún bloque.
 *
 * @param {string} rawText
 * @param {{ defaultBankName?: string, expandDualCurrencyCards?: boolean }} [options]
 * @returns {{
 *   bankName: string,
 *   accountsList: Array<object>,
 *   transactionsList: Array<object>
 * }}
 */
export function parseMultiProductBankText(rawText, options = {}) {
  const expandDual = Boolean(options.expandDualCurrencyCards);
  const targetCountry = normalizeUserCountryCode(
    options.country || getActiveUserCountry({ storage: options.storage })
  );
  const regionalConfig = getCountryRegionalConfig(targetCountry);
  const cleanedText = cleanMobileUiText(String(rawText || ''));
  const lines = cleanedText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !isMobileUiNoiseLine(l));

  const bankName = normalizeHybridBankName(
    options.defaultBankName || cleanedText,
    cleanedText,
    targetCountry
  );

  const accountsList = [];
  const seenKeys = new Set();
  let currentSection = '';

  const amountPattern =
    /(?:(LPS|HNL|GTQ|NIO|CRC|MXN|USD|US\$|\$|L\.?|Q\.?|C\$|₡)\s*(\d{1,3}(?:,\d{3})+\.\d{2}|\d{1,9}\.\d{2})(?:\s*(?:LPS|HNL|GTQ|NIO|CRC|MXN|USD))?|(\d{1,3}(?:,\d{3})+\.\d{2}|\d{1,9}\.\d{2})\s*(LPS|HNL|GTQ|NIO|CRC|MXN|USD|US\$|\$|L\.?|Q\.?|C\$|₡))/gi;

  const extractAmountsFromStr = (str) =>
    [...String(str || '').matchAll(amountPattern)].map((m) => ({
      rawMatch: m[0],
      currency: normalizeTemplateCurrency(m[1] || m[4], targetCountry),
      balance: sanitizeNumericAmount(m[2] || m[3]),
    }));

  const addAccountEntry = (rawEntry) => {
    const norm = normalizeHybridAccountItem(
      { ...rawEntry, country: targetCountry },
      accountsList.length,
      bankName
    );
    const key = `${norm.accountNumber}::${norm.currency}::${norm.productType}::${norm.currentBalance}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      accountsList.push(norm);
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    // Limpiar numeración de lista inicial como "1) " o "2. " para no confundirla con número de cuenta
    const line = rawLine.replace(/^\d+\s*[).]\s*/, '').trim();

    // Ignorar filas de totales de resumen
    if (/^total(?:es)?\s+(?:cuentas|tarjetas|pr[eé]stamos|en)\b/i.test(line)) {
      continue;
    }

    // Detectar encabezados de sección ("Tarjetas personales", "Tarjetas de crédito", "Cuentas personales", etc.)
    if (/^tarjetas?\s+(?:de\s+cr[eé]dito|personales)\b/i.test(line)) {
      currentSection = 'Tarjeta de Crédito';
      continue;
    }
    if (/^pr[eé]stamos?\b|^financiamientos?\b/i.test(line)) {
      currentSection = 'Préstamo';
      continue;
    }
    if (/^cuentas?\s+(?:bancarias|personales|de\s+ahorro|de\s+cheques)\b/i.test(line)) {
      currentSection = 'Ahorro';
      continue;
    }

    // Saltar filas que inician con una fecha de transacción (DD/MM/YYYY o YYYY-MM-DD)
    if (/^(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|20\d{2}-\d{2}-\d{2})\b/.test(line)) {
      continue;
    }

    // Extraer todos los pares (moneda, monto) presentes en la línea
    let amountMatches = extractAmountsFromStr(line);
    if (amountMatches.length === 0) continue;

    // Buscar número de cuenta, préstamo o tarjeta enmascarada en la línea o líneas adyacentes
    let textWithoutAmounts = line;
    for (const am of amountMatches) {
      textWithoutAmounts = textWithoutAmounts.replace(am.rawMatch, ' ');
    }

    const prevLine = i > 0 ? lines[i - 1].replace(/^\d+\s*[).]\s*/, '').trim() : '';
    const prevPrevLine = i > 1 ? lines[i - 2].replace(/^\d+\s*[).]\s*/, '').trim() : '';
    const nextLine = i + 1 < lines.length ? lines[i + 1].replace(/^\d+\s*[).]\s*/, '').trim() : '';

    const lineMaskedCardMatch =
      textWithoutAmounts.match(/\d{4}-\d{2}[*X•]{2}-[*X•]{4}-(\d{4})/) ||
      textWithoutAmounts.match(
        /(?:(?:AMEX|MCARD|MASTERCARD|VISA|AMERICAN\s+EXPRESS)\s*(?:[*X•.°+-]+\s*-?\s*|-\s*|\s+)(\d{4})\b(?!-[\d*X•])|[*X•]{2,4}-?(\d{4})\b)/i
      );
    const lineAccountNumMatch =
      textWithoutAmounts.match(/(?:N\.?°?\s*|No\.?\s*|#\s*|`)(\d[\d-]{3,20}\d)`?\b/i) ||
      textWithoutAmounts.match(/\b(\d{6,20})\b/) ||
      textWithoutAmounts.match(/\b(\d{4})\b(?!-[\d*X•])/);

    let resolvedNumber = lineMaskedCardMatch
      ? lineMaskedCardMatch[1] || lineMaskedCardMatch[2]
      : lineAccountNumMatch
        ? String(lineAccountNumMatch[1] || '').replace(/-/g, '').trim()
        : '';

    let consumedNextLine = false;
    let nextLineBrand = '';

    // Si la línea actual tiene el monto (ej. "HN - Tarjeta L8,154.03") pero el número/marca está en `nextLine`
    // (ej. "AMEX ****-3244 $0.00" o "MCARD ****-0618 $11.49"), fusionar el bloque de 2 líneas
    if (!resolvedNumber && nextLine) {
      const nextAmounts = extractAmountsFromStr(nextLine);
      let nextWithoutAmounts = nextLine;
      for (const nam of nextAmounts) {
        nextWithoutAmounts = nextWithoutAmounts.replace(nam.rawMatch, ' ');
      }
      const nextCardMatch = nextWithoutAmounts.match(
        /(?:\b(AMEX|MCARD|MASTERCARD|VISA|AMERICAN\s+EXPRESS)\s*(?:\d{4}-\d{2}[*X•]{2}-[*X•]{4}-|[*X•.°+-]+\s*-?\s*|-\s*|\s+)(\d{4})\b(?!-[\d*X•])|(?:\d{4}-\d{2}[*X•]{2}-[*X•]{4}-|[*X•]{2,4}-?)(\d{4})\b)/i
      );
      if (nextCardMatch) {
        resolvedNumber = nextCardMatch[2] || nextCardMatch[3] || '';
        nextLineBrand = nextCardMatch[1] || '';
        amountMatches = [...amountMatches, ...nextAmounts];
        consumedNextLine = true;
      }
    }

    if (!resolvedNumber) {
      const prevMaskedMatch =
        prevLine.match(/\d{4}-\d{2}[*X•]{2}-[*X•]{4}-(\d{4})/) ||
        prevLine.match(
          /(?:(?:AMEX|MCARD|MASTERCARD|VISA|AMERICAN\s+EXPRESS)\s*(?:[*X•.°+-]+\s*-?\s*|-\s*|\s+)(\d{4})\b(?!-[\d*X•])|[*X•]{2,4}-?(\d{4})\b)/i
        );
      const prevAccMatch =
        prevLine.match(/(?:N\.?°?\s*|No\.?\s*|#\s*)(\d[\d-]{3,20}\d)\b/i) ||
        prevLine.match(/\b(\d{6,20})\b/);

      resolvedNumber = prevMaskedMatch
        ? prevMaskedMatch[1] || prevMaskedMatch[2]
        : prevAccMatch
          ? String(prevAccMatch[1] || '').replace(/-/g, '').trim()
          : '';
    }

    if (!resolvedNumber) continue;

    let labelCandidate = textWithoutAmounts
      .replace(/\d{4}-\d{2}[*X•]{2}-[*X•]{4}-\d{4}/g, ' ')
      .replace(/[*X•]{2,4}-?\d{4}/g, ' ')
      .replace(/`\d{4,20}`/g, ' ')
      .replace(/\b\d{4,20}\b/g, ' ')
      .replace(/\(\s*y\s*\)/gi, ' ')
      .replace(/->/g, ' ')
      .replace(/\b(?:saldo|disponible|actual|balance|n\.?°?|no\.?|moneda|total)\b\s*[:|-]?/gi, ' ')
      .replace(/[|•:;()]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (nextLineBrand && /HN\s*-\s*Tarjeta/i.test(labelCandidate)) {
      labelCandidate = `${labelCandidate} (${nextLineBrand.toUpperCase()})`;
    }

    if (!labelCandidate || labelCandidate.length < 3) {
      const cleanPrev = prevLine
        .replace(/\b\d{4,20}\b/g, ' ')
        .replace(/[|•:;/]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (cleanPrev.length >= 3 && !/^(?:resumen|banca|productos|estado|cuentas|tarjetas)/i.test(cleanPrev)) {
        labelCandidate = cleanPrev;
      } else if (prevPrevLine) {
        const cleanPrevPrev = prevPrevLine
          .replace(/\b\d{4,20}\b/g, ' ')
          .replace(/[|•:;/]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (
          cleanPrevPrev.length >= 3 &&
          !/^(?:resumen|banca|productos|estado|cuentas|tarjetas|buenas)/i.test(cleanPrevPrev)
        ) {
          labelCandidate = cleanPrevPrev;
        }
      }
    }

    const classification = classifyBankProductType(
      `${currentSection} ${labelCandidate} ${line} ${nextLineBrand}`,
      resolvedNumber
    );

    const finalLabel =
      labelCandidate && labelCandidate.length >= 3
        ? labelCandidate
        : classification.productType;

    const dualBalances = {};
    for (const a of amountMatches) {
      dualBalances[a.currency] = a.balance;
    }

    // Verificar si se solicitó expandir tarjetas con doble saldo HNL y USD (> 0 en ambas monedas)
    const nonZeroAmounts = amountMatches.filter((a) => a.balance > 0);
    const hasDualCurrencies =
      expandDual &&
      classification.isCreditCard &&
      nonZeroAmounts.length >= 2 &&
      new Set(nonZeroAmounts.map((a) => a.currency)).size >= 2;

    if (hasDualCurrencies) {
      for (const a of nonZeroAmounts) {
        addAccountEntry({
          bankName,
          accountType: finalLabel,
          productType: classification.productType,
          accountNumber: resolvedNumber,
          currency: a.currency,
          currentBalance: a.balance,
          isCreditCard: true,
          isLoan: false,
          dualBalances,
        });
      }
    } else {
      const chosen = nonZeroAmounts[0] || amountMatches[0];
      addAccountEntry({
        bankName,
        accountType: finalLabel,
        productType: classification.productType,
        accountNumber: resolvedNumber,
        currency: chosen.currency,
        currentBalance: chosen.balance,
        isCreditCard: classification.isCreditCard,
        isLoan: classification.isLoan,
        ...(Object.keys(dualBalances).length > 1 ? { dualBalances } : {}),
      });
    }

    if (consumedNextLine) {
      i += 1;
    }
  }

  // Extraer lista de movimientos / transacciones (`transactionsList`)
  const transactionsList = [];
  const txRegex =
    /(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|20\d{2}-\d{2}-\d{2})\s+([\s\S]+?)\s+(?:(Cr[eé]dito|D[eé]bito|Abono|Cargo|Dep[oó]sito|Retiro)\s+)?(?:(LPS|HNL|USD|US\$|\$|L\.?)\s*)?(\d{1,3}(?:,\d{3})+\.\d{2}|\d{1,9}\.\d{2})/gi;

  let txMatch;
  while ((txMatch = txRegex.exec(cleanedText)) !== null) {
    const rawDate = txMatch[1];
    const rawConcept = txMatch[2]
      .replace(/\r?\n/g, ' ')
      .replace(/\b(?:Cr[eé]dito|D[eé]bito|Abono|Cargo)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    const rawTypeHint = txMatch[3] || '';
    const rawCur = txMatch[4] || accountsList[0]?.currency || regionalConfig.currency || 'HNL';
    const rawAmt = txMatch[5];

    const amount = sanitizeNumericAmount(rawAmt);
    if (amount > 0 && rawConcept && !isMobileUiNoiseLine(rawConcept)) {
      transactionsList.push(
        normalizeHybridTransactionItem(
          {
            date: rawDate,
            concept: rawConcept,
            type: classifyTransactionType(rawTypeHint, rawConcept),
            amount,
            currency: rawCur,
            country: targetCountry,
            selected: true,
          },
          transactionsList.length,
          accountsList[0]?.currency || regionalConfig.currency || 'HNL',
          targetCountry
        )
      );
    }
  }

  return {
    country: targetCountry,
    bankName: accountsList[0]?.bankName || bankName,
    accountsList,
    transactionsList,
    taxMetadata: detectCountryTaxAndCurrency(cleanedText, targetCountry),
  };
}

/**
 * Convierte un archivo (`File` / `Blob`) o Data URL a `{ base64Data, mimeType, dataUrl, isPdf }`.
 *
 * @param {File | Blob | string} fileOrDataUrl
 */
async function encodeMediaForGeminiVision(fileOrDataUrl) {
  if (typeof fileOrDataUrl === 'string') {
    const trimmed = fileOrDataUrl.trim();
    const match = trimmed.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      return {
        mimeType: match[1],
        base64Data: match[2],
        dataUrl: trimmed,
        isPdf: match[1] === 'application/pdf',
      };
    }
    return {
      mimeType: 'image/png',
      base64Data: trimmed,
      dataUrl: `data:image/png;base64,${trimmed}`,
      isPdf: false,
    };
  }

  if (!fileOrDataUrl || typeof fileOrDataUrl !== 'object') {
    return {
      mimeType: 'image/png',
      base64Data: '',
      dataUrl: '',
      isPdf: false,
    };
  }

  const fileName = String(fileOrDataUrl.name || '');
  const isPdf =
    fileOrDataUrl.type === 'application/pdf' || /\.pdf$/i.test(fileName);
  const mimeType = isPdf
    ? 'application/pdf'
    : fileOrDataUrl.type || 'image/png';

  if (typeof FileReader !== 'undefined' && typeof Blob !== 'undefined' && fileOrDataUrl instanceof Blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || '');
        const base64Data = dataUrl.replace(/^data:[^;]+;base64,/, '');
        resolve({ base64Data, mimeType, dataUrl, isPdf });
      };
      reader.onerror = () => reject(new Error('No se pudo codificar el archivo.'));
      reader.readAsDataURL(fileOrDataUrl);
    });
  }

  if (typeof fileOrDataUrl.arrayBuffer === 'function') {
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

  return {
    mimeType,
    base64Data: String(fileOrDataUrl.base64Data || ''),
    dataUrl: '',
    isPdf,
  };
}

/**
 * Etapa Secundaria (Fallback con Gemini 2.5 Flash Vision API):
 * Envía la imagen o PDF a Gemini 2.5 Flash forzando una respuesta estructurada en JSON
 * con los arreglos `accountsList` y `transactionsList`.
 *
 * @param {File | Blob | string | object} fileOrDataUrl
 * @param {{
 *   apiKey?: string,
 *   fetchImpl?: typeof fetch,
 *   ocrText?: string,
 *   bankTemplates?: Array<object>,
 *   model?: string
 * }} [options]
 */
export async function invokeGemini25FlashFallback(fileOrDataUrl, options = {}) {
  const fetchFn =
    options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchFn) {
    return null;
  }

  const { base64Data, mimeType } = await encodeMediaForGeminiVision(fileOrDataUrl);
  const apiKey = String(options.apiKey || '').trim();
  const model = String(options.model || GEMINI_VISION_MODEL).trim() || GEMINI_VISION_MODEL;
  const templates = Array.isArray(options.bankTemplates) ? options.bankTemplates : [];
  const promptWithTemplates = buildFewShotPromptWithTemplates(
    HYBRID_EXTRACTOR_SYSTEM_PROMPT,
    templates
  );

  // 1. Llamada directa a Gemini 2.5 Flash API si hay API Key disponible
  if (apiKey && base64Data) {
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const response = await fetchFn(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: promptWithTemplates },
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
            responseSchema: HYBRID_EXTRACTOR_JSON_SCHEMA,
          },
        }),
      });

      if (response.ok) {
        const payload = await response.json();
        const rawJson = payload?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (rawJson) {
          const parsed = JSON.parse(rawJson);
          return {
            parsed,
            source: model,
            promptUsed: promptWithTemplates,
          };
        }
      }
    } catch {
      // Fallback al endpoint del servidor `/api/ai/scan-account`
    }
  }

  // 2. Llamada al endpoint del proyecto `/api/ai/scan-account`
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers['x-gemini-api-key'] = apiKey;
    }
    const res = await fetchFn('/api/ai/scan-account', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        imageBase64: base64Data,
        mimeType,
        ocrTextFallback: options.ocrText || '',
        fewShotPrompt: promptWithTemplates,
        bankTemplates: templates,
        apiKey: apiKey || undefined,
      }),
    });
    if (res.ok) {
      const body = await res.json();
      if (body?.ok && body?.data) {
        return {
          parsed: body.data,
          source: body.source || `genkit:${model}`,
          promptUsed: promptWithTemplates,
        };
      }
    }
  } catch {
    // Fallback local si no hay red
  }

  return null;
}

/**
 * Motor Principal de Procesamiento Híbrido (`extractBankDataHybrid`):
 *
 * - Etapa Primaria (Motor Local Open-Source):
 *   1. Ejecuta Tesseract.js localmente en el navegador (costo de API $0, Local-First).
 *   2. Compara el texto extraído contra los patrones almacenados en `bank_templates` (IndexedDB / Firestore).
 *   3. Si la confianza es suficiente y coincide con un formato conocido en `bank_templates`,
 *      devuelve `accountsList` y `transactionsList` de inmediato sin consumir API.
 *
 * - Etapa Secundaria (Fallback con Gemini 2.5 Flash Vision API):
 *   1. Si la confianza del OCR local es baja (`< confidenceThreshold`) o el formato es totalmente nuevo,
 *      envía la imagen/PDF a la API de Gemini 2.5 Flash (`gemini-2.5-flash`).
 *   2. Fuerza una respuesta estructurada en JSON con `accountsList` y `transactionsList`.
 *
 * @param {File | Blob | string | object} fileOrDataUrl
 * @param {{
 *   apiKey?: string,
 *   ocrTextFallback?: string,
 *   ocrFallbackText?: string,
 *   ocrConfidence?: number,
 *   confidenceThreshold?: number,
 *   ocrReader?: Function,
 *   tesseractWorker?: { recognize: Function },
 *   fetchImpl?: typeof fetch,
 *   storage?: Storage,
 *   indexedDb?: IDBFactory,
 *   firestoreDb?: any,
 *   firestoreModule?: any,
 *   templates?: Array<object>,
 *   expandDualCurrencyCards?: boolean,
 *   offline?: boolean,
 *   onProgress?: (status: string, progress?: number) => void
 * }} [options]
 */
export async function extractBankDataHybrid(fileOrDataUrl, options = {}) {
  const confidenceThreshold =
    typeof options.confidenceThreshold === 'number'
      ? options.confidenceThreshold
      : DEFAULT_OCR_CONFIDENCE_THRESHOLD;
  const targetCountry = normalizeUserCountryCode(
    options.country || getActiveUserCountry({ storage: options.storage })
  );
  const regionalConfig = getCountryRegionalConfig(targetCountry);

  // Cargar plantillas desde `bank_templates` filtradas por el `country` del usuario
  const bankTemplates =
    Array.isArray(options.templates) && options.templates.length > 0
      ? filterBankTemplatesByCountry(options.templates, targetCountry, {
          strictCountryOnly: Boolean(options.strictCountryOnly),
        })
      : await fetchBankTemplatesFromFirestore({
          firestoreDb: options.firestoreDb,
          firestoreModule: options.firestoreModule,
          indexedDb: options.indexedDb,
          storage: options.storage,
          country: targetCountry,
          strictCountryOnly: Boolean(options.strictCountryOnly),
        });

  // =========================================================================
  // ETAPA PRIMARIA: Motor Local Open-Source (Tesseract.js + `bank_templates`)
  // =========================================================================
  const localOcr = await runTesseractLocalOcr(fileOrDataUrl, options);
  const ocrText = localOcr.text;
  const ocrConfidence = localOcr.confidence;

  if (ocrText && ocrConfidence >= confidenceThreshold) {
    const templateMatch = await extractOfflineWithLearnedTemplates(ocrText, {
      indexedDb: options.indexedDb,
      storage: options.storage,
      templates: bankTemplates,
      country: targetCountry,
      strictCountryOnly: Boolean(options.strictCountryOnly),
    });

    if (templateMatch.matched && templateMatch.accountsList.length > 0) {
      let rawAccounts = templateMatch.accountsList;

      // Si el texto contiene tarjetas con doble saldo HNL/USD (>0 en ambas monedas) o préstamos adicionales,
      // enriquecer con el parser multiproducto cuando `expandDualCurrencyCards` está activo
      if (options.expandDualCurrencyCards === true) {
        const multiParsed = parseMultiProductBankText(ocrText, {
          defaultBankName: templateMatch.bankName,
          expandDualCurrencyCards: true,
          country: targetCountry,
        });
        if (multiParsed.accountsList.length > rawAccounts.length) {
          rawAccounts = multiParsed.accountsList;
        }
      }

      const normalizedAccounts = rawAccounts.map((acc, idx) =>
        normalizeHybridAccountItem(
          { ...acc, country: targetCountry },
          idx,
          templateMatch.bankName
        )
      );
      const normalizedTransactions = (templateMatch.detectedTransactions || []).map(
        (tx, idx) =>
          normalizeHybridTransactionItem(
            tx,
            idx,
            normalizedAccounts[0]?.currency || regionalConfig.currency || 'HNL',
            targetCountry
          )
      );

      const primary = normalizedAccounts[0];
      const taxMetadata = detectCountryTaxAndCurrency(ocrText, targetCountry);
      return {
        stage: 'primary-local-ocr',
        usedGeminiFallback: false,
        apiCost: 0,
        country: targetCountry,
        taxMetadata,
        ocrConfidence,
        ocrText,
        matchedTemplate: templateMatch.template,
        source: `local-tesseract:${templateMatch.template.bankId}`,
        bankName: primary.bankName,
        accountType: primary.accountType,
        productType: primary.productType,
        accountNumber: primary.accountNumber,
        currency: primary.currency,
        currentBalance: primary.currentBalance,
        isCreditCard: primary.isCreditCard,
        isLoan: primary.isLoan,
        status: primary.status,
        accountsList: normalizedAccounts,
        accounts: normalizedAccounts,
        accountsArray: normalizedAccounts,
        transactionsList: normalizedTransactions,
        detectedTransactions: normalizedTransactions,
      };
    }
  }

  // =========================================================================
  // ETAPA SECUNDARIA: Fallback con Gemini 2.5 Flash Vision API
  // (Se activa cuando la confianza del OCR local es baja o el formato es nuevo)
  // =========================================================================
  const isOffline =
    options.offline === true ||
    (typeof navigator !== 'undefined' && navigator.onLine === false);

  if (!isOffline) {
    const geminiResult = await invokeGemini25FlashFallback(fileOrDataUrl, {
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl,
      ocrText,
      bankTemplates,
      model: options.model || GEMINI_VISION_MODEL,
    });

    if (geminiResult?.parsed) {
      const raw = geminiResult.parsed;
      const rawAccounts =
        Array.isArray(raw.accountsList) && raw.accountsList.length > 0
          ? raw.accountsList
          : Array.isArray(raw.accounts) && raw.accounts.length > 0
            ? raw.accounts
            : Array.isArray(raw.accountsArray) && raw.accountsArray.length > 0
              ? raw.accountsArray
              : raw.accountNumber || raw.currentBalance !== undefined
                ? [raw]
                : [];

      const rawTransactions =
        Array.isArray(raw.transactionsList) && raw.transactionsList.length > 0
          ? raw.transactionsList
          : Array.isArray(raw.detectedTransactions) && raw.detectedTransactions.length > 0
            ? raw.detectedTransactions
            : Array.isArray(raw.transactions)
              ? raw.transactions
              : [];

      const defaultBank = normalizeHybridBankName(
        raw.bankName ||
          rawAccounts[0]?.bankName ||
          regionalConfig.priorityBanks?.[0] ||
          'Banco Atlántida',
        ocrText,
        targetCountry
      );

      const normalizedAccounts = rawAccounts.map((acc, idx) =>
        normalizeHybridAccountItem(
          { ...acc, country: targetCountry },
          idx,
          defaultBank
        )
      );
      const normalizedTransactions = rawTransactions.map((tx, idx) =>
        normalizeHybridTransactionItem(
          tx,
          idx,
          normalizedAccounts[0]?.currency || regionalConfig.currency || 'HNL',
          targetCountry
        )
      );

      if (normalizedAccounts.length > 0) {
        const primary = normalizedAccounts[0];
        const taxMetadata = detectCountryTaxAndCurrency(ocrText, targetCountry);
        return {
          stage: 'secondary-gemini-vision',
          usedGeminiFallback: true,
          apiCost: 1,
          country: targetCountry,
          taxMetadata,
          ocrConfidence,
          ocrText,
          matchedTemplate: null,
          source: geminiResult.source || GEMINI_VISION_MODEL,
          fewShotPromptUsed: geminiResult.promptUsed,
          bankName: primary.bankName,
          accountType: primary.accountType,
          productType: primary.productType,
          accountNumber: primary.accountNumber,
          currency: primary.currency,
          currentBalance: primary.currentBalance,
          isCreditCard: primary.isCreditCard,
          isLoan: primary.isLoan,
          status: primary.status,
          accountsList: normalizedAccounts,
          accounts: normalizedAccounts,
          accountsArray: normalizedAccounts,
          transactionsList: normalizedTransactions,
          detectedTransactions: normalizedTransactions,
        };
      }
    }
  }

  // =========================================================================
  // RESCATE LOCAL HEURÍSTICO MULTIPRODUCTO (Si no hay red/API Key y el formato es nuevo)
  // Permite mostrar la vista previa editable en `ImportAccountModal.js` para que el
  // usuario confirme y guarde la huella en `bank_templates`.
  // =========================================================================
  if (ocrText) {
    const multiParsed = parseMultiProductBankText(ocrText, {
      expandDualCurrencyCards: options.expandDualCurrencyCards !== false,
      country: targetCountry,
    });

    if (multiParsed.accountsList.length > 0 || multiParsed.transactionsList.length > 0) {
      const fallbackAccounts =
        multiParsed.accountsList.length > 0
          ? multiParsed.accountsList
          : [
              normalizeHybridAccountItem(
                {
                  bankName: multiParsed.bankName,
                  accountType: 'Cuenta de Ahorro',
                  productType: BANK_PRODUCT_TYPES.SAVINGS,
                  accountNumber: '',
                  currency: regionalConfig.currency || 'HNL',
                  country: targetCountry,
                  currentBalance: 0,
                },
                0,
                multiParsed.bankName
              ),
            ];

      const primary = fallbackAccounts[0];
      return {
        stage: 'local-heuristic-new-format',
        usedGeminiFallback: false,
        apiCost: 0,
        country: targetCountry,
        taxMetadata: multiParsed.taxMetadata,
        ocrConfidence,
        ocrText,
        matchedTemplate: null,
        source: 'local-ocr-heuristic',
        bankName: primary.bankName,
        accountType: primary.accountType,
        productType: primary.productType,
        accountNumber: primary.accountNumber,
        currency: primary.currency,
        currentBalance: primary.currentBalance,
        isCreditCard: primary.isCreditCard,
        isLoan: primary.isLoan,
        status: primary.status,
        accountsList: fallbackAccounts,
        accounts: fallbackAccounts,
        accountsArray: fallbackAccounts,
        transactionsList: multiParsed.transactionsList,
        detectedTransactions: multiParsed.transactionsList,
      };
    }
  }

  throw new Error(
    'No se pudo extraer la información bancaria. Verifica la imagen/PDF o configura tu Gemini API Key.'
  );
}

export {
  BANK_TEMPLATES_COLLECTION,
  BANK_TEMPLATES_LOCAL_STORE,
  computeLayoutFingerprint,
  filterBankTemplatesByCountry,
  getAllLocalBankTemplates,
  learnBankTemplateFromConfirmation,
  detectCountryTaxAndCurrency,
};
