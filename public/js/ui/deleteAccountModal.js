/**
 * @fileoverview DeleteAccountModal Controller (`public/js/ui/deleteAccountModal.js`).
 *
 * Implements the relational integrity confirmation modal when clicking the trash/delete icon
 * on any Account, Wallet, Credit Card, Savings Goal, or Debt card:
 * - Displays the account's current balance and number of associated transactions.
 * - Option A: "📦 Archivar Cuenta (Recomendado)" -> sets `isArchived: true` (`status: "archived"`),
 *   hides the account from active lists/selectors, and preserves 100% of historical transactions.
 * - Option B: "⚠️ Borrar Cuenta y Transacciones (Eliminar en Cascada)" -> displays the red warning alert
 *   and executes an atomic Firestore `writeBatch` deleting both `accounts/{accountId}` and all
 *   `transactions` where `accountId === idDeLaCuenta`.
 */

import { Money } from '../domain/models.js';
import { attachDialogLightDismissFallback } from './keypadModal.js';

export class DeleteAccountModal {
  constructor({ dialogEl, onArchive, onCascadeDelete }) {
    this.dialogEl = dialogEl;
    this.onArchive = onArchive;
    this.onCascadeDelete = onCascadeDelete;
    this.targetAccountId = null;

    if (this.dialogEl) {
      attachDialogLightDismissFallback(this.dialogEl);
      this.bindEvents();
    }
  }

  bindEvents() {
    const cancelBtn = document.getElementById('btn-cancel-delete-warning');
    const archiveBtn = document.getElementById('btn-archive-account-option');
    const cascadeDeleteBtn = document.getElementById('btn-confirm-delete-warning');

    cancelBtn?.addEventListener('click', () => {
      this.targetAccountId = null;
      this.dialogEl?.close();
    });

    archiveBtn?.addEventListener('click', async () => {
      const accountId = this.targetAccountId;
      if (!accountId) return;
      try {
        if (archiveBtn) archiveBtn.disabled = true;
        await this.onArchive(accountId);
        this.targetAccountId = null;
        this.dialogEl?.close();
      } finally {
        if (archiveBtn) archiveBtn.disabled = false;
      }
    });

    cascadeDeleteBtn?.addEventListener('click', async () => {
      const accountId = this.targetAccountId;
      if (!accountId) return;
      try {
        if (cascadeDeleteBtn) cascadeDeleteBtn.disabled = true;
        await this.onCascadeDelete(accountId);
        this.targetAccountId = null;
        this.dialogEl?.close();
      } finally {
        if (cascadeDeleteBtn) cascadeDeleteBtn.disabled = false;
      }
    });
  }

  open({ account, currentBalance, txCount }) {
    if (!account) return;
    this.targetAccountId = account.id;

    const titleEl = document.getElementById('delete-warning-title');
    const targetNameEl = document.getElementById('delete-warning-target-name');
    const descEl = document.getElementById('delete-warning-description');
    const balanceBadgeEl = document.getElementById('delete-account-balance-badge');
    const txCountBadgeEl = document.getElementById('delete-account-tx-count-badge');
    const redAlertEl = document.getElementById('delete-cascade-red-alert');

    const formattedBalance = Money.format(currentBalance ?? account.initialBalance ?? 0, account.currency || 'USD');
    const safeTxCount = Number.isFinite(txCount) ? txCount : 0;

    if (titleEl) {
      titleEl.innerHTML = `<span aria-hidden="true">⚠️</span> Gestión de Cuenta e Integridad Relacional`;
    }

    if (targetNameEl) {
      targetNameEl.textContent = `Cuenta seleccionada: "${account.name}"`;
    }

    if (balanceBadgeEl) {
      balanceBadgeEl.textContent = formattedBalance;
    }

    if (txCountBadgeEl) {
      txCountBadgeEl.textContent = `${safeTxCount} transacción(es)`;
    }

    if (descEl) {
      descEl.textContent = `Saldo actual: ${formattedBalance} · Movimientos asociados: ${safeTxCount}. Selecciona cómo deseas proceder con esta cuenta:`;
    }

    if (redAlertEl) {
      redAlertEl.textContent = `Esta acción eliminará la cuenta Y TODAS las ${safeTxCount} transacciones/movimientos asociados permanentemente. Esta acción no se puede deshacer.`;
    }

    if (this.dialogEl && !this.dialogEl.open) {
      this.dialogEl.showModal();
    }
  }
}
