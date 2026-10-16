/**
 * @fileoverview Pisto-Style Calculator Keypad & Modal Controller.
 *
 * Implements:
 * - Built-in arithmetic expression evaluator (+, -, *, /) for splitting receipts on the fly.
 * - Native <dialog closedby="any"> with light-dismiss fallback per modern-web-guidance.
 * - Full keyboard and touch/click support.
 */

import { Money, TRANSACTION_TYPES } from '../domain/models.js';

/**
 * Safely evaluates a simple arithmetic expression (e.g., "25.50+12*2") without eval().
 * @param {string} expr
 * @returns {number}
 */
export function evaluateKeypadExpression(expr) {
  const sanitized = String(expr || '')
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/[^0-9.+\-*/]/g, '');

  if (!sanitized) return 0;

  // Tokenize numbers and operators (+, -, *, /)
  const tokens = sanitized.match(/(\d+(?:\.\d+)?|\.\d+|[+\-*/])/g);
  if (!tokens || tokens.length === 0) return 0;

  // First pass: multiplication and division
  const addSubStack = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === '*' || token === '/') {
      const prev = Number.parseFloat(addSubStack.pop() ?? '0');
      const next = Number.parseFloat(tokens[i + 1] ?? '1');
      if (!Number.isFinite(next) || (token === '/' && next === 0)) {
        addSubStack.push(prev);
      } else {
        addSubStack.push(token === '*' ? prev * next : prev / next);
      }
      i += 2;
    } else {
      addSubStack.push(token);
      i += 1;
    }
  }

  // Second pass: addition and subtraction
  let total = Number.parseFloat(addSubStack[0]);
  if (!Number.isFinite(total)) total = 0;

  for (let j = 1; j < addSubStack.length; j += 2) {
    const op = addSubStack[j];
    const val = Number.parseFloat(addSubStack[j + 1] ?? '0');
    if (!Number.isFinite(val)) continue;
    if (op === '+') total += val;
    if (op === '-') total -= val;
  }

  return Money.fromCents(Money.toCents(Math.max(0, total)));
}

/**
 * Attaches the mandatory light-dismiss fallback for browsers without native <dialog closedby="any">.
 * @param {HTMLDialogElement} dialog
 */
export function attachDialogLightDismissFallback(dialog) {
  if (!dialog || 'closedBy' in HTMLDialogElement.prototype) return;

  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const isDialogContent =
      rect.top <= event.clientY &&
      event.clientY <= rect.top + rect.height &&
      rect.left <= event.clientX &&
      event.clientX <= rect.left + rect.width;

    if (!isDialogContent) {
      dialog.close();
    }
  });
}

export class KeypadModalController {
  /**
   * @param {object} options
   * @param {HTMLDialogElement} options.dialogEl
   * @param {(txData: object) => void} options.onSubmit
   * @param {(txId: string) => void} [options.onDelete]
   */
  constructor({ dialogEl, onSubmit, onDelete }) {
    this.dialogEl = dialogEl;
    this.onSubmit = onSubmit;
    this.onDelete = onDelete;
    this.expression = '';
    this.currentType = TRANSACTION_TYPES.EXPENSE;
    this.editingId = null;

    if (this.dialogEl) {
      attachDialogLightDismissFallback(this.dialogEl);
      this.bindEvents();
    }
  }

  bindEvents() {
    this.dialogEl.addEventListener('click', (e) => {
      const keyBtn = e.target.closest('[data-key]');
      if (keyBtn) {
        e.preventDefault();
        this.handleKeyInput(keyBtn.dataset.key);
        return;
      }

      const typeBtn = e.target.closest('[data-tx-type]');
      if (typeBtn) {
        e.preventDefault();
        this.setTransactionType(typeBtn.dataset.txType);
      }
    });

    const amountInput = this.dialogEl.querySelector('#tx-amount-input');
    amountInput?.addEventListener('input', () => {
      const rawVal = String(amountInput.value || '').trim();
      this.expression = rawVal;
      this.updateDisplay({ skipAmountInput: true });
    });

    const currencySelect = this.dialogEl.querySelector('#tx-currency-select');
    currencySelect?.addEventListener('change', () => {
      this.updateDisplay();
    });

    const deleteBtn = this.dialogEl.querySelector('#btn-delete-tx-modal');
    deleteBtn?.addEventListener('click', () => {
      if (!this.editingId) return;
      const targetId = this.editingId;
      this.editingId = null;
      this.dialogEl.close();
      if (typeof this.onDelete === 'function') {
        this.onDelete(targetId);
      }
    });

    this.dialogEl.addEventListener('keydown', (e) => {
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      if (/^[0-9.]$/.test(e.key)) {
        e.preventDefault();
        this.handleKeyInput(e.key);
      } else if (e.key === '+' || e.key === '-') {
        e.preventDefault();
        this.handleKeyInput(e.key);
      } else if (e.key === '*') {
        e.preventDefault();
        this.handleKeyInput('×');
      } else if (e.key === '/') {
        e.preventDefault();
        this.handleKeyInput('÷');
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        this.handleKeyInput('BACK');
      }
    });

    const form = this.dialogEl.querySelector('#tx-modal-form');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        this.submitForm();
      });
    }
  }

  /**
   * Opens the Pisto transaction keypad modal pre-populated with optional category/account/type
   * or an existing transaction (`preset.id`) for full in-place editing.
   * @param {object} state
   * @param {object} [preset]
   */
  open(state, preset = {}) {
    this.state = state;
    this.editingId = preset.id || null;
    this.currentType = preset.type || TRANSACTION_TYPES.EXPENSE;
    this.expression = preset.amount !== undefined && preset.amount !== null ? String(preset.amount) : '';

    const titleEl = this.dialogEl.querySelector('#tx-dialog-title');
    const saveBtn = this.dialogEl.querySelector('#btn-save-transaction');
    const deleteBtn = this.dialogEl.querySelector('#btn-delete-tx-modal');
    if (titleEl) {
      titleEl.textContent = this.editingId ? 'Detalle de Transacción' : 'Registrar Movimiento';
    }
    if (saveBtn) {
      saveBtn.textContent = this.editingId ? 'Guardar Cambios' : 'Guardar Movimiento';
    }
    if (deleteBtn) {
      deleteBtn.classList.toggle('is-hidden', !this.editingId);
    }

    this.populateSelects(preset);
    this.setTransactionType(this.currentType, preset.categoryId);

    const noteInput = this.dialogEl.querySelector('#tx-note-input');
    const dateInput = this.dialogEl.querySelector('#tx-date-input');
    if (noteInput) noteInput.value = preset.note || '';
    if (dateInput) dateInput.value = preset.date || new Date().toISOString().slice(0, 10);

    this.updateDisplay();
    if (!this.dialogEl.open) {
      this.dialogEl.showModal();
    }
  }

  populateSelects(preset = {}) {
    const fromAccountSelect = this.dialogEl.querySelector('#tx-account-select');
    const toAccountSelect = this.dialogEl.querySelector('#tx-to-account-select');
    const currencySelect = this.dialogEl.querySelector('#tx-currency-select');

    if (fromAccountSelect && this.state?.accounts) {
      fromAccountSelect.innerHTML = this.state.accounts
        .map((acc) => `<option value="${acc.id}">${acc.name} (${acc.currency})</option>`)
        .join('');
      if (preset.accountId && this.state.accounts.some((a) => a.id === preset.accountId)) {
        fromAccountSelect.value = preset.accountId;
      }
    }

    if (toAccountSelect && this.state?.accounts) {
      toAccountSelect.innerHTML = this.state.accounts
        .map((acc) => `<option value="${acc.id}">${acc.name} (${acc.currency})</option>`)
        .join('');
      const fallbackSecond = this.state.accounts[1]?.id || this.state.accounts[0]?.id;
      toAccountSelect.value = preset.toAccountId || fallbackSecond;
    }

    if (currencySelect) {
      currencySelect.value = preset.currency || this.state?.settings?.baseCurrency || 'USD';
    }
  }

  setTransactionType(type, preferredCategoryId = null) {
    this.currentType = type;
    const tabs = this.dialogEl.querySelectorAll('[data-tx-type]');
    for (const tab of tabs) {
      const isSelected = tab.dataset.txType === type;
      tab.classList.toggle('is-active', isSelected);
      tab.setAttribute('aria-selected', String(isSelected));
    }

    const categoryGroup = this.dialogEl.querySelector('#tx-category-group');
    const toAccountGroup = this.dialogEl.querySelector('#tx-to-account-group');
    const categorySelect = this.dialogEl.querySelector('#tx-category-select');

    if (type === TRANSACTION_TYPES.TRANSFER) {
      categoryGroup?.classList.add('is-hidden');
      toAccountGroup?.classList.remove('is-hidden');
    } else {
      categoryGroup?.classList.remove('is-hidden');
      toAccountGroup?.classList.add('is-hidden');

      if (categorySelect && this.state?.categories) {
        const filteredCats = this.state.categories.filter((c) => c.type === type);
        categorySelect.innerHTML = filteredCats
          .map((c) => `<option value="${c.id}">${c.name}</option>`)
          .join('');
        if (preferredCategoryId && filteredCats.some((c) => c.id === preferredCategoryId)) {
          categorySelect.value = preferredCategoryId;
        }
      }
    }
  }

  handleKeyInput(key) {
    if (key === 'C') {
      this.expression = '';
    } else if (key === 'BACK') {
      this.expression = this.expression.slice(0, -1);
    } else if (key === '=') {
      const evaluated = evaluateKeypadExpression(this.expression);
      this.expression = evaluated > 0 ? String(evaluated) : '';
    } else {
      if (this.expression.length < 18) {
        this.expression += key;
      }
    }
    this.updateDisplay();
  }

  updateDisplay({ skipAmountInput = false } = {}) {
    const exprEl = this.dialogEl.querySelector('#keypad-expression');
    const valueEl = this.dialogEl.querySelector('#keypad-evaluated');
    const amountInput = this.dialogEl.querySelector('#tx-amount-input');
    const errorEl = this.dialogEl.querySelector('#keypad-error-msg');
    const evaluated = evaluateKeypadExpression(this.expression);

    if (exprEl) {
      exprEl.textContent = this.expression || '0';
    }
    if (valueEl) {
      const currency = this.dialogEl.querySelector('#tx-currency-select')?.value || 'USD';
      valueEl.textContent = `= ${Money.format(evaluated, currency)}`;
    }
    if (amountInput && !skipAmountInput) {
      amountInput.value = evaluated > 0 ? String(evaluated) : '';
    }
    if (errorEl) {
      errorEl.classList.add('is-hidden');
    }
  }

  submitForm() {
    const amountInput = this.dialogEl.querySelector('#tx-amount-input');
    const evaluatedFromExpr = evaluateKeypadExpression(this.expression);
    const parsedFromInput = amountInput?.value ? Number.parseFloat(amountInput.value) : 0;
    const amount =
      evaluatedFromExpr > 0
        ? evaluatedFromExpr
        : Number.isFinite(parsedFromInput) && parsedFromInput > 0
          ? Money.fromCents(Money.toCents(parsedFromInput))
          : 0;

    const errorEl = this.dialogEl.querySelector('#keypad-error-msg');

    if (amount <= 0) {
      if (errorEl) {
        errorEl.textContent = 'Ingrese un monto mayor a 0 en el campo Monto o en la calculadora.';
        errorEl.classList.remove('is-hidden');
      }
      return;
    }

    const accountId = this.dialogEl.querySelector('#tx-account-select')?.value;
    const toAccountId = this.dialogEl.querySelector('#tx-to-account-select')?.value;
    const categoryId = this.dialogEl.querySelector('#tx-category-select')?.value;
    const currency = this.dialogEl.querySelector('#tx-currency-select')?.value || 'USD';
    const note = this.dialogEl.querySelector('#tx-note-input')?.value || '';
    const date = this.dialogEl.querySelector('#tx-date-input')?.value || new Date().toISOString().slice(0, 10);

    if (this.currentType === TRANSACTION_TYPES.TRANSFER && accountId === toAccountId) {
      if (errorEl) {
        errorEl.textContent = 'Seleccione una cuenta de destino distinta a la de origen.';
        errorEl.classList.remove('is-hidden');
      }
      return;
    }

    const submittedId = this.editingId;
    this.editingId = null;

    this.onSubmit({
      id: submittedId || undefined,
      type: this.currentType,
      amount,
      currency,
      categoryId: this.currentType === TRANSACTION_TYPES.TRANSFER ? 'transfer' : categoryId,
      accountId,
      toAccountId: this.currentType === TRANSACTION_TYPES.TRANSFER ? toAccountId : null,
      note,
      date,
    });

    this.dialogEl.close();
  }
}
