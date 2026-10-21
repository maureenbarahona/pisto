/**
 * @fileoverview Servicio y Hook de Agente ADK (`useAccountAgentADK` / `src/services/agentService.ts`)
 * para extracción inteligente de cuentas desde Imagen/PDF con Fallback de Diagnóstico Local.
 *
 * Implementa:
 * 1. Inicialización con trazabilidad en consola:
 *    `console.log("🤖 Agente ADK: Inicializando modal de importación...")` y notificación toast.
 * 2. Procesamiento con Agente ADK Vision (`processAccountWithAgentADK`):
 *    - Si la API Key de Gemini / Genkit está configurada: procesa el archivo con el agente ADK Vision.
 *    - Si NO hay API Key configurada o falla la conexión: activa el modo de prueba / agente local
 *      que captura el archivo y carga datos de demostración ("Banco Atlántida - Cuenta de Ahorro SOS", L 3,901.33)
 *      para garantizar que el modal abra y funcione siempre en entorno de pruebas.
 */

import {
  ExtractedAccountSchema,
  extractAccountFromFile,
  parseAccountDataFromTextFallback,
  type ExtractedAccountData,
} from './accountExtractor.ts';

export const ADK_INIT_LOG_MESSAGE = '🤖 Agente ADK: Inicializando modal de importación...';

/**
 * Datos estáticos de demostración ("Banco Atlántida - Cuenta de Ahorro SOS", L 3,901.33)
 * utilizados por el Agente ADK cuando no hay API Key configurada o falla la conexión.
 */
export const ADK_DEMO_ACCOUNT_DATA: Readonly<ExtractedAccountData> = Object.freeze({
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
export function getDemoAccountExtraction(): ExtractedAccountData {
  return ExtractedAccountSchema.parse({
    ...ADK_DEMO_ACCOUNT_DATA,
    detectedTransactions: ADK_DEMO_ACCOUNT_DATA.detectedTransactions.map((tx, idx) => ({
      ...tx,
      id: `adk_demo_tx_${idx + 1}_${Date.now().toString(36)}`,
    })),
  });
}

export interface AgentADKOptions {
  apiKey?: string;
  ocrTextFallback?: string;
  ocrFallbackText?: string;
  fetchImpl?: typeof fetch;
  notifyToast?: (message: string) => void;
}

export interface AgentADKResult {
  data: ExtractedAccountData;
  source: 'adk-gemini-vision' | 'adk-local-ocr' | 'adk-local-fallback';
  isDemoFallback: boolean;
  message: string;
}

/**
 * Procesa una imagen o PDF mediante el Agente ADK Vision o activa el fallback local de diagnóstico.
 */
export async function processAccountWithAgentADK(
  fileOrDataUrl: File | Blob | string | null | undefined,
  options: AgentADKOptions = {}
): Promise<AgentADKResult> {
  const apiKey = String(options.apiKey || '').trim();
  const fallbackText = String(options.ocrTextFallback || options.ocrFallbackText || '').trim();

  // 1. Si hay API Key configurada (o endpoint disponible), intentar extracción con Agente ADK Vision
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

  // 2. Si existe texto OCR/PDF extraído con datos válidos de cuenta (saldo > 0 o número de cuenta), usarlo
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
 */
export function useAccountAgentADK(defaultOptions: AgentADKOptions = {}) {
  return {
    /**
     * Registra en consola y muestra el toast confirmando la apertura del modal de importación.
     */
    initializeModal(notifyToast?: (message: string) => void): string {
      console.log(ADK_INIT_LOG_MESSAGE);
      const toastFn = notifyToast || defaultOptions.notifyToast;
      if (typeof toastFn === 'function') {
        toastFn(ADK_INIT_LOG_MESSAGE);
      }
      return ADK_INIT_LOG_MESSAGE;
    },

    /**
     * Analiza un archivo (Imagen o PDF) con Gemini Vision / Genkit o carga el fallback de demostración ADK.
     */
    async analyzeFile(
      fileOrDataUrl: File | Blob | string | null | undefined,
      runtimeOptions: AgentADKOptions = {}
    ): Promise<AgentADKResult> {
      return processAccountWithAgentADK(fileOrDataUrl, {
        ...defaultOptions,
        ...runtimeOptions,
      });
    },

    /**
     * Carga directamente los datos de demostración del Agente ADK ("Banco Atlántida - Cuenta de Ahorro SOS", L 3,901.33).
     */
    loadDemoFallback(): AgentADKResult {
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
