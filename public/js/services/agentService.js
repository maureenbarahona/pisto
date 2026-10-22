/**
 * @fileoverview Servicio y Hook de Agente ADK (`useAccountAgentADK` / `public/js/services/agentService.js`)
 * para extracción inteligente de cuentas desde Imagen/PDF con Fallback de Diagnóstico Local.
 */

import {
  ExtractedAccountSchema,
  extractAccountFromFile,
  parseAccountDataFromTextFallback,
} from './accountExtractor.js';

export const ADK_INIT_LOG_MESSAGE = '🤖 Agente ADK: Inicializando modal de importación...';

/**
 * Datos estáticos de demostración ("Banco Atlántida - Cuenta de Ahorro SOS", L 3,901.33)
 * utilizados por el Agente ADK cuando no hay API Key configurada o falla la conexión.
 */
export const ADK_DEMO_ACCOUNT_DATA = Object.freeze({
  bankName: 'Banco Atlántida',
  accountType: 'CUENTA DE AHORRO SOS',
  accountNumber: '213130058771',
  currency: 'HNL',
  currentBalance: 3901.33,
  status: 'Activa',
  detectedTransactions: [
    {
      id: 'adk_demo_tx_1',
      date: '2026-10-15',
      concept: 'DEPOSITO DE AHORRO CON T/D 37170597',
      type: 'income',
      amount: 200.0,
      selected: true,
    },
  ],
});

/**
 * Devuelve una copia fresca y validada de los datos de demostración del Agente ADK.
 */
export function getDemoAccountExtraction() {
  return ExtractedAccountSchema.parse({
    ...ADK_DEMO_ACCOUNT_DATA,
    detectedTransactions: ADK_DEMO_ACCOUNT_DATA.detectedTransactions.map((tx, idx) => ({
      ...tx,
      id: `adk_demo_tx_${idx + 1}_${Date.now().toString(36)}`,
    })),
  });
}

/**
 * Procesa una imagen o PDF mediante el Agente ADK Vision o activa el fallback local de diagnóstico.
 * @param {File | Blob | string | null | undefined} fileOrDataUrl
 * @param {object} [options]
 */
export async function processAccountWithAgentADK(fileOrDataUrl, options = {}) {
  const apiKey = String(options.apiKey || '').trim();
  const fallbackText = String(options.ocrTextFallback || options.ocrFallbackText || '').trim();

  // 1. Intentar extracción con Agente ADK Vision (Gemini Flash directo o endpoint /api/ai/scan-account)
  if (fileOrDataUrl && (apiKey || options.fetchImpl || typeof window !== 'undefined')) {
    try {
      const extracted = await extractAccountFromFile(fileOrDataUrl, {
        apiKey,
        ocrFallbackText: fallbackText,
        fetchImpl: options.fetchImpl,
        storage: options.storage,
      });
      const hasExtractedAccounts =
        Array.isArray(extracted?.data?.accountsList) &&
        extracted.data.accountsList.some(
          (item) => Boolean(item.accountNumber) || Number(item.currentBalance) > 0
        );
      if (hasExtractedAccounts || extracted?.source !== 'local-ocr-fallback') {
        return {
          data: extracted.data,
          source: `adk:${extracted.source}`,
          isDemoFallback: false,
          message: '🤖 Agente ADK Vision: Estado de cuenta extraído con éxito.',
        };
      }
    } catch {
      // Fallback silencioso a modo local sin llamadas a consola
    }
  }

  // 2. Si hay texto OCR válido disponible (incluyendo formatos nuevos inferidos por contexto)
  if (fallbackText.length >= 8) {
    try {
      const parsedFromText = parseAccountDataFromTextFallback(fallbackText);
      const hasMeaningfulData =
        Boolean(parsedFromText.accountNumber) ||
        parsedFromText.currentBalance > 0 ||
        parsedFromText.detectedTransactions.length > 0 ||
        (Array.isArray(parsedFromText.accountsList) &&
          parsedFromText.accountsList.some(
            (acc) => Boolean(acc.accountNumber) || Number(acc.currentBalance) > 0
          ));
      if (hasMeaningfulData) {
        return {
          data: parsedFromText,
          source: 'adk-ocr-local',
          isDemoFallback: false,
          message: '🤖 Agente ADK (OCR Local): Datos extraídos del documento.',
        };
      }
    } catch {
      // Continúa al fallback estático de demostración
    }
  }

  // 3. Modo de prueba / Agente Local de demostración ("Banco Atlántida - Cuenta de Ahorro SOS", L 3,901.33)
  const demoData = getDemoAccountExtraction();
  return {
    data: demoData,
    source: 'adk-local-fallback',
    isDemoFallback: true,
    message:
      '🤖 Agente ADK (Modo Diagnóstico Local): Datos de demostración cargados (Banco Atlántida - Cuenta de Ahorro SOS, L 3,901.33).',
  };
}

/**
 * Hook / Factory del Agente ADK (`useAccountAgentADK`) para inicializar el modal y analizar archivos.
 * @param {object} [defaultOptions]
 */
export function useAccountAgentADK(defaultOptions = {}) {
  return {
    initializeModal(notifyToast) {
      const toastFn = notifyToast || defaultOptions.notifyToast;
      if (typeof toastFn === 'function') {
        toastFn(ADK_INIT_LOG_MESSAGE);
      }
      return ADK_INIT_LOG_MESSAGE;
    },

    async analyzeFile(fileOrDataUrl, runtimeOptions = {}) {
      return processAccountWithAgentADK(fileOrDataUrl, {
        ...defaultOptions,
        ...runtimeOptions,
      });
    },

    loadDemoFallback() {
      return {
        data: getDemoAccountExtraction(),
        source: 'adk-local-fallback',
        isDemoFallback: true,
        message:
          '🤖 Agente ADK (Modo Diagnóstico Local): Datos de demostración cargados (Banco Atlántida - Cuenta de Ahorro SOS, L 3,901.33).',
      };
    },
  };
}
