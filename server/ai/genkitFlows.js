/**
 * @fileoverview Firebase Genkit Flows with Strict Token Optimization.
 *
 * Architectural Principles:
 * 1. Minimal AI Calls: Invoked ONLY on explicit user request when local 0-token
 *    heuristics cannot resolve complex multi-item prompts or when deep insights are requested.
 * 2. Micro-Payloads: Receives pre-aggregated financial summaries (< 80 input tokens)
 *    instead of raw transaction logs.
 * 3. SHA-256 Content-Addressable Cache: Prevents duplicate LLM invocations for identical states.
 * 4. Graceful Degradation: Works seamlessly with 0 tokens if GEMINI_API_KEY is not configured.
 */

import crypto from 'node:crypto';

const DEFAULT_MODEL = process.env.GENKIT_MODEL || 'gemini-2.5-flash';
const MAX_OUTPUT_TOKENS = Number.parseInt(process.env.GENKIT_MAX_OUTPUT_TOKENS || '250', 10);
const CACHE_TTL_MS = 1000 * 60 * 30; // 30 minutes cache TTL
const MAX_CACHE_ENTRIES = 200;

/** @type {Map<string, { data: any, timestamp: number, tokensUsed: number }>} */
const responseCache = new Map();

/** Server-side token telemetry */
const telemetry = {
  totalAiCalls: 0,
  cacheHits: 0,
  fallbackCalls: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
};

const genkitRuntimeCache = new Map();

/**
 * Lazily initializes Firebase Genkit only when an AI flow is actually invoked
 * and GEMINI_API_KEY (or a client-provided apiKey from localStorage) is present.
 * @param {string} [userApiKey]
 */
async function getGenkitRuntime(userApiKey) {
  const effectiveKey = String(userApiKey || process.env.GEMINI_API_KEY || '').trim();
  if (!effectiveKey) {
    return null;
  }
  if (genkitRuntimeCache.has(effectiveKey)) {
    return genkitRuntimeCache.get(effectiveKey);
  }

  try {
    const [{ genkit, z }, { googleAI }] = await Promise.all([
      import('genkit'),
      import('@genkit-ai/google-genai'),
    ]);

    const ai = genkit({
      plugins: [googleAI({ apiKey: effectiveKey })],
    });

    const flows = registerGenkitFlows(ai, googleAI, z);
    const runtime = { ai, googleAI, z, flows };
    genkitRuntimeCache.set(effectiveKey, runtime);
    return runtime;
  } catch (error) {
    console.warn('[Genkit] Running in 0-token local mode (Genkit packages or API key unavailable):', error.message);
    return null;
  }
}

/**
 * Registers structured Genkit flows using Zod schemas and token caps.
 */
function registerGenkitFlows(ai, googleAI, z) {
  const ParsedItemSchema = z.object({
    type: z.enum(['expense', 'income', 'transfer']),
    amount: z.number().positive(),
    categoryId: z.string(),
    accountHint: z.string().optional(),
    note: z.string(),
  });

  const ParseOutputSchema = z.object({
    items: z.array(ParsedItemSchema),
  });

  const InsightsOutputSchema = z.object({
    score: z.number().min(0).max(100),
    status: z.enum(['excellent', 'healthy', 'warning', 'critical']),
    headline: z.string(),
    tips: z.array(z.string()).max(3),
    savingOpportunity: z.string(),
  });

  const parseTransactionsFlow = ai.defineFlow(
    {
      name: 'parseTransactionsFlow',
      inputSchema: z.object({
        text: z.string().max(400),
        categories: z.array(z.string()),
      }),
      outputSchema: ParseOutputSchema,
    },
    async ({ text, categories }) => {
      const compactPrompt = [
        'Extract finance transactions from text into JSON.',
        `Allowed categoryIds: ${categories.join(',')}.`,
        `Text: "${text}"`,
      ].join(' ');

      const response = await ai.generate({
        model: googleAI.model(DEFAULT_MODEL),
        prompt: compactPrompt,
        output: { schema: ParseOutputSchema },
        config: {
          temperature: 0.1,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        },
      });

      const usage = response.usage || {};
      telemetry.totalInputTokens += usage.inputTokens || estimateTokens(compactPrompt);
      telemetry.totalOutputTokens += usage.outputTokens || estimateTokens(JSON.stringify(response.output));
      telemetry.totalAiCalls += 1;

      return response.output;
    }
  );

  const financialInsightsFlow = ai.defineFlow(
    {
      name: 'financialInsightsFlow',
      inputSchema: z.object({
        compactSummary: z.string().max(600),
        lang: z.string().default('es'),
      }),
      outputSchema: InsightsOutputSchema,
    },
    async ({ compactSummary, lang }) => {
      const compactPrompt = [
        `Role: Concise Personal CFO (${lang}).`,
        'Analyze compact ledger summary (c=currency,i=income,e=expense,s=savingsRate%,cats=[[name,spent,budget]],d=debt,g=goals).',
        'Return JSON with score(0-100), status, short headline, max 3 actionable tips (<18 words each), and 1 savingOpportunity.',
        `Data:${compactSummary}`,
      ].join(' ');

      const response = await ai.generate({
        model: googleAI.model(DEFAULT_MODEL),
        prompt: compactPrompt,
        output: { schema: InsightsOutputSchema },
        config: {
          temperature: 0.2,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        },
      });

      const usage = response.usage || {};
      telemetry.totalInputTokens += usage.inputTokens || estimateTokens(compactPrompt);
      telemetry.totalOutputTokens += usage.outputTokens || estimateTokens(JSON.stringify(response.output));
      telemetry.totalAiCalls += 1;

      return response.output;
    }
  );

    return { parseTransactionsFlow, financialInsightsFlow };
}

/**
 * Estimates token count (~4 chars per token) when exact usage metadata is omitted.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text = '') {
  return Math.max(1, Math.ceil(String(text).length / 4));
}

/**
 * Creates a deterministic SHA-256 cache key.
 * @param {string} prefix
 * @param { unknown } payload
 * @returns {string}
 */
function buildCacheKey(prefix, payload) {
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const hash = crypto.createHash('sha256').update(serialized).digest('hex').slice(0, 24);
  return `${prefix}:${hash}`;
}

/**
 * Reads from or populates the bounded LRU-like Map cache.
 */
function getCachedResponse(key) {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    responseCache.delete(key);
    return null;
  }
  telemetry.cacheHits += 1;
  return entry.data;
}

function setCachedResponse(key, data, tokensUsed = 0) {
  if (responseCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = responseCache.keys().next().value;
    responseCache.delete(oldestKey);
  }
  responseCache.set(key, { data, timestamp: Date.now(), tokensUsed });
}

/**
 * Executes the Genkit transaction parser or falls back to deterministic multi-clause parsing.
 * @param {{ text: string, categories?: string[], apiKey?: string }} input
 */
export async function executeSmartParse({ text, categories = [], apiKey }) {
  const cleanText = String(text || '').trim().slice(0, 400);
  if (!cleanText) {
    throw new Error('El texto para analizar no puede estar vacío.');
  }

  const allowedCategories = categories.length > 0
    ? categories
    : ['food', 'groceries', 'transport', 'housing', 'utilities', 'health', 'entertainment', 'shopping', 'salary', 'freelance', 'other'];

  const cacheKey = buildCacheKey('parse', { cleanText, allowedCategories });
  const cached = getCachedResponse(cacheKey);
  if (cached) {
    return { ...cached, cached: true, tokensUsed: 0 };
  }

  const runtime = await getGenkitRuntime(apiKey);
  if (runtime && runtime.flows) {
    try {
      const beforeTokens = telemetry.totalInputTokens + telemetry.totalOutputTokens;
      const output = await runtime.flows.parseTransactionsFlow({
        text: cleanText,
        categories: allowedCategories,
      });
      const tokensUsed = Math.max(1, (telemetry.totalInputTokens + telemetry.totalOutputTokens) - beforeTokens);
      const result = {
        items: output.items || [],
        source: `genkit:${DEFAULT_MODEL}`,
        tokensUsed,
        cached: false,
      };
      setCachedResponse(cacheKey, result, tokensUsed);
      return result;
    } catch (error) {
      console.warn('[Genkit] parseTransactionsFlow fallback triggered:', error.message);
    }
  }

  // Deterministic 0-token multi-clause fallback
  telemetry.fallbackCalls += 1;
  const fallbackItems = deterministicMultiParse(cleanText);
  const result = {
    items: fallbackItems,
    source: 'local-deterministic-engine',
    tokensUsed: 0,
    cached: false,
  };
  setCachedResponse(cacheKey, result, 0);
  return result;
}

/**
 * Executes the Genkit Financial Insights flow using a micro-compressed payload.
 * @param {{ compactPayload: object, lang?: string, apiKey?: string }} input
 */
export async function executeFinancialInsights({ compactPayload, lang = 'es', apiKey }) {
  const compactSummary = JSON.stringify(compactPayload || {});
  const cacheKey = buildCacheKey('insights', { compactSummary, lang });
  const cached = getCachedResponse(cacheKey);
  if (cached) {
    return { ...cached, cached: true, tokensUsed: 0 };
  }

  const runtime = await getGenkitRuntime(apiKey);
  if (runtime && runtime.flows) {
    try {
      const beforeTokens = telemetry.totalInputTokens + telemetry.totalOutputTokens;
      const insights = await runtime.flows.financialInsightsFlow({
        compactSummary,
        lang,
      });
      const tokensUsed = Math.max(1, (telemetry.totalInputTokens + telemetry.totalOutputTokens) - beforeTokens);
      const result = {
        ...insights,
        source: `genkit:${DEFAULT_MODEL}`,
        tokensUsed,
        inputTokensEstimate: estimateTokens(compactSummary),
        cached: false,
      };
      setCachedResponse(cacheKey, result, tokensUsed);
      return result;
    } catch (error) {
      console.warn('[Genkit] financialInsightsFlow fallback triggered:', error.message);
    }
  }

  // Deterministic 0-token financial advisor fallback
  telemetry.fallbackCalls += 1;
  const deterministicResult = buildDeterministicInsights(compactPayload);
  const result = {
    ...deterministicResult,
    source: 'local-deterministic-cfo',
    tokensUsed: 0,
    inputTokensEstimate: estimateTokens(compactSummary),
    cached: false,
  };
  setCachedResponse(cacheKey, result, 0);
  return result;
}

/**
 * Multi-sentence deterministic parser used when Genkit API key is not configured.
 * @param {string} text
 */
export function deterministicMultiParse(text) {
  const segments = text
    .split(/(?:\s+y\s+|\s+e\s+|[,;\n]+)/i)
    .map((s) => s.trim())
    .filter(Boolean);

  const keywordMap = [
    { regex: /super|mercado|abarrotes|walmart|feria|verdura/i, categoryId: 'groceries', type: 'expense' },
    { regex: /almuerzo|cena|desayuno|cafe|café|restaurante|comida|pizza|burger/i, categoryId: 'food', type: 'expense' },
    { regex: /uber|taxi|bus|gasolina|combustible|metro|peaje|transporte/i, categoryId: 'transport', type: 'expense' },
    { regex: /alquiler|renta|hipoteca|casa|condominio/i, categoryId: 'housing', type: 'expense' },
    { regex: /luz|agua|internet|telefono|teléfono|electricidad|servicios/i, categoryId: 'utilities', type: 'expense' },
    { regex: /farmacia|medico|médico|salud|dentista|gym|gimnasio/i, categoryId: 'health', type: 'expense' },
    { regex: /cine|netflix|spotify|juego|concierto|salida|ocio/i, categoryId: 'entertainment', type: 'expense' },
    { regex: /ropa|zapatos|amazon|compra|regalo|tienda/i, categoryId: 'shopping', type: 'expense' },
    { regex: /salario|sueldo|nomina|nómina|quincena/i, categoryId: 'salary', type: 'income' },
    { regex: /freelance|cliente|venta|bono|ingreso|pagaron|depositaron/i, categoryId: 'freelance', type: 'income' },
  ];

  const results = [];
  for (const seg of segments) {
    const amountMatch = seg.match(/(?:[$€₡]|usd|crc|mxn)?\s*(\d+(?:[.,]\d{1,2})?)/i);
    if (!amountMatch) continue;

    const amount = Number.parseFloat(amountMatch[1].replace(',', '.'));
    if (!Number.isFinite(amount) || amount <= 0) continue;

    let matchedCategory = 'food';
    let matchedType = /ingreso|pagaron|depositaron|recibi|recibí|cobré|salario|sueldo|venta/i.test(seg)
      ? 'income'
      : 'expense';

    for (const rule of keywordMap) {
      if (rule.regex.test(seg)) {
        matchedCategory = rule.categoryId;
        matchedType = rule.type;
        break;
      }
    }

    const cleanNote = seg
      .replace(amountMatch[0], '')
      .replace(/\b(gaste|gasté|pague|pagué|en|de|por|con|me)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    results.push({
      type: matchedType,
      amount,
      categoryId: matchedCategory,
      note: cleanNote ? cleanNote.charAt(0).toUpperCase() + cleanNote.slice(1) : 'Registro rápido',
    });
  }

  return results;
}

/**
 * Generates deterministic CFO insights from the micro-payload (0 tokens).
 * @param {any} payload
 */
export function buildDeterministicInsights(payload = {}) {
  const cur = payload.c || 'USD';
  const income = Number(payload.i) || 0;
  const expense = Number(payload.e) || 0;
  const savingsRate = income > 0 ? Math.round(((income - expense) / income) * 100) : 0;
  const categories = Array.isArray(payload.cats) ? payload.cats : [];
  const totalDebt = Number(payload.d) || 0;

  let score = 70;
  if (savingsRate >= 25) score += 20;
  else if (savingsRate >= 10) score += 8;
  else if (savingsRate < 0) score -= 25;

  const overBudgetCats = categories.filter(([, spent, budget]) => budget > 0 && spent > budget);
  score -= overBudgetCats.length * 8;
  if (totalDebt > income * 0.5 && income > 0) score -= 10;
  score = Math.max(15, Math.min(99, score));

  const status = score >= 85 ? 'excellent' : score >= 70 ? 'healthy' : score >= 50 ? 'warning' : 'critical';

  const tips = [];
  if (overBudgetCats.length > 0) {
    const [name, spent, budget] = overBudgetCats[0];
    const excess = (spent - budget).toFixed(0);
    tips.push(`Reduzca "${name}": supera el presupuesto mensual por ${cur} ${excess}.`);
  } else if (categories.length > 0) {
    const [topName, topSpent] = categories[0];
    const share = expense > 0 ? Math.round((topSpent / expense) * 100) : 0;
    tips.push(`"${topName}" representa el ${share}% de su gasto total (${cur} ${topSpent}).`);
  }

  if (savingsRate >= 20) {
    tips.push(`Excelente tasa de ahorro (${savingsRate}%). Destine el excedente a su fondo de inversión o metas.`);
  } else if (savingsRate >= 0) {
    tips.push(`Su tasa de ahorro actual es ${savingsRate}%. Automatice un 15% al inicio del mes.`);
  } else {
    tips.push(`Flujo negativo este período (${cur} ${(income - expense).toFixed(0)}). Priorice gastos esenciales.`);
  }

  if (totalDebt > 0) {
    tips.push(`Deuda activa de ${cur} ${totalDebt}: aplique método avalancha para liquidar saldos pendientes.`);
  } else {
    tips.push('Sin deudas críticas registradas; mantenga su liquidez cubriendo 3 a 6 meses de gastos.');
  }

  const topCat = categories[0];
  const potentialSave = topCat ? Math.max(10, Math.round(topCat[1] * 0.12)) : 25;

  return {
    score,
    status,
    headline:
      savingsRate >= 20
        ? `Salud financiera sólida con ${savingsRate}% de ahorro neto.`
        : savingsRate >= 0
          ? `Flujo positivo, con margen para optimizar presupuestos clave.`
          : `Atención: los gastos superan los ingresos del período actual.`,
    tips: tips.slice(0, 3),
    savingOpportunity: topCat
      ? `Recortar un 12% en ${topCat[0]} liberaría ~${cur} ${potentialSave} al mes.`
      : `Establecer presupuestos por categoría puede ahorrarle un 10-15% mensual.`,
  };
}

/**
 * Returns current Genkit & Token Optimizer status.
 */
export function getAiTelemetryStatus() {
  return {
    genkitConfigured: Boolean(process.env.GEMINI_API_KEY),
    model: DEFAULT_MODEL,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    cacheEntries: responseCache.size,
    ...telemetry,
  };
}
