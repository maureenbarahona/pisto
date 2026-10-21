/**
 * @fileoverview Accounts & Relational Integrity Data Service (`src/services/accounts.ts`).
 */

export {
  type AccountRecord,
  type AccountServiceContext,
  isAccountArchived,
  getActiveAccounts,
  filterActiveAccounts,
  filterArchivedAccounts,
  filterAccountsForView,
  saveAccountToFirestore,
  archiveAccount,
  unarchiveAccount,
  deleteAccountWithCascade,
} from '../../public/js/services/accounts.ts';
