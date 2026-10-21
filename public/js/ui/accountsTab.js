/**
 * @fileoverview Vista de Cuentas (`public/js/ui/accountsTab.js`) y Orquestador del Modal
 * de Importación de Cuenta desde Imagen o PDF (`ImportAccountModal`) para ejecución en navegador
 * (Desarrollo Local y Cloud Run).
 *
 * Implementa:
 * 1. Reparación del Handler de Evento:
 *    - Vincula explícitamente el botón `"➕ Importar Cuenta desde Imagen/PDF"` (`#btn-import-account-media`)
 *      con `onClick={() => setIsImportAccountModalOpen(true)}`.
 *    - Remueve cualquier clase CSS bloqueante (`pointer-events-none`, `select-none`, `is-disabled`)
 *      en el botón y sus contenedores padres.
 * 2. Garantía de Renderizado del Modal (`ImportAccountModal`):
 *    - Renderiza y abre el modal de forma síncrona al cambiar `isImportAccountModalOpen` a `true`,
 *      ejecutando `onClose={() => setIsImportAccountModalOpen(false)}` al cerrarse.
 *    - Registra referencias globales para evitar Tree-Shaking en compilaciones de producción.
 * 3. Validación Multi-Entorno (Local y Cloud Run):
 *    - Sin bloqueo por llamadas asíncronas en la inicialización; permite seleccionar archivo o cargar
 *      modo de prueba local/fallback aunque no existan variables de entorno de producción.
 * 4. Libre de llamadas a `console.log`.
 */

import {
  ImportAccountModal,
  HONDURAS_BANKS_LIST,
  cleanBankName,
  cleanAccountType,
} from './importAccountModal.js';
import { persistImportedAccountAndTransactions } from '../services/accountExtractor.js';

export {
  ImportAccountModal,
  HONDURAS_BANKS_LIST,
  cleanBankName,
  cleanAccountType,
  persistImportedAccountAndTransactions,
};

export const IMPORT_ACCOUNT_BUTTON_ID = 'btn-import-account-media';
export const IMPORT_ACCOUNT_BUTTON_LABEL = '➕ Importar Cuenta desde Imagen/PDF';

const BLOCKING_CSS_CLASSES = ['pointer-events-none', 'select-none', 'is-disabled'];

export let isImportAccountModalOpen = false;

let activeModalInstance = null;
const modalStateListeners = new Set();

export function getIsImportAccountModalOpen() {
  return isImportAccountModalOpen;
}

export function setIsImportAccountModalOpen(isOpen) {
  const nextState = Boolean(isOpen);
  isImportAccountModalOpen = nextState;
  if (typeof globalThis !== 'undefined') {
    globalThis.__PISTO_IMPORT_ACCOUNT_MODAL_OPEN__ = nextState;
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

export function subscribeImportAccountModalState(listener) {
  modalStateListeners.add(listener);
  return () => {
    modalStateListeners.delete(listener);
  };
}

export function sanitizeClickableAncestors(element) {
  if (!element) return;
  let cursor = element;
  while (cursor) {
    cursor.classList?.remove(...BLOCKING_CSS_CLASSES);
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

export function isSupportedImportAccountFile(file) {
  if (!file) return false;
  const mime = String(file.type || '').trim();
  const name = String(file.name || '').trim();
  return (
    /^image\/(png|jpeg|jpg|webp)$/i.test(mime) ||
    /^application\/pdf$/i.test(mime) ||
    /\.(png|jpe?g|webp|pdf)$/i.test(name)
  );
}

export function checkDuplicateAccountNumber(accountNumber, accounts = []) {
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

export function formatDuplicateAccountMessage(account) {
  const num = String(account?.accountNumber || '').trim();
  const label = String(account?.name || account?.institution || 'Cuenta existente').trim();
  return `Ya existe una cuenta registrada con el número ${num} (${label}).`;
}

export function formatDuplicateOverwriteWarning(account) {
  return `${formatDuplicateAccountMessage(account)} Verifica si deseas actualizarla o crear un registro adicional.`;
}

function buildDefaultModalOptions(customOptions = {}) {
  return {
    getState: () => {
      if (typeof customOptions.getState === 'function') {
        return customOptions.getState();
      }
      return globalThis.pistoApp?.state || null;
    },
    getImportContext: () => {
      if (typeof customOptions.getImportContext === 'function') {
        return customOptions.getImportContext();
      }
      const app = globalThis.pistoApp;
      const auth = app?.authService;
      const runtime = auth?.getFirebaseRuntime?.() || {};
      return {
        apiKey: auth?.geminiKeyStore?.getApiKey?.() || '',
        workspaceId: auth?.getActiveWorkspaceId?.() || app?.state?.settings?.workspaceId || 'ws_default',
        currentUser: auth?.currentUser || null,
        currentUserProfile: auth?.currentProfile || null,
        firestoreDb: runtime.firestoreDb || null,
        firestoreModule: runtime.firestoreModule || null,
        storage: typeof localStorage !== 'undefined' ? localStorage : null,
      };
    },
    showToast: (msg) => {
      if (typeof customOptions.showToast === 'function') {
        customOptions.showToast(msg);
        return;
      }
      if (typeof globalThis.pistoApp?.showToast === 'function') {
        globalThis.pistoApp.showToast(msg);
        return;
      }
      if (typeof document !== 'undefined') {
        const toast = document.getElementById('app-toast');
        if (toast) {
          toast.textContent = msg;
          toast.classList.add('is-visible');
        }
      }
    },
    onCreated: (created) => {
      const app = globalThis.pistoApp;
      if (app?.repo && app?.state) {
        app.repo.saveState(app.state);
        app.renderAll?.();
      }
      customOptions.onCreated?.(created);
    },
    onClose: () => {
      isImportAccountModalOpen = false;
      if (typeof globalThis !== 'undefined') {
        globalThis.__PISTO_IMPORT_ACCOUNT_MODAL_OPEN__ = false;
      }
      customOptions.onClose?.();
    },
  };
}

function ensureActiveImportAccountModal(options = {}) {
  if (!activeModalInstance) {
    activeModalInstance = new ImportAccountModal(buildDefaultModalOptions(options));
    activeModalInstance.init();
  }
  return activeModalInstance;
}

export function renderAccountsViewTemplate(openState = isImportAccountModalOpen) {
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

export class AccountsView {
  constructor(options = {}) {
    this.options = options;
    this.modal = new ImportAccountModal(buildDefaultModalOptions(options));
    activeModalInstance = this.modal;

    if (options.initialOpen) {
      isImportAccountModalOpen = true;
    }

    this.setIsImportAccountModalOpen = this.setIsImportAccountModalOpen.bind(this);
    this.openImportAccountModal = this.openImportAccountModal.bind(this);
    this.closeImportAccountModal = this.closeImportAccountModal.bind(this);
  }

  get isImportAccountModalOpen() {
    return isImportAccountModalOpen;
  }

  setIsImportAccountModalOpen(isOpen) {
    const next = Boolean(isOpen);
    isImportAccountModalOpen = next;
    if (typeof globalThis !== 'undefined') {
      globalThis.__PISTO_IMPORT_ACCOUNT_MODAL_OPEN__ = next;
    }
    this.modal.setIsImportAccountModalOpen(next);
    return isImportAccountModalOpen;
  }

  openImportAccountModal() {
    this.setIsImportAccountModalOpen(true);
  }

  closeImportAccountModal() {
    this.setIsImportAccountModalOpen(false);
  }

  init() {
    this.modal.init();
    this.bindImportAccountButton();
    if (isImportAccountModalOpen) {
      this.modal.setIsImportAccountModalOpen(true);
    }
    return this;
  }

  bindImportAccountButton() {
    if (typeof document === 'undefined') return null;

    const panelAccounts = document.getElementById('panel-accounts');
    if (panelAccounts) {
      sanitizeClickableAncestors(panelAccounts);
    }

    const actionContainer = document.querySelector(
      '#panel-accounts .toolbar-action-group, #panel-accounts .section-toolbar > div:last-child, #panel-accounts .section-header > div:last-child'
    );
    if (actionContainer) {
      sanitizeClickableAncestors(actionContainer);
    }

    let button = document.getElementById(IMPORT_ACCOUNT_BUTTON_ID);
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

    const buttons = document.querySelectorAll(
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

      btn.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.setIsImportAccountModalOpen(true);
      };
    });

    return button;
  }

  renderMarkup() {
    return renderAccountsViewTemplate(this.isImportAccountModalOpen);
  }
}

export function createAccountsView(options = {}) {
  const view = new AccountsView(options);
  return view.init();
}

export { AccountsView as AccountsTab, createAccountsView as createAccountsTab };

if (typeof globalThis !== 'undefined') {
  globalThis.__PISTO_ACCOUNTS_VIEW__ = AccountsView;
  globalThis.__PISTO_IMPORT_ACCOUNT_MODAL__ = ImportAccountModal;
  globalThis.__PISTO_SET_IMPORT_ACCOUNT_MODAL_OPEN__ = setIsImportAccountModalOpen;
}

if (typeof document !== 'undefined') {
  const mountAccountsView = () => {
    if (!globalThis.__PISTO_ACCOUNTS_VIEW_INSTANCE__) {
      globalThis.__PISTO_ACCOUNTS_VIEW_INSTANCE__ = createAccountsView();
    } else {
      globalThis.__PISTO_ACCOUNTS_VIEW_INSTANCE__.bindImportAccountButton();
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountAccountsView, { once: true });
  } else {
    mountAccountsView();
  }
}

export default AccountsView;
