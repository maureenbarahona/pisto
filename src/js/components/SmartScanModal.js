import {
  Money,
  TRANSACTION_TYPES,
  extractLast4Digits,
  createTransaction,
} from '../../../public/js/domain/models.js';
import { filterActiveAccounts } from '../../../public/js/services/accounts.js';
import {
  SMART_SCAN_DOCUMENT_TYPES,
  sanitizeSmartScanAmount,
  getTransactionTypeForDocument,
  matchAccountFromWorkspace,
  detectSmartScanDuplicate,
  extractSmartScanDocument,
} from '../services/smartScanExtractor.js';

export const SMART_SCAN_MODAL_ID = 'smart-scan-dialog';
export const DUPLICATE_RESOLUTION_ACTIONS = Object.freeze({
  OVERWRITE: 'overwrite',
  CREATE_NEW: 'create_new',
  SKIP: 'skip',
});

/**
 * Construye el HTML del Modal de Confirmación Único (`#smart-scan-dialog`).
 * @returns {string}
 */
export function renderSmartScanModalMarkup() {
  const docTypeOptions = Object.values(SMART_SCAN_DOCUMENT_TYPES)
    .map((type) => `<option value="${type}">${type}</option>`)
    .join('');

  return `
    <div class="modal-header">
      <div>
        <h3 id="smart-scan-dialog-title">📷 Escanear Documento / PDF</h3>
        <p id="smart-scan-subtitle" style="font-size: 0.78rem; color: var(--text-secondary); margin-top: 2px;">
          Motor unificado de clasificación OCR y asociación automática a cuentas del workspace
        </p>
      </div>
      <button type="button" class="btn-icon" data-close-modal="${SMART_SCAN_MODAL_ID}" aria-label="Cerrar escáner inteligente">✕</button>
    </div>

    <div id="smart-scan-progress-box" class="voucher-progress-container is-hidden" aria-live="polite">
      <div style="display: flex; justify-content: space-between; font-size: 0.82rem;">
        <span id="smart-scan-progress-status">Analizando documento...</span>
        <strong id="smart-scan-progress-pct">0%</strong>
      </div>
      <progress id="smart-scan-progress-bar" value="0" max="100"></progress>
    </div>

    <form id="smart-scan-confirm-form">
      <div class="voucher-scanner-layout">
        <div class="voucher-preview-pane">
          <img id="smart-scan-preview-img" alt="Vista previa del documento escaneado" src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=" />
          <div id="smart-scan-match-badges" class="voucher-match-badges"></div>
        </div>

        <div class="voucher-fields-pane">
          <div id="smart-scan-tax-summary" class="voucher-tax-summary is-hidden"></div>

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
              <label for="smart-scan-doc-type-select">Tipo de Documento</label>
              <select id="smart-scan-doc-type-select" name="tipoDocumento" class="select-input">
                ${docTypeOptions}
              </select>
            </div>
            <div class="form-group">
              <label for="smart-scan-date-input">Fecha del Comprobante</label>
              <input type="date" id="smart-scan-date-input" name="fecha" class="text-input" required />
            </div>
          </div>

          <div class="form-group">
            <label for="smart-scan-merchant-input">Comercio / Concepto Detectado</label>
            <input
              type="text"
              id="smart-scan-merchant-input"
              name="comercio"
              class="text-input"
              required
              placeholder="Ej: Supermercados La Colonia / Transferencia ACH"
            />
          </div>

          <div class="form-row-2">
            <div class="form-group">
              <label for="smart-scan-amount-input">Monto Total</label>
              <input
                type="number"
                id="smart-scan-amount-input"
                name="monto"
                class="text-input"
                step="0.01"
                min="0.01"
                required
                placeholder="0.00"
              />
            </div>
            <div class="form-group">
              <label for="smart-scan-currency-select">Moneda</label>
              <select id="smart-scan-currency-select" name="moneda" class="select-input">
                <option value="HNL">Lempiras (HNL)</option>
                <option value="USD">Dólares (USD)</option>
              </select>
            </div>
          </div>

          <div class="form-row-2">
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
            <div class="form-group">
              <label for="smart-scan-category-select">Categoría Sugerida</label>
              <select id="smart-scan-category-select" name="categoryId" class="select-input" required></select>
            </div>
          </div>

          <div class="form-group">
            <label for="smart-scan-account-select">Cuenta Asociada</label>
            <select id="smart-scan-account-select" name="accountId" class="select-input" required></select>
            <small id="smart-scan-account-match-hint" style="display: block; margin-top: 0.28rem; font-size: 0.76rem; color: var(--text-secondary);"></small>
          </div>
        </div>
      </div>

      <div class="modal-footer" style="margin-top: 1rem;">
        <button type="button" class="btn-secondary" data-close-modal="${SMART_SCAN_MODAL_ID}">Cancelar</button>
        <button type="submit" id="btn-save-smart-scan-tx" class="btn-primary" style="flex: 1;">
          Guardar Movimiento
        </button>
      </div>
    </form>
  `.trim();
}

/**
 * Persiste la transacción confirmada y actualiza el saldo de la cuenta asociada
 * tanto en memoria como en Firestore (`workspaces/{workspaceId}/transactions` y `accounts`).
 *
 * @param {object} params
 * @param {object} params.extractedData
 * @param {object} params.state
 * @param {string} [params.duplicateResolution='create_new'] - 'overwrite' | 'create_new' | 'skip'
 * @param {object} [params.duplicateTx=null]
 * @param {object} [params.firestoreDb=null]
 * @param {object} [params.firestoreModule=null]
 * @param {string} [params.workspaceId='']
 * @param {Function} [params.recordTransactionFn=null]
 * @param {Storage} [params.storage=globalThis.localStorage]
 * @returns {Promise<{
 *   action: 'overwrite'|'create_new'|'skip',
 *   saved: boolean,
 *   transaction: object|null,
 *   updatedAccount: object|null,
 *   newAccountBalance: number
 * }>}
 */
export async function confirmAndPersistSmartScanTransaction({
  extractedData,
  state,
  duplicateResolution = DUPLICATE_RESOLUTION_ACTIONS.CREATE_NEW,
  duplicateTx = null,
  firestoreDb = null,
  firestoreModule = null,
  workspaceId = '',
  recordTransactionFn = null,
  storage = typeof localStorage !== 'undefined' ? localStorage : null,
}) {
  if (duplicateResolution === DUPLICATE_RESOLUTION_ACTIONS.SKIP) {
    return {
      action: DUPLICATE_RESOLUTION_ACTIONS.SKIP,
      saved: false,
      transaction: null,
      updatedAccount: null,
      newAccountBalance: 0,
    };
  }

  const fecha = String(extractedData.fecha || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const comercio = String(extractedData.comercio || 'Movimiento Escaneado').trim();
  const monto = sanitizeSmartScanAmount(extractedData.monto);
  const moneda = extractedData.moneda === 'USD' ? 'USD' : 'HNL';
  const tipoDocumento =
    extractedData.tipoDocumento || SMART_SCAN_DOCUMENT_TYPES.INVOICE_RECEIPT;
  const tipoTransaccion =
    extractedData.tipoTransaccion || getTransactionTypeForDocument(tipoDocumento);
  const cuentaIdentificada = String(extractedData.cuentaIdentificada || '').trim();
  const accountId = String(
    extractedData.accountId || state?.accounts?.[0]?.id || ''
  ).trim();
  const categoryId = String(
    extractedData.categoryId ||
      (tipoTransaccion === TRANSACTION_TYPES.INCOME ? 'salary' : 'groceries')
  ).trim();

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

  if (!Array.isArray(state.transactions)) {
    state.transactions = [];
  }
  if (!Array.isArray(state.accounts)) {
    state.accounts = [];
  }

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
      documentType: tipoDocumento,
      cuentaIdentificada,
    };

    if (!state.transactions.some((tx) => tx.id === savedTx.id)) {
      state.transactions.unshift(savedTx);
    }
  }

  // Recalcular el saldo de la cuenta asociada en base a su initialBalance y transacciones
  let updatedAccount = state.accounts.find((acc) => acc.id === accountId) || null;
  const accCurrency = updatedAccount?.currency || moneda || 'HNL';
  let balanceCents = Money.toCents(updatedAccount?.initialBalance ?? 0);

  for (const tx of state.transactions) {
    if (tx.accountId === accountId) {
      const amtInAcc = Money.convert(tx.amount, tx.currency || accCurrency, accCurrency);
      const txCents = Money.toCents(amtInAcc);
      if (tx.type === TRANSACTION_TYPES.INCOME) {
        balanceCents += txCents;
      } else if (tx.type === TRANSACTION_TYPES.EXPENSE || tx.type === TRANSACTION_TYPES.TRANSFER) {
        balanceCents -= txCents;
      }
    } else if (tx.type === TRANSACTION_TYPES.TRANSFER && tx.toAccountId === accountId) {
      const amtInAcc = Money.convert(tx.amount, tx.currency || accCurrency, accCurrency);
      balanceCents += Money.toCents(amtInAcc);
    }
  }

  const newAccountBalance = Money.fromCents(balanceCents);
  if (updatedAccount) {
    updatedAccount.currentBalance = newAccountBalance;
    if (cuentaIdentificada && !updatedAccount.accountNumber) {
      updatedAccount.accountNumber = last4 || cuentaIdentificada;
    }
  }

  const resolvedWorkspaceId =
    workspaceId || state?.activeWorkspaceId || state?.workspaceId || '';

  // Persistir en Firestore si el módulo y base de datos están disponibles
  if (firestoreDb && firestoreModule && resolvedWorkspaceId) {
    try {
      const { doc, setDoc, updateDoc } = firestoreModule;
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
        if (typeof updateDoc === 'function') {
          await updateDoc(accRef, accountPatch);
        } else if (typeof setDoc === 'function') {
          await setDoc(accRef, { ...updatedAccount, ...accountPatch }, { merge: true });
        }
      }
    } catch {
      // Continúa con persistencia Local-First en caso de desconexión
    }
  }

  // Sincronizar cachés locales del workspace si existen
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

  return {
    action: effectiveAction,
    saved: true,
    transaction: savedTx,
    updatedAccount,
    newAccountBalance,
  };
}

/**
 * Componente Modal de Confirmación Único (`SmartScanModal`).
 */
export class SmartScanModal {
  /**
   * @param {object} [options]
   * @param {Document} [options.doc]
   * @param {Function} [options.getState]
   * @param {Function} [options.getWorkspaceId]
   * @param {object} [options.firestoreDb]
   * @param {object} [options.firestoreModule]
   * @param {Function} [options.recordTransactionFn]
   * @param {Function} [options.onSaved]
   * @param {Function} [options.onMultiRowStatementDetected]
   * @param {Function} [options.showToast]
   */
  constructor(options = {}) {
    this.doc = options.doc || (typeof document !== 'undefined' ? document : null);
    this.getState = typeof options.getState === 'function' ? options.getState : () => ({});
    this.getWorkspaceId =
      typeof options.getWorkspaceId === 'function' ? options.getWorkspaceId : () => '';
    this.firestoreDb = options.firestoreDb || null;
    this.firestoreModule = options.firestoreModule || null;
    this.recordTransactionFn = options.recordTransactionFn || null;
    this.onSaved = typeof options.onSaved === 'function' ? options.onSaved : null;
    this.onMultiRowStatementDetected =
      typeof options.onMultiRowStatementDetected === 'function'
        ? options.onMultiRowStatementDetected
        : null;
    this.showToast = typeof options.showToast === 'function' ? options.showToast : () => {};

    this.currentExtracted = null;
    this._bound = false;
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
    } else if (!dialogEl.querySelector('#smart-scan-confirm-form')) {
      dialogEl.innerHTML = renderSmartScanModalMarkup();
    }

    this.bindEvents(dialogEl);
    return dialogEl;
  }

  /**
   * Enlaza eventos interactivos del formulario de confirmación.
   * @param {HTMLElement} [dialogEl]
   */
  bindEvents(dialogEl = null) {
    const modal = dialogEl || this.doc?.getElementById(SMART_SCAN_MODAL_ID);
    if (!modal || modal.dataset.smartScanModalBound === 'true') return;
    modal.dataset.smartScanModalBound = 'true';

    const formEl = modal.querySelector('#smart-scan-confirm-form');
    const docTypeSelect = modal.querySelector('#smart-scan-doc-type-select');
    const identifiedInput = modal.querySelector('#smart-scan-identified-account-input');
    const accountSelect = modal.querySelector('#smart-scan-account-select');
    const dateInput = modal.querySelector('#smart-scan-date-input');
    const amountInput = modal.querySelector('#smart-scan-amount-input');
    const merchantInput = modal.querySelector('#smart-scan-merchant-input');

    // Botones de cerrar
    modal.querySelectorAll(`[data-close-modal="${SMART_SCAN_MODAL_ID}"]`).forEach((btn) => {
      btn.addEventListener('click', () => {
        this.close();
      });
    });

    // Al cambiar tipo de documento, actualiza las categorías sugeridas (Ingreso vs Gasto)
    docTypeSelect?.addEventListener('change', () => {
      const txType = getTransactionTypeForDocument(docTypeSelect.value);
      this.populateCategoryOptions(txType, modal.querySelector('#smart-scan-category-select')?.value);
    });

    // Al editar cuentaIdentificada, re-evalúa asociación automática a cuentas existentes
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
      this.renderAccountSelector(match.activeAccounts, match.matched ? match.accountId : '', match);
      this.refreshDuplicateWarning();
    });

    // Al cambiar cuenta, fecha, monto o comercio, re-evalúa detección de duplicados
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
   * Llena el selector de categorías filtrando por tipo de transacción ('income' o 'expense').
   * @param {'income'|'expense'} txType
   * @param {string} [selectedCategoryId]
   */
  populateCategoryOptions(txType = TRANSACTION_TYPES.EXPENSE, selectedCategoryId = '') {
    const catSelect = this.doc?.getElementById('smart-scan-category-select');
    if (!catSelect) return;

    const state = this.getState();
    const categories = Array.isArray(state?.categories) ? state.categories : [];
    const filtered = categories.filter((c) => c.type === txType);
    const list = filtered.length > 0 ? filtered : categories;

    catSelect.innerHTML = list
      .map((c) => `<option value="${c.id}">${c.name}</option>`)
      .join('');

    if (selectedCategoryId && list.some((c) => c.id === selectedCategoryId)) {
      catSelect.value = selectedCategoryId;
    } else if (list[0]) {
      catSelect.value = list[0].id;
    }
  }

  /**
   * Renderiza el selector desplegable de cuentas activas:
   * - Si `accountMatch.matched === true`, asigna automáticamente esa cuenta como "Cuenta Asociada".
   * - Si no coincide, muestra la opción placeholder para selección manual junto con la lista completa de cuentas activas.
   *
   * @param {Array<object>} activeAccounts
   * @param {string} matchedAccountId
   * @param {object} [accountMatch]
   */
  renderAccountSelector(activeAccounts = [], matchedAccountId = '', accountMatch = null) {
    const accSelect = this.doc?.getElementById('smart-scan-account-select');
    const hintEl = this.doc?.getElementById('smart-scan-account-match-hint');
    const badgesEl = this.doc?.getElementById('smart-scan-match-badges');
    if (!accSelect) return;

    const accounts = filterActiveAccounts(activeAccounts);
    const optionsHtml = [];

    if (!matchedAccountId) {
      optionsHtml.push(
        `<option value="" selected>-- Selecciona manualmente una cuenta activa (${accounts.length}) --</option>`
      );
    }

    for (const acc of accounts) {
      const last4 = extractLast4Digits(acc.accountNumber || '');
      const numBadge = last4 ? ` (N.º *${last4})` : acc.accountNumber ? ` (${acc.accountNumber})` : '';
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
          'ℹ️ Sin coincidencia automática de cuenta. Selecciona manualmente la cuenta en la lista desplegable.';
      }
    }

    if (badgesEl) {
      const docType =
        this.doc?.getElementById('smart-scan-doc-type-select')?.value ||
        this.currentExtracted?.tipoDocumento ||
        SMART_SCAN_DOCUMENT_TYPES.INVOICE_RECEIPT;
      const matchLabel =
        accountMatch?.matched && accountMatch.matchedAccount
          ? `✅ Asociada: ${accountMatch.matchedAccount.name}`
          : '🔎 Selección manual de cuenta requerida';

      badgesEl.innerHTML = `
        <div class="voucher-pill">📄 ${docType}</div>
        <div class="voucher-pill">${matchLabel}</div>
      `;
    }
  }

  /**
   * Re-evalúa si los valores actuales del formulario corresponden a un movimiento duplicado
   * y muestra/oculta la alerta con opciones "Sobreescribir", "Crear Nueva" u "Omitir".
   */
  refreshDuplicateWarning() {
    if (!this.doc) return;
    const warningEl = this.doc.getElementById('smart-scan-duplicate-warning');
    const detailEl = this.doc.getElementById('smart-scan-duplicate-detail');
    if (!warningEl) return;

    const fecha = this.doc.getElementById('smart-scan-date-input')?.value || '';
    const comercio = this.doc.getElementById('smart-scan-merchant-input')?.value || '';
    const monto = sanitizeSmartScanAmount(
      this.doc.getElementById('smart-scan-amount-input')?.value || 0
    );
    const moneda = this.doc.getElementById('smart-scan-currency-select')?.value || 'HNL';
    const accountId = this.doc.getElementById('smart-scan-account-select')?.value || '';

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
   * @param {object} extracted
   */
  openWithExtractedData(extracted) {
    const dialogEl = this.ensureDialogElement();
    if (!dialogEl) return;

    this.currentExtracted = { ...extracted };

    const docTypeSelect = this.doc.getElementById('smart-scan-doc-type-select');
    const dateInput = this.doc.getElementById('smart-scan-date-input');
    const merchantInput = this.doc.getElementById('smart-scan-merchant-input');
    const amountInput = this.doc.getElementById('smart-scan-amount-input');
    const currencySelect = this.doc.getElementById('smart-scan-currency-select');
    const identifiedInput = this.doc.getElementById('smart-scan-identified-account-input');
    const previewImg = this.doc.getElementById('smart-scan-preview-img');
    const taxSummaryEl = this.doc.getElementById('smart-scan-tax-summary');

    const tipoDocumento =
      extracted.tipoDocumento || SMART_SCAN_DOCUMENT_TYPES.INVOICE_RECEIPT;
    const tipoTransaccion =
      extracted.tipoTransaccion || getTransactionTypeForDocument(tipoDocumento);

    if (docTypeSelect) docTypeSelect.value = tipoDocumento;
    if (dateInput) dateInput.value = extracted.fecha || new Date().toISOString().slice(0, 10);
    if (merchantInput) merchantInput.value = extracted.comercio || '';
    if (amountInput) {
      const cleanAmt = sanitizeSmartScanAmount(extracted.monto);
      amountInput.value = cleanAmt > 0 ? String(cleanAmt) : '';
    }
    if (currencySelect) currencySelect.value = extracted.moneda === 'USD' ? 'USD' : 'HNL';
    if (identifiedInput) identifiedInput.value = extracted.cuentaIdentificada || '';
    if (previewImg && extracted.originalDataUrl) {
      previewImg.src = extracted.originalDataUrl;
    }

    this.populateCategoryOptions(tipoTransaccion, extracted.categoryId);

    const state = this.getState();
    const activeAccounts =
      extracted.accountMatch?.activeAccounts ||
      filterActiveAccounts(state?.accounts || []);
    const matchedAccountId = extracted.accountMatch?.matched
      ? extracted.accountMatch.accountId
      : extracted.accountId || '';

    this.renderAccountSelector(activeAccounts, matchedAccountId, extracted.accountMatch);

    if (taxSummaryEl) {
      const { subtotal = 0, isv = 0, devolIsv = 0 } = extracted.breakdown || {};
      if (subtotal > 0 || isv > 0) {
        taxSummaryEl.classList.remove('is-hidden');
        taxSummaryEl.innerHTML = `
          <strong>Desglose detectado:</strong>
          Subtotal: ${Money.format(subtotal, extracted.moneda || 'HNL')} ·
          ISV: ${Money.format(isv, extracted.moneda || 'HNL')}
          ${devolIsv > 0 ? ` · Devolución ISV: -${Money.format(devolIsv, extracted.moneda || 'HNL')}` : ''} ·
          <strong>Total: ${Money.format(extracted.monto || 0, extracted.moneda || 'HNL')}</strong>
        `;
      } else {
        taxSummaryEl.classList.add('is-hidden');
      }
    }

    // Por defecto selecciona "Crear Nueva" en los radios de duplicado
    const createNewRadio = dialogEl.querySelector(
      'input[name="duplicateResolution"][value="create_new"]'
    );
    if (createNewRadio) createNewRadio.checked = true;

    this.refreshDuplicateWarning();

    if (typeof dialogEl.showModal === 'function' && !dialogEl.open) {
      dialogEl.showModal();
    } else {
      dialogEl.setAttribute('open', '');
    }
  }

  /**
   * Procesa un archivo (PNG, JPG, WEBP, PDF) con el Motor Unificado y abre el modal.
   * @param {File|Blob|object|string} file
   * @param {object} [extraOptions]
   * @returns {Promise<object>}
   */
  async processFileAndOpen(file, extraOptions = {}) {
    const dialogEl = this.ensureDialogElement();
    const progressBox = this.doc?.getElementById('smart-scan-progress-box');
    const progressStatus = this.doc?.getElementById('smart-scan-progress-status');
    const progressPct = this.doc?.getElementById('smart-scan-progress-pct');
    const progressBar = this.doc?.getElementById('smart-scan-progress-bar');
    const saveBtn = this.doc?.getElementById('btn-save-smart-scan-tx');

    if (dialogEl) {
      if (typeof dialogEl.showModal === 'function' && !dialogEl.open) {
        dialogEl.showModal();
      } else {
        dialogEl.setAttribute('open', '');
      }
    }

    if (progressBox) progressBox.classList.remove('is-hidden');
    if (saveBtn) saveBtn.disabled = true;

    try {
      const state = this.getState();
      const extracted = await extractSmartScanDocument(
        file,
        state,
        {
          firestoreDb: this.firestoreDb,
          firestoreModule: this.firestoreModule,
          workspaceId: this.getWorkspaceId(),
          ...extraOptions,
        },
        (status, pct) => {
          if (progressStatus) progressStatus.textContent = status;
          if (progressPct) progressPct.textContent = `${pct}%`;
          if (progressBar) progressBar.value = pct;
        }
      );

      // Si es un estado de cuenta PDF con múltiples movimientos y hay handler especializado, delegar o poblar
      if (
        extracted.isMultiRowStatement &&
        typeof this.onMultiRowStatementDetected === 'function'
      ) {
        this.close();
        await this.onMultiRowStatementDetected(file, extracted);
        return extracted;
      }

      this.openWithExtractedData(extracted);
      return extracted;
    } catch (error) {
      this.showToast(`Aviso al escanear documento: ${error.message}`);
      throw error;
    } finally {
      if (progressBox) progressBox.classList.add('is-hidden');
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  /**
   * Procesa el envío del formulario del modal, aplicando la resolución de duplicados
   * ("Sobreescribir", "Crear Nueva" u "Omitir"), guardando en Firestore y actualizando el saldo.
   * @returns {Promise<object>}
   */
  async handleFormSubmit() {
    const dialogEl = this.doc?.getElementById(SMART_SCAN_MODAL_ID);
    const formEl = this.doc?.getElementById('smart-scan-confirm-form');
    if (!formEl) return { saved: false };

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
      this.doc.getElementById('smart-scan-doc-type-select')?.value ||
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
    const moneda =
      this.doc.getElementById('smart-scan-currency-select')?.value || 'HNL';
    const cuentaIdentificada = (
      this.doc.getElementById('smart-scan-identified-account-input')?.value || ''
    ).trim();
    const categoryId =
      this.doc.getElementById('smart-scan-category-select')?.value || 'groceries';
    const accountId =
      this.doc.getElementById('smart-scan-account-select')?.value || '';

    if (!accountId) {
      this.showToast('⚠️ Selecciona la Cuenta Asociada antes de confirmar.');
      return { saved: false };
    }

    const state = this.getState();
    const result = await confirmAndPersistSmartScanTransaction({
      extractedData: {
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
      duplicateResolution,
      duplicateTx: this.currentExtracted?.duplicateTx || null,
      firestoreDb: this.firestoreDb,
      firestoreModule: this.firestoreModule,
      workspaceId: this.getWorkspaceId(),
      recordTransactionFn: this.recordTransactionFn,
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
