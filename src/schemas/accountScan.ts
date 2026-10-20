/**
 * @fileoverview Zod Schema & Normalizers for Smart Account Detail Screenshot Scanning
 * (OCR + Gemini 1.5 Flash / Genkit Vision) — `src/schemas/accountScan.ts`.
 */

import { z } from 'zod';

/**
 * Schema for each transaction detected inside the mobile banking screenshot.
 */
export const DetectedTransactionSchema = z.object({
  date: z
    .string()
    .describe('Fecha de la transacción en formato YYYY-MM-DD (ej. "15/10/2026" -> "2026-10-15")'),
  concept: z
    .string()
    .describe('Concepto o descripción del movimiento (ej. "DEPOSITO DE AHORRO CON T/D 37170597")'),
  type: z
    .enum(['income', 'expense'])
    .describe('Si indica Crédito/Depósito es "income"; si indica Débito/Retiro es "expense"'),
  amount: z.number().nonnegative().describe('Monto numérico positivo de la transacción (ej. 200.00)'),
});

/**
 * Main Zod Schema for structured extraction of an Account Detail screenshot via Gemini API / Genkit.
 */
export const AccountScanSchema = z.object({
  accountType: z
    .string()
    .describe('Tipo de cuenta detectada (ej. "Cuenta de Ahorro", "Cuenta Cheques", "Tarjeta de Crédito")'),
  accountNumber: z
    .string()
    .describe('Número de cuenta completo o últimos 4 dígitos (ej. "213130058771")'),
  bankName: z
    .string()
    .describe('Nombre del banco detectado (ej. "Atlántida", "BAC", "Ficohsa", "Banpais" o "Banco General")'),
  currency: z
    .string()
    .describe('Moneda detectada: "HNL" si muestra "L" / "Lempiras", o "USD" si muestra "$" / "Dólares"'),
  currentBalance: z
    .number()
    .describe('Saldo disponible o saldo actual numérico de la cuenta (ej. 3901.33)'),
  status: z
    .string()
    .describe('Estado de la cuenta: "Activa" o "Inactiva"'),
  detectedTransactions: z
    .array(DetectedTransactionSchema)
    .default([])
    .describe('Lista de transacciones o movimientos visibles en la captura de pantalla'),
});

export type DetectedTransaction = z.infer<typeof DetectedTransactionSchema>;
export type AccountScanResult = z.infer<typeof AccountScanSchema>;

/**
 * JSON Schema representation used with Gemini 1.5 Flash `generationConfig.responseSchema`.
 */
export const ACCOUNT_SCAN_RESPONSE_JSON_SCHEMA = Object.freeze({
  type: 'OBJECT',
  properties: {
    accountType: {
      type: 'STRING',
      description: 'Ej. "Cuenta de Ahorro", "Cuenta Cheques", "Tarjeta de Crédito"',
    },
    accountNumber: {
      type: 'STRING',
      description: 'Número de cuenta (ej. "213130058771" o últimos 4 dígitos)',
    },
    bankName: {
      type: 'STRING',
      description: 'Atlántida, BAC, Ficohsa, Banpais, Davivienda, Lafise, Promerica, Occidente o "Banco General"',
    },
    currency: {
      type: 'STRING',
      enum: ['HNL', 'USD'],
      description: '"HNL" si ve "L" o "USD" si ve "$"',
    },
    currentBalance: {
      type: 'NUMBER',
      description: 'Saldo actual numérico (ej. 3901.33)',
    },
    status: {
      type: 'STRING',
      enum: ['Activa', 'Inactiva'],
      description: 'Estado de la cuenta ("Activa" o "Inactiva")',
    },
    detectedTransactions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          date: {
            type: 'STRING',
            description: 'Formato YYYY-MM-DD (ej. "15/10/2026" -> "2026-10-15")',
          },
          concept: {
            type: 'STRING',
            description: 'Concepto o descripción (ej. "DEPOSITO DE AHORRO CON T/D 37170597")',
          },
          type: {
            type: 'STRING',
            enum: ['income', 'expense'],
            description: 'Crédito/Depósito = "income", Débito/Retiro = "expense"',
          },
          amount: {
            type: 'NUMBER',
            description: 'Monto numérico (ej. 200.00)',
          },
        },
        required: ['date', 'concept', 'type', 'amount'],
      },
    },
  },
  required: [
    'accountType',
    'accountNumber',
    'bankName',
    'currency',
    'currentBalance',
    'status',
    'detectedTransactions',
  ],
});

/**
 * Parses a visible date string (e.g. "15/10/2026", "15-10-2026", "2026-10-15") into "YYYY-MM-DD".
 */
export function normalizeScanDateToIso(rawDate: unknown): string {
  const str = String(rawDate || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }

  // Match DD/MM/YYYY or DD-MM-YYYY
  const dmyMatch = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (dmyMatch) {
    const day = dmyMatch[1].padStart(2, '0');
    const month = dmyMatch[2].padStart(2, '0');
    const rawYear = dmyMatch[3];
    const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
    return `${year}-${month}-${day}`;
  }

  // Match YYYY/MM/DD
  const ymdSlash = str.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (ymdSlash) {
    return `${ymdSlash[1]}-${ymdSlash[2].padStart(2, '0')}-${ymdSlash[3].padStart(2, '0')}`;
  }

  return new Date().toISOString().slice(0, 10);
}

/**
 * Normalizes a raw bank name into a recognized institution or "Banco General".
 */
export function normalizeBankName(rawBank: unknown): string {
  const raw = String(rawBank || '').trim();
  if (!raw) return 'Banco General';
  const lower = raw.toLowerCase();
  if (lower.includes('atlantida') || lower.includes('atlántida')) return 'Atlántida';
  if (lower.includes('bac') || lower.includes('credomatic')) return 'BAC';
  if (lower.includes('ficohsa')) return 'Ficohsa';
  if (lower.includes('banpais') || lower.includes('banpaís')) return 'Banpais';
  if (lower.includes('occidente')) return 'Banco de Occidente';
  if (lower.includes('davivienda')) return 'Davivienda';
  if (lower.includes('lafise')) return 'Lafise';
  if (lower.includes('promerica')) return 'Promerica';
  if (lower.includes('banrural')) return 'Banrural';
  if (lower.includes('azteca')) return 'Banco Azteca';
  if (lower.includes('sagrada familia')) return 'Cooperativa Sagrada Familia';
  if (lower.includes('elga')) return 'Cooperativa ELGA';
  return raw;
}

/**
 * Normalizes currency indicators ("L", "LPS", "HNL", "$", "USD") to "HNL" or "USD".
 */
export function normalizeScanCurrency(rawCurrency: unknown): 'HNL' | 'USD' {
  const str = String(rawCurrency || '').trim().toUpperCase();
  if (str === 'USD' || str.includes('$') || str.includes('DOLAR') || str.includes('DÓLAR')) {
    return 'USD';
  }
  return 'HNL';
}

/**
 * Normalizes and validates raw Gemini/OCR output against `AccountScanSchema`.
 */
export function validateAndNormalizeAccountScan(rawInput: any): AccountScanResult {
  const raw = rawInput && typeof rawInput === 'object' ? rawInput : {};

  const parsedBalance =
    typeof raw.currentBalance === 'number'
      ? raw.currentBalance
      : Number.parseFloat(String(raw.currentBalance || '0').replace(/,/g, '')) || 0;

  const rawStatus = String(raw.status || 'Activa').trim().toLowerCase();
  const status = rawStatus.includes('inactiv') ? 'Inactiva' : 'Activa';

  const rawTxs = Array.isArray(raw.detectedTransactions) ? raw.detectedTransactions : [];
  const detectedTransactions: DetectedTransaction[] = rawTxs
    .map((tx: any) => {
      const rawType = String(tx?.type || '').trim().toLowerCase();
      const concept = String(tx?.concept || 'Movimiento bancario').trim();
      const conceptLower = concept.toLowerCase();
      const isIncome =
        rawType === 'income' ||
        rawType.includes('credit') ||
        rawType.includes('crédit') ||
        rawType.includes('deposit') ||
        rawType.includes('depósit') ||
        (!rawType &&
          (conceptLower.includes('deposito') ||
            conceptLower.includes('depósito') ||
            conceptLower.includes('credito') ||
            conceptLower.includes('crédito') ||
            conceptLower.includes('abono')));

      const rawAmount =
        typeof tx?.amount === 'number'
          ? Math.abs(tx.amount)
          : Math.abs(Number.parseFloat(String(tx?.amount || '0').replace(/,/g, '')) || 0);

      return {
        date: normalizeScanDateToIso(tx?.date),
        concept: concept || 'Movimiento bancario',
        type: (isIncome ? 'income' : 'expense') as 'income' | 'expense',
        amount: Number(rawAmount.toFixed(2)),
      };
    })
    .filter((tx: DetectedTransaction) => tx.amount > 0);

  const candidate = {
    accountType: String(raw.accountType || 'Cuenta de Ahorro').trim() || 'Cuenta de Ahorro',
    accountNumber: String(raw.accountNumber || '').replace(/\s+/g, '').trim(),
    bankName: normalizeBankName(raw.bankName),
    currency: normalizeScanCurrency(raw.currency),
    currentBalance: Number(parsedBalance.toFixed(2)),
    status,
    detectedTransactions,
  };

  return AccountScanSchema.parse(candidate);
}
