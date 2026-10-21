/**
 * @fileoverview Browser JS Mirror of `src/components/ScanAccountModal.tsx`.
 */

import {
  cleanAmount,
  encodeImageToBase64,
  formatAccountScanPreviewSummary,
  analyzeAccountScreenshotWithGemini,
  createScannedAccountAndTransactionsAtomically,
} from '../services/accountScanService.js';
import { validateAndNormalizeAccountScan } from '../schemas/accountScan.js';
import { attachDialogLightDismissFallback } from './keypadModal.js';

export class ScanAccountModal {
  /**
   * @param {{
   *   getState: () => any,
   *   getScanContext: () => any,
   *   extractOcrFallbackText?: (file: File) => Promise<string>,
   *   onCreated?: (result: any) => void,
   *   showToast?: (message: string) => void
   * }} options
   */
  constructor(options) {
    this.options = options;
    this.currentScanResult = null;
    this.isProcessing = false;
  }

  init() {
    const dialog = document.getElementById('scan-account-dialog');
    if (!dialog) return;

    attachDialogLightDismissFallback(dialog);

    const fileInput = document.getElementById('scan-account-file-input');
    const dropzone = document.getElementById('scan-account-dropzone');
    const triggerUploadBtn = document.getElementById('btn-trigger-scan-account-file');
    const confirmBtn = document.getElementById('btn-confirm-scan-account');
    const cancelBtn = document.getElementById('btn-cancel-scan-account');
    const closeBtn = document.getElementById('btn-close-scan-account');

    triggerUploadBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      fileInput?.click();
    });

    dropzone?.addEventListener('click', (e) => {
      if (e.target?.closest?.('#btn-trigger-scan-account-file')) return;
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

    const editableIds = [
      'scan-acc-bank-input',
      'scan-acc-type-input',
      'scan-acc-number-input',
      'scan-acc-currency-select',
      'scan-acc-balance-input',
      'scan-acc-status-select',
    ];
    for (const id of editableIds) {
      document.getElementById(id)?.addEventListener('input', () => this.syncPreviewHeaderFromInputs());
      document.getElementById(id)?.addEventListener('change', () => this.syncPreviewHeaderFromInputs());
    }

    confirmBtn?.addEventListener('click', () => this.handleConfirmCreate());
    cancelBtn?.addEventListener('click', () => dialog.close());
    closeBtn?.addEventListener('click', () => dialog.close());
  }

  open() {
    const dialog = document.getElementById('scan-account-dialog');
    if (!dialog) return;
    this.resetView();
    if (!dialog.open) {
      dialog.showModal();
    }
  }

  resetView() {
    this.currentScanResult = null;
    this.isProcessing = false;

    const loadingEl = document.getElementById('scan-account-loading-box');
    const previewBox = document.getElementById('scan-account-preview-box');
    const errorBox = document.getElementById('scan-account-error-box');
    const confirmBtn = document.getElementById('btn-confirm-scan-account');
    const imgPreview = document.getElementById('scan-account-image-preview');

    loadingEl?.classList.add('is-hidden');
    previewBox?.classList.add('is-hidden');
    errorBox?.classList.add('is-hidden');
    if (errorBox) errorBox.textContent = '';
    if (confirmBtn) confirmBtn.disabled = true;
    if (imgPreview) {
      imgPreview.removeAttribute('src');
      imgPreview.classList.add('is-hidden');
    }
  }

  async handleFileSelected(file) {
    if (!file || this.isProcessing) return;

    const validMime =
      /^image\/(png|jpeg|jpg|webp)$/i.test(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name || '');
    if (!validMime) {
      this.showError('Por favor selecciona una imagen válida (PNG, JPG o WEBP).');
      return;
    }

    this.isProcessing = true;
    const loadingEl = document.getElementById('scan-account-loading-box');
    const loadingText = document.getElementById('scan-account-loading-text');
    const previewBox = document.getElementById('scan-account-preview-box');
    const errorBox = document.getElementById('scan-account-error-box');
    const confirmBtn = document.getElementById('btn-confirm-scan-account');
    const imgPreview = document.getElementById('scan-account-image-preview');

    errorBox?.classList.add('is-hidden');
    previewBox?.classList.add('is-hidden');
    if (confirmBtn) confirmBtn.disabled = true;
    if (loadingText) {
      loadingText.textContent = '🤖 Analizando estado de cuenta con Gemini...';
    }
    loadingEl?.classList.remove('is-hidden');

    try {
      const encoded = await encodeImageToBase64(file);
      if (imgPreview && encoded.dataUrl) {
        imgPreview.src = encoded.dataUrl;
        imgPreview.classList.remove('is-hidden');
      }

      let ocrTextFallback = '';
      if (typeof this.options.extractOcrFallbackText === 'function') {
        try {
          ocrTextFallback = await this.options.extractOcrFallbackText(file);
        } catch {
          ocrTextFallback = '';
        }
      }

      const ctx = this.options.getScanContext?.() || {};
      const result = await analyzeAccountScreenshotWithGemini(encoded.dataUrl, {
        apiKey: ctx.apiKey,
        ocrTextFallback,
        fetchImpl: ctx.fetchImpl,
      });

      this.currentScanResult = result.scan;
      this.renderPreview(result.scan, result.source);
    } catch (err) {
      this.showError(err?.message || 'No se pudo analizar la captura de pantalla.');
    } finally {
      this.isProcessing = false;
      loadingEl?.classList.add('is-hidden');
    }
  }

  showError(message) {
    const errorBox = document.getElementById('scan-account-error-box');
    if (errorBox) {
      errorBox.textContent = `⚠️ ${message}`;
      errorBox.classList.remove('is-hidden');
    }
    this.options.showToast?.(`⚠️ ${message}`);
  }

  renderPreview(scan, source = 'gemini-1.5-flash') {
    const previewBox = document.getElementById('scan-account-preview-box');
    const summaryTitleEl = document.getElementById('scan-account-summary-title');
    const txCountBadgeEl = document.getElementById('scan-account-tx-count-badge');
    const sourceBadgeEl = document.getElementById('scan-account-source-badge');
    const tbody = document.getElementById('scan-account-tx-tbody');
    const confirmBtn = document.getElementById('btn-confirm-scan-account');

    const bankInput = document.getElementById('scan-acc-bank-input');
    const typeInput = document.getElementById('scan-acc-type-input');
    const numberInput = document.getElementById('scan-acc-number-input');
    const currencySelect = document.getElementById('scan-acc-currency-select');
    const balanceInput = document.getElementById('scan-acc-balance-input');
    const statusSelect = document.getElementById('scan-acc-status-select');

    if (bankInput) bankInput.value = scan.bankName || 'Banco General';
    if (typeInput) typeInput.value = scan.accountType || 'Cuenta de Ahorro';
    if (numberInput) numberInput.value = scan.accountNumber || '';
    if (currencySelect) currencySelect.value = scan.currency === 'USD' ? 'USD' : 'HNL';
    if (balanceInput) balanceInput.value = String(cleanAmount(scan.currentBalance));
    if (statusSelect) statusSelect.value = scan.status === 'Inactiva' ? 'Inactiva' : 'Activa';

    const summary = formatAccountScanPreviewSummary(scan);
    if (summaryTitleEl) summaryTitleEl.textContent = summary.accountSummaryTitle;
    if (txCountBadgeEl) txCountBadgeEl.textContent = summary.transactionsCountLabel;
    if (sourceBadgeEl) {
      sourceBadgeEl.textContent =
        source.includes('gemini') || source.includes('genkit')
          ? '🤖 Gemini 1.5 Flash Vision'
          : '⚡ OCR Inteligente';
    }

    if (tbody) {
      const txs = Array.isArray(scan.detectedTransactions) ? scan.detectedTransactions : [];
      if (txs.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="4" style="text-align: center; padding: 1rem; color: var(--text-secondary);">
              No se detectaron movimientos individuales en la captura (se creará únicamente la cuenta con su saldo actual).
            </td>
          </tr>
        `;
      } else {
        const symbol = scan.currency === 'USD' ? '$' : 'L';
        tbody.innerHTML = txs
          .map((tx) => {
            const isIncome = tx.type === 'income';
            const badgeText = isIncome ? 'Ingreso (Crédito)' : 'Gasto (Débito)';
            const amountClass = isIncome ? 'text-income' : 'text-expense';
            const sign = isIncome ? '+' : '-';
            const formattedAmt = cleanAmount(tx.amount).toLocaleString('en-US', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            });
            return `
              <tr>
                <td style="white-space: nowrap; font-variant-numeric: tabular-nums;">${tx.date}</td>
                <td><strong>${tx.concept}</strong></td>
                <td><span class="voucher-pill">${badgeText}</span></td>
                <td class="num-col"><strong class="${amountClass}">${sign} ${symbol} ${formattedAmt}</strong></td>
              </tr>
            `;
          })
          .join('');
      }
    }

    previewBox?.classList.remove('is-hidden');
    if (confirmBtn) confirmBtn.disabled = false;
  }

  syncPreviewHeaderFromInputs() {
    if (!this.currentScanResult) return;
    const updated = this.collectEditedScanPayload();
    const summary = formatAccountScanPreviewSummary(updated);
    const summaryTitleEl = document.getElementById('scan-account-summary-title');
    const txCountBadgeEl = document.getElementById('scan-account-tx-count-badge');
    if (summaryTitleEl) summaryTitleEl.textContent = summary.accountSummaryTitle;
    if (txCountBadgeEl) txCountBadgeEl.textContent = summary.transactionsCountLabel;
  }

  collectEditedScanPayload() {
    const bankInput = document.getElementById('scan-acc-bank-input');
    const typeInput = document.getElementById('scan-acc-type-input');
    const numberInput = document.getElementById('scan-acc-number-input');
    const currencySelect = document.getElementById('scan-acc-currency-select');
    const balanceInput = document.getElementById('scan-acc-balance-input');
    const statusSelect = document.getElementById('scan-acc-status-select');

    return validateAndNormalizeAccountScan({
      accountType: typeInput?.value || this.currentScanResult?.accountType || 'Cuenta de Ahorro',
      accountNumber: numberInput?.value ?? this.currentScanResult?.accountNumber ?? '',
      bankName: bankInput?.value || this.currentScanResult?.bankName || 'Banco General',
      currency: currencySelect?.value || this.currentScanResult?.currency || 'HNL',
      currentBalance: cleanAmount(balanceInput?.value ?? this.currentScanResult?.currentBalance ?? 0),
      status: statusSelect?.value || this.currentScanResult?.status || 'Activa',
      detectedTransactions: this.currentScanResult?.detectedTransactions || [],
    });
  }

  async handleConfirmCreate() {
    if (!this.currentScanResult || this.isProcessing) return;
    this.isProcessing = true;

    const confirmBtn = document.getElementById('btn-confirm-scan-account');
    const dialog = document.getElementById('scan-account-dialog');
    if (confirmBtn) confirmBtn.disabled = true;

    try {
      const payload = this.collectEditedScanPayload();
      const state = this.options.getState?.();
      const ctx = this.options.getScanContext?.() || {};

      const created = await createScannedAccountAndTransactionsAtomically(payload, state, ctx);
      dialog?.close();
      this.options.showToast?.(created.toastMessage);
      this.options.onCreated?.(created);
    } catch (err) {
      this.showError(err?.message || 'Error al guardar la cuenta y transacciones.');
      if (confirmBtn) confirmBtn.disabled = false;
    } finally {
      this.isProcessing = false;
    }
  }
}
