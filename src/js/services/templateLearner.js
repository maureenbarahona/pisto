/**
 * @fileoverview Motor de Aprendizaje de Formatos Bancarios (`src/js/services/templateLearner.js`).
 *
 * Implementa:
 * 1. Arquitectura Híbrida Adaptativa (Cloud AI + Local Fallback):
 *    - Modo Nube (Cloud Run / Gemini 1.5 Flash Vision / Genkit):
 *      Consulta la colección `bank_templates` en Firestore antes de llamar a la IA
 *      para inyectar reglas conocidas mediante Few-Shot Prompting dinámico.
 *    - Modo Local / Offline (Tesseract.js / Regex Machine Learning Engine):
 *      Lee la imagen localmente con OCR y aplica reglas regex almacenadas en IndexedDB
 *      (`bank_templates_local`) para extraer cuentas y movimientos sin conexión a internet.
 * 2. Base de Datos de Formatos Registrados (`bank_templates` en Firestore / `bank_templates_local` en IndexedDB):
 *    - `bankId`: string (ej. "promerica_app", "bac_web", "bac_mobile", "atlantida_mobile")
 *    - `bankName`: string (ej. "Banco Promerica", "BAC Credomatic", "Banco Atlántida")
 *    - `keywords`: array de strings para identificar el layout
 *    - `extractionRules`: objeto con patrones regex para `accountNumber`, `accountType`,
 *      `currency` (LPS/HNL -> HNL, USD/$ -> USD) y `currentBalance`.
 * 3. Flujo de Realimentación y Aprendizaje ("Aprender sobre este Formato"):
 *    - Detecta ediciones o correcciones del usuario en el modal de confirmación y guarda
 *      el patrón ajustado en `bank_templates` (Firestore + IndexedDB `bank_templates_local`),
 *      logrando reconocimiento instantáneo con 100% de precisión en futuras capturas similares.
 * 4. Estricto Vanilla JS ESNext, cero llamados a `console.log`.
 */

import {
  cleanAmount,
  cleanMobileUiText,
  isMobileUiNoiseLine,
  normalizeScanDateToIso,
  classifyTransactionType,
} from '../../../public/js/schemas/accountScan.js';

export const BANK_TEMPLATES_COLLECTION = 'bank_templates';
export const BANK_TEMPLATES_LOCAL_STORE = 'bank_templates_local';
export const BANK_TEMPLATES_IDB_NAME = 'pisto_adaptive_templates_db';
export const BANK_TEMPLATES_IDB_VERSION = 1;
export const BANK_TEMPLATES_STORAGE_MIRROR_KEY = 'pisto_bank_templates_local_v1';

const inMemoryTemplatesStore = new Map();

/**
 * Plantillas base pre-entrenadas para formatos bancarios frecuentes (Promerica App, BAC Web, BAC App, Atlántida).
 */
export const DEFAULT_BANK_TEMPLATES = Object.freeze([
  Object.freeze({
    bankId: 'promerica_app',
    bankName: 'Banco Promerica',
    keywords: Object.freeze([
      'Banco Promerica',
      'Cuentas de cheques y ahorros',
      'Ahorros Personal',
      'Cuenta de Ahorros Personal',
    ]),
    extractionRules: Object.freeze({
      accountNumber: '\\b(\\d{10,16})\\b',
      accountType:
        '(Cuenta\\s+de\\s+Ahorros\\s+Personal(?:\\s*\\([^)]+\\))?|Ahorros\\s+Personal|Cuenta\\s+de\\s+Ahorros|Cuentas\\s+de\\s+cheques\\s+y\\s+ahorros)',
      currency: '\\b(LPS|HNL|Lempiras|USD|US\\$|\\$)\\b',
      currentBalance: '(?:LPS|HNL|USD|\\$)\\s*(\\d{1,3}(?:,\\d{3})+\\.\\d{2}|\\d+\\.\\d{2})',
    }),
  }),
  Object.freeze({
    bankId: 'bac_web',
    bankName: 'BAC Credomatic',
    keywords: Object.freeze([
      'Resumen de productos',
      'Banca en Línea',
      'Total cuentas bancarias',
      'HN - CUENTA BANCARIA',
      'HN - AMERICAN EXPRESS',
      'HN - MASTERCARD',
    ]),
    extractionRules: Object.freeze({
      accountNumber: '(?:\\d{4}-\\d{2}\\*{2}-\\*{4}-(\\d{4})|\\b(\\d{7,12})\\b)',
      accountType:
        '(HN\\s*-\\s*(?:CUENTA\\s+BANCARIA|Negocio\\s+Lempiras|AMERICAN\\s+EXPRESS|MASTERCARD|VISA))',
      currency: '(\\d{1,3}(?:,\\d{3})*\\.\\d{2})\\s*(LPS|HNL|USD|\\$)',
      currentBalance: '(\\d{1,3}(?:,\\d{3})*\\.\\d{2})\\s*(?:LPS|HNL|USD|\\$)',
    }),
  }),
  Object.freeze({
    bankId: 'bac_mobile',
    bankName: 'BAC Credomatic',
    keywords: Object.freeze([
      'Cuentas personales',
      'Tarjetas personales',
      'HN - Cuenta bancaria',
      'HN - Negocio Lempiras',
      'HN - Tarjeta',
      'AMEX ****',
      'MCARD ****',
    ]),
    extractionRules: Object.freeze({
      accountNumber: '(?:(?:AMEX|MCARD|VISA)\\s*\\*{2,4}-(\\d{4})|\\b(\\d{7,12})\\b)',
      accountType:
        '(HN\\s*-\\s*(?:Cuenta\\s+bancaria|Negocio\\s+Lempiras|Tarjeta))',
      currency: '(L|\\$|LPS|HNL|USD)\\s*(\\d{1,3}(?:,\\d{3})*\\.\\d{2})',
      currentBalance: '(?:L|\\$|LPS|HNL|USD)\\s*(\\d{1,3}(?:,\\d{3})*\\.\\d{2})',
    }),
  }),
  Object.freeze({
    bankId: 'atlantida_mobile',
    bankName: 'Banco Atlántida',
    keywords: Object.freeze([
      'Banco Atlántida',
      'CUENTA DE AHORRO SOS',
      'Detalle de Cuenta',
      'Saldo Disponible',
    ]),
    extractionRules: Object.freeze({
      accountNumber: '\\b(\\d{10,16})\\b',
      accountType: '(CUENTA\\s+DE\\s+AHORRO\\s+SOS|CUENTA\\s+DE\\s+AHORRO|Cuenta\\s+Cheques)',
      currency: '(L\\.?|LPS|HNL|USD|\\$)',
      currentBalance: '(?:L\\.?|LPS|HNL|USD|\\$)\\s*(\\d{1,3}(?:,\\d{3})*\\.\\d{2}|\\d+\\.\\d{2})',
    }),
  }),
]);

/**
 * Normaliza un indicador de moneda (LPS/HNL/L/Lempiras -> HNL, USD/$/US$/Dólares -> USD).
 * @param {string} rawCurrency
 * @returns {'HNL'|'USD'}
 */
export function normalizeTemplateCurrency(rawCurrency) {
  const token = String(rawCurrency || '').trim().toUpperCase();
  if (
    token.includes('USD') ||
    token.includes('US$') ||
    token.includes('$') ||
    token.includes('DOLAR') ||
    token.includes('DÓLAR')
  ) {
    return 'USD';
  }
  return 'HNL';
}

/**
 * Genera un identificador `bankId` limpio (ej. "Banco Promerica" -> "promerica_app" o slug normalizado).
 * @param {string} bankName
 * @param {string} [layoutHint='']
 * @returns {string}
 */
export function buildBankTemplateId(bankName, layoutHint = '') {
  const combined = `${String(bankName || '')} ${String(layoutHint || '')}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (combined.includes('promerica')) return 'promerica_app';
  if (combined.includes('bac') || combined.includes('credomatic')) {
    if (
      combined.includes('resumen de productos') ||
      combined.includes('banca en linea') ||
      combined.includes('web')
    ) {
      return 'bac_web';
    }
    if (
      combined.includes('cuentas personales') ||
      combined.includes('tarjetas personales') ||
      combined.includes('mobile')
    ) {
      return 'bac_mobile';
    }
  }
  if (combined.includes('atlantida')) return 'atlantida_mobile';

  const cleanSlug = String(bankName || 'custom_bank')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\bbanco\b/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return cleanSlug ? `${cleanSlug}_template` : 'custom_bank_template';
}

/**
 * Escapa caracteres especiales para construir expresiones regulares seguras.
 * @param {string} value
 * @returns {string}
 */
function escapeRegexLiteral(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normaliza y valida la estructura de un documento de `bank_templates`.
 * @param {object} rawTemplate
 * @returns {{
 *   bankId: string,
 *   bankName: string,
 *   keywords: string[],
 *   extractionRules: {
 *     accountNumber: string,
 *     accountType: string,
 *     currency: string,
 *     currentBalance: string
 *   },
 *   learnedAccounts?: Array<object>,
 *   fingerprint?: string,
 *   updatedAt: string
 * }}
 */
export function normalizeBankTemplate(rawTemplate = {}) {
  const bankName = String(rawTemplate.bankName || 'Banco Atlántida').trim() || 'Banco Atlántida';
  const rawKeywords = Array.isArray(rawTemplate.keywords)
    ? rawTemplate.keywords.map((k) => String(k || '').trim()).filter(Boolean)
    : [];

  const bankId =
    String(rawTemplate.bankId || '').trim() ||
    buildBankTemplateId(bankName, rawKeywords.join(' '));

  const keywords =
    rawKeywords.length > 0 ? Array.from(new Set(rawKeywords)) : [bankName];

  const rules = rawTemplate.extractionRules && typeof rawTemplate.extractionRules === 'object'
    ? rawTemplate.extractionRules
    : {};

  const extractionRules = {
    accountNumber:
      String(rules.accountNumber || '').trim() || '\\b(\\d{4,20})\\b',
    accountType:
      String(rules.accountType || '').trim() ||
      '(Cuenta\\s+de\\s+Ahorros?[^\\n]*|Cuenta\\s+Bancaria[^\\n]*|Tarjeta\\s+de\\s+Cr[eé]dito[^\\n]*)',
    currency:
      String(rules.currency || '').trim() || '(LPS|HNL|L\\.?|USD|US\\$|\\$)',
    currentBalance:
      String(rules.currentBalance || '').trim() ||
      '(\\d{1,3}(?:,\\d{3})+\\.\\d{2}|\\d+\\.\\d{2})',
  };

  const learnedAccounts = Array.isArray(rawTemplate.learnedAccounts)
    ? rawTemplate.learnedAccounts
        .filter((a) => a && typeof a === 'object')
        .map((a) => ({
          bankName: String(a.bankName || bankName).trim(),
          accountType: String(a.accountType || 'Cuenta de Ahorro').trim(),
          productType: String(
            a.productType ||
              (a.isLoan
                ? 'Préstamo'
                : a.isCreditCard
                  ? 'Tarjeta de Crédito'
                  : /cheque|corriente|negocio/i.test(String(a.accountType || ''))
                    ? 'Cheques'
                    : 'Ahorro')
          ).trim(),
          accountNumber: String(a.accountNumber || '').trim(),
          currency: normalizeTemplateCurrency(a.currency),
          currentBalance: cleanAmount(a.currentBalance ?? 0),
          isCreditCard: Boolean(a.isCreditCard),
          isLoan: Boolean(a.isLoan),
          rawAccountNumberToken: String(a.rawAccountNumberToken || '').trim(),
          rawAccountTypeToken: String(a.rawAccountTypeToken || '').trim(),
        }))
    : [];

  return {
    bankId,
    bankName,
    keywords,
    extractionRules,
    ...(learnedAccounts.length > 0 ? { learnedAccounts } : {}),
    ...(rawTemplate.fingerprint ? { fingerprint: String(rawTemplate.fingerprint) } : {}),
    updatedAt: String(rawTemplate.updatedAt || new Date().toISOString()),
  };
}

function seedInMemoryDefaults() {
  if (inMemoryTemplatesStore.size === 0) {
    for (const tpl of DEFAULT_BANK_TEMPLATES) {
      inMemoryTemplatesStore.set(tpl.bankId, normalizeBankTemplate(tpl));
    }
  }
}

/**
 * Abre la base de datos IndexedDB para el almacén `bank_templates_local`.
 * @param {IDBFactory} [idbFactory]
 * @returns {Promise<IDBDatabase | null>}
 */
export function openBankTemplatesIndexedDb(
  idbFactory = typeof indexedDB !== 'undefined' ? indexedDB : null
) {
  if (!idbFactory || typeof idbFactory.open !== 'function') {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const request = idbFactory.open(BANK_TEMPLATES_IDB_NAME, BANK_TEMPLATES_IDB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (db && !db.objectStoreNames.contains(BANK_TEMPLATES_LOCAL_STORE)) {
          db.createObjectStore(BANK_TEMPLATES_LOCAL_STORE, { keyPath: 'bankId' });
        }
      };
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Lee las plantillas desde `localStorage` y memoria sincrónicamente (respaldo rápido y para entornos sin IndexedDB).
 * @param {Storage | null} [storage]
 * @returns {Array<ReturnType<typeof normalizeBankTemplate>>}
 */
export function getLocalBankTemplatesSync(
  storage = typeof localStorage !== 'undefined' ? localStorage : null
) {
  seedInMemoryDefaults();
  const merged = new Map(inMemoryTemplatesStore);

  if (storage && typeof storage.getItem === 'function') {
    try {
      const raw = storage.getItem(BANK_TEMPLATES_STORAGE_MIRROR_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item && typeof item === 'object') {
              const norm = normalizeBankTemplate(item);
              merged.set(norm.bankId, norm);
              inMemoryTemplatesStore.set(norm.bankId, norm);
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
 * Guarda una plantilla en IndexedDB (`bank_templates_local`) y su espejo en `localStorage`/memoria.
 * @param {object} rawTemplate
 * @param {{ indexedDb?: IDBFactory, storage?: Storage }} [options]
 * @returns {Promise<ReturnType<typeof normalizeBankTemplate>>}
 */
export async function saveTemplateToLocalIndexedDb(rawTemplate, options = {}) {
  seedInMemoryDefaults();
  const normalized = normalizeBankTemplate(rawTemplate);
  inMemoryTemplatesStore.set(normalized.bankId, normalized);

  const storage =
    options.storage !== undefined
      ? options.storage
      : typeof localStorage !== 'undefined'
        ? localStorage
        : null;

  if (storage && typeof storage.setItem === 'function') {
    try {
      const currentList = getLocalBankTemplatesSync(storage);
      const byId = new Map(currentList.map((item) => [item.bankId, item]));
      byId.set(normalized.bankId, normalized);
      storage.setItem(
        BANK_TEMPLATES_STORAGE_MIRROR_KEY,
        JSON.stringify(Array.from(byId.values()))
      );
    } catch {
      // Ignorar errores de cuota
    }
  }

  const db = await openBankTemplatesIndexedDb(options.indexedDb);
  if (db) {
    await new Promise((resolve) => {
      try {
        const tx = db.transaction(BANK_TEMPLATES_LOCAL_STORE, 'readwrite');
        const store = tx.objectStore(BANK_TEMPLATES_LOCAL_STORE);
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
 * Obtiene todas las plantillas almacenadas en IndexedDB (`bank_templates_local`) combinadas con las predefinidas.
 * @param {{ indexedDb?: IDBFactory, storage?: Storage }} [options]
 * @returns {Promise<Array<ReturnType<typeof normalizeBankTemplate>>>}
 */
export async function getAllLocalBankTemplates(options = {}) {
  const storage =
    options.storage !== undefined
      ? options.storage
      : typeof localStorage !== 'undefined'
        ? localStorage
        : null;

  const baseList = getLocalBankTemplatesSync(storage);
  const merged = new Map(baseList.map((tpl) => [tpl.bankId, tpl]));

  const db = await openBankTemplatesIndexedDb(options.indexedDb);
  if (db) {
    const idbItems = await new Promise((resolve) => {
      try {
        const tx = db.transaction(BANK_TEMPLATES_LOCAL_STORE, 'readonly');
        const store = tx.objectStore(BANK_TEMPLATES_LOCAL_STORE);
        const req = store.getAll();
        req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });

    for (const rawItem of idbItems) {
      if (rawItem && typeof rawItem === 'object') {
        const norm = normalizeBankTemplate(rawItem);
        merged.set(norm.bankId, norm);
        inMemoryTemplatesStore.set(norm.bankId, norm);
      }
    }
  }

  return Array.from(merged.values());
}

/**
 * Consulta la colección `bank_templates` en Firestore y sincroniza las reglas aprendidas con `bank_templates_local`.
 * @param {{ firestoreDb?: any, firestoreModule?: any, indexedDb?: IDBFactory, storage?: Storage }} [options]
 * @returns {Promise<Array<ReturnType<typeof normalizeBankTemplate>>>}
 */
export async function fetchBankTemplatesFromFirestore(options = {}) {
  const localTemplates = await getAllLocalBankTemplates(options);
  const merged = new Map(localTemplates.map((tpl) => [tpl.bankId, tpl]));

  const { firestoreDb, firestoreModule } = options;
  if (
    firestoreDb &&
    firestoreModule &&
    typeof firestoreModule.collection === 'function' &&
    typeof firestoreModule.getDocs === 'function'
  ) {
    try {
      const colRef = firestoreModule.collection(firestoreDb, BANK_TEMPLATES_COLLECTION);
      const snap = await firestoreModule.getDocs(colRef);
      const docs = Array.isArray(snap?.docs) ? snap.docs : [];
      for (const docSnap of docs) {
        const rawData = typeof docSnap.data === 'function' ? docSnap.data() : docSnap;
        if (rawData && typeof rawData === 'object') {
          const norm = normalizeBankTemplate({
            bankId: docSnap.id || rawData.bankId,
            ...rawData,
          });
          merged.set(norm.bankId, norm);
          await saveTemplateToLocalIndexedDb(norm, options);
        }
      }
    } catch {
      // Fallback silencioso a IndexedDB (`bank_templates_local`) si no hay red
    }
  }

  return Array.from(merged.values());
}

/**
 * Guarda o actualiza un documento de plantilla en la colección `bank_templates` de Firestore
 * y en IndexedDB (`bank_templates_local`).
 *
 * @param {object} rawTemplate
 * @param {{ firestoreDb?: any, firestoreModule?: any, indexedDb?: IDBFactory, storage?: Storage }} [options]
 * @returns {Promise<{ template: ReturnType<typeof normalizeBankTemplate>, savedToFirestore: boolean, savedToLocal: boolean }>}
 */
export async function saveBankTemplate(rawTemplate, options = {}) {
  const normalized = await saveTemplateToLocalIndexedDb(rawTemplate, options);
  let savedToFirestore = false;

  const { firestoreDb, firestoreModule } = options;
  if (firestoreDb && firestoreModule && typeof firestoreModule.doc === 'function') {
    try {
      const tplRef = firestoreModule.doc(
        firestoreDb,
        BANK_TEMPLATES_COLLECTION,
        normalized.bankId
      );
      if (typeof firestoreModule.setDoc === 'function') {
        await firestoreModule.setDoc(tplRef, normalized, { merge: true });
        savedToFirestore = true;
      } else if (typeof firestoreModule.writeBatch === 'function') {
        const batch = firestoreModule.writeBatch(firestoreDb);
        if (typeof batch?.set === 'function') {
          batch.set(tplRef, normalized, { merge: true });
          await batch.commit();
          savedToFirestore = true;
        }
      }
    } catch {
      // Si está offline, queda persistido en `bank_templates_local` (IndexedDB)
    }
  }

  return {
    template: normalized,
    savedToFirestore,
    savedToLocal: true,
  };
}

/**
 * Construye el prompt Few-Shot dinámico inyectando las reglas de `bank_templates`
 * antes de invocar a Gemini 1.5 Flash Vision / Genkit.
 *
 * @param {string} basePrompt
 * @param {Array<object>} [templates]
 * @returns {string}
 */
export function buildFewShotPromptWithTemplates(basePrompt = '', templates = []) {
  const activeTemplates =
    Array.isArray(templates) && templates.length > 0
      ? templates.map((t) => normalizeBankTemplate(t))
      : getLocalBankTemplatesSync();

  const fewShotBlocks = activeTemplates.slice(0, 12).map((tpl) => {
    const kwList = tpl.keywords.slice(0, 6).join(', ');
    const rules = tpl.extractionRules;
    const learnedHint =
      Array.isArray(tpl.learnedAccounts) && tpl.learnedAccounts.length > 0
        ? ` | Ejemplo verificado: ${tpl.learnedAccounts
            .slice(0, 3)
            .map(
              (a) =>
                `{bankName:"${a.bankName}",accountType:"${a.accountType}",accountNumber:"${a.accountNumber}",currency:"${a.currency}",currentBalance:${a.currentBalance}}`
            )
            .join(', ')}`
        : '';
    return `- [${tpl.bankId}] Banco: "${tpl.bankName}" | Keywords: [${kwList}] | Regex(accountNumber: ${rules.accountNumber}, accountType: ${rules.accountType}, currency: ${rules.currency}, currentBalance: ${rules.currentBalance})${learnedHint}`;
  });

  if (fewShotBlocks.length === 0) {
    return basePrompt;
  }

  return `${basePrompt}\n\nFEW-SHOT BANK TEMPLATES (` +
    `${BANK_TEMPLATES_COLLECTION}):\n` +
    `Si la imagen o PDF contiene las palabras clave de alguno de estos formatos bancarios registrados, aplica exactamente sus reglas de extracción:\n` +
    `${fewShotBlocks.join('\n')}`;
}

/**
 * Calcula una huella de estructura/texto (fingerprint) ligera para identificar capturas del mismo formato.
 * @param {string} rawText
 * @returns {string}
 */
export function computeLayoutFingerprint(rawText) {
  const cleaned = cleanMobileUiText(String(rawText || ''))
    .toLowerCase()
    .replace(/\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/g, '#date#')
    .replace(/\d{1,3}(?:,\d{3})+\.\d{2}|\d+\.\d{2}/g, '#amt#')
    .replace(/\d{4,20}/g, '#num#')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 240);
}

/**
 * Encuentra la plantilla de `bank_templates_local` que mejor coincide con el texto OCR.
 * @param {string} rawText
 * @param {Array<object>} [templates]
 * @returns {ReturnType<typeof normalizeBankTemplate> | null}
 */
export function matchBankTemplateFromText(rawText, templates = null) {
  const text = String(rawText || '').trim();
  if (!text) return null;

  const lowerText = text.toLowerCase();
  const candidateTemplates =
    Array.isArray(templates) && templates.length > 0
      ? templates.map((t) => normalizeBankTemplate(t))
      : getLocalBankTemplatesSync();

  const textFingerprint = computeLayoutFingerprint(text);

  let bestTemplate = null;
  let bestScore = 0;

  for (const tpl of candidateTemplates) {
    let score = 0;

    if (tpl.fingerprint && textFingerprint && tpl.fingerprint === textFingerprint) {
      score += 50;
    }

    for (const kw of tpl.keywords) {
      const cleanKw = String(kw || '').trim().toLowerCase();
      if (!cleanKw) continue;
      if (lowerText.includes(cleanKw)) {
        score += cleanKw.length >= 10 ? 5 : 3;
      }
    }

    if (Array.isArray(tpl.learnedAccounts)) {
      for (const learned of tpl.learnedAccounts) {
        const rawNumToken = String(learned.rawAccountNumberToken || learned.accountNumber || '').toLowerCase();
        if (rawNumToken && rawNumToken.length >= 4 && lowerText.includes(rawNumToken)) {
          score += 8;
        }
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestTemplate = tpl;
    }
  }

  return bestScore >= 3 ? bestTemplate : null;
}

/**
 * Extractor especializado para `promerica_app` ("Banco Promerica"):
 * En la app móvil de Banco Promerica el número de cuenta (`10000000206587`) aparece ARRIBA
 * de la etiqueta `Ahorros` / `Cuenta de Ahorros Personal (Lempiras)` y del saldo `LPS 14,326.70`.
 *
 * @param {string} cleanedText
 * @param {ReturnType<typeof normalizeBankTemplate>} template
 * @returns {Array<object>}
 */
function extractPromericaAppAccounts(cleanedText, template) {
  const lines = cleanedText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !isMobileUiNoiseLine(l));

  const results = [];
  const seenNumbers = new Set();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const accNumMatch = line.match(/\b(\d{10,16})\b/);
    if (!accNumMatch) continue;

    // Evitar confundir una dirección IP o timestamp de "Último Ingreso"
    if (/ingreso|\d{1,2}:\d{2}:\d{2}|\d+\.\d+\.\d+\.\d+/i.test(line)) continue;

    const accountNumber = accNumMatch[1];
    if (seenNumbers.has(accountNumber)) continue;

    const windowLines = lines.slice(i, Math.min(lines.length, i + 6));
    const windowText = windowLines.join('\n');

    let accountType = 'Cuenta de Ahorros Personal';
    const detailedTypeLine = windowLines.find((w) =>
      /cuenta\s+de\s+ahorros?\s+personal|cuenta\s+de\s+cheques|cuenta\s+corriente/i.test(w)
    );
    const shortTypeLine = windowLines.find((w) => /^(?:ahorros?|cheques?)$/i.test(w));
    if (detailedTypeLine) {
      accountType = detailedTypeLine.trim();
    } else if (shortTypeLine) {
      accountType = `Cuenta de ${shortTypeLine.trim()}`;
    }

    const balMatch =
      windowText.match(
        /(?:^|[^\w])(LPS|HNL|USD|US\$|\$|L\.?)\s*(\d{1,3}(?:,\d{3})+\.\d{2}|\d+\.\d{2})\b/i
      ) ||
      windowText.match(
        /\b(\d{1,3}(?:,\d{3})+\.\d{2}|\d+\.\d{2})\s*(LPS|HNL|USD|US\$|\$|L\.?)\b/i
      );

    const isFirstCurrency = balMatch
      ? /^(?:LPS|HNL|USD|US\$|\$|L\.?)$/i.test(balMatch[1])
      : true;
    const rawCurrency = balMatch
      ? isFirstCurrency
        ? balMatch[1]
        : balMatch[2]
      : /d[oó]lares|usd/i.test(accountType)
        ? 'USD'
        : 'LPS';
    const rawBalance = balMatch
      ? isFirstCurrency
        ? balMatch[2]
        : balMatch[1]
      : '0';

    seenNumbers.add(accountNumber);
    results.push({
      bankName: template.bankName || 'Banco Promerica',
      accountType,
      accountNumber,
      currency: normalizeTemplateCurrency(rawCurrency),
      currentBalance: cleanAmount(rawBalance),
      isCreditCard: /tarjeta|cr[eé]dito/i.test(accountType),
      selected: true,
    });
  }

  return results;
}

/**
 * Extractor especializado para `bac_web` y `bac_mobile` ("BAC Credomatic"):
 * Soporta tanto la tabla web ("Resumen de productos", "Cuentas bancarias", "Tarjetas de crédito")
 * como la vista móvil ("Cuentas personales", "Tarjetas personales", `AMEX ****-3244`, `MCARD ****-0618`),
 * escaneando TODOS los bloques sin límite y continuando después de "Tarjetas personales".
 *
 * @param {string} cleanedText
 * @param {ReturnType<typeof normalizeBankTemplate>} template
 * @returns {Array<object>}
 */
export function extractBacAccounts(cleanedText, template = {}) {
  const lines = cleanedText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !isMobileUiNoiseLine(l));

  const results = [];
  const seenKeys = new Set();
  let inCardsSection = false;

  const amountRegex =
    /(?:(LPS|HNL|USD|US\$|\$|L\.?)\s*(\d{1,3}(?:,\d{3})*\.\d{2})(?:\s*(?:LPS|HNL|USD))?|(\d{1,3}(?:,\d{3})*\.\d{2})\s*(LPS|HNL|USD|US\$|\$|L\.?))/gi;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // Ignorar filas de totales de resumen ("Total cuentas bancarias 3,941.43 USD")
    if (/^total\s+cuentas\b|^totales\s+en\b/i.test(line)) {
      continue;
    }

    if (/^tarjetas?\s+(?:de\s+cr[eé]dito|personales)\b/i.test(line)) {
      inCardsSection = true;
      continue;
    }
    if (/^cuentas?\s+(?:bancarias|personales)\b/i.test(line)) {
      inCardsSection = false;
      continue;
    }

    // Caso 1: Fila en una sola línea (BAC Web o resumen compacto):
    // Ej. "HN - CUENTA BANCARIA 726935871 401.28 LPS"
    // Ej. "Cuenta bancaria 751666931 -> $ 3,705.95 USD"
    // Ej. "HN - AMERICAN EXPRESS 3777-43**-****-3244 8,154.03 LPS 0.00 USD"
    // Ej. "Tarjeta AMEX 3244 -> L 8,154.03 HNL (y $ 0.00 USD)"
    // Ej. "Tarjeta MCARD 0618 -> L 46,852.97 HNL (y $ 11.49 USD)"
    const webRowMatch = line.match(
      /^((?:HN\s*-\s*)?[A-Za-zÁÉÍÓÚÜÑáéíóúüñ\s]+?)\s+(\d{4}-\d{2}[*X•]{2}-[*X•]{4}-\d{4}|(?:AMEX|MCARD|MASTERCARD|VISA)?\s*[*X•]{1,4}-?\d{4}|\d{7,14}|\d{4})\s*(?:->|:|\|)?\s*(.+)$/i
    );
    if (webRowMatch) {
      const rawType = webRowMatch[1].replace(/\s+/g, ' ').trim();
      const rawProductCode = webRowMatch[2].trim();
      const amountsTail = webRowMatch[3];

      const maskedLast4 = rawProductCode.match(/(\d{4})$/);
      const isLoan = /pr[eé]stamo|financiamiento|hipoteca/i.test(rawType);
      const isCard =
        !isLoan &&
        (inCardsSection ||
          /[*X•]|american\s+express|mastercard|visa|amex|mcard|tarjeta/i.test(
            `${rawType} ${rawProductCode}`
          ));

      // Si el código es de 4 dígitos pero no es tarjeta ni está en sección de tarjetas, no es fila válida
      if (!isCard && /^\d{4}$/.test(rawProductCode)) {
        // continuar al siguiente patrón
      } else {
        const accountNumber = isCard && maskedLast4 ? maskedLast4[1] : rawProductCode;
        const productType = isLoan
          ? 'Préstamo'
          : isCard
            ? 'Tarjeta de Crédito'
            : /cheque|corriente|negocio/i.test(rawType)
              ? 'Cheques'
              : 'Ahorro';

        const amountMatches = [...amountsTail.matchAll(amountRegex)].map((m) => ({
          currency: normalizeTemplateCurrency(m[1] || m[4]),
          balance: cleanAmount(m[2] || m[3]),
        }));

        if (amountMatches.length > 0) {
          const nonZero = amountMatches.filter((m) => m.balance > 0);
          const dualBalances = {};
          for (const m of amountMatches) {
            dualBalances[m.currency] = m.balance;
          }
          const chosen = nonZero[0] || amountMatches[0];
          const key = `${accountNumber}::${chosen.currency}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            results.push({
              bankName: template?.bankName || 'BAC Credomatic',
              accountType: rawType,
              productType,
              accountNumber,
              currency: chosen.currency,
              currentBalance: chosen.balance,
              isCreditCard: isCard,
              isLoan,
              dualBalances,
              selected: true,
            });
          }
          continue;
        }
      }
    }

    // Caso 2: Bloque multilínea (BAC Mobile App / BAC Web OCR por líneas):
    // Ej:
    // "HN - Cuenta bancaria" o "HN - Cuenta\nbancaria 726935871 L401.28"
    // "HN - Negocio\nLempiras 758886371 L5,963.18"
    // "HN - Tarjeta L8,154.03"
    // "AMEX ****-3244 $0.00"
    // "HN - Tarjeta L46,852.97"
    // "MCARD ****-0618 $11.49"
    const isBacHeader =
      /^(?:HN\s*-\s*(?:Cuenta(?:\s+bancaria)?|CUENTA(?:\s+BANCARIA)?|Negocio(?:\s+[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+)?|Tarjeta|AMERICAN\s+EXPRESS|MASTERCARD|MCARD|AMEX|VISA)|Cuenta\s+bancaria|Negocio\s+Lempiras|Negocio\s+D[oó]lares|Tarjeta\s+(?:AMEX|MCARD|MASTERCARD|VISA|AMERICAN\s+EXPRESS)|AMERICAN\s+EXPRESS|MASTERCARD|VISA)\b/i.test(
        line
      );

    if (isBacHeader) {
      const blockLines = [line];
      for (let j = i + 1; j < Math.min(lines.length, i + 6); j += 1) {
        const nextL = lines[j];
        if (
          /^(?:HN\s*-|Tarjetas?\s+(?:de\s+cr[eé]dito|personales)|Cuentas?\s+(?:bancarias|personales)|Total(?:es)?\s+(?:cuentas|tarjetas|en)|Inicio|Centro\s+de\s+pagos|Cuenta\s+bancaria\b|Negocio\s+Lempiras\b|Tarjeta\s+(?:AMEX|MCARD|MASTERCARD|VISA))/i.test(
            nextL
          )
        ) {
          break;
        }
        blockLines.push(nextL);
      }

      const blockText = blockLines.join(' ');
      const headerMatch = blockText.match(
        /^(HN\s*-\s*(?:Cuenta\s+bancaria|CUENTA\s+BANCARIA|Negocio\s+[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+|Tarjeta|AMERICAN\s+EXPRESS|MASTERCARD|MCARD|AMEX|VISA)|Cuenta\s+bancaria|Negocio\s+Lempiras|Negocio\s+D[oó]lares|Tarjeta\s+(?:AMEX|MCARD|MASTERCARD|VISA|AMERICAN\s+EXPRESS)|AMERICAN\s+EXPRESS|MASTERCARD|VISA)/i
      );
      let accountType = headerMatch ? headerMatch[1].replace(/\s+/g, ' ').trim() : line;

      const brandMaskedMatch =
        blockText.match(
          /\b(AMEX|MCARD|MASTERCARD|VISA|AMERICAN\s+EXPRESS)\s*(?:\d{4}-\d{2}[*X•]{2}-[*X•]{4}-|[*X•.°+-]+\s*-?\s*|-\s*|\s+)(\d{4})\b(?!-[\d*X•])/i
        ) ||
        blockText.match(/(?:\d{4}-\d{2}[*X•]{2}-[*X•]{4}-|[*X•]{2,4}-?)(\d{4})\b/i);
      const plainAccMatch = blockText.match(/\b(\d{7,14})\b/);

      const isCard =
        inCardsSection ||
        Boolean(brandMaskedMatch) ||
        /tarjeta|american\s+express|mastercard|visa|amex|mcard/i.test(blockText);

      const resolvedCardDigits = brandMaskedMatch
        ? brandMaskedMatch[2] || brandMaskedMatch[1]
        : '';
      const resolvedBrand =
        brandMaskedMatch && brandMaskedMatch[2] ? brandMaskedMatch[1] : '';

      const accountNumber = resolvedCardDigits
        ? resolvedCardDigits
        : plainAccMatch
          ? plainAccMatch[1]
          : '';

      if (resolvedBrand && /HN\s*-\s*Tarjeta/i.test(accountType)) {
        accountType = `${accountType} (${resolvedBrand.toUpperCase()})`;
      }

      const amountTokens = [...blockText.matchAll(amountRegex)];

      if (accountNumber && amountTokens.length > 0) {
        const parsedAmounts = amountTokens.map((m) => ({
          currency: normalizeTemplateCurrency(m[1] || m[4]),
          balance: cleanAmount(m[2] || m[3]),
        }));
        const dualBalances = {};
        for (const item of parsedAmounts) {
          dualBalances[item.currency] = item.balance;
        }
        const nonZero = parsedAmounts.filter((item) => item.balance > 0);
        const primary = nonZero[0] || parsedAmounts[0];
        const isLoan = /pr[eé]stamo|financiamiento|hipoteca/i.test(accountType);
        const productType = isLoan
          ? 'Préstamo'
          : isCard
            ? 'Tarjeta de Crédito'
            : /cheque|corriente|negocio/i.test(accountType)
              ? 'Cheques'
              : 'Ahorro';

        const key = `${accountNumber}::${primary.currency}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          results.push({
            bankName: template?.bankName || 'BAC Credomatic',
            accountType,
            productType,
            accountNumber,
            currency: primary.currency,
            currentBalance: primary.balance,
            isCreditCard: isCard,
            isLoan,
            dualBalances,
            selected: true,
          });
        }
        i += blockLines.length - 1;
      }
    }
  }

  return results;
}

/**
 * Aplica las reglas regex de una plantilla `bank_templates` sobre texto OCR para extraer cuentas y movimientos
 * sin conexión a internet (Modo Local / Offline Regex Machine Learning Engine).
 *
 * @param {string} rawOcrText
 * @param {object} [template]
 * @returns {{
 *   matched: boolean,
 *   bankId: string,
 *   bankName: string,
 *   accountsList: Array<object>,
 *   detectedTransactions: Array<object>
 * }}
 */
export function applyTemplateExtractionRules(rawOcrText, template) {
  const cleanedText = cleanMobileUiText(String(rawOcrText || ''));
  const normalizedTpl = normalizeBankTemplate(template || {});
  const { bankId, bankName, extractionRules } = normalizedTpl;

  let extractedAccounts = [];

  // 1. Si la plantilla tiene cuentas aprendidas por retroalimentación directa del usuario y coinciden con el texto
  if (Array.isArray(normalizedTpl.learnedAccounts) && normalizedTpl.learnedAccounts.length > 0) {
    const textFingerprint = computeLayoutFingerprint(cleanedText);
    const isExactFingerprint =
      Boolean(normalizedTpl.fingerprint) && normalizedTpl.fingerprint === textFingerprint;

    const matchedLearned = normalizedTpl.learnedAccounts.filter((learnedAcc) => {
      if (isExactFingerprint) return true;
      const numToken = String(
        learnedAcc.rawAccountNumberToken || learnedAcc.accountNumber || ''
      ).trim();
      return numToken && cleanedText.includes(numToken);
    });

    if (matchedLearned.length > 0) {
      extractedAccounts = matchedLearned.map((acc) => {
        // Actualizar el saldo dinámicamente si la captura trae un monto diferente para la misma cuenta
        let dynamicBalance = acc.currentBalance;
        if (!isExactFingerprint && acc.accountNumber) {
          const escapedNum = escapeRegexLiteral(
            acc.rawAccountNumberToken || acc.accountNumber
          );
          const nearNumRegex = new RegExp(
            `${escapedNum}[\\s\\S]{0,120}?(?:LPS|HNL|USD|\\$|L\\.?)*\\s*(\\d{1,3}(?:,\\d{3})+\\.\\d{2}|\\d+\\.\\d{2})`,
            'i'
          );
          const nearMatch = cleanedText.match(nearNumRegex);
          if (nearMatch?.[1]) {
            dynamicBalance = cleanAmount(nearMatch[1]);
          }
        }
        return {
          bankName: acc.bankName || bankName,
          accountType: acc.accountType,
          productType:
            acc.productType ||
            (acc.isLoan
              ? 'Préstamo'
              : acc.isCreditCard
                ? 'Tarjeta de Crédito'
                : /cheque|corriente|negocio/i.test(String(acc.accountType || ''))
                  ? 'Cheques'
                  : 'Ahorro'),
          accountNumber: acc.accountNumber,
          currency: normalizeTemplateCurrency(acc.currency),
          currentBalance: dynamicBalance,
          isCreditCard: Boolean(acc.isCreditCard),
          isLoan: Boolean(acc.isLoan),
          selected: true,
        };
      });
    }
  }

  // 2. Extractores especializados según `bankId` (ejecutar siempre para no truncar si hay más productos en la imagen)
  let specializedAccounts = [];
  if (bankId === 'promerica_app' || /promerica/i.test(bankName)) {
    specializedAccounts = extractPromericaAppAccounts(cleanedText, normalizedTpl);
  } else if (
    bankId === 'bac_web' ||
    bankId === 'bac_mobile' ||
    /\bbac\b|credomatic/i.test(bankName)
  ) {
    specializedAccounts = extractBacAccounts(cleanedText, normalizedTpl);
  }

  if (specializedAccounts.length > 0) {
    if (extractedAccounts.length === 0) {
      extractedAccounts = specializedAccounts;
    } else if (specializedAccounts.length > extractedAccounts.length) {
      const learnedByNumber = new Map(
        extractedAccounts.map((acc) => [String(acc.accountNumber || '').trim(), acc])
      );
      extractedAccounts = specializedAccounts.map((specAcc) => {
        const learned = learnedByNumber.get(String(specAcc.accountNumber || '').trim());
        return learned
          ? {
              ...specAcc,
              bankName: learned.bankName || specAcc.bankName,
              accountType: learned.accountType || specAcc.accountType,
            }
          : specAcc;
      });
    }
  }

  // 3. Motor genérico por `extractionRules` regex configuradas en la plantilla
  if (extractedAccounts.length === 0) {
    try {
      const numRegex = new RegExp(extractionRules.accountNumber, 'gi');
      const typeRegex = new RegExp(extractionRules.accountType, 'i');
      const curRegex = new RegExp(extractionRules.currency, 'i');
      const balRegex = new RegExp(extractionRules.currentBalance, 'gi');

      const numMatches = [...cleanedText.matchAll(numRegex)];
      const balMatches = [...cleanedText.matchAll(balRegex)];
      const typeMatch = cleanedText.match(typeRegex);
      const curMatch = cleanedText.match(curRegex);

      const defaultType = typeMatch ? typeMatch[0].trim() : 'Cuenta de Ahorro';
      const defaultCur = normalizeTemplateCurrency(curMatch ? curMatch[0] : cleanedText);

      if (numMatches.length > 0) {
        const seenNums = new Set();
        for (let idx = 0; idx < numMatches.length; idx += 1) {
          const m = numMatches[idx];
          const rawNum = String(m[1] || m[2] || m[0] || '')
            .replace(/[^\d]/g, '')
            .trim();
          if (!rawNum || seenNums.has(rawNum)) continue;
          seenNums.add(rawNum);

          const balEntry = balMatches[idx] || balMatches[0];
          const rawBalStr = balEntry ? balEntry[1] || balEntry[2] || balEntry[0] : '0';
          const isCard = /tarjeta|cr[eé]dito|amex|mastercard|visa/i.test(defaultType);

          extractedAccounts.push({
            bankName,
            accountType: defaultType,
            accountNumber: rawNum,
            currency: defaultCur,
            currentBalance: cleanAmount(rawBalStr),
            isCreditCard: isCard,
            selected: true,
          });
        }
      }
    } catch {
      // Si alguna regex personalizada tiene sintaxis inválida, continúa de forma segura
    }
  }

  // 4. Extraer transacciones/movimientos si existen en el texto OCR
  const detectedTransactions = [];
  const txRowRegex =
    /(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|20\d{2}-\d{2}-\d{2})\s+([\s\S]+?)\s+(?:(Cr[eé]dito|D[eé]bito)\s+)?(?:L\.?|\$|HNL|USD|LPS)?\s*(\d{1,3}(?:,\d{3})+\.\d{2}|\d{1,9}\.\d{2})/gi;
  let txMatch;
  while ((txMatch = txRowRegex.exec(cleanedText)) !== null) {
    const date = normalizeScanDateToIso(txMatch[1]);
    const concept = txMatch[2]
      .replace(/\r?\n/g, ' ')
      .replace(/\b(?:Cr[eé]dito|D[eé]bito)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    const labelType = txMatch[3] || '';
    const amount = cleanAmount(txMatch[4]);
    const type = classifyTransactionType(labelType, concept);
    if (amount > 0 && concept && !isMobileUiNoiseLine(concept)) {
      detectedTransactions.push({
        id: `tpl_tx_${detectedTransactions.length}_${Date.now().toString(36)}`,
        date,
        concept,
        type,
        amount,
        selected: true,
      });
    }
  }

  return {
    matched: extractedAccounts.length > 0,
    bankId,
    bankName: extractedAccounts[0]?.bankName || bankName,
    accountsList: extractedAccounts,
    transactionsList: detectedTransactions,
    detectedTransactions,
  };
}

/**
 * Ejecuta OCR local sobre un archivo de imagen cuando está en Modo Local / Offline
 * (usa `globalThis.Tesseract.recognize` si está cargado o un lector OCR inyectado).
 *
 * @param {File | Blob | string} fileOrDataUrl
 * @param {{ ocrReader?: Function, ocrTextFallback?: string }} [options]
 * @returns {Promise<string>}
 */
export async function runLocalOcrEngine(fileOrDataUrl, options = {}) {
  const explicitText = String(
    options.ocrTextFallback ||
      options.ocrFallbackText ||
      fileOrDataUrl?.extractedText ||
      fileOrDataUrl?.ocrText ||
      ''
  ).trim();
  if (explicitText) {
    return explicitText;
  }

  if (typeof options.ocrReader === 'function') {
    try {
      const text = await options.ocrReader(fileOrDataUrl);
      if (text) return String(text).trim();
    } catch {
      // Fallback
    }
  }

  if (
    typeof globalThis !== 'undefined' &&
    globalThis.Tesseract &&
    typeof globalThis.Tesseract.recognize === 'function'
  ) {
    try {
      const result = await globalThis.Tesseract.recognize(fileOrDataUrl, 'spa+eng');
      const text = result?.data?.text || '';
      if (text) return String(text).trim();
    } catch {
      // Fallback
    }
  }

  return '';
}

/**
 * Ejecuta el motor de extracción en Modo Local / Offline buscando coincidencias en `bank_templates_local` (IndexedDB).
 *
 * @param {string} ocrText
 * @param {{ indexedDb?: IDBFactory, storage?: Storage, templates?: Array<object> }} [options]
 * @returns {Promise<{
 *   matched: boolean,
 *   template: ReturnType<typeof normalizeBankTemplate> | null,
 *   bankName: string,
 *   accountsList: Array<object>,
 *   detectedTransactions: Array<object>
 * }>}
 */
export async function extractOfflineWithLearnedTemplates(ocrText, options = {}) {
  const templates =
    Array.isArray(options.templates) && options.templates.length > 0
      ? options.templates.map((t) => normalizeBankTemplate(t))
      : await getAllLocalBankTemplates(options);

  const matchedTemplate = matchBankTemplateFromText(ocrText, templates);
  if (!matchedTemplate) {
    return {
      matched: false,
      template: null,
      bankName: '',
      accountsList: [],
      detectedTransactions: [],
    };
  }

  const extraction = applyTemplateExtractionRules(ocrText, matchedTemplate);
  return {
    matched: extraction.matched,
    template: matchedTemplate,
    bankName: extraction.bankName,
    accountsList: extraction.accountsList,
    transactionsList: extraction.detectedTransactions,
    detectedTransactions: extraction.detectedTransactions,
  };
}

/**
 * Compara los datos extraídos originalmente con los datos confirmados por el usuario
 * para determinar si el usuario editó o corrigió algún campo (`bankName`, `accountType`, `accountNumber`, `currency`, `currentBalance`).
 *
 * @param {Array<object>|object} originalExtracted
 * @param {Array<object>|object} confirmedAccounts
 * @returns {boolean}
 */
export function hasUserEditedExtractedAccounts(originalExtracted, confirmedAccounts) {
  const origList = Array.isArray(originalExtracted)
    ? originalExtracted
    : Array.isArray(originalExtracted?.accountsList)
      ? originalExtracted.accountsList
      : Array.isArray(originalExtracted?.accounts)
        ? originalExtracted.accounts
        : originalExtracted && typeof originalExtracted === 'object'
          ? [originalExtracted]
          : [];

  const confList = Array.isArray(confirmedAccounts)
    ? confirmedAccounts
    : Array.isArray(confirmedAccounts?.accountsList)
      ? confirmedAccounts.accountsList
      : Array.isArray(confirmedAccounts?.accounts)
        ? confirmedAccounts.accounts
        : confirmedAccounts && typeof confirmedAccounts === 'object'
          ? [confirmedAccounts]
          : [];

  if (origList.length === 0 && confList.length > 0) return true;
  if (origList.length !== confList.length) return true;

  for (let i = 0; i < confList.length; i += 1) {
    const orig = origList[i] || {};
    const conf = confList[i] || {};
    if (
      String(orig.bankName || '').trim() !== String(conf.bankName || '').trim() ||
      String(orig.accountType || '').trim() !== String(conf.accountType || '').trim() ||
      String(orig.accountNumber || '').trim() !== String(conf.accountNumber || '').trim() ||
      normalizeTemplateCurrency(orig.currency) !== normalizeTemplateCurrency(conf.currency) ||
      cleanAmount(orig.currentBalance) !== cleanAmount(conf.currentBalance)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Extrae palabras clave significativas del texto OCR y de las cuentas confirmadas
 * para identificar el layout en futuras subidas.
 *
 * @param {string} ocrText
 * @param {string} bankName
 * @param {Array<object>} confirmedList
 * @returns {string[]}
 */
export function deriveTemplateKeywords(ocrText, bankName, confirmedList = []) {
  const keywords = new Set();
  if (bankName) {
    keywords.add(String(bankName).trim());
  }

  for (const acc of confirmedList) {
    if (acc?.accountType) {
      keywords.add(String(acc.accountType).trim());
    }
    if (acc?.bankName) {
      keywords.add(String(acc.bankName).trim());
    }
  }

  const cleaned = cleanMobileUiText(String(ocrText || ''));
  const lines = cleaned
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 4 && !isMobileUiNoiseLine(l));

  for (const line of lines.slice(0, 12)) {
    // Tomar encabezados descriptivos sin secuencias largas de dígitos
    if (!/\d{6,}/.test(line) && line.length <= 48) {
      keywords.add(line);
    }
    if (keywords.size >= 8) break;
  }

  return Array.from(keywords).filter(Boolean);
}

/**
 * Construye o actualiza un documento de plantilla `bank_templates` a partir de las cuentas
 * confirmadas/corregidas por el usuario y lo guarda en Firestore (`bank_templates`)
 * y en IndexedDB (`bank_templates_local`).
 *
 * @param {{
 *   originalExtracted?: Array<object>|object,
 *   confirmedAccounts: Array<object>|object,
 *   ocrText?: string,
 *   bankId?: string,
 *   bankName?: string,
 *   firestoreDb?: any,
 *   firestoreModule?: any,
 *   indexedDb?: IDBFactory,
 *   storage?: Storage
 * }} params
 */
export async function learnBankTemplateFromConfirmation(params = {}) {
  const rawConfirmed = params.confirmedAccounts;
  const confirmedList = (
    Array.isArray(rawConfirmed)
      ? rawConfirmed
      : Array.isArray(rawConfirmed?.accountsList)
        ? rawConfirmed.accountsList
        : Array.isArray(rawConfirmed?.accounts)
          ? rawConfirmed.accounts
          : rawConfirmed && typeof rawConfirmed === 'object'
            ? [rawConfirmed]
            : []
  ).filter((item) => item && typeof item === 'object' && item.selected !== false);

  if (confirmedList.length === 0) {
    return null;
  }

  const origList = Array.isArray(params.originalExtracted)
    ? params.originalExtracted
    : Array.isArray(params.originalExtracted?.accountsList)
      ? params.originalExtracted.accountsList
      : Array.isArray(params.originalExtracted?.accounts)
        ? params.originalExtracted.accounts
        : [];

  const primaryBankName =
    String(params.bankName || confirmedList[0]?.bankName || 'Banco Atlántida').trim() ||
    'Banco Atlántida';
  const ocrText = String(params.ocrText || '').trim();
  const bankId =
    String(params.bankId || '').trim() ||
    buildBankTemplateId(primaryBankName, ocrText);

  const existingTemplates = await getAllLocalBankTemplates(params);
  const existing = existingTemplates.find((t) => t.bankId === bankId) || null;

  const keywords = deriveTemplateKeywords(
    ocrText,
    primaryBankName,
    confirmedList
  );
  const mergedKeywords = existing
    ? Array.from(new Set([...existing.keywords, ...keywords])).slice(0, 14)
    : keywords;

  const typePatterns = confirmedList
    .map((acc) => escapeRegexLiteral(String(acc.accountType || '').trim()))
    .filter(Boolean);

  const numLengths = confirmedList
    .map((acc) => String(acc.accountNumber || '').replace(/\D+/g, '').length)
    .filter((len) => len > 0);
  const minLen = numLengths.length > 0 ? Math.min(...numLengths, 4) : 4;
  const maxLen = numLengths.length > 0 ? Math.max(...numLengths, 16) : 20;

  const extractionRules = {
    accountNumber:
      existing?.extractionRules?.accountNumber ||
      `\\b(\\d{${minLen},${maxLen}})\\b`,
    accountType:
      typePatterns.length > 0
        ? `(${typePatterns.join('|')})`
        : existing?.extractionRules?.accountType ||
          '(Cuenta\\s+de\\s+Ahorros?[^\\n]*|Cuenta\\s+Bancaria[^\\n]*)',
    currency:
      existing?.extractionRules?.currency ||
      '(LPS|HNL|L\\.?|Lempiras|USD|US\\$|\\$)',
    currentBalance:
      existing?.extractionRules?.currentBalance ||
      '(?:LPS|HNL|USD|\\$|L\\.?)*\\s*(\\d{1,3}(?:,\\d{3})+\\.\\d{2}|\\d+\\.\\d{2})',
  };

  const learnedAccounts = confirmedList.map((acc, idx) => {
    const origItem = origList[idx] || {};
    return {
      bankName: String(acc.bankName || primaryBankName).trim(),
      accountType: String(acc.accountType || 'Cuenta de Ahorro').trim(),
      productType: String(
        acc.productType ||
          (acc.isLoan
            ? 'Préstamo'
            : acc.isCreditCard
              ? 'Tarjeta de Crédito'
              : /cheque|corriente|negocio/i.test(String(acc.accountType || ''))
                ? 'Cheques'
                : 'Ahorro')
      ).trim(),
      accountNumber: String(acc.accountNumber || '').trim(),
      currency: normalizeTemplateCurrency(acc.currency),
      currentBalance: cleanAmount(acc.currentBalance ?? 0),
      isCreditCard: Boolean(acc.isCreditCard),
      isLoan: Boolean(acc.isLoan),
      rawAccountNumberToken: String(origItem.accountNumber || acc.accountNumber || '').trim(),
      rawAccountTypeToken: String(origItem.accountType || acc.accountType || '').trim(),
    };
  });

  const userEdited = hasUserEditedExtractedAccounts(params.originalExtracted, confirmedList);
  const fingerprint = ocrText ? computeLayoutFingerprint(ocrText) : existing?.fingerprint || '';

  const templateDoc = normalizeBankTemplate({
    bankId,
    bankName: primaryBankName,
    keywords: mergedKeywords,
    extractionRules,
    learnedAccounts,
    fingerprint,
    updatedAt: new Date().toISOString(),
  });

  const saveResult = await saveBankTemplate(templateDoc, params);

  return {
    ...saveResult,
    userEdited,
  };
}
