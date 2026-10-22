/**
 * @fileoverview Re-exportador compatible del Extractor Nativo de Capa de Texto en PDF (`src/js/services/pdfTextExtractor.js`).
 */

export {
  PDFJS_CDN_URL,
  PDFJS_WORKER_CDN_URL,
  VECTOR_PDF_MIN_CHARS,
  extractPdfBinaryData,
  cleanPdfTextLine,
  organizeTextItemsIntoLines,
  organizeLinesIntoHierarchicalBlocks,
  extractNativePdfTextLayer,
  extractPdfData,
} from './pdfExtractor.js';
