/**
 * @fileoverview Motor de Coincidencia y Bucle de Aprendizaje Machine Learning por País (`src/js/services/patternLearner.js`).
 *
 * Implementa el flujo de 3 etapas sobre la colección `document_templates` (Firestore + IndexedDB):
 * - Paso 1 (Identify): Consulta `document_templates` filtrando por `user.country` y evalúa
 *   `matchingRules.fingerprintKeywords` + patrones de encabezado en el texto extraído.
 * - Paso 2 (Parse): Si encuentra coincidencia con confianza `> 99%` (`confidence > 0.99`),
 *   extrae el encabezado (`headerRegexPatterns`) y los movimientos/líneas (`lineItemRegexPattern`)
 *   100% en local a costo 0 (`apiCost: 0`).
 * - Paso 3 (Learn/Feedback): Cuando el usuario edita o confirma campos en `SmartScanModal.js`,
 *   incrementa `metadata.sampleCount`, mejora `metadata.accuracyScore` (hasta `0.999`),
 *   incrementa `metadata.version` y refina `matchingRules` en Firestore e IndexedDB.
 *
 * Reglas del Stack:
 * - JavaScript Vanilla (ESNext Modules) puro, cero código muerto, cero `console.log`.
 */

import { cleanAmount } from '../../../public/js/schemas/accountScan.js';
import {
  DEFAULT_USER_COUNTRY,
  normalizeUserCountryCode,
  getCountryRegionalConfig,
  getActiveUserCountry,
} from './user.js';
import {
  normalizeTemplateCurrency,
} from './templateLearner.js';
import {
  normalizeStatementDate,
  detectCountryTaxAndCurrency,
} from './bankTemplateMatcher.js';
import {
  parseMultiProductBankText,
} from './ocrExtractor.js';
import {
  DOCUMENT_TEMPLATES_COLLECTION,
  DOCUMENT_TEMPLATES_LOCAL_STORE,
  DOCUMENT_TEMPLATE_TYPES,
  MAX_TEMPLATE_ACCURACY_SCORE,
  HIGH_CONFIDENCE_THRESHOLD,
  DEFAULT_HONDURAN_DOCUMENT_TEMPLATES,
  normalizeDocumentTemplateType,
  buildDocumentTemplateId,
  normalizeDocumentTemplate,
  queryDocumentTemplatesByCountry,
  saveDocumentTemplateToFirestore,
} from './templateDatabase.js';

/**
 * Normaliza una cadena para búsqueda insensible a mayúsculas/acentos y espacios múltiples.
 *
 * @param {string} str
 * @returns {string}
 */
function normalizeSearchText(str = '') {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Ejecuta una expresión regular segura devolviendo el primer grupo de captura no vacío.
 *
 * @param {string} text
 * @param {string|RegExp} pattern
 * @returns {string}
 */
function extractFirstCaptureSafe(text = '', pattern = '') {
  if (!text || !pattern) return '';
  try {
    const regex =
      pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'im');
    const match = String(text).match(regex);
    if (!match) return '';
    for (let i = 1; i < match.length; i += 1) {
      if (match[i] !== undefined && String(match[i]).trim() !== '') {
        return String(match[i]).trim();
      }
    }
    return String(match[0] || '').trim();
  } catch {
    return '';
  }
}

/**
 * Paso 1 (Identify): Consulta `document_templates` filtrado por `user.country` y busca
 * `matchingRules.fingerprintKeywords` y patrones de encabezado en el texto extraído.
 *
 * @param {string} extractedText
 * @param {{
 *   country?: string,
 *   user?: { country?: string },
 *   docType?: string,
 *   confidenceThreshold?: number,
 *   templates?: Array<object>,
 *   firestoreDb?: any,
 *   firestoreModule?: any,
 *   indexedDb?: IDBFactory,
 *   storage?: Storage
 * }} [options]
 * @returns {Promise<{
 *   matched: boolean,
 *   highConfidence: boolean,
 *   confidence: number,
 *   confidencePercent: number,
 *   country: string,
 *   template: ReturnType<typeof normalizeDocumentTemplate> | null,
 *   matchedKeywords: Array<string>,
 *   headerMatchesCount: number
 * }>}
 */
export async function identifyDocumentTemplate(extractedText = '', options = {}) {
  const targetCountry = normalizeUserCountryCode(
    options?.country || options?.user?.country || getActiveUserCountry(options)
  );
  const threshold =
    typeof options?.confidenceThreshold === 'number'
      ? options.confidenceThreshold
      : HIGH_CONFIDENCE_THRESHOLD;

  const rawText = String(extractedText || '');
  const normText = normalizeSearchText(rawText);

  if (!normText) {
    return {
      matched: false,
      highConfidence: false,
      confidence: 0,
      confidencePercent: 0,
      country: targetCountry,
      template: null,
      matchedKeywords: [],
      headerMatchesCount: 0,
    };
  }

  const candidateTemplates = Array.isArray(options?.templates) && options.templates.length > 0
    ? options.templates
        .map((t) => normalizeDocumentTemplate(t))
        .filter((t) => t.country === targetCountry)
    : await queryDocumentTemplatesByCountry(targetCountry, options);

  let bestTemplate = null;
  let bestConfidence = 0;
  let bestMatchedKeywords = [];
  let bestHeaderMatchesCount = 0;

  for (const tpl of candidateTemplates) {
    const keywords = tpl.matchingRules?.fingerprintKeywords || [];
    const matchedKeywords = [];

    for (const kw of keywords) {
      const normKw = normalizeSearchText(kw);
      if (normKw && normText.includes(normKw)) {
        matchedKeywords.push(kw);
      }
    }

    const normInst = normalizeSearchText(tpl.institutionName);
    const institutionMatched = Boolean(
      normInst && normInst.length >= 3 && normText.includes(normInst)
    );

    const headerPatterns = tpl.matchingRules?.headerRegexPatterns || {};
    let headerMatchesCount = 0;
    for (const patternStr of Object.values(headerPatterns)) {
      if (extractFirstCaptureSafe(rawText, patternStr)) {
        headerMatchesCount += 1;
      }
    }

    if (matchedKeywords.length === 0 && !institutionMatched) {
      continue;
    }

    const effectiveKeywordHits =
      matchedKeywords.length + (institutionMatched ? 1 : 0);

    // Calcular confianza combinando coincidencias de fingerprintKeywords, headerRegexPatterns y accuracyScore
    let computedConfidence = 0;
    if (matchedKeywords.length >= 3 || (matchedKeywords.length >= 2 && headerMatchesCount >= 1)) {
      const baseAccuracy = Math.max(0.992, tpl.metadata?.accuracyScore || 0.995);
      const bonus = Math.min(
        0.007,
        matchedKeywords.length * 0.001 + headerMatchesCount * 0.0005
      );
      computedConfidence = Math.min(
        MAX_TEMPLATE_ACCURACY_SCORE,
        Number((baseAccuracy + bonus).toFixed(4))
      );
    } else if (effectiveKeywordHits >= 2) {
      const baseAccuracy = Math.max(0.991, tpl.metadata?.accuracyScore || 0.993);
      computedConfidence = Math.min(
        MAX_TEMPLATE_ACCURACY_SCORE,
        Number((baseAccuracy + headerMatchesCount * 0.001).toFixed(4))
      );
    } else if (matchedKeywords.length === 1 && headerMatchesCount >= 2) {
      computedConfidence = Math.min(
        MAX_TEMPLATE_ACCURACY_SCORE,
        Number(Math.max(0.991, tpl.metadata?.accuracyScore || 0.992).toFixed(4))
      );
    } else {
      computedConfidence = Number(
        Math.min(0.85, 0.45 + effectiveKeywordHits * 0.15 + headerMatchesCount * 0.1).toFixed(4)
      );
    }

    if (
      computedConfidence > bestConfidence ||
      (computedConfidence === bestConfidence &&
        matchedKeywords.length > bestMatchedKeywords.length)
    ) {
      bestConfidence = computedConfidence;
      bestTemplate = tpl;
      bestMatchedKeywords = matchedKeywords;
      bestHeaderMatchesCount = headerMatchesCount;
    }
  }

  const highConfidence = Boolean(bestTemplate && bestConfidence > threshold);
  return {
    matched: Boolean(bestTemplate && bestConfidence >= 0.6),
    highConfidence,
    confidence: bestConfidence,
    confidencePercent: Number((bestConfidence * 100).toFixed(2)),
    country: targetCountry,
    template: bestTemplate,
    matchedKeywords: bestMatchedKeywords,
    headerMatchesCount: bestHeaderMatchesCount,
  };
}

/**
 * Paso 2 (Parse): Extrae el encabezado (`headerRegexPatterns`) y las líneas/transacciones
 * (`lineItemRegexPattern`) localmente a costo 0 usando la plantilla de `document_templates`.
 *
 * @param {string} extractedText
 * @param {object} rawTemplate
 * @param {{ country?: string }} [options]
 */
export function parseDocumentWithTemplate(
  extractedText = '',
  rawTemplate = {},
  options = {}
) {
  const template = normalizeDocumentTemplate(rawTemplate);
  const targetCountry = normalizeUserCountryCode(
    options?.country || template.country || DEFAULT_USER_COUNTRY
  );
  const regional = getCountryRegionalConfig(targetCountry);
  const text = String(extractedText || '');
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const headerPatterns = template.matchingRules?.headerRegexPatterns || {};
  const extractedHeader = {};
  for (const [key, patternStr] of Object.entries(headerPatterns)) {
    const val = extractFirstCaptureSafe(text, patternStr);
    if (val) {
      extractedHeader[key] = val;
    }
  }

  const taxMetadata = detectCountryTaxAndCurrency(text, targetCountry);
  const resolvedCurrency = normalizeTemplateCurrency(
    extractedHeader.currency || taxMetadata.currency || regional.defaultCurrency,
    targetCountry
  );

  // Caso A: Voucher POS / Factura Fiscal / Recibo
  if (
    template.docType === DOCUMENT_TEMPLATE_TYPES.POS_VOUCHER ||
    template.docType === DOCUMENT_TEMPLATE_TYPES.TAX_INVOICE ||
    template.docType === DOCUMENT_TEMPLATE_TYPES.RECEIPT
  ) {
    const subtotal = cleanAmount(extractedHeader.subtotal || 0);
    const taxAmount = cleanAmount(
      extractedHeader.taxAmount || taxMetadata.taxAmount || 0
    );
    const totalAmount = cleanAmount(
      extractedHeader.totalAmount ||
        (subtotal > 0 ? subtotal + taxAmount : 0)
    );
    const voucherDate = normalizeStatementDate(
      extractedHeader.date || '',
      new Date().toISOString().slice(0, 10)
    );
    const merchantName =
      extractedHeader.merchantName ||
      lines.find(
        (l) =>
          !/\b(?:RTN|CAI|SUBTOTAL|ISV|IVA|TOTAL|FACTURA|FECHA)\b/i.test(l) &&
          l.length >= 3
      ) ||
      template.institutionName;

    const lineItems = [];
    const linePattern = template.matchingRules?.lineItemRegexPattern;
    if (linePattern) {
      const lineRegex = new RegExp(linePattern, 'i');
      for (const line of lines) {
        if (/\b(?:SUBTOTAL|I\.?S\.?V\.?|I\.?V\.?A\.?|TOTAL|RTN|CAI|CAMBIO|EFECTIVO)\b/i.test(line)) {
          continue;
        }
        const m = line.match(lineRegex);
        if (m) {
          const qty = Number(m[1] || 1) || 1;
          const desc = String(m[2] || '').trim();
          const amt = cleanAmount(m[3] || 0);
          if (desc && amt > 0) {
            lineItems.push({
              quantity: qty,
              concept: desc,
              amount: amt,
              currency: resolvedCurrency,
            });
          }
        }
      }
    }

    const singleTx = {
      date: voucherDate,
      concept: String(merchantName).trim(),
      amount: totalAmount > 0 ? totalAmount : lineItems[0]?.amount || 0,
      type: 'expense',
      currency: resolvedCurrency,
    };

    return {
      stage: 'local-document-template',
      usedLocalTemplate: true,
      usedGeminiFallback: false,
      apiCost: 0,
      country: targetCountry,
      docType: template.docType,
      institutionName: template.institutionName,
      bankName: template.institutionName,
      templateId: template.id,
      template,
      header: {
        ...extractedHeader,
        merchantName: String(merchantName).trim(),
        rtn: extractedHeader.rtn || '',
        cai: extractedHeader.cai || '',
        invoiceNumber: extractedHeader.invoiceNumber || '',
        date: voucherDate,
        subtotal,
        taxAmount,
        totalAmount: singleTx.amount,
        currency: resolvedCurrency,
      },
      accountInfo: {
        accountName: template.institutionName,
        accountNumber: extractedHeader.accountNumber || '',
        currency: resolvedCurrency,
        currentBalance: singleTx.amount,
      },
      taxMetadata: {
        ...taxMetadata,
        taxAmount,
      },
      lineItems,
      transactions: singleTx.amount > 0 ? [singleTx] : [],
      accountsList: [],
    };
  }

  // Caso B: Estado de Cuenta Bancario o Resumen de Productos Multicuenta
  const multiParsed = parseMultiProductBankText(text, {
    defaultBankName: template.institutionName,
    expandDualCurrencyCards: true,
    country: targetCountry,
  });

  const transactions = [];
  const linePattern = template.matchingRules?.lineItemRegexPattern;
  if (linePattern) {
    const lineRegex = new RegExp(linePattern, 'i');
    for (const line of lines) {
      if (
        /\b(?:FECHA\s+DE\s+CORTE|FECHA\s+DE\s+PAGO|SALDO\s+ANTERIOR|SALDO\s+ACTUAL|L[IÍ]MITE\s+DE\s+CR[EÉ]DITO|PAGO\s+M[IÍ]NIMO|PAGO\s+DE\s+CONTADO)\b/i.test(
          line
        )
      ) {
        continue;
      }
      const match = line.match(lineRegex);
      if (match && match.length >= 4) {
        const rawDateCandidate = match[1] || '';
        const isDateLine =
          /^(?:20\d{2}[-/]\d{2}[-/]\d{2}|\d{1,2}[-/](?:[A-Za-z]{3,9}|\d{1,2})[-/]\d{2,4})$/i.test(
            rawDateCandidate.trim()
          );
        if (isDateLine) {
          const txDate = normalizeStatementDate(
            rawDateCandidate,
            normalizeStatementDate(extractedHeader.cutoffDate || '', '2026-09-05')
          );
          const txTime = String(match[2] || '12:00 AM').trim();
          const txConcept = String(match[3] || '')
            .replace(/\s{2,}/g, ' ')
            .replace(/^[-*•:|]+|[-*•:|]+$/g, '')
            .trim();
          const rawAmtStr = String(match[4] || '');
          const txAmount = cleanAmount(rawAmtStr);

          if (txConcept && txAmount > 0) {
            const isIncome =
              rawAmtStr.trim().startsWith('+') ||
              /\b(?:ABONO|CR[EÉ]DITO|DEP[OÓ]SITO|SU\s+PAGO\s+GRACIAS|PAGO\s+RECIBIDO|REVERSI[OÓ]N)\b/i.test(
                `${txConcept} ${line}`
              );
            transactions.push({
              date: txDate,
              time: txTime,
              concept: txConcept,
              amount: txAmount,
              type: isIncome ? 'income' : 'expense',
              currency: /\bUSD\b|\bUS\$/i.test(line) ? 'USD' : resolvedCurrency,
            });
          }
        }
      }
    }
  }

  const finalTransactions =
    transactions.length > 0 ? transactions : multiParsed.transactionsList || [];

  const accountNumber = String(
    extractedHeader.accountNumber ||
      multiParsed.accountsList?.[0]?.accountNumber ||
      ''
  ).replace(/[^\d]/g, '');

  const accountName = String(
    extractedHeader.accountName ||
      multiParsed.accountsList?.[0]?.accountType ||
      'Cuenta / Tarjeta'
  ).trim();

  const currentBalance = cleanAmount(
    extractedHeader.currentBalance ||
      multiParsed.accountsList?.[0]?.currentBalance ||
      finalTransactions.reduce((acc, tx) => acc + tx.amount, 0)
  );
  const minimumPayment = cleanAmount(extractedHeader.minimumPayment || 0);
  const creditLimit = cleanAmount(extractedHeader.creditLimit || 0);

  return {
    stage: 'local-document-template',
    usedLocalTemplate: true,
    usedGeminiFallback: false,
    apiCost: 0,
    country: targetCountry,
    docType: template.docType,
    institutionName: template.institutionName,
    bankName: template.institutionName,
    templateId: template.id,
    template,
    header: {
      ...extractedHeader,
      accountName,
      accountNumber,
      currency: resolvedCurrency,
      currentBalance,
      minimumPayment,
      creditLimit,
    },
    accountInfo: {
      accountName,
      accountNumber,
      owner: String(extractedHeader.owner || '').trim(),
      cutoffDate: normalizeStatementDate(extractedHeader.cutoffDate || ''),
      paymentDueDate: normalizeStatementDate(extractedHeader.paymentDueDate || ''),
      currency: resolvedCurrency,
      currentBalance,
      minimumPayment,
      creditLimit,
    },
    taxMetadata,
    accountsList: multiParsed.accountsList || [],
    transactions: finalTransactions,
    lineItems: finalTransactions,
  };
}

/**
 * Ejecuta el Paso 1 (Identify) y Paso 2 (Parse) de forma integrada:
 * - Busca una plantilla en `document_templates` para el `country` del usuario.
 * - Si la confianza es `> 99%` (`confidence > 0.99`), extrae localmente a costo 0.
 *
 * @param {string} extractedText
 * @param {object} [options]
 */
export async function matchAndParseDocumentWithTemplate(
  extractedText = '',
  options = {}
) {
  const identification = await identifyDocumentTemplate(extractedText, options);
  if (!identification.highConfidence || !identification.template) {
    return {
      matched: false,
      highConfidence: false,
      confidence: identification.confidence,
      confidencePercent: identification.confidencePercent,
      country: identification.country,
      template: identification.template,
      extracted: null,
    };
  }

  const extracted = parseDocumentWithTemplate(
    extractedText,
    identification.template,
    { country: identification.country }
  );

  return {
    matched: true,
    highConfidence: true,
    confidence: identification.confidence,
    confidencePercent: identification.confidencePercent,
    country: identification.country,
    template: identification.template,
    matchedKeywords: identification.matchedKeywords,
    extracted,
  };
}

/**
 * Paso 3 (Learn/Feedback): Cuando el usuario edita o confirma campos en `SmartScanModal.js`,
 * incrementa `metadata.sampleCount`, mejora `metadata.accuracyScore` (hasta `0.999`),
 * incrementa `metadata.version` y refina `matchingRules` en `document_templates` (Firestore + IndexedDB).
 *
 * @param {{
 *   templateId?: string,
 *   country?: string,
 *   docType?: string,
 *   institutionName?: string,
 *   bankName?: string,
 *   merchantName?: string,
 *   accountNumber?: string,
 *   accountName?: string,
 *   currency?: string,
 *   rtn?: string,
 *   cai?: string,
 *   rawText?: string,
 *   transactions?: Array<object>,
 *   fingerprintKeywords?: Array<string>,
 *   headerRegexPatterns?: Record<string, string>,
 *   lineItemRegexPattern?: string
 * }} [confirmationPayload={}]
 * @param {{
 *   firestoreDb?: any,
 *   firestoreModule?: any,
 *   indexedDb?: IDBFactory,
 *   storage?: Storage,
 *   state?: object
 * }} [options={}]
 */
export async function recordDocumentTemplateFeedback(
  confirmationPayload = {},
  options = {}
) {
  const targetCountry = normalizeUserCountryCode(
    confirmationPayload?.country ||
      options?.country ||
      getActiveUserCountry({ ...options, state: options?.state })
  );

  const docType = normalizeDocumentTemplateType(
    confirmationPayload?.docType ||
      confirmationPayload?.documentType ||
      confirmationPayload?.tipoDocumento ||
      DOCUMENT_TEMPLATE_TYPES.BANK_STATEMENT
  );

  const institutionName = String(
    confirmationPayload?.institutionName ||
      confirmationPayload?.bankName ||
      confirmationPayload?.detectedBank ||
      confirmationPayload?.merchantName ||
      confirmationPayload?.comercio ||
      'Banco Promerica'
  ).trim();

  const existingTemplates = await queryDocumentTemplatesByCountry(
    targetCountry,
    options
  );

  const targetId = String(
    confirmationPayload?.templateId ||
      confirmationPayload?.id ||
      ''
  ).trim();

  const normInst = normalizeSearchText(institutionName);
  const existingMatch =
    (targetId && existingTemplates.find((t) => t.id === targetId)) ||
    existingTemplates.find(
      (t) =>
        t.docType === docType &&
        (normalizeSearchText(t.institutionName) === normInst ||
          normalizeSearchText(t.institutionName).includes(normInst) ||
          normInst.includes(normalizeSearchText(t.institutionName)))
    ) ||
    null;

  const prevSampleCount = existingMatch?.metadata?.sampleCount || 0;
  const prevAccuracy = existingMatch?.metadata?.accuracyScore || 0.99;
  const prevVersion = existingMatch?.metadata?.version || 0;

  const nextSampleCount = prevSampleCount + 1;
  const nextAccuracyScore = Math.min(
    MAX_TEMPLATE_ACCURACY_SCORE,
    Number((prevAccuracy + (MAX_TEMPLATE_ACCURACY_SCORE - prevAccuracy) * 0.35).toFixed(4))
  );
  const nextVersion = prevVersion + 1;

  // Refinar `fingerprintKeywords`
  const mergedKeywords = new Set(
    existingMatch?.matchingRules?.fingerprintKeywords || []
  );
  if (institutionName && institutionName !== 'Banco Local') {
    mergedKeywords.add(institutionName);
  }
  if (Array.isArray(confirmationPayload?.fingerprintKeywords)) {
    for (const kw of confirmationPayload.fingerprintKeywords) {
      if (kw && String(kw).trim()) mergedKeywords.add(String(kw).trim());
    }
  }
  if (confirmationPayload?.accountName && String(confirmationPayload.accountName).trim()) {
    mergedKeywords.add(String(confirmationPayload.accountName).trim());
  }
  if (confirmationPayload?.accountNumber && String(confirmationPayload.accountNumber).trim()) {
    const cleanAccNum = String(confirmationPayload.accountNumber).trim();
    const rawText = String(confirmationPayload?.rawText || '');
    if (rawText.includes(`Cuenta: ${cleanAccNum}`)) {
      mergedKeywords.add(`Cuenta: ${cleanAccNum}`);
    }
  }
  if (Array.isArray(confirmationPayload?.transactions)) {
    const firstConcept = String(
      confirmationPayload.transactions[0]?.concept ||
        confirmationPayload.transactions[0]?.comercio ||
        ''
    ).trim();
    if (firstConcept && firstConcept.length >= 4 && firstConcept.length <= 40) {
      mergedKeywords.add(firstConcept);
    }
  }

  // Refinar `headerRegexPatterns`
  const baseHeaders = {
    ...(existingMatch?.matchingRules?.headerRegexPatterns || {}),
    ...(confirmationPayload?.headerRegexPatterns || {}),
  };
  if (confirmationPayload?.accountNumber && !baseHeaders.accountNumber) {
    baseHeaders.accountNumber =
      '(?:Cuenta|CUENTA|TARJETA|N[°ºo.]*)[ \\t]*[:#-]?[ \\t]*(\\d{4,16})\\b';
  }
  if (confirmationPayload?.currency && !baseHeaders.currency) {
    baseHeaders.currency = '\\b(HNL|LPS|Lempiras|GTQ|USD|US\\$)\\b';
  }
  if (confirmationPayload?.rtn && !baseHeaders.rtn) {
    baseHeaders.rtn = '\\bRTN[ \\t]*[:.#-]?[ \\t]*(\\d{4}[- ]?\\d{4}[- ]?\\d{6}|\\d{14})\\b';
  }
  if (confirmationPayload?.cai && !baseHeaders.cai) {
    baseHeaders.cai = '\\bCAI[ \\t]*[:.#-]?[ \\t]*([A-Z0-9-]{14,40})\\b';
  }

  const defaultLinePattern =
    docType === DOCUMENT_TEMPLATE_TYPES.POS_VOUCHER ||
    docType === DOCUMENT_TEMPLATE_TYPES.TAX_INVOICE
      ? DEFAULT_HONDURAN_DOCUMENT_TEMPLATES[2].matchingRules.lineItemRegexPattern
      : DEFAULT_HONDURAN_DOCUMENT_TEMPLATES[0].matchingRules.lineItemRegexPattern;

  const lineItemRegexPattern = String(
    confirmationPayload?.lineItemRegexPattern ||
      existingMatch?.matchingRules?.lineItemRegexPattern ||
      defaultLinePattern
  );

  const updatedTemplate = normalizeDocumentTemplate({
    id:
      existingMatch?.id ||
      targetId ||
      buildDocumentTemplateId(targetCountry, institutionName, docType),
    country: targetCountry,
    docType,
    institutionName,
    matchingRules: {
      fingerprintKeywords: Array.from(mergedKeywords),
      headerRegexPatterns: baseHeaders,
      lineItemRegexPattern,
    },
    metadata: {
      accuracyScore: nextAccuracyScore,
      sampleCount: nextSampleCount,
      version: nextVersion,
      updatedAt: new Date().toISOString(),
    },
  });

  const saved = await saveDocumentTemplateToFirestore(updatedTemplate, {
    ...options,
    useUpdateDoc: Boolean(existingMatch),
  });

  return saved.template;
}

export {
  DOCUMENT_TEMPLATES_COLLECTION,
  DOCUMENT_TEMPLATES_LOCAL_STORE,
  DOCUMENT_TEMPLATE_TYPES,
  MAX_TEMPLATE_ACCURACY_SCORE,
  HIGH_CONFIDENCE_THRESHOLD,
  DEFAULT_HONDURAN_DOCUMENT_TEMPLATES,
  normalizeDocumentTemplateType,
  buildDocumentTemplateId,
  normalizeDocumentTemplate,
  queryDocumentTemplatesByCountry,
  saveDocumentTemplateToFirestore,
};
