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

/**
 * Tipos de documento soportados por el Motor Unificado de Clasificación y OCR.
 */
export const SMART_SCAN_DOCUMENT_TYPES = Object.freeze({
  VOUCHER_POS: 'Voucher POS',
  INVOICE_RECEIPT: 'Factura/Recibo',
  CREDIT_SLIP: 'Comprobante de Crédito (Ingreso)',
  DEBIT_SLIP: 'Comprobante de Débito (Gasto)',
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
 * Sanitiza montos monetarios eliminando símbolos de moneda y comas de miles
 * (ej. "3,901.33" -> 3901.33, "L. 12,450.50" -> 12450.5).
 * @param {string|number} rawValue
 * @returns {number}
 */
export function sanitizeSmartScanAmount(rawValue) {
  return cleanAmount(rawValue);
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
 * Clasifica el texto extraído por OCR / PDF en uno de los 4 tipos de documento.
 * @param {string} rawText
 * @returns {string} Uno de los valores de SMART_SCAN_DOCUMENT_TYPES
 */
export function classifySmartScanDocumentType(rawText = '') {
  const text = String(rawText || '').toUpperCase();

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

  // 4. Factura / Recibo (por defecto o coincidencia explícita SAR / CAI / RTN)
  return SMART_SCAN_DOCUMENT_TYPES.INVOICE_RECEIPT;
}

/**
 * Extrae el número de cuenta o los últimos 4 dígitos de tarjeta/cuenta presentes en el texto.
 * @param {string} rawText
 * @param {string} [fallbackLast4='']
 * @returns {string}
 */
export function extractIdentifiedAccountNumber(rawText = '', fallbackLast4 = '') {
  const text = String(rawText || '');

  // Patrones explícitos de cuenta bancaria o tarjeta en comprobantes
  const explicitAccountPatterns = [
    /(?:CUENTA\s+(?:DE\s+)?(?:DESTINO|ORIGEN|N[°ºo.]*|BANCARIA|AHORRO|CHEQUES)|CTA\.?\s*N[°ºo.]*|N[ÚU]MERO\s+DE\s+CUENTA)\s*[:#-]?\s*(?:\*+|X+|\.{2,})?\s*(\d[\d-\s]{2,18}\d)/i,
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
 * Consulta las cuentas activas del workspace (en memoria y opcionalmente en Firestore `accounts`)
 * y verifica si `cuentaIdentificada` coincide con el `accountNumber` o los últimos 4 dígitos.
 *
 * @param {string} cuentaIdentificada
 * @param {Array<object>} localAccounts
 * @param {object} [options]
 * @param {object} [options.firestoreDb]
 * @param {object} [options.firestoreModule]
 * @param {string} [options.workspaceId]
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

  // Consulta cuentas en Firestore (`accounts`) del workspace actual si está disponible
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
      accountId: '',
      matchedAccount: null,
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
      accountId: exactMatch.id,
      matchedAccount: exactMatch,
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
        accountId: last4Match.id,
        matchedAccount: last4Match,
        activeAccounts,
        matchedDigits: targetLast4,
      };
    }
  }

  return {
    matched: false,
    accountId: '',
    matchedAccount: null,
    activeAccounts,
    matchedDigits: targetLast4 || rawDigits,
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
  const candidateConcept = String(candidate.comercio || candidate.concept || candidate.merchant || '')
    .trim()
    .toUpperCase();

  if (!candidateDate || candidateAmount <= 0) {
    return { isDuplicate: false, matchType: null, duplicateTx: null };
  }

  // 1. Verificar coincidencia exacta (fecha + monto + concepto similar o misma cuenta)
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

  // 2. Reutilizar detector heurístico para vouchers vs estados de cuenta
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
 * Opcionalmente invoca Gemini Vision API cuando se provee una clave API y un imagen/PDF base64.
 * Si no está configurado o falla, retorna null para usar el motor local Tesseract.js / PDF.js.
 *
 * @param {string} dataUrl
 * @param {string} apiKey
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<object|null>}
 */
export async function extractWithGeminiVision(dataUrl, apiKey, fetchImpl = globalThis.fetch) {
  if (!dataUrl || !apiKey || typeof fetchImpl !== 'function') return null;
  const match = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;

  const mimeType = match[1];
  const base64Data = match[2];
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;

  const prompt = [
    'Extrae los datos de este comprobante financiero y responde estrictamente en JSON con las claves:',
    '{"fecha":"YYYY-MM-DD","comercio":"string","monto":0.00,"moneda":"HNL|USD","tipoDocumento":"Voucher POS|Factura/Recibo|Comprobante de Crédito (Ingreso)|Comprobante de Débito (Gasto)","cuentaIdentificada":"string"}',
  ].join(' ');

  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType, data: base64Data } },
            ],
          },
        ],
      }),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const textOut = payload?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const jsonMatch = textOut.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

/**
 * Analiza texto crudo de un documento o comprobante y construye el resultado normalizado
 * del Motor Unificado de Clasificación y OCR.
 *
 * @param {string} rawText
 * @param {object} [state]
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export async function parseSmartScanText(rawText = '', state = {}, options = {}) {
  const parsedVoucher = parseVoucherText(rawText, state);
  const tipoDocumento = classifySmartScanDocumentType(rawText);
  const tipoTransaccion = getTransactionTypeForDocument(tipoDocumento);
  const monto = sanitizeSmartScanAmount(parsedVoucher.amount);
  const fecha = parsedVoucher.date || new Date().toISOString().slice(0, 10);
  const comercio = parsedVoucher.merchant || 'Comercio / Movimiento';
  const moneda = parsedVoucher.currency === 'USD' ? 'USD' : 'HNL';
  const cuentaIdentificada = extractIdentifiedAccountNumber(rawText, parsedVoucher.cardLast4);

  const accountMatch = await matchAccountFromWorkspace(
    cuentaIdentificada,
    state?.accounts || [],
    options
  );

  const resolvedAccountId = accountMatch.matched
    ? accountMatch.accountId
    : options.preferredAccountId || '';

  // Categoría sugerida según si es ingreso o gasto
  let categoryId = parsedVoucher.categoryId || 'groceries';
  if (tipoTransaccion === TRANSACTION_TYPES.INCOME) {
    const incomeCat = (state?.categories || []).find((c) => c.type === TRANSACTION_TYPES.INCOME);
    categoryId = incomeCat?.id || 'salary';
  }

  const duplicateCheck = detectSmartScanDuplicate(
    { fecha, comercio, monto, moneda },
    state?.transactions || [],
    resolvedAccountId
  );

  // Detectar si además contiene múltiples filas de un estado de cuenta en PDF
  const statementParsed = parseBankStatementText(rawText, state, {
    targetAccountId: resolvedAccountId || accountMatch.activeAccounts[0]?.id,
    fallbackYear: options.fallbackYear,
  });

  return {
    fecha,
    comercio,
    monto,
    moneda,
    tipoDocumento,
    tipoTransaccion,
    cuentaIdentificada,
    categoryId,
    accountId: resolvedAccountId,
    accountMatch,
    isDuplicate: duplicateCheck.isDuplicate,
    duplicateType: duplicateCheck.matchType,
    duplicateTx: duplicateCheck.duplicateTx,
    detectedBank: parsedVoucher.detectedBank || statementParsed.detectedBank || null,
    breakdown: parsedVoucher.breakdown || { subtotal: 0, isv: 0, devolIsv: 0 },
    statementItems: statementParsed.items || [],
    isMultiRowStatement: (statementParsed.items || []).length >= 2,
    rawText,
  };
}

/**
 * Motor Unificado de Clasificación y OCR (`extractSmartScanDocument`).
 * Acepta cualquier formato de archivo (PNG, JPG, WEBP, PDF) o un objeto con texto/datos.
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

  // Soporte directo para texto crudo en pruebas unitarias o invocaciones directas
  if (typeof fileOrInput === 'string') {
    onProgress('Clasificando texto del documento...', 60);
    const result = await parseSmartScanText(fileOrInput, state, options);
    onProgress('Extracción completada', 100);
    return result;
  }

  if (typeof fileOrInput === 'object' && typeof fileOrInput.rawText === 'string' && !(fileOrInput instanceof Blob)) {
    onProgress('Clasificando datos del comprobante...', 60);
    const result = await parseSmartScanText(fileOrInput.rawText, state, options);
    onProgress('Extracción completada', 100);
    return {
      ...result,
      originalDataUrl: fileOrInput.originalDataUrl || null,
    };
  }

  const fileName = String(fileOrInput.name || '').toLowerCase();
  const mimeType = String(fileOrInput.type || '').toLowerCase();
  const isPdf = mimeType === 'application/pdf' || fileName.endsWith('.pdf');
  const isImage =
    mimeType.startsWith('image/') || /\.(png|jpe?g|webp|bmp|gif)$/i.test(fileName);

  if (!isPdf && !isImage) {
    throw new Error('Formato no soportado. Sube un archivo PNG, JPG, WEBP o PDF.');
  }

  let decoded = null;
  if (isPdf) {
    decoded = await decodeVoucherFile(fileOrInput, state, onProgress);
    // Si el PDF tiene múltiples páginas de estado de cuenta, intenta extraer el texto completo
    if (!decoded.rawText || decoded.rawText.trim().length < 20) {
      const stmtDecoded = await decodeBankStatementPdf(fileOrInput, state, options, onProgress);
      decoded = {
        ...decoded,
        rawText: stmtDecoded.rawText || decoded.rawText || '',
      };
    }
  } else {
    decoded = await decodeVoucherFile(fileOrInput, state, onProgress);
  }

  const parsed = await parseSmartScanText(decoded.rawText || '', state, options);

  // Si hay Gemini Vision API key configurada y el monto no pudo extraerse localmente, intenta enriquecer
  if (parsed.monto <= 0 && options.geminiApiKey && decoded.originalDataUrl) {
    const geminiData = await extractWithGeminiVision(
      decoded.originalDataUrl,
      options.geminiApiKey,
      options.fetchImpl
    );
    if (geminiData) {
      if (geminiData.fecha) parsed.fecha = String(geminiData.fecha).slice(0, 10);
      if (geminiData.comercio) parsed.comercio = String(geminiData.comercio).trim();
      if (geminiData.monto !== undefined) {
        parsed.monto = sanitizeSmartScanAmount(geminiData.monto);
      }
      if (geminiData.moneda === 'USD' || geminiData.moneda === 'HNL') {
        parsed.moneda = geminiData.moneda;
      }
      if (geminiData.tipoDocumento) {
        parsed.tipoDocumento = geminiData.tipoDocumento;
        parsed.tipoTransaccion = getTransactionTypeForDocument(geminiData.tipoDocumento);
      }
      if (geminiData.cuentaIdentificada) {
        parsed.cuentaIdentificada = extractIdentifiedAccountNumber(
          String(geminiData.cuentaIdentificada)
        );
        parsed.accountMatch = await matchAccountFromWorkspace(
          parsed.cuentaIdentificada,
          state?.accounts || [],
          options
        );
        if (parsed.accountMatch.matched) {
          parsed.accountId = parsed.accountMatch.accountId;
        }
      }
    }
  }

  return {
    ...parsed,
    originalDataUrl: decoded.originalDataUrl || null,
    preprocessedDataUrl: decoded.preprocessedDataUrl || null,
  };
}
