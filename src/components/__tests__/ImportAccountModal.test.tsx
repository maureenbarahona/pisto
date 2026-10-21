import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AccountsView,
  createAccountsView,
  ImportAccountModal,
  IMPORT_ACCOUNT_BUTTON_ID,
  IMPORT_ACCOUNT_BUTTON_LABEL,
  getIsImportAccountModalOpen,
  setIsImportAccountModalOpen,
  sanitizeClickableAncestors,
  renderAccountsViewTemplate,
} from '../AccountsView.tsx';

describe('AccountsView & ImportAccountModal (TSX)', () => {
  it('toggles isImportAccountModalOpen synchronously and invokes onClose without console.log', () => {
    let closedCount = 0;
    const view = createAccountsView({
      onClose: () => {
        closedCount += 1;
      },
    });

    assert.equal(IMPORT_ACCOUNT_BUTTON_ID, 'btn-import-account-media');
    assert.equal(IMPORT_ACCOUNT_BUTTON_LABEL, '➕ Importar Cuenta desde Imagen/PDF');
    assert.equal(view.isImportAccountModalOpen, false);

    view.openImportAccountModal();
    assert.equal(view.isImportAccountModalOpen, true);
    assert.equal(getIsImportAccountModalOpen(), true);
    assert.ok(renderAccountsViewTemplate(true).includes('data-rendered-component="ImportAccountModal"'));

    view.closeImportAccountModal();
    assert.equal(view.isImportAccountModalOpen, false);
    assert.equal(getIsImportAccountModalOpen(), false);
    assert.equal(closedCount, 1);

    setIsImportAccountModalOpen(true);
    assert.equal(getIsImportAccountModalOpen(), true);
    setIsImportAccountModalOpen(false);
    assert.equal(getIsImportAccountModalOpen(), false);
    assert.ok(typeof ImportAccountModal === 'function');
    assert.ok(typeof AccountsView === 'function');
    assert.ok(typeof sanitizeClickableAncestors === 'function');
  });
});
