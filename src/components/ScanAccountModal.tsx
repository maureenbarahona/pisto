/**
 * @fileoverview Smart Account Detail Screenshot Scanner Modal Component (`src/components/ScanAccountModal.tsx`).
 *
 * Implements:
 * - Trigger button in "Cuentas y Metas": "📷 Importar con Captura de Pantalla".
 * - Drag-and-drop or file-picker upload for PNG/JPG/WEBP screenshots of mobile banking account details.
 * - Loading state: "🤖 Analizando estado de cuenta con Gemini..." with lightweight animation.
 * - Confirmation preview: e.g. "Cuenta detectada: Atlántida - Ahorro L 3,901.33" and "1 Transacción encontrada".
 * - Atomic Firestore creation of the Account (`accounts` collection) and detected Transactions (`transactions` collection),
 *   followed by toast "🎉 Cuenta y transacciones creadas exitosamente".
 */

import {
  analyzeAccountScreenshotWithGemini,
  createScannedAccountAndTransactionsAtomically,
  formatAccountScanPreviewSummary,
  type AccountScanPayload,
  type AccountScanContext,
} from '../services/accountScanService.ts';
import { validateAndNormalizeAccountScan } from '../schemas/accountScan.ts';
import { attachDialogLightDismissFallback } from '../../public/js/ui/keypadModal.js';
import { Money } from '../../public/js/domain/models.js';

export interface ScanAccountModalOptions {
  dialogEl: HTMLDialogElement | null;
  getState: () => any;
  getScanContext: () => AccountScanContext;
  extractOcrFallbackText?: (file: File) => Promise<string>;
  onCreated?: (result: {
    account: any;
    transactions: any[];
    toastMessage: string;
  }) => void;
  showToast?: (message: string) => void;
}

export class ScanAccountModal {
  private dialogEl: HTMLDialogElement | null;
  private getState: () => any;
  private getScanContext: () => AccountScanContext;
  private extractOcrFallbackText?: (file: File) => Promise<string>;
  private onCreated?: ScanAccountModalOptions['onCreated'];
  private showToast?: (message: string) => void;
  private pendingScanResult: AccountScanPayload | null = null;
  private previewDataUrl: string = '';

  constructor(options: ScanAccountModalOptions) {
    this.dialogEl = options.dialogEl;
    this.getState = options.getState;
    this.getScanContext = options.getScanContext;
    this.extractOcrFallbackText = options.extractOcrFallbackText;
    this.onCreated = options.onCreated;
    this.showToast = options.showToast;

    if (this.dialogEl) {
      attachDialogLightDismissFallback(this.dialogEl);
      this.bindEvents();
    }
  }

  private bindEvents(): void {
    if (!this.dialogEl) return;

    const dropzone = this.dialogEl.querySelector('#scan-account-dropzone') as HTMLElement | null;
    const fileInput = this.dialogEl.querySelector('#scan-account-file-input') as HTMLInputElement | null;
    const selectFileBtn = this.dialogEl.querySelector('#btn-select-scan-account-file') as HTMLButtonElement | null;
    const confirmBtn = this.dialogEl.querySelector('#btn-confirm-scan-account') as HTMLButtonElement | null;
    const resetBtn = this.dialogEl.querySelector('#btn-reset-scan-account') as HTMLButtonElement | null;

    selectFileBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fileInput?.click();
    });

    dropzone?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement)?.closest('button')) return;
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

  open(): void {
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

  close(): void {
    if (!this.dialogEl) return;
    if (this.dialogEl.open && typeof this.dialogEl.close === 'function') {
      this.dialogEl.close();
    } else {
      this.dialogEl.removeAttribute('open');
    }
    this.pendingScanResult = null;
  }

  resetModalState(): void {
    this.pendingScanResult = null;
    this.previewDataUrl = '';
    if (!this.dialogEl) return;

    const loadingBox = this.dialogEl.querySelector('#scan-account-loading-box');
    const previewBox = this.dialogEl.querySelector('#scan-account-preview-box');
    const errorBox = this.dialogEl.querySelector('#scan-account-error-box');
    const confirmBtn = this.dialogEl.querySelector('#btn-confirm-scan-account') as HTMLButtonElement | null;

    loadingBox?.classList.add('is-hidden');
    previewBox?.classList.add('is-hidden');
    errorBox?.classList.add('is-hidden');
    if (confirmBtn) {
      confirmBtn.disabled = true;
    }
  }

  async processScreenshotFile(file: File): Promise<AccountScanPayload | null> {
    if (!file) return null;
    if (!/^image\/(png|jpeg|jpg|webp)$/i.test(file.type)) {
      this.showError('Selecciona una imagen válida en formato PNG, JPG o WEBP.');
      return null;
    }

    const loadingBox = this.dialogEl?.querySelector('#scan-account-loading-box');
    const loadingText = this.dialogEl?.querySelector('#scan-account-loading-text');
    const previewBox = this.dialogEl?.querySelector('#scan-account-preview-box');
    const errorBox = this.dialogEl?.querySelector('#scan-account-error-box');
    const confirmBtn = this.dialogEl?.querySelector('#btn-confirm-scan-account') as HTMLButtonElement | null;

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
    } catch (err: any) {
      this.showError(
        err?.message || 'Error al analizar la captura de pantalla con Gemini.'
      );
      return null;
    } finally {
      loadingBox?.classList.add('is-hidden');
    }
  }

  renderScanPreview(
    scan: AccountScanPayload,
    preview = formatAccountScanPreviewSummary(scan)
  ): void {
    if (!this.dialogEl) return;

    const previewBox = this.dialogEl.querySelector('#scan-account-preview-box');
    const summaryTitleEl = this.dialogEl.querySelector('#scan-account-summary-title');
    const txCountBadgeEl = this.dialogEl.querySelector('#scan-account-tx-count-badge');
    const bankInput = this.dialogEl.querySelector('#scan-acc-bank-input') as HTMLInputElement | null;
    const typeInput = this.dialogEl.querySelector('#scan-acc-type-input') as HTMLInputElement | null;
    const numberInput = this.dialogEl.querySelector('#scan-acc-number-input') as HTMLInputElement | null;
    const currencySelect = this.dialogEl.querySelector('#scan-acc-currency-select') as HTMLSelectElement | null;
    const balanceInput = this.dialogEl.querySelector('#scan-acc-balance-input') as HTMLInputElement | null;
    const statusSelect = this.dialogEl.querySelector('#scan-acc-status-select') as HTMLSelectElement | null;
    const txTbody = this.dialogEl.querySelector('#scan-account-tx-tbody');
    const confirmBtn = this.dialogEl.querySelector('#btn-confirm-scan-account') as HTMLButtonElement | null;

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

  private collectEditedScanPayload(): AccountScanPayload | null {
    if (!this.pendingScanResult) return null;
    if (!this.dialogEl) return this.pendingScanResult;

    const bankInput = this.dialogEl.querySelector('#scan-acc-bank-input') as HTMLInputElement | null;
    const typeInput = this.dialogEl.querySelector('#scan-acc-type-input') as HTMLInputElement | null;
    const numberInput = this.dialogEl.querySelector('#scan-acc-number-input') as HTMLInputElement | null;
    const currencySelect = this.dialogEl.querySelector('#scan-acc-currency-select') as HTMLSelectElement | null;
    const balanceInput = this.dialogEl.querySelector('#scan-acc-balance-input') as HTMLInputElement | null;
    const statusSelect = this.dialogEl.querySelector('#scan-acc-status-select') as HTMLSelectElement | null;

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

  async handleConfirmCreation(): Promise<void> {
    const finalPayload = this.collectEditedScanPayload();
    if (!finalPayload) return;

    const confirmBtn = this.dialogEl?.querySelector('#btn-confirm-scan-account') as HTMLButtonElement | null;
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
    } catch (err: any) {
      this.showError(err?.message || 'Error al guardar la cuenta y transacciones en Firestore.');
    } finally {
      if (confirmBtn) confirmBtn.disabled = false;
    }
  }

  private showError(message: string): void {
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
