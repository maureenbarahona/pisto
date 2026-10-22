/**
 * @fileoverview Componente Vanilla ESNext `ImportAccountModal` (`src/js/components/ImportAccountModal.js`).
 *
 * Implementa:
 * 1. Garantía del Botón `"Importar Cuenta desde Imagen/PDF"`:
 *    - Escucha directamente el evento `click` en Vanilla JS:
 *      `document.getElementById('btn-import-account')?.addEventListener('click', openImportModal);`
 *      (compatible también con `#btn-import-account-media` y `[data-action="open-import-account-modal"]`).
 *    - Comportamiento idéntico en desarrollo local y en Cloud Run, sin `console.log`.
 * 2. Deduplicación Inteligente de Transacciones (Modal / Banner de Advertencia):
 *    - Consulta las transacciones existentes de la cuenta (`accountId`) antes de guardar.
 *    - Criterio de coincidencia: Misma `accountId` + Misma `date` + Mismo `amount` + Concepto/Comercio similar (`concept`).
 *    - Muestra advertencia clara:
 *      `"⚠️ Posible transacción duplicada detectada (Monto: L X.XX, Fecha: DD/MM/YYYY, Comercio: X)"`
 *    - Ofrece 3 opciones explícitas al usuario:
 *      a) `"✏️ Sobreescribir / Actualizar Transacción Existente"`
 *      b) `"➕ Crear como Nueva Transacción"`
 *      c) `"🚫 Omitir"`
 */

import {
  cleanAmount,
  cleanMobileUiText,
  isMobileUiNoiseLine,
  normalizeScanDateToIso,
  encodeFileToBase64,
  extractAccountFromFile,
  persistImportedAccountAndTransactions,
  saveBatchAccountsToFirestore,
  fetchExistingWorkspaceAccountNumbers,
  formatBatchAccountsToastMessage,
  BATCH_DEMO_PRODUCTS_SUMMARY,
  ExtractedAccountSchema,
  ExtractedBatchAccountsSchema,
  ACCOUNT_EXTRACTOR_SYSTEM_PROMPT,
  EXTRACTED_ACCOUNT_JSON_SCHEMA,
  buildAccountExtractorSystemPrompt,
  learnAdaptiveAccountPattern,
  getLearnedBankPatterns,
  inferAccountsFromUnstructuredText,
  BANK_TEMPLATES_COLLECTION,
  BANK_TEMPLATES_LOCAL_STORE,
  BANK_TEMPLATES_IDB_NAME,
  BANK_TEMPLATES_STORAGE_MIRROR_KEY,
  DEFAULT_BANK_TEMPLATES,
  normalizeTemplateCurrency,
  buildBankTemplateId,
  normalizeBankTemplate,
  openBankTemplatesIndexedDb,
  getLocalBankTemplatesSync,
  saveTemplateToLocalIndexedDb,
  getAllLocalBankTemplates,
  fetchBankTemplatesFromFirestore,
  saveBankTemplate,
  buildFewShotPromptWithTemplates,
  computeLayoutFingerprint,
  matchBankTemplateFromText,
  applyTemplateExtractionRules,
  runLocalOcrEngine,
  extractOfflineWithLearnedTemplates,
  hasUserEditedExtractedAccounts,
  deriveTemplateKeywords,
  learnBankTemplateFromConfirmation,
  GEMINI_VISION_MODEL,
  GEMINI_VISION_FALLBACK_MODEL,
  DEFAULT_OCR_CONFIDENCE_THRESHOLD,
  BANK_PRODUCT_TYPES,
  sanitizeNumericAmount,
  sanitizeNumericAmountString,
  classifyBankProductType,
  HYBRID_ACCOUNT_ITEM_JSON_SCHEMA,
  HYBRID_TRANSACTION_ITEM_JSON_SCHEMA,
  HYBRID_EXTRACTOR_JSON_SCHEMA,
  HYBRID_EXTRACTOR_SYSTEM_PROMPT,
  runTesseractLocalOcr,
  parseMultiProductBankText,
  invokeGemini25FlashFallback,
  extractBankDataHybrid,
} from '../services/accountExtractor.js';
import {
  BatchAccountsModal,
  formatBatchAccountRowSummary,
  renderBatchAccountsRowsMarkup,
} from './BatchAccountsModal.js';
import {
  useAccountAgentADK,
  ADK_INIT_LOG_MESSAGE,
  ADK_DEMO_ACCOUNT_DATA,
} from '../../../public/js/services/agentService.js';
import { formatAccountScanPreviewSummary } from '../../../public/js/services/accountScanService.js';
import { attachDialogLightDismissFallback } from '../../../public/js/ui/keypadModal.js';
import {
  DUPLICATE_TRANSACTION_ACTIONS,
  DUPLICATE_TRANSACTION_OPTION_LABELS,
  formatDuplicateTransactionWarning,
  findAccountDuplicateTransactions,
  checkAccountTransactionDuplicate,
  resolveDuplicateTransactionAction,
} from '../services/firestore.js';
import { HONDURAS_FINANCIAL_ENTITIES } from '../../../public/js/domain/models.js';

export {
  HONDURAS_FINANCIAL_ENTITIES,
  useAccountAgentADK,
  ADK_INIT_LOG_MESSAGE,
  ADK_DEMO_ACCOUNT_DATA,
  DUPLICATE_TRANSACTION_ACTIONS,
  DUPLICATE_TRANSACTION_OPTION_LABELS,
  formatDuplicateTransactionWarning,
  findAccountDuplicateTransactions,
  checkAccountTransactionDuplicate,
  resolveDuplicateTransactionAction,
  extractAccountFromFile,
  persistImportedAccountAndTransactions,
  saveBatchAccountsToFirestore,
  fetchExistingWorkspaceAccountNumbers,
  formatBatchAccountsToastMessage,
  BATCH_DEMO_PRODUCTS_SUMMARY,
  ExtractedBatchAccountsSchema,
  ACCOUNT_EXTRACTOR_SYSTEM_PROMPT,
  EXTRACTED_ACCOUNT_JSON_SCHEMA,
  buildAccountExtractorSystemPrompt,
  learnAdaptiveAccountPattern,
  getLearnedBankPatterns,
  inferAccountsFromUnstructuredText,
  BANK_TEMPLATES_COLLECTION,
  BANK_TEMPLATES_LOCAL_STORE,
  BANK_TEMPLATES_IDB_NAME,
  BANK_TEMPLATES_STORAGE_MIRROR_KEY,
  DEFAULT_BANK_TEMPLATES,
  normalizeTemplateCurrency,
  buildBankTemplateId,
  normalizeBankTemplate,
  openBankTemplatesIndexedDb,
  getLocalBankTemplatesSync,
  saveTemplateToLocalIndexedDb,
  getAllLocalBankTemplates,
  fetchBankTemplatesFromFirestore,
  saveBankTemplate,
  buildFewShotPromptWithTemplates,
  computeLayoutFingerprint,
  matchBankTemplateFromText,
  applyTemplateExtractionRules,
  runLocalOcrEngine,
  extractOfflineWithLearnedTemplates,
  hasUserEditedExtractedAccounts,
  deriveTemplateKeywords,
  learnBankTemplateFromConfirmation,
  GEMINI_VISION_MODEL,
  GEMINI_VISION_FALLBACK_MODEL,
  DEFAULT_OCR_CONFIDENCE_THRESHOLD,
  BANK_PRODUCT_TYPES,
  sanitizeNumericAmount,
  sanitizeNumericAmountString,
  classifyBankProductType,
  HYBRID_ACCOUNT_ITEM_JSON_SCHEMA,
  HYBRID_TRANSACTION_ITEM_JSON_SCHEMA,
  HYBRID_EXTRACTOR_JSON_SCHEMA,
  HYBRID_EXTRACTOR_SYSTEM_PROMPT,
  runTesseractLocalOcr,
  parseMultiProductBankText,
  invokeGemini25FlashFallback,
  extractBankDataHybrid,
  BatchAccountsModal,
  formatBatchAccountRowSummary,
  renderBatchAccountsRowsMarkup,
};

export const HONDURAS_BANK_CATALOG_GROUPS = Object.freeze([
  Object.freeze({
    label: 'Bancos de Honduras (CNBS)',
    options: Object.freeze([
      'Banco Atlántida',
      'BAC Credomatic',
      'BAC Credomatic Honduras',
      'Banco Ficohsa',
      'Banpaís (Banco del País)',
      'Banco de Occidente',
      'Banco Davivienda Honduras',
      'Davivienda',
      'Banco Lafise Honduras',
      'Banco Promerica',
      'Banco Promerica Honduras',
      'Promerica',
      'Ficensa (Banco Financiera Comercial Hondureña)',
      'Banco Azteca Honduras',
      'Banrural Honduras',
      'Banco Popular',
      'Banco Hondureño del Café (Banhcafé)',
      'Banco de los Trabajadores (Bantrab)',
      'Banhprovi (Banco Hondureño para la Producción y la Vivienda)',
      'Banadesa (Banco Nacional de Desarrollo Agrícola)',
    ]),
  }),
  Object.freeze({
    label: 'Cooperativas de Ahorro y Crédito de Honduras (CONSUCOOP)',
    options: HONDURAS_FINANCIAL_ENTITIES.cooperativas,
  }),
  Object.freeze({
    label: 'Financieras y Billeteras Digitales (Honduras)',
    options: HONDURAS_FINANCIAL_ENTITIES.financierasYBilleteras,
  }),
]);

export const HONDURAS_BANKS_LIST = Object.freeze([
  ...new Set([
    ...HONDURAS_BANK_CATALOG_GROUPS.flatMap((group) => group.options),
    ...HONDURAS_FINANCIAL_ENTITIES.bancos,
    ...HONDURAS_FINANCIAL_ENTITIES.cooperativas,
    ...HONDURAS_FINANCIAL_ENTITIES.financierasYBilleteras,
    '— Ninguna / Efectivo / Otra —',
    'Otro / Personalizado',
  ]),
]);

const BANK_UI_GARBAGE_REGEX =
  /[©®™=<>|_~^•*«»]|--|\b\d{1,2}:\d{2}\b|\b(?:4G|5G|LTE|WIFI|VOLTE)\b|\bdetalle\s+de\s+cuenta\b|\bbal\s*all\b|\bsaldo\s+disponible\b|\bconsulta\s+de\b/i;

/**
 * Resuelve la opción del catálogo completo de Entidades Bancarias de Honduras que corresponde
 * al banco detectado por la IA o seleccionado por el usuario.
 * @param {string} rawBank
 * @returns {string}
 */
export function resolveHondurasCatalogBankOption(rawBank) {
  const trimmed = String(rawBank ?? '').trim();
  if (!trimmed) return HONDURAS_BANKS_LIST[0];

  const exactMatch = HONDURAS_BANKS_LIST.find(
    (b) => b.toLowerCase() === trimmed.toLowerCase()
  );
  if (exactMatch) return exactMatch;

  const lower = trimmed.toLowerCase();
  if (lower.includes('atlantida') || lower.includes('atlántida')) return 'Banco Atlántida';
  if (/\bbac\b/.test(lower) || lower.includes('credomatic')) {
    return /honduras/i.test(trimmed) ? 'BAC Credomatic Honduras' : 'BAC Credomatic';
  }
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
  if (lower.includes('davivienda')) {
    return /banco\s+davivienda/i.test(trimmed) ? 'Banco Davivienda Honduras' : 'Davivienda';
  }
  if (lower.includes('lafise')) return 'Banco Lafise Honduras';
  if (lower.includes('promerica')) {
    if (/honduras/i.test(trimmed)) return 'Banco Promerica Honduras';
    return /banco\s+promerica/i.test(trimmed) ? 'Banco Promerica' : 'Promerica';
  }
  if (lower.includes('ficensa')) return 'Ficensa (Banco Financiera Comercial Hondureña)';
  if (lower.includes('azteca')) return 'Banco Azteca Honduras';
  if (lower.includes('banrural')) return 'Banrural Honduras';
  if (lower.includes('popular')) return 'Banco Popular';
  if (lower.includes('banhcafe') || lower.includes('banhcafé')) {
    return 'Banco Hondureño del Café (Banhcafé)';
  }
  if (lower.includes('bantrab') || lower.includes('trabajadores')) {
    return 'Banco de los Trabajadores (Bantrab)';
  }
  if (lower.includes('banhprovi')) {
    return 'Banhprovi (Banco Hondureño para la Producción y la Vivienda)';
  }
  if (lower.includes('banadesa')) {
    return 'Banadesa (Banco Nacional de Desarrollo Agrícola)';
  }

  const partialCatalogMatch = HONDURAS_BANKS_LIST.find(
    (b) =>
      b !== 'Otro / Personalizado' &&
      b !== '— Ninguna / Efectivo / Otra —' &&
      b.toLowerCase().includes(lower)
  );
  if (partialCatalogMatch) return partialCatalogMatch;

  return trimmed;
}

export function cleanBankName(rawText, contextHint = '') {
  const raw = String(rawText ?? '').trim();
  const hint = String(contextHint ?? '').trim();

  // 1. Si el valor es una opción del catálogo de Entidades Bancarias de Honduras o fue elegido explícitamente, conservarlo sin que `contextHint` lo bloquee
  if (raw && !/\r?\n/.test(raw) && !BANK_UI_GARBAGE_REGEX.test(raw) && !isMobileUiNoiseLine(raw)) {
    const exactInCatalog = HONDURAS_BANKS_LIST.find(
      (b) =>
        b !== 'Otro / Personalizado' &&
        b.toLowerCase() === raw.toLowerCase()
    );
    if (exactInCatalog) {
      return exactInCatalog;
    }

    const localTemplates = getLocalBankTemplatesSync();
    for (const tpl of localTemplates) {
      if (tpl.bankName && raw.toLowerCase() === tpl.bankName.toLowerCase()) {
        return tpl.bankName;
      }
    }

    if (
      raw !== hint &&
      raw.toLowerCase() !== 'banco general' &&
      /\b(?:banco|cooperativa|financiera|billetera|credomatic|banpa[ií]s|ficohsa|davivienda|promerica|lafise|banrural|banhcaf[eé]|banhprovi|banadesa|bantrab|ficensa|azteca|popular|odef|tigo\s+money|tengo|dilo|kash)\b/i.test(
        raw
      )
    ) {
      return raw.replace(/\s+/g, ' ').trim();
    }
  }

  const combined = `${raw} ${hint}`.toLowerCase();

  if (combined.includes('atlantida') || combined.includes('atlántida')) {
    return 'Banco Atlántida';
  }
  if (/\bbac\b/.test(combined) || combined.includes('credomatic')) {
    return 'BAC Credomatic';
  }
  if (combined.includes('ficohsa')) {
    return 'Banco Ficohsa';
  }
  if (
    combined.includes('banpais') ||
    combined.includes('banpaís') ||
    combined.includes('banco del pais') ||
    combined.includes('banco del país')
  ) {
    return 'Banpaís (Banco del País)';
  }
  if (combined.includes('occidente')) {
    return 'Banco de Occidente';
  }
  if (combined.includes('davivienda')) {
    return 'Davivienda';
  }
  if (combined.includes('promerica')) {
    return /banco\s+promerica/i.test(`${raw} ${hint}`) ? 'Banco Promerica' : 'Promerica';
  }

  if (/\bsos\b/i.test(combined) || /\bcuenta\s+de\s+ahorro\s+sos\b/i.test(combined)) {
    return 'Banco Atlántida';
  }

  const learnedPatterns = getLearnedBankPatterns();
  for (const learned of learnedPatterns) {
    if (learned?.bankName && combined.includes(learned.bankName.toLowerCase())) {
      return learned.bankName;
    }
  }

  const hasUiGarbage =
    !raw ||
    raw.toLowerCase() === 'banco general' ||
    BANK_UI_GARBAGE_REGEX.test(raw) ||
    isMobileUiNoiseLine(raw);

  if (hasUiGarbage) {
    if (/\b(?:ahorro|sos)\b/i.test(combined)) {
      return 'Banco Atlántida';
    }
    return HONDURAS_BANKS_LIST[0];
  }

  const stripped = raw
    .replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9().\-\s/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const alphaCount = (stripped.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g) || []).length;
  if (alphaCount < 3 || BANK_UI_GARBAGE_REGEX.test(stripped)) {
    return HONDURAS_BANKS_LIST[0];
  }

  return stripped;
}

export function cleanAccountType(rawAccountType) {
  const cleaned = cleanMobileUiText(String(rawAccountType ?? ''))
    .replace(/[©®™=<>|_~^•*«»]|--|\b\d{1,2}:\d{2}\b|\bdetalle\s+de\s+cuenta\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned.length < 3) {
    return 'Cuenta de Ahorro';
  }
  return cleaned;
}

function escapeHtmlAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Renderiza SIEMPRE el catálogo completo de bancos y entidades financieras de Honduras
 * (idéntico a "Entidad Bancaria" en el modal "Modificar Cuenta o Meta"), marcando como
 * `selected` el banco detectado por la IA o elegido por el usuario.
 *
 * @param {string} [selectedBank='']
 * @returns {string}
 */
export function renderBankSelectOptionsMarkup(selectedBank = '') {
  const rawTarget = String(selectedBank ?? '').trim();
  const resolvedTarget = rawTarget
    ? resolveHondurasCatalogBankOption(rawTarget)
    : HONDURAS_BANKS_LIST[0];

  const allCatalogItems = HONDURAS_BANK_CATALOG_GROUPS.flatMap((g) => g.options);
  const isInStandardGroups = allCatalogItems.some(
    (opt) => opt.toLowerCase() === resolvedTarget.toLowerCase()
  );
  const isSpecialOption =
    resolvedTarget === '— Ninguna / Efectivo / Otra —' ||
    resolvedTarget === 'Otro / Personalizado';

  const customOptionHtml =
    resolvedTarget && !isInStandardGroups && !isSpecialOption
      ? `<optgroup label="Banco Detectado / Personalizado"><option value="${escapeHtmlAttr(resolvedTarget)}" selected>${escapeHtmlAttr(resolvedTarget)}</option></optgroup>`
      : '';

  const groupsHtml = HONDURAS_BANK_CATALOG_GROUPS.map((group) => {
    const optionsHtml = group.options
      .map((bank) => {
        const isSelected =
          (isInStandardGroups && bank.toLowerCase() === resolvedTarget.toLowerCase()) ||
          (!rawTarget && bank === HONDURAS_BANKS_LIST[0]);
        return `<option value="${escapeHtmlAttr(bank)}"${isSelected ? ' selected' : ''}>${escapeHtmlAttr(bank)}</option>`;
      })
      .join('');
    return `<optgroup label="${escapeHtmlAttr(group.label)}">${optionsHtml}</optgroup>`;
  }).join('');

  const noneSelected = resolvedTarget === '— Ninguna / Efectivo / Otra —';
  const customSelected = resolvedTarget === 'Otro / Personalizado';

  return [
    `<option value="— Ninguna / Efectivo / Otra —"${noneSelected ? ' selected' : ''}>— Ninguna / Efectivo / Otra —</option>`,
    customOptionHtml,
    groupsHtml,
    `<option value="Otro / Personalizado"${customSelected ? ' selected' : ''}>Otro / Personalizado</option>`,
  ].join('');
}

let sharedImportModalInstance = null;

/**
 * Handler directo para abrir el modal de importación desde el botón `#btn-import-account`
 * o `#btn-import-account-media` en la vista de Cuentas.
 * @param {Event} [event]
 */
export function openImportModal(event) {
  if (event && typeof event.preventDefault === 'function') {
    event.preventDefault();
  }
  if (event && typeof event.stopPropagation === 'function') {
    event.stopPropagation();
  }
  if (globalThis.__PISTO_ACCOUNTS_VIEW_INSTANCE__) {
    globalThis.__PISTO_ACCOUNTS_VIEW_INSTANCE__.setIsImportAccountModalOpen(true);
    return;
  }
  if (!sharedImportModalInstance) {
    sharedImportModalInstance = new ImportAccountModal();
    sharedImportModalInstance.init();
  }
  sharedImportModalInstance.setIsImportAccountModalOpen(true);
}

/**
 * Vincula explícitamente el botón `#btn-import-account` (y `#btn-import-account-media`)
 * usando Vanilla JS `addEventListener('click', openImportModal)`.
 */
export function bindImportAccountTriggerButtons(customHandler = openImportModal) {
  if (typeof document === 'undefined') return null;

  document.getElementById('btn-import-account')?.addEventListener('click', customHandler);
  document.getElementById('btn-import-account-media')?.addEventListener('click', customHandler);

  const buttons = document.querySelectorAll(
    '#btn-import-account, #btn-import-account-media, [data-action="open-import-account-modal"]'
  );
  buttons.forEach((btn) => {
    btn.type = 'button';
    btn.disabled = false;
    btn.removeAttribute('disabled');
    btn.classList.remove('pointer-events-none', 'select-none', 'is-disabled');
    btn.style.pointerEvents = 'auto';
    btn.style.userSelect = 'auto';
    btn.style.cursor = 'pointer';
    btn.style.position = 'relative';
    btn.style.zIndex = '10';

    let parentEl = btn.parentElement;
    while (parentEl && parentEl !== document.body) {
      parentEl.classList.remove('pointer-events-none', 'select-none', 'is-disabled');
      if (parentEl.style?.pointerEvents === 'none') {
        parentEl.style.pointerEvents = 'auto';
      }
      parentEl = parentEl.parentElement;
    }

    btn.onclick = (e) => {
      customHandler(e);
    };
  });

  return document.getElementById('btn-import-account') || document.getElementById('btn-import-account-media');
}

/**
 * Abre un modal de advertencia interactivo cuando se detecta una posible transacción duplicada
 * al registrar o importar una transacción y devuelve la opción seleccionada por el usuario:
 * - `'overwrite'` (`"✏️ Sobreescribir / Actualizar Transacción Existente"`)
 * - `'create_new'` (`"➕ Crear como Nueva Transacción"`)
 * - `'skip'` (`"🚫 Omitir"`)
 *
 * @param {object} candidateTx
 * @param {object} duplicateTx
 * @returns {Promise<'overwrite'|'create_new'|'skip'>}
 */
export function promptDuplicateTransactionModal(candidateTx, duplicateTx) {
  const warningText = formatDuplicateTransactionWarning({
    amount: candidateTx?.amount,
    currency: candidateTx?.currency || duplicateTx?.currency || 'HNL',
    date: candidateTx?.date,
    concept: candidateTx?.concept || candidateTx?.note || duplicateTx?.note || 'Comercio',
  });

  if (typeof document === 'undefined') {
    return Promise.resolve(DUPLICATE_TRANSACTION_ACTIONS.OVERWRITE);
  }

  let dialog = document.getElementById('duplicate-tx-warning-dialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'duplicate-tx-warning-dialog';
    dialog.className = 'modal-dialog';
    dialog.setAttribute('closedby', 'any');
    dialog.setAttribute('aria-labelledby', 'duplicate-tx-warning-title');
    dialog.innerHTML = `
      <div class="modal-header">
        <div>
          <h2 id="duplicate-tx-warning-title">⚠️ Transacción Duplicada Detectada</h2>
          <p style="font-size: 0.85rem; color: var(--text-secondary); margin: 0.15rem 0 0 0;">
            Se encontró un movimiento coincidente en esta misma cuenta bancaria.
          </p>
        </div>
      </div>
      <div class="modal-body" style="display: flex; flex-direction: column; gap: 1rem;">
        <div
          id="duplicate-tx-warning-banner"
          class="duplicate-tx-warning-banner"
          role="alert"
        ></div>
        <div style="display: flex; flex-direction: column; gap: 0.6rem;">
          <button
            type="button"
            id="btn-dup-tx-overwrite"
            class="btn-primary"
            data-dup-action="${DUPLICATE_TRANSACTION_ACTIONS.OVERWRITE}"
          >${DUPLICATE_TRANSACTION_OPTION_LABELS.OVERWRITE}</button>
          <button
            type="button"
            id="btn-dup-tx-create-new"
            class="btn-secondary"
            data-dup-action="${DUPLICATE_TRANSACTION_ACTIONS.CREATE_NEW}"
          >${DUPLICATE_TRANSACTION_OPTION_LABELS.CREATE_NEW}</button>
          <button
            type="button"
            id="btn-dup-tx-skip"
            class="btn-secondary"
            data-dup-action="${DUPLICATE_TRANSACTION_ACTIONS.SKIP}"
          >${DUPLICATE_TRANSACTION_OPTION_LABELS.SKIP}</button>
        </div>
      </div>
    `;
    document.body.appendChild(dialog);
    attachDialogLightDismissFallback(dialog);
  }

  const bannerEl = document.getElementById('duplicate-tx-warning-banner');
  if (bannerEl) {
    bannerEl.textContent = warningText;
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (choice) => {
      if (settled) return;
      settled = true;
      if (dialog.open && typeof dialog.close === 'function') {
        try {
          dialog.close();
        } catch {
          dialog.removeAttribute('open');
        }
      } else {
        dialog.removeAttribute('open');
      }
      resolve(choice);
    };

    const overwriteBtn = document.getElementById('btn-dup-tx-overwrite');
    const createNewBtn = document.getElementById('btn-dup-tx-create-new');
    const skipBtn = document.getElementById('btn-dup-tx-skip');

    if (overwriteBtn) {
      overwriteBtn.onclick = () => finish(DUPLICATE_TRANSACTION_ACTIONS.OVERWRITE);
    }
    if (createNewBtn) {
      createNewBtn.onclick = () => finish(DUPLICATE_TRANSACTION_ACTIONS.CREATE_NEW);
    }
    if (skipBtn) {
      skipBtn.onclick = () => finish(DUPLICATE_TRANSACTION_ACTIONS.SKIP);
    }
    dialog.onclose = () => finish(DUPLICATE_TRANSACTION_ACTIONS.SKIP);

    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') {
        try {
          dialog.showModal();
        } catch {
          dialog.setAttribute('open', '');
        }
      } else {
        dialog.setAttribute('open', '');
      }
    }
  });
}

export class ImportAccountModal {
  constructor(options = {}) {
    this.options = options;
    this.currentExtracted = null;
    this.initialExtractedSnapshot = null;
    this.learnFormatEnabled = true;
    this.lastLearnedTemplate = null;
    this.isImportAccountModalOpen = false;
    this.isProcessing = false;
    this.matchedExistingAccount = null;
    this.lastOcrTextFallback = '';
    this.agentADK = useAccountAgentADK({
      notifyToast: (msg) => this.options.showToast?.(msg),
    });
    this.batchAccountsModal = new BatchAccountsModal({
      getState: () => this.options.getState?.() || globalThis.pistoApp?.state || null,
      showToast: (msg) => this.options.showToast?.(msg),
      onAccountsBatchSaved: (result) => {
        this.setIsImportAccountModalOpen(false);
        this.options.onAccountCreated?.(
          result?.createdAccounts?.[0] || null,
          [],
          result
        );
      },
    });
  }

  get accountsList() {
    if (Array.isArray(this.currentExtracted?.accountsList)) {
      return this.currentExtracted.accountsList;
    }
    return Array.isArray(this.currentExtracted?.accounts)
      ? this.currentExtracted.accounts
      : [];
  }

  get accounts() {
    return this.accountsList;
  }

  get transactionsList() {
    if (Array.isArray(this.currentExtracted?.transactionsList)) {
      return this.currentExtracted.transactionsList;
    }
    return Array.isArray(this.currentExtracted?.detectedTransactions)
      ? this.currentExtracted.detectedTransactions
      : [];
  }

  init() {
    this.ensureModalDom();
    this.bindTriggerButtons();
    this.bindDialogInternalEvents();
  }

  handleSelectImageOrPdfClick(event) {
    if (event && typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
    if (event && typeof event.stopPropagation === 'function') {
      event.stopPropagation();
    }
    if (typeof document === 'undefined') return null;

    this.ensureModalDom();
    const fileInput = document.getElementById('import-account-file-input');
    if (!fileInput) return null;

    fileInput.disabled = false;
    fileInput.removeAttribute('disabled');
    try {
      fileInput.value = '';
    } catch {
      // ignore read-only value in synthetic tests
    }
    if (typeof fileInput.click === 'function') {
      fileInput.click();
    }
    return fileInput;
  }

  bindDialogInternalEvents() {
    if (typeof document === 'undefined') return;
    const dialog = document.getElementById('import-account-dialog');
    if (!dialog) return;

    this.populateBankOptions();

    const fileInput = document.getElementById('import-account-file-input');
    const triggerBtn = document.getElementById('btn-trigger-import-account-file');

    if (triggerBtn && triggerBtn.dataset.boundTriggerFile !== 'true') {
      triggerBtn.dataset.boundTriggerFile = 'true';
      triggerBtn.type = 'button';
      triggerBtn.disabled = false;
      triggerBtn.removeAttribute('disabled');
      triggerBtn.addEventListener('click', (e) => {
        this.handleSelectImageOrPdfClick(e);
      });
    }

    if (fileInput && fileInput.dataset.boundFileInput !== 'true') {
      fileInput.dataset.boundFileInput = 'true';
      fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        if (file) {
          this.handleFileSelected(file);
        }
        try {
          fileInput.value = '';
        } catch {
          // ignore
        }
      });
    }

    if (dialog.dataset.boundImportModal === 'true') return;
    dialog.dataset.boundImportModal = 'true';

    attachDialogLightDismissFallback(dialog);
    dialog.addEventListener('close', () => {
      const wasOpen = this.isImportAccountModalOpen;
      this.isImportAccountModalOpen = false;
      globalThis.__PISTO_IMPORT_ACCOUNT_MODAL_OPEN__ = false;
      if (wasOpen) {
        this.options.onClose?.();
      }
    });

    const dropzone = document.getElementById('import-account-dropzone');
    const demoAdkBtn = document.getElementById('btn-import-account-demo-adk');
    const confirmBtn = document.getElementById('btn-confirm-import-account');
    const cancelBtn = document.getElementById('btn-cancel-import-account');
    const closeBtn = document.getElementById('btn-close-import-account');
    const selectAllAccountsCheckbox = document.getElementById('import-account-select-all-accounts');
    const addAccountRowBtn = document.getElementById('btn-import-account-add-acc');
    const accountsTbody = document.getElementById('import-account-accounts-tbody');
    const selectAllCheckbox = document.getElementById('import-account-select-all-tx');
    const addTxRowBtn = document.getElementById('btn-import-account-add-tx');
    const tbody = document.getElementById('import-account-tx-tbody');

    const bankSelect = document.getElementById('import-acc-bank-select');
    const bankInput = document.getElementById('import-acc-bank-input');

    demoAdkBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.handleLoadDemoADK();
    });

    dropzone?.addEventListener('click', (e) => {
      if (
        e.target?.closest?.('#btn-trigger-import-account-file') ||
        e.target?.closest?.('#btn-import-account-demo-adk')
      ) {
        return;
      }
      this.handleSelectImageOrPdfClick(e);
    });

    dropzone?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput?.click();
      }
    });

    dropzone?.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('is-dragover');
    });

    dropzone?.addEventListener('dragleave', () => {
      dropzone.classList.remove('is-dragover');
    });

    dropzone?.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('is-dragover');
      const file = e.dataTransfer?.files?.[0];
      if (file) {
        this.handleFileSelected(file);
      }
    });

    bankSelect?.addEventListener('change', () => {
      const selectedVal = bankSelect.value;
      const customWrapper = document.getElementById('import-acc-bank-custom-wrapper');
      if (selectedVal === 'Otro / Personalizado') {
        customWrapper?.classList.remove('is-hidden');
        if (bankInput) {
          if (HONDURAS_BANKS_LIST.includes(bankInput.value)) {
            bankInput.value = '';
          }
          bankInput.focus();
        }
      } else if (bankInput) {
        bankInput.value = selectedVal;
      }
      if (this.currentExtracted) {
        const nextBank =
          selectedVal && selectedVal !== 'Otro / Personalizado'
            ? cleanBankName(selectedVal)
            : this.readEditedBankName();
        const prevPrimaryBank = this.currentExtracted.bankName;
        this.currentExtracted.bankName = nextBank;
        if (Array.isArray(this.currentExtracted.accounts)) {
          this.currentExtracted.accounts.forEach((acc, idx) => {
            if (idx === 0 || !acc.bankName || acc.bankName === prevPrimaryBank) {
              acc.bankName = nextBank;
            }
          });
          this.renderAccountsListTable();
        }
      }
      this.syncSummaryBanner();
    });

    bankInput?.addEventListener('input', () => {
      const typed = bankInput.value.trim();
      if (bankSelect) {
        const matchedOption = HONDURAS_BANKS_LIST.find(
          (b) => b !== 'Otro / Personalizado' && b.toLowerCase() === typed.toLowerCase()
        );
        if (matchedOption) {
          bankSelect.value = matchedOption;
        }
      }
      if (this.currentExtracted) {
        const nextBank = typed || HONDURAS_BANKS_LIST[0];
        this.currentExtracted.bankName = nextBank;
        if (this.currentExtracted.accounts?.[0]) {
          this.currentExtracted.accounts[0].bankName = nextBank;
          this.renderAccountsListTable();
        }
      }
      this.syncSummaryBanner();
    });

    selectAllAccountsCheckbox?.addEventListener('change', () => {
      if (!this.currentExtracted) return;
      this.syncAccountsFromDom();
      this.toggleSelectAllAccounts(Boolean(selectAllAccountsCheckbox.checked));
    });

    addAccountRowBtn?.addEventListener('click', () => {
      this.addAccountRow();
    });

    const learnFormatCheckbox = document.getElementById('import-account-learn-format-checkbox');
    learnFormatCheckbox?.addEventListener('change', () => {
      this.learnFormatEnabled = Boolean(learnFormatCheckbox.checked);
    });

    const handleAccountRowMutation = (e) => {
      const target = e.target;
      if (!target || !this.currentExtracted) return;

      if (target.hasAttribute?.('data-import-acc-select')) {
        const idx = Number.parseInt(target.getAttribute('data-import-acc-select') || '-1', 10);
        this.updateAccountAtIndex(idx, 'selected', Boolean(target.checked));
        return;
      }

      if (target.hasAttribute?.('data-import-acc-bank')) {
        const idx = Number.parseInt(target.getAttribute('data-import-acc-bank') || '-1', 10);
        this.updateAccountAtIndex(idx, 'bankName', target.value);
        return;
      }

      if (target.hasAttribute?.('data-import-acc-type')) {
        const idx = Number.parseInt(target.getAttribute('data-import-acc-type') || '-1', 10);
        this.updateAccountAtIndex(idx, 'accountType', target.value);
        return;
      }

      if (target.hasAttribute?.('data-import-acc-number')) {
        const idx = Number.parseInt(target.getAttribute('data-import-acc-number') || '-1', 10);
        this.updateAccountAtIndex(idx, 'accountNumber', target.value);
        return;
      }

      if (target.hasAttribute?.('data-import-acc-currency')) {
        const idx = Number.parseInt(target.getAttribute('data-import-acc-currency') || '-1', 10);
        this.updateAccountAtIndex(idx, 'currency', target.value);
        return;
      }

      if (target.hasAttribute?.('data-import-acc-balance')) {
        const idx = Number.parseInt(target.getAttribute('data-import-acc-balance') || '-1', 10);
        this.updateAccountAtIndex(idx, 'currentBalance', target.value);
        return;
      }

      if (target.hasAttribute?.('data-import-acc-card')) {
        const idx = Number.parseInt(target.getAttribute('data-import-acc-card') || '-1', 10);
        this.updateAccountAtIndex(idx, 'isCreditCard', target.value === 'true');
      }
    };

    accountsTbody?.addEventListener('input', handleAccountRowMutation);
    accountsTbody?.addEventListener('change', handleAccountRowMutation);
    accountsTbody?.addEventListener('click', (e) => {
      const removeBtn = e.target?.closest?.('[data-import-acc-remove]');
      if (!removeBtn) return;
      e.preventDefault();
      const idx = Number.parseInt(removeBtn.getAttribute('data-import-acc-remove') || '-1', 10);
      if (idx >= 0) {
        this.removeAccountAtIndex(idx);
      }
    });

    selectAllCheckbox?.addEventListener('change', () => {
      if (!this.currentExtracted) return;
      this.syncTransactionsFromDom();
      const checked = Boolean(selectAllCheckbox.checked);
      this.currentExtracted.detectedTransactions.forEach((tx) => {
        tx.selected = checked;
      });
      this.renderTransactionsTable();
      this.syncSummaryBanner();
    });

    addTxRowBtn?.addEventListener('click', () => {
      if (!this.currentExtracted) return;
      this.syncTransactionsFromDom();
      const todayIso = new Date().toISOString().slice(0, 10);
      this.currentExtracted.detectedTransactions.push({
        id: `imp_tx_manual_${Date.now().toString(36)}`,
        date: todayIso,
        concept: 'Nuevo movimiento',
        type: 'expense',
        amount: 100,
        selected: true,
      });
      this.reconcileAccountAndTransactionDuplicates();
      this.renderTransactionsTable();
      this.syncSelectAllCheckboxState();
      this.syncSummaryBanner();
    });

    const handleTableFieldMutation = (e) => {
      const target = e.target;
      if (!target || !this.currentExtracted) return;

      if (target.hasAttribute?.('data-import-tx-index')) {
        const idx = Number.parseInt(target.getAttribute('data-import-tx-index') || '-1', 10);
        if (idx >= 0 && idx < this.currentExtracted.detectedTransactions.length) {
          this.currentExtracted.detectedTransactions[idx].selected = Boolean(target.checked);
          this.syncSelectAllCheckboxState();
          this.syncSummaryBanner();
        }
        return;
      }

      if (target.hasAttribute?.('data-import-tx-dup-action')) {
        const idx = Number.parseInt(target.getAttribute('data-import-tx-dup-action') || '-1', 10);
        if (idx >= 0 && idx < this.currentExtracted.detectedTransactions.length) {
          const actionVal = target.value;
          this.currentExtracted.detectedTransactions[idx].duplicateAction = actionVal;
          this.currentExtracted.detectedTransactions[idx].selected =
            actionVal !== DUPLICATE_TRANSACTION_ACTIONS.SKIP;
          this.renderTransactionsTable();
          this.syncSelectAllCheckboxState();
          this.syncSummaryBanner();
        }
        return;
      }

      if (target.hasAttribute?.('data-import-tx-date')) {
        const idx = Number.parseInt(target.getAttribute('data-import-tx-date') || '-1', 10);
        if (idx >= 0 && idx < this.currentExtracted.detectedTransactions.length) {
          this.currentExtracted.detectedTransactions[idx].date = normalizeScanDateToIso(target.value);
          this.reconcileAccountAndTransactionDuplicates();
          this.syncSummaryBanner();
        }
        return;
      }

      if (target.hasAttribute?.('data-import-tx-concept')) {
        const idx = Number.parseInt(target.getAttribute('data-import-tx-concept') || '-1', 10);
        if (idx >= 0 && idx < this.currentExtracted.detectedTransactions.length) {
          this.currentExtracted.detectedTransactions[idx].concept = target.value;
          this.reconcileAccountAndTransactionDuplicates();
          this.syncSummaryBanner();
        }
        return;
      }

      if (target.hasAttribute?.('data-import-tx-type')) {
        const idx = Number.parseInt(target.getAttribute('data-import-tx-type') || '-1', 10);
        if (idx >= 0 && idx < this.currentExtracted.detectedTransactions.length) {
          this.currentExtracted.detectedTransactions[idx].type =
            target.value === 'income' ? 'income' : 'expense';
          this.syncSummaryBanner();
        }
        return;
      }

      if (target.hasAttribute?.('data-import-tx-amount')) {
        const idx = Number.parseInt(target.getAttribute('data-import-tx-amount') || '-1', 10);
        if (idx >= 0 && idx < this.currentExtracted.detectedTransactions.length) {
          this.currentExtracted.detectedTransactions[idx].amount = Math.abs(cleanAmount(target.value));
          this.reconcileAccountAndTransactionDuplicates();
          this.syncSummaryBanner();
        }
      }
    };

    tbody?.addEventListener('input', handleTableFieldMutation);
    tbody?.addEventListener('change', handleTableFieldMutation);

    const editableFieldIds = [
      'import-acc-type-input',
      'import-acc-number-input',
      'import-acc-currency-select',
      'import-acc-balance-input',
    ];
    for (const id of editableFieldIds) {
      document.getElementById(id)?.addEventListener('input', () => {
        this.syncFirstAccountFromPrimaryInputs();
        if (id === 'import-acc-number-input') {
          this.reconcileAccountAndTransactionDuplicates();
        }
        this.renderAccountsListTable();
        this.syncSummaryBanner();
      });
      document.getElementById(id)?.addEventListener('change', () => {
        this.syncFirstAccountFromPrimaryInputs();
        if (id === 'import-acc-currency-select' || id === 'import-acc-number-input') {
          this.syncTransactionsFromDom();
          this.reconcileAccountAndTransactionDuplicates();
          this.renderTransactionsTable();
        }
        this.renderAccountsListTable();
        this.syncSummaryBanner();
      });
    }

    confirmBtn?.addEventListener('click', () => this.handleConfirmCreate());
    cancelBtn?.addEventListener('click', () => this.setIsImportAccountModalOpen(false));
    closeBtn?.addEventListener('click', () => this.setIsImportAccountModalOpen(false));
  }

  bindTriggerButtons() {
    bindImportAccountTriggerButtons((e) => {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      this.setIsImportAccountModalOpen(true);
    });
  }

  setIsImportAccountModalOpen(isOpen) {
    const nextState = Boolean(isOpen);
    const prevState = this.isImportAccountModalOpen;
    this.isImportAccountModalOpen = nextState;
    globalThis.__PISTO_IMPORT_ACCOUNT_MODAL_OPEN__ = nextState;

    if (typeof document === 'undefined') {
      if (nextState) {
        this.agentADK.initializeModal(this.options.showToast);
      } else if (prevState) {
        this.options.onClose?.();
      }
      return;
    }

    this.ensureModalDom();
    this.bindDialogInternalEvents();
    const dialog = document.getElementById('import-account-dialog');
    if (nextState) {
      this.agentADK.initializeModal(this.options.showToast);
      this.resetView();
      if (dialog) {
        dialog.classList.remove('is-hidden');
        if (!dialog.open) {
          if (typeof dialog.showModal === 'function') {
            try {
              dialog.showModal();
            } catch {
              dialog.setAttribute('open', '');
            }
          } else {
            dialog.setAttribute('open', '');
          }
        }
      }
    } else {
      if (dialog) {
        if (dialog.open && typeof dialog.close === 'function') {
          try {
            dialog.close();
          } catch {
            dialog.removeAttribute('open');
          }
        } else {
          dialog.removeAttribute('open');
        }
      }
      if (prevState) {
        this.options.onClose?.();
      }
    }
  }

  get extractedAccounts() {
    return this.currentExtracted?.accounts || [];
  }

  getSelectedAccounts() {
    return (this.currentExtracted?.accounts || []).filter((acc) => acc.selected !== false);
  }

  populateForm(data, source = 'gemini-1.5-flash') {
    return this.renderPreview(data, source);
  }

  /**
   * Renderiza SIEMPRE el catálogo completo de bancos y entidades financieras de Honduras
   * (idéntico a "Entidad Bancaria" en el modal "Modificar Cuenta o Meta"), marcando como
   * `selected` el banco detectado por la IA o elegido por el usuario.
   *
   * @param {string} [selectedBank='']
   * @returns {string}
   */
  renderBankSelectOptionsMarkup(selectedBank = '') {
    return renderBankSelectOptionsMarkup(selectedBank);
  }

  populateBankOptions(selectedBank = '') {
    if (typeof document === 'undefined') return;
    const bankSelect = document.getElementById('import-acc-bank-select');
    const datalist = document.getElementById('import-acc-bank-datalist');
    const targetBank =
      selectedBank ||
      this.currentExtracted?.accounts?.[0]?.bankName ||
      this.currentExtracted?.bankName ||
      HONDURAS_BANKS_LIST[0];
    const resolvedBank = resolveHondurasCatalogBankOption(targetBank);

    if (bankSelect) {
      bankSelect.innerHTML = this.renderBankSelectOptionsMarkup(resolvedBank);
      bankSelect.value = resolvedBank;
    }

    if (datalist) {
      datalist.innerHTML = HONDURAS_BANKS_LIST.filter((b) => b !== 'Otro / Personalizado')
        .map((bank) => `<option value="${escapeHtmlAttr(bank)}"></option>`)
        .join('');
    }
  }

  ensureModalDom() {
    if (typeof document === 'undefined') return;

    const accountsPanelActions = document.querySelector(
      '#panel-accounts .toolbar-action-group, #panel-accounts .section-toolbar > div:last-child, #panel-accounts .section-header > div:last-child'
    );
    if (
      accountsPanelActions &&
      !document.getElementById('btn-import-account') &&
      !document.getElementById('btn-import-account-media')
    ) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'btn-import-account';
      btn.className = 'btn-primary';
      btn.dataset.action = 'open-import-account-modal';
      btn.setAttribute('aria-label', 'Importar cuenta y movimientos desde imagen o PDF');
      btn.textContent = '➕ Importar Cuenta desde Imagen/PDF';
      accountsPanelActions.insertBefore(btn, accountsPanelActions.firstChild);
    }

    if (!document.getElementById('import-account-dialog')) {
      const dialog = document.createElement('dialog');
      dialog.id = 'import-account-dialog';
      dialog.className = 'modal-dialog modal-dialog-xl';
      dialog.setAttribute('closedby', 'any');
      dialog.setAttribute('aria-labelledby', 'import-account-dialog-title');
      dialog.innerHTML = `
        <div class="modal-header">
          <div>
            <h2 id="import-account-dialog-title">➕ Importar Cuenta desde Imagen / PDF</h2>
            <p style="font-size: 0.85rem; color: var(--text-secondary); margin: 0.15rem 0 0 0;">
              Extrae una o múltiples cuentas de tu captura o PDF, edita o elimina registros y selecciona qué cuentas guardar.
            </p>
          </div>
          <button type="button" class="btn-secondary btn-sm" id="btn-close-import-account" aria-label="Cerrar modal de importación de cuenta">Cerrar</button>
        </div>

        <div class="modal-body" style="display: flex; flex-direction: column; gap: 1rem;">
          <input
            type="file"
            id="import-account-file-input"
            accept="image/png,image/jpeg,image/webp,application/pdf,.pdf"
            class="sr-only"
          />

          <div
            id="import-account-dropzone"
            role="button"
            tabindex="0"
            aria-label="Subir o arrastrar captura de pantalla o estado de cuenta PDF"
            style="border: 2px dashed var(--surface-border); border-radius: 14px; padding: 1.1rem; text-align: center; background: var(--bg-elevated); cursor: pointer;"
          >
            <div style="font-weight: 600; margin-bottom: 0.35rem;">
              📷📄 Arrastra tu captura de Banca Móvil (PNG, JPG, WEBP) o Estado de Cuenta (PDF)
            </div>
            <p style="font-size: 0.8125rem; color: var(--text-secondary); margin: 0 0 0.65rem 0;">
              Detecta automáticamente 1 o múltiples cuentas/tarjetas (Banco, Tipo, Número Completo, Moneda, Saldo y Movimientos).
            </p>
            <div style="display: flex; justify-content: center; gap: 0.5rem; flex-wrap: wrap;">
              <button type="button" class="btn-primary btn-sm" id="btn-trigger-import-account-file">
                Seleccionar Imagen o PDF
              </button>
              <button type="button" class="btn-secondary btn-sm" id="btn-import-account-demo-adk">
                🤖 Cargar Demo ADK (Atlántida L 3,901.33)
              </button>
            </div>
          </div>

          <div id="import-account-loading-box" class="voucher-progress-box is-hidden" role="status" aria-live="polite">
            <div class="voucher-progress-labels">
              <span id="import-account-loading-text">🤖 Analizando documento con Gemini Vision...</span>
            </div>
            <progress class="native-progress" max="100"></progress>
          </div>

          <div id="import-account-error-box" class="error-msg is-hidden" role="alert"></div>

          <div id="import-account-duplicate-banner-box" class="duplicate-tx-warning-banner is-hidden" role="alert"></div>

          <div id="import-account-preview-box" class="is-hidden" style="display: flex; flex-direction: column; gap: 1rem;">
            <div style="display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; flex-wrap: wrap; padding: 0.75rem 1rem; border-radius: 12px; background: var(--bg-elevated); border: 1px solid var(--surface-border);">
              <div>
                <strong id="import-account-summary-title" style="font-size: 0.95rem;">Cuentas detectadas</strong>
                <div id="import-account-tx-count-badge" style="font-size: 0.8125rem; color: var(--text-secondary); margin-top: 0.15rem;">
                  0 movimiento(s) seleccionado(s)
                </div>
              </div>
              <span id="import-account-source-badge" class="voucher-pill">🤖 Gemini Vision</span>
            </div>

            <img
              id="import-account-image-preview"
              alt="Vista previa de captura de cuenta"
              class="is-hidden"
              style="max-height: 150px; object-fit: contain; border-radius: 10px; border: 1px solid var(--surface-border); align-self: center;"
            />

            <datalist id="import-acc-bank-datalist"></datalist>

            <!-- Lista de Cuentas Extraídas (1 o múltiples cuentas editables y eliminables con checkboxes) -->
            <div id="import-account-list-section">
              <div style="display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem; flex-wrap: wrap;">
                <label style="display: inline-flex; align-items: center; gap: 0.45rem; font-weight: 600; cursor: pointer;">
                  <input type="checkbox" id="import-account-select-all-accounts" checked />
                  <span>Cuentas Extraídas (✏️ Edita Banco, Tipo, Número, Moneda, Saldo o 🗑️ Elimina filas)</span>
                </label>
                <button type="button" class="btn-secondary btn-sm" id="btn-import-account-add-acc">
                  + Agregar Cuenta
                </button>
              </div>

              <div class="statement-table-wrapper">
                <table class="statement-table" aria-label="Lista de cuentas extraídas editables">
                  <thead>
                    <tr>
                      <th scope="col" style="width: 40px; text-align: center;">✓</th>
                      <th scope="col" style="min-width: 155px;">✏️ Nombre de Banco</th>
                      <th scope="col" style="min-width: 170px;">✏️ Tipo de Cuenta</th>
                      <th scope="col" style="min-width: 145px;">✏️ Número Completo</th>
                      <th scope="col" style="width: 110px;">✏️ Moneda</th>
                      <th scope="col" class="num-col" style="width: 135px;">✏️ Saldo</th>
                      <th scope="col" style="width: 90px; text-align: center;">🗑️ Quitar</th>
                    </tr>
                  </thead>
                  <tbody id="import-account-accounts-tbody"></tbody>
                </table>
              </div>

              <div style="margin-top: 0.5rem; padding: 0.55rem 0.85rem; border-radius: 10px; background: var(--bg-elevated); border: 1px dashed var(--surface-border); display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; flex-wrap: wrap;">
                <label style="display: inline-flex; align-items: center; gap: 0.45rem; font-size: 0.8125rem; cursor: pointer;">
                  <input type="checkbox" id="import-account-learn-format-checkbox" checked />
                  <span>🧠 Aprender sobre este Formato (guardar patrón ajustado en <code>bank_templates</code> para reconocimiento instantáneo)</span>
                </label>
              </div>
            </div>

            <!-- Campos de Cuenta Principal (sincronizados con la primera cuenta para compatibilidad directa) -->
            <details class="firebase-config-accordion">
              <summary>✏️ Edición Rápida de Cuenta Principal</summary>
              <div class="form-grid-2" style="margin-top: 0.65rem;">
                <div class="field">
                  <label for="import-acc-bank-select">Nombre del Banco (Honduras)</label>
                  <select id="import-acc-bank-select" name="bankSelect"></select>
                </div>

                <div class="field" id="import-acc-bank-custom-wrapper">
                  <label for="import-acc-bank-input">Nombre del Banco (Editable)</label>
                  <input
                    type="text"
                    id="import-acc-bank-input"
                    name="bankName"
                    list="import-acc-bank-datalist"
                    placeholder="Ej. Banco Atlántida"
                    required
                  />
                </div>
              </div>

              <div class="form-grid-2">
                <div class="field">
                  <label for="import-acc-type-input">Tipo de Cuenta</label>
                  <input
                    type="text"
                    id="import-acc-type-input"
                    name="accountType"
                    placeholder="Ej. CUENTA DE AHORRO SOS"
                    required
                  />
                </div>

                <div class="field">
                  <label for="import-acc-number-input">Número de Cuenta Completo</label>
                  <input
                    type="text"
                    id="import-acc-number-input"
                    name="accountNumber"
                    inputmode="numeric"
                    placeholder="Ej. 213130058771"
                  />
                </div>
              </div>

              <div class="form-grid-2">
                <div class="field">
                  <label for="import-acc-currency-select">Moneda</label>
                  <select id="import-acc-currency-select" name="currency">
                    <option value="HNL">HNL (Lempiras - L)</option>
                    <option value="USD">USD (Dólares - $)</option>
                  </select>
                </div>

                <div class="field">
                  <label for="import-acc-balance-input">Saldo Inicial / Disponible</label>
                  <input
                    type="number"
                    id="import-acc-balance-input"
                    name="currentBalance"
                    step="0.01"
                    required
                  />
                </div>
              </div>
            </details>

            <div>
              <div style="display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem; flex-wrap: wrap;">
                <label style="display: inline-flex; align-items: center; gap: 0.45rem; font-weight: 600; cursor: pointer;">
                  <input type="checkbox" id="import-account-select-all-tx" checked />
                  <span>Movimientos Detectados (Edita fecha, concepto o monto antes de importar)</span>
                </label>
                <button type="button" class="btn-secondary btn-sm" id="btn-import-account-add-tx">
                  + Agregar Fila Manual
                </button>
              </div>

              <div class="statement-table-wrapper">
                <table class="statement-table" aria-label="Movimientos detectados editables">
                  <thead>
                    <tr>
                      <th scope="col" style="width: 40px; text-align: center;">Imp.</th>
                      <th scope="col" style="width: 150px;">Fecha</th>
                      <th scope="col">Concepto / Descripción (Editable)</th>
                      <th scope="col" style="width: 150px;">Tipo</th>
                      <th scope="col" class="num-col" style="width: 150px;">Monto</th>
                    </tr>
                  </thead>
                  <tbody id="import-account-tx-tbody"></tbody>
                </table>
              </div>
            </div>
          </div>

          <div style="display: flex; justify-content: flex-end; gap: 0.65rem; margin-top: 0.5rem;">
            <button type="button" class="btn-secondary" id="btn-cancel-import-account">
              Cancelar
            </button>
            <button type="button" class="btn-primary" id="btn-confirm-import-account" disabled>
              Confirmar y Crear 1 Cuenta
            </button>
          </div>
        </div>
      `;
      document.body.appendChild(dialog);
    }
  }

  open() {
    this.setIsImportAccountModalOpen(true);
  }

  handleLoadDemoADK() {
    const demoResult = this.agentADK.loadDemoFallback();
    const sanitized = this.sanitizeExtractedData(demoResult.data);
    this.currentExtracted = sanitized;
    this.reconcileAccountAndTransactionDuplicates();
    if (typeof document !== 'undefined') {
      this.renderPreview(this.currentExtracted, demoResult.source);
    }
    this.options.showToast?.(demoResult.message);
    return this.currentExtracted;
  }

  resetView() {
    this.currentExtracted = null;
    this.isProcessing = false;
    this.matchedExistingAccount = null;

    const loadingBox = document.getElementById('import-account-loading-box');
    const previewBox = document.getElementById('import-account-preview-box');
    const errorBox = document.getElementById('import-account-error-box');
    const dupBannerBox = document.getElementById('import-account-duplicate-banner-box');
    const confirmBtn = document.getElementById('btn-confirm-import-account');
    const imgPreview = document.getElementById('import-account-image-preview');

    loadingBox?.classList.add('is-hidden');
    previewBox?.classList.add('is-hidden');
    errorBox?.classList.add('is-hidden');
    dupBannerBox?.classList.add('is-hidden');
    if (errorBox) errorBox.textContent = '';
    if (dupBannerBox) dupBannerBox.innerHTML = '';
    if (confirmBtn) confirmBtn.disabled = true;
    if (imgPreview) {
      imgPreview.removeAttribute('src');
      imgPreview.classList.add('is-hidden');
    }
  }

  async handleFileSelected(file) {
    if (!file || this.isProcessing) return;

    const isValidFile =
      /^image\/(png|jpeg|jpg|webp)$/i.test(file.type) ||
      file.type === 'application/pdf' ||
      /\.(png|jpe?g|webp|pdf)$/i.test(file.name || '');

    if (!isValidFile) {
      this.showError('Formato no soportado. Sube una imagen (PNG, JPG, WEBP) o un documento PDF.');
      return;
    }

    this.isProcessing = true;
    const loadingBox = document.getElementById('import-account-loading-box');
    const loadingText = document.getElementById('import-account-loading-text');
    const previewBox = document.getElementById('import-account-preview-box');
    const errorBox = document.getElementById('import-account-error-box');
    const confirmBtn = document.getElementById('btn-confirm-import-account');
    const imgPreview = document.getElementById('import-account-image-preview');

    errorBox?.classList.add('is-hidden');
    previewBox?.classList.add('is-hidden');
    if (confirmBtn) confirmBtn.disabled = true;
    if (loadingText) {
      loadingText.textContent = '🤖 Analizando documento con Gemini Vision...';
    }
    loadingBox?.classList.remove('is-hidden');

    try {
      try {
        const encoded = await encodeFileToBase64(file);
        if (imgPreview) {
          if (!encoded.isPdf && encoded.dataUrl) {
            imgPreview.src = encoded.dataUrl;
            imgPreview.classList.remove('is-hidden');
          } else {
            imgPreview.classList.add('is-hidden');
          }
        }
      } catch {
        imgPreview?.classList.add('is-hidden');
      }

      let ocrTextFallback = String(file?.extractedText || file?.ocrText || '').trim();
      if (typeof this.options.extractOcrFallbackText === 'function') {
        try {
          const extractedOcr = await this.options.extractOcrFallbackText(file, (status) => {
            if (loadingText && status) loadingText.textContent = status;
          });
          if (extractedOcr) {
            ocrTextFallback = String(extractedOcr).trim();
          }
        } catch {
          // preserve initial ocrTextFallback if any
        }
      }
      if (!ocrTextFallback) {
        try {
          const localOcrRes = await runTesseractLocalOcr(file, {
            ocrReader: this.options.ocrReader,
            tesseractWorker: this.options.tesseractWorker,
            onProgress: (status) => {
              if (loadingText && status) loadingText.textContent = status;
            },
          });
          if (localOcrRes?.text) {
            ocrTextFallback = String(localOcrRes.text).trim();
          }
        } catch {
          // fallback
        }
      }
      this.lastOcrTextFallback = ocrTextFallback;

      const ctx = this.options.getImportContext?.() || {};
      let extractionData = null;
      let extractionSource = '';
      let isDemoFallback = false;
      let statusMessage = '';

      try {
        const hybridResult = await extractBankDataHybrid(file, {
          apiKey: ctx.apiKey,
          ocrTextFallback,
          ocrReader: this.options.ocrReader || ctx.ocrReader,
          tesseractWorker: this.options.tesseractWorker || ctx.tesseractWorker,
          fetchImpl: ctx.fetchImpl,
          storage: ctx.storage,
          indexedDb: ctx.indexedDb,
          firestoreDb: ctx.firestoreDb,
          firestoreModule: ctx.firestoreModule,
        });
        if (
          hybridResult &&
          Array.isArray(hybridResult.accountsList) &&
          hybridResult.accountsList.some(
            (a) => Boolean(a.accountNumber) || Number(a.currentBalance) > 0
          )
        ) {
          extractionData = hybridResult;
          extractionSource = hybridResult.source || 'hybrid-ocr-extractor';
          if (hybridResult.ocrText && !this.lastOcrTextFallback) {
            this.lastOcrTextFallback = hybridResult.ocrText;
          }
        }
      } catch {
        // Fallback al Agente ADK
      }

      if (!extractionData) {
        const adkResult = await this.agentADK.analyzeFile(file, {
          apiKey: ctx.apiKey,
          ocrTextFallback,
          fetchImpl: ctx.fetchImpl,
        });
        extractionData = adkResult.data;
        extractionSource = adkResult.source;
        isDemoFallback = Boolean(adkResult.isDemoFallback);
        statusMessage = adkResult.message || '';
      }

      const sanitizedData = this.sanitizeExtractedData(extractionData, this.lastOcrTextFallback);
      this.currentExtracted = sanitizedData;

      this.reconcileAccountAndTransactionDuplicates();
      this.renderPreview(this.currentExtracted, extractionSource);
      if (isDemoFallback && statusMessage) {
        this.options.showToast?.(statusMessage);
      }
    } catch {
      const fallbackResult = this.agentADK.loadDemoFallback();
      const sanitizedFallback = this.sanitizeExtractedData(fallbackResult.data);
      this.currentExtracted = sanitizedFallback;
      this.reconcileAccountAndTransactionDuplicates();
      this.renderPreview(this.currentExtracted, fallbackResult.source);
      this.options.showToast?.(fallbackResult.message);
    } finally {
      this.isProcessing = false;
      loadingBox?.classList.add('is-hidden');
    }
  }

  /**
   * Actualiza un campo de una cuenta específica en `this.currentExtracted.accounts[idx]`
   * (✏️ Editar: Nombre de Banco, Tipo de Cuenta, Número Completo, Moneda, Saldo, o selección checkbox).
   */
  updateAccountAtIndex(idx, field, value) {
    if (!this.currentExtracted || !Array.isArray(this.currentExtracted.accounts)) return null;
    if (idx < 0 || idx >= this.currentExtracted.accounts.length) return null;

    const item = this.currentExtracted.accounts[idx];
    if (field === 'selected') {
      item.selected = Boolean(value);
    } else if (field === 'bankName') {
      item.bankName = cleanBankName(value, item.accountType);
    } else if (field === 'accountType') {
      item.accountType = String(value ?? '').trim() || 'Cuenta de Ahorro';
      const classification = classifyBankProductType(item.accountType, item.accountNumber);
      item.productType = classification.productType;
      item.isCreditCard = classification.isCreditCard;
      item.isLoan = classification.isLoan;
    } else if (field === 'productType') {
      const classification = classifyBankProductType(String(value ?? ''), item.accountNumber);
      item.productType = classification.productType;
      item.isCreditCard = classification.isCreditCard;
      item.isLoan = classification.isLoan;
    } else if (field === 'accountNumber') {
      item.accountNumber = String(value ?? '').trim();
    } else if (field === 'currency') {
      item.currency = String(value ?? '').toUpperCase().includes('USD') ? 'USD' : 'HNL';
    } else if (field === 'currentBalance') {
      item.currentBalance = cleanAmount(value);
    } else if (field === 'isCreditCard') {
      item.isCreditCard = Boolean(value === true || value === 'true');
      if (item.isCreditCard) {
        item.productType = BANK_PRODUCT_TYPES.CREDIT_CARD;
        item.isLoan = false;
      }
    } else if (field === 'isLoan') {
      item.isLoan = Boolean(value === true || value === 'true');
      if (item.isLoan) {
        item.productType = BANK_PRODUCT_TYPES.LOAN;
        item.isCreditCard = false;
      }
    }

    if (idx === 0) {
      this.currentExtracted.bankName = item.bankName;
      this.currentExtracted.accountType = item.accountType;
      this.currentExtracted.productType = item.productType;
      this.currentExtracted.accountNumber = item.accountNumber;
      this.currentExtracted.currency = item.currency;
      this.currentExtracted.currentBalance = item.currentBalance;
      this.currentExtracted.isCreditCard = Boolean(item.isCreditCard);
      this.currentExtracted.isLoan = Boolean(item.isLoan);
      this.syncPrimaryInputsFromFirstAccount();
      this.reconcileAccountAndTransactionDuplicates();
    }

    this.syncSelectAllAccountsCheckboxState();
    this.syncSummaryBanner();
    return item;
  }

  editAccountRow(idx, updates = {}) {
    if (!updates || typeof updates !== 'object') return null;
    let updated = null;
    for (const [field, val] of Object.entries(updates)) {
      updated = this.updateAccountAtIndex(idx, field, val);
    }
    this.renderAccountsListTable();
    return updated;
  }

  /**
   * ➕ Agrega una nueva fila editable a `accountsList` (`this.currentExtracted.accounts`).
   * @param {object} [accountData={}]
   */
  addAccountRow(accountData = {}) {
    if (!this.currentExtracted) {
      this.currentExtracted = this.sanitizeExtractedData({
        bankName: accountData.bankName || HONDURAS_BANKS_LIST[0],
        accountsList: [],
      });
    } else {
      this.syncAccountsFromDom();
    }

    const defaultBank =
      accountData.bankName || this.currentExtracted.bankName || HONDURAS_BANKS_LIST[0];
    const newAccItem = {
      id: accountData.id || `imp_acc_manual_${Date.now().toString(36)}`,
      bankName: cleanBankName(defaultBank, accountData.accountType || ''),
      accountType: String(accountData.accountType || 'Cuenta de Ahorro').trim(),
      accountNumber: String(accountData.accountNumber || '').trim(),
      currency: accountData.currency === 'USD' ? 'USD' : 'HNL',
      currentBalance: cleanAmount(accountData.currentBalance ?? 0),
      isCreditCard: Boolean(accountData.isCreditCard),
      status: accountData.status || 'Activa',
      selected: accountData.selected !== false,
    };

    this.currentExtracted.accounts.push(newAccItem);
    this.currentExtracted.accountsList = this.currentExtracted.accounts;
    this.currentExtracted.accountsArray = this.currentExtracted.accounts;
    this.syncPrimaryInputsFromFirstAccount();
    this.renderAccountsListTable();
    this.syncSelectAllAccountsCheckboxState();
    this.syncSummaryBanner();
    return newAccItem;
  }

  /**
   * 🗑️ Elimina / quita cualquier cuenta individual de la lista extraída antes de guardar.
   * @param {number} idx
   */
  removeAccountAtIndex(idx) {
    if (!this.currentExtracted || !Array.isArray(this.currentExtracted.accounts)) return [];
    if (idx < 0 || idx >= this.currentExtracted.accounts.length) {
      return this.currentExtracted.accounts;
    }

    this.syncAccountsFromDom();
    this.currentExtracted.accounts.splice(idx, 1);
    this.currentExtracted.accountsList = this.currentExtracted.accounts;
    this.currentExtracted.accountsArray = this.currentExtracted.accounts;

    if (this.currentExtracted.accounts.length > 0) {
      const first = this.currentExtracted.accounts[0];
      this.currentExtracted.bankName = first.bankName;
      this.currentExtracted.accountType = first.accountType;
      this.currentExtracted.accountNumber = first.accountNumber;
      this.currentExtracted.currency = first.currency;
      this.currentExtracted.currentBalance = first.currentBalance;
      this.currentExtracted.isCreditCard = Boolean(first.isCreditCard);
      this.syncPrimaryInputsFromFirstAccount();
    }

    this.reconcileAccountAndTransactionDuplicates();
    this.renderAccountsListTable();
    this.syncSelectAllAccountsCheckboxState();
    this.syncSummaryBanner();
    return this.currentExtracted.accounts;
  }

  removeExtractedAccount(idx) {
    return this.removeAccountAtIndex(idx);
  }

  /**
   * Selecciona o deselecciona todas las cuentas de `this.currentExtracted.accounts`.
   * @param {boolean} checked
   */
  toggleSelectAllAccounts(checked) {
    if (!this.currentExtracted || !Array.isArray(this.currentExtracted.accounts)) return [];
    const nextChecked = Boolean(checked);
    this.currentExtracted.accounts.forEach((acc) => {
      acc.selected = nextChecked;
    });
    this.renderAccountsListTable();
    this.syncSelectAllAccountsCheckboxState();
    this.syncSummaryBanner();
    return this.currentExtracted.accounts;
  }

  syncPrimaryInputsFromFirstAccount() {
    if (typeof document === 'undefined' || !this.currentExtracted) return;
    const first = this.currentExtracted.accounts?.[0];
    if (!first) return;

    const bankSelect = document.getElementById('import-acc-bank-select');
    const bankInput = document.getElementById('import-acc-bank-input');
    const typeInput = document.getElementById('import-acc-type-input');
    const numberInput = document.getElementById('import-acc-number-input');
    const currencySelect = document.getElementById('import-acc-currency-select');
    const balanceInput = document.getElementById('import-acc-balance-input');

    const resolvedBank = cleanBankName(
      first.bankName || this.currentExtracted.bankName,
      first.accountType
    );
    if (bankInput) bankInput.value = resolvedBank;
    if (bankSelect) {
      const catalogOption = resolveHondurasCatalogBankOption(resolvedBank);
      bankSelect.innerHTML = this.renderBankSelectOptionsMarkup(catalogOption);
      bankSelect.value = catalogOption;
    }
    if (typeInput) typeInput.value = first.accountType || 'Cuenta de Ahorro';
    if (numberInput) numberInput.value = first.accountNumber || '';
    if (currencySelect) currencySelect.value = first.currency === 'USD' ? 'USD' : 'HNL';
    if (balanceInput) balanceInput.value = String(cleanAmount(first.currentBalance));
  }

  syncFirstAccountFromPrimaryInputs() {
    if (typeof document === 'undefined' || !this.currentExtracted) return;
    const first = this.currentExtracted.accounts?.[0];
    if (!first) return;

    const typeInput = document.getElementById('import-acc-type-input');
    const numberInput = document.getElementById('import-acc-number-input');
    const currencySelect = document.getElementById('import-acc-currency-select');
    const balanceInput = document.getElementById('import-acc-balance-input');

    first.bankName = this.readEditedBankName();
    if (typeInput?.value !== undefined) {
      first.accountType = typeInput.value.trim() || 'Cuenta de Ahorro';
    }
    if (numberInput?.value !== undefined) {
      first.accountNumber = numberInput.value.trim();
    }
    if (currencySelect?.value) {
      first.currency = currencySelect.value === 'USD' ? 'USD' : 'HNL';
    }
    if (balanceInput?.value !== undefined && balanceInput.value !== '') {
      first.currentBalance = cleanAmount(balanceInput.value);
    }

    this.currentExtracted.bankName = first.bankName;
    this.currentExtracted.accountType = first.accountType;
    this.currentExtracted.accountNumber = first.accountNumber;
    this.currentExtracted.currency = first.currency;
    this.currentExtracted.currentBalance = first.currentBalance;
  }

  /**
   * Verifica si la cuenta importada ya existe por `accountNumber` y si alguno de sus
   * movimientos detectados coincide con transacciones existentes (`accountId` + `date` + `amount` + `concept` similar).
   */
  reconcileAccountAndTransactionDuplicates() {
    if (!this.currentExtracted) return;
    const state = this.options.getState?.() || globalThis.pistoApp?.state || null;
    const accounts = Array.isArray(state?.accounts) ? state.accounts : [];
    const transactions = Array.isArray(state?.transactions) ? state.transactions : [];

    const firstAcc = this.currentExtracted.accounts?.[0];
    const numberInput =
      typeof document !== 'undefined' ? document.getElementById('import-acc-number-input') : null;
    const currentAccNumber = String(
      firstAcc?.accountNumber ??
        (numberInput?.value !== undefined ? numberInput.value : this.currentExtracted.accountNumber || '')
    )
      .replace(/[\s-]/g, '')
      .trim();

    this.matchedExistingAccount = currentAccNumber
      ? accounts.find(
          (a) =>
            String(a?.accountNumber || '')
              .replace(/[\s-]/g, '')
              .trim() === currentAccNumber
        ) || null
      : null;

    const targetAccountId = this.matchedExistingAccount?.id || '';
    const currency = firstAcc?.currency || this.currentExtracted.currency || 'HNL';

    const duplicateMessages = [];
    for (const tx of this.currentExtracted.detectedTransactions || []) {
      const dupCheck = targetAccountId
        ? findAccountDuplicateTransactions(
            {
              accountId: targetAccountId,
              date: tx.date,
              amount: tx.amount,
              currency,
              concept: tx.concept,
            },
            transactions,
            targetAccountId
          )
        : { isDuplicate: false, duplicateTransaction: null, warningMessage: '' };

      tx.isDuplicate = dupCheck.isDuplicate;
      tx.duplicateTxId = dupCheck.duplicateTransaction?.id || null;
      tx.duplicateWarning = dupCheck.warningMessage || '';

      if (dupCheck.isDuplicate) {
        if (!tx.duplicateAction) {
          tx.duplicateAction = DUPLICATE_TRANSACTION_ACTIONS.OVERWRITE;
        }
        duplicateMessages.push(dupCheck.warningMessage);
      } else {
        tx.duplicateAction = null;
      }
    }

    if (typeof document !== 'undefined') {
      const dupBannerBox = document.getElementById('import-account-duplicate-banner-box');
      if (dupBannerBox) {
        if (duplicateMessages.length > 0) {
          dupBannerBox.classList.remove('is-hidden');
          dupBannerBox.innerHTML = duplicateMessages
            .map((msg) => `<div><strong>${escapeHtmlAttr(msg)}</strong></div>`)
            .join('');
        } else {
          dupBannerBox.classList.add('is-hidden');
          dupBannerBox.innerHTML = '';
        }
      }
    }
  }

  sanitizeExtractedData(rawData, contextHint = '') {
    const cleanedAccountType = cleanAccountType(rawData?.accountType);
    const cleanedBank = cleanBankName(
      rawData?.bankName,
      `${cleanedAccountType} ${contextHint}`
    );

    const rawTransactionsSource =
      Array.isArray(rawData?.detectedTransactions) && rawData.detectedTransactions.length > 0
        ? rawData.detectedTransactions
        : Array.isArray(rawData?.transactionsList)
          ? rawData.transactionsList
          : [];

    const cleanedTransactions = rawTransactionsSource.map((tx, idx) => ({
      id: tx.id || `imp_tx_${idx}_${Date.now().toString(36)}`,
      date: normalizeScanDateToIso(tx.date),
      concept:
        cleanMobileUiText(String(tx.concept || 'Movimiento bancario'))
          .replace(/\s+/g, ' ')
          .trim() || 'Movimiento bancario',
      type: tx.type === 'income' ? 'income' : 'expense',
      amount: Math.abs(cleanAmount(tx.amount)),
      selected: tx.selected !== false,
      isDuplicate: Boolean(tx.isDuplicate),
      duplicateTxId: tx.duplicateTxId || null,
      duplicateAction: tx.duplicateAction || null,
      duplicateWarning: tx.duplicateWarning || '',
    }));

    const sourceAccountsList =
      Array.isArray(rawData?.accountsList) && rawData.accountsList.length > 0
        ? rawData.accountsList
        : Array.isArray(rawData?.accounts) && rawData.accounts.length > 0
          ? rawData.accounts
          : Array.isArray(rawData?.accountsArray) && rawData.accountsArray.length > 0
            ? rawData.accountsArray
            : null;

    const normalizedAccounts = sourceAccountsList
      ? sourceAccountsList.map((item, idx) => {
          const itemType = cleanAccountType(item?.accountType);
          const classification = classifyBankProductType(
            `${itemType} ${item?.productType || ''} ${item?.isLoan ? 'Préstamo' : ''} ${item?.isCreditCard ? 'Tarjeta de Crédito' : ''}`,
            item?.accountNumber
          );
          const isLoan = Boolean(item?.isLoan || classification.isLoan);
          const isCard = !isLoan && Boolean(item?.isCreditCard || classification.isCreditCard);
          const productType = isLoan
            ? BANK_PRODUCT_TYPES.LOAN
            : isCard
              ? BANK_PRODUCT_TYPES.CREDIT_CARD
              : item?.productType || classification.productType;
          return {
            id: item?.id || `imp_acc_${idx}_${Date.now().toString(36)}`,
            bankName: cleanBankName(
              item?.bankName || cleanedBank,
              itemType || cleanedAccountType
            ),
            accountType: itemType,
            productType,
            accountNumber: String(item?.accountNumber ?? '').trim(),
            currency: item?.currency === 'USD' ? 'USD' : 'HNL',
            currentBalance: cleanAmount(item?.currentBalance ?? 0),
            isCreditCard: isCard,
            isLoan,
            status: item?.status || 'Activa',
            selected: item?.selected !== false,
          };
        })
      : [
          (() => {
            const classification = classifyBankProductType(
              `${cleanedAccountType} ${rawData?.productType || ''}`,
              rawData?.accountNumber
            );
            const isLoan = Boolean(rawData?.isLoan || classification.isLoan);
            const isCard = !isLoan && Boolean(rawData?.isCreditCard || classification.isCreditCard);
            return {
              id: `imp_acc_0_${Date.now().toString(36)}`,
              bankName: cleanedBank,
              accountType: cleanedAccountType,
              productType: isLoan
                ? BANK_PRODUCT_TYPES.LOAN
                : isCard
                  ? BANK_PRODUCT_TYPES.CREDIT_CARD
                  : rawData?.productType || classification.productType,
              accountNumber: String(rawData?.accountNumber ?? '').trim(),
              currency: rawData?.currency === 'USD' ? 'USD' : 'HNL',
              currentBalance: cleanAmount(rawData?.currentBalance ?? 0),
              isCreditCard: isCard,
              isLoan,
              status: rawData?.status || 'Activa',
              selected: true,
            };
          })(),
        ];

    const primaryAcc = normalizedAccounts[0];

    return {
      ...rawData,
      bankName: primaryAcc?.bankName || cleanedBank,
      accountType: primaryAcc?.accountType || cleanedAccountType,
      productType: primaryAcc?.productType || 'Ahorro',
      accountNumber: primaryAcc?.accountNumber ?? String(rawData?.accountNumber ?? '').trim(),
      currency: primaryAcc?.currency || (rawData?.currency === 'USD' ? 'USD' : 'HNL'),
      currentBalance: primaryAcc?.currentBalance ?? cleanAmount(rawData?.currentBalance ?? 0),
      isCreditCard: Boolean(primaryAcc?.isCreditCard ?? rawData?.isCreditCard),
      isLoan: Boolean(primaryAcc?.isLoan ?? rawData?.isLoan),
      accountsList: normalizedAccounts,
      accounts: normalizedAccounts,
      accountsArray: normalizedAccounts,
      status: rawData?.status || 'Activa',
      transactionsList: cleanedTransactions,
      detectedTransactions: cleanedTransactions,
    };
  }

  showError(message) {
    const errorBox = document.getElementById('import-account-error-box');
    if (errorBox) {
      errorBox.textContent = `⚠️ ${message}`;
      errorBox.classList.remove('is-hidden');
    }
    this.options.showToast?.(`⚠️ ${message}`);
  }

  readEditedBankName() {
    const bankSelect =
      typeof document !== 'undefined'
        ? document.getElementById('import-acc-bank-select')
        : null;
    const bankInput =
      typeof document !== 'undefined'
        ? document.getElementById('import-acc-bank-input')
        : null;

    const selectVal = bankSelect?.value?.trim() || '';
    const typedVal = bankInput?.value?.trim() || '';

    if (selectVal && selectVal !== 'Otro / Personalizado') {
      return cleanBankName(selectVal, this.currentExtracted?.accountType || '');
    }
    if (typedVal) {
      return cleanBankName(typedVal, this.currentExtracted?.accountType || '');
    }
    return cleanBankName(
      this.currentExtracted?.bankName || HONDURAS_BANKS_LIST[0],
      this.currentExtracted?.accountType || ''
    );
  }

  renderPreview(data, source = 'gemini-1.5-flash') {
    this.populateBankOptions();
    const sanitized = this.sanitizeExtractedData(data);
    this.currentExtracted = sanitized;
    this.initialExtractedSnapshot = (sanitized.accountsList || []).map((acc) => ({
      ...acc,
    }));

    this.syncPrimaryInputsFromFirstAccount();
    this.reconcileAccountAndTransactionDuplicates();
    this.renderAccountsListTable();
    this.syncSelectAllAccountsCheckboxState();
    this.renderTransactionsTable();
    this.syncSelectAllCheckboxState();
    this.syncSummaryBanner();

    if (typeof document !== 'undefined') {
      const previewBox = document.getElementById('import-account-preview-box');
      const sourceBadge = document.getElementById('import-account-source-badge');
      const confirmBtn = document.getElementById('btn-confirm-import-account');

      if (sourceBadge) {
        sourceBadge.textContent =
          source.includes('gemini') || source.includes('genkit')
            ? '🤖 Gemini Vision'
            : '⚡ Extractor OCR/PDF';
      }

      previewBox?.classList.remove('is-hidden');
      if (confirmBtn) {
        confirmBtn.disabled =
          this.currentExtracted.accounts.filter((a) => a.selected !== false).length === 0;
      }
    }
    return this.currentExtracted;
  }

  renderAccountsListTable() {
    if (!this.currentExtracted) return '';
    const accountsTbody =
      typeof document !== 'undefined'
        ? document.getElementById('import-account-accounts-tbody')
        : null;
    const accountsList = Array.isArray(this.currentExtracted.accounts)
      ? this.currentExtracted.accounts
      : [];

    const markup =
      accountsList.length === 0
        ? `
          <tr>
            <td colspan="7" style="text-align: center; padding: 1rem; color: var(--text-secondary);">
              No hay cuentas en la lista. Haz clic en "+ Agregar Cuenta" o selecciona una imagen/PDF.
            </td>
          </tr>
        `
        : accountsList
            .map((acc, idx) => {
              const isChecked = acc.selected !== false;
              const numericBal = cleanAmount(acc.currentBalance);
              return `
                <tr data-import-acc-row="${idx}" class="${isChecked ? 'is-selected' : 'is-unselected'}">
                  <td style="width: 40px; text-align: center;">
                    <input
                      type="checkbox"
                      data-import-acc-select="${idx}"
                      ${isChecked ? 'checked' : ''}
                      aria-label="Seleccionar cuenta ${idx + 1}"
                    />
                  </td>
                  <td>
                    <select
                      class="stmt-cat-select import-acc-bank-row-select"
                      data-import-acc-bank="${idx}"
                      aria-label="Nombre de Banco de cuenta ${idx + 1}"
                      style="width: 100%; padding: 0.38rem 0.6rem; font-size: 0.85rem;"
                    >
                      ${this.renderBankSelectOptionsMarkup(
                        acc.bankName || this.currentExtracted.bankName || HONDURAS_BANKS_LIST[0]
                      )}
                    </select>
                  </td>
                  <td>
                    <input
                      type="text"
                      class="smart-nlp-input"
                      data-import-acc-type="${idx}"
                      value="${escapeHtmlAttr(acc.accountType || 'Cuenta de Ahorro')}"
                      placeholder="Tipo de Cuenta"
                      aria-label="Tipo de Cuenta ${idx + 1}"
                      style="width: 100%; padding: 0.38rem 0.6rem; font-size: 0.85rem;"
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      class="smart-nlp-input"
                      data-import-acc-number="${idx}"
                      inputmode="numeric"
                      value="${escapeHtmlAttr(acc.accountNumber || '')}"
                      placeholder="Número Completo"
                      aria-label="Número Completo de cuenta ${idx + 1}"
                      style="width: 100%; padding: 0.38rem 0.6rem; font-size: 0.85rem; font-variant-numeric: tabular-nums;"
                    />
                  </td>
                  <td>
                    <select
                      class="stmt-cat-select"
                      data-import-acc-currency="${idx}"
                      aria-label="Moneda de cuenta ${idx + 1}"
                      style="width: 100%;"
                    >
                      <option value="HNL" ${acc.currency !== 'USD' ? 'selected' : ''}>HNL (L)</option>
                      <option value="USD" ${acc.currency === 'USD' ? 'selected' : ''}>USD ($)</option>
                    </select>
                  </td>
                  <td class="num-col">
                    <input
                      type="number"
                      step="0.01"
                      class="smart-nlp-input"
                      data-import-acc-balance="${idx}"
                      value="${numericBal}"
                      aria-label="Saldo de cuenta ${idx + 1}"
                      style="width: 100%; text-align: right; padding: 0.38rem 0.6rem; font-size: 0.85rem; font-variant-numeric: tabular-nums;"
                    />
                  </td>
                  <td style="text-align: center;">
                    <button
                      type="button"
                      class="btn-secondary btn-sm btn-remove-extracted-account"
                      data-import-acc-remove="${idx}"
                      aria-label="Eliminar cuenta ${idx + 1}"
                      title="Eliminar esta cuenta de la lista"
                    >🗑️ Eliminar</button>
                  </td>
                </tr>
              `;
            })
            .join('');

    if (accountsTbody) {
      accountsTbody.innerHTML = markup;
    }
    return markup;
  }

  syncAccountsFromDom() {
    if (!this.currentExtracted || !Array.isArray(this.currentExtracted.accounts)) return [];
    if (typeof document === 'undefined') return this.currentExtracted.accounts;

    const accountsTbody = document.getElementById('import-account-accounts-tbody');
    if (accountsTbody && accountsTbody.querySelectorAll('tr[data-import-acc-row]').length > 0) {
      this.currentExtracted.accounts = this.currentExtracted.accounts.map((acc, idx) => {
        const selectEl = accountsTbody.querySelector(`[data-import-acc-select="${idx}"]`);
        const bankEl = accountsTbody.querySelector(`[data-import-acc-bank="${idx}"]`);
        const typeEl = accountsTbody.querySelector(`[data-import-acc-type="${idx}"]`);
        const numEl = accountsTbody.querySelector(`[data-import-acc-number="${idx}"]`);
        const curEl = accountsTbody.querySelector(`[data-import-acc-currency="${idx}"]`);
        const balEl = accountsTbody.querySelector(`[data-import-acc-balance="${idx}"]`);

        const nextType =
          typeEl?.value !== undefined
            ? typeEl.value.trim() || 'Cuenta de Ahorro'
            : acc.accountType;
        const nextBank =
          bankEl?.value !== undefined
            ? cleanBankName(bankEl.value, nextType)
            : acc.bankName;

        return {
          ...acc,
          selected: selectEl ? Boolean(selectEl.checked) : acc.selected !== false,
          bankName: nextBank,
          accountType: nextType,
          accountNumber: numEl?.value !== undefined ? numEl.value.trim() : acc.accountNumber,
          currency: curEl?.value ? (curEl.value === 'USD' ? 'USD' : 'HNL') : acc.currency,
          currentBalance:
            balEl?.value !== undefined && balEl.value !== ''
              ? cleanAmount(balEl.value)
              : cleanAmount(acc.currentBalance),
        };
      });
    } else {
      this.syncFirstAccountFromPrimaryInputs();
    }

    this.currentExtracted.accountsList = this.currentExtracted.accounts;
    this.currentExtracted.accountsArray = this.currentExtracted.accounts;
    return this.currentExtracted.accounts;
  }

  syncSelectAllAccountsCheckboxState() {
    if (typeof document === 'undefined' || !this.currentExtracted) return;
    const selectAllAccountsCheckbox = document.getElementById('import-account-select-all-accounts');
    const confirmBtn = document.getElementById('btn-confirm-import-account');
    const list = this.currentExtracted.accounts || [];
    const selectedCount = list.filter((a) => a.selected !== false).length;

    if (selectAllAccountsCheckbox) {
      if (list.length === 0) {
        selectAllAccountsCheckbox.checked = false;
        selectAllAccountsCheckbox.indeterminate = false;
        selectAllAccountsCheckbox.disabled = true;
      } else {
        selectAllAccountsCheckbox.disabled = false;
        selectAllAccountsCheckbox.checked = selectedCount === list.length;
        selectAllAccountsCheckbox.indeterminate = selectedCount > 0 && selectedCount < list.length;
      }
    }

    if (confirmBtn && !this.isProcessing) {
      confirmBtn.disabled = selectedCount === 0;
    }
  }

  renderTransactionsTable() {
    if (typeof document === 'undefined' || !this.currentExtracted) return;
    const tbody = document.getElementById('import-account-tx-tbody');
    if (!tbody) return;

    const txs = this.currentExtracted.detectedTransactions || [];
    const currencySelect = document.getElementById('import-acc-currency-select');
    const currency = (currencySelect?.value || this.currentExtracted.currency) === 'USD' ? 'USD' : 'HNL';
    const symbol = currency === 'USD' ? '$' : 'L';

    if (txs.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; padding: 1rem; color: var(--text-secondary);">
            No se detectaron movimientos adicionales en el documento (se guardarán las cuentas seleccionadas con su saldo disponible o puedes agregar una fila manual).
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = txs
      .map((tx, idx) => {
        const isIncome = tx.type === 'income';
        const isChecked = tx.selected !== false && tx.duplicateAction !== DUPLICATE_TRANSACTION_ACTIONS.SKIP;
        const numericAmount = cleanAmount(tx.amount);
        const safeDate = normalizeScanDateToIso(tx.date);
        const dupAction = tx.duplicateAction || DUPLICATE_TRANSACTION_ACTIONS.OVERWRITE;

        const duplicateControlHtml = tx.isDuplicate
          ? `
            <div class="duplicate-tx-inline-alert" style="margin-top: 0.35rem;">
              <div style="font-size: 0.75rem; color: #f59e0b; font-weight: 600; margin-bottom: 0.25rem;">
                ${escapeHtmlAttr(tx.duplicateWarning || formatDuplicateTransactionWarning({ amount: numericAmount, currency, date: safeDate, concept: tx.concept }))}
              </div>
              <select
                class="stmt-cat-select"
                data-import-tx-dup-action="${idx}"
                aria-label="Acción para transacción duplicada ${idx + 1}"
                style="width: 100%; font-size: 0.78rem;"
              >
                <option value="${DUPLICATE_TRANSACTION_ACTIONS.OVERWRITE}" ${dupAction === DUPLICATE_TRANSACTION_ACTIONS.OVERWRITE ? 'selected' : ''}>${DUPLICATE_TRANSACTION_OPTION_LABELS.OVERWRITE}</option>
                <option value="${DUPLICATE_TRANSACTION_ACTIONS.CREATE_NEW}" ${dupAction === DUPLICATE_TRANSACTION_ACTIONS.CREATE_NEW ? 'selected' : ''}>${DUPLICATE_TRANSACTION_OPTION_LABELS.CREATE_NEW}</option>
                <option value="${DUPLICATE_TRANSACTION_ACTIONS.SKIP}" ${dupAction === DUPLICATE_TRANSACTION_ACTIONS.SKIP ? 'selected' : ''}>${DUPLICATE_TRANSACTION_OPTION_LABELS.SKIP}</option>
              </select>
            </div>
          `
          : '';

        return `
          <tr class="${tx.isDuplicate ? 'stmt-row-duplicate' : ''}">
            <td style="width: 40px; text-align: center;">
              <input
                type="checkbox"
                data-import-tx-index="${idx}"
                ${isChecked ? 'checked' : ''}
                aria-label="Seleccionar movimiento ${idx + 1}"
              />
            </td>
            <td style="min-width: 135px;">
              <input
                type="date"
                class="control-date-input"
                data-import-tx-date="${idx}"
                value="${escapeHtmlAttr(safeDate)}"
                aria-label="Fecha del movimiento ${idx + 1}"
                style="width: 100%;"
              />
            </td>
            <td style="min-width: 210px;">
              <input
                type="text"
                class="smart-nlp-input"
                data-import-tx-concept="${idx}"
                value="${escapeHtmlAttr(tx.concept)}"
                placeholder="Concepto o descripción"
                aria-label="Concepto del movimiento ${idx + 1}"
                style="width: 100%; padding: 0.38rem 0.6rem; font-size: 0.85rem;"
              />
              ${duplicateControlHtml}
            </td>
            <td style="min-width: 140px;">
              <select
                class="stmt-cat-select"
                data-import-tx-type="${idx}"
                aria-label="Tipo del movimiento ${idx + 1}"
                style="width: 100%;"
              >
                <option value="income" ${isIncome ? 'selected' : ''}>Ingreso (+ ${symbol})</option>
                <option value="expense" ${!isIncome ? 'selected' : ''}>Gasto (- ${symbol})</option>
              </select>
            </td>
            <td class="num-col" style="min-width: 135px;">
              <input
                type="number"
                step="0.01"
                min="0.01"
                class="smart-nlp-input"
                data-import-tx-amount="${idx}"
                value="${numericAmount}"
                aria-label="Monto del movimiento ${idx + 1}"
                style="width: 100%; text-align: right; padding: 0.38rem 0.6rem; font-size: 0.85rem; font-variant-numeric: tabular-nums;"
              />
            </td>
          </tr>
        `;
      })
      .join('');
  }

  syncTransactionsFromDom() {
    if (!this.currentExtracted) return [];
    if (typeof document === 'undefined') return this.currentExtracted.detectedTransactions;
    const tbody = document.getElementById('import-account-tx-tbody');
    if (!tbody) return this.currentExtracted.detectedTransactions;

    const rows = this.currentExtracted.detectedTransactions.map((tx, idx) => {
      const checkEl = tbody.querySelector(`[data-import-tx-index="${idx}"]`);
      const dateEl = tbody.querySelector(`[data-import-tx-date="${idx}"]`);
      const conceptEl = tbody.querySelector(`[data-import-tx-concept="${idx}"]`);
      const typeEl = tbody.querySelector(`[data-import-tx-type="${idx}"]`);
      const amountEl = tbody.querySelector(`[data-import-tx-amount="${idx}"]`);
      const dupActionEl = tbody.querySelector(`[data-import-tx-dup-action="${idx}"]`);

      const duplicateAction = dupActionEl?.value || tx.duplicateAction || null;
      const isSkipped = duplicateAction === DUPLICATE_TRANSACTION_ACTIONS.SKIP;

      return {
        ...tx,
        selected: isSkipped ? false : checkEl ? Boolean(checkEl.checked) : tx.selected !== false,
        date: dateEl?.value ? normalizeScanDateToIso(dateEl.value) : tx.date,
        concept:
          conceptEl?.value !== undefined
            ? conceptEl.value.trim() || 'Movimiento bancario'
            : tx.concept,
        type: typeEl?.value ? (typeEl.value === 'income' ? 'income' : 'expense') : tx.type,
        amount:
          amountEl?.value !== undefined
            ? Math.abs(cleanAmount(amountEl.value))
            : Math.abs(cleanAmount(tx.amount)),
        ...(duplicateAction ? { duplicateAction } : {}),
        ...(tx.duplicateTxId ? { duplicateTxId: tx.duplicateTxId } : {}),
      };
    });

    this.currentExtracted.detectedTransactions = rows;
    return rows;
  }

  syncSelectAllCheckboxState() {
    if (typeof document === 'undefined' || !this.currentExtracted) return;
    const selectAllCheckbox = document.getElementById('import-account-select-all-tx');
    if (!selectAllCheckbox) return;
    const txs = this.currentExtracted.detectedTransactions || [];
    if (txs.length === 0) {
      selectAllCheckbox.checked = false;
      selectAllCheckbox.disabled = true;
      return;
    }
    selectAllCheckbox.disabled = false;
    selectAllCheckbox.checked = txs.every((tx) => tx.selected !== false);
  }

  syncSummaryBanner() {
    if (typeof document === 'undefined' || !this.currentExtracted) return;
    const currentPayload = this.collectConfirmedPayload();
    const selectedAccounts = (currentPayload.accounts || []).filter((a) => a.selected !== false);
    const selectedTxs = currentPayload.detectedTransactions.filter(
      (t) => t.selected !== false && t.duplicateAction !== DUPLICATE_TRANSACTION_ACTIONS.SKIP
    );
    const summary = formatAccountScanPreviewSummary({
      ...currentPayload,
      status: currentPayload.status || 'Activa',
      detectedTransactions: selectedTxs,
    });

    const summaryTitleEl = document.getElementById('import-account-summary-title');
    const txCountBadgeEl = document.getElementById('import-account-tx-count-badge');
    const confirmBtn = document.getElementById('btn-confirm-import-account');

    if (summaryTitleEl) {
      summaryTitleEl.textContent =
        currentPayload.accounts.length > 1
          ? `${selectedAccounts.length} de ${currentPayload.accounts.length} cuenta(s) seleccionada(s) (${currentPayload.bankName})`
          : summary.accountSummaryTitle;
    }
    if (txCountBadgeEl) {
      txCountBadgeEl.textContent = `${selectedAccounts.length} cuenta(s) · ${selectedTxs.length} de ${currentPayload.detectedTransactions.length} movimiento(s) seleccionado(s)`;
    }
    if (confirmBtn) {
      const count = selectedAccounts.length;
      confirmBtn.textContent =
        count === 1
          ? 'Confirmar y Crear 1 Cuenta'
          : `Confirmar y Crear ${count} Cuentas`;
    }
  }

  collectConfirmedPayload() {
    const editedAccounts = this.syncAccountsFromDom();
    const editedTransactions = this.syncTransactionsFromDom();

    const selectedAccounts = editedAccounts.filter((a) => a.selected !== false);
    const primaryAcc = selectedAccounts[0] || editedAccounts[0] || {};

    const typeInput =
      typeof document !== 'undefined'
        ? document.getElementById('import-acc-type-input')
        : null;
    const numberInput =
      typeof document !== 'undefined'
        ? document.getElementById('import-acc-number-input')
        : null;
    const currencySelect =
      typeof document !== 'undefined'
        ? document.getElementById('import-acc-currency-select')
        : null;
    const balanceInput =
      typeof document !== 'undefined'
        ? document.getElementById('import-acc-balance-input')
        : null;

    const editedAccountType =
      primaryAcc.accountType ||
      typeInput?.value?.trim() ||
      cleanAccountType(this.currentExtracted?.accountType || 'Cuenta de Ahorro');
    const editedBankName =
      primaryAcc.bankName || this.readEditedBankName();
    const editedAccountNumber =
      primaryAcc.accountNumber !== undefined
        ? String(primaryAcc.accountNumber).trim()
        : numberInput?.value !== undefined
          ? numberInput.value.trim()
          : String(this.currentExtracted?.accountNumber ?? '').trim();
    const editedCurrency =
      (primaryAcc.currency || currencySelect?.value || this.currentExtracted?.currency) === 'USD'
        ? 'USD'
        : 'HNL';
    const editedBalance =
      primaryAcc.currentBalance !== undefined
        ? cleanAmount(primaryAcc.currentBalance)
        : balanceInput?.value !== undefined && balanceInput.value !== ''
          ? cleanAmount(balanceInput.value)
          : cleanAmount(this.currentExtracted?.currentBalance ?? 0);

    return ExtractedAccountSchema.parse({
      bankName: editedBankName,
      accountType: editedAccountType,
      accountNumber: editedAccountNumber,
      currency: editedCurrency,
      currentBalance: editedBalance,
      accountsList: editedAccounts,
      accounts: editedAccounts,
      accountsArray: editedAccounts,
      status: this.currentExtracted?.status || 'Activa',
      detectedTransactions: editedTransactions,
    });
  }

  async handleConfirmCreate() {
    if (!this.currentExtracted || this.isProcessing) return;
    this.isProcessing = true;

    const confirmBtn =
      typeof document !== 'undefined'
        ? document.getElementById('btn-confirm-import-account')
        : null;
    if (confirmBtn) confirmBtn.disabled = true;

    try {
      this.reconcileAccountAndTransactionDuplicates();
      const payload = this.collectConfirmedPayload();
      const selectedAccounts = (payload.accountsList || payload.accounts || []).filter(
        (a) => a.selected !== false
      );

      if (selectedAccounts.length === 0) {
        this.showError('Selecciona al menos una cuenta en la lista antes de confirmar.');
        if (confirmBtn) confirmBtn.disabled = false;
        return;
      }

      const state = this.options.getState?.();
      const ctx =
        this.options.getImportContext?.() ||
        this.options.getContext?.() ||
        {};

      for (const confirmedAcc of selectedAccounts) {
        learnAdaptiveAccountPattern(
          confirmedAcc,
          this.lastOcrTextFallback || '',
          ctx.storage
        );
      }

      const learnCheckbox =
        typeof document !== 'undefined'
          ? document.getElementById('import-account-learn-format-checkbox')
          : null;
      const shouldLearnFormat =
        (learnCheckbox ? Boolean(learnCheckbox.checked) : this.learnFormatEnabled !== false) ||
        hasUserEditedExtractedAccounts(this.initialExtractedSnapshot, selectedAccounts);

      if (shouldLearnFormat) {
        const learnedResult = await learnBankTemplateFromConfirmation({
          originalExtracted: this.initialExtractedSnapshot,
          confirmedAccounts: selectedAccounts,
          ocrText: this.lastOcrTextFallback || '',
          bankName: payload.bankName,
          firestoreDb: ctx.firestoreDb,
          firestoreModule: ctx.firestoreModule,
          indexedDb: ctx.indexedDb,
          storage: ctx.storage,
        });
        this.lastLearnedTemplate = learnedResult?.template || null;
      }

      const selectedTransactions = (payload.detectedTransactions || []).filter(
        (tx) => tx.selected !== false && tx.duplicateAction !== DUPLICATE_TRANSACTION_ACTIONS.SKIP
      );

      if (selectedAccounts.length > 1 || (selectedTransactions.length === 0 && !this.matchedExistingAccount)) {
        const batchResult = await saveBatchAccountsToFirestore(
          {
            bankName: payload.bankName,
            accountsList: selectedAccounts,
            accounts: selectedAccounts,
            accountsArray: selectedAccounts,
          },
          state,
          ctx
        );
        const enrichedBatchResult = {
          ...batchResult,
          learnedTemplate: this.lastLearnedTemplate,
        };
        this.setIsImportAccountModalOpen(false);
        this.options.showToast?.(batchResult.toastMessage);
        this.options.onCreated?.(enrichedBatchResult);
        this.options.onAccountCreated?.(
          batchResult.createdAccounts?.[0] || null,
          [],
          enrichedBatchResult
        );
        return enrichedBatchResult;
      }

      if (this.matchedExistingAccount?.id) {
        ctx.existingAccountId = this.matchedExistingAccount.id;
      }

      const created = await persistImportedAccountAndTransactions(payload, state, ctx);
      const enrichedCreated = {
        ...created,
        learnedTemplate: this.lastLearnedTemplate,
      };
      this.setIsImportAccountModalOpen(false);
      this.options.showToast?.(created.toastMessage);
      this.options.onCreated?.(enrichedCreated);
      this.options.onAccountCreated?.(created.account, created.transactions, enrichedCreated);
      return enrichedCreated;
    } catch (err) {
      this.showError(err?.message || 'Error al guardar la cuenta y movimientos.');
      if (confirmBtn) confirmBtn.disabled = false;
      return null;
    } finally {
      this.isProcessing = false;
    }
  }
}

if (typeof globalThis !== 'undefined') {
  globalThis.__PISTO_IMPORT_ACCOUNT_MODAL__ = ImportAccountModal;
  globalThis.openImportModal = openImportModal;
}

export default ImportAccountModal;
