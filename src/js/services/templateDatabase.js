/**
 * @fileoverview Base de Datos de Plantillas de Documentos (`document_templates`) para
 * Reconocimiento de Patrones Machine Learning por País en Firestore e IndexedDB (`src/js/services/templateDatabase.js`).
 *
 * Implementa:
 * 1. Colección `document_templates` en Firestore con caché local en IndexedDB (`document_templates_local`)
 *    y espejo en `localStorage`/memoria para velocidad Offline-First (0 latencia).
 * 2. Esquema estricto por documento:
 *    - `country`: Código ISO (ej. `"HN"` para Honduras).
 *    - `docType`: `"bank_statement"` | `"pos_voucher"` | `"tax_invoice"` | `"receipt"`.
 *    - `institutionName`: ej. `"Banco Promerica"`, `"BAC Credomatic"`, `"Banco Atlántida"`.
 *    - `matchingRules`: Objeto con `fingerprintKeywords`, `headerRegexPatterns` y `lineItemRegexPattern`.
 *    - `metadata`: Objeto con `accuracyScore` (hasta `0.999`), `sampleCount` y `version`.
 * 3. Pre-población de Plantillas por Defecto para Honduras (`"HN"`):
 *    a) Tarjetas de Crédito Banco Promerica (`"MI TARJETA PLATINUM"`, `"Cuenta: 310074459"`, `"SEGURO DE DEUDA"`).
 *    b) Resúmenes de Cuentas BAC Credomatic (`"Resumen de productos"`, `"Cuentas bancarias"`, `"LPS"`, `"USD"`).
 *    c) Vouchers POS Estándar / Facturación SAR (`"RTN"`, `"CAI"`, `"SUBTOTAL"`, `"ISV 15%"`).
 * 4. Reglas del Stack:
 *    - JavaScript Vanilla (ESNext Modules) puro, cero código muerto, cero `console.log`.
 */

import {
  DEFAULT_USER_COUNTRY,
  normalizeUserCountryCode,
  getActiveUserCountry,
} from './user.js';

export const DOCUMENT_TEMPLATES_COLLECTION = 'document_templates';
export const DOCUMENT_TEMPLATES_LOCAL_STORE = 'document_templates_local';
export const DOCUMENT_TEMPLATES_IDB_NAME = 'pisto_document_templates_idb';
export const DOCUMENT_TEMPLATES_IDB_VERSION = 1;
export const DOCUMENT_TEMPLATES_STORAGE_MIRROR_KEY = 'pisto_document_templates_mirror_v1';

export const MAX_TEMPLATE_ACCURACY_SCORE = 0.999;
export const HIGH_CONFIDENCE_THRESHOLD = 0.99;

export const DOCUMENT_TEMPLATE_TYPES = Object.freeze({
  BANK_STATEMENT: 'bank_statement',
  POS_VOUCHER: 'pos_voucher',
  TAX_INVOICE: 'tax_invoice',
  RECEIPT: 'receipt',
});

const VALID_DOC_TYPES = new Set(Object.values(DOCUMENT_TEMPLATE_TYPES));

/**
 * Plantillas pre-pobladas por defecto para instituciones financieras y comercios de Honduras (`"HN"`).
 */
export const DEFAULT_HONDURAN_DOCUMENT_TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'hn_promerica_credit_card_statement',
    templateId: 'hn_promerica_credit_card_statement',
    country: 'HN',
    docType: DOCUMENT_TEMPLATE_TYPES.BANK_STATEMENT,
    institutionName: 'Banco Promerica',
    matchingRules: Object.freeze({
      fingerprintKeywords: Object.freeze([
        'MI TARJETA PLATINUM',
        'Cuenta: 310074459',
        'SEGURO DE DEUDA',
        'Banco Promerica',
        'ESTADO DE CUENTA DE TARJETA DE CREDITO',
      ]),
      headerRegexPatterns: Object.freeze({
        accountName:
          '(MI[ \\t]+TARJETA[ \\t]+PLATINUM[^\\r\\n]*|TARJETA[ \\t]+PLATINUM[^\\r\\n]*)',
        accountNumber:
          '(?:Cuenta|CUENTA|TARJETA|N[°ºo.]*)[ \\t]*[:#-]?[ \\t]*(310074459|\\d{6,16})\\b',
        owner:
          '(?:TITULAR|CLIENTE|TARJETAHABIENTE|NOMBRE)[ \\t]*[:.-]?[ \\t]*([A-ZÁÉÍÓÚÑ]{2,}(?:[ \\t]+[A-ZÁÉÍÓÚÑ]{2,}){1,4})',
        cutoffDate:
          '(?:FECHA[ \\t]+DE[ \\t]+CORTE|CORTE)[ \\t]*[:.-]?[ \\t]*(20\\d{2}[-/]\\d{2}[-/]\\d{2}|\\d{1,2}[-/](?:[A-Za-z]{3,10}|\\d{1,2})[-/]\\d{2,4})',
        paymentDueDate:
          '(?:FECHA[ \\t]+(?:L[IÍ]MITE[ \\t]+)?DE[ \\t]+PAGO|VENCIMIENTO)[ \\t]*[:.-]?[ \\t]*(20\\d{2}[-/]\\d{2}[-/]\\d{2}|\\d{1,2}[-/](?:[A-Za-z]{3,10}|\\d{1,2})[-/]\\d{2,4})',
        currency: '\\b(HNL|LPS|Lempiras|USD|US\\$)\\b',
        currentBalance:
          '(?:PAGO[ \\t]+DE[ \\t]+CONTADO|SALDO[ \\t]+(?:ACTUAL|AL[ \\t]+CORTE|TOTAL))[ \\t]*[:.-]?[ \\t]*(?:L\\.?|LPS|HNL|USD|\\$)?[ \\t]*(\\d{1,3}(?:,\\d{3})*\\.\\d{2}|\\d+\\.\\d{2})',
        minimumPayment:
          '(?:PAGO[ \\t]+M[IÍ]NIMO(?:[ \\t]+LOCAL)?)[ \\t]*[:.-]?[ \\t]*(?:L\\.?|LPS|HNL|USD|\\$)?[ \\t]*(\\d{1,3}(?:,\\d{3})*\\.\\d{2}|\\d+\\.\\d{2})',
        creditLimit:
          '(?:L[IÍ]MITE[ \\t]+DE[ \\t]+CR[EÉ]DITO)[ \\t]*[:.-]?[ \\t]*(?:L\\.?|LPS|HNL|USD|\\$)?[ \\t]*(\\d{1,3}(?:,\\d{3})*\\.\\d{2}|\\d+\\.\\d{2})',
      }),
      lineItemRegexPattern:
        '(20\\d{2}[-/]\\d{2}[-/]\\d{2}|\\d{1,2}[-/](?:[A-Za-z]{3,9}|\\d{1,2})[-/]\\d{2,4})(?:\\s+(\\d{1,2}:\\d{2}\\s*(?:AM|PM)))?\\s+([A-ZÁÉÍÓÚÑ0-9][A-ZÁÉÍÓÚÑ0-9\\s.,/*#-]{2,60}?)\\s+(?:(?:D[eé]bito|Cr[eé]dito|Cargo|Abono)\\s+)?(?:L\\.?|LPS|HNL|USD|\\$)?\\s*([+-]?\\d{1,3}(?:,\\d{3})*\\.\\d{2}|[+-]?\\d+\\.\\d{2})',
    }),
    metadata: Object.freeze({
      accuracyScore: 0.996,
      sampleCount: 25,
      version: 1,
      updatedAt: '2026-10-22T00:00:00.000Z',
    }),
  }),
  Object.freeze({
    id: 'hn_bac_credomatic_account_summary',
    templateId: 'hn_bac_credomatic_account_summary',
    country: 'HN',
    docType: DOCUMENT_TEMPLATE_TYPES.BANK_STATEMENT,
    institutionName: 'BAC Credomatic',
    matchingRules: Object.freeze({
      fingerprintKeywords: Object.freeze([
        'Resumen de productos',
        'Cuentas bancarias',
        'LPS',
        'USD',
        'BAC Credomatic',
        'Cuentas personales',
        'Tarjetas personales',
      ]),
      headerRegexPatterns: Object.freeze({
        accountName:
          '(HN[ \\t]*-[ \\t]*(?:CUENTA[ \\t]+BANCARIA|Negocio[ \\t]+Lempiras|Tarjeta)|CUENTA[ \\t]+BANCARIA|AMERICAN[ \\t]+EXPRESS|MASTERCARD|VISA)',
        accountNumber:
          '\\b(\\d{7,14}|\\d{4}-\\d{2}[*X•]{2}-[*X•]{4}-\\d{4}|(?:AMEX|MCARD|VISA|MASTERCARD)[ \\t]*[*X•-]*[ \\t]*\\d{4})\\b',
        currency: '\\b(LPS|HNL|USD|US\\$)\\b',
        currentBalance:
          '(?:LPS|HNL|USD|US\\$|\\$|L\\.?)[ \\t]*(\\d{1,3}(?:,\\d{3})*\\.\\d{2}|\\d+\\.\\d{2})|(?:(\\d{1,3}(?:,\\d{3})*\\.\\d{2}|\\d+\\.\\d{2})[ \\t]*(?:LPS|HNL|USD))',
      }),
      lineItemRegexPattern:
        '(?:(HN[ \\t]*-[ \\t]*[^\\r\\n0-9L$]+|CUENTA[ \\t]+BANCARIA|Negocio[ \\t]+Lempiras|AMEX|MCARD|MASTERCARD|VISA)[^\\r\\n]*?)?\\b(\\d{4,14})\\b[^\\r\\n]*?(?:(LPS|HNL|USD|US\\$|\\$|L\\.?)[ \\t]*(\\d{1,3}(?:,\\d{3})*\\.\\d{2}|\\d+\\.\\d{2})|(\\d{1,3}(?:,\\d{3})*\\.\\d{2}|\\d+\\.\\d{2})[ \\t]*(LPS|HNL|USD))',
    }),
    metadata: Object.freeze({
      accuracyScore: 0.996,
      sampleCount: 30,
      version: 1,
      updatedAt: '2026-10-22T00:00:00.000Z',
    }),
  }),
  Object.freeze({
    id: 'hn_standard_pos_voucher_sar',
    templateId: 'hn_standard_pos_voucher_sar',
    country: 'HN',
    docType: DOCUMENT_TEMPLATE_TYPES.POS_VOUCHER,
    institutionName: 'Voucher POS / Facturación SAR Honduras',
    matchingRules: Object.freeze({
      fingerprintKeywords: Object.freeze([
        'RTN',
        'CAI',
        'SUBTOTAL',
        'ISV 15%',
        'ISV',
        'TOTAL',
      ]),
      headerRegexPatterns: Object.freeze({
        merchantName:
          '^(?:COMERCIO|ESTABLECIMIENTO|TIENDA)?[ \\t]*[:.-]?[ \\t]*([A-ZÁÉÍÓÚÑ0-9][A-ZÁÉÍÓÚÑ0-9 .,/*&-]{3,45})',
        rtn: '\\bRTN[ \\t]*[:.#-]?[ \\t]*(\\d{4}[- ]?\\d{4}[- ]?\\d{6}|\\d{14})\\b',
        cai: '\\bCAI[ \\t]*[:.#-]?[ \\t]*([A-F0-9]{6}(?:-[A-F0-9]{6}){4}-[A-F0-9]{2}|[A-Z0-9-]{14,40})\\b',
        invoiceNumber:
          '(?:FACTURA|RECIBO|BOLETA|TICKET|N[°ºo.]*[ \\t]*DOC(?:UMENTO)?)[ \\t]*[:.#-]?[ \\t]*(\\d{3}-\\d{3}-\\d{2}-\\d{8}|[A-Z0-9-]{4,25})',
        date: '(?:FECHA|DATE)[ \\t]*[:.#-]?[ \\t]*(20\\d{2}[-/]\\d{2}[-/]\\d{2}|\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4})',
        subtotal:
          '\\bSUBTOTAL[ \\t]*[:.#-]?[ \\t]*(?:L\\.?|LPS|HNL|USD|\\$)?[ \\t]*(\\d{1,3}(?:,\\d{3})*\\.\\d{2}|\\d+\\.\\d{2})',
        taxAmount:
          '\\b(?:I\\.?S\\.?V\\.?[ \\t]*15[ \\t]*%|15[ \\t]*%[ \\t]*I\\.?S\\.?V\\.?|I\\.?S\\.?V\\.?)[ \\t]*[:.#-]?[ \\t]*(?:L\\.?|LPS|HNL|USD|\\$)?[ \\t]*(\\d{1,3}(?:,\\d{3})*\\.\\d{2}|\\d+\\.\\d{2})',
        totalAmount:
          '\\b(?:TOTAL(?:[ \\t]+A[ \\t]+PAGAR|[ \\t]+GENERAL|[ \\t]+FACTURA)?|MONTO[ \\t]+TOTAL)[ \\t]*[:.#-]?[ \\t]*(?:L\\.?|LPS|HNL|USD|\\$)?[ \\t]*(\\d{1,3}(?:,\\d{3})*\\.\\d{2}|\\d+\\.\\d{2})',
        currency: '\\b(HNL|LPS|Lempiras|USD|US\\$)\\b',
        accountNumber:
          '(?:TARJETA|CUENTA|AUT(?:ORIZACI[OÓ]N)?|[*X•]{4})[ \\t]*[:.#-]?[ \\t]*(\\d{4})\\b',
      }),
      lineItemRegexPattern:
        '(?:(\\d+(?:\\.\\d+)?)[ \\t]*[xX*]?[ \\t]+)?([A-ZÁÉÍÓÚÑ0-9][A-ZÁÉÍÓÚÑ0-9 \\t.,/#-]{2,42}?)[ \\t]+(?:L\\.?|LPS|HNL|USD|\\$)?[ \\t]*(\\d{1,3}(?:,\\d{3})*\\.\\d{2}|\\d+\\.\\d{2})',
    }),
    metadata: Object.freeze({
      accuracyScore: 0.995,
      sampleCount: 40,
      version: 1,
      updatedAt: '2026-10-22T00:00:00.000Z',
    }),
  }),
  Object.freeze({
    id: 'hn_banco_atlantida_statement',
    templateId: 'hn_banco_atlantida_statement',
    country: 'HN',
    docType: DOCUMENT_TEMPLATE_TYPES.BANK_STATEMENT,
    institutionName: 'Banco Atlántida',
    matchingRules: Object.freeze({
      fingerprintKeywords: Object.freeze([
        'Banco Atlántida',
        'Atlántida Móvil',
        'Atlántida Online',
        'CUENTA DE AHORRO',
        'Saldo Disponible',
      ]),
      headerRegexPatterns: Object.freeze({
        accountName:
          '(CUENTA[ \\t]+DE[ \\t]+AHORRO[^\\r\\n]*|CUENTA[ \\t]+DE[ \\t]+CHEQUES[^\\r\\n]*|TARJETA[ \\t]+ATL[AÁ]NTIDA[^\\r\\n]*)',
        accountNumber:
          '(?:CUENTA|TARJETA|N[°ºo.]*)[ \\t]*[:#-]?[ \\t]*(\\d{6,16})\\b',
        currency: '\\b(HNL|LPS|Lempiras|USD|US\\$)\\b',
        currentBalance:
          '(?:SALDO[ \\t]+(?:DISPONIBLE|ACTUAL|TOTAL))[ \\t]*[:.-]?[ \\t]*(?:L\\.?|LPS|HNL|USD|\\$)?[ \\t]*(\\d{1,3}(?:,\\d{3})*\\.\\d{2}|\\d+\\.\\d{2})',
      }),
      lineItemRegexPattern:
        '(20\\d{2}[-/]\\d{2}[-/]\\d{2}|\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4})\\s+([A-ZÁÉÍÓÚÑ0-9][A-ZÁÉÍÓÚÑ0-9\\s.,/*#-]{2,60}?)\\s+(?:L\\.?|LPS|HNL|USD|\\$)?\\s*([+-]?\\d{1,3}(?:,\\d{3})*\\.\\d{2}|[+-]?\\d+\\.\\d{2})',
    }),
    metadata: Object.freeze({
      accuracyScore: 0.995,
      sampleCount: 18,
      version: 1,
      updatedAt: '2026-10-22T00:00:00.000Z',
    }),
  }),
]);

export const DEFAULT_DOCUMENT_TEMPLATES = DEFAULT_HONDURAN_DOCUMENT_TEMPLATES;

const inMemoryDocumentTemplates = new Map();

/**
 * Normaliza el `docType` de una plantilla a uno de los 4 tipos canónicos:
 * `"bank_statement"` | `"pos_voucher"` | `"tax_invoice"` | `"receipt"`.
 *
 * @param {string} rawDocType
 * @returns {'bank_statement' | 'pos_voucher' | 'tax_invoice' | 'receipt'}
 */
export function normalizeDocumentTemplateType(rawDocType = '') {
  const raw = String(rawDocType || '').trim();
  const lower = raw.toLowerCase();
  if (VALID_DOC_TYPES.has(lower)) {
    return lower;
  }
  if (/estado\s+de\s+cuenta|statement|resumen\s+de\s+productos|cuentas\s+bancarias/i.test(raw)) {
    return DOCUMENT_TEMPLATE_TYPES.BANK_STATEMENT;
  }
  if (/voucher|pos|comprobante\s+de\s+d[eé]bito|comprobante\s+de\s+cr[eé]dito/i.test(raw)) {
    return DOCUMENT_TEMPLATE_TYPES.POS_VOUCHER;
  }
  if (/factura|tax_invoice|invoice|cai|rtn/i.test(raw)) {
    return DOCUMENT_TEMPLATE_TYPES.TAX_INVOICE;
  }
  if (/recibo|receipt/i.test(raw)) {
    return DOCUMENT_TEMPLATE_TYPES.RECEIPT;
  }
  return DOCUMENT_TEMPLATE_TYPES.BANK_STATEMENT;
}

/**
 * Genera un identificador determinista para un documento de `document_templates`.
 *
 * @param {string} country
 * @param {string} institutionName
 * @param {string} docType
 * @returns {string}
 */
export function buildDocumentTemplateId(
  country = DEFAULT_USER_COUNTRY,
  institutionName = 'institucion',
  docType = DOCUMENT_TEMPLATE_TYPES.BANK_STATEMENT
) {
  const normCountry = normalizeUserCountryCode(country).toLowerCase();
  const normType = normalizeDocumentTemplateType(docType);
  const slug = String(institutionName || 'institucion')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 36);
  return `${normCountry}_${slug || 'general'}_${normType}`;
}

/**
 * Normaliza y valida un registro del esquema `document_templates`.
 *
 * @param {object} [rawTemplate={}]
 * @returns {{
 *   id: string,
 *   templateId: string,
 *   country: string,
 *   docType: 'bank_statement' | 'pos_voucher' | 'tax_invoice' | 'receipt',
 *   institutionName: string,
 *   matchingRules: {
 *     fingerprintKeywords: Array<string>,
 *     headerRegexPatterns: Record<string, string>,
 *     lineItemRegexPattern: string
 *   },
 *   metadata: {
 *     accuracyScore: number,
 *     sampleCount: number,
 *     version: number,
 *     updatedAt: string
 *   }
 * }}
 */
export function normalizeDocumentTemplate(rawTemplate = {}) {
  const country = normalizeUserCountryCode(rawTemplate.country || DEFAULT_USER_COUNTRY);
  const docType = normalizeDocumentTemplateType(
    rawTemplate.docType || rawTemplate.documentType || DOCUMENT_TEMPLATE_TYPES.BANK_STATEMENT
  );
  const institutionName =
    String(
      rawTemplate.institutionName ||
        rawTemplate.bankName ||
        rawTemplate.merchantName ||
        'Banco Promerica'
    ).trim() || 'Banco Promerica';

  const resolvedId = String(
    rawTemplate.id ||
      rawTemplate.templateId ||
      buildDocumentTemplateId(country, institutionName, docType)
  ).trim();

  const rawRules =
    rawTemplate.matchingRules && typeof rawTemplate.matchingRules === 'object'
      ? rawTemplate.matchingRules
      : {};

  const rawKeywords = Array.isArray(rawRules.fingerprintKeywords)
    ? rawRules.fingerprintKeywords
    : Array.isArray(rawTemplate.fingerprintKeywords)
      ? rawTemplate.fingerprintKeywords
      : Array.isArray(rawTemplate.keywords)
        ? rawTemplate.keywords
        : [institutionName];

  const fingerprintKeywords = Array.from(
    new Set(
      rawKeywords
        .map((kw) => String(kw ?? '').trim())
        .filter(Boolean)
    )
  );

  const rawHeaders =
    rawRules.headerRegexPatterns && typeof rawRules.headerRegexPatterns === 'object'
      ? rawRules.headerRegexPatterns
      : rawTemplate.headerRegexPatterns && typeof rawTemplate.headerRegexPatterns === 'object'
        ? rawTemplate.headerRegexPatterns
        : {};

  const headerRegexPatterns = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      headerRegexPatterns[k] = v instanceof RegExp ? v.source : String(v);
    }
  }

  const rawLinePattern =
    rawRules.lineItemRegexPattern ??
    rawTemplate.lineItemRegexPattern ??
    rawTemplate.statementRules?.transactionLine ??
    '';
  const lineItemRegexPattern =
    rawLinePattern instanceof RegExp ? rawLinePattern.source : String(rawLinePattern || '');

  const rawMeta =
    rawTemplate.metadata && typeof rawTemplate.metadata === 'object'
      ? rawTemplate.metadata
      : {};

  const rawAccuracy = Number(
    rawMeta.accuracyScore ?? rawTemplate.accuracyScore ?? 0.95
  );
  const accuracyScore = Number.isFinite(rawAccuracy)
    ? Math.max(0, Math.min(MAX_TEMPLATE_ACCURACY_SCORE, Number(rawAccuracy.toFixed(4))))
    : 0.95;

  const rawSamples = Number(rawMeta.sampleCount ?? rawTemplate.sampleCount ?? 1);
  const sampleCount =
    Number.isFinite(rawSamples) && rawSamples >= 1 ? Math.floor(rawSamples) : 1;

  const rawVersion = Number(rawMeta.version ?? rawTemplate.version ?? 1);
  const version =
    Number.isFinite(rawVersion) && rawVersion >= 1 ? Math.floor(rawVersion) : 1;

  const updatedAt = String(
    rawMeta.updatedAt || rawTemplate.updatedAt || new Date().toISOString()
  );

  return {
    id: resolvedId,
    templateId: resolvedId,
    country,
    docType,
    institutionName,
    matchingRules: {
      fingerprintKeywords,
      headerRegexPatterns,
      lineItemRegexPattern,
    },
    metadata: {
      accuracyScore,
      sampleCount,
      version,
      updatedAt,
    },
  };
}

function ensureInMemorySeeded() {
  if (inMemoryDocumentTemplates.size === 0) {
    for (const tpl of DEFAULT_HONDURAN_DOCUMENT_TEMPLATES) {
      const normalized = normalizeDocumentTemplate(tpl);
      inMemoryDocumentTemplates.set(normalized.id, normalized);
    }
  }
}

/**
 * Abre la base de datos IndexedDB para el almacén `document_templates_local`.
 *
 * @param {IDBFactory|null} [idbFactory]
 * @returns {Promise<IDBDatabase|null>}
 */
export function openDocumentTemplatesIndexedDb(
  idbFactory = typeof indexedDB !== 'undefined' ? indexedDB : null
) {
  if (!idbFactory || typeof idbFactory.open !== 'function') {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const req = idbFactory.open(
        DOCUMENT_TEMPLATES_IDB_NAME,
        DOCUMENT_TEMPLATES_IDB_VERSION
      );
      req.onupgradeneeded = () => {
        const db = req.result;
        if (db && !db.objectStoreNames.contains(DOCUMENT_TEMPLATES_LOCAL_STORE)) {
          db.createObjectStore(DOCUMENT_TEMPLATES_LOCAL_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Lee sincrónicamente las plantillas de `document_templates` desde memoria y `localStorage`.
 *
 * @param {{ storage?: Storage }} [options]
 * @returns {Array<ReturnType<typeof normalizeDocumentTemplate>>}
 */
export function getLocalDocumentTemplatesSync(options = {}) {
  ensureInMemorySeeded();
  const merged = new Map(inMemoryDocumentTemplates);
  const storage =
    options?.storage !== undefined
      ? options.storage
      : typeof localStorage !== 'undefined'
        ? localStorage
        : null;

  if (storage && typeof storage.getItem === 'function') {
    try {
      const raw = storage.getItem(DOCUMENT_TEMPLATES_STORAGE_MIRROR_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item && typeof item === 'object') {
              const norm = normalizeDocumentTemplate(item);
              merged.set(norm.id, norm);
              inMemoryDocumentTemplates.set(norm.id, norm);
            }
          }
        }
      }
    } catch {
      // Ignorar errores de parseo local
    }
  }

  return Array.from(merged.values());
}

/**
 * Guarda una plantilla en IndexedDB (`document_templates_local`), `localStorage` y memoria.
 *
 * @param {object} rawTemplate
 * @param {{ indexedDb?: IDBFactory, storage?: Storage }} [options]
 * @returns {Promise<ReturnType<typeof normalizeDocumentTemplate>>}
 */
export async function saveDocumentTemplateToLocalCache(rawTemplate, options = {}) {
  ensureInMemorySeeded();
  const normalized = normalizeDocumentTemplate(rawTemplate);
  inMemoryDocumentTemplates.set(normalized.id, normalized);

  const storage =
    options?.storage !== undefined
      ? options.storage
      : typeof localStorage !== 'undefined'
        ? localStorage
        : null;

  if (storage && typeof storage.setItem === 'function') {
    try {
      const current = getLocalDocumentTemplatesSync({ storage });
      const byId = new Map(current.map((item) => [item.id, item]));
      byId.set(normalized.id, normalized);
      storage.setItem(
        DOCUMENT_TEMPLATES_STORAGE_MIRROR_KEY,
        JSON.stringify(Array.from(byId.values()))
      );
    } catch {
      // Ignorar errores de cuota
    }
  }

  const db = await openDocumentTemplatesIndexedDb(options?.indexedDb);
  if (db) {
    await new Promise((resolve) => {
      try {
        const tx = db.transaction(DOCUMENT_TEMPLATES_LOCAL_STORE, 'readwrite');
        const store = tx.objectStore(DOCUMENT_TEMPLATES_LOCAL_STORE);
        store.put(normalized);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  }

  return normalized;
}

/**
 * Obtiene todas las plantillas de `document_templates` desde IndexedDB + espejo local + semillas por defecto.
 *
 * @param {{ indexedDb?: IDBFactory, storage?: Storage }} [options]
 * @returns {Promise<Array<ReturnType<typeof normalizeDocumentTemplate>>>}
 */
export async function getAllLocalDocumentTemplates(options = {}) {
  const baseList = getLocalDocumentTemplatesSync(options);
  const merged = new Map(baseList.map((tpl) => [tpl.id, tpl]));

  const db = await openDocumentTemplatesIndexedDb(options?.indexedDb);
  if (db) {
    const idbItems = await new Promise((resolve) => {
      try {
        const tx = db.transaction(DOCUMENT_TEMPLATES_LOCAL_STORE, 'readonly');
        const store = tx.objectStore(DOCUMENT_TEMPLATES_LOCAL_STORE);
        const req = store.getAll();
        req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });

    for (const rawItem of idbItems) {
      if (rawItem && typeof rawItem === 'object') {
        const norm = normalizeDocumentTemplate(rawItem);
        merged.set(norm.id, norm);
        inMemoryDocumentTemplates.set(norm.id, norm);
      }
    }
  }

  return Array.from(merged.values());
}

/**
 * Pre-puebla las plantillas por defecto de Honduras (`"HN"`) en IndexedDB y opcionalmente en Firestore.
 *
 * @param {{
 *   firestoreDb?: any,
 *   firestoreModule?: any,
 *   indexedDb?: IDBFactory,
 *   storage?: Storage,
 *   syncToFirestore?: boolean
 * }} [options]
 * @returns {Promise<Array<ReturnType<typeof normalizeDocumentTemplate>>>}
 */
export async function seedDefaultHonduranDocumentTemplates(options = {}) {
  ensureInMemorySeeded();
  const seeded = [];

  for (const tpl of DEFAULT_HONDURAN_DOCUMENT_TEMPLATES) {
    const savedLocal = await saveDocumentTemplateToLocalCache(tpl, options);
    seeded.push(savedLocal);

    if (
      options.syncToFirestore === true &&
      options.firestoreDb &&
      options.firestoreModule &&
      typeof options.firestoreModule.doc === 'function' &&
      typeof options.firestoreModule.setDoc === 'function'
    ) {
      try {
        const ref = options.firestoreModule.doc(
          options.firestoreDb,
          DOCUMENT_TEMPLATES_COLLECTION,
          savedLocal.id
        );
        await options.firestoreModule.setDoc(ref, savedLocal, { merge: true });
      } catch {
        // Continúa con caché local si Firestore no está disponible
      }
    }
  }

  return seeded;
}

/**
 * Consulta la colección `document_templates` filtrada por `country` (ej. `"HN"`),
 * combinando Firestore (`where('country', '==', country)`) con la caché local de IndexedDB.
 *
 * @param {string} [country='HN']
 * @param {{
 *   docType?: string,
 *   firestoreDb?: any,
 *   firestoreModule?: any,
 *   indexedDb?: IDBFactory,
 *   storage?: Storage,
 *   customTemplates?: Array<object>
 * }} [options]
 * @returns {Promise<Array<ReturnType<typeof normalizeDocumentTemplate>>>}
 */
export async function queryDocumentTemplatesByCountry(
  country = DEFAULT_USER_COUNTRY,
  options = {}
) {
  const targetCountry = normalizeUserCountryCode(
    country || options?.country || getActiveUserCountry(options)
  );
  const localTemplates = await getAllLocalDocumentTemplates(options);
  const byId = new Map(localTemplates.map((tpl) => [tpl.id, tpl]));

  if (Array.isArray(options?.customTemplates)) {
    for (const customTpl of options.customTemplates) {
      if (customTpl && typeof customTpl === 'object') {
        const norm = normalizeDocumentTemplate(customTpl);
        byId.set(norm.id, norm);
      }
    }
  }

  const { firestoreDb, firestoreModule } = options || {};
  if (
    firestoreDb &&
    firestoreModule &&
    typeof firestoreModule.collection === 'function' &&
    typeof firestoreModule.getDocs === 'function'
  ) {
    try {
      const colRef = firestoreModule.collection(
        firestoreDb,
        DOCUMENT_TEMPLATES_COLLECTION
      );
      let queryTarget = colRef;
      if (
        typeof firestoreModule.query === 'function' &&
        typeof firestoreModule.where === 'function'
      ) {
        try {
          queryTarget = firestoreModule.query(
            colRef,
            firestoreModule.where('country', '==', targetCountry)
          );
        } catch {
          queryTarget = colRef;
        }
      }

      const snap = await firestoreModule.getDocs(queryTarget);
      const remoteDocs = [];
      if (snap && typeof snap.forEach === 'function') {
        snap.forEach((docSnap) => remoteDocs.push(docSnap));
      } else if (Array.isArray(snap?.docs)) {
        remoteDocs.push(...snap.docs);
      }

      for (const docSnap of remoteDocs) {
        const rawData =
          typeof docSnap.data === 'function' ? docSnap.data() : docSnap;
        if (rawData && typeof rawData === 'object') {
          const norm = normalizeDocumentTemplate({
            id: docSnap.id || rawData.id || rawData.templateId,
            country: rawData.country || targetCountry,
            ...rawData,
          });
          byId.set(norm.id, norm);
          await saveDocumentTemplateToLocalCache(norm, options);
        }
      }
    } catch {
      // Fallback Local-First silencioso
    }
  }

  const filterDocType = options?.docType
    ? normalizeDocumentTemplateType(options.docType)
    : '';

  return Array.from(byId.values())
    .filter((tpl) => tpl.country === targetCountry)
    .filter((tpl) => (!filterDocType ? true : tpl.docType === filterDocType))
    .sort((a, b) => {
      if (b.metadata.accuracyScore !== a.metadata.accuracyScore) {
        return b.metadata.accuracyScore - a.metadata.accuracyScore;
      }
      return b.metadata.sampleCount - a.metadata.sampleCount;
    });
}

/**
 * Persiste o actualiza una plantilla en `document_templates` tanto en IndexedDB como en Firestore.
 *
 * @param {object} rawTemplate
 * @param {{
 *   firestoreDb?: any,
 *   firestoreModule?: any,
 *   indexedDb?: IDBFactory,
 *   storage?: Storage,
 *   useUpdateDoc?: boolean
 * }} [options]
 * @returns {Promise<{
 *   template: ReturnType<typeof normalizeDocumentTemplate>,
 *   savedToLocal: boolean,
 *   savedToFirestore: boolean
 * }>}
 */
export async function saveDocumentTemplateToFirestore(rawTemplate, options = {}) {
  const normalized = await saveDocumentTemplateToLocalCache(rawTemplate, options);
  let savedToFirestore = false;

  const { firestoreDb, firestoreModule } = options || {};
  if (firestoreDb && firestoreModule && typeof firestoreModule.doc === 'function') {
    try {
      const docRef = firestoreModule.doc(
        firestoreDb,
        DOCUMENT_TEMPLATES_COLLECTION,
        normalized.id
      );
      if (
        options.useUpdateDoc === true &&
        typeof firestoreModule.updateDoc === 'function'
      ) {
        try {
          await firestoreModule.updateDoc(docRef, {
            country: normalized.country,
            docType: normalized.docType,
            institutionName: normalized.institutionName,
            matchingRules: normalized.matchingRules,
            metadata: normalized.metadata,
          });
          savedToFirestore = true;
        } catch {
          if (typeof firestoreModule.setDoc === 'function') {
            await firestoreModule.setDoc(docRef, normalized, { merge: true });
            savedToFirestore = true;
          }
        }
      } else if (typeof firestoreModule.setDoc === 'function') {
        await firestoreModule.setDoc(docRef, normalized, { merge: true });
        savedToFirestore = true;
      } else if (typeof firestoreModule.updateDoc === 'function') {
        await firestoreModule.updateDoc(docRef, normalized);
        savedToFirestore = true;
      }
    } catch {
      savedToFirestore = false;
    }
  }

  return {
    template: normalized,
    savedToLocal: true,
    savedToFirestore,
  };
}
