/**
 * @fileoverview Browser-compatible Account Scan Schema & Normalizer (`public/js/schemas/accountScan.js`).
 * Mirrors `src/schemas/accountScan.ts` for native browser ES modules without requiring a bundler.
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

export function normalizeScanDateToIso(rawDate) {
  const str = String(rawDate || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }

  const dmyMatch = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (dmyMatch) {
    const day = dmyMatch[1].padStart(2, '0');
    const month = dmyMatch[2].padStart(2, '0');
    const rawYear = dmyMatch[3];
    const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
    return `${year}-${month}-${day}`;
  }

  const ymdSlash = str.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (ymdSlash) {
    return `${ymdSlash[1]}-${ymdSlash[2].padStart(2, '0')}-${ymdSlash[3].padStart(2, '0')}`;
  }

  return new Date().toISOString().slice(0, 10);
}

export function normalizeBankName(rawBank) {
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

export function normalizeScanCurrency(rawCurrency) {
  const str = String(rawCurrency || '').trim().toUpperCase();
  if (str === 'USD' || str.includes('$') || str.includes('DOLAR') || str.includes('DÓLAR')) {
    return 'USD';
  }
  return 'HNL';
}

export function validateAndNormalizeAccountScan(rawInput) {
  const raw = rawInput && typeof rawInput === 'object' ? rawInput : {};

  const parsedBalance =
    typeof raw.currentBalance === 'number'
      ? raw.currentBalance
      : Number.parseFloat(String(raw.currentBalance || '0').replace(/,/g, '')) || 0;

  const rawStatus = String(raw.status || 'Activa').trim().toLowerCase();
  const status = rawStatus.includes('inactiv') ? 'Inactiva' : 'Activa';

  const rawTxs = Array.isArray(raw.detectedTransactions) ? raw.detectedTransactions : [];
  const detectedTransactions = rawTxs
    .map((tx) => {
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
        type: isIncome ? 'income' : 'expense',
        amount: Number(rawAmount.toFixed(2)),
      };
    })
    .filter((tx) => tx.amount > 0);

  return {
    accountType: String(raw.accountType || 'Cuenta de Ahorro').trim() || 'Cuenta de Ahorro',
    accountNumber: String(raw.accountNumber || '').replace(/\s+/g, '').trim(),
    bankName: normalizeBankName(raw.bankName),
    currency: normalizeScanCurrency(raw.currency),
    currentBalance: Number(parsedBalance.toFixed(2)),
    status,
    detectedTransactions,
  };
}
