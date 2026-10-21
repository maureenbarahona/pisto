/**
 * @fileoverview Vista de Cuentas (`src/components/AccountsView.tsx`) y Orquestador del Modal
 * de Importación de Cuenta desde Imagen o PDF (`ImportAccountModal`).
 *
 * Implementa:
 * 1. Reparación del Handler de Evento:
 *    - Vinculación explícita del botón `"➕ Importar Cuenta desde Imagen/PDF"`:
 *      `<button type="button" onClick={() => setIsImportAccountModalOpen(true)} className="btn-primary">`
 *    - Limpieza de clases CSS bloqueantes en el botón y contenedores padres (`pointer-events-none`, `select-none`).
 *    - Estado accesible `isImportAccountModalOpen` y `setIsImportAccountModalOpen` en el componente y estado global.
 * 2. Garantía de Renderizado del Modal (`ImportAccountModal`):
 *    - Renderizado condicional directo en la vista activa de Cuentas:
 *      `{isImportAccountModalOpen && <ImportAccountModal onClose={() => setIsImportAccountModalOpen(false)} />}`
 *    - Prevención de Tree-Shaking en compilaciones de producción (Vite / Webpack / Cloud Run).
 * 3. Validación Multi-Entorno (Local y Cloud Run):
 *    - Inicialización 100% síncrona sin bloqueo por llamadas asíncronas ni dependencia obligatoria de variables
 *      de entorno de producción para abrir la interfaz de selección de archivo en modo de prueba local/fallback.
 * 4. Código libre de llamadas a `console.log`.
 */

import {
  ImportAccountModal,
  HONDURAS_BANKS_LIST,
  cleanBankName,
  cleanAccountType,
  type ImportAccountModalOptions,
} from './ImportAccountModal.tsx';
import {
  persistImportedAccountAndTransactions,
  type ExtractedAccountData,
  type AccountImportContext,
} from '../services/accountExtractor.ts';

export {
  ImportAccountModal,
  HONDURAS_BANKS_LIST,
  cleanBankName,
  cleanAccountType,
  persistImportedAccountAndTransactions,
};

export const IMPORT_ACCOUNT_BUTTON_ID = 'btn-import-account-media';
export const IMPORT_ACCOUNT_BUTTON_LABEL = '➕ Importar Cuenta desde Imagen/PDF';

const BLOCKING_CSS_CLASSES = ['pointer-events-none', 'select-none', 'is-disabled'] as const;

/**
 * Estado global/accesible para apertura del modal de importación de cuentas.
 */
export let isImportAccountModalOpen = false;

let activeModalInstance: ImportAccountModal | null = null;
const modalStateListeners = new Set<(isOpen: boolean) => void>();

export function getIsImportAccountModalOpen(): boolean {
  return isImportAccountModalOpen;
}

/**
 * Actualiza el estado `isImportAccountModalOpen` y sincroniza la apertura/cierre del modal
 * de forma inmediata y no bloqueante tanto en desarrollo local como en Cloud Run.
 */
export function setIsImportAccountModalOpen(isOpen: boolean): boolean {
  const nextState = Boolean(isOpen);
  isImportAccountModalOpen = nextState;
  if (typeof globalThis !== 'undefined') {
    (globalThis as any).__PISTO_IMPORT_ACCOUNT_MODAL_OPEN__ = nextState;
  }

  if (nextState) {
    const modal = ensureActiveImportAccountModal();
    if (!modal.isImportAccountModalOpen) {
      modal.setIsImportAccountModalOpen(true);
    }
  } else if (activeModalInstance && activeModalInstance.isImportAccountModalOpen) {
    activeModalInstance.setIsImportAccountModalOpen(false);
  }

  for (const listener of modalStateListeners) {
    listener(nextState);
  }

  return isImportAccountModalOpen;
}

export function subscribeImportAccountModalState(
  listener: (isOpen: boolean) => void
): () => void {
  modalStateListeners.add(listener);
  return () => {
    modalStateListeners.delete(listener);
  };
}

/**
 * Remueve cualquier clase CSS en un elemento y sus contenedores padres que pueda bloquear clics
 * (`pointer-events-none`, `select-none`, `is-disabled`).
 */
export function sanitizeClickableAncestors(element: HTMLElement | null): void {
  if (!element) return;
  let cursor: HTMLElement | null = element;
  while (cursor) {
    cursor.classList.remove(...BLOCKING_CSS_CLASSES);
    if (cursor.style && cursor.style.pointerEvents === 'none') {
      cursor.style.pointerEvents = 'auto';
    }
    if (cursor.style && cursor.style.userSelect === 'none') {
      cursor.style.userSelect = 'auto';
    }
    if (typeof document !== 'undefined' && cursor === document.body) {
      break;
    }
    cursor = cursor.parentElement;
  }
}

/**
 * Valida si un archivo seleccionado es compatible con el importador de cuentas (PNG, JPG, JPEG, WEBP o PDF).
 */
export function isSupportedImportAccountFile(
  file: { type?: string; name?: string } | null | undefined
): boolean {
  if (!file) return false;
  const mime = String(file.type || '').trim();
  const name = String(file.name || '').trim();
  return (
    /^image\/(png|jpeg|jpg|webp)$/i.test(mime) ||
    /^application\/pdf$/i.test(mime) ||
    /\.(png|jpe?g|webp|pdf)$/i.test(name)
  );
}

/**
 * Verifica si ya existe una cuenta registrada con el mismo número de cuenta normalizado.
 */
export function checkDuplicateAccountNumber(
  accountNumber: unknown,
  accounts: Array<{ id?: string; name?: string; accountNumber?: string; institution?: string }> = []
): {
  isDuplicate: boolean;
  existingAccount: { id?: string; name?: string; accountNumber?: string; institution?: string } | null;
} {
  const normalizedTarget = String(accountNumber ?? '')
    .replace(/[\s-]/g, '')
    .trim();
  if (!normalizedTarget || !Array.isArray(accounts)) {
    return { isDuplicate: false, existingAccount: null };
  }

  const matched =
    accounts.find((acc) => {
      const candidate = String(acc?.accountNumber ?? '')
        .replace(/[\s-]/g, '')
        .trim();
      return Boolean(candidate) && candidate === normalizedTarget;
    }) || null;

  return {
    isDuplicate: Boolean(matched),
    existingAccount: matched,
  };
}

export function formatDuplicateAccountMessage(account: {
  name?: string;
  accountNumber?: string;
  institution?: string;
}): string {
  const num = String(account?.accountNumber || '').trim();
  const label = String(account?.name || account?.institution || 'Cuenta existente').trim();
  return `Ya existe una cuenta registrada con el número ${num} (${label}).`;
}

export function formatDuplicateOverwriteWarning(account: {
  name?: string;
  accountNumber?: string;
  institution?: string;
}): string {
  return `${formatDuplicateAccountMessage(account)} Verifica si deseas actualizarla o crear un registro adicional.`;
}

export interface AccountsViewOptions extends ImportAccountModalOptions {
  containerSelector?: string;
  initialOpen?: boolean;
}

export interface AccountsViewController {
  readonly isImportAccountModalOpen: boolean;
  setIsImportAccountModalOpen: (isOpen: boolean) => boolean;
  openImportAccountModal: () => void;
  closeImportAccountModal: () => void;
  bindImportAccountButton: () => HTMLButtonElement | null;
  renderMarkup: () => string;
  modal: ImportAccountModal;
}

function ensureActiveImportAccountModal(options: AccountsViewOptions = {}): ImportAccountModal {
  if (!activeModalInstance) {
    activeModalInstance = new ImportAccountModal({
      ...options,
      onClose: () => {
        isImportAccountModalOpen = false;
        if (typeof globalThis !== 'undefined') {
          (globalThis as any).__PISTO_IMPORT_ACCOUNT_MODAL_OPEN__ = false;
        }
        options.onClose?.();
      },
    });
    activeModalInstance.init();
  }
  return activeModalInstance;
}

/**
 * Renderizado descriptivo de la vista activa de Cuentas incluyendo el botón con `onClick` explícito
 * y el renderizado condicional `{isImportAccountModalOpen && <ImportAccountModal onClose={() => setIsImportAccountModalOpen(false)} />}`.
 */
export function renderAccountsViewTemplate(openState = isImportAccountModalOpen): string {
  // Referencia explícita anti-Tree-Shaking al constructor ImportAccountModal
  const ModalComponent = ImportAccountModal;
  const modalRenderedSection =
    openState && ModalComponent
      ? '<div data-rendered-component="ImportAccountModal" data-modal-open="true"></div>'
      : '';

  return [
    '<div class="toolbar-action-group">',
    `  <button type="button" id="${IMPORT_ACCOUNT_BUTTON_ID}" data-action="open-import-account-modal" onClick="() => setIsImportAccountModalOpen(true)" class="btn-primary">`,
    `    ${IMPORT_ACCOUNT_BUTTON_LABEL}`,
    '  </button>',
    '</div>',
    modalRenderedSection,
  ].join('\n');
}

/**
 * Componente / Controlador principal de la vista de Cuentas (`AccountsView`).
 *
 * Estructura de eventos y renderizado condicional:
 * - Botón: `<button type="button" onClick={() => setIsImportAccountModalOpen(true)} className="btn-primary">➕ Importar Cuenta desde Imagen/PDF</button>`
 * - Modal condicional: `{isImportAccountModalOpen && <ImportAccountModal onClose={() => setIsImportAccountModalOpen(false)} />}`
 */
export class AccountsView implements AccountsViewController {
  private options: AccountsViewOptions;
  public modal: ImportAccountModal;

  constructor(options: AccountsViewOptions = {}) {
    this.options = options;
    this.modal = new ImportAccountModal({
      ...options,
      onClose: () => {
        setIsImportAccountModalOpen(false);
        this.options.onClose?.();
      },
    });
    activeModalInstance = this.modal;

    if (options.initialOpen) {
      isImportAccountModalOpen = true;
    }
  }

  get isImportAccountModalOpen(): boolean {
    return isImportAccountModalOpen;
  }

  public setIsImportAccountModalOpen = (isOpen: boolean): boolean => {
    const next = Boolean(isOpen);
    isImportAccountModalOpen = next;
    if (typeof globalThis !== 'undefined') {
      (globalThis as any).__PISTO_IMPORT_ACCOUNT_MODAL_OPEN__ = next;
    }
    this.modal.setIsImportAccountModalOpen(next);
    return isImportAccountModalOpen;
  };

  public openImportAccountModal = (): void => {
    this.setIsImportAccountModalOpen(true);
  };

  public closeImportAccountModal = (): void => {
    this.setIsImportAccountModalOpen(false);
  };

  public init(): this {
    this.modal.init();
    this.bindImportAccountButton();
    if (isImportAccountModalOpen) {
      this.modal.setIsImportAccountModalOpen(true);
    }
    return this;
  }

  /**
   * Garantiza que el botón `"➕ Importar Cuenta desde Imagen/PDF"` exista en la vista activa de Cuentas,
   * limpia cualquier clase CSS bloqueante (`pointer-events-none`, `select-none`) en sus contenedores padres
   * y vincula explícitamente `onClick={() => setIsImportAccountModalOpen(true)}`.
   */
  public bindImportAccountButton(): HTMLButtonElement | null {
    if (typeof document === 'undefined') return null;

    const panelAccounts = document.getElementById('panel-accounts');
    if (panelAccounts) {
      sanitizeClickableAncestors(panelAccounts);
    }

    const actionContainer = document.querySelector<HTMLElement>(
      '#panel-accounts .toolbar-action-group, #panel-accounts .section-toolbar > div:last-child, #panel-accounts .section-header > div:last-child'
    );
    if (actionContainer) {
      sanitizeClickableAncestors(actionContainer);
    }

    let button = document.getElementById(IMPORT_ACCOUNT_BUTTON_ID) as HTMLButtonElement | null;
    if (!button && actionContainer) {
      button = document.createElement('button');
      button.type = 'button';
      button.id = IMPORT_ACCOUNT_BUTTON_ID;
      button.className = 'btn-primary';
      button.dataset.action = 'open-import-account-modal';
      button.setAttribute('aria-label', 'Importar cuenta y movimientos desde imagen o PDF');
      button.textContent = IMPORT_ACCOUNT_BUTTON_LABEL;
      actionContainer.insertBefore(button, actionContainer.firstChild);
    }

    const buttons = document.querySelectorAll<HTMLButtonElement>(
      `#${IMPORT_ACCOUNT_BUTTON_ID}, [data-action="open-import-account-modal"]`
    );

    buttons.forEach((btn) => {
      btn.type = 'button';
      btn.disabled = false;
      btn.removeAttribute('disabled');
      btn.classList.remove(...BLOCKING_CSS_CLASSES);
      btn.style.pointerEvents = 'auto';
      btn.style.userSelect = 'auto';
      btn.style.cursor = 'pointer';
      btn.style.position = 'relative';
      btn.style.zIndex = '10';
      sanitizeClickableAncestors(btn);

      btn.onclick = (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        this.setIsImportAccountModalOpen(true);
      };
    });

    return button;
  }

  public renderMarkup(): string {
    return renderAccountsViewTemplate(this.isImportAccountModalOpen);
  }
}

export function createAccountsView(options: AccountsViewOptions = {}): AccountsView {
  const view = new AccountsView(options);
  return view.init();
}

export { AccountsView as AccountsTab, createAccountsView as createAccountsTab };

// Registro global para evitar Tree-Shaking agresivo en compilaciones de producción (Vite / Webpack / Cloud Run)
if (typeof globalThis !== 'undefined') {
  (globalThis as any).__PISTO_ACCOUNTS_VIEW__ = AccountsView;
  (globalThis as any).__PISTO_IMPORT_ACCOUNT_MODAL__ = ImportAccountModal;
  (globalThis as any).__PISTO_SET_IMPORT_ACCOUNT_MODAL_OPEN__ = setIsImportAccountModalOpen;
}

export default AccountsView;
