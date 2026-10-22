import {
  TRANSACTION_TYPES,
  extractLast4Digits,
} from '../../../public/js/domain/models.js';
import { filterActiveAccounts } from '../../../public/js/services/accounts.js';
import {
  cleanAmount,
  parseVoucherText,
  decodeVoucherFile,
  decodeBankStatementPdf,
  parseBankStatementText,
  findDuplicateTransaction,
} from '../../../public/js/services/voucherOcrService.js';
import {
  matchBankTemplateFromText,
  getAllLocalBankTemplates,
  getLocalBankTemplatesSync,
  saveBankTemplate,
  normalizeBankTemplate,
  buildBankTemplateId,
  deriveTemplateKeywords,
  computeLayoutFingerprint,
} from './templateLearner.js';
import {
  VECTOR_PDF_MIN_CHARS,
  extractNativePdfTextLayer,
  organizeTextItemsIntoLines,
  organizeLinesIntoHierarchicalBlocks,
  extractPdfData,
} from './pdfExtractor.js';
import {
  parseBankStatementTextData,
  parseStatementHeaderAccountData,
  parseStatementTransactions,
  detectActiveStatementCurrency,
  normalizeBankStatementDate,
} from './bankParsers.js';
import {
  PROMERICA_CREDIT_CARD_SAMPLE_EXTRACTION,
  DEFAULT_STATEMENT_TEMPLATES,
  loadKnownStatementTemplates,
  matchStatementTemplate,
  extractStatementWithTemplate,
  learnAndSaveStatementPatternToBankTemplates,
  processPdfStatementWithPatternLearning,
} from './bankTemplateMatcher.js';

/**
 * Estados visuales de carga explícitos para la estrategia híbrida (OCR Local -> Gemini 2.5 Flash).
 */
export const LOCAL_OCR_LOADING_STATUS = '⏳ Procesando documento con OCR local...';
export const GEMINI_FALLBACK_LOADING_STATUS = '🤖 Refinando análisis con Gemini Flash AI...';
export const SMART_SCAN_GEMINI_MODEL = 'gemini-2.5-flash';
export const PDFJS_CDN_ESM_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/+esm';
export const PDFJS_WORKER_CDN_URL =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs';

/**
 * Tipos de documento soportados por el Motor Unificado de Clasificación y OCR.
 */
export const SMART_SCAN_DOCUMENT_TYPES = Object.freeze({
  VOUCHER_POS: 'Voucher POS',
  INVOICE_RECEIPT: 'Factura/Recibo',
  CREDIT_SLIP: 'Comprobante de Crédito (Ingreso)',
  DEBIT_SLIP: 'Comprobante de Débito (Gasto)',
  BANK_STATEMENT: 'Estado de Cuenta (Múltiples Movimientos)',
});

/**
 * Formatos de archivo aceptados por el botón inteligente "📷 Escanear Documento / PDF".
 */
export const SUPPORTED_SMART_SCAN_MIMES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'application/pdf',
]);

/**
 * Diccionario de categorías sugeridas legibles (`categoriaSugerida`) y su `categoryId` interno.
 */
export const SMART_SCAN_CATEGORY_RULES = Object.freeze([
  {
    categoryId: 'groceries',
    categoriaSugerida: 'Supermercado',
    type: 'expense',
    keywords: [
      'la colonia',
      'supermercados la colonia',
      'pricesmart',
      'price smart',
      'walmart',
      'paiz',
      'super paiz',
      'maxi despensa',
      'despensa familiar',
      'duns',
      'el colonial',
      'la antorcha',
      'supermercado',
      'minimarket',
      'mercadito',
      'abarroteria',
      'comisariato',
    ],
  },
  {
    categoryId: 'utilities',
    categoriaSugerida: 'Servicios Públicos',
    type: 'expense',
    keywords: [
      'enee',
      'eeh',
      'sanaa',
      'aguas de san pedro',
      'aguas de choloma',
      'tigo',
      'claro',
      'hondutel',
      'cable color',
      'starlink',
      'internet',
      'energia electrica',
      'electricidad',
      'agua potable',
      'telecomunicaciones',
      'servicios publicos',
      'pago de servicio',
    ],
  },
  {
    categoryId: 'transport',
    categoriaSugerida: 'Combustible',
    type: 'expense',
    keywords: [
      'puma energy',
      'puma',
      'gasolinera uno',
      'uno',
      'texaco',
      'shell',
      'chevron',
      'gasolinera',
      'estacion de servicio',
      'combustible',
      'gasolina',
      'diesel',
      'fuel',
    ],
  },
  {
    categoryId: 'transport',
    categoriaSugerida: 'Transporte',
    type: 'expense',
    keywords: [
      'uber',
      'didi',
      'indriver',
      'taxi',
      'peaje',
      'covi',
      'parqueo',
      'estacionamiento',
      'taller',
      'llantas',
      'autopartes',
      'repuestos',
      'avianca',
      'copa airlines',
      'aeropuerto',
      'palmerola',
      'toncontin',
      'transporte',
    ],
  },
  {
    categoryId: 'food',
    categoriaSugerida: 'Restaurantes',
    type: 'expense',
    keywords: [
      'espresso americano',
      'burger king',
      'mcdonald',
      'pizza hut',
      'little caesars',
      'domino',
      'kfc',
      'kentucky',
      'wendy',
      'pollo campero',
      'popeyes',
      'subway',
      'starbucks',
      'dunkin',
      'cinnabon',
      'chili',
      'applebee',
      'denny',
      'restaurante',
      'taqueria',
      'cafe',
      'cafeteria',
      'panaderia',
      'reposteria',
      'baleadas',
      'asados',
      'parrillada',
      'sushi',
      'pizzeria',
      'pedidosya',
      'hugo',
      'rappi',
      'uber eats',
      'bigos',
      'matambritas',
      'la cumbre',
      'el patio',
    ],
  },
  {
    categoryId: 'health',
    categoriaSugerida: 'Salud',
    type: 'expense',
    keywords: [
      'kielsa',
      'farmacia siman',
      'farmacity',
      'farmacia del ahorro',
      'punto farma',
      'farmacia',
      'drogueria',
      'hospital',
      'medical center',
      'honduras medical',
      'cemesa',
      'viera',
      'laboratorio',
      'clinica',
      'dental',
      'odontologia',
      'optica',
      'gym',
      'smart fit',
      'gimnasio',
      'medico',
      'salud',
    ],
  },
  {
    categoryId: 'shopping',
    categoriaSugerida: 'Compras',
    type: 'expense',
    keywords: [
      'diunsa',
      'siman',
      'el titan',
      'almacenes el titan',
      'carrion',
      'mendels',
      'lady lee',
      'larach',
      'acosa',
      'novacentro',
      'cemaco',
      'ferreteria',
      'jetstereo',
      'radioshack',
      'elektra',
      'monge',
      'gallo mas gallo',
      'la curacao',
      'zara',
      'nike',
      'adidas',
      'amazon',
      'shein',
      'temu',
      'compras',
    ],
  },
  {
    categoryId: 'education',
    categoriaSugerida: 'Educación',
    type: 'expense',
    keywords: [
      'unah',
      'unitec',
      'ceutec',
      'uth',
      'unicah',
      'zamorano',
      'universidad',
      'colegio',
      'escuela',
      'instituto',
      'libreria',
      'pacasa',
      'matricula',
      'educacion',
    ],
  },
  {
    categoryId: 'housing',
    categoriaSugerida: 'Vivienda',
    type: 'expense',
    keywords: ['alquiler', 'renta', 'condominio', 'hipoteca', 'vivienda'],
  },
  {
    categoryId: 'entertainment',
    categoriaSugerida: 'Entretenimiento',
    type: 'expense',
    keywords: [
      'cinemark',
      'metrocinemas',
      'cinepolis',
      'cine',
      'netflix',
      'spotify',
      'disney',
      'hbo',
      'max',
      'prime video',
      'youtube',
      'playstation',
      'xbox',
      'steam',
      'hotel',
      'airbnb',
      'booking',
      'entretenimiento',
      'ocio',
    ],
  },
  {
    categoryId: 'freelance',
    categoriaSugerida: 'Freelance',
    type: 'income',
    keywords: ['freelance', 'honorarios', 'consultoria', 'servicios profesionales'],
  },
  {
    categoryId: 'investments',
    categoriaSugerida: 'Inversiones',
    type: 'income',
    keywords: ['intereses ganados', 'dividendos', 'rendimiento', 'inversiones', 'inversion'],
  },
  {
    categoryId: 'salary',
    categoriaSugerida: 'Salario',
    type: 'income',
    keywords: [
      'salario',
      'planilla',
      'nomina',
      'sueldo',
      'pago de planilla',
      'deposito',
      'abono',
      'credito',
      'transferencia recibida',
      'ach recibido',
      'ach recibida',
    ],
  },
]);

const CATEGORY_ID_TO_LABEL = Object.freeze({
  groceries: 'Supermercado',
  utilities: 'Servicios Públicos',
  transport: 'Combustible',
  food: 'Restaurantes',
  health: 'Salud',
  shopping: 'Compras',
  education: 'Educación',
  housing: 'Vivienda',
  entertainment: 'Entretenimiento',
  family: 'Hogar y Mascotas',
  salary: 'Salario',
  freelance: 'Freelance',
  investments: 'Inversiones',
  gifts: 'Otros Ingresos',
});

/**
 * Infiere la categoría más pertinente (`categoriaSugerida` y `categoryId`) según el comercio
 * o concepto extraído del documento (ej. "Supermercado", "Servicios Públicos", "Combustible",
 * "Restaurantes", "Salario", etc.).
 *
 * @param {string} [comercio='']
 * @param {string} [rawText='']
 * @param {'income'|'expense'} [tipoTransaccion='expense']
 * @param {Array<object>} [categories=[]]
 * @param {string} [explicitSuggestedCategory='']
 * @returns {{ categoryId: string, categoriaSugerida: string }}
 */
export function inferSmartScanCategory(
  comercio = '',
  rawText = '',
  tipoTransaccion = TRANSACTION_TYPES.EXPENSE,
  categories = [],
  explicitSuggestedCategory = ''
) {
  const normalizeStr = (s) =>
    String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();

  const normalizedExplicit = normalizeStr(explicitSuggestedCategory);
  if (normalizedExplicit) {
    const matchedByExplicitRule = SMART_SCAN_CATEGORY_RULES.find(
      (r) =>
        normalizeStr(r.categoriaSugerida) === normalizedExplicit ||
        normalizeStr(r.categoryId) === normalizedExplicit ||
        r.keywords.some((kw) => normalizedExplicit.includes(kw))
    );
    if (matchedByExplicitRule) {
      return {
        categoryId: matchedByExplicitRule.categoryId,
        categoriaSugerida: matchedByExplicitRule.categoriaSugerida,
      };
    }
  }

  const combined = `${normalizeStr(comercio)} ${normalizeStr(rawText)}`.trim();

  // 1. Buscar primero en el nombre del comercio/concepto directo
  const normMerchant = normalizeStr(comercio);
  for (const rule of SMART_SCAN_CATEGORY_RULES) {
    if (rule.keywords.some((kw) => normMerchant.includes(kw))) {
      return {
        categoryId: rule.categoryId,
        categoriaSugerida: rule.categoriaSugerida,
      };
    }
  }

  // 2. Buscar en el texto completo del documento
  for (const rule of SMART_SCAN_CATEGORY_RULES) {
    if (rule.keywords.some((kw) => combined.includes(kw))) {
      return {
        categoryId: rule.categoryId,
        categoriaSugerida: rule.categoriaSugerida,
      };
    }
  }

  // 3. Buscar coincidencia en categorías personalizadas del usuario si existen
  if (Array.isArray(categories) && categories.length > 0) {
    const userCat = categories.find(
      (c) =>
        c &&
        c.name &&
        (normMerchant.includes(normalizeStr(c.name)) ||
          combined.includes(normalizeStr(c.name)))
    );
    if (userCat) {
      return {
        categoryId: userCat.id,
        categoriaSugerida: userCat.name,
      };
    }
  }

  // 4. Fallback según tipo de transacción (Ingreso -> Salario, Gasto -> Supermercado)
  if (tipoTransaccion === TRANSACTION_TYPES.INCOME) {
    const incomeCat = Array.isArray(categories)
      ? categories.find((c) => c && c.type === TRANSACTION_TYPES.INCOME)
      : null;
    return {
      categoryId: incomeCat?.id || 'salary',
      categoriaSugerida: incomeCat?.name || 'Salario',
    };
  }

  return {
    categoryId: 'groceries',
    categoriaSugerida: 'Supermercado',
  };
}

/**
 * Esquema JSON estructurado (`responseSchema`) para forzar la extracción con Gemini 2.5 Flash API.
 * Incluye `bankName`, `documentType`, `date`, `amount`, `currency`, `accountNumber`, `merchant`,
 * `suggestedCategory` y `transactions` (si es un Estado de Cuenta).
 */
export const SMART_SCAN_GEMINI_JSON_SCHEMA = Object.freeze({
  type: 'OBJECT',
  properties: {
    bankName: {
      type: 'STRING',
      description: 'Nombre del banco o entidad financiera detectada (ej. BAC Credomatic, Banco Atlántida, Ficohsa, Banpaís).',
    },
    documentType: {
      type: 'STRING',
      enum: Object.values(SMART_SCAN_DOCUMENT_TYPES),
      description: 'Clasificación del documento financiero.',
    },
    date: {
      type: 'STRING',
      description: 'Fecha principal del documento en formato ISO YYYY-MM-DD.',
    },
    merchant: {
      type: 'STRING',
      description: 'Nombre del comercio, establecimiento o concepto principal del comprobante.',
    },
    amount: {
      type: 'NUMBER',
      description: 'Monto total numérico sin comas de miles (ej. 3901.33).',
    },
    currency: {
      type: 'STRING',
      enum: ['HNL', 'USD'],
      description: 'Código de moneda ISO (HNL para Lempiras o USD para Dólares).',
    },
    accountNumber: {
      type: 'STRING',
      description: 'Número de cuenta bancaria completo o últimos 4 dígitos de la tarjeta.',
    },
    suggestedCategory: {
      type: 'STRING',
      description: 'Categoría sugerida según el comercio o concepto (ej. Supermercado, Servicios Públicos, Combustible, Restaurantes, Salario).',
    },
    transactions: {
      type: 'ARRAY',
      description: 'Listado completo de transacciones si el documento es un Estado de Cuenta.',
      items: {
        type: 'OBJECT',
        properties: {
          date: {
            type: 'STRING',
            description: 'Fecha del movimiento en formato YYYY-MM-DD.',
          },
          merchant: {
            type: 'STRING',
            description: 'Concepto o comercio del movimiento.',
          },
          amount: {
            type: 'NUMBER',
            description: 'Monto numérico positivo del movimiento sin comas de miles.',
          },
          type: {
            type: 'STRING',
            enum: ['income', 'expense'],
            description: 'Tipo de movimiento: income (crédito/depósito) o expense (débito/cargo).',
          },
          currency: {
            type: 'STRING',
            enum: ['HNL', 'USD'],
          },
          suggestedCategory: {
            type: 'STRING',
            description: 'Categoría sugerida del movimiento.',
          },
        },
        required: ['date', 'merchant', 'amount', 'type'],
      },
    },
  },
  required: ['bankName', 'documentType', 'date', 'amount', 'currency', 'accountNumber'],
});

/**
 * Sanitiza montos monetarios eliminando símbolos de moneda y comas de miles
 * (ej. "3,901.33" -> 3901.33, "L. 12,450.50" -> 12450.5).
 * @param {string|number} rawValue
 * @returns {number}
 */
export function sanitizeSmartScanAmount(rawValue) {
  return cleanAmount(rawValue);
}

/**
 * Normaliza una cadena de fecha (`YYYY-MM-DD` o `DD/MM/YYYY` o `DD-MM-YYYY`) a formato ISO `YYYY-MM-DD`.
 * @param {string} rawDate
 * @param {string} [fallbackDate]
 * @returns {string}
 */
export function normalizeSmartScanDate(rawDate = '', fallbackDate = '') {
  const raw = String(rawDate || '').trim();
  if (!raw) {
    return fallbackDate || new Date().toISOString().slice(0, 10);
  }

  const isoMatch = raw.match(/\b(20\d{2})[/-](0[1-9]|1[0-2])[/-](0[1-9]|[12]\d|3[01])\b/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  const dmyMatch = raw.match(/\b(0?[1-9]|[12]\d|3[01])[/-](0?[1-9]|1[0-2])[/-](\d{2,4})\b/);
  if (dmyMatch) {
    const day = String(dmyMatch[1]).padStart(2, '0');
    const month = String(dmyMatch[2]).padStart(2, '0');
    const year = dmyMatch[3].length === 2 ? `20${dmyMatch[3]}` : dmyMatch[3];
    return `${year}-${month}-${day}`;
  }

  return fallbackDate || new Date().toISOString().slice(0, 10);
}

/**
 * Determina el tipo de transacción ('income' o 'expense') a partir del tipo de documento.
 * @param {string} tipoDocumento
 * @returns {'income'|'expense'}
 */
export function getTransactionTypeForDocument(tipoDocumento) {
  if (tipoDocumento === SMART_SCAN_DOCUMENT_TYPES.CREDIT_SLIP) {
    return TRANSACTION_TYPES.INCOME;
  }
  return TRANSACTION_TYPES.EXPENSE;
}

/**
 * Detecta la entidad bancaria y el tipo de cuenta sugerido a partir del encabezado del documento.
 * @param {string} rawText
 * @returns {{ bankName: string, hasExplicitBank: boolean, accountType: 'bank'|'card', accountTypeLabel: string }}
 */
export function detectBankAndAccountMetadata(rawText = '') {
  const text = String(rawText || '');
  let bankName = 'Banco Local';
  let hasExplicitBank = true;

  if (/\b(?:BAC|CREDOMATIC)\b/i.test(text)) bankName = 'BAC Credomatic';
  else if (/\bATL[AÁ]NTIDA\b/i.test(text)) bankName = 'Banco Atlántida';
  else if (/\bFICOHSA\b/i.test(text)) bankName = 'Banco Ficohsa';
  else if (/\b(?:BANPA[IÍ]S|BANCO\s+DEL\s+PA[IÍ]S)\b/i.test(text)) bankName = 'Banpaís';
  else if (/\bPROMERICA\b/i.test(text)) bankName = 'Banco Promerica';
  else if (/\bOCCIDENTE\b/i.test(text)) bankName = 'Banco de Occidente';
  else if (/\bDAVIVIENDA\b/i.test(text)) bankName = 'Banco Davivienda';
  else if (/\bLAFISE\b/i.test(text)) bankName = 'Banco Lafise';
  else if (/\bBANRURAL\b/i.test(text)) bankName = 'Banrural';
  else if (/\bAZTECA\b/i.test(text)) bankName = 'Banco Azteca';
  else if (/\bCUSCATL[AÁ]N\b/i.test(text)) bankName = 'Banco Cuscatlán';
  else if (/\bPOPULAR\b/i.test(text)) bankName = 'Banco Popular';
  else {
    hasExplicitBank = false;
  }

  const isCreditCard =
    /\b(?:TARJETA\s+DE\s+CR[EÉ]DITO|VISA|MASTERCARD|AMEX|AMERICAN\s+EXPRESS|FECHA\s+DE\s+CORTE|PAGO\s+M[IÍ]NIMO|PAGO\s+DE\s+CONTADO)\b/i.test(
      text
    );
  const isChecking = /\b(?:CHEQUES|CUENTA\s+CORRIENTE)\b/i.test(text);

  return {
    bankName,
    hasExplicitBank,
    accountType: isCreditCard ? 'card' : 'bank',
    accountTypeLabel: isCreditCard
      ? 'Tarjeta de Crédito'
      : isChecking
        ? 'Cuenta de Cheques'
        : 'Cuenta de Ahorro',
  };
}

/**
 * Extrae el número de cuenta o los últimos 4 dígitos de tarjeta/cuenta presentes en el texto.
 * @param {string} rawText
 * @param {string} [fallbackLast4='']
 * @returns {string}
 */
export function extractIdentifiedAccountNumber(rawText = '', fallbackLast4 = '') {
  const text = String(rawText || '');

  const explicitAccountPatterns = [
    /(?:CUENTA\s+(?:DE\s+)?(?:DESTINO|ORIGEN|N[°ºo.]*|BANCARIA|AHORRO|CHEQUES)?|CTA\.?\s*N[°ºo.]*|N[ÚU]MERO\s+DE\s+CUENTA|PRODUCTO\s*N[°ºo.]*)\s*[:#-]?\s*(?:\*+|X+|\.{2,})?\s*(\d[\d-\s]{2,18}\d)/i,
    /(?:TARJETA|CARD|NRO\.?\s*TARJETA|PAN)\s*[:#-]?\s*(?:\*{2,}|X{2,}|\.{2,}|[\d\s-]{4,15})?(\d{4})\b/i,
    /(?:\*{1,}|X{2,})\s*(\d{4})\b/i,
    /TERMINAD[AO]\s+EN\s*[:#-]?\s*(\d{4})\b/i,
  ];

  for (const regex of explicitAccountPatterns) {
    const match = text.match(regex);
    if (match?.[1]) {
      const digitsOnly = match[1].replace(/\D/g, '');
      if (digitsOnly.length >= 4) {
        return digitsOnly;
      }
    }
  }

  if (fallbackLast4) {
    const cleanFallback = String(fallbackLast4).replace(/\D/g, '');
    if (cleanFallback.length >= 4) {
      return cleanFallback;
    }
  }

  return '';
}

/**
 * Aplica limpiadores de expresiones regulares (regex) sobre el texto plano extraído por Tesseract.js
 * para buscar patrones de:
 * - Fecha (`YYYY-MM-DD` o `DD/MM/YYYY`, además de formatos con mes en texto)
 * - Montos (sanitizando comas de miles para no perder dígitos, ej. "3,901.33" -> 3901.33)
 * - Números de cuenta o últimos 4 dígitos de tarjeta
 * - Nombre del banco o comercio
 *
 * @param {string} rawText
 * @param {object} [state]
 * @returns {{
 *   date: string,
 *   hasExplicitDate: boolean,
 *   amount: number,
 *   hasExplicitAmount: boolean,
 *   currency: 'HNL'|'USD',
 *   accountNumber: string,
 *   hasAccountNumber: boolean,
 *   bankName: string,
 *   merchant: string,
 *   hasBankOrMerchant: boolean
 * }}
 */
export function applySmartScanRegexCleaners(rawText = '', state = {}) {
  const text = String(rawText || '');
  const parsedVoucher = parseVoucherText(text, state);
  const bankMeta = detectBankAndAccountMetadata(text);

  // 1. Patrón de Fecha explícita (YYYY-MM-DD o DD/MM/YYYY o DD-MM-YYYY o MES DD, YYYY)
  const explicitIsoDate = text.match(/\b(20\d{2})[/-](0[1-9]|1[0-2])[/-](0[1-9]|[12]\d|3[01])\b/);
  const explicitDmyDate = text.match(/\b(0?[1-9]|[12]\d|3[01])[/-](0?[1-9]|1[0-2])[/-](\d{2,4})\b/);
  const explicitTextMonthDate = text.match(
    /\b(?:ENE|JAN|FEB|MAR|ABR|APR|MAY|JUN|JUL|AGO|AUG|SEP|SET|OCT|0CT|NOV|DIC|DEC)[A-Z]*\s+\d{1,2}\s*[,./-]\s*\d{2,4}\b|\b\d{1,2}\s*(?:DE\s+|[/.-])?(?:ENE|JAN|FEB|MAR|ABR|APR|MAY|JUN|JUL|AGO|AUG|SEP|SET|OCT|0CT|NOV|DIC|DEC)[A-Z]*\s*(?:DE\s+|[,./-])?\s*\d{2,4}\b/i
  );

  let date = parsedVoucher.date || new Date().toISOString().slice(0, 10);
  if (explicitIsoDate) {
    date = `${explicitIsoDate[1]}-${explicitIsoDate[2]}-${explicitIsoDate[3]}`;
  } else if (explicitDmyDate) {
    const d = String(explicitDmyDate[1]).padStart(2, '0');
    const m = String(explicitDmyDate[2]).padStart(2, '0');
    const y = explicitDmyDate[3].length === 2 ? `20${explicitDmyDate[3]}` : explicitDmyDate[3];
    date = `${y}-${m}-${d}`;
  }
  const hasExplicitDate = Boolean(explicitIsoDate || explicitDmyDate || explicitTextMonthDate);

  // 2. Patrón de Montos (sanitizando comas de miles: "3,901.33" -> 3901.33)
  const amountRegexMatches = [
    ...text.matchAll(
      /(?:TOTAL|MONTO|IMPORTE|VALOR|PAGADO|SALDO|L\.?|\$|HNL|USD|LPS)\s*[:.]?\s*(?:HNL|USD|LPS|US\$|L\.?|\$)?\s*(\d{1,3}(?:,\d{3})+\.\d{2}|\d{1,9}\.\d{2})/gi
    ),
    ...text.matchAll(/\b(\d{1,3}(?:,\d{3})+\.\d{2}|\d{1,9}\.\d{2})\b/g),
  ];

  let amount = sanitizeSmartScanAmount(parsedVoucher.amount);
  if (amount <= 0 && amountRegexMatches.length > 0) {
    const candidateAmounts = amountRegexMatches
      .map((m) => sanitizeSmartScanAmount(m[1]))
      .filter((n) => n > 0 && n < 100000000);
    if (candidateAmounts.length > 0) {
      amount = Math.max(...candidateAmounts);
    }
  }
  const hasExplicitAmount = amount > 0;

  // 3. Patrón de Número de Cuenta o últimos 4 dígitos de tarjeta
  const accountNumber = extractIdentifiedAccountNumber(text, parsedVoucher.cardLast4);
  const hasAccountNumber = Boolean(accountNumber && accountNumber.length >= 4);

  // 4. Patrón de Banco o Comercio
  const rawMerchant = String(parsedVoucher.merchant || '').trim();
  const isGenericMerchant =
    !rawMerchant ||
    /^(?:COMERCIO|MOVIMIENTO|COMERCIO\s*\/\s*MOVIMIENTO|COMERCIO\s+LOCAL|SIN\s+NOMBRE|DESCONOCIDO)$/i.test(
      rawMerchant
    );
  const bankName = parsedVoucher.detectedBank || bankMeta.bankName || 'Banco Local';
  const merchant = !isGenericMerchant
    ? rawMerchant
    : bankMeta.hasExplicitBank
      ? bankName
      : '';
  const hasBankOrMerchant = Boolean(!isGenericMerchant || bankMeta.hasExplicitBank);

  const resolvedMerchant = merchant || rawMerchant || 'Comercio / Movimiento';
  const hasBothLempirasAndDolares =
    /\b(?:LEMPIRAS|HNL|LPS)\b/i.test(text) && /\b(?:D[OÓ]LARES|USD|US\$)\b/i.test(text);
  const currency = hasBothLempirasAndDolares
    ? detectActiveStatementCurrency(text)
    : parsedVoucher.currency === 'USD' || /\b(?:USD|US\$|D[OÓ]LARES)\b/i.test(text)
      ? 'USD'
      : 'HNL';
  const inferredType =
    /\b(?:DEP[OÓ]SITO|ABONO|CR[EÉ]DITO|TRANSFERENCIA\s+RECIBIDA|ACH\s+RECIBID[OA]|PLANILLA|N[OÓ]MINA)\b/i.test(
      text
    )
      ? TRANSACTION_TYPES.INCOME
      : TRANSACTION_TYPES.EXPENSE;
  const { categoryId, categoriaSugerida } = inferSmartScanCategory(
    resolvedMerchant,
    text,
    inferredType,
    state?.categories || []
  );

  return {
    date,
    fecha: date,
    hasExplicitDate,
    amount,
    monto: amount,
    hasExplicitAmount,
    currency,
    moneda: currency,
    accountNumber,
    cuentaIdentificada: accountNumber,
    hasAccountNumber,
    bankName,
    merchant: resolvedMerchant,
    comercio: resolvedMerchant,
    categoryId,
    categoriaSugerida,
    hasBankOrMerchant,
  };
}

/**
 * Evalúa el nivel de confianza y completitud del resultado obtenido por el OCR local (Tesseract.js).
 * Determina si es necesario activar el Paso 2 (Fallback con Gemini 2.5 Flash API).
 *
 * @param {object} parsedResult
 * @param {string} rawText
 * @param {number|null} [ocrConfidence=null]
 * @param {object} [options]
 * @returns {{
 *   isComplete: boolean,
 *   needsGeminiFallback: boolean,
 *   confidenceScore: number,
 *   missingFields: Array<string>,
 *   reason: string
 * }}
 */
export function evaluateLocalOcrCompleteness(
  parsedResult = {},
  rawText = '',
  ocrConfidence = null,
  options = {}
) {
  const text = String(rawText || '').trim();
  const minConfidence =
    typeof options.minOcrConfidence === 'number' ? options.minOcrConfidence : 42;

  if (!text || text.length < 8) {
    return {
      isComplete: false,
      needsGeminiFallback: true,
      confidenceScore: 0,
      missingFields: ['rawText', 'date', 'amount', 'merchant'],
      reason: 'empty_or_illegible_ocr_text',
    };
  }

  // Verificar legibilidad básica (proporción de caracteres alfanuméricos frente a basura OCR)
  const alphaNumCount = (text.match(/[a-zA-Z0-9áéíóúÁÉÍÓÚñÑ]/g) || []).length;
  const alphaNumRatio = alphaNumCount / Math.max(1, text.length);
  if (alphaNumRatio < 0.25 || alphaNumCount < 6) {
    return {
      isComplete: false,
      needsGeminiFallback: true,
      confidenceScore: Math.round(alphaNumRatio * 100),
      missingFields: ['legibleText'],
      reason: 'low_alphanumeric_legibility',
    };
  }

  if (typeof ocrConfidence === 'number' && ocrConfidence > 0 && ocrConfidence < minConfidence) {
    return {
      isComplete: false,
      needsGeminiFallback: true,
      confidenceScore: ocrConfidence,
      missingFields: ['ocrConfidence'],
      reason: 'below_confidence_threshold',
    };
  }

  const cleaners = applySmartScanRegexCleaners(text);
  const statementRows = Array.isArray(parsedResult?.statementItems)
    ? parsedResult.statementItems
    : Array.isArray(parsedResult?.transactions)
      ? parsedResult.transactions
      : [];

  const validStatementRows = statementRows.filter(
    (r) => r && sanitizeSmartScanAmount(r.monto ?? r.amount ?? 0) > 0 && (r.fecha || r.date)
  );

  // Si es Estado de Cuenta con movimientos válidos extraídos, la extracción local es completa
  if (
    validStatementRows.length >= 2 ||
    (validStatementRows.length >= 1 &&
      Boolean(cleaners.hasAccountNumber || parsedResult?.cuentaIdentificada))
  ) {
    return {
      isComplete: true,
      needsGeminiFallback: false,
      confidenceScore: typeof ocrConfidence === 'number' ? ocrConfidence : 90,
      missingFields: [],
      reason: 'complete_statement_rows',
    };
  }

  // Si el encabezado dice "ESTADO DE CUENTA" pero el OCR local no logró extraer filas de movimientos
  if (
    parsedResult?.tipoDocumento === SMART_SCAN_DOCUMENT_TYPES.BANK_STATEMENT &&
    validStatementRows.length === 0
  ) {
    return {
      isComplete: false,
      needsGeminiFallback: true,
      confidenceScore: 30,
      missingFields: ['transactions'],
      reason: 'statement_without_extracted_rows',
    };
  }

  const missingFields = [];
  const effectiveAmount = sanitizeSmartScanAmount(
    parsedResult?.monto ?? parsedResult?.amount ?? cleaners.amount
  );

  if (effectiveAmount <= 0) {
    missingFields.push('amount');
  }
  if (!cleaners.hasExplicitDate && !parsedResult?.hasExplicitDate) {
    missingFields.push('date');
  }
  if (!cleaners.hasBankOrMerchant && !cleaners.hasAccountNumber && !parsedResult?.cuentaIdentificada) {
    missingFields.push('merchantOrBank');
  }

  // El monto es indispensable en un comprobante individual; además requerimos al menos fecha o comercio/banco
  const isComplete =
    effectiveAmount > 0 &&
    (cleaners.hasExplicitDate || cleaners.hasBankOrMerchant || cleaners.hasAccountNumber);

  let score = typeof ocrConfidence === 'number' && ocrConfidence > 0 ? ocrConfidence : 80;
  if (!cleaners.hasExplicitDate) score -= 15;
  if (!cleaners.hasBankOrMerchant) score -= 15;
  if (effectiveAmount <= 0) score = Math.min(score, 20);

  return {
    isComplete,
    needsGeminiFallback: !isComplete,
    confidenceScore: Math.max(0, Math.min(100, score)),
    missingFields,
    reason: isComplete ? 'complete_single_document' : `missing_${missingFields.join('_')}`,
  };
}

/**
 * Extrae el listado completo de transacciones desde el texto de un Estado de Cuenta
 * (incluyendo tanto gastos/débitos como ingresos/créditos/depósitos).
 *
 * @param {string} rawText
 * @param {object} [state]
 * @param {object} [options]
 * @returns {Array<object>}
 */
export function extractStatementTransactionsFromText(rawText = '', state = {}, options = {}) {
  const text = String(rawText || '');
  const baseStmt = parseBankStatementText(text, state, options);
  const rows = [];
  const seenKeys = new Set();

  // 1. Incluir filas detectadas por el parser estructurado de estados de cuenta
  for (const item of baseStmt.items || []) {
    const fecha = String(item.date || '').slice(0, 10);
    const comercio = String(item.concept || item.rawConcept || 'Movimiento')
      .replace(/\s+(?:USD|US\$|HNL|LPS|L\.?|\$)\s*$/i, '')
      .trim();
    const monto = sanitizeSmartScanAmount(item.amount);
    const moneda = item.currency === 'USD' ? 'USD' : 'HNL';
    const isIncome =
      /\b(?:DEP[OÓ]SITO|ABONO|CR[EÉ]DITO|TRANSFERENCIA\s+RECIBIDA|ACH\s+RECIBID[OA]|PLANILLA|N[OÓ]MINA|INTERESES\s+GANADOS)\b/i.test(
        comercio
      );
    const tipo = isIncome ? TRANSACTION_TYPES.INCOME : TRANSACTION_TYPES.EXPENSE;
    const key = `${fecha}|${comercio.toUpperCase()}|${monto}`;
    seenKeys.add(key);
    seenKeys.add(`${fecha}|${monto}`);

    const inferredCat = inferSmartScanCategory(
      comercio,
      comercio,
      tipo,
      state?.categories || []
    );

    rows.push({
      id: item.id || `stmt_tx_${rows.length + 1}`,
      selected: item.selected !== false,
      fecha,
      date: fecha,
      comercio,
      concept: comercio,
      monto,
      amount: monto,
      moneda,
      currency: moneda,
      tipo,
      type: tipo,
      categoryId: item.categoryId || inferredCat.categoryId,
      categoriaSugerida:
        item.categoriaSugerida ||
        CATEGORY_ID_TO_LABEL[item.categoryId] ||
        inferredCat.categoriaSugerida,
      isDuplicate: Boolean(item.isDuplicate),
    });
  }

  // 2. Parser flexible adicional para líneas de estados de cuenta bancarios (incluyendo créditos/ingresos y fechas ISO o DD/MM/YYYY)
  const defaultYear = options.fallbackYear || new Date().getFullYear();
  const defaultCurrency =
    typeof state === 'string' && (state === 'USD' || state === 'HNL')
      ? state
      : /\bMONEDA\s*:\s*(?:USD|D[OÓ]LARES)\b/i.test(text)
        ? 'USD'
        : detectActiveStatementCurrency(text);

  // Incluir filas detectadas por bankParsers.js (soporta montos con o sin coma de miles como 1620.42)
  const bankParsedRows = parseStatementTransactions(text, defaultCurrency);
  for (const bpRow of bankParsedRows) {
    const bpKey = `${bpRow.fecha}|${bpRow.comercio.toUpperCase()}|${bpRow.monto}`;
    if (seenKeys.has(bpKey) || seenKeys.has(`${bpRow.fecha}|${bpRow.monto}`)) continue;
    seenKeys.add(bpKey);
    seenKeys.add(`${bpRow.fecha}|${bpRow.monto}`);
    const inferredRowCat = inferSmartScanCategory(
      bpRow.comercio,
      bpRow.comercio,
      bpRow.tipo,
      Array.isArray(state?.categories) ? state.categories : []
    );
    rows.push({
      id: `stmt_tx_${rows.length + 1}`,
      selected: true,
      fecha: bpRow.fecha,
      date: bpRow.date,
      time: bpRow.time || '12:00 AM',
      comercio: bpRow.comercio,
      concept: bpRow.concept,
      monto: bpRow.monto,
      amount: bpRow.amount,
      moneda: bpRow.moneda || defaultCurrency,
      currency: bpRow.currency || defaultCurrency,
      tipo: bpRow.tipo,
      type: bpRow.type,
      categoryId: inferredRowCat.categoryId,
      categoriaSugerida: inferredRowCat.categoriaSugerida,
      isDuplicate: false,
    });
  }

  const monthMap = {
    ENE: '01',
    JAN: '01',
    FEB: '02',
    MAR: '03',
    ABR: '04',
    APR: '04',
    MAY: '05',
    JUN: '06',
    JUL: '07',
    AGO: '08',
    AUG: '08',
    SEP: '09',
    SET: '09',
    OCT: '10',
    NOV: '11',
    DIC: '12',
    DEC: '12',
  };

  const normalizeRowDate = (rawToken) => {
    const clean = String(rawToken || '').trim().toUpperCase();
    const iso = clean.match(/^(20\d{2})[/-](0[1-9]|1[0-2])[/-](0[1-9]|[12]\d|3[01])$/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

    const dmy = clean.match(/^(0?[1-9]|[12]\d|3[01])[/-](0?[1-9]|1[0-2])(?:[/-](\d{2,4}))?$/);
    if (dmy) {
      const d = String(dmy[1]).padStart(2, '0');
      const m = String(dmy[2]).padStart(2, '0');
      const y = dmy[3] ? (dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3]) : String(defaultYear);
      return `${y}-${m}-${d}`;
    }

    const mmmFirst = clean.match(/^([A-Z]{3})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/);
    if (mmmFirst && monthMap[mmmFirst[1]]) {
      const d = String(mmmFirst[2]).padStart(2, '0');
      const m = monthMap[mmmFirst[1]];
      const y = mmmFirst[3]
        ? mmmFirst[3].length === 2
          ? `20${mmmFirst[3]}`
          : mmmFirst[3]
        : String(defaultYear);
      return `${y}-${m}-${d}`;
    }

    const dFirstMmm = clean.match(/^(\d{1,2})[/.-]([A-Z]{3})(?:[/.-](\d{2,4}))?$/);
    if (dFirstMmm && monthMap[dFirstMmm[2]]) {
      const d = String(dFirstMmm[1]).padStart(2, '0');
      const m = monthMap[dFirstMmm[2]];
      const y = dFirstMmm[3]
        ? dFirstMmm[3].length === 2
          ? `20${dFirstMmm[3]}`
          : dFirstMmm[3]
        : String(defaultYear);
      return `${y}-${m}-${d}`;
    }

    return null;
  };

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const flexLineRegex =
    /^(?:Ref\.?\s*[\w-]+\s+|\d{1,6}\s+)?(\d{4}[/-]\d{2}[/-]\d{2}|\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?|[A-Z]{3}[/.-]\d{1,2}(?:[/.-](\d{2,4}))?|\d{1,2}[/.-][A-Z]{3}(?:[/.-](\d{2,4}))?)\s+(.+?)\s+(?:(USD|US\$|HNL|LPS|L\.?|\$)\s*)?([+-]?\d+(?:,\d{3})*\.\d{2})\s*(CR|DB|CREDITO|DEBITO|INGRESO|GASTO|\+|-)?$/i;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (
      /^(?:SALDO\s+ANTERIOR|SALDO\s+FINAL|PAGO\s+MINIMO|PAGO\s+DE\s+CONTADO|FECHA\s+DE\s+CORTE)/i.test(
        line
      )
    ) {
      continue;
    }
    const match = line.match(flexLineRegex);
    if (!match) continue;

    const fecha = normalizeRowDate(match[1]);
    if (!fecha) continue;

    const rawConcept = match[4]
      .replace(/\s+(?:USD|US\$|HNL|LPS|L\.?|\$)\s*$/i, '')
      .trim();
    const currencyToken = String(match[5] || '').toUpperCase();
    const rawAmt = match[6];
    const signSuffix = String(match[7] || '').toUpperCase();

    const monto = Math.abs(sanitizeSmartScanAmount(rawAmt));
    if (monto <= 0) continue;

    const key = `${fecha}|${rawConcept.toUpperCase()}|${monto}`;
    if (seenKeys.has(key) || seenKeys.has(`${fecha}|${monto}`)) continue;
    seenKeys.add(key);
    seenKeys.add(`${fecha}|${monto}`);

    const moneda =
      currencyToken === 'USD' || currencyToken === 'US$' || currencyToken === '$'
        ? 'USD'
        : currencyToken === 'HNL' || currencyToken === 'LPS' || currencyToken.startsWith('L')
          ? 'HNL'
          : defaultCurrency;

    const isCredit =
      signSuffix === 'CR' ||
      signSuffix === 'CREDITO' ||
      signSuffix === 'INGRESO' ||
      signSuffix === '+' ||
      String(rawAmt).trim().startsWith('+') ||
      /\b(?:DEP[OÓ]SITO|ABONO|CR[EÉ]DITO|TRANSFERENCIA\s+RECIBIDA|ACH\s+RECIBID[OA]|PLANILLA|N[OÓ]MINA|PAGO\s+RECIBIDO|INTERESES)\b/i.test(
        rawConcept
      );

    const tipo = isCredit ? TRANSACTION_TYPES.INCOME : TRANSACTION_TYPES.EXPENSE;
    const inferredRowCat = inferSmartScanCategory(
      rawConcept,
      rawConcept,
      tipo,
      state?.categories || []
    );

    rows.push({
      id: `stmt_tx_${rows.length + 1}`,
      selected: true,
      fecha,
      date: fecha,
      comercio: rawConcept,
      concept: rawConcept,
      monto,
      amount: monto,
      moneda,
      currency: moneda,
      tipo,
      type: tipo,
      categoryId: inferredRowCat.categoryId,
      categoriaSugerida: inferredRowCat.categoriaSugerida,
      isDuplicate: false,
    });
  }

  return rows;
}

/**
 * Clasifica el texto extraído por OCR / PDF en uno de los 5 tipos de documento
 * (incluyendo "Estado de Cuenta (Múltiples Movimientos)").
 *
 * @param {string} rawText
 * @param {Array<object>} [extractedStatementRows]
 * @returns {string} Uno de los valores de SMART_SCAN_DOCUMENT_TYPES
 */
export function classifySmartScanDocumentType(rawText = '', extractedStatementRows = null) {
  const text = String(rawText || '').toUpperCase();

  // 0. Estado de Cuenta (Múltiples Movimientos)
  const statementPatterns = [
    /ESTADO\s+DE\s+CUENTA/,
    /DETALLE\s+DE\s+(?:MOVIMIENTOS|TRANSACCIONES)/,
    /MOVIMIENTOS\s+DEL\s+PER[IÍ]ODO/,
    /RESUMEN\s+DE\s+ESTADO\s+DE\s+CUENTA/,
    /FECHA\s+DE\s+CORTE[\s\S]{0,160}(?:SALDO\s+ANTERIOR|PAGO\s+M[IÍ]NIMO|DETALLE)/,
  ];
  const rows = Array.isArray(extractedStatementRows)
    ? extractedStatementRows
    : extractStatementTransactionsFromText(rawText);

  if (rows.length >= 2 || statementPatterns.some((regex) => regex.test(text))) {
    return SMART_SCAN_DOCUMENT_TYPES.BANK_STATEMENT;
  }

  // 1. Comprobante de Crédito (Ingreso)
  const creditPatterns = [
    /COMPROBANTE\s+DE\s+CR[EÉ]DITO/,
    /NOTA\s+DE\s+CR[EÉ]DITO/,
    /DEP[OÓ]SITO\s+(?:EN|A)\s+CUENTA/,
    /COMPROBANTE\s+DE\s+DEP[OÓ]SITO/,
    /TRANSFERENCIA\s+RECIBIDA/,
    /ACH\s+RECIBID[OA]/,
    /ABONO\s+(?:EN|A)\s+CUENTA/,
    /ACREDITADO\s+A\s+CUENTA/,
    /CR[EÉ]DITO\s+BANCARIO/,
    /INGRESO\s+A\s+CUENTA/,
    /PAGO\s+RECIBIDO/,
  ];
  if (creditPatterns.some((regex) => regex.test(text))) {
    return SMART_SCAN_DOCUMENT_TYPES.CREDIT_SLIP;
  }

  // 2. Comprobante de Débito (Gasto)
  const debitPatterns = [
    /COMPROBANTE\s+DE\s+D[EÉ]BITO/,
    /NOTA\s+DE\s+D[EÉ]BITO/,
    /D[EÉ]BITO\s+(?:EN|A)\s+CUENTA/,
    /D[EÉ]BITO\s+AUTOM[AÁ]TICO/,
    /TRANSFERENCIA\s+(?:ENVIADA|EXITOSA|ACH|BANCARIA|A\s+TERCEROS)/,
    /COMPROBANTE\s+DE\s+TRANSFERENCIA/,
    /CARGO\s+(?:EN|A)\s+CUENTA/,
    /RETIRO\s+(?:DE\s+EFECTIVO|ATM|CAJERO)/,
    /COMPROBANTE\s+DE\s+PAGO/,
    /PAGO\s+DE\s+SERVICIO/,
  ];
  if (debitPatterns.some((regex) => regex.test(text))) {
    return SMART_SCAN_DOCUMENT_TYPES.DEBIT_SLIP;
  }

  // 3. Voucher POS
  const posPatterns = [
    /\bVOUCHER\b/,
    /TERMINAL\s*[:#]?\s*[A-Z0-9-]+/,
    /AFILIACI[OÓ]N/,
    /AUTORIZACI[OÓ]N\s*[:#]?\s*[A-Z0-9]+/,
    /\bLOTE\s*[:#]?\s*\d+/,
    /\bAID\s*[:#]?\s*[A-F0-9]+/,
    /\b(?:VISA|MASTERCARD|AMEX|AMERICAN\s+EXPRESS)\b.*(?:\*{2,}|X{2,}|\d{4})/,
    /COMPRA\s+POS/,
    /VENTA\s+TARJETA/,
  ];
  if (posPatterns.some((regex) => regex.test(text))) {
    return SMART_SCAN_DOCUMENT_TYPES.VOUCHER_POS;
  }

  // 4. Factura / Recibo
  return SMART_SCAN_DOCUMENT_TYPES.INVOICE_RECEIPT;
}

/**
 * Consulta las cuentas activas del workspace (en memoria y opcionalmente en Firestore `accounts`)
 * y verifica si `cuentaIdentificada` coincide con el `accountNumber` o los últimos 4 dígitos.
 *
 * @param {string} cuentaIdentificada
 * @param {Array<object>} localAccounts
 * @param {object} [options]
 * @returns {Promise<{
 *   matched: boolean,
 *   accountId: string,
 *   matchedAccount: object|null,
 *   activeAccounts: Array<object>,
 *   matchedDigits: string
 * }>}
 */
export async function matchAccountFromWorkspace(
  cuentaIdentificada = '',
  localAccounts = [],
  options = {}
) {
  let mergedAccounts = Array.isArray(localAccounts) ? [...localAccounts] : [];

  const { firestoreDb, firestoreModule, workspaceId } = options;
  if (firestoreDb && firestoreModule && workspaceId) {
    try {
      const { collection, getDocs } = firestoreModule;
      if (typeof collection === 'function' && typeof getDocs === 'function') {
        const accountsRef = collection(
          firestoreDb,
          'workspaces',
          String(workspaceId),
          'accounts'
        );
        const snapshot = await getDocs(accountsRef);
        const remoteAccounts = [];
        if (snapshot && typeof snapshot.forEach === 'function') {
          snapshot.forEach((docSnap) => {
            const data = typeof docSnap.data === 'function' ? docSnap.data() : docSnap;
            if (data && (data.id || docSnap.id)) {
              remoteAccounts.push({ id: docSnap.id, ...data });
            }
          });
        } else if (Array.isArray(snapshot?.docs)) {
          for (const docSnap of snapshot.docs) {
            const data = typeof docSnap.data === 'function' ? docSnap.data() : docSnap;
            if (data && (data.id || docSnap.id)) {
              remoteAccounts.push({ id: docSnap.id, ...data });
            }
          }
        }

        if (remoteAccounts.length > 0) {
          const byId = new Map();
          for (const acc of mergedAccounts) {
            if (acc?.id) byId.set(acc.id, acc);
          }
          for (const remoteAcc of remoteAccounts) {
            if (remoteAcc?.id) {
              byId.set(remoteAcc.id, { ...(byId.get(remoteAcc.id) || {}), ...remoteAcc });
            }
          }
          mergedAccounts = Array.from(byId.values());
        }
      }
    } catch {
      // Fallback silencioso a las cuentas locales del estado activo
    }
  }

  const activeAccounts = filterActiveAccounts(mergedAccounts).filter(
    (acc) => acc && !acc.archived && !acc.isArchived
  );
  const rawDigits = String(cuentaIdentificada || '').replace(/\D/g, '');
  const targetLast4 = extractLast4Digits(rawDigits);

  if (!rawDigits || activeAccounts.length === 0) {
    return {
      matched: false,
      accountExists: false,
      accountId: '',
      matchedAccount: null,
      account: null,
      activeAccounts,
      matchedDigits: targetLast4 || rawDigits,
    };
  }

  // 1. Coincidencia exacta por accountNumber completo o sufijo
  const exactMatch = activeAccounts.find((acc) => {
    const accDigits = String(acc.accountNumber || '').replace(/\D/g, '');
    if (!accDigits) return false;
    return accDigits === rawDigits || (rawDigits.length >= 4 && accDigits.endsWith(rawDigits));
  });

  if (exactMatch) {
    return {
      matched: true,
      accountExists: true,
      accountId: exactMatch.id,
      matchedAccount: exactMatch,
      account: exactMatch,
      activeAccounts,
      matchedDigits: targetLast4 || rawDigits,
    };
  }

  // 2. Coincidencia por últimos 4 dígitos de accountNumber o en el nombre de la cuenta
  if (targetLast4.length === 4) {
    const last4Match = activeAccounts.find((acc) => {
      const accLast4 = extractLast4Digits(acc.accountNumber || '');
      if (accLast4 && accLast4 === targetLast4) return true;
      const nameDigits = extractLast4Digits(acc.name || '');
      return nameDigits && nameDigits === targetLast4;
    });

    if (last4Match) {
      return {
        matched: true,
        accountExists: true,
        accountId: last4Match.id,
        matchedAccount: last4Match,
        account: last4Match,
        activeAccounts,
        matchedDigits: targetLast4,
      };
    }
  }

  return {
    matched: false,
    accountExists: false,
    accountId: '',
    matchedAccount: null,
    account: null,
    activeAccounts,
    matchedDigits: targetLast4 || rawDigits,
  };
}

/**
 * Guarda o actualiza en `bank_templates` (IndexedDB local y Firestore) la estructura visual
 * y palabras clave de un Estado de Cuenta procesado exitosamente para futuras lecturas locales
 * con Tesseract.js a costo cero.
 *
 * @param {object} params
 * @returns {Promise<object>}
 */
export async function learnStatementFormatTemplate(params = {}) {
  const rawText = String(params.rawText || '').trim();
  const metadata = detectBankAndAccountMetadata(rawText);
  const bankName = String(params.bankName || metadata.bankName || 'Banco Local').trim();
  const accountNumber = String(params.accountNumber || '').trim();
  const currency = params.currency === 'USD' ? 'USD' : 'HNL';
  const accountTypeLabel = String(
    params.accountType || metadata.accountTypeLabel || 'Cuenta de Ahorro'
  ).trim();

  const bankId =
    String(params.bankId || '').trim() ||
    buildBankTemplateId(`${bankName}_statement`, rawText);

  const existingTemplates = await getAllLocalBankTemplates(params);
  const existing = existingTemplates.find((t) => t.bankId === bankId) || null;

  const baseKeywords = deriveTemplateKeywords(rawText, bankName, [
    { bankName, accountType: accountTypeLabel },
  ]);
  const statementKeywords = [
    bankName,
    'Estado de Cuenta',
    accountTypeLabel,
    ...baseKeywords,
  ].filter(Boolean);

  const mergedKeywords = existing
    ? Array.from(new Set([...(existing.keywords || []), ...statementKeywords])).slice(0, 16)
    : Array.from(new Set(statementKeywords)).slice(0, 16);

  const extractionRules = {
    accountNumber:
      existing?.extractionRules?.accountNumber ||
      '(?:CUENTA|CTA|TARJETA|PRODUCTO)[^\\d]*(\\d{4,20})',
    accountType:
      existing?.extractionRules?.accountType ||
      `(${accountTypeLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|Estado\\s+de\\s+Cuenta)`,
    currency:
      existing?.extractionRules?.currency || '(LPS|HNL|L\\.?|Lempiras|USD|US\\$|\\$)',
    currentBalance:
      existing?.extractionRules?.currentBalance ||
      '(?:LPS|HNL|USD|\\$|L\\.?)*\\s*(\\d{1,3}(?:,\\d{3})+\\.\\d{2}|\\d+\\.\\d{2})',
    statementRowPattern:
      '(\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[/.-]\\d{1,2}(?:[/.-]\\d{2,4})?|[A-Z]{3}[/.-]\\d{1,2})\\s+(.+?)\\s+([+-]?\\d{1,3}(?:,\\d{3})*\\.\\d{2})',
  };

  const templateDoc = normalizeBankTemplate({
    bankId,
    bankName,
    keywords: mergedKeywords,
    extractionRules,
    learnedAccounts: [
      {
        bankName,
        accountType: accountTypeLabel,
        productType: metadata.accountType === 'card' ? 'Tarjeta de Crédito' : 'Ahorro',
        accountNumber,
        currency,
        currentBalance: 0,
      },
    ],
    fingerprint: rawText ? computeLayoutFingerprint(rawText) : existing?.fingerprint || '',
    updatedAt: new Date().toISOString(),
  });

  const saved = await saveBankTemplate(templateDoc, params);
  return {
    ...templateDoc,
    ...saved,
    template: templateDoc,
    learnedTransactionsCount: Array.isArray(params.transactions)
      ? params.transactions.length
      : 0,
  };
}

/**
 * Verifica si un movimiento extraído es un posible duplicado en la cuenta destino
 * (misma fecha, mismo monto y mismo/similar concepto o comercio).
 *
 * @param {object} candidate - { fecha, comercio, monto, moneda }
 * @param {Array<object>} existingTransactions
 * @param {string} [targetAccountId='']
 * @returns {{
 *   isDuplicate: boolean,
 *   matchType: string|null,
 *   duplicateTx: object|null
 * }}
 */
export function detectSmartScanDuplicate(
  candidate,
  existingTransactions = [],
  targetAccountId = ''
) {
  if (!candidate || !Array.isArray(existingTransactions) || existingTransactions.length === 0) {
    return { isDuplicate: false, matchType: null, duplicateTx: null };
  }

  const candidateDate = String(candidate.fecha || candidate.date || '').slice(0, 10);
  const candidateAmount = sanitizeSmartScanAmount(candidate.monto ?? candidate.amount ?? 0);
  const candidateConcept = String(
    candidate.comercio || candidate.concept || candidate.merchant || ''
  )
    .trim()
    .toUpperCase();

  if (!candidateDate || candidateAmount <= 0) {
    return { isDuplicate: false, matchType: null, duplicateTx: null };
  }

  for (const tx of existingTransactions) {
    if (targetAccountId && tx.accountId && tx.accountId !== targetAccountId) {
      continue;
    }
    const txDate = String(tx.date || '').slice(0, 10);
    const txAmount = sanitizeSmartScanAmount(tx.amount);
    if (txDate === candidateDate && Math.abs(txAmount - candidateAmount) < 0.01) {
      const txNote = String(tx.note || tx.merchant || '').trim().toUpperCase();
      const conceptOverlap =
        !candidateConcept ||
        !txNote ||
        txNote.includes(candidateConcept) ||
        candidateConcept.includes(txNote) ||
        candidateConcept
          .split(/\s+/)
          .filter((t) => t.length >= 3)
          .some((token) => txNote.includes(token));

      return {
        isDuplicate: true,
        matchType: conceptOverlap ? 'exact_date_amount_concept' : 'same_date_amount',
        duplicateTx: tx,
      };
    }
  }

  const fallbackDup = findDuplicateTransaction(
    {
      date: candidateDate,
      amount: candidateAmount,
      currency: candidate.moneda || candidate.currency || 'HNL',
      concept: candidateConcept,
    },
    existingTransactions,
    targetAccountId || null
  );

  return fallbackDup;
}

/**
 * Codifica cualquier archivo (`File`, `Blob`, `data:...;base64,...` o objeto con bytes/dataUrl)
 * en un objeto `{ dataUrl, base64Data, mimeType, isPdf, isImage }` apto para vista previa y Gemini 2.5 Flash.
 *
 * @param {File|Blob|string|object} fileOrInput
 * @returns {Promise<{ dataUrl: string, base64Data: string, mimeType: string, isPdf: boolean, isImage: boolean }>}
 */
export async function encodeSmartScanFileToBase64(fileOrInput) {
  if (!fileOrInput) {
    return { dataUrl: '', base64Data: '', mimeType: 'image/png', isPdf: false, isImage: true };
  }

  if (typeof fileOrInput === 'string') {
    const trimmed = fileOrInput.trim();
    const dataMatch = trimmed.match(/^data:([^;]+);base64,(.+)$/);
    if (dataMatch) {
      const mimeType = dataMatch[1].toLowerCase();
      return {
        dataUrl: trimmed,
        base64Data: dataMatch[2],
        mimeType,
        isPdf: mimeType === 'application/pdf',
        isImage: mimeType.startsWith('image/'),
      };
    }
    return {
      dataUrl: '',
      base64Data: '',
      mimeType: 'text/plain',
      isPdf: false,
      isImage: false,
    };
  }

  if (typeof fileOrInput === 'object' && !(typeof Blob !== 'undefined' && fileOrInput instanceof Blob)) {
    if (typeof fileOrInput.originalDataUrl === 'string' && fileOrInput.originalDataUrl.startsWith('data:')) {
      return encodeSmartScanFileToBase64(fileOrInput.originalDataUrl);
    }
    if (typeof fileOrInput.dataUrl === 'string' && fileOrInput.dataUrl.startsWith('data:')) {
      return encodeSmartScanFileToBase64(fileOrInput.dataUrl);
    }
    if (typeof fileOrInput.base64Data === 'string' && fileOrInput.base64Data) {
      const mimeType = String(fileOrInput.type || fileOrInput.mimeType || 'image/png').toLowerCase();
      return {
        dataUrl: `data:${mimeType};base64,${fileOrInput.base64Data}`,
        base64Data: fileOrInput.base64Data,
        mimeType,
        isPdf: mimeType === 'application/pdf',
        isImage: mimeType.startsWith('image/'),
      };
    }
  }

  const fileName = String(fileOrInput.name || '').toLowerCase();
  const rawType = String(fileOrInput.type || '').toLowerCase();
  const isPdf = rawType === 'application/pdf' || fileName.endsWith('.pdf');
  const mimeType = isPdf
    ? 'application/pdf'
    : rawType.startsWith('image/')
      ? rawType
      : fileName.endsWith('.webp')
        ? 'image/webp'
        : fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')
          ? 'image/jpeg'
          : 'image/png';
  const isImage = mimeType.startsWith('image/');

  if (typeof fileOrInput.arrayBuffer === 'function') {
    try {
      const arrayBuffer = await fileOrInput.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let base64Data = '';
      if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
        base64Data = Buffer.from(bytes).toString('base64');
      } else if (typeof btoa === 'function') {
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i += 1) {
          binary += String.fromCharCode(bytes[i]);
        }
        base64Data = btoa(binary);
      }
      if (base64Data) {
        return {
          dataUrl: `data:${mimeType};base64,${base64Data}`,
          base64Data,
          mimeType,
          isPdf,
          isImage,
        };
      }
    } catch {
      // Continuar con FileReader si arrayBuffer falla
    }
  }

  if (
    typeof FileReader !== 'undefined' &&
    typeof Blob !== 'undefined' &&
    fileOrInput instanceof Blob
  ) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || '');
        const base64Data = dataUrl.replace(/^data:[^;]+;base64,/, '');
        resolve({ dataUrl, base64Data, mimeType, isPdf, isImage });
      };
      reader.onerror = () =>
        resolve({ dataUrl: '', base64Data: '', mimeType, isPdf, isImage });
      reader.readAsDataURL(fileOrInput);
    });
  }

  return { dataUrl: '', base64Data: '', mimeType, isPdf, isImage };
}

/**
 * Genera una miniatura SVG codificada en Base64 como respaldo cuando el entorno no dispone de Canvas 2D.
 * @param {string} [label='PDF']
 * @returns {string}
 */
function buildFallbackPdfThumbnailDataUrl(label = 'Documento PDF') {
  const safeLabel = String(label || 'Documento PDF')
    .replace(/[<>&"']/g, '')
    .slice(0, 28);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="460" viewBox="0 0 360 460"><rect width="360" height="460" rx="16" fill="#0f172a"/><rect x="28" y="28" width="304" height="404" rx="10" fill="#1e293b" stroke="#38bdf8" stroke-width="2"/><rect x="56" y="64" width="92" height="34" rx="6" fill="#ef4444"/><text x="102" y="87" fill="#ffffff" font-family="sans-serif" font-size="16" font-weight="bold" text-anchor="middle">PDF</text><line x1="56" y1="132" x2="304" y2="132" stroke="#475569" stroke-width="8" stroke-linecap="round"/><line x1="56" y1="164" x2="268" y2="164" stroke="#475569" stroke-width="8" stroke-linecap="round"/><line x1="56" y1="196" x2="290" y2="196" stroke="#475569" stroke-width="8" stroke-linecap="round"/><line x1="56" y1="228" x2="220" y2="228" stroke="#475569" stroke-width="8" stroke-linecap="round"/><text x="180" y="380" fill="#e2e8f0" font-family="sans-serif" font-size="14" text-anchor="middle">${safeLabel}</text></svg>`;
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
  }
  if (typeof btoa === 'function') {
    return `data:image/svg+xml;base64,${btoa(svg)}`;
  }
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * Extrae bytes `Uint8Array` desde un archivo PDF (`File`, `Blob`, `ArrayBuffer`, `Uint8Array` o Data URL).
 * @param {File|Blob|ArrayBuffer|Uint8Array|string|object} pdfFileOrInput
 * @returns {Promise<Uint8Array|null>}
 */
async function extractPdfBinaryBytes(pdfFileOrInput) {
  if (!pdfFileOrInput) return null;
  if (pdfFileOrInput instanceof Uint8Array) return pdfFileOrInput;
  if (typeof ArrayBuffer !== 'undefined' && pdfFileOrInput instanceof ArrayBuffer) {
    return new Uint8Array(pdfFileOrInput);
  }
  if (typeof pdfFileOrInput.arrayBuffer === 'function') {
    const ab = await pdfFileOrInput.arrayBuffer();
    return new Uint8Array(ab);
  }
  const encoded = await encodeSmartScanFileToBase64(pdfFileOrInput);
  if (encoded.base64Data) {
    if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
      return new Uint8Array(Buffer.from(encoded.base64Data, 'base64'));
    }
    if (typeof atob === 'function') {
      const bin = atob(encoded.base64Data);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) {
        out[i] = bin.charCodeAt(i);
      }
      return out;
    }
  }
  return null;
}

/**
 * Renderiza la primera página de un archivo `.pdf` dentro de un `<canvas>` de HTML5
 * utilizando `pdfjs-dist` (PDF.js open-source de Mozilla) y la convierte en miniatura/imagen
 * Data URL (`image/png`) para mostrarla en el contenedor de vista previa compartido.
 *
 * @param {File|Blob|ArrayBuffer|Uint8Array|string|object} pdfFileOrInput
 * @param {object} [options]
 * @param {HTMLCanvasElement} [options.canvas]
 * @param {Document} [options.doc]
 * @param {object} [options.pdfjsLib]
 * @param {number} [options.scale=1.6]
 * @returns {Promise<{
 *   thumbnailDataUrl: string,
 *   previewDataUrl: string,
 *   width: number,
 *   height: number,
 *   pageCount: number,
 *   digitalText: string,
 *   renderedOnCanvas: boolean
 * }>}
 */
export async function renderPdfFirstPageThumbnail(pdfFileOrInput, options = {}) {
  const fileLabel = String(pdfFileOrInput?.name || 'Documento PDF');
  const fallbackThumb = buildFallbackPdfThumbnailDataUrl(fileLabel);

  try {
    const pdfBytes = await extractPdfBinaryBytes(pdfFileOrInput);
    const pdfjsLib =
      options.pdfjsLib ||
      (typeof globalThis !== 'undefined' ? globalThis.__PISTO_PDFJS_LIB__ : null) ||
      (await import(PDFJS_CDN_ESM_URL));

    if (pdfjsLib?.GlobalWorkerOptions && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_CDN_URL;
    }

    const getDocTask = pdfjsLib.getDocument(
      pdfBytes ? { data: pdfBytes } : { url: String(pdfFileOrInput) }
    );
    const pdfDoc = await (getDocTask.promise || getDocTask);
    const page = await pdfDoc.getPage(1);
    const scale = typeof options.scale === 'number' && options.scale > 0 ? options.scale : 1.6;
    const viewport = page.getViewport({ scale });

    const targetDoc =
      options.doc || (typeof document !== 'undefined' ? document : null);
    const canvas =
      options.canvas ||
      (targetDoc && typeof targetDoc.createElement === 'function'
        ? targetDoc.createElement('canvas')
        : null);

    let thumbnailDataUrl = fallbackThumb;
    let renderedOnCanvas = false;
    const width = Math.max(1, Math.round(viewport?.width || 600));
    const height = Math.max(1, Math.round(viewport?.height || 800));

    if (canvas) {
      canvas.width = width;
      canvas.height = height;
      const ctx =
        typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
      if (ctx && typeof page.render === 'function') {
        const renderTask = page.render({ canvasContext: ctx, viewport });
        await (renderTask?.promise || renderTask);
        if (typeof canvas.toDataURL === 'function') {
          const candidateUrl = canvas.toDataURL('image/png');
          if (typeof candidateUrl === 'string' && candidateUrl.startsWith('data:image/')) {
            thumbnailDataUrl = candidateUrl;
            renderedOnCanvas = true;
          }
        }
      }
    }

    let digitalText = '';
    if (typeof page.getTextContent === 'function') {
      try {
        const textContent = await page.getTextContent();
        if (Array.isArray(textContent?.items)) {
          digitalText = textContent.items.map((item) => item.str || '').join('\n').trim();
        }
      } catch {
        digitalText = '';
      }
    }

    return {
      thumbnailDataUrl,
      previewDataUrl: thumbnailDataUrl,
      width,
      height,
      pageCount: Number(pdfDoc?.numPages) || 1,
      digitalText,
      pageText: digitalText,
      renderedOnCanvas,
    };
  } catch {
    return {
      thumbnailDataUrl: fallbackThumb,
      previewDataUrl: fallbackThumb,
      width: 360,
      height: 460,
      pageCount: 1,
      digitalText: '',
      pageText: '',
      renderedOnCanvas: false,
    };
  }
}

/**
 * Resuelve la clave API de Gemini configurada en el proyecto (opciones explícitas,
 * almacenamiento local del perfil de usuario o variable global).
 *
 * @param {object} [options]
 * @returns {string}
 */
export function resolveConfiguredGeminiApiKey(options = {}) {
  const direct = String(options.geminiApiKey || options.apiKey || '').trim();
  if (direct) return direct;

  const storage =
    options.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (storage && typeof storage.getItem === 'function') {
    const k1 = String(storage.getItem('pisto_user_gemini_api_key_v1') || '').trim();
    if (k1) return k1;
    const k2 = String(storage.getItem('pisto_gemini_api_key_v1') || '').trim();
    if (k2) return k2;
  }

  if (typeof globalThis !== 'undefined') {
    const globalKey = String(
      globalThis.__PISTO_GEMINI_API_KEY__ || globalThis.GEMINI_API_KEY || ''
    ).trim();
    if (globalKey) return globalKey;
  }

  return '';
}

/**
 * Normaliza la respuesta JSON de Gemini 2.5 Flash para garantizar compatibilidad tanto
 * con las claves del JSON Schema (`bankName`, `documentType`, `date`, `amount`, `currency`,
 * `accountNumber`, `merchant`, `suggestedCategory`, `transactions`) como con los alias en español (`banco`,
 * `tipoDocumento`, `fecha`, `monto`, `moneda`, `cuentaIdentificada`, `comercio`, `categoriaSugerida`).
 *
 * @param {object} rawObj
 * @returns {object|null}
 */
export function normalizeGeminiSmartScanPayload(rawObj) {
  if (!rawObj || typeof rawObj !== 'object') return null;

  const bankName = String(
    rawObj.bankName ||
      rawObj.banco ||
      rawObj.accountsList?.[0]?.bankName ||
      'Banco Local'
  ).trim();

  const rawTxList = Array.isArray(rawObj.transactions)
    ? rawObj.transactions
    : Array.isArray(rawObj.transactionsList)
      ? rawObj.transactionsList
      : Array.isArray(rawObj.detectedTransactions)
        ? rawObj.detectedTransactions
        : [];

  const normalizedTransactions = rawTxList
    .map((tx, idx) => {
      const txDate = normalizeSmartScanDate(tx.date || tx.fecha || rawObj.date || rawObj.fecha);
      const txMerchant = String(
        tx.merchant || tx.comercio || tx.concept || tx.description || 'Movimiento'
      ).trim();
      const txAmount = sanitizeSmartScanAmount(tx.amount ?? tx.monto ?? 0);
      const txCurrency =
        String(tx.currency || tx.moneda || rawObj.currency || rawObj.moneda || 'HNL')
          .toUpperCase()
          .includes('USD')
          ? 'USD'
          : 'HNL';
      const rawType = String(tx.type || tx.tipo || 'expense').toLowerCase();
      const txType =
        rawType === 'income' || rawType === 'ingreso' || rawType === 'credit' || rawType === 'credito'
          ? TRANSACTION_TYPES.INCOME
          : TRANSACTION_TYPES.EXPENSE;
      const inferredRowCat = inferSmartScanCategory(
        txMerchant,
        txMerchant,
        txType,
        [],
        tx.suggestedCategory || tx.categoriaSugerida || ''
      );

      return {
        id: tx.id || `stmt_tx_${idx + 1}`,
        selected: tx.selected !== false,
        date: txDate,
        fecha: txDate,
        merchant: txMerchant,
        comercio: txMerchant,
        concept: txMerchant,
        amount: txAmount,
        monto: txAmount,
        currency: txCurrency,
        moneda: txCurrency,
        type: txType,
        tipo: txType,
        categoryId: tx.categoryId || inferredRowCat.categoryId,
        categoriaSugerida:
          tx.categoriaSugerida || tx.suggestedCategory || inferredRowCat.categoriaSugerida,
      };
    })
    .filter((tx) => tx.amount > 0);

  const validDocTypes = Object.values(SMART_SCAN_DOCUMENT_TYPES);
  let documentType = String(rawObj.documentType || rawObj.tipoDocumento || '').trim();
  if (normalizedTransactions.length >= 2) {
    documentType = SMART_SCAN_DOCUMENT_TYPES.BANK_STATEMENT;
  } else if (!validDocTypes.includes(documentType)) {
    documentType = classifySmartScanDocumentType(
      `${documentType} ${bankName} ${rawObj.merchant || rawObj.comercio || ''}`,
      normalizedTransactions
    );
  }

  const date = normalizeSmartScanDate(
    rawObj.date || rawObj.fecha || normalizedTransactions[0]?.date
  );
  const amount = sanitizeSmartScanAmount(
    rawObj.amount ??
      rawObj.monto ??
      rawObj.currentBalance ??
      rawObj.accountsList?.[0]?.currentBalance ??
      normalizedTransactions[0]?.amount ??
      0
  );
  const rawCurrency = String(
    rawObj.currency ||
      rawObj.moneda ||
      rawObj.accountsList?.[0]?.currency ||
      normalizedTransactions[0]?.currency ||
      'HNL'
  ).toUpperCase();
  const currency = rawCurrency === 'USD' || rawCurrency === 'US$' || rawCurrency === '$' ? 'USD' : 'HNL';

  const accountNumber = extractIdentifiedAccountNumber(
    String(
      rawObj.accountNumber ||
        rawObj.cuentaIdentificada ||
        rawObj.accountsList?.[0]?.accountNumber ||
        ''
    ),
    String(rawObj.accountNumber || rawObj.cuentaIdentificada || '')
  );

  const merchant = String(
    rawObj.merchant ||
      rawObj.comercio ||
      normalizedTransactions[0]?.merchant ||
      bankName ||
      'Comercio / Movimiento'
  ).trim();

  const txType = getTransactionTypeForDocument(documentType);
  const inferredMainCat = inferSmartScanCategory(
    merchant,
    `${merchant} ${bankName}`,
    txType,
    [],
    rawObj.suggestedCategory || rawObj.categoriaSugerida || ''
  );

  return {
    bankName,
    banco: bankName,
    documentType,
    tipoDocumento: documentType,
    date,
    fecha: date,
    merchant,
    comercio: merchant,
    amount,
    monto: amount,
    currency,
    moneda: currency,
    accountNumber,
    cuentaIdentificada: accountNumber,
    categoryId: rawObj.categoryId || inferredMainCat.categoryId,
    categoriaSugerida:
      rawObj.categoriaSugerida ||
      rawObj.suggestedCategory ||
      inferredMainCat.categoriaSugerida,
    suggestedCategory:
      rawObj.suggestedCategory ||
      rawObj.categoriaSugerida ||
      inferredMainCat.categoriaSugerida,
    transactions: normalizedTransactions,
  };
}

/**
 * Paso 2 (Fallback / Respaldo con Gemini 2.5 Flash API):
 * Envía la imagen o PDF codificado en Base64 a la API de Gemini 2.5 Flash (`gemini-2.5-flash`)
 * utilizando un prompt estructurado y `SMART_SCAN_GEMINI_JSON_SCHEMA` para forzar la extracción de:
 * `bankName`, `documentType`, `date`, `amount`, `currency`, `accountNumber`, `merchant` y `transactions`.
 *
 * @param {string|File|Blob} dataUrlOrFile
 * @param {string} [apiKey]
 * @param {typeof fetch} [fetchImpl]
 * @param {object} [options]
 * @returns {Promise<object|null>}
 */
export async function extractWithGeminiVision(
  dataUrlOrFile,
  apiKey = '',
  fetchImpl = globalThis.fetch,
  options = {}
) {
  if (!dataUrlOrFile || typeof fetchImpl !== 'function') return null;

  const encoded = await encodeSmartScanFileToBase64(dataUrlOrFile);
  if (!encoded.base64Data) return null;

  const resolvedKey = String(apiKey || resolveConfiguredGeminiApiKey(options)).trim();
  const model = String(options.model || SMART_SCAN_GEMINI_MODEL).trim() || SMART_SCAN_GEMINI_MODEL;

  const prompt = [
    'Eres un motor experto de extracción financiera y bancaria para Honduras y Latinoamérica.',
    'Analiza la imagen o documento PDF adjunto y extrae los datos respondiendo estrictamente en JSON según el esquema requerido.',
    'Reglas obligatorias:',
    '1. `bankName`: Nombre del banco o entidad financiera (ej. "BAC Credomatic", "Banco Atlántida", "Banco Ficohsa", "Banpaís", "Banco de Occidente", "Davivienda", "Lafise").',
    '2. `documentType`: Clasifica en uno de: "Voucher POS", "Factura/Recibo", "Comprobante de Crédito (Ingreso)", "Comprobante de Débito (Gasto)", o "Estado de Cuenta (Múltiples Movimientos)".',
    '3. `date`: Fecha en formato YYYY-MM-DD (convierte DD/MM/YYYY a YYYY-MM-DD).',
    '4. `amount`: Monto numérico en punto flotante sanitizando comas de miles (ej. "3,901.33" -> 3901.33; jamás pierdas dígitos a la izquierda de la coma).',
    '5. `currency`: "HNL" para Lempiras (L / LPS) o "USD" para Dólares ($ / US$).',
    '6. `accountNumber`: Número de cuenta bancaria completo o los últimos 4 dígitos de la tarjeta.',
    '7. `merchant`: Nombre del comercio, establecimiento o concepto de la transacción.',
    '8. `transactions`: Si es un Estado de Cuenta con múltiples movimientos, incluye todas las filas con `{ date, merchant, amount, type ("income"|"expense"), currency }`.',
  ].join('\n');

  // 1. Llamada directa a Gemini 2.5 Flash API con JSON Schema estructurado
  if (resolvedKey) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(resolvedKey)}`;
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                {
                  inline_data: {
                    mime_type: encoded.mimeType,
                    data: encoded.base64Data,
                  },
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
            responseSchema: SMART_SCAN_GEMINI_JSON_SCHEMA,
          },
        }),
      });

      if (response.ok) {
        const payload = await response.json();
        const textOut = payload?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const jsonMatch = textOut.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsedObj = JSON.parse(jsonMatch[0]);
          return normalizeGeminiSmartScanPayload(parsedObj);
        }
      }
    } catch {
      // Continuar con respaldo del endpoint del proyecto si aplica
    }
  }

  // 2. Respaldo mediante el endpoint configurado en el servidor del proyecto (`/api/ai/scan-account`)
  if (options.allowServerEndpointFallback !== false) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (resolvedKey) {
        headers['x-gemini-api-key'] = resolvedKey;
      }
      const serverRes = await fetchImpl('/api/ai/scan-account', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          imageBase64: encoded.base64Data,
          mimeType: encoded.mimeType,
          ocrTextFallback: options.ocrTextFallback || '',
          fewShotPrompt: prompt,
          apiKey: resolvedKey || undefined,
        }),
      });
      if (serverRes && serverRes.ok) {
        const serverBody = await serverRes.json();
        const rawData = serverBody?.data || serverBody;
        if (rawData && typeof rawData === 'object') {
          return normalizeGeminiSmartScanPayload(rawData);
        }
      }
    } catch {
      // Sin conexión al endpoint local
    }
  }

  return null;
}

/**
 * Paso 1 (Prioridad Local OCR - Tesseract.js):
 * Inicializa el worker de Tesseract.js (o PDF.js para PDFs digitales/escaneados) para extraer
 * el texto plano del documento en el cliente sin bloquear ni romper el flujo si el worker falla.
 *
 * @param {File|Blob|object} fileOrInput
 * @param {object} [state]
 * @param {object} [options]
 * @param {Function} [onProgress]
 * @returns {Promise<{
 *   rawText: string,
 *   confidence: number|null,
 *   originalDataUrl: string|null,
 *   preprocessedDataUrl: string|null,
 *   hadError: boolean
 * }>}
 */
export async function runLocalTesseractOcrStage(
  fileOrInput,
  state = {},
  options = {},
  onProgress = () => {}
) {
  onProgress(LOCAL_OCR_LOADING_STATUS, 15);

  const encoded = await encodeSmartScanFileToBase64(fileOrInput);
  const fileName = String(fileOrInput?.name || '').toLowerCase();
  const mimeType = String(fileOrInput?.type || encoded.mimeType || '').toLowerCase();
  const isPdf = mimeType === 'application/pdf' || fileName.endsWith('.pdf');

  let originalDataUrl = encoded.dataUrl || null;
  let preprocessedDataUrl = encoded.dataUrl || null;
  let thumbnailDataUrl = encoded.isImage ? encoded.dataUrl || null : null;
  let pdfThumbResult = null;

  if (isPdf) {
    pdfThumbResult = await renderPdfFirstPageThumbnail(fileOrInput, options);
    if (pdfThumbResult?.thumbnailDataUrl) {
      thumbnailDataUrl = pdfThumbResult.thumbnailDataUrl;
      originalDataUrl = pdfThumbResult.thumbnailDataUrl;
      preprocessedDataUrl = pdfThumbResult.thumbnailDataUrl;
    }
  }

  // 1. Soporte para runner/worker inyectado (pruebas unitarias o worker pre-inicializado)
  if (typeof options.localOcrRunner === 'function') {
    try {
      const customRes = await options.localOcrRunner(fileOrInput, onProgress);
      const text =
        typeof customRes === 'string'
          ? customRes
          : String(customRes?.text || customRes?.rawText || pdfThumbResult?.digitalText || '');
      const confidence =
        typeof customRes?.confidence === 'number' ? customRes.confidence : null;
      const resolvedThumb =
        customRes?.thumbnailDataUrl ||
        customRes?.originalDataUrl ||
        thumbnailDataUrl ||
        originalDataUrl;
      return {
        rawText: text.trim(),
        confidence,
        thumbnailDataUrl: resolvedThumb,
        originalDataUrl: resolvedThumb,
        preprocessedDataUrl: customRes?.preprocessedDataUrl || preprocessedDataUrl || resolvedThumb,
        hadError: false,
      };
    } catch {
      return {
        rawText: pdfThumbResult?.digitalText || '',
        confidence: pdfThumbResult?.digitalText ? 85 : 0,
        thumbnailDataUrl: thumbnailDataUrl || originalDataUrl,
        originalDataUrl: thumbnailDataUrl || originalDataUrl,
        preprocessedDataUrl,
        hadError: !pdfThumbResult?.digitalText,
      };
    }
  }

  if (options.tesseractWorker && typeof options.tesseractWorker.recognize === 'function') {
    try {
      const targetSource = thumbnailDataUrl || originalDataUrl || fileOrInput;
      const recognition = await options.tesseractWorker.recognize(targetSource);
      const text = String(
        recognition?.data?.text ?? recognition?.text ?? pdfThumbResult?.digitalText ?? ''
      ).trim();
      const confidence =
        typeof recognition?.data?.confidence === 'number'
          ? recognition.data.confidence
          : typeof recognition?.confidence === 'number'
            ? recognition.confidence
            : null;
      if (typeof options.tesseractWorker.terminate === 'function' && options.terminateInjectedWorker) {
        await options.tesseractWorker.terminate();
      }
      return {
        rawText: text,
        confidence,
        thumbnailDataUrl: thumbnailDataUrl || originalDataUrl,
        originalDataUrl: thumbnailDataUrl || originalDataUrl,
        preprocessedDataUrl,
        hadError: false,
      };
    } catch {
      return {
        rawText: pdfThumbResult?.digitalText || '',
        confidence: 0,
        thumbnailDataUrl: thumbnailDataUrl || originalDataUrl,
        originalDataUrl: thumbnailDataUrl || originalDataUrl,
        preprocessedDataUrl,
        hadError: true,
      };
    }
  }

  // 2. Ejecución en cliente con Tesseract.js / PDF.js
  try {
    const progressAdapter = (_msg, pct) => {
      const mappedPct =
        typeof pct === 'number' ? Math.max(15, Math.min(58, Math.round(pct * 0.55))) : 35;
      onProgress(LOCAL_OCR_LOADING_STATUS, mappedPct);
    };

    if (isPdf) {
      // 1. Extracción nativa de capa de texto en PDF mediante pdfjs-dist (todas las páginas)
      const nativePdfLayer = await extractNativePdfTextLayer(fileOrInput, options);
      const nativeFullText = String(
        nativePdfLayer?.fullText || pdfThumbResult?.digitalText || ''
      ).trim();

      // Si el texto extraído tiene más de 50 caracteres (PDF vectorial nativo), omitir Tesseract.js
      if (nativeFullText.length > VECTOR_PDF_MIN_CHARS) {
        const resolvedNativeThumb =
          nativePdfLayer?.thumbnailDataUrl || thumbnailDataUrl || originalDataUrl;
        return {
          rawText: nativeFullText,
          confidence: 95,
          thumbnailDataUrl: resolvedNativeThumb,
          originalDataUrl: resolvedNativeThumb,
          preprocessedDataUrl: preprocessedDataUrl || resolvedNativeThumb,
          hadError: false,
          isVectorPdf: true,
          skipTesseractOcr: true,
        };
      }

      let decoded = null;
      let stmtDecoded = null;
      try {
        decoded = await decodeVoucherFile(fileOrInput, state, progressAdapter);
      } catch {
        decoded = null;
      }
      try {
        stmtDecoded = await decodeBankStatementPdf(
          fileOrInput,
          state,
          options,
          progressAdapter
        );
      } catch {
        stmtDecoded = null;
      }

      const textA = String(decoded?.rawText || '').trim();
      const textB = String(stmtDecoded?.rawText || '').trim();
      const textC = nativeFullText;
      const combinedPdfText = [textA, textB, textC].sort((a, b) => b.length - a.length)[0] || '';
      const resolvedPdfThumb =
        decoded?.originalDataUrl || thumbnailDataUrl || originalDataUrl;

      return {
        rawText: combinedPdfText,
        confidence: combinedPdfText.length >= 15 ? 88 : 0,
        thumbnailDataUrl: resolvedPdfThumb,
        originalDataUrl: resolvedPdfThumb,
        preprocessedDataUrl: decoded?.processedDataUrl || preprocessedDataUrl || resolvedPdfThumb,
        hadError: !combinedPdfText,
      };
    }

    const decodedImg = await decodeVoucherFile(fileOrInput, state, progressAdapter);
    const rawText = String(decodedImg?.rawText || '').trim();
    const resolvedImgThumb = decodedImg?.originalDataUrl || thumbnailDataUrl || originalDataUrl;
    return {
      rawText,
      confidence: rawText.length >= 12 ? 85 : 0,
      thumbnailDataUrl: resolvedImgThumb,
      originalDataUrl: resolvedImgThumb,
      preprocessedDataUrl: decodedImg?.processedDataUrl || preprocessedDataUrl,
      hadError: false,
    };
  } catch {
    // Si decodeVoucherFile falla (ej. entorno sin Canvas o worker CDN bloqueado), intentar Tesseract.js directo
    try {
      const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
      if (isBrowser && (thumbnailDataUrl || originalDataUrl || fileOrInput)) {
        const TesseractModule = await import('https://cdn.jsdelivr.net/npm/tesseract.js@5/+esm');
        const Tesseract = TesseractModule.default || TesseractModule;
        const worker = await Tesseract.createWorker('spa+eng', 1);
        try {
          const rec = await worker.recognize(thumbnailDataUrl || originalDataUrl || fileOrInput);
          const text = String(rec?.data?.text || pdfThumbResult?.digitalText || '').trim();
          const conf = typeof rec?.data?.confidence === 'number' ? rec.data.confidence : null;
          return {
            rawText: text,
            confidence: conf,
            thumbnailDataUrl: thumbnailDataUrl || originalDataUrl,
            originalDataUrl: thumbnailDataUrl || originalDataUrl,
            preprocessedDataUrl,
            hadError: false,
          };
        } finally {
          await worker.terminate();
        }
      }
    } catch {
      // Fallback limpio al Paso 2 (Gemini 2.5 Flash)
    }

    const fallbackText = String(pdfThumbResult?.digitalText || '').trim();
    return {
      rawText: fallbackText,
      confidence: fallbackText.length >= 15 ? 85 : 0,
      thumbnailDataUrl: thumbnailDataUrl || originalDataUrl,
      originalDataUrl: thumbnailDataUrl || originalDataUrl,
      preprocessedDataUrl,
      hadError: !fallbackText,
    };
  }
}

/**
 * Analiza texto crudo de un documento, comprobante o Estado de Cuenta y construye
 * el resultado normalizado del Motor Unificado de Clasificación y OCR.
 * Garantiza la devolución estricta de:
 * - `comercio`
 * - `fecha` (YYYY-MM-DD)
 * - `monto` (float limpio sin comas de miles)
 * - `moneda` (HNL / USD)
 * - `cuentaIdentificada`
 * - `categoriaSugerida`
 *
 * @param {string} rawText
 * @param {object} [state]
 * @param {object} [options]
 * @returns {object}
 */
export function parseSmartScanText(rawText = '', state = {}, options = {}) {
  const parsedVoucher = parseVoucherText(rawText, state);
  const regexCleaners = applySmartScanRegexCleaners(rawText, state);
  const statementRows = extractStatementTransactionsFromText(rawText, state, options);
  const tipoDocumento = classifySmartScanDocumentType(rawText, statementRows);
  const tipoTransaccion = getTransactionTypeForDocument(tipoDocumento);
  const monto = sanitizeSmartScanAmount(
    parsedVoucher.amount > 0 ? parsedVoucher.amount : regexCleaners.amount
  );
  const fecha = normalizeSmartScanDate(
    regexCleaners.hasExplicitDate
      ? regexCleaners.date
      : parsedVoucher.date || statementRows[0]?.fecha || new Date().toISOString().slice(0, 10)
  );
  const comercio = String(
    parsedVoucher.merchant ||
      statementRows[0]?.comercio ||
      regexCleaners.merchant ||
      'Comercio / Movimiento'
  ).trim();
  const moneda =
    parsedVoucher.currency === 'USD' ||
    regexCleaners.currency === 'USD' ||
    statementRows[0]?.moneda === 'USD'
      ? 'USD'
      : 'HNL';
  const cuentaIdentificada =
    regexCleaners.accountNumber ||
    extractIdentifiedAccountNumber(rawText, parsedVoucher.cardLast4);

  // Consultar plantillas aprendidas en bank_templates (localStorage / IndexedDB) y plantillas de Estado de Cuenta
  const localTemplates = getLocalBankTemplatesSync(options?.storage);
  const matchedTemplate = matchBankTemplateFromText(rawText, localTemplates);
  const matchedStmtTemplate = matchStatementTemplate(rawText, [
    ...DEFAULT_STATEMENT_TEMPLATES,
    ...(Array.isArray(localTemplates) ? localTemplates : []),
  ]);
  const extractedStmt = matchedStmtTemplate
    ? extractStatementWithTemplate(rawText, matchedStmtTemplate)
    : null;

  const bankMetadata = detectBankAndAccountMetadata(rawText);
  const detectedBank =
    matchedTemplate?.bankName ||
    parsedVoucher.detectedBank ||
    bankMetadata.bankName ||
    extractedStmt?.bankName ||
    'Banco Local';
  const detectedAccountType =
    extractedStmt?.accountInfo?.creditLimit > 0 ? 'card' : bankMetadata.accountType;
  const detectedAccountTypeLabel =
    extractedStmt?.accountInfo?.accountName ||
    matchedTemplate?.learnedAccounts?.[0]?.accountType ||
    bankMetadata.accountTypeLabel;

  const resolvedCuentaIdentificada =
    cuentaIdentificada || extractedStmt?.accountInfo?.accountNumber || '';
  const accountInfo = {
    accountName: extractedStmt?.accountInfo?.accountName || detectedAccountTypeLabel,
    accountNumber: resolvedCuentaIdentificada,
    owner: extractedStmt?.accountInfo?.owner || '',
    cutoffDate: extractedStmt?.accountInfo?.cutoffDate || '',
    paymentDueDate: extractedStmt?.accountInfo?.paymentDueDate || '',
    currency: extractedStmt?.accountInfo?.currency || moneda,
    currentBalance:
      extractedStmt?.accountInfo?.currentBalance > 0
        ? extractedStmt.accountInfo.currentBalance
        : monto,
    minimumPayment: extractedStmt?.accountInfo?.minimumPayment || 0,
    creditLimit: extractedStmt?.accountInfo?.creditLimit || 0,
  };

  if (
    statementRows.length === 0 &&
    Array.isArray(extractedStmt?.transactions) &&
    extractedStmt.transactions.length > 0
  ) {
    for (const tx of extractedStmt.transactions) {
      const rowCat = inferSmartScanCategory(
        tx.concept,
        tx.concept,
        tx.type === 'income' ? TRANSACTION_TYPES.INCOME : TRANSACTION_TYPES.EXPENSE,
        state?.categories || []
      );
      statementRows.push({
        id: `stmt_tx_${statementRows.length + 1}`,
        selected: true,
        fecha: tx.date,
        date: tx.date,
        time: tx.time || '12:00 AM',
        comercio: tx.concept,
        concept: tx.concept,
        monto: tx.amount,
        amount: tx.amount,
        moneda: tx.currency || moneda,
        currency: tx.currency || moneda,
        tipo: tx.type === 'income' ? TRANSACTION_TYPES.INCOME : TRANSACTION_TYPES.EXPENSE,
        type: tx.type === 'income' ? TRANSACTION_TYPES.INCOME : TRANSACTION_TYPES.EXPENSE,
        categoryId: rowCat.categoryId,
        categoriaSugerida: rowCat.categoriaSugerida,
        isDuplicate: false,
      });
    }
  }

  const activeAccounts = filterActiveAccounts(
    Array.isArray(state?.accounts) ? state.accounts : []
  ).filter((acc) => acc && !acc.archived && !acc.isArchived);
  const rawDigits = String(resolvedCuentaIdentificada || '').replace(/\D/g, '');
  const targetLast4 = extractLast4Digits(rawDigits);
  let matchedAccount = null;
  if (rawDigits && activeAccounts.length > 0) {
    matchedAccount =
      activeAccounts.find((acc) => {
        const accDigits = String(acc.accountNumber || '').replace(/\D/g, '');
        return (
          accDigits &&
          (accDigits === rawDigits || (rawDigits.length >= 4 && accDigits.endsWith(rawDigits)))
        );
      }) ||
      (targetLast4.length === 4
        ? activeAccounts.find((acc) => {
            const accLast4 = extractLast4Digits(acc.accountNumber || '');
            if (accLast4 && accLast4 === targetLast4) return true;
            const nameDigits = extractLast4Digits(acc.name || '');
            return nameDigits && nameDigits === targetLast4;
          })
        : null) ||
      null;
  }

  const accountMatch = {
    matched: Boolean(matchedAccount),
    accountId: matchedAccount?.id || '',
    matchedAccount,
    activeAccounts,
    matchedDigits: targetLast4 || rawDigits,
  };

  const resolvedAccountId = accountMatch.matched
    ? accountMatch.accountId
    : options.preferredAccountId || '';

  const inferredCategory = inferSmartScanCategory(
    comercio,
    rawText,
    tipoTransaccion,
    state?.categories || []
  );

  let categoryId = inferredCategory.categoryId || parsedVoucher.categoryId || 'groceries';
  let categoriaSugerida =
    inferredCategory.categoriaSugerida ||
    CATEGORY_ID_TO_LABEL[categoryId] ||
    'Supermercado';

  if (tipoTransaccion === TRANSACTION_TYPES.INCOME && categoryId === 'groceries') {
    const incomeCat = (state?.categories || []).find((c) => c.type === TRANSACTION_TYPES.INCOME);
    categoryId = incomeCat?.id || 'salary';
    categoriaSugerida = incomeCat?.name || 'Salario';
  }

  const duplicateCheck = detectSmartScanDuplicate(
    { fecha, comercio, monto, moneda },
    state?.transactions || [],
    resolvedAccountId
  );

  const isMultiRowStatement =
    tipoDocumento === SMART_SCAN_DOCUMENT_TYPES.BANK_STATEMENT || statementRows.length >= 2;

  return {
    fecha,
    date: fecha,
    hasExplicitDate: regexCleaners.hasExplicitDate,
    comercio,
    merchant: comercio,
    monto,
    amount: monto,
    moneda,
    currency: moneda,
    tipoDocumento,
    documentType: tipoDocumento,
    statementDocumentType: extractedStmt?.documentType || tipoDocumento,
    tipoTransaccion,
    cuentaIdentificada: resolvedCuentaIdentificada,
    accountNumber: resolvedCuentaIdentificada,
    accountInfo,
    creditLimit: accountInfo.creditLimit,
    minimumPayment: accountInfo.minimumPayment,
    cutoffDate: accountInfo.cutoffDate,
    paymentDueDate: accountInfo.paymentDueDate,
    owner: accountInfo.owner,
    categoryId,
    categoriaSugerida,
    suggestedCategory: categoriaSugerida,
    accountId: resolvedAccountId,
    accountMatch,
    accountExists: Boolean(accountMatch.matched),
    isDuplicate: duplicateCheck.isDuplicate,
    duplicateType: duplicateCheck.matchType,
    duplicateTx: duplicateCheck.duplicateTx,
    detectedBank,
    bancoDetectado: detectedBank,
    bankName: detectedBank,
    detectedAccountType,
    detectedAccountTypeLabel,
    matchedTemplateId:
      matchedStmtTemplate?.bankId || matchedTemplate?.bankId || null,
    breakdown: parsedVoucher.breakdown || { subtotal: 0, isv: 0, devolIsv: 0 },
    statementItems: statementRows,
    statementTransactions: statementRows,
    transactions: statementRows,
    isMultiRowStatement,
    extractionSource: 'local-ocr',
    usedGeminiFallback: false,
    rawText,
  };
}

/**
 * Aplica los campos extraídos por Gemini 2.5 Flash sobre el objeto `parsed` y re-sincroniza
 * la asociación de cuenta en Firestore (`matchAccountFromWorkspace`) y la detección de duplicados.
 *
 * @param {object} parsed
 * @param {object} geminiData
 * @param {object} [state]
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function mergeGeminiResultIntoParsed(parsed, geminiData, state = {}, options = {}) {
  const normalizedGemini = normalizeGeminiSmartScanPayload(geminiData);
  if (!normalizedGemini) return parsed;

  if (normalizedGemini.fecha) {
    parsed.fecha = normalizedGemini.fecha;
    parsed.date = normalizedGemini.fecha;
    parsed.hasExplicitDate = true;
  }
  if (normalizedGemini.comercio) {
    parsed.comercio = normalizedGemini.comercio;
    parsed.merchant = normalizedGemini.comercio;
  }
  if (normalizedGemini.monto > 0) {
    parsed.monto = sanitizeSmartScanAmount(normalizedGemini.monto);
    parsed.amount = parsed.monto;
  }
  if (normalizedGemini.moneda === 'USD' || normalizedGemini.moneda === 'HNL') {
    parsed.moneda = normalizedGemini.moneda;
    parsed.currency = normalizedGemini.moneda;
  }
  if (normalizedGemini.bankName) {
    parsed.detectedBank = normalizedGemini.bankName;
    parsed.bancoDetectado = normalizedGemini.bankName;
    parsed.bankName = normalizedGemini.bankName;
  }

  if (Array.isArray(normalizedGemini.transactions) && normalizedGemini.transactions.length > 0) {
    parsed.statementItems = normalizedGemini.transactions.map((tx, idx) => {
      const rowTipo =
        tx.tipo === 'income' || tx.type === 'income'
          ? TRANSACTION_TYPES.INCOME
          : TRANSACTION_TYPES.EXPENSE;
      const rowComercio = String(tx.comercio || tx.merchant || 'Movimiento').trim();
      const rowCat = inferSmartScanCategory(
        rowComercio,
        rowComercio,
        rowTipo,
        state?.categories || [],
        tx.categoriaSugerida || tx.suggestedCategory || ''
      );
      return {
        id: tx.id || `stmt_tx_${idx + 1}`,
        selected: tx.selected !== false,
        fecha: String(tx.fecha || tx.date || parsed.fecha).slice(0, 10),
        date: String(tx.fecha || tx.date || parsed.fecha).slice(0, 10),
        comercio: rowComercio,
        concept: rowComercio,
        monto: sanitizeSmartScanAmount(tx.monto ?? tx.amount ?? 0),
        amount: sanitizeSmartScanAmount(tx.monto ?? tx.amount ?? 0),
        moneda: tx.moneda === 'USD' || tx.currency === 'USD' ? 'USD' : parsed.moneda,
        currency: tx.moneda === 'USD' || tx.currency === 'USD' ? 'USD' : parsed.moneda,
        tipo: rowTipo,
        type: rowTipo,
        categoryId: tx.categoryId || rowCat.categoryId,
        categoriaSugerida:
          tx.categoriaSugerida || tx.suggestedCategory || rowCat.categoriaSugerida,
      };
    });
    parsed.statementTransactions = parsed.statementItems;
    parsed.transactions = parsed.statementItems;

    if (
      normalizedGemini.transactions.length >= 2 ||
      normalizedGemini.documentType === SMART_SCAN_DOCUMENT_TYPES.BANK_STATEMENT
    ) {
      parsed.tipoDocumento = SMART_SCAN_DOCUMENT_TYPES.BANK_STATEMENT;
      parsed.documentType = SMART_SCAN_DOCUMENT_TYPES.BANK_STATEMENT;
      parsed.isMultiRowStatement = true;
    }
  } else if (normalizedGemini.documentType) {
    parsed.tipoDocumento = normalizedGemini.documentType;
    parsed.documentType = normalizedGemini.documentType;
    parsed.tipoTransaccion = getTransactionTypeForDocument(normalizedGemini.documentType);
    parsed.isMultiRowStatement =
      normalizedGemini.documentType === SMART_SCAN_DOCUMENT_TYPES.BANK_STATEMENT;
  }

  if (normalizedGemini.accountNumber) {
    parsed.cuentaIdentificada = normalizedGemini.accountNumber;
    parsed.accountNumber = normalizedGemini.accountNumber;
  }

  if (parsed.cuentaIdentificada) {
    parsed.accountMatch = await matchAccountFromWorkspace(
      parsed.cuentaIdentificada,
      state?.accounts || [],
      options
    );
    parsed.accountExists = Boolean(parsed.accountMatch.matched);
    if (parsed.accountMatch.matched) {
      parsed.accountId = parsed.accountMatch.accountId;
    }
  }

  const reInferredCat = inferSmartScanCategory(
    parsed.comercio,
    `${parsed.comercio} ${parsed.rawText || ''}`,
    parsed.tipoTransaccion,
    state?.categories || [],
    normalizedGemini.categoriaSugerida || normalizedGemini.suggestedCategory || ''
  );
  parsed.categoryId = normalizedGemini.categoryId || reInferredCat.categoryId;
  parsed.categoriaSugerida =
    normalizedGemini.categoriaSugerida || reInferredCat.categoriaSugerida;
  parsed.suggestedCategory = parsed.categoriaSugerida;

  const dupCheck = detectSmartScanDuplicate(
    {
      fecha: parsed.fecha,
      comercio: parsed.comercio,
      monto: parsed.monto,
      moneda: parsed.moneda,
    },
    state?.transactions || [],
    parsed.accountId
  );
  parsed.isDuplicate = dupCheck.isDuplicate;
  parsed.duplicateType = dupCheck.matchType;
  parsed.duplicateTx = dupCheck.duplicateTx;
  parsed.extractionSource = 'gemini-2.5-flash';
  parsed.usedGeminiFallback = true;

  if (parsed.isMultiRowStatement || parsed.tipoDocumento === SMART_SCAN_DOCUMENT_TYPES.BANK_STATEMENT) {
    try {
      parsed.learnedTemplate = await learnAndSaveStatementPatternToBankTemplates(
        {
          bankName: parsed.bankName,
          documentType: parsed.statementDocumentType || parsed.tipoDocumento,
          accountInfo: {
            ...(parsed.accountInfo || {}),
            accountName:
              parsed.accountInfo?.accountName || parsed.detectedAccountTypeLabel || 'Estado de Cuenta',
            accountNumber: parsed.cuentaIdentificada || '',
            currency: parsed.moneda,
            currentBalance: parsed.monto || 0,
          },
          transactions: parsed.statementItems || [],
        },
        parsed.rawText || '',
        options
      );
    } catch {
      // Fallback local-first silencioso
    }
  }

  return parsed;
}

export {
  VECTOR_PDF_MIN_CHARS,
  extractPdfData,
  extractNativePdfTextLayer,
  organizeTextItemsIntoLines,
  organizeLinesIntoHierarchicalBlocks,
  parseBankStatementTextData,
  parseStatementHeaderAccountData,
  parseStatementTransactions,
  detectActiveStatementCurrency,
  normalizeBankStatementDate,
  PROMERICA_CREDIT_CARD_SAMPLE_EXTRACTION,
  DEFAULT_STATEMENT_TEMPLATES,
  loadKnownStatementTemplates,
  matchStatementTemplate,
  extractStatementWithTemplate,
  learnAndSaveStatementPatternToBankTemplates,
  processPdfStatementWithPatternLearning,
};

/**
 * Motor Unificado de Clasificación y Extracción Híbrida (`extractSmartScanDocument`).
 * - Paso 1 (Prioridad Local OCR - Tesseract.js):
 *   Muestra `"⏳ Procesando documento con OCR local..."`, extrae el texto plano con Tesseract.js / PDF.js,
 *   aplica limpiadores regex (Fecha, Montos sin perder dígitos por comas de miles, Cuenta/Tarjeta, Banco/Comercio)
 *   y evalúa la confianza/completitud del resultado.
 * - Paso 2 (Fallback con Gemini 2.5 Flash API):
 *   Si Tesseract.js falla, devuelve texto ilegible o no logra identificar los campos requeridos,
 *   transiciona la UI a `"🤖 Refinando análisis con Gemini Flash AI..."`, codifica el archivo en Base64
 *   y consulta Gemini 2.5 Flash con `SMART_SCAN_GEMINI_JSON_SCHEMA`.
 *
 * @param {File|Blob|object|string} fileOrInput
 * @param {object} [state]
 * @param {object} [options]
 * @param {Function} [onProgress]
 * @returns {Promise<object>}
 */
export async function extractSmartScanDocument(
  fileOrInput,
  state = {},
  options = {},
  onProgress = () => {}
) {
  if (!fileOrInput) {
    throw new Error('Selecciona una imagen (PNG, JPG, WEBP) o un documento PDF para escanear.');
  }

  // Entrada directa como cadena de texto (o Data URL base64)
  if (typeof fileOrInput === 'string') {
    const trimmed = fileOrInput.trim();
    if (!trimmed.startsWith('data:')) {
      onProgress(LOCAL_OCR_LOADING_STATUS, 25);
      const parsedTextResult = parseSmartScanText(fileOrInput, state, options);
      if (parsedTextResult.cuentaIdentificada && options.firestoreDb) {
        parsedTextResult.accountMatch = await matchAccountFromWorkspace(
          parsedTextResult.cuentaIdentificada,
          state?.accounts || [],
          options
        );
        parsedTextResult.accountExists = Boolean(parsedTextResult.accountMatch.matched);
        if (parsedTextResult.accountMatch.matched) {
          parsedTextResult.accountId = parsedTextResult.accountMatch.accountId;
        }
      }
      onProgress('Extracción completada', 100);
      return parsedTextResult;
    }
  }

  // Entrada como objeto pre-extraído con `rawText`
  if (
    typeof fileOrInput === 'object' &&
    typeof fileOrInput.rawText === 'string' &&
    !(typeof Blob !== 'undefined' && fileOrInput instanceof Blob)
  ) {
    onProgress(LOCAL_OCR_LOADING_STATUS, 25);
    const result = parseSmartScanText(fileOrInput.rawText, state, options);
    if (Array.isArray(fileOrInput.transactions) && fileOrInput.transactions.length > 0) {
      result.statementItems = fileOrInput.transactions.map((tx, idx) => {
        const rowTipo =
          tx.tipo === 'income' || tx.type === 'income'
            ? TRANSACTION_TYPES.INCOME
            : TRANSACTION_TYPES.EXPENSE;
        const rowComercio = String(tx.comercio || tx.merchant || tx.concept || 'Movimiento').trim();
        const rowCat = inferSmartScanCategory(
          rowComercio,
          rowComercio,
          rowTipo,
          state?.categories || [],
          tx.categoriaSugerida || tx.suggestedCategory || ''
        );
        return {
          id: tx.id || `stmt_tx_${idx + 1}`,
          selected: tx.selected !== false,
          fecha: normalizeSmartScanDate(tx.fecha || tx.date, result.fecha),
          date: normalizeSmartScanDate(tx.fecha || tx.date, result.fecha),
          comercio: rowComercio,
          concept: rowComercio,
          monto: sanitizeSmartScanAmount(tx.monto ?? tx.amount ?? 0),
          amount: sanitizeSmartScanAmount(tx.monto ?? tx.amount ?? 0),
          moneda: tx.moneda === 'USD' || tx.currency === 'USD' ? 'USD' : result.moneda,
          currency: tx.moneda === 'USD' || tx.currency === 'USD' ? 'USD' : result.moneda,
          tipo: rowTipo,
          type: rowTipo,
          categoryId: tx.categoryId || rowCat.categoryId,
          categoriaSugerida:
            tx.categoriaSugerida || tx.suggestedCategory || rowCat.categoriaSugerida,
        };
      });
      result.statementTransactions = result.statementItems;
      result.transactions = result.statementItems;
      result.tipoDocumento = SMART_SCAN_DOCUMENT_TYPES.BANK_STATEMENT;
      result.documentType = SMART_SCAN_DOCUMENT_TYPES.BANK_STATEMENT;
      result.isMultiRowStatement = true;
    }

    const completeness = evaluateLocalOcrCompleteness(
      result,
      fileOrInput.rawText,
      fileOrInput.ocrConfidence ?? null,
      options
    );
    result.ocrCompleteness = completeness;

    const fallbackSource =
      fileOrInput.thumbnailDataUrl || fileOrInput.originalDataUrl || fileOrInput.dataUrl || null;
    if (completeness.needsGeminiFallback && fallbackSource) {
      onProgress(GEMINI_FALLBACK_LOADING_STATUS, 65);
      const geminiData = await extractWithGeminiVision(
        fallbackSource,
        resolveConfiguredGeminiApiKey(options),
        options.fetchImpl,
        {
          ...options,
          ocrTextFallback: fileOrInput.rawText,
        }
      );
      if (geminiData) {
        await mergeGeminiResultIntoParsed(result, geminiData, state, options);
      }
    }

    onProgress('Extracción completada', 100);
    return {
      ...result,
      thumbnailDataUrl: fallbackSource,
      originalDataUrl: fallbackSource,
    };
  }

  // Validar formato de archivo (PNG, JPG, WEBP, PDF)
  const fileName = String(fileOrInput.name || '').toLowerCase();
  const mimeType = String(fileOrInput.type || '').toLowerCase();
  const isDataUrlString = typeof fileOrInput === 'string' && fileOrInput.trim().startsWith('data:');
  const isPdf =
    mimeType === 'application/pdf' ||
    fileName.endsWith('.pdf') ||
    (isDataUrlString && fileOrInput.startsWith('data:application/pdf'));
  const isImage =
    mimeType.startsWith('image/') ||
    /\.(png|jpe?g|webp|bmp|gif)$/i.test(fileName) ||
    (isDataUrlString && fileOrInput.startsWith('data:image/'));

  if (!isPdf && !isImage) {
    throw new Error('Formato no soportado. Sube un archivo PNG, JPG, WEBP o PDF.');
  }

  // =========================================================================
  // PASO 1: Prioridad Local OCR (Tesseract.js / PDF.js + Limpiadores Regex)
  // =========================================================================
  const localStage = await runLocalTesseractOcrStage(
    fileOrInput,
    state,
    options,
    onProgress
  );

  const parsed = parseSmartScanText(localStage.rawText || '', state, options);
  if (parsed.cuentaIdentificada && options.firestoreDb) {
    parsed.accountMatch = await matchAccountFromWorkspace(
      parsed.cuentaIdentificada,
      state?.accounts || [],
      options
    );
    parsed.accountExists = Boolean(parsed.accountMatch.matched);
    if (parsed.accountMatch.matched) {
      parsed.accountId = parsed.accountMatch.accountId;
    }
  }

  const completeness = evaluateLocalOcrCompleteness(
    parsed,
    localStage.rawText || '',
    localStage.confidence,
    options
  );
  parsed.ocrCompleteness = completeness;
  parsed.ocrConfidence = localStage.confidence;

  // =========================================================================
  // PASO 2: Fallback / Respaldo con Gemini 2.5 Flash API
  // Se activa si Tesseract.js falló, devolvió texto ilegible o no logró
  // identificar los campos requeridos.
  // =========================================================================
  const shouldFallbackToGemini =
    localStage.hadError ||
    completeness.needsGeminiFallback ||
    options.forceGeminiFallback === true;

  if (shouldFallbackToGemini) {
    onProgress(GEMINI_FALLBACK_LOADING_STATUS, 65);
    const geminiInput = fileOrInput || localStage.originalDataUrl;
    const geminiData = await extractWithGeminiVision(
      geminiInput,
      resolveConfiguredGeminiApiKey(options),
      options.fetchImpl,
      {
        ...options,
        ocrTextFallback: localStage.rawText || '',
      }
    );

    if (geminiData) {
      await mergeGeminiResultIntoParsed(parsed, geminiData, state, options);
    }
  }

  onProgress('Extracción completada', 100);

  const resolvedThumbnail =
    localStage.thumbnailDataUrl || localStage.originalDataUrl || null;

  return {
    ...parsed,
    thumbnailDataUrl: resolvedThumbnail,
    originalDataUrl: resolvedThumbnail,
    preprocessedDataUrl: localStage.preprocessedDataUrl || resolvedThumbnail,
  };
}

