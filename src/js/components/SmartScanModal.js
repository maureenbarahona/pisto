import {
  Money,
  DEFAULT_CATEGORIES,
  TRANSACTION_TYPES,
  extractLast4Digits,
  createTransaction,
  createAccount,
} from '../../../public/js/domain/models.js';
import { filterActiveAccounts } from '../../../public/js/services/accounts.js';
import {
  SMART_SCAN_DOCUMENT_TYPES,
  LOCAL_OCR_LOADING_STATUS,
  GEMINI_FALLBACK_LOADING_STATUS,
  sanitizeSmartScanAmount,
  normalizeSmartScanDate,
  getTransactionTypeForDocument,
  detectBankAndAccountMetadata,
  inferSmartScanCategory,
  matchAccountFromWorkspace,
  detectSmartScanDuplicate,
  encodeSmartScanFileToBase64,
  renderPdfFirstPageThumbnail,
  extractSmartScanDocument,
  extractStatementTransactionsFromText,
  learnStatementFormatTemplate,
} from '../services/smartScanExtractor.js';
import {
  VECTOR_PDF_MIN_CHARS,
  extractPdfData,
} from '../services/pdfExtractor.js';
import {
  parseBankStatementTextData,
  parseStatementHeaderAccountData,
  parseStatementTransactions,
  detectActiveStatementCurrency,
  normalizeBankStatementDate,
} from '../services/bankParsers.js';
import {
  SMART_SCAN_FILE_INPUT_ID,
  extractFileFromInputOrDropEvent,
} from './TransactionsView.js';
import {
  identifyDocumentTemplate,
  parseDocumentWithTemplate,
  matchAndParseDocumentWithTemplate,
  recordDocumentTemplateFeedback,
} from '../services/patternLearner.js';

export {
  VECTOR_PDF_MIN_CHARS,
  extractPdfData,
  parseBankStatementTextData,
  parseStatementHeaderAccountData,
  parseStatementTransactions,
  detectActiveStatementCurrency,
  normalizeBankStatementDate,
};

export const SMART_SCAN_MODAL_ID = 'smart-scan-dialog';
export const SMART_SCAN_MODAL_FILE_INPUT_ID = 'smart-scan-modal-file-input';
export const DOCUMENT_TYPE_SELECT_ID = 'document-type';
export const ASSOCIATED_ACCOUNT_SELECT_ID = 'associated-account';
export const SMART_SCAN_THUMBNAIL_CONTAINER_ID = 'smart-scan-thumbnail-container';
export const SMART_SCAN_PREVIEW_CANVAS_ID = 'smart-scan-preview-canvas';
export const SMART_SCAN_PREVIEW_IMG_ID = 'smart-scan-preview-img';
export const STATEMENT_FOOTER_SUMMARY_ID = 'smart-scan-statement-footer-summary';
export const SMART_SCAN_PROCESS_BUTTON_ID = 'btn-process-file';
export const SMART_SCAN_PROCESS_BUTTON_LABEL = '⚡ Procesar y Evaluar Documento';
export const SMART_SCAN_ANALYZING_PDF_LABEL = '⏳ Analizando PDF...';
export const SMART_SCAN_TOAST_OVERLAY_ID = 'smart-scan-toast-overlay';

export const DUPLICATE_RESOLUTION_ACTIONS = Object.freeze({
  OVERWRITE: 'overwrite',
  CREATE_NEW: 'create_new',
  SKIP: 'skip',
});

/**
 * 3a) Abstrae la información del encabezado del documento (Datos de Cuenta):
 * - Extrae Nombre del Banco (`bankName`), Número de Cuenta/Tarjeta (`accountNumber` / `cuentaIdentificada`),
 *   Moneda (`HNL` / `USD`) y Tipo de Cuenta (`accountType`, `accountTypeLabel`).
 * - Evalúa automáticamente la coincidencia contra las cuentas activas del workspace para poblar
 *   "Cuenta / Últimos 4 Dígitos" y "Cuenta Asociada".
 *
 * @param {object} [extracted={}]
 * @param {object} [state={}]
 * @returns {{
 *   bankName: string,
 *   accountNumber: string,
 *   cuentaIdentificada: string,
 *   last4Digits: string,
 *   currency: 'HNL'|'USD',
 *   moneda: 'HNL'|'USD',
 *   accountType: 'card'|'bank',
 *   accountTypeLabel: string,
 *   activeAccounts: Array<object>,
 *   matchedAccountId: string,
 *   matchedAccount: object|null,
 *   accountMatch: object
 * }}
 */
export function abstractDocumentHeaderAccountData(extracted = {}, state = {}) {
  const accountInfo = extracted?.accountInfo || {};
  const rawText = String(extracted?.rawText || '').trim();
  const parsedHeaderFromText = rawText ? parseStatementHeaderAccountData(rawText) : null;
  const metadata = detectBankAndAccountMetadata(
    rawText ||
      `${extracted?.bankName || ''} ${extracted?.detectedBank || ''} ${accountInfo?.bankName || ''} ${accountInfo?.accountName || ''}`
  );

  const bankName = String(
    (parsedHeaderFromText?.bankName && parsedHeaderFromText.bankName !== 'Banco Local'
      ? parsedHeaderFromText.bankName
      : '') ||
      extracted?.bankName ||
      extracted?.detectedBank ||
      accountInfo?.bankName ||
      metadata.bankName ||
      'Banco Local'
  ).trim();

  const accountNumber = String(
    parsedHeaderFromText?.accountNumber ||
      extracted?.cuentaIdentificada ||
      extracted?.accountNumber ||
      accountInfo?.accountNumber ||
      metadata.accountNumber ||
      ''
  ).trim();

  const last4Digits = extractLast4Digits(accountNumber) || accountNumber;

  const currency = parsedHeaderFromText?.currency
    ? parsedHeaderFromText.currency
    : extracted?.moneda === 'USD' ||
        extracted?.currency === 'USD' ||
        accountInfo?.currency === 'USD'
      ? 'USD'
      : 'HNL';

  const creditLimit = sanitizeSmartScanAmount(
    extracted?.creditLimit ?? accountInfo?.creditLimit ?? parsedHeaderFromText?.creditLimit ?? 0
  );
  const isCreditCard =
    creditLimit > 0 ||
    parsedHeaderFromText?.accountType === 'card' ||
    extracted?.detectedAccountType === 'card' ||
    accountInfo?.accountType === 'card' ||
    /Tarjeta|PLATINUM|VISA|MASTERCARD|AMEX/i.test(
      `${extracted?.statementDocumentType || ''} ${accountInfo?.accountName || ''} ${parsedHeaderFromText?.accountName || ''} ${extracted?.detectedAccountTypeLabel || ''}`
    ) ||
    metadata.accountType === 'card';

  const accountType = isCreditCard ? 'card' : 'bank';
  const accountTypeLabel = String(
    accountInfo?.accountName ||
      parsedHeaderFromText?.accountName ||
      extracted?.detectedAccountTypeLabel ||
      accountInfo?.accountTypeLabel ||
      metadata.accountTypeLabel ||
      (isCreditCard ? 'Tarjeta de Crédito' : 'Cuenta de Ahorro')
  ).trim();

  const activeAccounts =
    extracted?.accountMatch?.activeAccounts ||
    filterActiveAccounts(state?.accounts || []).filter(
      (a) => a && !a.archived && !a.isArchived
    );

  let effectiveAccountMatch = extracted?.accountMatch || null;
  if (!effectiveAccountMatch && accountNumber) {
    const targetLast4 = extractLast4Digits(accountNumber);
    const matchedAcc = activeAccounts.find((acc) => {
      const accDigits = String(acc.accountNumber || '').replace(/\D/g, '');
      const rawDigits = accountNumber.replace(/\D/g, '');
      if (accDigits && rawDigits && (accDigits === rawDigits || accDigits.endsWith(rawDigits))) {
        return true;
      }
      const accLast4 = extractLast4Digits(acc.accountNumber || '');
      return Boolean(targetLast4 && accLast4 && accLast4 === targetLast4);
    });
    effectiveAccountMatch = {
      matched: Boolean(matchedAcc),
      accountId: matchedAcc?.id || '',
      matchedAccount: matchedAcc || null,
      activeAccounts,
      matchedDigits: targetLast4 || accountNumber,
    };
  } else if (!effectiveAccountMatch) {
    effectiveAccountMatch = {
      matched: false,
      accountId: '',
      matchedAccount: null,
      activeAccounts,
      matchedDigits: '',
    };
  }

  const matchedAccountId = effectiveAccountMatch?.matched
    ? effectiveAccountMatch.accountId
    : String(extracted?.accountId || '').trim();

  return {
    bankName,
    accountNumber,
    cuentaIdentificada: accountNumber,
    last4Digits,
    currency,
    moneda: currency,
    accountType,
    accountTypeLabel,
    activeAccounts,
    matchedAccountId,
    matchedAccount: effectiveAccountMatch?.matchedAccount || null,
    accountMatch: effectiveAccountMatch,
  };
}

/**
 * 3b) Abstrae el detalle del cuerpo del documento (Lista de Transacciones):
 * - Extrae fechas, conceptos/comercios, montos y tipos (Ingreso/Gasto).
 * - Genera filas normalizadas listas para poblar dinámicamente la tabla
 *   "Movimientos Extraídos del Estado de Cuenta".
 *
 * @param {object} [extracted={}]
 * @param {object} [headerData={}]
 * @returns {Array<{
 *   id: string,
 *   selected: boolean,
 *   fecha: string,
 *   date: string,
 *   comercio: string,
 *   concept: string,
 *   monto: number,
 *   amount: number,
 *   moneda: 'HNL'|'USD',
 *   currency: 'HNL'|'USD',
 *   tipo: 'income'|'expense',
 *   type: 'income'|'expense',
 *   categoryId: string,
 *   categoriaSugerida: string
 * }>}
 */
export function abstractDocumentBodyTransactions(extracted = {}, headerData = {}) {
  const defaultCurrency =
    headerData?.currency ||
    headerData?.moneda ||
    (extracted?.moneda === 'USD' || extracted?.currency === 'USD' ? 'USD' : 'HNL');
  const fallbackDate = normalizeSmartScanDate(
    extracted?.fecha ||
      extracted?.date ||
      extracted?.accountInfo?.cutoffDate ||
      new Date().toISOString().slice(0, 10)
  );

  let rawRows = Array.isArray(extracted?.statementItems)
    ? extracted.statementItems
    : Array.isArray(extracted?.statementTransactions)
      ? extracted.statementTransactions
      : Array.isArray(extracted?.transactions)
        ? extracted.transactions
        : [];

  if (extracted?.rawText) {
    const parsedFromBankParser = parseStatementTransactions(
      String(extracted.rawText),
      defaultCurrency
    );
    const parsedFromText =
      parsedFromBankParser.length > 0
        ? parsedFromBankParser
        : extractStatementTransactionsFromText(String(extracted.rawText), defaultCurrency);

    const hasOnlyPlaceholderDefaultRow =
      rawRows.length === 1 &&
      (!rawRows[0]?.comercio && !rawRows[0]?.concept
        ? true
        : String(rawRows[0]?.comercio || rawRows[0]?.concept || '')
            .trim()
            .toUpperCase() ===
          String(
            headerData?.accountTypeLabel ||
              extracted?.accountInfo?.accountName ||
              extracted?.accountName ||
              ''
          )
            .trim()
            .toUpperCase());

    if ((rawRows.length === 0 || hasOnlyPlaceholderDefaultRow) && parsedFromText.length > 0) {
      rawRows = parsedFromText;
    }
  }

  return rawRows.map((row, idx) => {
    const fecha = normalizeSmartScanDate(row.fecha || row.date || fallbackDate);
    const comercio = String(
      row.comercio || row.merchant || row.concept || row.description || 'Movimiento'
    ).trim();
    const monto = sanitizeSmartScanAmount(row.monto ?? row.amount ?? 0);
    const moneda =
      row.moneda === 'USD' || row.currency === 'USD' ? 'USD' : defaultCurrency;
    const isIncome =
      row.tipo === TRANSACTION_TYPES.INCOME ||
      row.type === TRANSACTION_TYPES.INCOME ||
      /cr[eé]dito|abono|dep[oó]sito|pago\s+gracias|su\s+pago/i.test(
        `${row.tipo || ''} ${row.type || ''} ${comercio}`
      );
    const tipo = isIncome ? TRANSACTION_TYPES.INCOME : TRANSACTION_TYPES.EXPENSE;

    return {
      id: row.id || `stmt_tx_${idx + 1}`,
      selected: row.selected !== false,
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
      categoryId:
        row.categoryId || (tipo === TRANSACTION_TYPES.INCOME ? 'salary' : 'groceries'),
      categoriaSugerida:
        row.categoriaSugerida ||
        (tipo === TRANSACTION_TYPES.INCOME ? 'Ingresos' : 'Supermercado'),
    };
  });
}

/**
 * Genera el aviso explícito cuando la cuenta identificada no se encuentra en el espacio financiero.
 * @param {string} accountNumber
 * @returns {string}
 */
export function formatMissingAccountWorkspaceNotice(accountNumber = '') {
  const num = String(accountNumber || '').trim() || 'S/N';
  return `⚠️ La cuenta N.º ${num} no se encuentra en tu espacio financiero.`;
}

/**
 * Genera el texto del botón explícito para crear la cuenta y asociar movimientos.
 * @param {string} accountNumber
 * @returns {string}
 */
export function formatCreateAndAssociateAccountButtonLabel(accountNumber = '') {
  const num = String(accountNumber || '').trim() || 'S/N';
  return `✨ Crear Cuenta N.º ${num} y Asociar Movimientos`;
}

/**
 * Genera la alerta concisa cuando la cuenta detectada no existe en el workspace de Firestore.
 * - Si se especifica `bankName`, muestra:
 *   `⚠️ La cuenta N.º 310074459 (Banco Promerica) no existe. ¿Deseas crearla automáticamente?`
 * - Si no se especifica `bankName`, muestra:
 *   `⚠️ La cuenta N.º {accountNumber} no existe. Se creará automáticamente`
 *
 * @param {string} accountNumber
 * @param {string} [bankName='']
 * @returns {string}
 */
export function formatMissingAccountAlertText(accountNumber = '', bankName = '') {
  const num = String(accountNumber || '').trim() || 'S/N';
  const cleanBank = String(bankName || '').trim();
  if (cleanBank) {
    return `⚠️ La cuenta N.º ${num} (${cleanBank}) no existe. ¿Deseas crearla automáticamente?`;
  }
  return `⚠️ La cuenta N.º ${num} no existe. Se creará automáticamente`;
}

/**
 * Genera la alerta de confirmación para crear automáticamente una cuenta bancaria o de crédito faltante:
 * `"⚠️ La cuenta N.º 310074459 (Banco Promerica) no existe. ¿Deseas crearla automáticamente?"`
 *
 * @param {string} accountNumber
 * @param {string} [bankName='']
 * @returns {string}
 */
export function formatMissingBankAccountPrompt(accountNumber = '', bankName = '') {
  const num = String(accountNumber || '').trim() || 'S/N';
  const cleanBank = String(bankName || '').trim();
  if (cleanBank) {
    return `⚠️ La cuenta N.º ${num} (${cleanBank}) no existe. ¿Deseas crearla automáticamente?`;
  }
  return `⚠️ La cuenta N.º ${num} no existe. ¿Deseas crearla automáticamente?`;
}

/**
 * Genera el aviso nítido en primer plano cuando la cuenta extraída del PDF no está registrada en Firestore `accounts`:
 * `"⚠️ La cuenta N.º 310074459 (Banco Promerica) no está registrada. Se creará automáticamente al guardar."`
 *
 * @param {string} accountNumber
 * @param {string} [bankName='']
 * @returns {string}
 */
export function formatUnregisteredAccountNotice(accountNumber = '', bankName = '') {
  const num = String(accountNumber || '').trim() || 'S/N';
  const cleanBank = String(bankName || '').trim();
  if (cleanBank && cleanBank !== 'Banco Local') {
    return `⚠️ La cuenta N.º ${num} (${cleanBank}) no está registrada. Se creará automáticamente al guardar.`;
  }
  return `⚠️ La cuenta N.º ${num} no está registrada. Se creará automáticamente al guardar.`;
}

/**
 * Genera el mensaje de aviso cuando la cuenta identificada en el documento no existe en el workspace.
 * @param {string} accountNumber
 * @param {{ short?: boolean, workspaceNotice?: boolean, unregistered?: boolean, bankName?: string }} [options]
 * @returns {string}
 */
export function formatMissingAccountBannerMessage(accountNumber = '', options = {}) {
  const num = String(accountNumber || '').trim() || 'S/N';
  const bankName = String(options?.bankName || '').trim();
  if (options?.unregistered === true) {
    return formatUnregisteredAccountNotice(num, bankName);
  }
  if (options?.short === true) {
    return formatMissingAccountAlertText(num, bankName);
  }
  if (options?.workspaceNotice === true) {
    return formatMissingAccountWorkspaceNotice(num);
  }
  if (bankName) {
    return formatMissingBankAccountPrompt(num, bankName);
  }
  return `⚠️ La cuenta N.º ${num} no existe en tu espacio. Se creará automáticamente con la información del documento.`;
}

/**
 * Formatea un monto numérico con comas de miles y 2 decimales (ej. 3901.33 -> "3,901.33").
 * @param {number} amount
 * @returns {string}
 */
function formatNumberWithCommas(amount = 0) {
  const clean = Money.fromCents(Money.toCents(amount));
  const [intPart, decPart = '00'] = Math.abs(clean).toFixed(2).split('.');
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${clean < 0 ? '-' : ''}${withCommas}.${decPart}`;
}

/**
 * Genera el resumen dinámico en el pie del modal para Estados de Cuenta:
 * "Total Seleccionado: L X,XXX.XX | N.º de Movimientos: X"
 *
 * @param {Array<object>} [rows=[]]
 * @param {'HNL'|'USD'} [currency='HNL']
 * @returns {string}
 */
export function formatStatementFooterSummary(rows = [], currency = 'HNL') {
  const validRows = Array.isArray(rows)
    ? rows.filter((r) => r && r.selected !== false)
    : [];
  let totalAmount = 0;
  for (const row of validRows) {
    const rowAmt = sanitizeSmartScanAmount(row.monto ?? row.amount ?? 0);
    if (rowAmt > 0) {
      totalAmount = Money.add(totalAmount, rowAmt);
    }
  }
  const symbol = currency === 'USD' ? '$' : 'L';
  return `Total Seleccionado: ${symbol} ${formatNumberWithCommas(totalAmount)} | N.º de Movimientos: ${validRows.length}`;
}

/**
 * Renderiza la miniatura de una imagen (PNG, JPG, WEBP) o la primera página de un archivo `.pdf`
 * (usando `pdfjs-dist` sobre `<canvas>`) dentro del contenedor de vista previa compartido.
 *
 * @param {File|Blob|string|object} fileOrInput
 * @param {Document} [doc]
 * @param {object} [options]
 * @returns {Promise<{ thumbnailDataUrl: string, isPdf: boolean, isImage: boolean, renderedOnCanvas: boolean }>}
 */
export async function renderDocumentPreviewThumbnail(
  fileOrInput,
  doc = typeof document !== 'undefined' ? document : null,
  options = {}
) {
  const containerEl =
    options.containerEl || doc?.getElementById?.(SMART_SCAN_THUMBNAIL_CONTAINER_ID) || null;
  const canvasEl =
    options.canvas || doc?.getElementById?.(SMART_SCAN_PREVIEW_CANVAS_ID) || null;
  const imgEl =
    options.imgEl || doc?.getElementById?.(SMART_SCAN_PREVIEW_IMG_ID) || null;

  const fileName = String(fileOrInput?.name || '').toLowerCase();
  const mimeType = String(fileOrInput?.type || '').toLowerCase();
  const isPdf =
    mimeType === 'application/pdf' ||
    fileName.endsWith('.pdf') ||
    (typeof fileOrInput === 'string' && fileOrInput.trim().startsWith('data:application/pdf'));

  if (isPdf) {
    const pdfPreview = await renderPdfFirstPageThumbnail(fileOrInput, {
      ...options,
      doc,
      canvas: canvasEl,
    });
    const thumbnailDataUrl = pdfPreview.thumbnailDataUrl || '';
    if (containerEl) {
      containerEl.dataset.previewType = 'pdf';
    }
    if (imgEl && thumbnailDataUrl) {
      imgEl.src = thumbnailDataUrl;
      imgEl.classList?.remove?.('is-hidden');
    }
    if (canvasEl) {
      canvasEl.classList?.add?.('is-hidden');
    }
    return {
      thumbnailDataUrl,
      isPdf: true,
      isImage: false,
      renderedOnCanvas: Boolean(pdfPreview.renderedOnCanvas),
    };
  }

  const encoded = await encodeSmartScanFileToBase64(fileOrInput);
  const thumbnailDataUrl = encoded.dataUrl || '';
  if (containerEl) {
    containerEl.dataset.previewType = 'image';
  }
  if (imgEl && thumbnailDataUrl) {
    imgEl.src = thumbnailDataUrl;
    imgEl.classList?.remove?.('is-hidden');
  }
  if (canvasEl) {
    canvasEl.classList?.add?.('is-hidden');
  }
  return {
    thumbnailDataUrl,
    isPdf: false,
    isImage: true,
    renderedOnCanvas: false,
  };
}

/**
 * Genera el texto dinámico del botón de guardado según el modo del modal.
 * - Comprobante individual: "Guardar Movimiento"
 * - Estado de Cuenta: "Guardar X Movimientos Seleccionados"
 *
 * @param {boolean} isStatementMode
 * @param {number} [selectedCount=0]
 * @returns {string}
 */
export function formatSmartScanSubmitButtonLabel(isStatementMode, selectedCount = 0) {
  if (!isStatementMode) {
    return 'Guardar Movimiento';
  }
  const count = Math.max(0, Number.parseInt(String(selectedCount), 10) || 0);
  return `Guardar ${count} Movimientos Seleccionados`;
}

/**
 * Renderiza las filas HTML `<tr>` de la tabla visual interactiva para Estados de Cuenta.
 * Columnas: Checkbox [x] | Fecha | Concepto/Comercio | Monto | Tipo (Ingreso/Gasto) | Acción (🗑️ Eliminar)
 *
 * @param {Array<object>} rows
 * @returns {string}
 */
export function renderStatementTransactionsRowsMarkup(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return `
      <tr class="smart-scan-empty-row">
        <td colspan="6" style="text-align: center; padding: 1.25rem; color: var(--text-secondary);">
          No hay movimientos en la lista. Puedes cambiar el tipo de documento o agregar movimientos.
        </td>
      </tr>
    `.trim();
  }

  return rows
    .map((row, idx) => {
      const isChecked = row.selected !== false ? 'checked' : '';
      const fecha = String(row.fecha || row.date || new Date().toISOString().slice(0, 10)).slice(
        0,
        10
      );
      const comercio = String(row.comercio || row.concept || '')
        .replace(/"/g, '&quot;');
      const monto = sanitizeSmartScanAmount(row.monto ?? row.amount ?? 0);
      const tipo =
        row.tipo === TRANSACTION_TYPES.INCOME || row.type === TRANSACTION_TYPES.INCOME
          ? TRANSACTION_TYPES.INCOME
          : TRANSACTION_TYPES.EXPENSE;

      return `
        <tr data-scan-row-index="${idx}">
          <td style="text-align: center;">
            <input
              type="checkbox"
              data-scan-row-check="${idx}"
              ${isChecked}
              aria-label="Seleccionar movimiento ${idx + 1}"
            />
          </td>
          <td>
            <input
              type="date"
              class="text-input"
              data-scan-row-field="fecha"
              data-scan-row-index="${idx}"
              value="${fecha}"
              aria-label="Fecha del movimiento ${idx + 1}"
            />
          </td>
          <td>
            <input
              type="text"
              class="text-input"
              data-scan-row-field="comercio"
              data-scan-row-index="${idx}"
              value="${comercio}"
              placeholder="Concepto o comercio"
              aria-label="Concepto o comercio del movimiento ${idx + 1}"
            />
          </td>
          <td>
            <input
              type="number"
              class="text-input"
              step="0.01"
              min="0.01"
              data-scan-row-field="monto"
              data-scan-row-index="${idx}"
              value="${monto}"
              aria-label="Monto del movimiento ${idx + 1}"
            />
          </td>
          <td>
            <select
              class="select-input"
              data-scan-row-field="tipo"
              data-scan-row-index="${idx}"
              aria-label="Tipo del movimiento ${idx + 1}"
            >
              <option value="expense" ${tipo === 'expense' ? 'selected' : ''}>Gasto</option>
              <option value="income" ${tipo === 'income' ? 'selected' : ''}>Ingreso</option>
            </select>
          </td>
          <td style="text-align: center;">
            <button
              type="button"
              class="btn-secondary btn-sm"
              data-scan-row-delete="${idx}"
              aria-label="Eliminar movimiento ${idx + 1}"
            >🗑️ Eliminar</button>
          </td>
        </tr>
      `.trim();
    })
    .join('\n');
}

/**
 * Construye el HTML del Modal de Confirmación Único (`#smart-scan-dialog`)
 * con soporte adaptativo para comprobantes individuales y Estados de Cuenta multi-transacción.
 *
 * @returns {string}
 */
export function renderSmartScanModalMarkup() {
  const docTypeOptions = Object.values(SMART_SCAN_DOCUMENT_TYPES)
    .map((type) => `<option value="${type}">${type}</option>`)
    .join('');

  return `
    <div
      id="${SMART_SCAN_TOAST_OVERLAY_ID}"
      class="smart-scan-toast-overlay is-hidden"
      role="status"
      aria-live="assertive"
      style="position: fixed; top: 1.25rem; left: 50%; transform: translateX(-50%); z-index: 9999; filter: none; backdrop-filter: none; opacity: 1;"
    ></div>

    <div class="modal-header">
      <div>
        <h3 id="smart-scan-dialog-title">📷 Escanear Documento / PDF</h3>
        <p id="smart-scan-subtitle" style="font-size: 0.78rem; color: var(--text-secondary); margin-top: 2px;">
          Motor unificado de clasificación OCR, conciliación de Estados de Cuenta y asociación automática a cuentas
        </p>
      </div>
      <button type="button" class="btn-icon" data-close-modal="${SMART_SCAN_MODAL_ID}" aria-label="Cerrar escáner inteligente">✕</button>
    </div>

    <div id="smart-scan-progress-box" class="voucher-progress-container is-hidden" aria-live="polite">
      <div style="display: flex; justify-content: space-between; font-size: 0.82rem;">
        <span id="smart-scan-progress-status">${LOCAL_OCR_LOADING_STATUS}</span>
        <strong id="smart-scan-progress-pct">0%</strong>
      </div>
      <progress id="smart-scan-progress-bar" value="0" max="100"></progress>
    </div>

    <form id="smart-scan-confirm-form">
      <div class="voucher-scanner-layout">
        <div class="voucher-preview-pane" id="smart-scan-dropzone">
          <input
            type="file"
            id="${SMART_SCAN_MODAL_FILE_INPUT_ID}"
            accept="image/png,image/jpeg,image/webp,image/*,application/pdf,.pdf"
            class="sr-only"
          />
          <div id="${SMART_SCAN_THUMBNAIL_CONTAINER_ID}" class="smart-scan-thumbnail-container" data-preview-type="image">
            <canvas
              id="${SMART_SCAN_PREVIEW_CANVAS_ID}"
              class="smart-scan-preview-canvas is-hidden"
              aria-label="Miniatura de primera página PDF"
            ></canvas>
            <img
              id="${SMART_SCAN_PREVIEW_IMG_ID}"
              class="smart-scan-preview-img"
              alt="Vista previa del documento escaneado"
              src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="
              style="cursor: pointer;"
              title="Haz clic o arrastra un documento (PNG, JPG, WEBP, PDF)"
            />
          </div>
          <button
            type="button"
            id="btn-smart-scan-pick-file"
            class="btn-secondary btn-sm"
            data-action="pick-smart-scan-file"
            style="margin-top: 0.5rem; width: 100%;"
          >📂 Seleccionar o arrastrar imagen / PDF</button>
          <button
            type="button"
            id="${SMART_SCAN_PROCESS_BUTTON_ID}"
            class="btn-primary btn-sm"
            data-action="process-smart-scan-file"
            style="margin-top: 0.5rem; width: 100%;"
          >${SMART_SCAN_PROCESS_BUTTON_LABEL}</button>
        </div>

        <div class="voucher-fields-pane">
          <div id="smart-scan-tax-summary" class="voucher-tax-summary is-hidden"></div>

          <!-- Banner de creación dinámica cuando la cuenta identificada no existe en Firestore -->
          <div
            id="smart-scan-missing-account-banner"
            class="is-hidden"
            role="alert"
            style="padding: 0.85rem 1rem; border-radius: var(--radius-md); background: rgba(245, 158, 11, 0.14); border: 1px solid rgba(245, 158, 11, 0.45); margin-bottom: 0.85rem; position: relative; z-index: 9999; filter: none; backdrop-filter: none; opacity: 1;"
          >
            <strong id="smart-scan-unregistered-account-notice" style="display: block; font-size: 0.86rem; color: #fbbf24; margin-bottom: 0.25rem;">
              ⚠️ La cuenta N.º S/N no está registrada. Se creará automáticamente al guardar.
            </strong>
            <strong id="smart-scan-missing-account-workspace-notice" style="display: block; font-size: 0.82rem; color: #fbbf24; margin-bottom: 0.2rem;">
              ⚠️ La cuenta N.º S/N no se encuentra en tu espacio financiero.
            </strong>
            <span id="smart-scan-missing-account-alert" style="display: block; font-size: 0.78rem; color: #fcd34d; margin-bottom: 0.2rem;">
              ⚠️ La cuenta N.º S/N no existe. Se creará automáticamente
            </span>
            <p id="smart-scan-missing-account-message" style="font-size: 0.78rem; color: var(--text-secondary); margin: 0 0 0.65rem 0;">
              ⚠️ La cuenta N.º S/N no existe en tu espacio. Se creará automáticamente con la información del documento.
            </p>
            <div style="display: flex; flex-wrap: wrap; gap: 0.55rem;">
              <button
                type="button"
                id="btn-accept-create-account"
                class="btn-primary btn-sm"
                data-action="accept-create-account"
              >✨ Crear Cuenta N.º S/N y Asociar Movimientos</button>
              <button
                type="button"
                id="btn-cancel-create-account"
                class="btn-secondary btn-sm"
                data-action="cancel-create-account"
              >Cancelar</button>
            </div>
          </div>

          <div
            id="smart-scan-duplicate-warning"
            class="is-hidden"
            role="alert"
            style="padding: 0.85rem 1rem; border-radius: var(--radius-md); background: rgba(245, 158, 11, 0.14); border: 1px solid rgba(245, 158, 11, 0.45); margin-bottom: 0.85rem;"
          >
            <strong style="display: block; color: #fbbf24; font-size: 0.86rem; margin-bottom: 0.3rem;">
              ⚠️ Posible Movimiento Duplicado Detectado
            </strong>
            <p id="smart-scan-duplicate-detail" style="font-size: 0.78rem; color: var(--text-secondary); margin: 0 0 0.6rem 0;">
              Ya existe un movimiento con la misma fecha, monto y concepto en la cuenta seleccionada.
            </p>
            <div style="display: flex; flex-wrap: wrap; gap: 0.65rem;" role="radiogroup" aria-label="Acción ante movimiento duplicado">
              <label style="display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.8rem; cursor: pointer;">
                <input type="radio" name="duplicateResolution" value="overwrite" />
                <span>Sobreescribir</span>
              </label>
              <label style="display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.8rem; cursor: pointer;">
                <input type="radio" name="duplicateResolution" value="create_new" checked />
                <span>Crear Nueva</span>
              </label>
              <label style="display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.8rem; cursor: pointer;">
                <input type="radio" name="duplicateResolution" value="skip" />
                <span>Omitir</span>
              </label>
            </div>
          </div>

          <div class="form-row-2">
            <div class="form-group">
              <label for="${DOCUMENT_TYPE_SELECT_ID}">Tipo de Documento</label>
              <select id="${DOCUMENT_TYPE_SELECT_ID}" name="tipoDocumento" class="select-input">
                ${docTypeOptions}
              </select>
            </div>
            <div class="form-group">
              <label for="smart-scan-identified-account-input">Cuenta / Últimos 4 Dígitos</label>
              <input
                type="text"
                id="smart-scan-identified-account-input"
                name="cuentaIdentificada"
                class="text-input"
                maxlength="22"
                placeholder="Ej: 4589 o 200014589"
              />
            </div>
          </div>

          <div class="form-row-2">
            <div class="form-group">
              <label for="smart-scan-currency-select">Moneda</label>
              <select id="smart-scan-currency-select" name="moneda" class="select-input">
                <option value="HNL">Lempiras (HNL)</option>
                <option value="USD">Dólares (USD)</option>
              </select>
            </div>
            <div class="form-group">
              <label for="${ASSOCIATED_ACCOUNT_SELECT_ID}">Cuenta Asociada</label>
              <select id="${ASSOCIATED_ACCOUNT_SELECT_ID}" name="accountId" class="select-input"></select>
              <small id="smart-scan-account-match-hint" style="display: block; margin-top: 0.28rem; font-size: 0.76rem; color: var(--text-secondary);"></small>
            </div>
          </div>

          <!-- Campos exclusivos de comprobante individual (se ocultan en modo Estado de Cuenta) -->
          <div id="smart-scan-single-fields">
            <div class="form-row-2">
              <div class="form-group">
                <label for="smart-scan-date-input">Fecha del Comprobante</label>
                <input type="date" id="smart-scan-date-input" name="fecha" class="text-input" />
              </div>
              <div class="form-group">
                <label for="smart-scan-amount-input">Monto Total</label>
                <input
                  type="number"
                  id="smart-scan-amount-input"
                  name="monto"
                  class="text-input"
                  step="0.01"
                  min="0.01"
                  placeholder="0.00"
                />
              </div>
            </div>

            <div class="form-row-2">
              <div class="form-group">
                <label for="smart-scan-merchant-input">Comercio / Concepto Detectado</label>
                <input
                  type="text"
                  id="smart-scan-merchant-input"
                  name="comercio"
                  class="text-input"
                  placeholder="Ej: Supermercados La Colonia / Transferencia ACH"
                />
              </div>
              <div class="form-group">
                <label for="smart-scan-category-select">Categoría Sugerida</label>
                <select id="smart-scan-category-select" name="categoryId" class="select-input"></select>
              </div>
            </div>
          </div>

          <!-- Sección/tabla visual interactiva para "Estado de Cuenta (Múltiples Movimientos)" -->
          <div id="smart-scan-statement-section" class="is-hidden" style="margin-top: 0.75rem;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
              <strong style="font-size: 0.85rem;">📋 Movimientos Extraídos del Estado de Cuenta</strong>
              <button
                type="button"
                id="btn-smart-scan-add-row"
                class="btn-secondary btn-sm"
                data-action="add-statement-row"
              >+ Agregar Fila</button>
            </div>
            <div class="statement-table-scroll" style="max-height: 310px; overflow-y: auto; border: 1px solid var(--border-subtle, rgba(255,255,255,0.12)); border-radius: var(--radius-md);">
              <table class="statement-preview-table" style="width: 100%; border-collapse: collapse; font-size: 0.8rem;">
                <thead>
                  <tr>
                    <th style="width: 44px; text-align: center;">[x]</th>
                    <th>Fecha</th>
                    <th>Concepto/Comercio</th>
                    <th>Monto</th>
                    <th>Tipo (Ingreso/Gasto)</th>
                    <th style="text-align: center;">Acción</th>
                  </tr>
                </thead>
                <tbody id="smart-scan-statement-tbody"></tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <div class="modal-footer smart-scan-modal-footer" style="margin-top: 1rem;">
        <div
          id="${STATEMENT_FOOTER_SUMMARY_ID}"
          class="smart-scan-footer-summary is-hidden"
          aria-live="polite"
        >Total Seleccionado: L 0.00 | N.º de Movimientos: 0</div>
        <div class="smart-scan-footer-actions" style="display: flex; gap: 0.65rem; width: 100%; align-items: center;">
          <button type="button" class="btn-secondary" data-close-modal="${SMART_SCAN_MODAL_ID}">Cancelar</button>
          <button type="submit" id="btn-save-smart-scan-tx" class="btn-primary" style="flex: 1;">
            Guardar Movimiento
          </button>
        </div>
      </div>
    </form>
  `.trim();
}

/**
 * Recalcula el saldo actual de una cuenta a partir de su initialBalance y las transacciones del estado.
 * @param {object} account
 * @param {Array<object>} transactions
 * @param {string} [fallbackCurrency='HNL']
 * @returns {number}
 */
function recalculateAccountBalanceFromLedger(account, transactions = [], fallbackCurrency = 'HNL') {
  if (!account) return 0;
  const accCurrency = account.currency || fallbackCurrency || 'HNL';
  let balanceCents = Money.toCents(account.initialBalance ?? 0);

  for (const tx of transactions) {
    if (tx.accountId === account.id) {
      const amtInAcc = Money.convert(tx.amount, tx.currency || accCurrency, accCurrency);
      const txCents = Money.toCents(amtInAcc);
      if (tx.type === TRANSACTION_TYPES.INCOME) {
        balanceCents += txCents;
      } else if (
        tx.type === TRANSACTION_TYPES.EXPENSE ||
        tx.type === TRANSACTION_TYPES.TRANSFER
      ) {
        balanceCents -= txCents;
      }
    } else if (tx.type === TRANSACTION_TYPES.TRANSFER && tx.toAccountId === account.id) {
      const amtInAcc = Money.convert(tx.amount, tx.currency || accCurrency, accCurrency);
      balanceCents += Money.toCents(amtInAcc);
    }
  }

  return Money.fromCents(balanceCents);
}

/**
 * Persiste un Estado de Cuenta con múltiples movimientos en Firestore usando `writeBatch`:
 * - Si la cuenta no existe y `createMissingAccount === true`, crea primero la cuenta en `accounts`
 *   (con el banco, tipo y moneda detectados) y luego asocia e inserta todos los movimientos seleccionados
 *   en `transactions` dentro del mismo `writeBatch`.
 * - Ejecuta el aprendizaje adaptativo guardando la estructura visual/palabras clave en `bank_templates`
 *   (IndexedDB local y Firestore).
 *
 * @param {object} params
 * @param {object} params.extractedData
 * @param {Array<object>} params.statementRows
 * @param {object} params.state
 * @param {boolean} [params.createMissingAccount=false]
 * @param {object} [params.firestoreDb=null]
 * @param {object} [params.firestoreModule=null]
 * @param {string} [params.workspaceId='']
 * @param {Function} [params.recordTransactionFn=null]
 * @param {Storage} [params.storage=globalThis.localStorage]
 * @param {IDBFactory} [params.indexedDb]
 * @returns {Promise<{
 *   saved: boolean,
 *   createdAccount: object|null,
 *   accountId: string,
 *   savedTransactions: Array<object>,
 *   newAccountBalance: number,
 *   learnedTemplate: object|null
 * }>}
 */
export async function confirmAndPersistStatementBatch(paramsOrPayload = {}, secondOptions = {}) {
  const merged =
    secondOptions && Object.keys(secondOptions).length > 0
      ? {
          ...paramsOrPayload,
          ...secondOptions,
          extractedData: paramsOrPayload.extractedData || paramsOrPayload,
          statementRows:
            paramsOrPayload.statementRows ||
            paramsOrPayload.rows ||
            paramsOrPayload.statementTransactions ||
            null,
        }
      : paramsOrPayload;

  const {
    extractedData = merged,
    statementRows = null,
    statementTransactions = null,
    rows = null,
    accountMetadata = null,
    selectedAccountId = '',
    rawText = '',
    state = {},
    createMissingAccount = false,
    firestoreDb = null,
    firestoreModule = null,
    workspaceId = '',
    recordTransactionFn = null,
    storage = typeof localStorage !== 'undefined' ? localStorage : null,
    indexedDb = typeof globalThis !== 'undefined' ? globalThis.indexedDB : undefined,
  } = merged;

  if (!Array.isArray(state.accounts)) state.accounts = [];
  if (!Array.isArray(state.transactions)) state.transactions = [];

  const rowsInput = Array.isArray(statementRows)
    ? statementRows
    : Array.isArray(statementTransactions)
      ? statementTransactions
      : Array.isArray(rows)
        ? rows
        : [];
  const selectedRows = rowsInput.filter(
    (r) => r && r.selected !== false && sanitizeSmartScanAmount(r.monto ?? r.amount ?? 0) > 0
  );

  const effectiveRawText = String(rawText || extractedData.rawText || '').trim();
  const accountInfo = extractedData.accountInfo || merged.accountInfo || accountMetadata || {};
  const cuentaIdentificada = String(
    extractedData.cuentaIdentificada ||
      extractedData.accountNumber ||
      accountInfo?.accountNumber ||
      merged.cuentaIdentificada ||
      merged.accountNumber ||
      ''
  ).trim();
  const moneda =
    extractedData.moneda === 'USD' ||
    extractedData.currency === 'USD' ||
    accountInfo?.currency === 'USD' ||
    merged.moneda === 'USD'
      ? 'USD'
      : 'HNL';
  const metadata = detectBankAndAccountMetadata(effectiveRawText);
  const detectedBank = String(
    extractedData.detectedBank ||
      extractedData.bankName ||
      merged.bankName ||
      accountInfo?.bankName ||
      metadata.bankName ||
      'Banco Local'
  ).trim();
  const creditLimit = sanitizeSmartScanAmount(
    extractedData.creditLimit ?? accountInfo?.creditLimit ?? merged.creditLimit ?? 0
  );
  const minimumPayment = sanitizeSmartScanAmount(
    extractedData.minimumPayment ?? accountInfo?.minimumPayment ?? merged.minimumPayment ?? 0
  );
  const cutoffDate = String(
    extractedData.cutoffDate || accountInfo?.cutoffDate || merged.cutoffDate || ''
  ).trim();
  const paymentDueDate = String(
    extractedData.paymentDueDate || accountInfo?.paymentDueDate || merged.paymentDueDate || ''
  ).trim();
  const owner = String(
    extractedData.owner || accountInfo?.owner || merged.owner || ''
  ).trim();
  const isCreditCard =
    creditLimit > 0 ||
    extractedData.detectedAccountType === 'card' ||
    accountInfo?.accountType === 'card' ||
    /Tarjeta|PLATINUM|VISA|MASTERCARD|AMEX/i.test(
      `${extractedData.documentType || ''} ${accountInfo?.accountName || ''} ${extractedData.detectedAccountTypeLabel || ''}`
    ) ||
    metadata.accountType === 'card';
  const detectedAccountType = isCreditCard ? 'card' : 'bank';
  const detectedAccountTypeLabel = String(
    accountInfo?.accountName ||
      extractedData.detectedAccountTypeLabel ||
      accountInfo?.accountTypeLabel ||
      metadata.accountTypeLabel ||
      (isCreditCard ? 'Tarjeta de Crédito' : 'Cuenta de Ahorro')
  ).trim();

  let targetAccountId = String(selectedAccountId || extractedData.accountId || '').trim();
  let targetAccount = state.accounts.find((a) => a.id === targetAccountId) || null;
  let createdAccount = null;

  // Si la cuenta no existe y se solicitó creación automática (o no hay cuenta asociada en el estado)
  if ((!targetAccount && createMissingAccount) || (!targetAccount && cuentaIdentificada)) {
    const last4 = extractLast4Digits(cuentaIdentificada) || cuentaIdentificada;
    const baseAcc = createAccount({
      name: `${detectedBank} - ${detectedAccountTypeLabel}${last4 ? ` (*${last4})` : ''}`,
      type: detectedAccountType === 'card' ? 'card' : 'bank',
      currency: moneda,
      initialBalance: 0,
      institution: detectedBank,
      accountNumber: cuentaIdentificada || last4,
    });
    createdAccount = {
      ...baseAcc,
      bankName: detectedBank,
      accountName: detectedAccountTypeLabel,
      accountType: detectedAccountTypeLabel,
      accountNumber: cuentaIdentificada || last4,
      creditLimit,
      minimumPayment,
      cutoffDate,
      paymentDueDate,
      owner,
      currentBalance: 0,
      archived: false,
      isArchived: false,
    };
    state.accounts.push(createdAccount);
    targetAccount = createdAccount;
    targetAccountId = createdAccount.id;
  } else if (!targetAccount && state.accounts[0]) {
    targetAccount = state.accounts[0];
    targetAccountId = targetAccount.id;
  }

  if (targetAccount?._pendingBatchCreate) {
    delete targetAccount._pendingBatchCreate;
    createdAccount = targetAccount;
  }

  if (!targetAccountId) {
    throw new Error('Selecciona o acepta crear una Cuenta Asociada para guardar el Estado de Cuenta.');
  }

  const savedTransactions = [];
  for (const row of selectedRows) {
    const rowFecha = String(
      row.fecha || row.date || extractedData.fecha || new Date().toISOString().slice(0, 10)
    ).slice(0, 10);
    const rowComercio = String(row.comercio || row.concept || 'Movimiento Estado de Cuenta').trim();
    const rowMonto = sanitizeSmartScanAmount(row.monto ?? row.amount ?? 0);
    const rowMoneda =
      row.moneda === 'USD' || row.currency === 'USD' ? 'USD' : moneda;
    const rowTipo =
      row.tipo === TRANSACTION_TYPES.INCOME || row.type === TRANSACTION_TYPES.INCOME
        ? TRANSACTION_TYPES.INCOME
        : TRANSACTION_TYPES.EXPENSE;
    const rowCategoryId =
      row.categoryId || (rowTipo === TRANSACTION_TYPES.INCOME ? 'salary' : 'groceries');

    const baseTx =
      typeof recordTransactionFn === 'function'
        ? recordTransactionFn({
            type: rowTipo,
            amount: rowMonto,
            currency: rowMoneda,
            categoryId: rowCategoryId,
            accountId: targetAccountId,
            date: rowFecha,
            note: rowComercio,
          })
        : createTransaction({
            type: rowTipo,
            amount: rowMonto,
            currency: rowMoneda,
            categoryId: rowCategoryId,
            accountId: targetAccountId,
            date: rowFecha,
            note: rowComercio,
          });

    const txDoc = {
      ...baseTx,
      documentType: SMART_SCAN_DOCUMENT_TYPES.BANK_STATEMENT,
      cuentaIdentificada,
    };
    state.transactions.unshift(txDoc);
    savedTransactions.push(txDoc);
  }

  const newAccountBalance = recalculateAccountBalanceFromLedger(
    targetAccount,
    state.transactions,
    moneda
  );
  if (targetAccount) {
    targetAccount.currentBalance = newAccountBalance;
    targetAccount.balance = newAccountBalance;
  }

  const resolvedWorkspaceId =
    workspaceId || state?.activeWorkspaceId || state?.workspaceId || 'default_ws';

  // Persistencia atómica en Firestore mediante writeBatch
  if (firestoreDb && firestoreModule) {
    try {
      const { doc, writeBatch, setDoc, updateDoc } = firestoreModule;
      if (typeof writeBatch === 'function' && typeof doc === 'function') {
        const batch = writeBatch(firestoreDb);
        const accRef = doc(
          firestoreDb,
          'workspaces',
          String(resolvedWorkspaceId),
          'accounts',
          String(targetAccountId)
        );
        if (createdAccount) {
          batch.set(accRef, {
            ...createdAccount,
            currentBalance: newAccountBalance,
            balance: newAccountBalance,
            updatedAt: new Date().toISOString(),
          });
        } else if (targetAccount) {
          batch.set(
            accRef,
            {
              ...targetAccount,
              currentBalance: newAccountBalance,
              balance: newAccountBalance,
              updatedAt: new Date().toISOString(),
            },
            { merge: true }
          );
        }

        for (const txDoc of savedTransactions) {
          const txRef = doc(
            firestoreDb,
            'workspaces',
            String(resolvedWorkspaceId),
            'transactions',
            String(txDoc.id)
          );
          batch.set(txRef, txDoc);
        }

        await batch.commit();
      } else if (typeof doc === 'function' && typeof setDoc === 'function') {
        if (createdAccount) {
          const accRef = doc(
            firestoreDb,
            'workspaces',
            String(resolvedWorkspaceId),
            'accounts',
            String(targetAccountId)
          );
          await setDoc(accRef, createdAccount, { merge: true });
        }
        for (const txDoc of savedTransactions) {
          const txRef = doc(
            firestoreDb,
            'workspaces',
            String(resolvedWorkspaceId),
            'transactions',
            String(txDoc.id)
          );
          await setDoc(txRef, txDoc, { merge: true });
        }
        if (targetAccount && typeof updateDoc === 'function') {
          const accRef = doc(
            firestoreDb,
            'workspaces',
            String(resolvedWorkspaceId),
            'accounts',
            String(targetAccountId)
          );
          await updateDoc(accRef, {
            currentBalance: newAccountBalance,
            balance: newAccountBalance,
          });
        }
      }
    } catch {
      // Fallback Local-First silencioso
    }
  }

  if (storage && resolvedWorkspaceId) {
    try {
      storage.setItem(
        `pisto_firestore_transactions_ws_${resolvedWorkspaceId}`,
        JSON.stringify(state.transactions)
      );
      storage.setItem(
        `pisto_firestore_accounts_ws_${resolvedWorkspaceId}`,
        JSON.stringify(state.accounts)
      );
    } catch {
      // Ignorar errores de cuota
    }
  }

  // 3. Aprendizaje Adaptativo de Formatos (Pattern Learning) en bank_templates y document_templates (IndexedDB + Firestore)
  const learnedTemplate = await learnStatementFormatTemplate({
    bankName: detectedBank,
    accountNumber: cuentaIdentificada || targetAccount?.accountNumber || '',
    accountType: detectedAccountTypeLabel,
    currency: moneda,
    rawText: effectiveRawText,
    transactions: savedTransactions,
    firestoreDb,
    firestoreModule,
    indexedDb,
    storage,
  });

  const learnedDocumentTemplate = await recordDocumentTemplateFeedback(
    {
      country: extractedData.country || merged.country || state?.user?.country || state?.profile?.country,
      docType: 'bank_statement',
      institutionName: detectedBank,
      accountNumber: cuentaIdentificada || targetAccount?.accountNumber || '',
      accountName: detectedAccountTypeLabel,
      currency: moneda,
      rawText: effectiveRawText,
      transactions: savedTransactions,
    },
    {
      firestoreDb,
      firestoreModule,
      indexedDb,
      storage,
      state,
    }
  );

  return {
    saved: true,
    action: 'statement_batch',
    createdAccount,
    accountId: targetAccountId,
    savedCount: savedTransactions.length,
    savedTransactions,
    transactions: savedTransactions,
    transaction: savedTransactions[0] || null,
    updatedAccount: targetAccount,
    newAccountBalance,
    learnedTemplate,
    learnedDocumentTemplate,
  };
}

/**
 * Persiste una transacción individual confirmada y actualiza el saldo de la cuenta asociada
 * tanto en memoria como en Firestore (`workspaces/{workspaceId}/transactions` y `accounts`).
 *
 * @param {object} params
 * @returns {Promise<object>}
 */
export async function confirmAndPersistSmartScanTransaction(
  paramsOrPayload = {},
  secondOptions = {}
) {
  const merged =
    secondOptions && Object.keys(secondOptions).length > 0
      ? {
          ...paramsOrPayload,
          ...secondOptions,
          extractedData: paramsOrPayload.extractedData || paramsOrPayload,
        }
      : paramsOrPayload;

  const {
    extractedData = merged,
    state = {},
    createMissingAccount = false,
    duplicateResolution = DUPLICATE_RESOLUTION_ACTIONS.CREATE_NEW,
    duplicateTx = null,
    firestoreDb = null,
    firestoreModule = null,
    workspaceId = '',
    recordTransactionFn = null,
    storage = typeof localStorage !== 'undefined' ? localStorage : null,
  } = merged;

  if (duplicateResolution === DUPLICATE_RESOLUTION_ACTIONS.SKIP) {
    return {
      action: DUPLICATE_RESOLUTION_ACTIONS.SKIP,
      saved: false,
      createdAccount: null,
      transaction: null,
      updatedAccount: null,
      newAccountBalance: 0,
    };
  }

  if (!Array.isArray(state.transactions)) {
    state.transactions = [];
  }
  if (!Array.isArray(state.accounts)) {
    state.accounts = [];
  }

  const fecha = String(extractedData.fecha || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const comercio = String(extractedData.comercio || 'Movimiento Escaneado').trim();
  const monto = sanitizeSmartScanAmount(extractedData.monto);
  const moneda = extractedData.moneda === 'USD' ? 'USD' : 'HNL';
  const tipoDocumento =
    extractedData.tipoDocumento || SMART_SCAN_DOCUMENT_TYPES.INVOICE_RECEIPT;
  const tipoTransaccion =
    extractedData.tipoTransaccion || getTransactionTypeForDocument(tipoDocumento);
  const cuentaIdentificada = String(
    extractedData.cuentaIdentificada || extractedData.accountNumber || ''
  ).trim();

  const inferredCat = inferSmartScanCategory(
    comercio,
    `${comercio} ${extractedData.rawText || ''}`,
    tipoTransaccion,
    state?.categories || [],
    extractedData.categoriaSugerida || ''
  );
  const categoryId = String(
    extractedData.categoryId ||
      inferredCat.categoryId ||
      (tipoTransaccion === TRANSACTION_TYPES.INCOME ? 'salary' : 'groceries')
  ).trim();
  const categoriaSugerida = String(
    extractedData.categoriaSugerida || inferredCat.categoriaSugerida || 'Supermercado'
  ).trim();

  let accountId = String(extractedData.accountId || '').trim();
  let updatedAccount = state.accounts.find((acc) => acc.id === accountId) || null;
  let createdAccount = null;

  if ((!updatedAccount && createMissingAccount) || (!updatedAccount && cuentaIdentificada)) {
    const metadata = detectBankAndAccountMetadata(
      extractedData.rawText || `${extractedData.detectedBank || ''} ${comercio}`
    );
    const detectedBank = String(
      extractedData.detectedBank ||
        extractedData.bankName ||
        metadata.bankName ||
        'Banco Local'
    ).trim();
    const detectedAccountType =
      extractedData.detectedAccountType || metadata.accountType || 'bank';
    const detectedAccountTypeLabel =
      extractedData.detectedAccountTypeLabel ||
      metadata.accountTypeLabel ||
      'Cuenta de Ahorro';
    const last4 = extractLast4Digits(cuentaIdentificada) || cuentaIdentificada;

    const baseAcc = createAccount({
      name: `${detectedBank} - ${detectedAccountTypeLabel}${last4 ? ` (*${last4})` : ''}`,
      type: detectedAccountType === 'card' ? 'card' : 'bank',
      currency: moneda,
      initialBalance: 0,
      institution: detectedBank,
      accountNumber: cuentaIdentificada || last4,
    });
    createdAccount = {
      ...baseAcc,
      bankName: detectedBank,
      accountType: detectedAccountTypeLabel,
      accountNumber: cuentaIdentificada || last4,
      currentBalance: 0,
      archived: false,
      isArchived: false,
    };
    state.accounts.push(createdAccount);
    updatedAccount = createdAccount;
    accountId = createdAccount.id;
  } else if (!updatedAccount && state.accounts[0]) {
    updatedAccount = state.accounts[0];
    accountId = updatedAccount.id;
  }

  if (updatedAccount?._pendingBatchCreate) {
    delete updatedAccount._pendingBatchCreate;
    createdAccount = updatedAccount;
  }

  if (!accountId) {
    throw new Error('Selecciona una Cuenta Asociada para registrar el movimiento.');
  }
  if (monto <= 0) {
    throw new Error('El monto del movimiento debe ser mayor a cero.');
  }

  const last4 = extractLast4Digits(cuentaIdentificada);
  const noteParts = [comercio];
  if (last4) {
    noteParts.push(`Cuenta/Tarjeta *${last4}`);
  }
  const note = noteParts.join(' · ');

  let savedTx = null;
  let effectiveAction = duplicateResolution;

  if (
    duplicateResolution === DUPLICATE_RESOLUTION_ACTIONS.OVERWRITE &&
    duplicateTx?.id
  ) {
    const existingIdx = state.transactions.findIndex((tx) => tx.id === duplicateTx.id);
    const updatedTx = {
      ...(existingIdx >= 0 ? state.transactions[existingIdx] : duplicateTx),
      type: tipoTransaccion,
      amount: monto,
      currency: moneda,
      categoryId,
      categoriaSugerida,
      accountId,
      date: fecha,
      note,
      documentType: tipoDocumento,
      cuentaIdentificada,
      updatedAt: new Date().toISOString(),
    };

    if (existingIdx >= 0) {
      state.transactions[existingIdx] = updatedTx;
    } else {
      state.transactions.unshift(updatedTx);
    }
    savedTx = updatedTx;
  } else {
    effectiveAction = DUPLICATE_RESOLUTION_ACTIONS.CREATE_NEW;
    const baseTx =
      typeof recordTransactionFn === 'function'
        ? recordTransactionFn({
            type: tipoTransaccion,
            amount: monto,
            currency: moneda,
            categoryId,
            accountId,
            date: fecha,
            note,
          })
        : createTransaction({
            type: tipoTransaccion,
            amount: monto,
            currency: moneda,
            categoryId,
            accountId,
            date: fecha,
            note,
          });

    savedTx = {
      ...baseTx,
      categoriaSugerida,
      documentType: tipoDocumento,
      cuentaIdentificada,
    };

    if (!state.transactions.some((tx) => tx.id === savedTx.id)) {
      state.transactions.unshift(savedTx);
    }
  }

  const newAccountBalance = recalculateAccountBalanceFromLedger(
    updatedAccount || { id: accountId, initialBalance: 0, currency: moneda },
    state.transactions,
    moneda
  );

  if (updatedAccount) {
    updatedAccount.currentBalance = newAccountBalance;
    updatedAccount.balance = newAccountBalance;
    if (cuentaIdentificada && !updatedAccount.accountNumber) {
      updatedAccount.accountNumber = last4 || cuentaIdentificada;
    }
  }

  const resolvedWorkspaceId =
    workspaceId || state?.activeWorkspaceId || state?.workspaceId || '';

  if (firestoreDb && firestoreModule && resolvedWorkspaceId) {
    try {
      const { doc, setDoc, updateDoc } = firestoreModule;
      if (updatedAccount && typeof doc === 'function') {
        const accRef = doc(
          firestoreDb,
          'workspaces',
          String(resolvedWorkspaceId),
          'accounts',
          String(accountId)
        );
        const accountPatch = {
          currentBalance: newAccountBalance,
          balance: newAccountBalance,
          accountNumber: updatedAccount.accountNumber || '',
          updatedAt: new Date().toISOString(),
        };
        if (createdAccount && typeof setDoc === 'function') {
          await setDoc(accRef, { ...updatedAccount, ...accountPatch }, { merge: true });
        } else if (typeof updateDoc === 'function') {
          await updateDoc(accRef, accountPatch);
        } else if (typeof setDoc === 'function') {
          await setDoc(accRef, { ...updatedAccount, ...accountPatch }, { merge: true });
        }
      }
      if (typeof doc === 'function' && typeof setDoc === 'function') {
        const txRef = doc(
          firestoreDb,
          'workspaces',
          String(resolvedWorkspaceId),
          'transactions',
          String(savedTx.id)
        );
        await setDoc(txRef, savedTx, { merge: true });
      }
    } catch {
      // Continúa con persistencia Local-First en caso de desconexión
    }
  }

  if (storage && resolvedWorkspaceId) {
    try {
      storage.setItem(
        `pisto_firestore_transactions_ws_${resolvedWorkspaceId}`,
        JSON.stringify(state.transactions)
      );
      storage.setItem(
        `pisto_firestore_accounts_ws_${resolvedWorkspaceId}`,
        JSON.stringify(state.accounts)
      );
    } catch {
      // Ignorar errores de cuota en almacenamiento local
    }
  }

  const learnedDocumentTemplate = await recordDocumentTemplateFeedback(
    {
      country:
        extractedData.country ||
        merged.country ||
        state?.user?.country ||
        state?.profile?.country,
      docType:
        tipoDocumento === SMART_SCAN_DOCUMENT_TYPES.INVOICE_RECEIPT
          ? 'tax_invoice'
          : 'pos_voucher',
      institutionName:
        extractedData.institutionName ||
        extractedData.detectedBank ||
        comercio ||
        'Voucher POS / Facturación SAR Honduras',
      accountNumber: cuentaIdentificada || '',
      currency: moneda,
      rtn: extractedData.rtn || '',
      cai: extractedData.cai || '',
      rawText: String(extractedData.rawText || merged.rawText || ''),
      transactions: [savedTx],
    },
    {
      firestoreDb:
        typeof firestoreModule?.updateDoc === 'function' ||
        typeof firestoreModule?.collection === 'function'
          ? firestoreDb
          : null,
      firestoreModule,
      indexedDb: merged.indexedDb,
      storage,
      state,
    }
  );

  return {
    action: effectiveAction,
    saved: true,
    createdAccount,
    accountId,
    transaction: savedTx,
    updatedAccount,
    newAccountBalance,
    learnedDocumentTemplate,
  };
}

/**
 * Componente Modal de Confirmación Único (`SmartScanModal`) con vista adaptativa
 * para comprobantes individuales y Estados de Cuenta multi-movimiento.
 */
export class SmartScanModal {
  /**
   * @param {object} [options]
   */
  constructor(options = {}) {
    this.doc = options.doc || (typeof document !== 'undefined' ? document : null);
    this.getState = typeof options.getState === 'function' ? options.getState : () => ({});
    this._rawGetWorkspaceId =
      typeof options.getWorkspaceId === 'function'
        ? options.getWorkspaceId
        : typeof options.getActiveWorkspaceId === 'function'
          ? options.getActiveWorkspaceId
          : null;
    this.authService = options.authService || null;
    this.getWorkspaceId = () => this.getActiveWorkspaceId();
    this.firestoreDb = options.firestoreDb || null;
    this.firestoreModule = options.firestoreModule || null;
    this.recordTransactionFn = options.recordTransactionFn || null;
    this.onSaved = typeof options.onSaved === 'function' ? options.onSaved : null;
    this._externalShowToast =
      typeof options.showToast === 'function' ? options.showToast : null;
    this.showToast = (message) => this.displayForegroundToast(message);
    this.storage =
      options.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    this.indexedDb =
      options.indexedDb ||
      (typeof globalThis !== 'undefined' ? globalThis.indexedDB : undefined);

    this.currentExtracted = null;
    this.currentFile = null;
    this.lastSelectedFile = null;
    this.lastAnalyzingButtonLabel = '';
    this.statementRows = [];
    this.createMissingAccountAccepted = false;
    this.createMissingAccountConfirmed = false;
    this.modalEl = options.modalEl || null;
    this._toastTimer = null;
    this._bound = false;
  }

  /**
   * Busca un elemento por ID tanto en `this.doc` como en `this.modalEl`.
   * @param {string} id
   * @returns {HTMLElement|null}
   */
  findElement(id) {
    const cleanId = String(id || '').replace(/^#/, '');
    if (!cleanId) return null;
    return (
      this.doc?.getElementById?.(cleanId) ||
      this.modalEl?.querySelector?.(`#${cleanId}`) ||
      this.doc?.querySelector?.(`#${cleanId}`) ||
      null
    );
  }

  /**
   * Actualiza el estado visual del botón `#btn-process-file`:
   * - En análisis: `"⏳ Analizando PDF..."` (`SMART_SCAN_ANALYZING_PDF_LABEL`)
   * - En reposo: `"⚡ Procesar y Evaluar Documento"` (`SMART_SCAN_PROCESS_BUTTON_LABEL`)
   *
   * @param {boolean} isLoading
   */
  setProcessButtonLoadingState(isLoading = false) {
    const processBtn = this.findElement(SMART_SCAN_PROCESS_BUTTON_ID);
    if (isLoading) {
      this.lastAnalyzingButtonLabel = SMART_SCAN_ANALYZING_PDF_LABEL;
    }
    if (!processBtn) return;

    if (isLoading) {
      processBtn.textContent = SMART_SCAN_ANALYZING_PDF_LABEL;
      if (processBtn.dataset) {
        processBtn.dataset.loading = 'true';
        processBtn.dataset.loadingLabel = SMART_SCAN_ANALYZING_PDF_LABEL;
      }
      processBtn.disabled = true;
    } else {
      processBtn.textContent = SMART_SCAN_PROCESS_BUTTON_LABEL;
      if (processBtn.dataset) {
        processBtn.dataset.loading = 'false';
      }
      processBtn.disabled = false;
    }
  }

  /**
   * Obtiene de forma segura el ID del workspace activo evitando errores como
   * `this.getActiveWorkspaceId is not a function`.
   * @returns {string}
   */
  getActiveWorkspaceId() {
    if (typeof this._rawGetWorkspaceId === 'function') {
      try {
        const wsId = this._rawGetWorkspaceId();
        if (wsId) return String(wsId);
      } catch {
        // Fallback seguro al estado local o authService
      }
    }
    const state = typeof this.getState === 'function' ? this.getState() : {};
    return String(
      this.authService?.getActiveWorkspaceId?.() ||
        state?.activeWorkspaceId ||
        state?.workspaceId ||
        state?.settings?.workspaceId ||
        'ws_default'
    );
  }

  /**
   * Muestra notificaciones y alertas en primer plano (`z-index: 9999`) completamente nítidas,
   * sin difuminado (`filter: none`, `backdrop-filter: none`) ni superposiciones opacas detrás del modal.
   *
   * @param {string} message
   */
  displayForegroundToast(message) {
    const cleanMsg = String(message || '').trim();
    if (!cleanMsg) return;

    const appToast = this.findElement('app-toast');
    if (appToast) {
      if (appToast.style) {
        appToast.style.zIndex = '9999';
        appToast.style.filter = 'none';
        appToast.style.backdropFilter = 'none';
      }
    }

    const modalOverlayToast = this.findElement(SMART_SCAN_TOAST_OVERLAY_ID);
    if (modalOverlayToast) {
      modalOverlayToast.textContent = cleanMsg;
      modalOverlayToast.innerHTML = cleanMsg;
      modalOverlayToast.hidden = false;
      modalOverlayToast.removeAttribute?.('hidden');
      if (modalOverlayToast.style) {
        modalOverlayToast.style.display = 'block';
        modalOverlayToast.style.zIndex = '9999';
        modalOverlayToast.style.filter = 'none';
        modalOverlayToast.style.backdropFilter = 'none';
        modalOverlayToast.style.opacity = '1';
      }
      modalOverlayToast.classList?.remove?.('is-hidden');
      modalOverlayToast.classList?.add?.('is-visible');
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => {
        modalOverlayToast.classList?.remove?.('is-visible');
        modalOverlayToast.classList?.add?.('is-hidden');
      }, 3600);
    }

    if (typeof this._externalShowToast === 'function') {
      this._externalShowToast(cleanMsg);
    }
  }

  /**
   * Obtiene el elemento `<select id="document-type">` (con fallback a `#smart-scan-doc-type-select`).
   * @returns {HTMLSelectElement|null}
   */
  getDocTypeSelect() {
    return (
      this.findElement(DOCUMENT_TYPE_SELECT_ID) ||
      this.findElement('smart-scan-doc-type-select')
    );
  }

  /**
   * Obtiene el elemento `<select id="associated-account">` (con fallback a `#smart-scan-account-select`).
   * @returns {HTMLSelectElement|null}
   */
  getAccountSelect() {
    return (
      this.findElement(ASSOCIATED_ACCOUNT_SELECT_ID) ||
      this.findElement('smart-scan-account-select')
    );
  }

  /**
   * Determina si el modal se encuentra actualmente en modo "Estado de Cuenta (Múltiples Movimientos)".
   * @returns {boolean}
   */
  isStatementMode() {
    const docTypeVal =
      this.getDocTypeSelect()?.value || this.currentExtracted?.tipoDocumento || '';
    return docTypeVal === SMART_SCAN_DOCUMENT_TYPES.BANK_STATEMENT;
  }

  /**
   * Asegura que el elemento `<dialog id="smart-scan-dialog">` exista en el DOM y tenga sus listeners.
   * @returns {HTMLDialogElement|HTMLElement|null}
   */
  ensureDialogElement() {
    if (!this.doc) return null;
    let dialogEl = this.doc.getElementById(SMART_SCAN_MODAL_ID);
    if (!dialogEl) {
      dialogEl = this.doc.createElement('dialog');
      dialogEl.id = SMART_SCAN_MODAL_ID;
      dialogEl.className = 'modal-dialog modal-dialog-wide';
      dialogEl.setAttribute('closedby', 'any');
      dialogEl.setAttribute('aria-labelledby', 'smart-scan-dialog-title');
      dialogEl.innerHTML = renderSmartScanModalMarkup();
      this.doc.body?.appendChild(dialogEl);
    } else if (
      !dialogEl.querySelector('#smart-scan-confirm-form') ||
      !dialogEl.querySelector('#smart-scan-statement-section') ||
      !dialogEl.querySelector(`#${DOCUMENT_TYPE_SELECT_ID}`) ||
      !dialogEl.querySelector(`#${ASSOCIATED_ACCOUNT_SELECT_ID}`) ||
      !dialogEl.querySelector(`#${SMART_SCAN_PROCESS_BUTTON_ID}`) ||
      dialogEl.querySelector('#smart-scan-match-badges')
    ) {
      dialogEl.innerHTML = renderSmartScanModalMarkup();
      delete dialogEl.dataset.smartScanModalBound;
    }

    this.bindEvents(dialogEl);
    return dialogEl;
  }

  /**
   * Enlaza eventos interactivos del formulario de confirmación, selectores de archivo (`change`),
   * botón único `#btn-process-file` (`⚡ Procesar y Evaluar Documento`), soporte de arrastrar y soltar (`drop`)
   * y de la tabla de Estado de Cuenta.
   * @param {HTMLElement} [dialogEl]
   */
  bindEvents(dialogEl = null) {
    const modal = dialogEl || this.doc?.getElementById(SMART_SCAN_MODAL_ID);
    if (!modal || modal.dataset.smartScanModalBound === 'true') return;
    modal.dataset.smartScanModalBound = 'true';

    const formEl = modal.querySelector('#smart-scan-confirm-form');
    const docTypeSelect =
      modal.querySelector(`#${DOCUMENT_TYPE_SELECT_ID}`) ||
      modal.querySelector('#smart-scan-doc-type-select');
    const identifiedInput = modal.querySelector('#smart-scan-identified-account-input');
    const accountSelect =
      modal.querySelector(`#${ASSOCIATED_ACCOUNT_SELECT_ID}`) ||
      modal.querySelector('#smart-scan-account-select');
    const currencySelect = modal.querySelector('#smart-scan-currency-select');
    const dateInput = modal.querySelector('#smart-scan-date-input');
    const amountInput = modal.querySelector('#smart-scan-amount-input');
    const merchantInput = modal.querySelector('#smart-scan-merchant-input');
    const tbody = modal.querySelector('#smart-scan-statement-tbody');
    const addRowBtn = modal.querySelector('#btn-smart-scan-add-row');
    const acceptCreateAccBtn = modal.querySelector('#btn-accept-create-account');
    const cancelCreateAccBtn = modal.querySelector('#btn-cancel-create-account');
    const modalFileInput = modal.querySelector(`#${SMART_SCAN_MODAL_FILE_INPUT_ID}`);
    const pickFileBtn = modal.querySelector('#btn-smart-scan-pick-file');
    const processFileBtn = modal.querySelector(`#${SMART_SCAN_PROCESS_BUTTON_ID}`);
    const previewImg = modal.querySelector('#smart-scan-preview-img');

    modal.querySelectorAll(`[data-close-modal="${SMART_SCAN_MODAL_ID}"]`).forEach((btn) => {
      btn.addEventListener('click', () => {
        this.close();
      });
    });

    // Captura de archivo por clic en vista previa o botón interno del modal
    const triggerModalFilePicker = (event) => {
      event?.preventDefault?.();
      const inputEl =
        modal.querySelector(`#${SMART_SCAN_MODAL_FILE_INPUT_ID}`) ||
        this.doc?.getElementById?.(SMART_SCAN_FILE_INPUT_ID);
      if (inputEl) {
        inputEl.value = '';
        inputEl.click?.();
      }
    };
    pickFileBtn?.addEventListener('click', triggerModalFilePicker);
    previewImg?.addEventListener('click', triggerModalFilePicker);

    // Botón único de evaluación: ⚡ Procesar y Evaluar Documento (#btn-process-file)
    processFileBtn?.addEventListener('click', async (event) => {
      event?.preventDefault?.();
      await this.handleProcessFileButtonClick(event);
    });

    // Captura de archivo en el evento `change` del <input type="file"> dentro del modal
    modalFileInput?.addEventListener('change', async (event) => {
      const file = extractFileFromInputOrDropEvent(event);
      if (file) {
        this.currentFile = file;
        this.lastSelectedFile = file;
        await this.processFileAndOpen(file);
      }
      modalFileInput.value = '';
    });

    // Captura de archivo en el evento `drop` sobre el modal (#smart-scan-dialog) o su zona de vista previa
    modal.addEventListener('dragover', (event) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      modal.classList?.add?.('is-dragover');
    });
    modal.addEventListener('dragleave', (event) => {
      event.preventDefault?.();
      modal.classList?.remove?.('is-dragover');
    });
    modal.addEventListener('drop', async (event) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      modal.classList?.remove?.('is-dragover');
      const file = extractFileFromInputOrDropEvent(event);
      if (file) {
        this.currentFile = file;
        this.lastSelectedFile = file;
        await this.processFileAndOpen(file);
      }
    });

    // Cambio de Tipo de Documento: alterna entre campos individuales y tabla de Estado de Cuenta
    docTypeSelect?.addEventListener('change', () => {
      const selectedType = docTypeSelect.value;
      if (this.currentExtracted) {
        this.currentExtracted.tipoDocumento = selectedType;
      }
      if (selectedType === SMART_SCAN_DOCUMENT_TYPES.BANK_STATEMENT) {
        const currentCurrency =
          modal.querySelector('#smart-scan-currency-select')?.value || 'HNL';
        const parsedFromRawText = this.currentExtracted?.rawText
          ? parseStatementTransactions(this.currentExtracted.rawText, currentCurrency)
          : [];
        if (parsedFromRawText.length > 0) {
          this.statementRows = parsedFromRawText;
        } else if (this.statementRows.length === 0) {
          this.statementRows = [
            {
              id: 'stmt_tx_1',
              selected: true,
              fecha:
                dateInput?.value ||
                this.currentExtracted?.fecha ||
                new Date().toISOString().slice(0, 10),
              comercio: merchantInput?.value || this.currentExtracted?.comercio || '',
              monto: sanitizeSmartScanAmount(
                amountInput?.value || this.currentExtracted?.monto || 0
              ),
              moneda: currentCurrency,
              tipo: TRANSACTION_TYPES.EXPENSE,
            },
          ];
        }
      } else {
        const txType = getTransactionTypeForDocument(selectedType);
        this.populateCategoryOptions(
          txType,
          modal.querySelector('#smart-scan-category-select')?.value,
          this.currentExtracted?.categoriaSugerida || ''
        );
      }
      this.syncAdaptiveViewMode();
    });

    // Al cambiar moneda, actualiza el resumen dinámico del pie del modal si está en Estado de Cuenta
    currencySelect?.addEventListener('change', () => {
      this.updateSubmitButtonLabel();
      this.refreshDuplicateWarning();
    });

    // Al editar cuentaIdentificada, re-evalúa asociación automática y banner de creación de cuenta
    identifiedInput?.addEventListener('input', async () => {
      const state = this.getState();
      const match = await matchAccountFromWorkspace(
        identifiedInput.value,
        state?.accounts || [],
        {
          firestoreDb: this.firestoreDb,
          firestoreModule: this.firestoreModule,
          workspaceId: this.getWorkspaceId(),
        }
      );
      this.createMissingAccountAccepted = false;
      this.renderAccountSelector(
        match.activeAccounts,
        match.matched ? match.accountId : '',
        match
      );
      this.updateMissingAccountBanner(identifiedInput.value, match);
      this.refreshDuplicateWarning();
    });

    // Botón [✨ Crear Cuenta N.º {accountNumber} y Asociar Movimientos] en el banner de cuenta inexistente
    acceptCreateAccBtn?.addEventListener('click', async () => {
      await this.handleAcceptCreateAccount();
    });

    // Botón [Cancelar] en el banner de cuenta inexistente
    cancelCreateAccBtn?.addEventListener('click', () => {
      this.createMissingAccountAccepted = false;
      const bannerEl = this.doc?.getElementById('smart-scan-missing-account-banner');
      bannerEl?.classList.add('is-hidden');
    });

    // Eventos delegados de la tabla interactiva de Estado de Cuenta (edición de celdas, checkboxes y eliminar)
    tbody?.addEventListener('change', (event) => {
      const target = event.target;
      if (!target) return;

      const checkAttr = target.getAttribute?.('data-scan-row-check');
      if (checkAttr !== null && checkAttr !== undefined) {
        const idx = Number.parseInt(checkAttr, 10);
        if (this.statementRows[idx]) {
          this.statementRows[idx].selected = Boolean(target.checked);
          this.updateSubmitButtonLabel();
        }
        return;
      }

      const fieldName = target.getAttribute?.('data-scan-row-field');
      const rowIdxAttr = target.getAttribute?.('data-scan-row-index');
      if (fieldName && rowIdxAttr !== null && rowIdxAttr !== undefined) {
        const idx = Number.parseInt(rowIdxAttr, 10);
        if (this.statementRows[idx]) {
          this.updateStatementRowCell(idx, fieldName, target.value);
        }
      }
    });

    tbody?.addEventListener('input', (event) => {
      const target = event.target;
      if (!target) return;
      const fieldName = target.getAttribute?.('data-scan-row-field');
      const rowIdxAttr = target.getAttribute?.('data-scan-row-index');
      if (fieldName && rowIdxAttr !== null && rowIdxAttr !== undefined) {
        const idx = Number.parseInt(rowIdxAttr, 10);
        if (this.statementRows[idx]) {
          this.updateStatementRowCell(idx, fieldName, target.value);
        }
      }
    });

    tbody?.addEventListener('click', (event) => {
      const delBtn = event.target?.closest?.('[data-scan-row-delete]');
      if (!delBtn) return;
      const idx = Number.parseInt(delBtn.getAttribute('data-scan-row-delete'), 10);
      this.deleteStatementRow(idx);
    });

    addRowBtn?.addEventListener('click', () => {
      this.addStatementRow();
    });

    const handleFieldChange = () => this.refreshDuplicateWarning();
    accountSelect?.addEventListener('change', handleFieldChange);
    dateInput?.addEventListener('change', handleFieldChange);
    amountInput?.addEventListener('input', handleFieldChange);
    merchantInput?.addEventListener('input', handleFieldChange);

    formEl?.addEventListener('submit', async (event) => {
      event.preventDefault();
      await this.handleFormSubmit();
    });

    this._bound = true;
  }

  /**
   * Alterna dinámicamente entre la vista de comprobante individual y la vista de Estado de Cuenta
   * (adaptando el modal a ancho extendido, mostrando la tabla de movimientos y el resumen dinámico).
   */
  syncAdaptiveViewMode() {
    if (!this.doc) return;
    const isStmt = this.isStatementMode();
    const dialogEl = this.doc.getElementById(SMART_SCAN_MODAL_ID);
    const singleFieldsEl = this.doc.getElementById('smart-scan-single-fields');
    const stmtSectionEl = this.doc.getElementById('smart-scan-statement-section');
    const footerSummaryEl = this.doc.getElementById(STATEMENT_FOOTER_SUMMARY_ID);
    const dateInput = this.doc.getElementById('smart-scan-date-input');
    const amountInput = this.doc.getElementById('smart-scan-amount-input');
    const merchantInput = this.doc.getElementById('smart-scan-merchant-input');
    const categorySelect = this.doc.getElementById('smart-scan-category-select');

    if (isStmt) {
      dialogEl?.classList?.add?.('smart-scan-modal-expanded');
      singleFieldsEl?.classList.add('is-hidden');
      stmtSectionEl?.classList.remove('is-hidden');
      footerSummaryEl?.classList.remove('is-hidden');
      if (dateInput) dateInput.required = false;
      if (amountInput) amountInput.required = false;
      if (merchantInput) merchantInput.required = false;
      if (categorySelect) categorySelect.required = false;
      this.renderStatementTable();
    } else {
      dialogEl?.classList?.remove?.('smart-scan-modal-expanded');
      singleFieldsEl?.classList.remove('is-hidden');
      stmtSectionEl?.classList.add('is-hidden');
      footerSummaryEl?.classList.add('is-hidden');
      if (dateInput) dateInput.required = true;
      if (amountInput) amountInput.required = true;
      if (merchantInput) merchantInput.required = true;
      if (categorySelect) categorySelect.required = true;
    }

    this.updateSubmitButtonLabel();
  }

  /**
   * Renderiza las filas de transacciones en `#smart-scan-statement-tbody` y actualiza el contador del botón y resumen.
   */
  renderStatementTable() {
    const tbody = this.findElement('smart-scan-statement-tbody');
    if (tbody) {
      tbody.innerHTML = renderStatementTransactionsRowsMarkup(this.statementRows);
    }
    this.updateSubmitButtonLabel();
  }

  /**
   * Actualiza una celda de la fila `index` en `this.statementRows`.
   * @param {number} index
   * @param {'fecha'|'comercio'|'monto'|'tipo'|'selected'} field
   * @param {any} value
   */
  updateStatementRowCell(index, field, value) {
    const row = this.statementRows[index];
    if (!row) return;

    if (field === 'selected') {
      row.selected = Boolean(value);
    } else if (field === 'fecha') {
      row.fecha = String(value || '').slice(0, 10);
      row.date = row.fecha;
    } else if (field === 'comercio') {
      row.comercio = String(value || '');
      row.concept = row.comercio;
    } else if (field === 'monto') {
      row.monto = sanitizeSmartScanAmount(value);
      row.amount = row.monto;
    } else if (field === 'tipo') {
      row.tipo =
        value === TRANSACTION_TYPES.INCOME
          ? TRANSACTION_TYPES.INCOME
          : TRANSACTION_TYPES.EXPENSE;
      row.type = row.tipo;
    }

    this.updateSubmitButtonLabel();
  }

  /**
   * Elimina una fila de la tabla de Estado de Cuenta y re-renderiza.
   * @param {number} index
   */
  deleteStatementRow(index) {
    if (index < 0 || index >= this.statementRows.length) return;
    this.statementRows.splice(index, 1);
    this.renderStatementTable();
  }

  /**
   * Agrega una nueva fila editable a la tabla de Estado de Cuenta.
   */
  addStatementRow() {
    const today = new Date().toISOString().slice(0, 10);
    const moneda =
      this.doc?.getElementById('smart-scan-currency-select')?.value || 'HNL';
    this.statementRows.push({
      id: `stmt_tx_${Date.now()}`,
      selected: true,
      fecha: today,
      date: today,
      comercio: '',
      concept: '',
      monto: 0,
      amount: 0,
      moneda,
      currency: moneda,
      tipo: TRANSACTION_TYPES.EXPENSE,
      type: TRANSACTION_TYPES.EXPENSE,
    });
    this.renderStatementTable();
  }

  /**
   * Devuelve las filas seleccionadas (`selected !== false`) del Estado de Cuenta.
   * @returns {Array<object>}
   */
  getSelectedStatementRows() {
    return this.statementRows.filter((r) => r && r.selected !== false);
  }

  /**
   * Actualiza el texto del botón de confirmación y el resumen dinámico del pie del modal:
   * - Comprobante individual: "Guardar Movimiento"
   * - Estado de Cuenta: "Guardar X Movimientos Seleccionados" + "Total Seleccionado: L X,XXX.XX | N.º de Movimientos: X"
   */
  updateSubmitButtonLabel() {
    const saveBtn = this.findElement('btn-save-smart-scan-tx');
    const footerSummaryEl = this.findElement(STATEMENT_FOOTER_SUMMARY_ID);
    const isStmt = this.isStatementMode();
    const selectedRows = this.getSelectedStatementRows();
    const selectedCount = selectedRows.length;

    if (saveBtn) {
      saveBtn.textContent = formatSmartScanSubmitButtonLabel(isStmt, selectedCount);
    }

    if (footerSummaryEl) {
      const currency =
        this.findElement('smart-scan-currency-select')?.value ||
        this.findElement('smart-scan-currency')?.value ||
        this.currentExtracted?.moneda ||
        'HNL';
      footerSummaryEl.textContent = formatStatementFooterSummary(
        this.statementRows,
        currency
      );
      if (isStmt) {
        footerSummaryEl.classList?.remove?.('is-hidden');
      } else {
        footerSummaryEl.classList?.add?.('is-hidden');
      }
    }
  }

  /**
   * Muestra u oculta el banner de aviso cuando la cuenta identificada no existe en el workspace de Firestore.
   * - Aviso: "⚠️ La cuenta N.º {accountNumber} ({bankName}) no está registrada. Se creará automáticamente al guardar."
   * - Botón: "✨ Crear Cuenta N.º {accountNumber} y Asociar Movimientos"
   *
   * @param {string} cuentaIdentificada
   * @param {object} accountMatch
   * @param {string} [bankName]
   */
  updateMissingAccountBanner(cuentaIdentificada = '', accountMatch = null, bankName = '') {
    const bannerEl = this.findElement('smart-scan-missing-account-banner');
    const unregisteredNoticeEl = this.findElement(
      'smart-scan-unregistered-account-notice'
    );
    const workspaceNoticeEl = this.findElement(
      'smart-scan-missing-account-workspace-notice'
    );
    const alertEl = this.findElement('smart-scan-missing-account-alert');
    const msgEl = this.findElement('smart-scan-missing-account-message');
    const createBtnEl = this.findElement('btn-accept-create-account');

    const cleanNum = String(cuentaIdentificada || '').trim();
    const isMatched = Boolean(accountMatch?.matched);
    const resolvedBank = String(
      bankName ||
        this.currentExtracted?.bankName ||
        this.currentExtracted?.detectedBank ||
        ''
    ).trim();
    const effectiveBank =
      resolvedBank && resolvedBank !== 'Banco Local' ? resolvedBank : '';

    if (cleanNum && !isMatched && !this.createMissingAccountAccepted) {
      this.createMissingAccountConfirmed = true;
      const unregisteredText = formatUnregisteredAccountNotice(cleanNum, effectiveBank);
      if (unregisteredNoticeEl) {
        unregisteredNoticeEl.textContent = unregisteredText;
      }
      if (workspaceNoticeEl) {
        workspaceNoticeEl.textContent = formatMissingAccountWorkspaceNotice(cleanNum);
      }
      if (alertEl) {
        alertEl.textContent = formatMissingAccountAlertText(cleanNum, effectiveBank);
      }
      if (msgEl) {
        msgEl.textContent = formatMissingAccountBannerMessage(cleanNum, {
          bankName: effectiveBank,
        });
      }
      if (createBtnEl) {
        createBtnEl.textContent = formatCreateAndAssociateAccountButtonLabel(cleanNum);
      }
      if (bannerEl) {
        if (!unregisteredNoticeEl && !workspaceNoticeEl && !alertEl && !msgEl) {
          bannerEl.innerHTML = unregisteredText;
        }
        bannerEl.hidden = false;
        if (bannerEl.style) {
          bannerEl.style.zIndex = '9999';
          bannerEl.style.filter = 'none';
          bannerEl.style.backdropFilter = 'none';
          bannerEl.style.opacity = '1';
        }
        bannerEl.classList?.remove?.('is-hidden');
      }
      this.displayForegroundToast(unregisteredText);
    } else if (bannerEl) {
      bannerEl.classList?.add?.('is-hidden');
    }
  }

  /**
   * Acción del botón `[✨ Crear Cuenta N.º {accountNumber} y Asociar Movimientos]`:
   * Crea primero la cuenta detectada en Firestore (`accounts`) con su banco, tipo, límite de crédito y saldo,
   * la selecciona automáticamente en `<select id="associated-account">` y, si `options.submitMovements`
   * es `true`, inserta también la transacción o lote de transacciones de inmediato.
   *
   * @param {{ submitMovements?: boolean }} [options]
   * @returns {Promise<object|null>}
   */
  async handleAcceptCreateAccount(options = {}) {
    const state = this.getState();
    if (!Array.isArray(state.accounts)) state.accounts = [];

    const accountInfo = this.currentExtracted?.accountInfo || {};
    const cuentaIdentificada = (
      this.doc?.getElementById('smart-scan-identified-account-input')?.value ||
      this.currentExtracted?.cuentaIdentificada ||
      accountInfo?.accountNumber ||
      ''
    ).trim();
    const moneda =
      this.doc?.getElementById('smart-scan-currency-select')?.value ||
      this.currentExtracted?.moneda ||
      accountInfo?.currency ||
      'HNL';
    const metadata = detectBankAndAccountMetadata(this.currentExtracted?.rawText || '');
    const detectedBank =
      this.currentExtracted?.bankName ||
      this.currentExtracted?.detectedBank ||
      metadata.bankName ||
      'Banco Local';
    const creditLimit = sanitizeSmartScanAmount(
      this.currentExtracted?.creditLimit ?? accountInfo?.creditLimit ?? 0
    );
    const minimumPayment = sanitizeSmartScanAmount(
      this.currentExtracted?.minimumPayment ?? accountInfo?.minimumPayment ?? 0
    );
    const cutoffDate = String(
      this.currentExtracted?.cutoffDate || accountInfo?.cutoffDate || ''
    ).trim();
    const paymentDueDate = String(
      this.currentExtracted?.paymentDueDate || accountInfo?.paymentDueDate || ''
    ).trim();
    const owner = String(
      this.currentExtracted?.owner || accountInfo?.owner || ''
    ).trim();
    const isCreditCard =
      creditLimit > 0 ||
      this.currentExtracted?.detectedAccountType === 'card' ||
      /Tarjeta|PLATINUM|VISA|MASTERCARD|AMEX/i.test(
        `${this.currentExtracted?.statementDocumentType || ''} ${accountInfo?.accountName || ''} ${this.currentExtracted?.detectedAccountTypeLabel || ''}`
      ) ||
      metadata.accountType === 'card';
    const detectedAccountType = isCreditCard ? 'card' : 'bank';
    const detectedAccountTypeLabel =
      accountInfo?.accountName ||
      this.currentExtracted?.detectedAccountTypeLabel ||
      metadata.accountTypeLabel ||
      (isCreditCard ? 'Tarjeta de Crédito' : 'Cuenta de Ahorro');
    const last4 = extractLast4Digits(cuentaIdentificada) || cuentaIdentificada;

    this.createMissingAccountAccepted = true;

    // Verificar si ya fue creada
    let targetAcc = state.accounts.find(
      (a) =>
        a.accountNumber &&
        String(a.accountNumber).replace(/\D/g, '') ===
          String(cuentaIdentificada).replace(/\D/g, '')
    );

    if (!targetAcc) {
      const baseAcc = createAccount({
        name: `${detectedBank} - ${detectedAccountTypeLabel}${last4 ? ` (*${last4})` : ''}`,
        type: detectedAccountType === 'card' ? 'card' : 'bank',
        currency: moneda,
        initialBalance: 0,
        institution: detectedBank,
        accountNumber: cuentaIdentificada || last4,
      });
      targetAcc = {
        ...baseAcc,
        bankName: detectedBank,
        accountName: detectedAccountTypeLabel,
        accountType: detectedAccountTypeLabel,
        accountNumber: cuentaIdentificada || last4,
        creditLimit,
        minimumPayment,
        cutoffDate,
        paymentDueDate,
        owner,
        currentBalance: 0,
        archived: false,
        isArchived: false,
        _pendingBatchCreate: true,
      };
      state.accounts.push(targetAcc);
    }

    // Persistir en Firestore si el cliente está disponible
    const resolvedWorkspaceId =
      this.getWorkspaceId() || state?.activeWorkspaceId || state?.workspaceId || '';
    if (this.firestoreDb && this.firestoreModule && resolvedWorkspaceId) {
      try {
        const { doc, setDoc } = this.firestoreModule;
        if (typeof doc === 'function' && typeof setDoc === 'function') {
          const accRef = doc(
            this.firestoreDb,
            'workspaces',
            String(resolvedWorkspaceId),
            'accounts',
            String(targetAcc.id)
          );
          const cleanAccDoc = { ...targetAcc };
          delete cleanAccDoc._pendingBatchCreate;
          await setDoc(accRef, cleanAccDoc, { merge: true });
        }
      } catch {
        // Fallback Local-First
      }
    }

    if (this.currentExtracted) {
      this.currentExtracted.accountId = targetAcc.id;
    }

    const activeAccounts = filterActiveAccounts(state.accounts).filter(
      (a) => a && !a.archived && !a.isArchived
    );
    this.renderAccountSelector(activeAccounts, targetAcc.id, {
      matched: true,
      accountId: targetAcc.id,
      matchedAccount: targetAcc,
      matchedDigits: last4,
      activeAccounts,
    });

    const bannerEl = this.doc?.getElementById('smart-scan-missing-account-banner');
    bannerEl?.classList.add('is-hidden');

    this.showToast(
      `✅ Cuenta "${targetAcc.name}" creada y asociada a los movimientos.`
    );

    if (options?.submitMovements === true) {
      await this.handleFormSubmit();
    }

    return targetAcc;
  }

  /**
   * Llena el selector de categorías filtrando por tipo de transacción ('income' o 'expense')
   * y selecciona la categoría más pertinente según `selectedCategoryId` o `categoriaSugerida`.
   *
   * @param {'income'|'expense'} txType
   * @param {string} [selectedCategoryId]
   * @param {string} [categoriaSugerida]
   */
  populateCategoryOptions(
    txType = TRANSACTION_TYPES.EXPENSE,
    selectedCategoryId = '',
    categoriaSugerida = ''
  ) {
    const catSelect = this.doc?.getElementById('smart-scan-category-select');
    if (!catSelect) return;

    const state = this.getState();
    const stateCategories =
      Array.isArray(state?.categories) && state.categories.length > 0
        ? state.categories
        : DEFAULT_CATEGORIES;
    const filtered = stateCategories.filter((c) => c.type === txType);
    const baseList = filtered.length > 0 ? [...filtered] : [...stateCategories];

    const normalizeLabel = (s) =>
      String(s || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();

    // Si categoriaSugerida viene con una etiqueta específica (ej. "Servicios Públicos" o "Combustible"),
    // asegurar que la opción seleccionada refleje tanto el categoryId como la etiqueta sugerida
    if (categoriaSugerida) {
      const targetNorm = normalizeLabel(categoriaSugerida);
      const matchingExisting = baseList.find(
        (c) =>
          normalizeLabel(c.name) === targetNorm ||
          (selectedCategoryId && c.id === selectedCategoryId)
      );
      if (matchingExisting && selectedCategoryId && matchingExisting.id === selectedCategoryId) {
        const idx = baseList.findIndex((c) => c.id === matchingExisting.id);
        if (idx >= 0) {
          baseList[idx] = { ...baseList[idx], name: categoriaSugerida };
        }
      }
    }

    catSelect.innerHTML = baseList
      .map((c) => `<option value="${c.id}">${c.name}</option>`)
      .join('');

    if (selectedCategoryId && baseList.some((c) => c.id === selectedCategoryId)) {
      catSelect.value = selectedCategoryId;
    } else if (categoriaSugerida) {
      const targetNorm = normalizeLabel(categoriaSugerida);
      const byName = baseList.find((c) => normalizeLabel(c.name) === targetNorm);
      if (byName) {
        catSelect.value = byName.id;
      } else if (baseList[0]) {
        catSelect.value = baseList[0].id;
      }
    } else if (baseList[0]) {
      catSelect.value = baseList[0].id;
    }
  }

  /**
   * Renderiza el selector desplegable de cuentas activas (`<select id="associated-account">`).
   * @param {Array<object>} activeAccounts
   * @param {string} matchedAccountId
   * @param {object} [accountMatch]
   */
  renderAccountSelector(activeAccounts = [], matchedAccountId = '', accountMatch = null) {
    const accSelect = this.getAccountSelect();
    const hintEl = this.doc?.getElementById('smart-scan-account-match-hint');
    if (!accSelect) return;

    const accounts = filterActiveAccounts(activeAccounts).filter(
      (a) => a && !a.archived && !a.isArchived
    );
    const optionsHtml = [];

    if (!matchedAccountId) {
      optionsHtml.push(
        `<option value="" selected>-- Selecciona manualmente una cuenta activa (${accounts.length}) --</option>`
      );
    }

    for (const acc of accounts) {
      const last4 = extractLast4Digits(acc.accountNumber || '');
      const numBadge = last4
        ? ` (N.º *${last4})`
        : acc.accountNumber
          ? ` (${acc.accountNumber})`
          : '';
      const instBadge = acc.institution ? ` · ${acc.institution}` : '';
      const isSelected = matchedAccountId && acc.id === matchedAccountId ? 'selected' : '';
      optionsHtml.push(
        `<option value="${acc.id}" ${isSelected}>${acc.name}${numBadge}${instBadge} [${acc.currency || 'HNL'}]</option>`
      );
    }

    accSelect.innerHTML = optionsHtml.join('');
    if (matchedAccountId && accounts.some((a) => a.id === matchedAccountId)) {
      accSelect.value = matchedAccountId;
    }

    if (hintEl) {
      if (accountMatch?.matched && accountMatch.matchedAccount) {
        hintEl.textContent = `✅ Cuenta asociada automáticamente por coincidencia (*${accountMatch.matchedDigits}) → ${accountMatch.matchedAccount.name}`;
      } else {
        hintEl.textContent =
          'ℹ️ Sin coincidencia automática de cuenta. Selecciona manualmente una cuenta o acepta crearla.';
      }
    }
  }

  /**
   * Re-evalúa si los valores actuales del formulario corresponden a un movimiento duplicado.
   */
  refreshDuplicateWarning() {
    if (!this.doc) return;
    const warningEl = this.doc.getElementById('smart-scan-duplicate-warning');
    const detailEl = this.doc.getElementById('smart-scan-duplicate-detail');
    if (!warningEl) return;

    if (this.isStatementMode()) {
      warningEl.classList.add('is-hidden');
      return;
    }

    const fecha = this.doc.getElementById('smart-scan-date-input')?.value || '';
    const comercio = this.doc.getElementById('smart-scan-merchant-input')?.value || '';
    const monto = sanitizeSmartScanAmount(
      this.doc.getElementById('smart-scan-amount-input')?.value || 0
    );
    const moneda = this.doc.getElementById('smart-scan-currency-select')?.value || 'HNL';
    const accountId = this.getAccountSelect()?.value || '';

    const state = this.getState();
    const dupCheck = detectSmartScanDuplicate(
      { fecha, comercio, monto, moneda },
      state?.transactions || [],
      accountId
    );

    if (this.currentExtracted) {
      this.currentExtracted.isDuplicate = dupCheck.isDuplicate;
      this.currentExtracted.duplicateTx = dupCheck.duplicateTx;
      this.currentExtracted.duplicateType = dupCheck.matchType;
    }

    if (dupCheck.isDuplicate) {
      warningEl.classList.remove('is-hidden');
      if (detailEl && dupCheck.duplicateTx) {
        detailEl.textContent = `Coincide con "${dupCheck.duplicateTx.note || 'Movimiento'}" del ${dupCheck.duplicateTx.date} por ${Money.format(dupCheck.duplicateTx.amount, dupCheck.duplicateTx.currency || moneda)}. Elige Sobreescribir, Crear Nueva u Omitir.`;
      }
    } else {
      warningEl.classList.add('is-hidden');
    }
  }

  /**
   * Abre el modal con datos ya extraídos para su edición y confirmación.
   * Si es un Estado de Cuenta (o contiene múltiples movimientos), activa automáticamente
   * la tabla visual interactiva y valida la existencia de la cuenta en el workspace.
   *
   * @param {object} extracted
   */
  openWithExtractedData(extracted = {}) {
    const dialogEl = this.ensureDialogElement() || this.modalEl;

    const state = this.getState();
    // 3a) Abstracción del Encabezado (Datos de Cuenta)
    const headerData = abstractDocumentHeaderAccountData(extracted, state);
    // 3b) Abstracción del Detalle del Contenido (Lista de Transacciones)
    const bodyTransactions = abstractDocumentBodyTransactions(extracted, headerData);

    const accountInfo = extracted.accountInfo || {};
    const normalizedDate = normalizeSmartScanDate(
      extracted.fecha ||
        extracted.date ||
        accountInfo.cutoffDate ||
        new Date().toISOString().slice(0, 10)
    );
    const normalizedMerchant = String(
      extracted.comercio ||
        extracted.merchant ||
        accountInfo.accountName ||
        headerData.bankName ||
        ''
    ).trim();
    const normalizedAmount = sanitizeSmartScanAmount(
      extracted.monto ?? extracted.amount ?? accountInfo.currentBalance ?? 0
    );
    const normalizedCurrency = headerData.currency;
    const normalizedAccountNum = headerData.accountNumber;

    const requestedDocType = extracted.tipoDocumento || extracted.documentType || '';
    const isAutoStatement =
      requestedDocType === SMART_SCAN_DOCUMENT_TYPES.BANK_STATEMENT ||
      /Estado\s+de\s+Cuenta/i.test(requestedDocType) ||
      /Estado\s+de\s+Cuenta/i.test(String(extracted.statementDocumentType || '')) ||
      extracted.isMultiRowStatement === true ||
      bodyTransactions.length >= 2 ||
      (bodyTransactions.length >= 1 && Boolean(extracted.accountInfo));

    const tipoDocumento = isAutoStatement
      ? SMART_SCAN_DOCUMENT_TYPES.BANK_STATEMENT
      : requestedDocType || SMART_SCAN_DOCUMENT_TYPES.INVOICE_RECEIPT;
    const tipoTransaccion =
      extracted.tipoTransaccion || getTransactionTypeForDocument(tipoDocumento);

    const inferredCat = inferSmartScanCategory(
      normalizedMerchant,
      `${normalizedMerchant} ${extracted.rawText || ''}`,
      tipoTransaccion,
      state?.categories || [],
      extracted.categoriaSugerida || extracted.suggestedCategory || ''
    );
    const resolvedCategoryId = extracted.categoryId || inferredCat.categoryId;
    const resolvedCategoriaSugerida =
      extracted.categoriaSugerida ||
      extracted.suggestedCategory ||
      inferredCat.categoriaSugerida;

    const accountExistsInFirestore = Boolean(headerData.accountMatch?.matched);
    this.currentExtracted = {
      ...extracted,
      bankName: headerData.bankName,
      detectedBank: headerData.bankName,
      detectedAccountType: headerData.accountType,
      detectedAccountTypeLabel: headerData.accountTypeLabel,
      fecha: normalizedDate,
      date: normalizedDate,
      comercio: normalizedMerchant,
      merchant: normalizedMerchant,
      monto: normalizedAmount,
      amount: normalizedAmount,
      moneda: normalizedCurrency,
      currency: normalizedCurrency,
      cuentaIdentificada: normalizedAccountNum,
      accountNumber: normalizedAccountNum,
      tipoDocumento,
      documentType: tipoDocumento,
      tipoTransaccion,
      categoryId: resolvedCategoryId,
      categoriaSugerida: resolvedCategoriaSugerida,
      headerAbstraction: {
        ...headerData,
        accountExistsInFirestore,
      },
      bodyTransactions,
    };
    this.createMissingAccountAccepted = false;
    this.createMissingAccountConfirmed = Boolean(
      normalizedAccountNum && !accountExistsInFirestore
    );
    this.statementRows = bodyTransactions;

    const docTypeSelect = this.getDocTypeSelect();
    const dateInput = this.findElement('smart-scan-date-input');
    const merchantInput = this.findElement('smart-scan-merchant-input');
    const amountInput = this.findElement('smart-scan-amount-input');
    const currencySelect = this.findElement('smart-scan-currency-select');
    const currencyFallbackSelect = this.findElement('smart-scan-currency');
    const identifiedInput = this.findElement('smart-scan-identified-account-input');
    const accountHintInput = this.findElement('smart-scan-account-hint');
    const previewImg = this.findElement(SMART_SCAN_PREVIEW_IMG_ID);
    const taxSummaryEl = this.findElement('smart-scan-tax-summary');

    if (docTypeSelect) docTypeSelect.value = tipoDocumento;
    if (dateInput) dateInput.value = normalizedDate;
    if (merchantInput) merchantInput.value = normalizedMerchant;
    if (amountInput) {
      amountInput.value = normalizedAmount > 0 ? String(normalizedAmount) : '';
    }
    if (currencySelect) currencySelect.value = normalizedCurrency;
    if (currencyFallbackSelect) currencyFallbackSelect.value = normalizedCurrency;
    if (identifiedInput) identifiedInput.value = normalizedAccountNum;
    if (accountHintInput) accountHintInput.value = normalizedAccountNum;
    const previewUrl = extracted.thumbnailDataUrl || extracted.originalDataUrl;
    if (previewImg && previewUrl) {
      previewImg.src = previewUrl;
    }

    this.populateCategoryOptions(
      tipoTransaccion,
      resolvedCategoryId,
      resolvedCategoriaSugerida
    );

    this.renderAccountSelector(
      headerData.activeAccounts,
      headerData.matchedAccountId,
      headerData.accountMatch
    );
    this.updateMissingAccountBanner(
      normalizedAccountNum,
      headerData.accountMatch,
      headerData.bankName
    );
    this.renderStatementTable();

    if (taxSummaryEl) {
      const { subtotal = 0, isv = 0, devolIsv = 0 } = extracted.breakdown || {};
      if (!isAutoStatement && (subtotal > 0 || isv > 0)) {
        taxSummaryEl.classList?.remove?.('is-hidden');
        taxSummaryEl.innerHTML = `
          <strong>Desglose detectado:</strong>
          Subtotal: ${Money.format(subtotal, normalizedCurrency)} ·
          ISV: ${Money.format(isv, normalizedCurrency)}
          ${devolIsv > 0 ? ` · Devolución ISV: -${Money.format(devolIsv, normalizedCurrency)}` : ''} ·
          <strong>Total: ${Money.format(normalizedAmount || 0, normalizedCurrency)}</strong>
        `;
      } else {
        taxSummaryEl.classList?.add?.('is-hidden');
      }
    }

    const createNewRadio = dialogEl?.querySelector?.(
      'input[name="duplicateResolution"][value="create_new"]'
    );
    if (createNewRadio) createNewRadio.checked = true;

    this.syncAdaptiveViewMode();
    this.refreshDuplicateWarning();

    if (dialogEl) {
      if (typeof dialogEl.showModal === 'function' && !dialogEl.open) {
        dialogEl.showModal();
      } else if (typeof dialogEl.setAttribute === 'function') {
        dialogEl.setAttribute('open', '');
      }
    }
  }

  /**
   * Handler conectado al botón `#btn-process-file` (`"⚡ Procesar y Evaluar Documento"`):
   * a) Muestra el indicador visual `"⏳ Analizando PDF..."` en el botón.
   * b) Ejecuta `extractPdfData(currentFile)`.
   * c) Actualiza atómicamente el estado del modal y los campos del DOM.
   * d) Evalúa si la cuenta existe en Firestore `accounts` y muestra el aviso nítido en primer plano.
   *
   * @param {Event|null} [event=null]
   * @param {object} [extraOptions={}]
   * @returns {Promise<object|null>}
   */
  async handleProcessFileButtonClick(event = null, extraOptions = {}) {
    event?.preventDefault?.();
    const modal = this.findElement(SMART_SCAN_MODAL_ID) || this.modalEl;
    const modalFileInput = modal?.querySelector?.(`#${SMART_SCAN_MODAL_FILE_INPUT_ID}`);
    const externalFileInput = this.findElement(SMART_SCAN_FILE_INPUT_ID);
    const pendingInputFile =
      modalFileInput?.files?.[0] || externalFileInput?.files?.[0] || null;
    const currentFile =
      pendingInputFile ||
      this.currentFile ||
      this.lastSelectedFile ||
      this.currentExtracted ||
      null;

    if (!currentFile) {
      const inputEl = modalFileInput || externalFileInput;
      if (inputEl) {
        inputEl.value = '';
        inputEl.click?.();
      }
      return null;
    }

    return this.evaluateAndPopulateDocument(currentFile, extraOptions);
  }

  /**
   * Evalúa el contenido del documento al hacer clic en `"⚡ Procesar y Evaluar Documento"` (`#btn-process-file`):
   * a) Muestra `"⏳ Analizando PDF..."` en el botón `#btn-process-file`.
   * b) Ejecuta `extractPdfData(currentFile)`.
   * c) Actualiza atómicamente el estado del modal y los campos del DOM:
   *    - Selector "Moneda": "Lempiras (HNL)" (`HNL`) o "Dólares (USD)" (`USD`)
   *    - Campo "Cuenta / Últimos 4 Dígitos": ej. "310074459"
   *    - Tabla de Movimientos: reemplaza la fila por defecto por las transacciones reales extraídas
   *    - Totales: "Total Seleccionado: L 1,620.42 | N.º de Movimientos: 1"
   * d) Revisa si la cuenta existe en Firestore `accounts` y muestra el aviso nítido en primer plano si no está registrada.
   *
   * @param {File|Blob|object|string} [fileOrExtracted=null]
   * @param {object} [extraOptions={}]
   * @returns {Promise<object|null>}
   */
  async evaluateAndPopulateDocument(fileOrExtracted = null, extraOptions = {}) {
    const currentFile =
      fileOrExtracted ||
      this.currentFile ||
      this.lastSelectedFile ||
      this.currentExtracted;
    if (!currentFile) {
      return null;
    }

    this.ensureDialogElement();
    this.setProcessButtonLoadingState(true);
    if (typeof extraOptions.onAnalyzingState === 'function') {
      extraOptions.onAnalyzingState(SMART_SCAN_ANALYZING_PDF_LABEL);
    }

    try {
      const fileName = String(currentFile?.name || '').toLowerCase();
      const mimeType = String(currentFile?.type || '').toLowerCase();
      const isImageFile =
        mimeType.startsWith('image/') || /\.(png|jpe?g|webp|bmp|gif)$/i.test(fileName);

      if (isImageFile && !currentFile?.rawText && !currentFile?.accountInfo) {
        this.currentFile = currentFile;
        this.lastSelectedFile = currentFile;
        return await this.processFileAndOpen(currentFile, extraOptions);
      }

      if (
        (typeof Blob !== 'undefined' && currentFile instanceof Blob) ||
        typeof currentFile?.arrayBuffer === 'function'
      ) {
        this.currentFile = currentFile;
        this.lastSelectedFile = currentFile;
      }

      const previewCanvas = this.findElement(SMART_SCAN_PREVIEW_CANVAS_ID);
      const pdfExtracted =
        typeof extraOptions.pdfExtractorRunner === 'function'
          ? await extraOptions.pdfExtractorRunner(currentFile, {
              ...extraOptions,
              doc: this.doc,
              canvas: previewCanvas,
            })
          : await extractPdfData(currentFile, {
              ...extraOptions,
              doc: this.doc,
              canvas: previewCanvas,
            });

      const state = this.getState();
      const accountNumber = String(
        pdfExtracted.accountNumber || pdfExtracted.cuentaIdentificada || ''
      ).trim();

      let candidateAccounts = Array.isArray(state?.accounts) ? [...state.accounts] : [];
      if (typeof extraOptions.firestoreAccountChecker === 'function') {
        const externalAccounts = await extraOptions.firestoreAccountChecker(accountNumber);
        if (Array.isArray(externalAccounts) && externalAccounts.length > 0) {
          candidateAccounts = [...candidateAccounts, ...externalAccounts];
        }
      }

      const accountMatch = await matchAccountFromWorkspace(
        accountNumber,
        candidateAccounts,
        {
          firestoreDb: extraOptions.firestoreDb || this.firestoreDb,
          firestoreModule: extraOptions.firestoreModule || this.firestoreModule,
          workspaceId: extraOptions.workspaceId || this.getActiveWorkspaceId(),
        }
      );

      const enrichedExtraction = {
        ...pdfExtracted,
        accountMatch,
        accountExists: Boolean(accountMatch.matched),
        accountId: accountMatch.matched ? accountMatch.accountId : '',
        unregisteredAccountNotice:
          accountNumber && !accountMatch.matched
            ? formatUnregisteredAccountNotice(accountNumber, pdfExtracted.bankName)
            : '',
      };

      this.openWithExtractedData(enrichedExtraction);
      if (accountNumber && !accountMatch.matched) {
        this.displayForegroundToast(enrichedExtraction.unregisteredAccountNotice);
      }
      return this.currentExtracted;
    } finally {
      if (extraOptions.keepAnalyzingIndicator !== true) {
        this.setProcessButtonLoadingState(false);
      }
    }
  }

  /**
   * Procesa un archivo (PNG, JPG, WEBP, PDF) con la estrategia híbrida (PDF Nativo -> Plantillas -> OCR Local -> Gemini 2.5 Flash),
   * genera la miniatura del documento (incluyendo primera página de PDF en `<canvas>`)
   * y sincroniza de inmediato los campos del modal.
   *
   * @param {File|Blob|object|string} file
   * @param {object} [extraOptions]
   * @returns {Promise<object>}
   */
  async processFileAndOpen(file, extraOptions = {}) {
    this.currentFile = file;
    this.lastSelectedFile = file;
    const dialogEl = this.ensureDialogElement();
    const progressBox = this.doc?.getElementById('smart-scan-progress-box');
    const progressStatus = this.doc?.getElementById('smart-scan-progress-status');
    const progressPct = this.doc?.getElementById('smart-scan-progress-pct');
    const progressBar = this.doc?.getElementById('smart-scan-progress-bar');
    const saveBtn = this.doc?.getElementById('btn-save-smart-scan-tx');
    const previewCanvas = this.doc?.getElementById(SMART_SCAN_PREVIEW_CANVAS_ID);

    const fileName = String(file?.name || '').toLowerCase();
    const mimeType = String(file?.type || '').toLowerCase();
    const isPdf =
      mimeType === 'application/pdf' ||
      fileName.endsWith('.pdf') ||
      (typeof file === 'string' && file.trim().startsWith('data:application/pdf'));

    const state = this.getState();
    // Pre-poblar selectores de categoría y cuentas para que el modal jamás luzca vacío durante la carga
    this.populateCategoryOptions(TRANSACTION_TYPES.EXPENSE);
    this.renderAccountSelector(filterActiveAccounts(state?.accounts || []), '');

    if (dialogEl) {
      if (typeof dialogEl.showModal === 'function' && !dialogEl.open) {
        dialogEl.showModal();
      } else {
        dialogEl.setAttribute('open', '');
      }
    }

    if (isPdf) {
      this.setProcessButtonLoadingState(true);
    }
    if (progressBox) progressBox.classList.remove('is-hidden');
    if (progressStatus) {
      progressStatus.textContent = isPdf
        ? SMART_SCAN_ANALYZING_PDF_LABEL
        : LOCAL_OCR_LOADING_STATUS;
    }
    if (progressPct) progressPct.textContent = '10%';
    if (progressBar) progressBar.value = 10;
    if (saveBtn) saveBtn.disabled = true;

    try {
      // Renderizar vista previa inmediata (tanto para imágenes PNG/JPG/WEBP como primera página de PDF en Canvas)
      const thumbPreview = await renderDocumentPreviewThumbnail(file, this.doc, {
        ...extraOptions,
        canvas: previewCanvas,
      });

      // Si es un archivo .pdf vectorial (> 50 caracteres), extraer directamente con extractPdfData omitiendo Tesseract.js
      if (isPdf && !extraOptions.localOcrRunner && !extraOptions.tesseractWorker && !extraOptions.forceGeminiFallback) {
        const pdfExtracted = await extractPdfData(file, {
          ...extraOptions,
          doc: this.doc,
          canvas: previewCanvas,
        });
        if (pdfExtracted.isVectorPdf) {
          const accountNumber = String(
            pdfExtracted.accountNumber || pdfExtracted.cuentaIdentificada || ''
          ).trim();
          const accountMatch = await matchAccountFromWorkspace(
            accountNumber,
            state?.accounts || [],
            {
              firestoreDb: extraOptions.firestoreDb || this.firestoreDb,
              firestoreModule: extraOptions.firestoreModule || this.firestoreModule,
              workspaceId: extraOptions.workspaceId || this.getActiveWorkspaceId(),
            }
          );
          const vectorResult = {
            ...pdfExtracted,
            thumbnailDataUrl:
              pdfExtracted.thumbnailDataUrl || thumbPreview?.thumbnailDataUrl || null,
            originalDataUrl:
              pdfExtracted.originalDataUrl || thumbPreview?.thumbnailDataUrl || null,
            accountMatch,
            accountExists: Boolean(accountMatch.matched),
            accountId: accountMatch.matched ? accountMatch.accountId : '',
            unregisteredAccountNotice:
              accountNumber && !accountMatch.matched
                ? formatUnregisteredAccountNotice(accountNumber, pdfExtracted.bankName)
                : '',
          };
          this.openWithExtractedData(vectorResult);
          if (accountNumber && !accountMatch.matched) {
            this.displayForegroundToast(vectorResult.unregisteredAccountNotice);
          }
          return vectorResult;
        }
      }

      const extracted = await extractSmartScanDocument(
        file,
        state,
        {
          firestoreDb: this.firestoreDb,
          firestoreModule: this.firestoreModule,
          workspaceId: this.getActiveWorkspaceId(),
          storage: this.storage,
          indexedDb: this.indexedDb,
          doc: this.doc,
          canvas: previewCanvas,
          ...extraOptions,
        },
        (status, pct) => {
          if (progressStatus && status) {
            progressStatus.textContent = status;
          }
          if (progressPct && typeof pct === 'number') {
            progressPct.textContent = `${pct}%`;
          }
          if (progressBar && typeof pct === 'number') {
            progressBar.value = pct;
          }
        }
      );

      if (thumbPreview?.thumbnailDataUrl && !extracted.thumbnailDataUrl) {
        extracted.thumbnailDataUrl = thumbPreview.thumbnailDataUrl;
        extracted.originalDataUrl = thumbPreview.thumbnailDataUrl;
      }

      this.openWithExtractedData(extracted);
      return extracted;
    } catch (error) {
      this.showToast(`Aviso al escanear documento: ${error.message}`);
      throw error;
    } finally {
      if (isPdf) {
        this.setProcessButtonLoadingState(false);
      }
      if (progressBox) progressBox.classList.add('is-hidden');
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  /**
   * Procesa el envío del formulario del modal:
   * - Si está en modo "Estado de Cuenta (Múltiples Movimientos)":
   *   Persiste la cuenta nueva (si no existía y fue aceptada) y los movimientos seleccionados
   *   en un `writeBatch`, y ejecuta el aprendizaje adaptativo en `bank_templates`.
   * - Si está en modo comprobante individual:
   *   Si la cuenta no existía, la crea primero en Firestore y luego guarda el movimiento individual.
   *
   * @returns {Promise<object>}
   */
  async handleFormSubmit() {
    const dialogEl = this.doc?.getElementById(SMART_SCAN_MODAL_ID);
    const formEl = this.doc?.getElementById('smart-scan-confirm-form');
    if (!formEl) return { saved: false };

    const moneda =
      this.doc.getElementById('smart-scan-currency-select')?.value || 'HNL';
    const cuentaIdentificada = (
      this.doc.getElementById('smart-scan-identified-account-input')?.value || ''
    ).trim();
    const accountId = this.getAccountSelect()?.value || '';

    // Flujo A: Estado de Cuenta (Múltiples Movimientos)
    if (this.isStatementMode()) {
      const selectedRows = this.getSelectedStatementRows();
      if (selectedRows.length === 0) {
        this.showToast('⚠️ Selecciona al menos un movimiento del Estado de Cuenta.');
        return { saved: false };
      }

      const state = this.getState();
      const batchResult = await confirmAndPersistStatementBatch({
        extractedData: {
          ...(this.currentExtracted || {}),
          moneda,
          cuentaIdentificada,
          accountId,
        },
        statementRows: this.statementRows,
        state,
        createMissingAccount: this.createMissingAccountAccepted || !accountId,
        firestoreDb: this.firestoreDb,
        firestoreModule: this.firestoreModule,
        workspaceId: this.getWorkspaceId(),
        recordTransactionFn: this.recordTransactionFn,
        storage: this.storage,
        indexedDb: this.indexedDb,
      });

      if (dialogEl) {
        this.close();
      }

      this.showToast(
        `📄 ${batchResult.savedTransactions.length} movimiento(s) del Estado de Cuenta guardados correctamente.`
      );

      if (typeof this.onSaved === 'function') {
        this.onSaved(batchResult);
      }

      return batchResult;
    }

    // Flujo B: Comprobante Individual
    const selectedResolutionRadio = formEl.querySelector(
      'input[name="duplicateResolution"]:checked'
    );
    const isDupVisible = !this.doc
      ?.getElementById('smart-scan-duplicate-warning')
      ?.classList.contains('is-hidden');
    const duplicateResolution = isDupVisible
      ? selectedResolutionRadio?.value || DUPLICATE_RESOLUTION_ACTIONS.CREATE_NEW
      : DUPLICATE_RESOLUTION_ACTIONS.CREATE_NEW;

    if (duplicateResolution === DUPLICATE_RESOLUTION_ACTIONS.SKIP) {
      this.close();
      this.showToast('⏭️ Movimiento duplicado omitido.');
      const skipResult = {
        action: DUPLICATE_RESOLUTION_ACTIONS.SKIP,
        saved: false,
        transaction: null,
      };
      if (typeof this.onSaved === 'function') {
        this.onSaved(skipResult);
      }
      return skipResult;
    }

    const tipoDocumento =
      this.getDocTypeSelect()?.value ||
      SMART_SCAN_DOCUMENT_TYPES.INVOICE_RECEIPT;
    const fecha =
      this.doc.getElementById('smart-scan-date-input')?.value ||
      new Date().toISOString().slice(0, 10);
    const comercio = (
      this.doc.getElementById('smart-scan-merchant-input')?.value || 'Comercio'
    ).trim();
    const monto = sanitizeSmartScanAmount(
      this.doc.getElementById('smart-scan-amount-input')?.value || 0
    );
    const categoryId =
      this.doc.getElementById('smart-scan-category-select')?.value || 'groceries';

    if (!accountId && !cuentaIdentificada && !this.createMissingAccountAccepted) {
      this.showToast('⚠️ Selecciona la Cuenta Asociada antes de confirmar.');
      return { saved: false };
    }

    const state = this.getState();
    const result = await confirmAndPersistSmartScanTransaction({
      extractedData: {
        ...(this.currentExtracted || {}),
        fecha,
        comercio,
        monto,
        moneda,
        tipoDocumento,
        tipoTransaccion: getTransactionTypeForDocument(tipoDocumento),
        cuentaIdentificada,
        categoryId,
        accountId,
      },
      state,
      createMissingAccount: this.createMissingAccountAccepted || !accountId,
      duplicateResolution,
      duplicateTx: this.currentExtracted?.duplicateTx || null,
      firestoreDb: this.firestoreDb,
      firestoreModule: this.firestoreModule,
      workspaceId: this.getWorkspaceId(),
      recordTransactionFn: this.recordTransactionFn,
      storage: this.storage,
    });

    if (dialogEl) {
      this.close();
    }

    const actionVerb =
      result.action === DUPLICATE_RESOLUTION_ACTIONS.OVERWRITE
        ? 'actualizado (sobreescrito)'
        : 'registrado';
    this.showToast(
      `📷 ${tipoDocumento} de "${comercio}" ${actionVerb} (${Money.format(result.transaction.amount, result.transaction.currency)})`
    );

    if (typeof this.onSaved === 'function') {
      this.onSaved(result);
    }

    return result;
  }

  close() {
    const dialogEl = this.doc?.getElementById(SMART_SCAN_MODAL_ID);
    if (!dialogEl) return;
    if (typeof dialogEl.close === 'function' && dialogEl.open) {
      dialogEl.close();
    } else {
      dialogEl.removeAttribute('open');
    }
  }
}

