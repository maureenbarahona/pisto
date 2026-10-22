/**
 * @fileoverview Refactored UI/UX Component for the "Presupuestos y Genkit IA" View (`src/js/components/BudgetsView.js`).
 *
 * Implements:
 * 1. Redesigned Budget Limit Cards (Left Column):
 *    - Generous card padding (`p-4`) and vertical spacing (`gap-3`).
 *    - Flexbox header (`justify-content: space-between`, `align-items: safe center`) with `min-inline-size: 0`
 *      so category names and numeric inputs never overlap.
 *    - High-contrast progress bars and clear visual hierarchy for "Gastado", "Disponible", and "Excedido".
 * 2. Simplified AI Financial Coach Section (Right Column):
 *    - Centered & highlighted primary CTA button ("✨ Generar Diagnóstico con Genkit").
 *    - Clean empty state container (`#ai-insights-result-mount`) below the button for rendering AI insights.
 *    - Collapsible `<details id="ai-technical-details">` ("⚙️ Ver datos técnicos de IA") hiding raw JSON
 *      micro-payload strings and technical token metrics by default.
 * 3. Responsive Multi-Column Grid:
 *    - Single column on mobile (`grid-cols-1`) shifting to a 3-column layout (`md:grid-cols-3`) on desktop
 *      where Budget Limit Cards span 2 columns (`md:col-span-2`) and the AI Coach spans 1 column (`md:col-span-1`).
 */

import { Money } from '../../../public/js/domain/models.js';

export const AI_COACH_CTA_BUTTON_ID = 'btn-generate-ai-insights';
export const AI_COACH_CTA_LABEL = '✨ Generar Diagnóstico con Genkit';
export const AI_TECHNICAL_DETAILS_ID = 'ai-technical-details';
export const AI_TECHNICAL_SUMMARY_LABEL = '⚙️ Ver datos técnicos de IA';

/**
 * Formats the status label for a budget category card ("Disponible", "Excedido", or "Sin límite asignado").
 *
 * @param {object} cat
 * @param {string} cur
 * @returns {string}
 */
export function formatBudgetCategoryStatusHtml(cat, cur = 'HNL') {
  const limit = Number(cat?.budgetLimit || 0);
  const spent = Number(cat?.amount || 0);
  const pct = Number(cat?.budgetPct || 0);

  if (limit <= 0) {
    return '<span class="budget-status-badge status-none">Sin límite asignado</span>';
  }

  if (spent <= limit) {
    const available = Money.format(limit - spent, cur);
    return `Disponible: <strong>${available}</strong> <span class="budget-pct-pill">(${pct}%)</span>`;
  }

  const exceeded = Money.format(spent - limit, cur);
  return `Excedido: <strong>${exceeded}</strong> <span class="budget-pct-pill">(${pct}%)</span>`;
}

/**
 * Renders an individual category budget limit card with Flexbox alignment, progress bar, and status hierarchy.
 *
 * @param {object} cat
 * @param {string} [cur='HNL']
 * @returns {string}
 */
export function renderBudgetLimitCardMarkup(cat, cur = 'HNL') {
  if (!cat) return '';
  const status = cat.budgetStatus || 'none';
  const pct = Math.min(100, Math.max(0, Number(cat.budgetPct || 0)));
  const limitValue = Number(cat.budgetLimit || 0);
  const spentFormatted = Money.format(Number(cat.amount || 0), cur);
  const statusHtml = formatBudgetCategoryStatusHtml(cat, cur);

  return `
    <article class="budget-item-card p-4 status-border-${status}" data-budget-card="${cat.id}">
      <div class="budget-item-header flex justify-between items-center">
        <div class="budget-cat-title">
          <span class="budget-dot" style="background-color: ${cat.color || '#10b981'}" aria-hidden="true"></span>
          <strong class="budget-cat-name">${cat.name}</strong>
        </div>
        <div class="budget-input-group">
          <label for="budget-input-${cat.id}" class="sr-only">Límite mensual para ${cat.name}</label>
          <span class="currency-prefix" aria-hidden="true">${cur}</span>
          <input
            type="number"
            id="budget-input-${cat.id}"
            name="budget_${cat.id}"
            class="budget-inline-input"
            inputmode="decimal"
            min="0"
            step="10"
            value="${limitValue}"
            data-budget-category="${cat.id}"
          />
        </div>
      </div>
      <div class="budget-progress-track">
        <progress
          class="native-progress budget-progress-bar progress-${status}"
          max="100"
          value="${pct}"
          aria-label="Progreso de presupuesto para ${cat.name}: ${pct}%"
        ></progress>
      </div>
      <div class="budget-item-footer flex justify-between items-center">
        <span class="budget-spent-text">
          Gastado: <strong>${spentFormatted}</strong>
        </span>
        <span class="budget-status-text status-${status}">
          ${statusHtml}
        </span>
      </div>
    </article>
  `.trim();
}

/**
 * Renders the list of category budget limit cards for the left column.
 *
 * @param {Array<object>} expenseCategories
 * @param {string} [cur='HNL']
 * @returns {string}
 */
export function renderBudgetsListMarkup(expenseCategories = [], cur = 'HNL') {
  if (!Array.isArray(expenseCategories) || expenseCategories.length === 0) {
    return `
      <div class="budget-empty-card p-4">
        <p class="text-muted">No hay categorías de gasto registradas todavía.</p>
      </div>
    `.trim();
  }

  return expenseCategories.map((cat) => renderBudgetLimitCardMarkup(cat, cur)).join('');
}

/**
 * Renders the clean default empty state inside `#ai-insights-result-mount` below the CTA button.
 *
 * @returns {string}
 */
export function renderAiInsightsEmptyStateMarkup() {
  return `
    <div class="ai-insights-empty-state p-4" role="status">
      <div class="ai-empty-state-icon" aria-hidden="true">🧭</div>
      <strong class="ai-empty-state-title">Diagnóstico financiero listo bajo demanda</strong>
      <p class="ai-empty-state-copy">
        Pulsa <strong>"${AI_COACH_CTA_LABEL}"</strong> para evaluar tu ritmo de gasto frente a tus presupuestos mensuales y descubrir oportunidades personalizadas de ahorro.
      </p>
    </div>
  `.trim();
}

/**
 * Renders the AI Coach response card or the clean empty state if no result is available yet.
 *
 * @param {object|null} result
 * @returns {string}
 */
export function renderAiInsightsResultMarkup(result = null) {
  if (!result || !result.headline) {
    return renderAiInsightsEmptyStateMarkup();
  }

  const tipsHtml = (result.tips || [])
    .map((tip) => `<li>${tip}</li>`)
    .join('');

  return `
    <div class="ai-insight-card p-4 status-border-${result.status || 'healthy'}">
      <div class="ai-insight-header">
        <div class="ai-score-circle">
          <strong>${result.score ?? 0}</strong>
          <span>/100</span>
        </div>
        <div class="ai-headline-box">
          <span class="ai-source-tag">
            Diagnóstico IA · ${result.cached ? 'Respuesta instantánea' : 'Análisis actualizado'}
          </span>
          <h4>${result.headline}</h4>
        </div>
      </div>
      <ul class="ai-tips-list">
        ${tipsHtml}
      </ul>
      <div class="ai-opportunity-banner">
        <strong>🎯 Oportunidad de ahorro:</strong> ${result.savingOpportunity || ''}
      </div>
    </div>
  `.trim();
}

/**
 * Renders the technical token telemetry pills inside the collapsible `<details>` debug section.
 *
 * @param {object} micro
 * @param {number} [localParsesSaved=0]
 * @returns {string}
 */
export function renderTokenTechnicalStatsMarkup(micro = {}, localParsesSaved = 0) {
  const rawTokens = micro?.rawTokensEstimate ?? 0;
  const compactTokens = micro?.compactTokensEstimate ?? 0;
  const savingsPct = micro?.savingsPct ?? 0;

  return `
    <div class="token-stat-pill">
      <span>Historial bruto:</span>
      <strong>~${rawTokens} tokens</strong>
    </div>
    <div class="token-stat-pill highlight">
      <span>Micro-Payload Genkit:</span>
      <strong>${compactTokens} tokens (-${savingsPct}%)</strong>
    </div>
    <div class="token-stat-pill">
      <span>Parses locales (0 tokens):</span>
      <strong>${localParsesSaved}</strong>
    </div>
  `.trim();
}

/**
 * Renders the complete HTML structure for the `#panel-budgets` view ("Presupuestos y Genkit IA").
 *
 * @returns {string}
 */
export function renderBudgetsAndAiPanelMarkup() {
  return `
    <div class="budgets-ai-grid grid grid-cols-1 md:grid-cols-3 gap-6">
      <div class="budgets-column md:col-span-2">
        <div class="budgets-section-header">
          <h2>Límites de Presupuesto Mensual</h2>
          <p class="budgets-section-subtitle">
            Ajusta el tope de cada categoría para recibir alertas tempranas antes de excederte.
          </p>
        </div>
        <div id="budgets-list-mount" class="budgets-list"></div>
      </div>

      <aside class="ai-coach-panel md:col-span-1 p-4" aria-label="Coach Financiero con Inteligencia Artificial">
        <div class="ai-coach-header">
          <h2>Coach Financiero Firebase Genkit</h2>
          <p class="ai-coach-subtitle">
            Obtén recomendaciones claras sobre tus hábitos de gasto y metas de ahorro mensuales con inteligencia artificial.
          </p>
        </div>

        <div class="ai-coach-cta-wrapper">
          <button
            type="button"
            id="${AI_COACH_CTA_BUTTON_ID}"
            class="btn-ai btn-ai-cta-highlight"
            data-action="generate-ai-insights"
            aria-label="Generar diagnóstico financiero con Firebase Genkit"
          >
            ${AI_COACH_CTA_LABEL}
          </button>
        </div>

        <div id="ai-insights-result-mount" class="ai-insights-result-area" aria-live="polite">
          ${renderAiInsightsEmptyStateMarkup()}
        </div>

        <details id="${AI_TECHNICAL_DETAILS_ID}" class="ai-technical-details">
          <summary class="ai-technical-summary">${AI_TECHNICAL_SUMMARY_LABEL}</summary>
          <div class="ai-technical-body">
            <p class="ai-technical-note">
              Compresión extrema de contexto: el historial se resume localmente en un micro-payload compacto para optimizar el consumo de tokens.
            </p>
            <div id="token-compression-stats" class="token-stats-grid"></div>
            <div class="micro-payload-wrapper">
              <span class="micro-payload-label">
                Micro-Payload enviado a Genkit (<code>gemini-2.5-flash</code>):
              </span>
              <pre id="micro-payload-preview" class="micro-payload-box" tabindex="0"><code id="micro-payload-code"></code></pre>
            </div>
          </div>
        </details>
      </aside>
    </div>
  `.trim();
}
