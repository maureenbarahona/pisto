/**
 * @fileoverview Smart Account Detail OCR + Gemini 1.5 Flash / Genkit Vision Service (`src/services/accountScanService.ts`).
 */

export {
  type DetectedTransactionItem,
  type AccountScanPayload,
  type AccountScanContext,
  encodeImageToBase64,
  formatAccountScanPreviewSummary,
  analyzeAccountScreenshotWithGemini,
  createScannedAccountAndTransactionsAtomically,
} from '../../public/js/services/accountScanService.ts';
