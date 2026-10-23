/**
 * @fileoverview Extracción Nativa de Capa de Texto en PDF (`src/js/services/pdfExtractor.js`).
 *
 * Implementa:
 * 1. Iteración sobre todas las páginas de un archivo `.pdf` mediante `pdfjs-dist` y extracción
 *    de su capa de texto vectorial con `page.getTextContent()`.
 * 2. Concatenación de las líneas de texto manteniendo el orden espacial y de bloques.
 * 3. Si el texto extraído tiene más de 50 caracteres (`VECTOR_PDF_MIN_CHARS = 50`, PDF vectorial nativo),
 *    omite por completo el procesamiento con Tesseract.js (`skipTesseractOcr: true`) y aplica
 *    directamente el Parser de Patrones (`parseBankStatementTextData` en `bankParsers.js`).
 * 4. Estricto Vanilla JS (ESNext), código limpio y cero llamadas a `console.log`.
 */

import {
  parseBankStatementTextData,
  parseStatementHeaderAccountData,
  parseStatementTransactions,
  detectActiveStatementCurrency,
  normalizeBankStatementDate,
} from './bankParsers.js';

export const PDFJS_CDN_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/+esm';
export const PDFJS_WORKER_CDN_URL =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs';
export const VECTOR_PDF_MIN_CHARS = 50;

export {
  parseBankStatementTextData,
  parseStatementHeaderAccountData,
  parseStatementTransactions,
  detectActiveStatementCurrency,
  normalizeBankStatementDate,
};

/**
 * Convierte un archivo o entrada PDF (`File`, `Blob`, `ArrayBuffer`, `Uint8Array` o Data URL Base64)
 * en un arreglo binario `Uint8Array` apto para `pdfjsLib.getDocument({ data })`.
 *
 * @param {File|Blob|ArrayBuffer|Uint8Array|string|object} pdfFileOrInput
 * @returns {Promise<Uint8Array|null>}
 */
export async function extractPdfBinaryData(pdfFileOrInput) {
  if (!pdfFileOrInput) return null;
  if (pdfFileOrInput instanceof Uint8Array) return pdfFileOrInput;
  if (typeof ArrayBuffer !== 'undefined' && pdfFileOrInput instanceof ArrayBuffer) {
    return new Uint8Array(pdfFileOrInput);
  }
  if (typeof pdfFileOrInput.arrayBuffer === 'function') {
    const buffer = await pdfFileOrInput.arrayBuffer();
    return new Uint8Array(buffer);
  }
  if (typeof pdfFileOrInput === 'string') {
    const trimmed = pdfFileOrInput.trim();
    if (trimmed.startsWith('data:')) {
      const base64Part = trimmed.replace(/^data:[^;]+;base64,/, '');
      if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
        return new Uint8Array(Buffer.from(base64Part, 'base64'));
      }
      if (typeof atob === 'function') {
        const binary = atob(base64Part);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
      }
    }
  }
  return null;
}

/**
 * Normaliza espacios múltiples y caracteres de control dentro de una línea de texto de PDF.
 * @param {string} rawLine
 * @returns {string}
 */
export function cleanPdfTextLine(rawLine = '') {
  return String(rawLine || '')
    .replace(/\u00A0/g, ' ')
    .replace(/[\t\r]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Organiza los ítems crudos devueltos por `page.getTextContent()` en líneas de texto limpias.
 * Si los ítems incluyen coordenadas espaciales (`transform[4]` = X, `transform[5]` = Y),
 * agrupa los fragmentos que pertenecen al mismo renglón (tolerancia vertical de ±3.5 pt)
 * y los ordena de izquierda a derecha.
 *
 * @param {Array<{ str?: string, transform?: number[], hasEOL?: boolean }>} items
 * @returns {string[]}
 */
export function organizeTextItemsIntoLines(items = []) {
  if (!Array.isArray(items) || items.length === 0) return [];

  const hasSpatialCoords = items.some(
    (item) => Array.isArray(item?.transform) && item.transform.length >= 6
  );

  if (!hasSpatialCoords) {
    const rawJoined = items
      .map((item) => {
        const token = String(item?.str || '');
        return item?.hasEOL ? `${token}\n` : token;
      })
      .join(' ');
    return rawJoined
      .split(/\r?\n/)
      .map((line) => cleanPdfTextLine(line))
      .filter(Boolean);
  }

  const rows = [];
  const Y_TOLERANCE = 3.5;

  for (const item of items) {
    const str = String(item?.str || '');
    if (!str.trim() && !item?.hasEOL) continue;

    const tx = Array.isArray(item.transform) ? Number(item.transform[4]) || 0 : 0;
    const ty = Array.isArray(item.transform) ? Number(item.transform[5]) || 0 : 0;

    let matchingRow = rows.find((row) => Math.abs(row.y - ty) <= Y_TOLERANCE);
    if (!matchingRow) {
      matchingRow = { y: ty, tokens: [] };
      rows.push(matchingRow);
    }
    matchingRow.tokens.push({ x: tx, str: str.trim() });
  }

  // En coordenadas PDF estándar el eje Y crece de abajo hacia arriba (orden descendente = arriba a abajo)
  rows.sort((a, b) => b.y - a.y);

  return rows
    .map((row) => {
      row.tokens.sort((a, b) => a.x - b.x);
      return cleanPdfTextLine(row.tokens.map((t) => t.str).join(' '));
    })
    .filter(Boolean);
}

/**
 * Clasifica el tipo semántico de una línea de estado de cuenta bancario para organizar
 * el documento en bloques jerárquicos.
 *
 * @param {string} line
 * @returns {'header'|'account_info'|'balances_dates'|'transactions'|'summary'}
 */
function classifyPdfStatementLineSection(line = '') {
  const upper = String(line || '').toUpperCase();

  if (
    /\b(?:MOVIMIENTOS|TRANSACCIONES|DETALLE\s+DE\s+CONSUMOS|FECHA\s+HORA\s+CONCEPTO|SEGURO\s+DE\s+DEUDA|LEMPIRAS|D[ÓO]LARES)\b/.test(
      upper
    ) ||
    /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/.test(upper) ||
    /^20\d{2}-\d{2}-\d{2}\b/.test(upper) ||
    /\b\d{1,2}:\d{2}\s*(?:AM|PM)\b/.test(upper)
  ) {
    return 'transactions';
  }

  if (
    /\b(?:FECHA\s+DE\s+CORTE|FECHA\s+DE\s+PAGO|PAGO\s+DE\s+CONTADO|PAGO\s+M[IÍ]NIMO|SALDO\s+ACTUAL|SALDO\s+TOTAL|L[IÍ]MITE\s+DE\s+CR[EÉ]DITO|DISPONIBLE)\b/.test(
      upper
    )
  ) {
    return 'balances_dates';
  }

  if (
    /\b(?:CUENTA|TARJETA|PLATINUM|VISA|MASTERCARD|AMEX|AMERICAN\s+EXPRESS|TITULAR|CLIENTE|PROPIETARIO|N[ÚU]MERO\s+DE\s+CUENTA|PRODUCTO)\b/.test(
      upper
    )
  ) {
    return 'account_info';
  }

  if (
    /\b(?:BANCO|PROMERICA|CREDOMATIC|BAC\b|ATL[AÁ]NTIDA|FICOHSA|BANPA[IÍ]S|OCCIDENTE|DAVIVIENDA|LAFISE|ESTADO\s+DE\s+CUENTA)\b/.test(
      upper
    )
  ) {
    return 'header';
  }

  return 'summary';
}

const SECTION_TITLES = Object.freeze({
  header: 'Encabezado e Institución Financiera',
  account_info: 'Identificación de Cuenta / Tarjeta y Titular',
  balances_dates: 'Fechas de Corte, Pago, Saldos y Límites',
  transactions: 'Detalle de Movimientos del Período',
  summary: 'Información General del Estado de Cuenta',
});

/**
 * Agrupa las líneas limpias de una o varias páginas en bloques jerárquicos estructurados.
 *
 * @param {string[]} lines
 * @returns {Array<{
 *   id: string,
 *   type: 'header'|'account_info'|'balances_dates'|'transactions'|'summary',
 *   title: string,
 *   lines: string[],
 *   text: string
 * }>}
 */
export function organizeLinesIntoHierarchicalBlocks(lines = []) {
  const cleanLines = Array.isArray(lines)
    ? lines.map((l) => cleanPdfTextLine(l)).filter(Boolean)
    : [];

  if (cleanLines.length === 0) return [];

  const buckets = new Map();
  const orderedTypes = ['header', 'account_info', 'balances_dates', 'transactions', 'summary'];

  for (const type of orderedTypes) {
    buckets.set(type, []);
  }

  for (const line of cleanLines) {
    const sectionType = classifyPdfStatementLineSection(line);
    buckets.get(sectionType).push(line);
  }

  const blocks = [];
  for (const type of orderedTypes) {
    const groupLines = buckets.get(type) || [];
    if (groupLines.length === 0) continue;
    blocks.push({
      id: `pdf_block_${type}`,
      type,
      title: SECTION_TITLES[type] || type,
      lines: groupLines,
      text: groupLines.join('\n'),
    });
  }

  Object.defineProperties(blocks, {
    header: { value: buckets.get('header') || [], enumerable: false },
    accountInfo: { value: buckets.get('account_info') || [], enumerable: false },
    balancesDates: { value: buckets.get('balances_dates') || [], enumerable: false },
    movements: { value: buckets.get('transactions') || [], enumerable: false },
    transactions: { value: buckets.get('transactions') || [], enumerable: false },
    summary: { value: buckets.get('summary') || [], enumerable: false },
  });

  return blocks;
}

/**
 * Extrae el texto vectorial nativo iterando sobre todas las hojas del PDF con `pdfjs-dist`
 * (`page.getTextContent()`), concatena las líneas manteniendo el orden de bloques y, opcionalmente,
 * renderiza la primera página en un `<canvas>` HTML5 para la miniatura de vista previa.
 *
 * @param {File|Blob|ArrayBuffer|Uint8Array|string|object} pdfFileOrInput
 * @param {object} [options]
 * @returns {Promise<{
 *   isVectorPdf: boolean,
 *   hasSelectableText: boolean,
 *   pageCount: number,
 *   firstPageText: string,
 *   fullText: string,
 *   lines: string[],
 *   pages: Array<object>,
 *   hierarchicalBlocks: Array<object>,
 *   thumbnailDataUrl: string|null,
 *   renderedOnCanvas: boolean
 * }>}
 */
export async function extractNativePdfTextLayer(pdfFileOrInput, options = {}) {
  if (!pdfFileOrInput) {
    return {
      isVectorPdf: false,
      hasSelectableText: false,
      pageCount: 0,
      firstPageText: '',
      fullText: '',
      lines: [],
      pages: [],
      hierarchicalBlocks: [],
      thumbnailDataUrl: null,
      renderedOnCanvas: false,
    };
  }

  const isPlainTextInput =
    typeof pdfFileOrInput === 'string' &&
    !pdfFileOrInput.trim().startsWith('data:application/pdf') &&
    !pdfFileOrInput.trim().startsWith('%PDF-') &&
    !/^https?:\/\//i.test(pdfFileOrInput.trim());

  // Soporte directo si se pasa un objeto con texto ya extraído o string plano en pruebas
  if (
    isPlainTextInput ||
    (typeof pdfFileOrInput === 'object' &&
      typeof pdfFileOrInput.rawText === 'string' &&
      !pdfFileOrInput.arrayBuffer)
  ) {
    const sourceText = isPlainTextInput ? pdfFileOrInput : pdfFileOrInput.rawText;
    const rawLines = sourceText
      .split(/\r?\n/)
      .map((l) => cleanPdfTextLine(l))
      .filter(Boolean);
    const blocks = organizeLinesIntoHierarchicalBlocks(rawLines);
    const fullText = rawLines.join('\n');
    const isVectorPdf = fullText.length > VECTOR_PDF_MIN_CHARS || rawLines.length > 0;
    return {
      isVectorPdf,
      skipTesseractOcr: fullText.length > VECTOR_PDF_MIN_CHARS,
      hasSelectableText: rawLines.length > 0,
      pageCount: 1,
      charCount: fullText.length,
      firstPageText: fullText,
      fullText,
      rawText: fullText,
      lines: rawLines,
      pages: [
        {
          pageNumber: 1,
          rawText: fullText,
          lines: rawLines,
          blocks,
        },
      ],
      hierarchicalBlocks: blocks,
      thumbnailDataUrl:
        typeof pdfFileOrInput === 'object' ? pdfFileOrInput.thumbnailDataUrl || null : null,
      renderedOnCanvas:
        typeof pdfFileOrInput === 'object' ? Boolean(pdfFileOrInput.renderedOnCanvas) : false,
    };
  }

  try {
    const pdfBytes = await extractPdfBinaryData(pdfFileOrInput);
    const pdfjsLib =
      options.pdfjsLib ||
      (typeof options.pdfJsLoader === 'function' ? await options.pdfJsLoader() : null) ||
      (typeof globalThis !== 'undefined' ? globalThis.__PISTO_PDFJS_LIB__ : null) ||
      (await import(PDFJS_CDN_URL));

    if (pdfjsLib?.GlobalWorkerOptions && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_CDN_URL;
    }

    const loadingTask = pdfjsLib.getDocument(
      pdfBytes ? { data: pdfBytes } : { url: String(pdfFileOrInput) }
    );
    const pdfDoc = await (loadingTask?.promise || loadingTask);
    const totalPages = Math.max(1, Number(pdfDoc?.numPages) || 1);
    const maxPagesToRead = Math.min(totalPages, Number(options.maxPages) || 25);

    const pages = [];
    const allLines = [];
    let thumbnailDataUrl = null;
    let renderedOnCanvas = false;

    for (let pageNum = 1; pageNum <= maxPagesToRead; pageNum += 1) {
      const page = await pdfDoc.getPage(pageNum);

      // Renderizar miniatura de la primera página si se solicita y existe Canvas disponible
      if (pageNum === 1 && options.renderThumbnail !== false) {
        const targetDoc =
          options.doc || (typeof document !== 'undefined' ? document : null);
        const canvas =
          options.canvas ||
          (targetDoc && typeof targetDoc.createElement === 'function'
            ? targetDoc.createElement('canvas')
            : null);

        if (canvas && typeof page.getViewport === 'function' && typeof page.render === 'function') {
          try {
            const scale =
              typeof options.scale === 'number' && options.scale > 0 ? options.scale : 1.6;
            const viewport = page.getViewport({ scale });
            canvas.width = Math.max(1, Math.round(viewport?.width || 600));
            canvas.height = Math.max(1, Math.round(viewport?.height || 800));
            const ctx =
              typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
            if (ctx) {
              const renderTask = page.render({ canvasContext: ctx, viewport });
              await (renderTask?.promise || renderTask);
              if (typeof canvas.toDataURL === 'function') {
                const dataUrl = canvas.toDataURL('image/png');
                if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) {
                  thumbnailDataUrl = dataUrl;
                  renderedOnCanvas = true;
                }
              }
            }
          } catch {
            // Continuar con la extracción vectorial aunque el entorno no soporte Canvas 2D
          }
        }
      }

      let pageItems = [];
      if (typeof page.getTextContent === 'function') {
        const textContent = await page.getTextContent();
        pageItems = Array.isArray(textContent?.items) ? textContent.items : [];
      }

      const pageLines = organizeTextItemsIntoLines(pageItems);
      const pageBlocks = organizeLinesIntoHierarchicalBlocks(pageLines);
      const pageRawText = pageLines.join('\n');

      pages.push({
        pageNumber: pageNum,
        rawText: pageRawText,
        lines: pageLines,
        blocks: pageBlocks,
      });
      allLines.push(...pageLines);
    }

    const fullText = allLines.join('\n').trim();
    const firstPageText = pages[0]?.rawText || fullText;
    const hierarchicalBlocks = organizeLinesIntoHierarchicalBlocks(allLines);
    const hasSelectableText = fullText.replace(/\s+/g, '').length >= 12;
    const isVectorPdf = fullText.length > VECTOR_PDF_MIN_CHARS || hasSelectableText;

    return {
      isVectorPdf,
      skipTesseractOcr: fullText.length > VECTOR_PDF_MIN_CHARS,
      hasSelectableText,
      pageCount: totalPages,
      charCount: fullText.length,
      firstPageText,
      fullText,
      rawText: fullText,
      lines: allLines,
      pages,
      hierarchicalBlocks,
      thumbnailDataUrl,
      renderedOnCanvas,
    };
  } catch {
    return {
      isVectorPdf: false,
      skipTesseractOcr: false,
      hasSelectableText: false,
      pageCount: 0,
      charCount: 0,
      firstPageText: '',
      fullText: '',
      rawText: '',
      lines: [],
      pages: [],
      hierarchicalBlocks: [],
      thumbnailDataUrl: null,
      renderedOnCanvas: false,
    };
  }
}

/**
 * Extrae la capa de texto vectorial de todas las páginas de un archivo `.pdf` usando `pdfjs-dist`
 * (`page.getTextContent()`), concatena las líneas manteniendo el orden de bloques y, si el texto
 * supera los 50 caracteres (`> 50`), omite Tesseract.js y aplica directamente el Parser de Patrones
 * (`parseBankStatementTextData`).
 *
 * @param {File|Blob|ArrayBuffer|Uint8Array|string|object} currentFile
 * @param {object} [options={}]
 * @returns {Promise<object>}
 */
export async function extractPdfData(currentFile, options = {}) {
  if (!currentFile) {
    throw new Error('Selecciona un archivo PDF o documento válido para procesar.');
  }

  // Si ya es un objeto extraído sin archivo binario ni rawText pero con accountInfo o transactions
  if (
    typeof currentFile === 'object' &&
    !(typeof Blob !== 'undefined' && currentFile instanceof Blob) &&
    !currentFile.arrayBuffer &&
    !(currentFile instanceof Uint8Array) &&
    !(typeof ArrayBuffer !== 'undefined' && currentFile instanceof ArrayBuffer) &&
    !currentFile.rawText &&
    (currentFile.accountInfo ||
      currentFile.cuentaIdentificada ||
      currentFile.accountNumber ||
      Array.isArray(currentFile.transactions) ||
      Array.isArray(currentFile.statementItems))
  ) {
    const fallbackCurrency =
      currentFile.currency === 'USD' ||
      currentFile.moneda === 'USD' ||
      currentFile.accountInfo?.currency === 'USD'
        ? 'USD'
        : 'HNL';
    const rawTxList =
      currentFile.transactions ||
      currentFile.statementItems ||
      currentFile.statementTransactions ||
      [];
    const normalizedTxList = rawTxList.map((tx, idx) => ({
      id: tx.id || `stmt_tx_${idx + 1}`,
      selected: tx.selected !== false,
      rawDate: tx.rawDate || tx.date || tx.fecha || '05/09/2026',
      date: normalizeBankStatementDate(tx.date || tx.fecha || '2026-09-05'),
      fecha: normalizeBankStatementDate(tx.fecha || tx.date || '2026-09-05'),
      time: tx.time || '12:00 AM',
      concept: String(tx.concept || tx.comercio || tx.merchant || 'Movimiento').trim(),
      comercio: String(tx.comercio || tx.concept || tx.merchant || 'Movimiento').trim(),
      amount: Number(tx.amount ?? tx.monto ?? 0) || 0,
      monto: Number(tx.monto ?? tx.amount ?? 0) || 0,
      type: tx.type === 'income' || tx.tipo === 'income' ? 'income' : 'expense',
      tipo: tx.tipo === 'income' || tx.type === 'income' ? 'income' : 'expense',
      currency: tx.currency === 'USD' || tx.moneda === 'USD' ? 'USD' : fallbackCurrency,
      moneda: tx.moneda === 'USD' || tx.currency === 'USD' ? 'USD' : fallbackCurrency,
    }));
    const accNum = String(
      currentFile.accountNumber ||
        currentFile.cuentaIdentificada ||
        currentFile.accountInfo?.accountNumber ||
        ''
    ).trim();
    const bankName = String(
      currentFile.bankName ||
        currentFile.detectedBank ||
        currentFile.accountInfo?.bankName ||
        'Banco Promerica'
    ).trim();
    const accName = String(
      currentFile.accountName ||
        currentFile.accountInfo?.accountName ||
        currentFile.detectedAccountTypeLabel ||
        'MI TARJETA PLATINUM VISA GAS/EDU'
    ).trim();
    const firstTx = normalizedTxList[0] || null;

    return {
      ...currentFile,
      isVectorPdf: true,
      skipTesseractOcr: true,
      usedTesseractOcr: false,
      extractedCharCount: String(currentFile.rawText || '').length,
      pageCount: 1,
      rawText: String(currentFile.rawText || ''),
      fullText: String(currentFile.rawText || ''),
      lines: [],
      hierarchicalBlocks: [],
      bankName,
      detectedBank: bankName,
      accountNumber: accNum,
      cuentaIdentificada: accNum,
      accountName: accName,
      accountType: currentFile.accountType || currentFile.detectedAccountType || 'card',
      detectedAccountType:
        currentFile.detectedAccountType || currentFile.accountType || 'card',
      detectedAccountTypeLabel: accName,
      currency: fallbackCurrency,
      moneda: fallbackCurrency,
      tipoDocumento: 'Estado de Cuenta (Múltiples Movimientos)',
      documentType: 'Estado de Cuenta (Múltiples Movimientos)',
      statementDocumentType:
        currentFile.statementDocumentType || 'Estado de Cuenta (Tarjeta de Crédito)',
      accountInfo: {
        ...(currentFile.accountInfo || {}),
        bankName,
        accountName: accName,
        accountNumber: accNum,
        currency: fallbackCurrency,
      },
      transactions: normalizedTxList,
      statementItems: normalizedTxList,
      statementTransactions: normalizedTxList,
      monto:
        firstTx?.amount ||
        Number(currentFile.monto ?? currentFile.amount ?? currentFile.accountInfo?.currentBalance ?? 0) ||
        0,
      amount:
        firstTx?.amount ||
        Number(currentFile.amount ?? currentFile.monto ?? currentFile.accountInfo?.currentBalance ?? 0) ||
        0,
      fecha: firstTx?.date || currentFile.fecha || currentFile.date || '2026-09-05',
      date: firstTx?.date || currentFile.date || currentFile.fecha || '2026-09-05',
      comercio: firstTx?.concept || currentFile.comercio || accName,
      merchant: firstTx?.concept || currentFile.merchant || accName,
      isMultiRowStatement: true,
      thumbnailDataUrl: currentFile.thumbnailDataUrl || null,
      originalDataUrl: currentFile.originalDataUrl || currentFile.thumbnailDataUrl || null,
      extractionSource: 'pdf-native-vector',
    };
  }

  // 1. Extraer capa de texto nativa iterando sobre todas las páginas del PDF con pdfjs-dist
  const pdfLayer = await extractNativePdfTextLayer(currentFile, {
    ...options,
    maxPages: options.maxPages || 25,
  });

  // Concatenar líneas manteniendo el orden de bloques
  const orderedBlockLines =
    Array.isArray(pdfLayer.hierarchicalBlocks) && pdfLayer.hierarchicalBlocks.length > 0
      ? pdfLayer.hierarchicalBlocks.flatMap((block) => block.lines || [])
      : [];
  const rawPageText = String(pdfLayer.fullText || '').trim();
  const blockConcatenatedText = orderedBlockLines.join('\n').trim();
  const fullText = rawPageText || blockConcatenatedText;
  const extractedCharCount = fullText.length;

  // Si el texto extraído tiene más de 50 caracteres (PDF vectorial nativo), omitir Tesseract.js
  const isVectorPdf = extractedCharCount > VECTOR_PDF_MIN_CHARS;
  const skipTesseractOcr = isVectorPdf;
  let usedTesseractOcr = false;

  let textToParse = fullText;
  if (!isVectorPdf && typeof options.ocrFallbackRunner === 'function') {
    const ocrFallbackText = await options.ocrFallbackRunner(currentFile, options);
    if (typeof ocrFallbackText === 'string' && ocrFallbackText.trim()) {
      textToParse = ocrFallbackText.trim();
      usedTesseractOcr = true;
    }
  }

  // 2. Aplicar directamente el Parser Específico de Estados de Cuenta y Tarjetas
  const parsedStatement = parseBankStatementTextData(textToParse, options);
  const firstTx = parsedStatement.transactions[0] || null;
  const totalTxAmount = parsedStatement.transactions.reduce(
    (acc, tx) => acc + (Number(tx.amount) || 0),
    0
  );
  const primaryAmount =
    totalTxAmount > 0
      ? Number(totalTxAmount.toFixed(2))
      : parsedStatement.accountInfo.currentBalance || 0;
  const primaryDate =
    firstTx?.date || parsedStatement.accountInfo.cutoffDate || '2026-09-05';
  const primaryConcept =
    firstTx?.concept ||
    parsedStatement.accountName ||
    parsedStatement.bankName ||
    'Estado de Cuenta';

  return {
    isVectorPdf,
    skipTesseractOcr,
    usedTesseractOcr,
    extractedCharCount,
    pageCount: pdfLayer.pageCount || 1,
    rawText: textToParse,
    fullText: textToParse,
    lines: pdfLayer.lines || [],
    hierarchicalBlocks: pdfLayer.hierarchicalBlocks || [],
    bankName: parsedStatement.bankName,
    detectedBank: parsedStatement.bankName,
    accountNumber: parsedStatement.accountNumber,
    cuentaIdentificada: parsedStatement.accountNumber,
    accountName: parsedStatement.accountName,
    accountType: parsedStatement.accountType,
    detectedAccountType: parsedStatement.accountType,
    detectedAccountTypeLabel: parsedStatement.accountName,
    currency: parsedStatement.currency,
    moneda: parsedStatement.currency,
    tipoDocumento: 'Estado de Cuenta (Múltiples Movimientos)',
    documentType: 'Estado de Cuenta (Múltiples Movimientos)',
    statementDocumentType:
      parsedStatement.accountType === 'card'
        ? 'Estado de Cuenta (Tarjeta de Crédito)'
        : 'Estado de Cuenta (Múltiples Movimientos)',
    accountInfo: parsedStatement.accountInfo,
    creditLimit: parsedStatement.accountInfo.creditLimit,
    minimumPayment: parsedStatement.accountInfo.minimumPayment,
    cutoffDate: parsedStatement.accountInfo.cutoffDate,
    paymentDueDate: parsedStatement.accountInfo.paymentDueDate,
    owner: parsedStatement.accountInfo.owner,
    transactions: parsedStatement.transactions,
    statementItems: parsedStatement.transactions,
    statementTransactions: parsedStatement.transactions,
    monto: primaryAmount,
    amount: primaryAmount,
    fecha: primaryDate,
    date: primaryDate,
    comercio: primaryConcept,
    merchant: primaryConcept,
    isMultiRowStatement: true,
    thumbnailDataUrl: pdfLayer.thumbnailDataUrl || null,
    originalDataUrl: pdfLayer.thumbnailDataUrl || null,
    renderedOnCanvas: Boolean(pdfLayer.renderedOnCanvas),
    extractionSource: isVectorPdf ? 'pdf-native-vector' : 'ocr-fallback',
  };
}
