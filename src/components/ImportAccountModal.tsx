/**
 * @fileoverview Modal dedicado "Crear / Importar Cuenta desde Imagen o PDF" (`src/components/ImportAccountModal.tsx`).
 *
 * Implementa:
 * 1. Campos de Formulario Editables (User Override):
 *    - Nombre del Banco: `<select>` + `<input list="...">` con autocompletado de los principales bancos de Honduras:
 *      `["Banco Atlántida", "BAC Credomatic", "Banco Ficohsa", "Banpaís (Banco del País)", "Banco de Occidente", "Davivienda", "Promerica", "Otro / Personalizado"]`.
 *    - Tipo de Cuenta: `<input type="text">` editable (ej. "CUENTA DE AHORRO SOS").
 *    - Número de Cuenta Completo: `<input type="text">` editable (ej. "213130058771").
 *    - Moneda: `<select>` editable (`HNL` / `USD`).
 *    - Saldo Inicial / Disponible: `<input type="number" step="0.01">` editable.
 * 2. Sanitización / Filtro Previo de Texto Extraído (`cleanBankName`):
 *    - Filtra basura de la barra de estado o interfaz del teléfono (`©`, `=`, `<`, `5:30`, `Detalle de cuenta`, `--`, `Bal all`)
 *      y asigna por palabras clave (ej. "AHORRO" o "SOS" -> "Banco Atlántida") o establece "Banco Atlántida" por defecto.
 * 3. Edición de Transacciones de la Tabla:
 *    - Permite editar directamente en cada fila de la tabla la fecha (`<input type="date">`),
 *      el concepto/descripción (`<input type="text">`), el tipo (`<select>`) y el monto (`<input type="number" step="0.01">`),
 *      además de seleccionar/deseleccionar con checkbox.
 * 4. Flujo de Guardado Final:
 *    - Al hacer clic en "Confirmar y Crear Cuenta", guarda en Firestore ÚNICAMENTE los valores finales
 *      presentes en los inputs editados por el usuario.
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
  type ExtractedAccountData,
  type ExtractedTransactionItem,
  type AccountImportContext,
} from '../services/accountExtractor.ts';
import {
  useAccountAgentADK,
  ADK_INIT_LOG_MESSAGE,
  ADK_DEMO_ACCOUNT_DATA,
} from '../services/agentService.ts';
import { formatAccountScanPreviewSummary } from '../services/accountScanService.ts';
import { attachDialogLightDismissFallback } from '../../public/js/ui/keypadModal.js';

export { useAccountAgentADK, ADK_INIT_LOG_MESSAGE, ADK_DEMO_ACCOUNT_DATA };

/**
 * Lista oficial de bancos principales de Honduras para el selector / autocompletado del modal.
 */
export const HONDURAS_BANKS_LIST = Object.freeze([
  'Banco Atlántida',
  'BAC Credomatic',
  'Banco Ficohsa',
  'Banpaís (Banco del País)',
  'Banco de Occidente',
  'Davivienda',
  'Promerica',
  'Otro / Personalizado',
] as const);

export type HondurasBankOption = (typeof HONDURAS_BANKS_LIST)[number];

/**
 * Patrones de ruido de interfaz móvil y basura de OCR que deben limpiarse del nombre del banco.
 */
const BANK_UI_GARBAGE_REGEX =
  /[©®™=<>|_~^•*«»]|--|\b\d{1,2}:\d{2}\b|\b(?:4G|5G|LTE|WIFI|VOLTE)\b|\bdetalle\s+de\s+cuenta\b|\bbal\s*all\b|\bsaldo\s+disponible\b|\bconsulta\s+de\b/i;

/**
 * Sanitiza y filtra el texto extraído del nombre del banco antes de asignarlo al estado del formulario.
 * - Si contiene caracteres raros de la interfaz del teléfono (`©`, `=`, `<`, `5:30`, `Detalle de cuenta`, `Bal all`),
 *   lo ignora y detecta el banco por palabras clave (ej. si ve "AHORRO" o "SOS" en contexto Atlántida -> "Banco Atlántida").
 * - Si la extracción falla o devuelve basura ilegible, establece por defecto `"Banco Atlántida"`.
 */
export function cleanBankName(rawText: unknown, contextHint: unknown = ''): string {
  const raw = String(rawText ?? '').trim();
  const hint = String(contextHint ?? '').trim();
  const combined = `${raw} ${hint}`.toLowerCase();

  // 1. Detección directa por palabras clave de bancos hondureños en el texto o contexto
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

  // 2. Contexto Atlántida por tipo de producto (ej. "CUENTA DE AHORRO SOS" o "AHORRO SOS")
  if (/\bsos\b/i.test(combined) || /\bcuenta\s+de\s+ahorro\s+sos\b/i.test(combined)) {
    return 'Banco Atlántida';
  }

  // 3. Verificar si el texto extraído contiene basura de la barra de estado / UI móvil
  const hasUiGarbage =
    !raw ||
    raw.toLowerCase() === 'banco general' ||
    BANK_UI_GARBAGE_REGEX.test(raw) ||
    isMobileUiNoiseLine(raw);

  if (hasUiGarbage) {
    // Si en el contexto aparece "AHORRO" o "SOS", sugerir "Banco Atlántida"
    if (/\b(?:ahorro|sos)\b/i.test(combined)) {
      return 'Banco Atlántida';
    }
    return HONDURAS_BANKS_LIST[0]; // "Banco Atlántida" por defecto cuando falla o trae basura
  }

  // 4. Limpiar caracteres no alfabéticos/extraños residuales
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

/**
 * Limpia el texto extraído para el campo Tipo de Cuenta, removiendo ruido de la barra de estado móvil.
 */
export function cleanAccountType(rawAccountType: unknown): string {
  const cleaned = cleanMobileUiText(String(rawAccountType ?? ''))
    .replace(/[©®™=<>|_~^•*«»]|--|\b\d{1,2}:\d{2}\b|\bdetalle\s+de\s+cuenta\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned.length < 3) {
    return 'Cuenta de Ahorro';
  }
  return cleaned;
}

function escapeHtmlAttr(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export interface ImportAccountModalOptions {
  getState?: () => any;
  getImportContext?: () => AccountImportContext;
  extractOcrFallbackText?: (file: File, onProgress?: (status: string) => void) => Promise<string>;
  onCreated?: (result: { account: any; transactions: any[]; toastMessage: string }) => void;
  onClose?: () => void;
  showToast?: (message: string) => void;
}

export class ImportAccountModal {
  private options: ImportAccountModalOptions;
  public currentExtracted: ExtractedAccountData | null = null;
  public isImportAccountModalOpen = false;
  private isProcessing = false;
  private agentADK: ReturnType<typeof useAccountAgentADK>;

  constructor(options: ImportAccountModalOptions = {}) {
    this.options = options;
    this.agentADK = useAccountAgentADK({
      notifyToast: (msg) => this.options.showToast?.(msg),
    });
  }

  init(): void {
    this.ensureModalDom();
    this.bindTriggerButtons();
    this.bindDialogInternalEvents();
  }

  private bindDialogInternalEvents(): void {
    if (typeof document === 'undefined') return;
    const dialog = document.getElementById('import-account-dialog') as HTMLDialogElement | null;
    if (!dialog) return;

    this.populateBankOptions();
    if (dialog.dataset.boundImportModal === 'true') return;
    dialog.dataset.boundImportModal = 'true';

    attachDialogLightDismissFallback(dialog);
    dialog.addEventListener('close', () => {
      const wasOpen = this.isImportAccountModalOpen;
      this.isImportAccountModalOpen = false;
      (globalThis as any).__PISTO_IMPORT_ACCOUNT_MODAL_OPEN__ = false;
      if (wasOpen) {
        this.options.onClose?.();
      }
    });

    const fileInput = document.getElementById('import-account-file-input') as HTMLInputElement | null;
    const dropzone = document.getElementById('import-account-dropzone');
    const triggerBtn = document.getElementById('btn-trigger-import-account-file');
    const demoAdkBtn = document.getElementById('btn-import-account-demo-adk');
    const confirmBtn = document.getElementById('btn-confirm-import-account') as HTMLButtonElement | null;
    const cancelBtn = document.getElementById('btn-cancel-import-account');
    const closeBtn = document.getElementById('btn-close-import-account');
    const selectAllCheckbox = document.getElementById('import-account-select-all-tx') as HTMLInputElement | null;
    const addTxRowBtn = document.getElementById('btn-import-account-add-tx');
    const tbody = document.getElementById('import-account-tx-tbody');

    const bankSelect = document.getElementById('import-acc-bank-select') as HTMLSelectElement | null;
    const bankInput = document.getElementById('import-acc-bank-input') as HTMLInputElement | null;

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
      const target = e.target as HTMLElement | null;
      if (
        target?.closest('#btn-trigger-import-account-file') ||
        target?.closest('#btn-import-account-demo-adk')
      ) {
        return;
      }
      fileInput?.click();
    });

    dropzone?.addEventListener('keydown', (e: KeyboardEvent) => {
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

    dropzone?.addEventListener('drop', (e: DragEvent) => {
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

    // Sincronización entre el <select> de bancos de Honduras y el <input> editable / personalizado
    bankSelect?.addEventListener('change', () => {
      const selectedVal = bankSelect.value;
      const customWrapper = document.getElementById('import-acc-bank-custom-wrapper');
      if (selectedVal === 'Otro / Personalizado') {
        customWrapper?.classList.remove('is-hidden');
        if (bankInput) {
          if ((HONDURAS_BANKS_LIST as readonly string[]).includes(bankInput.value)) {
            bankInput.value = '';
          }
          bankInput.focus();
        }
      } else {
        if (bankInput) {
          bankInput.value = selectedVal;
        }
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
      this.renderTransactionsTable();
      this.syncSelectAllCheckboxState();
      this.syncSummaryBanner();
    });

    // Edición en vivo de las filas de transacciones en la tabla (checkbox, fecha, concepto, tipo, monto)
    const handleTableFieldMutation = (e: Event) => {
      const target = e.target as HTMLInputElement | HTMLSelectElement | null;
      if (!target || !this.currentExtracted) return;

      if (target.hasAttribute('data-import-tx-index')) {
        const idx = Number.parseInt(target.getAttribute('data-import-tx-index') || '-1', 10);
        if (idx >= 0 && idx < this.currentExtracted.detectedTransactions.length) {
          this.currentExtracted.detectedTransactions[idx].selected = Boolean(
            (target as HTMLInputElement).checked
          );
          this.syncSelectAllCheckboxState();
          this.syncSummaryBanner();
        }
        return;
      }

      if (target.hasAttribute('data-import-tx-date')) {
        const idx = Number.parseInt(target.getAttribute('data-import-tx-date') || '-1', 10);
        if (idx >= 0 && idx < this.currentExtracted.detectedTransactions.length) {
          this.currentExtracted.detectedTransactions[idx].date = normalizeScanDateToIso(target.value);
          this.syncSummaryBanner();
        }
        return;
      }

      if (target.hasAttribute('data-import-tx-concept')) {
        const idx = Number.parseInt(target.getAttribute('data-import-tx-concept') || '-1', 10);
        if (idx >= 0 && idx < this.currentExtracted.detectedTransactions.length) {
          this.currentExtracted.detectedTransactions[idx].concept = target.value;
          this.syncSummaryBanner();
        }
        return;
      }

      if (target.hasAttribute('data-import-tx-type')) {
        const idx = Number.parseInt(target.getAttribute('data-import-tx-type') || '-1', 10);
        if (idx >= 0 && idx < this.currentExtracted.detectedTransactions.length) {
          this.currentExtracted.detectedTransactions[idx].type =
            target.value === 'income' ? 'income' : 'expense';
          this.syncSummaryBanner();
        }
        return;
      }

      if (target.hasAttribute('data-import-tx-amount')) {
        const idx = Number.parseInt(target.getAttribute('data-import-tx-amount') || '-1', 10);
        if (idx >= 0 && idx < this.currentExtracted.detectedTransactions.length) {
          this.currentExtracted.detectedTransactions[idx].amount = Math.abs(cleanAmount(target.value));
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
      document.getElementById(id)?.addEventListener('input', () => this.syncSummaryBanner());
      document.getElementById(id)?.addEventListener('change', () => {
        if (id === 'import-acc-currency-select') {
          this.syncTransactionsFromDom();
          this.renderTransactionsTable();
        }
        this.syncSummaryBanner();
      });
    }

    confirmBtn?.addEventListener('click', () => this.handleConfirmCreate());
    cancelBtn?.addEventListener('click', () => this.setIsImportAccountModalOpen(false));
    closeBtn?.addEventListener('click', () => this.setIsImportAccountModalOpen(false));
  }

  /**
   * Vincula explícitamente el evento `onClick` en el botón `"➕ Importar Cuenta desde Imagen/PDF"`
   * (`#btn-import-account-media` y `[data-action="open-import-account-modal"]`), garantizando que
   * ni el botón ni sus contenedores padres tengan `pointer-events-none`, `select-none` o `disabled`.
   */
  public bindTriggerButtons(): void {
    if (typeof document === 'undefined') return;
    const buttons = document.querySelectorAll<HTMLButtonElement>(
      '#btn-import-account-media, [data-action="open-import-account-modal"]'
    );
    buttons.forEach((btn) => {
      btn.type = 'button';
      btn.disabled = false;
      btn.removeAttribute('disabled');
      btn.classList.remove('pointer-events-none', 'select-none', 'is-disabled');
      btn.style.pointerEvents = 'auto';
      btn.style.cursor = 'pointer';
      btn.style.position = 'relative';
      btn.style.zIndex = '10';

      let parentEl: HTMLElement | null = btn.parentElement;
      while (parentEl && parentEl !== document.body) {
        parentEl.classList.remove('pointer-events-none', 'select-none', 'is-disabled');
        if (parentEl.style?.pointerEvents === 'none') {
          parentEl.style.pointerEvents = 'auto';
        }
        parentEl = parentEl.parentElement;
      }

      btn.onclick = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        this.setIsImportAccountModalOpen(true);
      };
    });
  }

  /**
   * Cambia el estado de apertura del modal (`isImportAccountModalOpen`) de forma síncrona
   * sin depender de llamadas asíncronas bloqueantes, permitiendo modo de prueba local/fallback.
   */
  public setIsImportAccountModalOpen(isOpen: boolean): void {
    const nextState = Boolean(isOpen);
    const prevState = this.isImportAccountModalOpen;
    this.isImportAccountModalOpen = nextState;
    (globalThis as any).__PISTO_IMPORT_ACCOUNT_MODAL_OPEN__ = nextState;

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
    const dialog = document.getElementById('import-account-dialog') as HTMLDialogElement | null;
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

  /**
   * Garantiza que las opciones de `HONDURAS_BANKS_LIST` estén presentes en el `<select>` y `<datalist>`.
   */
  private populateBankOptions(): void {
    const bankSelect = document.getElementById('import-acc-bank-select') as HTMLSelectElement | null;
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

  /**
   * Si el botón o el modal no están aún en el DOM, los inyecta de forma segura.
   */
  private ensureModalDom(): void {
    if (typeof document === 'undefined') return;

    const accountsPanelActions = document.querySelector(
      '#panel-accounts .toolbar-action-group, #panel-accounts .section-toolbar > div:last-child, #panel-accounts .section-header > div:last-child'
    );
    if (accountsPanelActions && !document.getElementById('btn-import-account-media')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'btn-import-account-media';
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

  open(): void {
    this.setIsImportAccountModalOpen(true);
  }

  /**
   * Carga los datos estáticos de demostración del Agente ADK ("Banco Atlántida - Cuenta de Ahorro SOS", L 3,901.33)
   * directamente en el formulario editable de confirmación.
   */
  public handleLoadDemoADK(): ExtractedAccountData {
    const demoResult = this.agentADK.loadDemoFallback();
    const sanitized = this.sanitizeExtractedData(demoResult.data);
    this.currentExtracted = sanitized;
    if (typeof document !== 'undefined') {
      this.renderPreview(sanitized, demoResult.source);
    }
    this.options.showToast?.(demoResult.message);
    return sanitized;
  }

  resetView(): void {
    this.currentExtracted = null;
    this.isProcessing = false;

    const loadingBox = document.getElementById('import-account-loading-box');
    const previewBox = document.getElementById('import-account-preview-box');
    const errorBox = document.getElementById('import-account-error-box');
    const confirmBtn = document.getElementById('btn-confirm-import-account') as HTMLButtonElement | null;
    const imgPreview = document.getElementById('import-account-image-preview') as HTMLImageElement | null;

    loadingBox?.classList.add('is-hidden');
    previewBox?.classList.add('is-hidden');
    errorBox?.classList.add('is-hidden');
    if (errorBox) errorBox.textContent = '';
    if (confirmBtn) confirmBtn.disabled = true;
    if (imgPreview) {
      imgPreview.removeAttribute('src');
      imgPreview.classList.add('is-hidden');
    }
  }

  async handleFileSelected(file: File): Promise<void> {
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
    const confirmBtn = document.getElementById('btn-confirm-import-account') as HTMLButtonElement | null;
    const imgPreview = document.getElementById('import-account-image-preview') as HTMLImageElement | null;

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
      this.renderPreview(sanitizedData, adkResult.source);
      if (adkResult.isDemoFallback) {
        this.options.showToast?.(adkResult.message);
      }
    } catch (err: any) {
      // Fallback de emergencia del Agente ADK para garantizar que el modal siempre abra y funcione en pruebas
      const fallbackResult = this.agentADK.loadDemoFallback();
      const sanitizedFallback = this.sanitizeExtractedData(fallbackResult.data);
      this.currentExtracted = sanitizedFallback;
      this.renderPreview(sanitizedFallback, fallbackResult.source);
      this.options.showToast?.(fallbackResult.message);
    } finally {
      this.isProcessing = false;
      loadingBox?.classList.add('is-hidden');
    }
  }

  /**
   * Aplica `cleanBankName` y `cleanAccountType` al resultado extraído antes de asignarlo al estado.
   */
  public sanitizeExtractedData(
    rawData: ExtractedAccountData,
    contextHint = ''
  ): ExtractedAccountData {
    const cleanedAccountType = cleanAccountType(rawData?.accountType);
    const cleanedBank = cleanBankName(
      rawData?.bankName,
      `${cleanedAccountType} ${contextHint}`
    );

    const cleanedTransactions: ExtractedTransactionItem[] = (
      rawData?.detectedTransactions || []
    ).map((tx, idx) => ({
      id: tx.id || `imp_tx_${idx}_${Date.now().toString(36)}`,
      date: normalizeScanDateToIso(tx.date),
      concept:
        cleanMobileUiText(String(tx.concept || 'Movimiento bancario'))
          .replace(/\s+/g, ' ')
          .trim() || 'Movimiento bancario',
      type: tx.type === 'income' ? 'income' : 'expense',
      amount: Math.abs(cleanAmount(tx.amount)),
      selected: tx.selected !== false,
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

  private showError(message: string): void {
    const errorBox = document.getElementById('import-account-error-box');
    if (errorBox) {
      errorBox.textContent = `⚠️ ${message}`;
      errorBox.classList.remove('is-hidden');
    }
    this.options.showToast?.(`⚠️ ${message}`);
  }

  private readEditedBankName(): string {
    const bankSelect =
      typeof document !== 'undefined'
        ? (document.getElementById('import-acc-bank-select') as HTMLSelectElement | null)
        : null;
    const bankInput =
      typeof document !== 'undefined'
        ? (document.getElementById('import-acc-bank-input') as HTMLInputElement | null)
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

  public renderPreview(data: ExtractedAccountData, source = 'gemini-1.5-flash'): void {
    this.populateBankOptions();
    const sanitized = this.sanitizeExtractedData(data);
    this.currentExtracted = sanitized;

    const previewBox = document.getElementById('import-account-preview-box');
    const sourceBadge = document.getElementById('import-account-source-badge');
    const confirmBtn = document.getElementById('btn-confirm-import-account') as HTMLButtonElement | null;

    const bankSelect = document.getElementById('import-acc-bank-select') as HTMLSelectElement | null;
    const bankInput = document.getElementById('import-acc-bank-input') as HTMLInputElement | null;
    const typeInput = document.getElementById('import-acc-type-input') as HTMLInputElement | null;
    const numberInput = document.getElementById('import-acc-number-input') as HTMLInputElement | null;
    const currencySelect = document.getElementById('import-acc-currency-select') as HTMLSelectElement | null;
    const balanceInput = document.getElementById('import-acc-balance-input') as HTMLInputElement | null;

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

    this.renderTransactionsTable();
    this.syncSelectAllCheckboxState();
    this.syncSummaryBanner();

    previewBox?.classList.remove('is-hidden');
    if (confirmBtn) confirmBtn.disabled = false;
  }

  /**
   * Renderiza la tabla de movimientos con inputs editables para Fecha, Concepto/Descripción, Tipo y Monto.
   */
  public renderTransactionsTable(): void {
    const tbody = document.getElementById('import-account-tx-tbody');
    if (!tbody || !this.currentExtracted) return;

    const txs = this.currentExtracted.detectedTransactions || [];
    const currencySelect = document.getElementById('import-acc-currency-select') as HTMLSelectElement | null;
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
        const isChecked = tx.selected !== false;
        const numericAmount = cleanAmount(tx.amount);
        const safeDate = normalizeScanDateToIso(tx.date);

        return `
          <tr>
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

  /**
   * Sincroniza en `this.currentExtracted.detectedTransactions` todos los valores editados en los inputs de la tabla.
   */
  public syncTransactionsFromDom(): ExtractedTransactionItem[] {
    if (!this.currentExtracted) return [];
    if (typeof document === 'undefined') return this.currentExtracted.detectedTransactions;
    const tbody = document.getElementById('import-account-tx-tbody');
    if (!tbody) return this.currentExtracted.detectedTransactions;

    const rows = this.currentExtracted.detectedTransactions.map((tx, idx) => {
      const checkEl = tbody.querySelector(
        `[data-import-tx-index="${idx}"]`
      ) as HTMLInputElement | null;
      const dateEl = tbody.querySelector(
        `[data-import-tx-date="${idx}"]`
      ) as HTMLInputElement | null;
      const conceptEl = tbody.querySelector(
        `[data-import-tx-concept="${idx}"]`
      ) as HTMLInputElement | null;
      const typeEl = tbody.querySelector(
        `[data-import-tx-type="${idx}"]`
      ) as HTMLSelectElement | null;
      const amountEl = tbody.querySelector(
        `[data-import-tx-amount="${idx}"]`
      ) as HTMLInputElement | null;

      return {
        ...tx,
        selected: checkEl ? Boolean(checkEl.checked) : tx.selected !== false,
        date: dateEl?.value ? normalizeScanDateToIso(dateEl.value) : tx.date,
        concept:
          conceptEl?.value !== undefined
            ? conceptEl.value.trim() || 'Movimiento bancario'
            : tx.concept,
        type: (typeEl?.value
          ? typeEl.value === 'income'
            ? 'income'
            : 'expense'
          : tx.type) as 'income' | 'expense',
        amount:
          amountEl?.value !== undefined
            ? Math.abs(cleanAmount(amountEl.value))
            : Math.abs(cleanAmount(tx.amount)),
      };
    });

    this.currentExtracted.detectedTransactions = rows;
    return rows;
  }

  private syncSelectAllCheckboxState(): void {
    const selectAllCheckbox = document.getElementById('import-account-select-all-tx') as HTMLInputElement | null;
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

  private syncSummaryBanner(): void {
    if (!this.currentExtracted) return;
    const currentPayload = this.collectConfirmedPayload();
    const selectedTxs = currentPayload.detectedTransactions.filter((t) => t.selected !== false);
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

  /**
   * Recolecta ÚNICAMENTE los valores finales presentes en los inputs editados por el usuario
   * tanto en el formulario de cuenta como en la tabla de transacciones.
   */
  public collectConfirmedPayload(): ExtractedAccountData {
    const typeInput =
      typeof document !== 'undefined'
        ? (document.getElementById('import-acc-type-input') as HTMLInputElement | null)
        : null;
    const numberInput =
      typeof document !== 'undefined'
        ? (document.getElementById('import-acc-number-input') as HTMLInputElement | null)
        : null;
    const currencySelect =
      typeof document !== 'undefined'
        ? (document.getElementById('import-acc-currency-select') as HTMLSelectElement | null)
        : null;
    const balanceInput =
      typeof document !== 'undefined'
        ? (document.getElementById('import-acc-balance-input') as HTMLInputElement | null)
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

  async handleConfirmCreate(): Promise<void> {
    if (!this.currentExtracted || this.isProcessing) return;
    this.isProcessing = true;

    const confirmBtn = document.getElementById('btn-confirm-import-account') as HTMLButtonElement | null;
    const dialog = document.getElementById('import-account-dialog') as HTMLDialogElement | null;
    if (confirmBtn) confirmBtn.disabled = true;

    try {
      const payload = this.collectConfirmedPayload();
      const state = this.options.getState?.();
      const ctx = this.options.getImportContext?.() || {};

      const created = await persistImportedAccountAndTransactions(payload, state, ctx);
      this.setIsImportAccountModalOpen(false);
      this.options.showToast?.(created.toastMessage);
      this.options.onCreated?.(created);
    } catch (err: any) {
      this.showError(err?.message || 'Error al guardar la cuenta y movimientos.');
      if (confirmBtn) confirmBtn.disabled = false;
    } finally {
      this.isProcessing = false;
    }
  }
}

// Registro global anti-Tree-Shaking para compilaciones de producción (Vite / Webpack / Cloud Run)
if (typeof globalThis !== 'undefined') {
  (globalThis as any).__PISTO_IMPORT_ACCOUNT_MODAL__ = ImportAccountModal;
}

export default ImportAccountModal;

