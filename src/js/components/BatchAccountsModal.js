/**
 * @fileoverview Modal de Confirmación e Importación Masiva en Lote de Cuentas y Tarjetas
 * (`src/js/components/BatchAccountsModal.js`) en JavaScript Vanilla (ESNext).
 *
 * Implementa:
 * 1. Tabla/lista responsiva con checkboxes para cada producto detectado en la imagen o PDF ("Resumen de Productos"):
 *    - [x] HN - CUENTA BANCARIA | N.° 726935871 | 401.28 HNL
 *    - [x] HN - CUENTA BANCARIA | N.° 751666931 | 3,705.95 USD
 *    - [x] HN - Negocio Lempiras | N.° 758886371 | 5,963.18 HNL
 *    - [x] AMERICAN EXPRESS | N.° 3244 | 8,154.03 HNL
 * 2. Filas 100% editables antes de confirmar (nombre/tipo, número de cuenta, moneda HNL/USD, saldo Float y categoría Cuenta/Tarjeta).
 * 3. Opción "Seleccionar / Deseleccionar todas" y selector de institución bancaria (`bankName`).
 * 4. Guardado Atómico en Lote (`saveBatchAccountsToFirestore` con `writeBatch` en Firestore) y deduplicación por `accountNumber` en `workspaceId`:
 *    - Toast: "🎉 Se registraron X cuentas exitosamente (y se omitieron N duplicadas)."
 * 5. Cero llamadas a `console.log` y cumplimiento de `modern-web-guidance` (`<dialog closedby="any">` + fallback light-dismiss).
 */

import {
  cleanAmount,
  BATCH_DEMO_PRODUCTS_SUMMARY,
  normalizeExtractorBankName,
  normalizeExtractedAccountItem,
  validateExtractedAccount,
  saveBatchAccountsToFirestore,
  fetchExistingWorkspaceAccountNumbers,
  formatBatchAccountsToastMessage,
} from '../services/accountExtractor.js';
import { attachDialogLightDismissFallback } from '../../../public/js/ui/keypadModal.js';

export {
  BATCH_DEMO_PRODUCTS_SUMMARY,
  saveBatchAccountsToFirestore,
  fetchExistingWorkspaceAccountNumbers,
  formatBatchAccountsToastMessage,
};

export const BATCH_ACCOUNTS_DIALOG_ID = 'batch-accounts-dialog';

export const BATCH_BANKS_LIST = Object.freeze([
  'BAC Credomatic',
  'Banco Atlántida',
  'Banco Ficohsa',
  'Banpaís (Banco del País)',
  'Banco de Occidente',
  'Davivienda',
  'Promerica',
  'Otro / Personalizado',
]);

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Formatea un monto numérico con separadores de miles y 2 decimales (ej. 3705.95 -> "3,705.95").
 * @param {number} amount
 * @returns {string}
 */
export function formatBatchBalanceNumber(amount) {
  const num = cleanAmount(amount);
  return num.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Formatea la etiqueta resumen de una fila de producto en lote:
 * `"[x] HN - CUENTA BANCARIA | N.° 726935871 | 401.28 HNL"`
 *
 * @param {{ selected?: boolean, accountType?: string, accountNumber?: string, currentBalance?: number, currency?: string }} item
 * @returns {string}
 */
export function formatBatchAccountRowSummary(item = {}) {
  const checkMark = item.selected !== false ? '[x]' : '[ ]';
  const label = String(item.accountType || 'Cuenta Bancaria').trim();
  const number = String(item.accountNumber || '0000').trim();
  const formattedBal = formatBatchBalanceNumber(item.currentBalance ?? 0);
  const currency = item.currency === 'USD' ? 'USD' : 'HNL';
  return `${checkMark} ${label} | N.° ${number} | ${formattedBal} ${currency}`;
}

/**
 * Renderiza las filas editables de la tabla de confirmación en lote.
 * @param {Array<object>} accountsArray
 * @param {Set<string>} [existingNumbers]
 * @returns {string}
 */
export function renderBatchAccountsRowsMarkup(accountsArray = [], existingNumbers = new Set()) {
  if (!Array.isArray(accountsArray) || accountsArray.length === 0) {
    return `
      <tr>
        <td colspan="8" class="batch-accounts-empty-cell">
          No hay cuentas en la lista. Haz clic en "+ Agregar Cuenta" o selecciona una imagen/PDF.
        </td>
      </tr>
    `;
  }

  return accountsArray
    .map((rawItem, idx) => {
      const item = normalizeExtractedAccountItem(rawItem, idx);
      const isChecked = item.selected !== false;
      const cleanNum = String(item.accountNumber || '').replace(/[\s-]/g, '').trim();
      const isAlreadyRegistered = Boolean(cleanNum && existingNumbers.has(cleanNum));
      const summaryLine = formatBatchAccountRowSummary(item);

      return `
        <tr
          class="batch-account-row ${isChecked ? 'is-selected' : 'is-unselected'} ${isAlreadyRegistered ? 'is-existing-duplicate' : ''}"
          data-batch-row-index="${idx}"
        >
          <td class="batch-col-check" data-label="Seleccionar">
            <input
              type="checkbox"
              id="batch-acc-check-${idx}"
              name="batch_acc_selected_${idx}"
              class="batch-row-checkbox"
              data-batch-acc-index="${idx}"
              data-batch-row-check="${idx}"
              data-batch-acc-field="selected"
              ${isChecked ? 'checked' : ''}
              aria-label="Seleccionar ${escapeHtml(item.accountType)} N.° ${escapeHtml(item.accountNumber)}"
            />
          </td>
          <td class="batch-col-bank" data-label="Banco">
            <input
              type="text"
              id="batch-acc-bank-${idx}"
              name="batch_acc_bank_${idx}"
              class="control-input batch-inline-input batch-row-input"
              data-batch-acc-field="bankName"
              data-batch-acc-row="${idx}"
              data-batch-row-bank="${idx}"
              list="import-acc-bank-datalist"
              value="${escapeHtml(item.bankName || 'BAC Credomatic')}"
              aria-label="Nombre de banco fila ${idx + 1}"
              required
            />
          </td>
          <td class="batch-col-type" data-label="Tipo de Cuenta">
            <div class="batch-type-cell-stack">
              <input
                type="text"
                id="batch-acc-type-${idx}"
                name="batch_acc_type_${idx}"
                class="control-input batch-inline-input batch-row-input"
                data-batch-acc-field="accountType"
                data-batch-acc-row="${idx}"
                data-batch-row-type="${idx}"
                value="${escapeHtml(item.accountType)}"
                aria-label="Nombre o tipo de producto fila ${idx + 1}"
                required
              />
              <span class="batch-row-preview-pill batch-row-summary-pill" data-batch-summary-pill="${idx}">
                ${escapeHtml(summaryLine)}
              </span>
              ${
                isAlreadyRegistered
                  ? `<span class="batch-duplicate-badge" role="status">⚠️ N.° ${escapeHtml(cleanNum)} ya existe en tu espacio (se omitirá al guardar)</span>`
                  : ''
              }
            </div>
          </td>
          <td class="batch-col-number" data-label="N.° Completo">
            <div class="batch-number-input-group">
              <span class="batch-number-prefix" aria-hidden="true">N.°</span>
              <input
                type="text"
                id="batch-acc-number-${idx}"
                name="batch_acc_number_${idx}"
                class="control-input batch-inline-input batch-mono-input batch-row-input"
                data-batch-acc-field="accountNumber"
                data-batch-acc-row="${idx}"
                data-batch-row-number="${idx}"
                value="${escapeHtml(item.accountNumber)}"
                inputmode="numeric"
                aria-label="Número de cuenta o últimos 4 dígitos fila ${idx + 1}"
                required
              />
            </div>
          </td>
          <td class="batch-col-currency" data-label="Moneda">
            <select
              id="batch-acc-currency-${idx}"
              name="batch_acc_currency_${idx}"
              class="control-select batch-inline-select batch-row-select"
              data-batch-acc-field="currency"
              data-batch-acc-row="${idx}"
              data-batch-row-currency="${idx}"
              aria-label="Moneda fila ${idx + 1}"
            >
              <option value="HNL" ${item.currency === 'HNL' ? 'selected' : ''}>HNL (LPS)</option>
              <option value="USD" ${item.currency === 'USD' ? 'selected' : ''}>USD ($)</option>
            </select>
          </td>
          <td class="batch-col-balance" data-label="Saldo">
            <input
              type="number"
              step="0.01"
              id="batch-acc-balance-${idx}"
              name="batch_acc_balance_${idx}"
              class="control-input batch-inline-input batch-balance-input batch-row-input"
              data-batch-acc-field="currentBalance"
              data-batch-acc-row="${idx}"
              data-batch-row-balance="${idx}"
              value="${Number(item.currentBalance || 0).toFixed(2)}"
              aria-label="Saldo actual fila ${idx + 1}"
              required
            />
          </td>
          <td class="batch-col-category" data-label="Categoría">
            <select
              id="batch-acc-is-card-${idx}"
              name="batch_acc_is_card_${idx}"
              class="control-select batch-inline-select batch-row-select"
              data-batch-acc-field="isCreditCard"
              data-batch-acc-row="${idx}"
              data-batch-row-card="${idx}"
              aria-label="Categoría de producto fila ${idx + 1}"
            >
              <option value="false" ${!item.isCreditCard ? 'selected' : ''}>🏦 Cuenta Bancaria</option>
              <option value="true" ${item.isCreditCard ? 'selected' : ''}>💳 Tarjeta de Crédito</option>
            </select>
          </td>
          <td class="batch-col-actions" data-label="Acción" style="text-align: center;">
            <button
              type="button"
              class="btn-secondary btn-sm btn-remove-extracted-account"
              data-batch-acc-remove="${idx}"
              data-batch-row-remove="${idx}"
              aria-label="Eliminar cuenta ${escapeHtml(item.accountType)} fila ${idx + 1}"
              title="Quitar esta cuenta de la lista"
            >🗑️ Quitar</button>
          </td>
        </tr>
      `;
    })
    .join('');
}

export class BatchAccountsModal {
  /**
   * @param {object} [options]
   * @param {function} [options.getState]
   * @param {function} [options.getImportContext]
   * @param {function} [options.onSaved]
   * @param {function} [options.onClose]
   * @param {function} [options.showToast]
   */
  constructor(options = {}) {
    this.options = options;
    this.bankName = 'BAC Credomatic';
    this.accountsArray = [];
    this.existingAccountNumbers = new Set();
    this.isOpen = false;
    this.isSaving = false;
    this.dialogEl = null;
  }

  get rows() {
    return this.accountsArray;
  }

  set rows(nextRows) {
    this.accountsArray = Array.isArray(nextRows) ? nextRows : [];
  }

  init() {
    this.ensureModalDom();
    this.bindEvents();
    return this;
  }

  ensureModalDom() {
    if (typeof document === 'undefined') return null;

    let dialog = document.getElementById(BATCH_ACCOUNTS_DIALOG_ID);
    if (!dialog && document.body) {
      dialog = document.createElement('dialog');
      dialog.id = BATCH_ACCOUNTS_DIALOG_ID;
      dialog.className = 'modal-dialog modal-dialog-wide batch-accounts-modal';
      dialog.setAttribute('closedby', 'any');
      dialog.setAttribute('aria-labelledby', 'batch-accounts-modal-title');
      dialog.innerHTML = `
        <div class="modal-header">
          <div>
            <span class="batch-modal-kicker">✨ Importación Masiva Inteligente · Gemini Vision</span>
            <h2 id="batch-accounts-modal-title">📦 Confirmar Resumen de Productos en Lote</h2>
            <p class="batch-modal-subtitle">
              Revisa, edita o selecciona las cuentas bancarias y tarjetas detectadas antes de guardarlas en un solo lote atómico.
            </p>
          </div>
          <button
            type="button"
            class="btn-icon"
            id="btn-close-batch-accounts-modal"
            aria-label="Cerrar modal de importación por lote"
          >✕</button>
        </div>

        <form id="batch-accounts-form" class="modal-body batch-accounts-form" novalidate>
          <div class="batch-accounts-toolbar">
            <div class="field batch-bank-field">
              <label for="batch-accounts-bank-select">Institución Bancaria Detectada</label>
              <select id="batch-accounts-bank-select" name="bankName" class="control-select">
                ${BATCH_BANKS_LIST.map(
                  (b) => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`
                ).join('')}
              </select>
            </div>

            <div class="batch-toolbar-actions">
              <label class="batch-select-all-label" for="batch-accounts-select-all">
                <input
                  type="checkbox"
                  id="batch-accounts-select-all"
                  name="select_all_accounts"
                  checked
                />
                <span>Seleccionar / Deseleccionar todas</span>
              </label>
              <button
                type="button"
                id="btn-batch-toggle-select-all"
                class="btn-secondary btn-sm"
              >
                Seleccionar / Deseleccionar todas
              </button>
              <button
                type="button"
                id="btn-batch-add-product-row"
                class="btn-secondary btn-sm"
              >
                + Agregar Producto
              </button>
            </div>
          </div>

          <div
            id="batch-accounts-summary-banner"
            class="batch-accounts-summary-banner"
            role="status"
            aria-live="polite"
          ></div>

          <div class="batch-accounts-table-wrap">
            <table class="batch-accounts-table" aria-label="Productos financieros detectados en lote">
              <thead>
                <tr>
                  <th scope="col" style="width: 44px;">✓</th>
                  <th scope="col">Cuenta / Tarjeta (Editable)</th>
                  <th scope="col">N.° de Producto</th>
                  <th scope="col" style="width: 125px;">Moneda</th>
                  <th scope="col" style="width: 150px;">Saldo Actual</th>
                  <th scope="col" style="width: 175px;">Sección</th>
                </tr>
              </thead>
              <tbody id="batch-accounts-tbody"></tbody>
            </table>
          </div>

          <div class="modal-footer batch-accounts-footer">
            <button
              type="button"
              id="btn-cancel-batch-accounts"
              class="btn-secondary"
            >
              Cancelar
            </button>
            <button
              type="submit"
              id="btn-save-batch-accounts"
              class="btn-primary"
            >
              💾 Guardar Cuentas Seleccionadas
            </button>
          </div>
        </form>
      `;
      document.body.appendChild(dialog);
    }

    this.dialogEl = dialog;
    return dialog;
  }

  bindEvents() {
    if (typeof document === 'undefined') return;
    const dialog = this.ensureModalDom();
    if (!dialog || dialog.dataset.boundBatchModal === 'true') return;
    dialog.dataset.boundBatchModal = 'true';

    attachDialogLightDismissFallback(dialog);

    dialog.addEventListener('close', () => {
      this.isOpen = false;
      this.options.onClose?.();
    });

    const closeBtn = document.getElementById('btn-close-batch-accounts-modal');
    const cancelBtn = document.getElementById('btn-cancel-batch-accounts');
    const bankSelect = document.getElementById('batch-accounts-bank-select');
    const selectAllCheckbox = document.getElementById('batch-accounts-select-all');
    const toggleAllBtn = document.getElementById('btn-batch-toggle-select-all');
    const addRowBtn = document.getElementById('btn-batch-add-product-row');
    const tbody = document.getElementById('batch-accounts-tbody');
    const form = document.getElementById('batch-accounts-form');

    closeBtn?.addEventListener('click', () => this.close());
    cancelBtn?.addEventListener('click', () => this.close());

    bankSelect?.addEventListener('change', () => {
      this.bankName = bankSelect.value || 'BAC Credomatic';
      this.updateSummaryBanner();
    });

    selectAllCheckbox?.addEventListener('change', () => {
      this.syncRowsFromDom();
      this.toggleAllSelection(Boolean(selectAllCheckbox.checked));
    });

    toggleAllBtn?.addEventListener('click', () => {
      this.syncRowsFromDom();
      const allSelected =
        this.accountsArray.length > 0 &&
        this.accountsArray.every((item) => item.selected !== false);
      this.toggleAllSelection(!allSelected);
    });

    addRowBtn?.addEventListener('click', () => {
      this.syncRowsFromDom();
      this.accountsArray.push(
        normalizeExtractedAccountItem(
          {
            accountType: 'HN - CUENTA BANCARIA',
            accountNumber: '',
            currency: 'HNL',
            currentBalance: 0,
            isCreditCard: false,
            selected: true,
          },
          this.accountsArray.length,
          this.bankName
        )
      );
      this.renderTable();
      this.updateSummaryBanner();
    });

    const handleRowInput = (event) => {
      const target = event.target;
      if (!target) return;

      if (target.hasAttribute?.('data-batch-acc-index')) {
        const idx = Number.parseInt(target.getAttribute('data-batch-acc-index') || '-1', 10);
        if (idx >= 0 && idx < this.accountsArray.length) {
          this.accountsArray[idx].selected = Boolean(target.checked);
          const rowEl = target.closest('tr');
          if (rowEl) {
            rowEl.classList.toggle('is-selected', Boolean(target.checked));
            rowEl.classList.toggle('is-unselected', !target.checked);
          }
          this.updateRowSummaryPill(idx);
          this.syncSelectAllCheckbox();
          this.updateSummaryBanner();
        }
        return;
      }

      if (target.hasAttribute?.('data-batch-acc-row')) {
        const idx = Number.parseInt(target.getAttribute('data-batch-acc-row') || '-1', 10);
        const field = target.getAttribute('data-batch-acc-field');
        if (idx >= 0 && idx < this.accountsArray.length && field) {
          const item = this.accountsArray[idx];
          if (field === 'bankName') {
            item.bankName = normalizeExtractorBankName(target.value, item.accountType);
          } else if (field === 'accountType') {
            item.accountType = String(target.value || '').trim() || 'Cuenta Bancaria';
          } else if (field === 'accountNumber') {
            item.accountNumber = String(target.value || '').trim();
          } else if (field === 'currency') {
            item.currency = target.value === 'USD' ? 'USD' : 'HNL';
          } else if (field === 'currentBalance') {
            item.currentBalance = cleanAmount(target.value);
          } else if (field === 'isCreditCard') {
            item.isCreditCard = target.value === 'true';
          }
          this.updateRowSummaryPill(idx);
          this.updateSummaryBanner();
        }
      }
    };

    tbody?.addEventListener('input', handleRowInput);
    tbody?.addEventListener('change', handleRowInput);
    tbody?.addEventListener('click', (event) => {
      const removeBtn = event.target?.closest?.('[data-batch-acc-remove]');
      if (!removeBtn) return;
      const idx = Number.parseInt(removeBtn.getAttribute('data-batch-acc-remove') || '-1', 10);
      if (idx >= 0) {
        this.removeRow(idx);
      }
    });

    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.handleSaveSelectedAccounts();
    });
  }

  updateRowSummaryPill(idx) {
    if (typeof document === 'undefined') return;
    const item = this.accountsArray[idx];
    if (!item) return;
    const pill = document.querySelector(`[data-batch-summary-pill="${idx}"]`);
    if (pill) {
      pill.textContent = formatBatchAccountRowSummary(item);
    }
  }

  toggleAllSelection(checked) {
    this.accountsArray = this.accountsArray.map((item) => ({
      ...item,
      selected: Boolean(checked),
    }));
    this.renderTable();
    this.syncSelectAllCheckbox();
    this.updateSummaryBanner();
  }

  toggleSelectAll(checked) {
    return this.toggleAllSelection(checked);
  }

  removeRow(idx) {
    if (idx < 0 || idx >= this.accountsArray.length) return this.accountsArray;
    this.syncRowsFromDom();
    this.accountsArray.splice(idx, 1);
    this.renderTable();
    this.syncSelectAllCheckbox();
    this.updateSummaryBanner();
    return this.accountsArray;
  }

  updateRowField(idx, field, value) {
    if (idx < 0 || idx >= this.accountsArray.length) return null;
    const item = this.accountsArray[idx];
    if (field === 'selected') {
      item.selected = Boolean(value);
    } else if (field === 'bankName') {
      item.bankName = normalizeExtractorBankName(value, item.accountType);
    } else if (field === 'accountType') {
      item.accountType = String(value || '').trim() || 'Cuenta Bancaria';
    } else if (field === 'accountNumber') {
      item.accountNumber = String(value || '').trim();
      const cleanNum = item.accountNumber.replace(/[\s-]/g, '').trim();
      item.alreadyExists = Boolean(cleanNum && this.existingAccountNumbers.has(cleanNum));
    } else if (field === 'currency') {
      item.currency = String(value || '').toUpperCase().includes('USD') ? 'USD' : 'HNL';
    } else if (field === 'currentBalance') {
      item.currentBalance = cleanAmount(value);
    } else if (field === 'isCreditCard') {
      item.isCreditCard = Boolean(value === true || value === 'true');
    }
    this.updateRowSummaryPill(idx);
    this.updateSummaryBanner();
    return item;
  }

  loadBatchPayload(payload = BATCH_DEMO_PRODUCTS_SUMMARY) {
    const validated = validateExtractedAccount(payload);
    this.bankName = validated.bankName || 'BAC Credomatic';

    const state = this.options.getState?.() || null;
    const localExisting = new Set(
      (state?.accounts || [])
        .map((a) => String(a?.accountNumber || '').replace(/[\s-]/g, '').trim())
        .filter(Boolean)
    );
    for (const num of this.existingAccountNumbers) {
      localExisting.add(num);
    }
    this.existingAccountNumbers = localExisting;

    this.accountsArray = (validated.accountsArray || []).map((rawItem, idx) => {
      const normalized = normalizeExtractedAccountItem(rawItem, idx, this.bankName);
      const cleanNum = String(normalized.accountNumber || '').replace(/[\s-]/g, '').trim();
      return {
        ...normalized,
        alreadyExists: Boolean(cleanNum && this.existingAccountNumbers.has(cleanNum)),
      };
    });

    this.renderTable();
    this.updateSummaryBanner();
    return this.accountsArray;
  }

  syncSelectAllCheckbox() {
    if (typeof document === 'undefined') return;
    const selectAllCheckbox = document.getElementById('batch-accounts-select-all');
    if (!selectAllCheckbox) return;
    const total = this.accountsArray.length;
    const selectedCount = this.accountsArray.filter((a) => a.selected !== false).length;
    selectAllCheckbox.checked = total > 0 && selectedCount === total;
    selectAllCheckbox.indeterminate = selectedCount > 0 && selectedCount < total;
  }

  syncRowsFromDom() {
    if (typeof document === 'undefined') return this.accountsArray;
    const tbody = document.getElementById('batch-accounts-tbody');
    if (!tbody) return this.accountsArray;

    const rows = tbody.querySelectorAll('tr[data-batch-row-index]');
    rows.forEach((row) => {
      const idx = Number.parseInt(row.getAttribute('data-batch-row-index') || '-1', 10);
      if (idx < 0 || idx >= this.accountsArray.length) return;
      const item = this.accountsArray[idx];

      const checkEl = row.querySelector('[data-batch-acc-field="selected"]');
      const typeEl = row.querySelector('[data-batch-acc-field="accountType"]');
      const numEl = row.querySelector('[data-batch-acc-field="accountNumber"]');
      const curEl = row.querySelector('[data-batch-acc-field="currency"]');
      const balEl = row.querySelector('[data-batch-acc-field="currentBalance"]');
      const cardEl = row.querySelector('[data-batch-acc-field="isCreditCard"]');

      if (checkEl) item.selected = Boolean(checkEl.checked);
      if (typeEl) item.accountType = String(typeEl.value || '').trim() || 'Cuenta Bancaria';
      if (numEl) item.accountNumber = String(numEl.value || '').trim();
      if (curEl) item.currency = curEl.value === 'USD' ? 'USD' : 'HNL';
      if (balEl) item.currentBalance = cleanAmount(balEl.value);
      if (cardEl) item.isCreditCard = cardEl.value === 'true';
    });

    const bankSelect = document.getElementById('batch-accounts-bank-select');
    if (bankSelect && bankSelect.value) {
      this.bankName = bankSelect.value;
    }

    return this.accountsArray;
  }

  updateSummaryBanner() {
    if (typeof document === 'undefined') return;
    const banner = document.getElementById('batch-accounts-summary-banner');
    if (!banner) return;

    const selectedItems = this.accountsArray.filter((a) => a.selected !== false);
    const cardsCount = selectedItems.filter((a) => a.isCreditCard).length;
    const bankAccountsCount = selectedItems.length - cardsCount;

    banner.innerHTML = `
      <span>
        🏦 <strong>${escapeHtml(this.bankName)}</strong> ·
        <strong>${selectedItems.length}</strong> de ${this.accountsArray.length} producto(s) seleccionado(s)
        (${bankAccountsCount} cuenta(s) bancaria(s), ${cardsCount} tarjeta(s) de crédito)
      </span>
    `;
  }

  renderTable() {
    if (typeof document === 'undefined') return;
    const tbody = document.getElementById('batch-accounts-tbody');
    if (!tbody) return;
    tbody.innerHTML = renderBatchAccountsRowsMarkup(
      this.accountsArray,
      this.existingAccountNumbers
    );
    this.syncSelectAllCheckbox();
  }

  /**
   * Abre el modal de confirmación por lote con los datos extraídos (`bankName` + `accountsArray`).
   * @param {{ bankName?: string, accountsArray?: Array<object> }} payload
   */
  async openWithExtractedBatch(payload = BATCH_DEMO_PRODUCTS_SUMMARY) {
    this.init();
    const validated = validateExtractedAccount(payload);
    this.bankName = validated.bankName || 'BAC Credomatic';
    this.accountsArray = (validated.accountsArray || []).map((item, idx) =>
      normalizeExtractedAccountItem(item, idx, this.bankName)
    );

    const context = this.options.getImportContext?.() || {};
    const state = this.options.getState?.() || context.state || null;
    this.existingAccountNumbers = await fetchExistingWorkspaceAccountNumbers({
      ...context,
      state,
    });

    if (typeof document !== 'undefined') {
      const bankSelect = document.getElementById('batch-accounts-bank-select');
      if (bankSelect) {
        const matched = BATCH_BANKS_LIST.find(
          (b) => b.toLowerCase() === this.bankName.toLowerCase()
        );
        bankSelect.value = matched || BATCH_BANKS_LIST[0];
      }
    }

    this.renderTable();
    this.updateSummaryBanner();

    if (this.dialogEl) {
      this.isOpen = true;
      if (typeof this.dialogEl.showModal === 'function') {
        try {
          if (!this.dialogEl.open) {
            this.dialogEl.showModal();
          }
        } catch {
          this.dialogEl.setAttribute('open', '');
        }
      } else {
        this.dialogEl.setAttribute('open', '');
      }
    }

    return this;
  }

  close() {
    this.isOpen = false;
    if (this.dialogEl) {
      if (typeof this.dialogEl.close === 'function' && this.dialogEl.open) {
        try {
          this.dialogEl.close();
        } catch {
          this.dialogEl.removeAttribute('open');
        }
      } else {
        this.dialogEl.removeAttribute('open');
      }
    }
  }

  /**
   * Guarda atómicamente todas las cuentas seleccionadas usando `saveBatchAccountsToFirestore` (`writeBatch`)
   * omitiendo duplicados en `workspaceId`.
   */
  async handleSaveSelectedAccounts() {
    if (this.isSaving) return null;
    this.syncRowsFromDom();

    const selectedItems = this.accountsArray.filter((item) => item.selected !== false);
    if (selectedItems.length === 0) {
      this.options.showToast?.('Selecciona al menos una cuenta o tarjeta para guardar.');
      return null;
    }

    this.isSaving = true;
    const saveBtn =
      typeof document !== 'undefined'
        ? document.getElementById('btn-save-batch-accounts')
        : null;
    if (saveBtn) {
      saveBtn.disabled = true;
    }

    try {
      const context = this.options.getImportContext?.() || {};
      const state = this.options.getState?.() || context.state || null;

      const result = await saveBatchAccountsToFirestore(
        {
          bankName: this.bankName,
          accountsArray: this.accountsArray,
        },
        state,
        {
          ...context,
          notifyToast: (msg) => this.options.showToast?.(msg),
        }
      );

      this.options.onSaved?.(result);
      this.options.onAccountsBatchSaved?.(result);
      this.close();
      return result;
    } finally {
      this.isSaving = false;
      if (saveBtn) {
        saveBtn.disabled = false;
      }
    }
  }
}

export default BatchAccountsModal;
