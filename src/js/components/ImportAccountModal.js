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
  ExtractedAccountSchema,
} from '../../../public/js/services/accountExtractor.js';
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

export {
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
};

export const HONDURAS_BANKS_LIST = Object.freeze([
  'Banco Atlántida',
  'BAC Credomatic',
  'Banco Ficohsa',
  'Banpaís (Banco del País)',
  'Banco de Occidente',
  'Davivienda',
  'Promerica',
  'Otro / Personalizado',
]);

const BANK_UI_GARBAGE_REGEX =
  /[©®™=<>|_~^•*«»]|--|\b\d{1,2}:\d{2}\b|\b(?:4G|5G|LTE|WIFI|VOLTE)\b|\bdetalle\s+de\s+cuenta\b|\bbal\s*all\b|\bsaldo\s+disponible\b|\bconsulta\s+de\b/i;

export function cleanBankName(rawText, contextHint = '') {
  const raw = String(rawText ?? '').trim();
  const hint = String(contextHint ?? '').trim();
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
    return 'Promerica';
  }

  if (/\bsos\b/i.test(combined) || /\bcuenta\s+de\s+ahorro\s+sos\b/i.test(combined)) {
    return 'Banco Atlántida';
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
    this.isImportAccountModalOpen = false;
    this.isProcessing = false;
    this.matchedExistingAccount = null;
    this.agentADK = useAccountAgentADK({
      notifyToast: (msg) => this.options.showToast?.(msg),
    });
  }

  init() {
    this.ensureModalDom();
    this.bindTriggerButtons();
    this.bindDialogInternalEvents();
  }

  bindDialogInternalEvents() {
    if (typeof document === 'undefined') return;
    const dialog = document.getElementById('import-account-dialog');
    if (!dialog) return;

    this.populateBankOptions();
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

    const fileInput = document.getElementById('import-account-file-input');
    const dropzone = document.getElementById('import-account-dropzone');
    const triggerBtn = document.getElementById('btn-trigger-import-account-file');
    const demoAdkBtn = document.getElementById('btn-import-account-demo-adk');
    const confirmBtn = document.getElementById('btn-confirm-import-account');
    const cancelBtn = document.getElementById('btn-cancel-import-account');
    const closeBtn = document.getElementById('btn-close-import-account');
    const selectAllCheckbox = document.getElementById('import-account-select-all-tx');
    const addTxRowBtn = document.getElementById('btn-import-account-add-tx');
    const tbody = document.getElementById('import-account-tx-tbody');

    const bankSelect = document.getElementById('import-acc-bank-select');
    const bankInput = document.getElementById('import-acc-bank-input');

    triggerBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fileInput?.click();
    });

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
      fileInput?.click();
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

    fileInput?.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) {
        this.handleFileSelected(file);
      }
      fileInput.value = '';
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
        this.currentExtracted.bankName = this.readEditedBankName();
      }
      this.syncSummaryBanner();
    });

    bankInput?.addEventListener('input', () => {
      const typed = bankInput.value.trim();
      if (bankSelect) {
        const matchedOption = HONDURAS_BANKS_LIST.find(
          (b) => b !== 'Otro / Personalizado' && b.toLowerCase() === typed.toLowerCase()
        );
        bankSelect.value = matchedOption || 'Otro / Personalizado';
      }
      if (this.currentExtracted) {
        this.currentExtracted.bankName = typed || HONDURAS_BANKS_LIST[0];
      }
      this.syncSummaryBanner();
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
        if (id === 'import-acc-number-input') {
          this.reconcileAccountAndTransactionDuplicates();
        }
        this.syncSummaryBanner();
      });
      document.getElementById(id)?.addEventListener('change', () => {
        if (id === 'import-acc-currency-select' || id === 'import-acc-number-input') {
          this.syncTransactionsFromDom();
          this.reconcileAccountAndTransactionDuplicates();
          this.renderTransactionsTable();
        }
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

  populateBankOptions() {
    const bankSelect = document.getElementById('import-acc-bank-select');
    const datalist = document.getElementById('import-acc-bank-datalist');

    if (bankSelect && bankSelect.options.length === 0) {
      bankSelect.innerHTML = HONDURAS_BANKS_LIST.map(
        (bank) => `<option value="${escapeHtmlAttr(bank)}">${escapeHtmlAttr(bank)}</option>`
      ).join('');
    }

    if (datalist && datalist.children.length === 0) {
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
              Extrae los datos de tu cuenta y edita cualquier campo o movimiento antes de guardar en Firestore.
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
              Detecta automáticamente Banco de Honduras, Tipo de Cuenta, Número Completo, Moneda, Saldo y Movimientos.
            </p>
            <div style="display: flex; justify-content: center; gap: 0.5rem; flex-wrap: wrap;">
              <button type="button" class="btn-secondary btn-sm" id="btn-trigger-import-account-file">
                Seleccionar Imagen o PDF
              </button>
              <button type="button" class="btn-secondary btn-sm" id="btn-import-account-demo-adk">
                🤖 Cargar Demo ADK (Atlántida L 3,901.33)
              </button>
            </div>
          </div>

          <div id="import-account-loading-box" class="voucher-progress-box is-hidden" role="status" aria-live="polite">
            <div class="voucher-progress-labels">
              <span id="import-account-loading-text">🤖 Analizando estado de cuenta con Gemini Vision...</span>
            </div>
            <progress class="native-progress" max="100"></progress>
          </div>

          <div id="import-account-error-box" class="error-msg is-hidden" role="alert"></div>

          <div id="import-account-duplicate-banner-box" class="duplicate-tx-warning-banner is-hidden" role="alert"></div>

          <div id="import-account-preview-box" class="is-hidden" style="display: flex; flex-direction: column; gap: 1rem;">
            <div style="display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; flex-wrap: wrap; padding: 0.75rem 1rem; border-radius: 12px; background: var(--bg-elevated); border: 1px solid var(--surface-border);">
              <div>
                <strong id="import-account-summary-title" style="font-size: 0.95rem;">Cuenta detectada</strong>
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

            <div class="form-grid-2">
              <div class="field">
                <label for="import-acc-bank-select">Nombre del Banco (Honduras)</label>
                <select id="import-acc-bank-select" name="bankSelect"></select>
              </div>

              <div class="field" id="import-acc-bank-custom-wrapper">
                <label for="import-acc-bank-input">Nombre del Banco (Editable / Autocompletado)</label>
                <input
                  type="text"
                  id="import-acc-bank-input"
                  name="bankName"
                  list="import-acc-bank-datalist"
                  placeholder="Ej. Banco Atlántida"
                  required
                />
                <datalist id="import-acc-bank-datalist"></datalist>
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
              Confirmar y Crear Cuenta
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
      loadingText.textContent = '🤖 Analizando estado de cuenta con Gemini Vision...';
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

      let ocrTextFallback = '';
      if (typeof this.options.extractOcrFallbackText === 'function') {
        try {
          ocrTextFallback = await this.options.extractOcrFallbackText(file, (status) => {
            if (loadingText && status) loadingText.textContent = status;
          });
        } catch {
          ocrTextFallback = '';
        }
      }

      const ctx = this.options.getImportContext?.() || {};
      const adkResult = await this.agentADK.analyzeFile(file, {
        apiKey: ctx.apiKey,
        ocrTextFallback,
        fetchImpl: ctx.fetchImpl,
      });

      const sanitizedData = this.sanitizeExtractedData(adkResult.data, ocrTextFallback);
      this.currentExtracted = sanitizedData;
      this.reconcileAccountAndTransactionDuplicates();
      this.renderPreview(this.currentExtracted, adkResult.source);
      if (adkResult.isDemoFallback) {
        this.options.showToast?.(adkResult.message);
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
   * Verifica si la cuenta importada ya existe por `accountNumber` y si alguno de sus
   * movimientos detectados coincide con transacciones existentes (`accountId` + `date` + `amount` + `concept` similar).
   */
  reconcileAccountAndTransactionDuplicates() {
    if (!this.currentExtracted) return;
    const state = this.options.getState?.() || globalThis.pistoApp?.state || null;
    const accounts = Array.isArray(state?.accounts) ? state.accounts : [];
    const transactions = Array.isArray(state?.transactions) ? state.transactions : [];

    const numberInput =
      typeof document !== 'undefined' ? document.getElementById('import-acc-number-input') : null;
    const currentAccNumber = String(
      numberInput?.value !== undefined ? numberInput.value : this.currentExtracted.accountNumber || ''
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
    const currency = this.currentExtracted.currency || 'HNL';

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

    const cleanedTransactions = (rawData?.detectedTransactions || []).map((tx, idx) => ({
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

    return {
      ...rawData,
      bankName: cleanedBank,
      accountType: cleanedAccountType,
      accountNumber: String(rawData?.accountNumber ?? '').trim(),
      currency: rawData?.currency === 'USD' ? 'USD' : 'HNL',
      currentBalance: cleanAmount(rawData?.currentBalance ?? 0),
      status: rawData?.status || 'Activa',
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

    const typedVal = bankInput?.value?.trim() || '';
    const selectVal = bankSelect?.value?.trim() || '';

    if (typedVal) {
      return cleanBankName(typedVal, this.currentExtracted?.accountType || '');
    }
    if (selectVal && selectVal !== 'Otro / Personalizado') {
      return selectVal;
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

    const previewBox = document.getElementById('import-account-preview-box');
    const sourceBadge = document.getElementById('import-account-source-badge');
    const confirmBtn = document.getElementById('btn-confirm-import-account');

    const bankSelect = document.getElementById('import-acc-bank-select');
    const bankInput = document.getElementById('import-acc-bank-input');
    const typeInput = document.getElementById('import-acc-type-input');
    const numberInput = document.getElementById('import-acc-number-input');
    const currencySelect = document.getElementById('import-acc-currency-select');
    const balanceInput = document.getElementById('import-acc-balance-input');

    const resolvedBank = cleanBankName(sanitized.bankName, sanitized.accountType);
    if (bankInput) {
      bankInput.value = resolvedBank;
    }
    if (bankSelect) {
      const matchingOption = HONDURAS_BANKS_LIST.find(
        (b) => b !== 'Otro / Personalizado' && b.toLowerCase() === resolvedBank.toLowerCase()
      );
      bankSelect.value = matchingOption || 'Otro / Personalizado';
    }

    if (typeInput) typeInput.value = sanitized.accountType || 'Cuenta de Ahorro';
    if (numberInput) numberInput.value = sanitized.accountNumber || '';
    if (currencySelect) currencySelect.value = sanitized.currency === 'USD' ? 'USD' : 'HNL';
    if (balanceInput) balanceInput.value = String(cleanAmount(sanitized.currentBalance));

    if (sourceBadge) {
      sourceBadge.textContent =
        source.includes('gemini') || source.includes('genkit')
          ? '🤖 Gemini Vision'
          : '⚡ Extractor OCR/PDF';
    }

    this.reconcileAccountAndTransactionDuplicates();
    this.renderTransactionsTable();
    this.syncSelectAllCheckboxState();
    this.syncSummaryBanner();

    previewBox?.classList.remove('is-hidden');
    if (confirmBtn) confirmBtn.disabled = false;
  }

  renderTransactionsTable() {
    const tbody = document.getElementById('import-account-tx-tbody');
    if (!tbody || !this.currentExtracted) return;

    const txs = this.currentExtracted.detectedTransactions || [];
    const currencySelect = document.getElementById('import-acc-currency-select');
    const currency = (currencySelect?.value || this.currentExtracted.currency) === 'USD' ? 'USD' : 'HNL';
    const symbol = currency === 'USD' ? '$' : 'L';

    if (txs.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; padding: 1rem; color: var(--text-secondary);">
            No se detectaron movimientos adicionales en el documento (se creará la cuenta con su saldo disponible o puedes agregar una fila manual).
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
    const selectAllCheckbox = document.getElementById('import-account-select-all-tx');
    if (!selectAllCheckbox || !this.currentExtracted) return;
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
    if (!this.currentExtracted) return;
    const currentPayload = this.collectConfirmedPayload();
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
    if (summaryTitleEl) summaryTitleEl.textContent = summary.accountSummaryTitle;
    if (txCountBadgeEl) {
      txCountBadgeEl.textContent = `${selectedTxs.length} de ${currentPayload.detectedTransactions.length} movimiento(s) seleccionado(s)`;
    }
  }

  collectConfirmedPayload() {
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

    const editedTransactions = this.syncTransactionsFromDom();
    const editedAccountType =
      typeInput?.value?.trim() ||
      cleanAccountType(this.currentExtracted?.accountType || 'Cuenta de Ahorro');
    const editedBankName = this.readEditedBankName();
    const editedAccountNumber =
      numberInput?.value !== undefined
        ? numberInput.value.trim()
        : String(this.currentExtracted?.accountNumber ?? '').trim();
    const editedCurrency =
      (currencySelect?.value || this.currentExtracted?.currency) === 'USD' ? 'USD' : 'HNL';
    const editedBalance =
      balanceInput?.value !== undefined && balanceInput.value !== ''
        ? cleanAmount(balanceInput.value)
        : cleanAmount(this.currentExtracted?.currentBalance ?? 0);

    return ExtractedAccountSchema.parse({
      bankName: editedBankName,
      accountType: editedAccountType,
      accountNumber: editedAccountNumber,
      currency: editedCurrency,
      currentBalance: editedBalance,
      status: this.currentExtracted?.status || 'Activa',
      detectedTransactions: editedTransactions,
    });
  }

  async handleConfirmCreate() {
    if (!this.currentExtracted || this.isProcessing) return;
    this.isProcessing = true;

    const confirmBtn = document.getElementById('btn-confirm-import-account');
    if (confirmBtn) confirmBtn.disabled = true;

    try {
      this.reconcileAccountAndTransactionDuplicates();
      const payload = this.collectConfirmedPayload();
      const state = this.options.getState?.();
      const ctx = this.options.getImportContext?.() || {};

      if (this.matchedExistingAccount?.id) {
        ctx.existingAccountId = this.matchedExistingAccount.id;
      }

      const created = await persistImportedAccountAndTransactions(payload, state, ctx);
      this.setIsImportAccountModalOpen(false);
      this.options.showToast?.(created.toastMessage);
      this.options.onCreated?.(created);
    } catch (err) {
      this.showError(err?.message || 'Error al guardar la cuenta y movimientos.');
      if (confirmBtn) confirmBtn.disabled = false;
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
