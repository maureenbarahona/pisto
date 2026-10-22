export const SMART_SCAN_BUTTON_ID = 'btn-smart-scan';
export const SMART_SCAN_FILE_INPUT_ID = 'smart-scan-file-input';
export const SMART_SCAN_BUTTON_LABEL = '📷 Escanear Documento / PDF';
export const SMART_SCAN_BANNER_DESCRIPTION =
  'Escanea facturas, recibos, vouchers POS, comprobantes de crédito/débito o estados de cuenta en PDF para registrar movimientos automáticamente.';

/**
 * Genera el HTML del contenedor de escaneo inteligente unificado en la pestaña Transacciones.
 * Reemplaza los dos botones previos ("Escanear Voucher" y "Subir Estado de Cuenta PDF")
 * por un único botón primario `#btn-smart-scan`.
 *
 * @returns {string}
 */
export function renderSmartScanBannerMarkup() {
  return `
    <div class="voucher-banner-copy">
      <strong class="voucher-banner-title">
        ✨ Escaneo Inteligente Unificado (Imágenes y PDF)
      </strong>
      <span class="voucher-banner-info" id="smart-scan-banner-description">
        ${SMART_SCAN_BANNER_DESCRIPTION}
      </span>
    </div>
    <div class="voucher-banner-actions">
      <input
        type="file"
        id="${SMART_SCAN_FILE_INPUT_ID}"
        accept="image/png,image/jpeg,image/webp,image/*,application/pdf,.pdf"
        class="sr-only"
      />
      <button
        type="button"
        id="${SMART_SCAN_BUTTON_ID}"
        class="btn-primary"
        data-action="trigger-smart-scan"
      >
        ${SMART_SCAN_BUTTON_LABEL}
      </button>
    </div>
  `.trim();
}

/**
 * Componente de vista de Transacciones (`TransactionsView`) encargado de montar y gestionar
 * el botón unificado `#btn-smart-scan` y su selector de archivos.
 */
export class TransactionsView {
  /**
   * @param {object} [options]
   * @param {Document} [options.doc]
   * @param {Function} [options.onFileSelected]
   */
  constructor(options = {}) {
    this.doc = options.doc || (typeof document !== 'undefined' ? document : null);
    this.onFileSelected = typeof options.onFileSelected === 'function' ? options.onFileSelected : null;
    this._bound = false;
  }

  /**
   * Monta o actualiza el banner `.voucher-scanner-banner` dentro de `#panel-transactions`
   * asegurando que exista únicamente `#btn-smart-scan` y el texto descriptivo unificado.
   *
   * @param {HTMLElement|null} [bannerEl]
   * @returns {HTMLElement|null}
   */
  mountSmartScanBanner(bannerEl = null) {
    if (!this.doc && !bannerEl) return null;
    const targetBanner =
      bannerEl ||
      this.doc.querySelector('#panel-transactions .voucher-scanner-banner') ||
      this.doc.querySelector('.voucher-scanner-banner');

    if (!targetBanner) return null;

    // Si aún contiene los botones antiguos o le falta #btn-smart-scan, renderiza el bloque unificado
    const hasLegacyButtons =
      Boolean(targetBanner.querySelector('#btn-scan-voucher')) ||
      Boolean(targetBanner.querySelector('#btn-upload-statement'));
    const existingSmartBtn = targetBanner.querySelector(`#${SMART_SCAN_BUTTON_ID}`);

    if (hasLegacyButtons || !existingSmartBtn) {
      targetBanner.innerHTML = renderSmartScanBannerMarkup();
    } else {
      const descEl =
        targetBanner.querySelector('#smart-scan-banner-description') ||
        targetBanner.querySelector('.voucher-banner-info');
      if (descEl) {
        descEl.textContent = SMART_SCAN_BANNER_DESCRIPTION;
      }
      existingSmartBtn.textContent = SMART_SCAN_BUTTON_LABEL;
    }

    this.bindEvents(targetBanner);
    return targetBanner;
  }

  /**
   * Enlaza los eventos del botón `#btn-smart-scan` y del input `#smart-scan-file-input`.
   * @param {HTMLElement|Document} [rootEl]
   */
  bindEvents(rootEl = null) {
    const scope = rootEl || this.doc;
    if (!scope) return;

    const smartBtn =
      scope.querySelector?.(`#${SMART_SCAN_BUTTON_ID}`) ||
      this.doc?.getElementById?.(SMART_SCAN_BUTTON_ID);
    const fileInput =
      scope.querySelector?.(`#${SMART_SCAN_FILE_INPUT_ID}`) ||
      this.doc?.getElementById?.(SMART_SCAN_FILE_INPUT_ID);

    if (smartBtn && !smartBtn.dataset.smartScanBound) {
      smartBtn.dataset.smartScanBound = 'true';
      smartBtn.addEventListener('click', (event) => {
        event.preventDefault();
        const inputEl =
          this.doc?.getElementById?.(SMART_SCAN_FILE_INPUT_ID) || fileInput;
        inputEl?.click?.();
      });
    }

    if (fileInput && !fileInput.dataset.smartScanBound) {
      fileInput.dataset.smartScanBound = 'true';
      fileInput.addEventListener('change', (event) => {
        const file = event.target?.files?.[0];
        if (file && typeof this.onFileSelected === 'function') {
          this.onFileSelected(file);
        }
        fileInput.value = '';
      });
    }

    this._bound = true;
  }
}
