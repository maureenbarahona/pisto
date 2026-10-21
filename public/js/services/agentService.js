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

  // 1. Si hay API Key configurada, intentar extracción con Agente ADK Vision
  if (apiKey && fileOrDataUrl) {
    try {
      const visionResult = await extractAccountFromFile(fileOrDataUrl, {
        apiKey,
        ocrTextFallback: fallbackText,
        fetchImpl: options.fetchImpl,
      });
      return {
        data: visionResult.data,
        source: 'adk-gemini-vision',
        isDemoFallback: false,
        message: '🤖 Agente ADK Vision: Estado de cuenta analizado exitosamente.',
      };
    } catch (error) {
      console.warn(
        '[Agente ADK] Falló la conexión con Gemini Vision; activando fallback local de diagnóstico:',
        error
      );
    }
  }

  // 2. Si existe texto OCR/PDF extraído con datos válidos de cuenta, usarlo
  if (fallbackText.length > 0) {
    try {
      const parsedFromOcr = parseAccountDataFromTextFallback(fallbackText);
      if (parsedFromOcr.currentBalance > 0 || parsedFromOcr.accountNumber.length >= 4) {
        return {
          data: parsedFromOcr,
          source: 'adk-local-ocr',
          isDemoFallback: false,
          message: '🤖 Agente ADK Local: Datos extraídos del documento.',
        };
      }
    } catch {
      // Continuar al fallback estático de demostración
    }
  }

  // 3. Fallback de Diagnóstico Local del Agente ADK ("Banco Atlántida - Cuenta de Ahorro SOS", L 3,901.33)
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
      console.log(ADK_INIT_LOG_MESSAGE);
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
