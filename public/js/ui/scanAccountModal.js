/**
 * @fileoverview Smart Account Detail Screenshot Scanner Modal Controller (`public/js/ui/scanAccountModal.js`).
 */

import {
  analyzeAccountScreenshotWithGemini,
  createScannedAccountAndTransactionsAtomically,
  formatAccountScanPreviewSummary,
} from '../services/accountScanService.js';
import { validateAndNormalizeAccountScan } from '../schemas/accountScan.js';
import { attachDialogLightDismissFallback } from './keypadModal.js';
import { Money } from '../domain/models.js';

export class ScanAccountModal {
  constructor(options) {
    this.dialogEl = options.dialogEl;
    this.getState = options.getState;
    this.getScanContext = options.getScanContext;
    this.extractOcrFallbackText = options.extractOcrFallbackText;
    this.onCreated = options.onCreated;
    this.showToast = options.showToast;
    this.pendingScanResult = null;
    this.previewDataUrl = '';

    if (this.dialogEl) {
      attachDialogLightDismissFallback(this.dialogEl);
      this.bindEvents();
    }
  }

  bindEvents() {
    if (!this.dialogEl) return;

    const dropzone = this.dialogEl.querySelector('#scan-account-dropzone');
    const fileInput = this.dialogEl.querySelector('#scan-account-file-input');
    const selectFileBtn = this.dialogEl.querySelector('#btn-select-scan-account-file');
    const confirmBtn = this.dialogEl.querySelector('#btn-confirm-scan-account');
    const resetBtn = this.dialogEl.querySelector('#btn-reset-scan-account');

    selectFileBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fileInput?.click();
    });

    dropzone?.addEventListener('click', (e) => {
      if (e.target?.closest?.('button')) return;
      fileInput?.click();
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
        this.processScreenshotFile(file);
      }
    });

    fileInput?.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) {
        this.processScreenshotFile(file);
      }
      fileInput.value = '';
    });

    resetBtn?.addEventListener('click', () => {
      this.resetModalState();
    });

    confirmBtn?.addEventListener('click', async () => {
      await this.handleConfirmCreation();
    });
  }

  open() {
    if (!this.dialogEl) return;
    this.resetModalState();
    if (!this.dialogEl.open) {
      if (typeof this.dialogEl.showModal === 'function') {
        this.dialogEl.showModal();
      } else {
        this.dialogEl.setAttribute('open', '');
      }
    }
  }

  close() {
    if (!this.dialogEl) return;
    if (this.dialogEl.open && typeof this.dialogEl.close === 'function') {
      this.dialogEl.close();
    } else {
      this.dialogEl.removeAttribute('open');
    }
    this.pendingScanResult = null;
  }

  resetModalState() {
    this.pendingScanResult = null;
    this.previewDataUrl = '';
    if (!this.dialogEl) return;

    const loadingBox = this.dialogEl.querySelector('#scan-account-loading-box');
    const previewBox = this.dialogEl.querySelector('#scan-account-preview-box');
    const errorBox = this.dialogEl.querySelector('#scan-account-error-box');
    const confirmBtn = this.dialogEl.querySelector('#btn-confirm-scan-account');

    loadingBox?.classList.add('is-hidden');
    previewBox?.classList.add('is-hidden');
    errorBox?.classList.add('is-hidden');
    if (confirmBtn) {
      confirmBtn.disabled = true;
    }
  }

  async processScreenshotFile(file) {
    if (!file) return null;
    if (!/^image\/(png|jpeg|jpg|webp)$/i.test(file.type)) {
      this.showError('Selecciona una imagen válida en formato PNG, JPG o WEBP.');
      return null;
    }

    const loadingBox = this.dialogEl?.querySelector('#scan-account-loading-box');
    const loadingText = this.dialogEl?.querySelector('#scan-account-loading-text');
    const previewBox = this.dialogEl?.querySelector('#scan-account-preview-box');
    const errorBox = this.dialogEl?.querySelector('#scan-account-error-box');
    const confirmBtn = this.dialogEl?.querySelector('#btn-confirm-scan-account');

    errorBox?.classList.add('is-hidden');
    previewBox?.classList.add('is-hidden');
    loadingBox?.classList.remove('is-hidden');
    if (loadingText) {
      loadingText.textContent = '🤖 Analizando estado de cuenta con Gemini...';
    }
    if (confirmBtn) {
      confirmBtn.disabled = true;
    }

    try {
      let ocrFallback = '';
      if (typeof this.extractOcrFallbackText === 'function') {
        try {
          ocrFallback = await this.extractOcrFallbackText(file);
        } catch {
          ocrFallback = '';
        }
      }

      const context = this.getScanContext();
      const { scan, preview } = await analyzeAccountScreenshotWithGemini(file, {
        apiKey: context.apiKey,
        ocrTextFallback: ocrFallback,
        fetchImpl: context.fetchImpl,
      });

      this.pendingScanResult = scan;
      this.renderScanPreview(scan, preview);
      return scan;
    } catch (err) {
      this.showError(
        err?.message || 'Error al analizar la captura de pantalla con Gemini.'
      );
      return null;
    } finally {
      loadingBox?.classList.add('is-hidden');
    }
  }

  renderScanPreview(scan, preview = formatAccountScanPreviewSummary(scan)) {
    if (!this.dialogEl) return;

    const previewBox = this.dialogEl.querySelector('#scan-account-preview-box');
    const summaryTitleEl = this.dialogEl.querySelector('#scan-account-summary-title');
    const txCountBadgeEl = this.dialogEl.querySelector('#scan-account-tx-count-badge');
    const bankInput = this.dialogEl.querySelector('#scan-acc-bank-input');
    const typeInput = this.dialogEl.querySelector('#scan-acc-type-input');
    const numberInput = this.dialogEl.querySelector('#scan-acc-number-input');
    const currencySelect = this.dialogEl.querySelector('#scan-acc-currency-select');
    const balanceInput = this.dialogEl.querySelector('#scan-acc-balance-input');
    const statusSelect = this.dialogEl.querySelector('#scan-acc-status-select');
    const txTbody = this.dialogEl.querySelector('#scan-account-tx-tbody');
    const confirmBtn = this.dialogEl.querySelector('#btn-confirm-scan-account');

    if (summaryTitleEl) {
      summaryTitleEl.textContent = preview.accountSummaryTitle;
    }
    if (txCountBadgeEl) {
      txCountBadgeEl.textContent = preview.transactionsCountLabel;
    }

    if (bankInput) bankInput.value = scan.bankName;
    if (typeInput) typeInput.value = scan.accountType;
    if (numberInput) numberInput.value = scan.accountNumber;
    if (currencySelect) currencySelect.value = scan.currency === 'USD' ? 'USD' : 'HNL';
    if (balanceInput) balanceInput.value = String(scan.currentBalance);
    if (statusSelect) statusSelect.value = scan.status === 'Inactiva' ? 'Inactiva' : 'Activa';

    if (txTbody) {
      if (!scan.detectedTransactions || scan.detectedTransactions.length === 0) {
        txTbody.innerHTML = `
          <tr>
            <td colspan="4" style="text-align: center; padding: 1rem; color: var(--text-secondary);">
              No se detectaron movimientos individuales en la captura. Se creará únicamente la cuenta con su saldo actual.
            </td>
          </tr>
        `;
      } else {
        const cur = scan.currency === 'USD' ? 'USD' : 'HNL';
        txTbody.innerHTML = scan.detectedTransactions
          .map((tx) => {
            const isIncome = tx.type === 'income';
            const sign = isIncome ? '+' : '-';
            const badgeLabel = isIncome ? 'Crédito / Depósito (Ingreso)' : 'Débito / Retiro (Gasto)';
            const amountClass = isIncome ? 'text-income' : 'text-expense';
            return `
              <tr>
                <td style="white-space: nowrap; font-variant-numeric: tabular-nums;">${tx.date}</td>
                <td>${tx.concept}</td>
                <td><span class="voucher-pill">${badgeLabel}</span></td>
                <td class="num-col"><strong class="${amountClass}">${sign} ${Money.format(tx.amount, cur)}</strong></td>
              </tr>
            `;
          })
          .join('');
      }
    }

    previewBox?.classList.remove('is-hidden');
    if (confirmBtn) {
      confirmBtn.disabled = false;
    }
  }

  collectEditedScanPayload() {
    if (!this.pendingScanResult) return null;
    if (!this.dialogEl) return this.pendingScanResult;

    const bankInput = this.dialogEl.querySelector('#scan-acc-bank-input');
    const typeInput = this.dialogEl.querySelector('#scan-acc-type-input');
    const numberInput = this.dialogEl.querySelector('#scan-acc-number-input');
    const currencySelect = this.dialogEl.querySelector('#scan-acc-currency-select');
    const balanceInput = this.dialogEl.querySelector('#scan-acc-balance-input');
    const statusSelect = this.dialogEl.querySelector('#scan-acc-status-select');

    return validateAndNormalizeAccountScan({
      ...this.pendingScanResult,
      bankName: bankInput?.value || this.pendingScanResult.bankName,
      accountType: typeInput?.value || this.pendingScanResult.accountType,
      accountNumber: numberInput?.value ?? this.pendingScanResult.accountNumber,
      currency: currencySelect?.value || this.pendingScanResult.currency,
      currentBalance: balanceInput?.value
        ? Number.parseFloat(balanceInput.value)
        : this.pendingScanResult.currentBalance,
      status: statusSelect?.value || this.pendingScanResult.status,
    });
  }

  async handleConfirmCreation() {
    const finalPayload = this.collectEditedScanPayload();
    if (!finalPayload) return;

    const confirmBtn = this.dialogEl?.querySelector('#btn-confirm-scan-account');
    try {
      if (confirmBtn) confirmBtn.disabled = true;
      const state = this.getState();
      const context = this.getScanContext();

      const result = await createScannedAccountAndTransactionsAtomically(
        finalPayload,
        state,
        context
      );

      this.close();
      if (typeof this.showToast === 'function') {
        this.showToast(result.toastMessage);
      }
      if (typeof this.onCreated === 'function') {
        this.onCreated(result);
      }
    } catch (err) {
      this.showError(err?.message || 'Error al guardar la cuenta y transacciones en Firestore.');
    } finally {
      if (confirmBtn) confirmBtn.disabled = false;
    }
  }

  showError(message) {
    if (!this.dialogEl) return;
    const errorBox = this.dialogEl.querySelector('#scan-account-error-box');
    if (errorBox) {
      errorBox.textContent = `⚠️ ${message}`;
      errorBox.classList.remove('is-hidden');
    }
    if (typeof this.showToast === 'function') {
      this.showToast(`⚠️ ${message}`);
    }
  }
}

export default ScanAccountModal;
