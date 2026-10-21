/**
 * @fileoverview Mobile Banking & Voucher OCR/Vision Extraction Service (`src/services/scanVoucherService.ts`).
 *
 * Exports:
 * - `cleanAmount`: Removes thousand-separator commas `,` BEFORE `parseFloat` ("3,901.33" -> 3901.33).
 * - `buildGeminiVisionPrompt`: Gemini Vision prompt with Honduras context, full account number rules,
 *   Crédito/Depósito -> income mapping, and mobile status bar/UI filtering.
 * - `parseVoucherText`, `extractCardAndBankInfo`, `extractAmountAndCurrency`, `extractMerchantFromLines`,
 *   `detectVoucherTransactionType`, `analyzeAccountScreenshotWithGemini`.
 */

export {
  cleanAmount,
  buildGeminiVisionPrompt,
  stripMobileUiChromeFromLine,
  extractMerchantFromLines,
  detectVoucherTransactionType,
  inferCategoryFromMerchant,
  extractCardAndBankInfo,
  matchAccountForVoucher,
  extractVoucherDate,
  extractAmountAndCurrency,
  parseVoucherText,
  decodeVoucherFile,
  parseBankStatementText,
  decodeBankStatementPdf,
  findDuplicateTransaction,
} from '../../public/js/services/voucherOcrService.js';

export {
  encodeImageToBase64,
  formatAccountScanPreviewSummary,
  analyzeAccountScreenshotWithGemini,
  createScannedAccountAndTransactionsAtomically,
} from './accountScanService.ts';
