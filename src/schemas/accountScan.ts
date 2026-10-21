/**
 * @fileoverview Zod Schema & Sanitizers for Smart Account Detail & Mobile Banking OCR/Vision
 * (`src/schemas/accountScan.ts`).
 *
 * Implements:
 * 1. `cleanAmount`: Removes thousand-separator commas `,` BEFORE `parseFloat`
 *    (e.g. "3,901.33" -> "3901.33" -> 3901.33) so digits before the comma are never clipped.
 * 2. Full Account Number vs. Card Last-4 Rule:
 *    - Bank accounts (Ahorro, Cheques, SOS, etc.): preserves full account number (e.g. "213130058771").
 *    - Credit/Debit cards: extracts last 4 digits ONLY when explicitly masked/labeled as a card (e.g. "**** **** **** 0618").
 * 3. Honduras Currency & Transaction Type Detection:
 *    - Maps "L" or "Lempiras" -> "HNL", "$" or "USD"/"Dólares" -> "USD".
 *    - Classifies movements labeled "Crédito" or "Depósito" (e.g. "DEPOSITO DE AHORRO CON T/D L 200.00") as `type: "income"`.
 * 4. Mobile UI / Status Bar Filtering:
 *    - Strips phone clock (`5:30`), battery/WiFi indicators, and navigation buttons ("Transferir", "Pagar").
 */

export interface DetectedTransaction {
  date: string;
  concept: string;
  type: 'income' | 'expense';
  amount: number;
}

export interface AccountScanResult {
  accountType: string;
  accountNumber: string;
  bankName: string;
  currency: 'HNL' | 'USD' | string;
  currentBalance: number;
  status: 'Activa' | 'Inactiva' | string;
  detectedTransactions: DetectedTransaction[];
}

/**
 * Helper that sanitizes monetary amounts from OCR / Gemini Vision strings.
 * Removes thousand-separator commas `,` BEFORE converting to FLOAT (`parseFloat`).
 * Example: "3,901.33" -> "3901.33" -> parseFloat("3901.33") -> 3901.33
 */
export function cleanAmount(rawValue: unknown): number {
  if (typeof rawValue === 'number') {
    return Number.isFinite(rawValue) ? Math.round(rawValue * 100) / 100 : 0;
  }
  if (rawValue === null || rawValue === undefined) return 0;

  let str = String(rawValue)
    .trim()
    // Remove currency symbols/prefixes ("HNL", "USD", "LPS", "US$", "L", "$") without touching leading digits
    .replace(/^(?:HNL|USD|LPS|US\$|EUR|CRC|MXN|[Ll$€₡])\s*\.?\s*/i, '')
    // Collapse OCR spaces around commas and decimal points ("3, 901. 33" -> "3,901.33")
    .replace(/\s*([,.])\s*/g, '$1')
    .replace(/\s+/g, '');

  if (str.includes(',') && str.includes('.')) {
    if (str.lastIndexOf(',') < str.lastIndexOf('.')) {
      // Standard format with thousand-separator commas: "3,901.33" -> "3901.33"
      str = str.replace(/,/g, '');
    } else {
      // European format: "3.901,33" -> "3901.33"
      str = str.replace(/\./g, '').replace(',', '.');
    }
  } else if (/^-?\d{1,3}(?:,\d{3})+$/.test(str)) {
    // Integer with thousand commas: "3,901" -> "3901"
    str = str.replace(/,/g, '');
  } else if (/^-?\d+,\d{2}$/.test(str)) {
    // Decimal comma without thousand separator: "200,00" -> "200.00"
    str = str.replace(',', '.');
  } else {
    // Always strip commas before parseFloat
    str = str.replace(/,/g, '');
  }

  str = str.replace(/[^0-9.-]/g, '');
  const parsed = Number.parseFloat(str);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

/**
 * Mobile UI / Status Bar noise patterns to ignore during OCR text analysis
 * (phone clock e.g. `5:30`, battery/WiFi icons, navigation buttons "Transferir" / "Pagar").
 */
const MOBILE_UI_NOISE_PATTERNS: RegExp[] = [
  /^\s*\d{1,2}:\d{2}(?:\s*(?:AM|PM|a\.?\s*m\.?|p\.?\s*m\.?))?(?:\s+(?:4G|5G|LTE|WiFi|VoLTE|\d{1,3}%|[•|📶🔋⚡]))*\s*$/i,
  /^(?:4G|5G|LTE|WIFI|VOLTE|\d{1,3}%)$/i,
  /^[<>←→✕×+\-•·…\s]+$/,
  /^(?:DETALLE\s+DE\s+CUENTA|DETALLE\s+DE\s+MOVIMIENTOS|MOVIMIENTOS|ULTIMOS\s+MOVIMIENTOS|ÚLTIMOS\s+MOVIMIENTOS)$/i,
  /^(?:TRANSFERIR|PAGAR|COMPARTIR|DESCARGAR|RECARGAR|RETIRAR|CONFIGURAR|VER\s+M[AÁ]S|ATR[AÁ]S|VOLVER|INICIO|MEN[UÚ])$/i,
  /^(?:TRANSFERIR\s+PAGAR|PAGAR\s+TRANSFERIR)$/i,
  /^(?:SALDO\s+DISPONIBLE|SALDO\s+ACTUAL|SALDO\s+TOTAL|SALDO\s+EN\s+LIBROS|N[UÚ]MERO\s+DE\s+CUENTA|ESTADO|ACTIVA|INACTIVA|MONEDA|FECHA|DESCRIPCI[OÓ]N|CONCEPTO)$/i,
];

/**
 * Checks whether a single line of OCR text is mobile status bar or navigation button noise.
 */
export function isMobileUiNoiseLine(line: string): boolean {
  const trimmed = String(line || '')
    .replace(/[|_~`^]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!trimmed || trimmed.length < 2) return true;
  return MOBILE_UI_NOISE_PATTERNS.some((rx) => rx.test(trimmed));
}

/**
 * Strips mobile status bar elements (clock `5:30`, battery/WiFi icons, navigation buttons "Transferir" / "Pagar")
 * from raw OCR text lines.
 */
export function cleanMobileUiText(rawText: string): string {
  return String(rawText || '')
    .split(/\r?\n/)
    .map((line) =>
      line
        // Strip leading status bar time e.g. "5:30 " or "05:30 5G 80%" if merged onto the first line
        .replace(/^\s*\d{1,2}:\d{2}(?:\s*(?:AM|PM))?(?:\s+(?:4G|5G|LTE|WiFi|\d{1,3}%))*\s*$/i, '')
        // Strip standalone navigation button tokens
        .replace(/\b(?:Transferir|Pagar)\s+(?:Pagar|Transferir)\b/gi, '')
        .trim()
    )
    .filter((line) => line.length > 0 && !isMobileUiNoiseLine(line))
    .join('\n');
}

/**
 * Normalizes a raw date string (e.g. "15/10/2026", "15-10-26", "2026-10-15") into YYYY-MM-DD.
 */
export function normalizeScanDateToIso(rawDate: unknown): string {
  const str = String(rawDate || '').trim();
  if (!str) return new Date().toISOString().slice(0, 10);

  const isoMatch = str.match(/\b(20\d{2})[/.-](0[1-9]|1[0-2])[/.-](0[1-9]|[12]\d|3[01])\b/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  const dmyMatch = str.match(/\b(0?[1-9]|[12]\d|3[01])[/.-](0?[1-9]|1[0-2])[/.-](\d{2,4})\b/);
  if (dmyMatch) {
    const day = String(dmyMatch[1]).padStart(2, '0');
    const month = String(dmyMatch[2]).padStart(2, '0');
    const year = dmyMatch[3].length === 2 ? `20${dmyMatch[3]}` : dmyMatch[3];
    return `${year}-${month}-${day}`;
  }

  return new Date().toISOString().slice(0, 10);
}

/**
 * Normalizes the detected bank name (Honduras & regional context).
 */
export function normalizeBankName(rawBank: unknown): string {
  const text = String(rawBank || '').trim();
  if (!text) return 'Banco General';
  const lower = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  if (lower.includes('atlantida')) return 'Atlántida';
  if (lower.includes('bac') || lower.includes('credomatic')) return 'BAC';
  if (lower.includes('ficohsa')) return 'Ficohsa';
  if (lower.includes('banpais') || lower.includes('banco del pais')) return 'Banpais';
  if (lower.includes('occidente')) return 'Banco de Occidente';
  if (lower.includes('davivienda')) return 'Davivienda';
  if (lower.includes('lafise')) return 'Lafise';
  if (lower.includes('promerica')) return 'Promerica';
  if (lower.includes('banrural')) return 'Banrural';
  if (lower.includes('azteca')) return 'Banco Azteca';
  return text;
}

/**
 * Maps currency indicators in Honduras context:
 * - "L" or "Lempiras" / "HNL" / "LPS" -> "HNL"
 * - "$" or "USD" / "Dólares" / "Dolares" -> "USD"
 */
export function normalizeScanCurrency(rawCurrency: unknown): 'HNL' | 'USD' {
  const str = String(rawCurrency || '').trim();
  if (!str) return 'HNL';
  if (/\b(?:USD|US\$|D[OÓ]LAR(?:ES)?)\b|\$/i.test(str) && !/\b(?:HNL|LPS|LEMPIRAS?)\b/i.test(str)) {
    return 'USD';
  }
  if (/\b(?:HNL|LPS|LEMPIRAS?)\b|^L\.?$|(?:\b|^)L\.?\s*\d/i.test(str)) {
    return 'HNL';
  }
  return str.toUpperCase() === 'USD' ? 'USD' : 'HNL';
}

/**
 * Normalizes account number according to the rule:
 * - Bank accounts (Ahorro, Cheques, SOS, etc.): preserve the FULL account number (e.g. "213130058771").
 * - Credit/Debit Cards ("**** **** **** 0618"): extract last 4 digits ONLY when explicitly a card or masked.
 */
export function normalizeAccountOrCardNumber(
  rawAccountNumber: unknown,
  accountType = ''
): string {
  const raw = String(rawAccountNumber || '').trim();
  if (!raw) return '';

  const isExplicitCard =
    /tarjeta\s+de\s+(?:cr[eé]dito|d[eé]bito)|tarjeta|card|visa|mastercard|amex/i.test(accountType) ||
    /[*X•]{3,}\s*\d{4}/i.test(raw);

  const digitsOnly = raw.replace(/\D+/g, '');
  if (!digitsOnly) return raw;

  if (isExplicitCard && (/[*X•]/.test(raw) || digitsOnly.length === 4 || digitsOnly.length === 16)) {
    return digitsOnly.slice(-4);
  }

  // Bank Account (Ahorro, Cheques, SOS, etc.): return FULL account number
  return digitsOnly;
}

/**
 * Classifies transaction type in Honduras banking context:
 * - If labeled "Crédito" or "Depósito" (e.g. "DEPOSITO DE AHORRO CON T/D L 200.00"), returns "income".
 * - If labeled "Débito", "Retiro", "Compra", "Cargo", or "expense", returns "expense".
 */
export function classifyTransactionType(
  rawType: unknown,
  concept = ''
): 'income' | 'expense' {
  const combined = `${String(rawType || '')} ${String(concept || '')}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  if (
    /\b(?:income|ingreso|credito|cr|deposito|abono|nota\s+de\s+credito|intereses\s+ganados)\b/i.test(
      combined
    )
  ) {
    return 'income';
  }
  return 'expense';
}

/**
 * Validates and normalizes an `AccountScanResult` payload.
 */
export function validateAndNormalizeAccountScan(input: any): AccountScanResult {
  if (!input || typeof input !== 'object') {
    throw new Error('El resultado del escaneo de cuenta no es un objeto válido.');
  }

  const accountType =
    String(input.accountType || 'Cuenta de Ahorro')
      .replace(/\s+/g, ' ')
      .trim() || 'Cuenta de Ahorro';

  const accountNumber = normalizeAccountOrCardNumber(input.accountNumber, accountType);
  const bankName = normalizeBankName(input.bankName);
  const currency = normalizeScanCurrency(input.currency);
  const currentBalance = cleanAmount(input.currentBalance);
  const statusRaw = String(input.status || 'Activa').trim();
  const status = /^inactiv/i.test(statusRaw) ? 'Inactiva' : 'Activa';

  const rawTxs = Array.isArray(input.detectedTransactions) ? input.detectedTransactions : [];
  const detectedTransactions: DetectedTransaction[] = rawTxs
    .map((tx: any) => {
      const concept = String(tx?.concept || tx?.description || 'Movimiento bancario')
        .replace(/\s+/g, ' ')
        .trim();
      const amount = Math.abs(cleanAmount(tx?.amount));
      const type = classifyTransactionType(tx?.type, concept);
      const date = normalizeScanDateToIso(tx?.date);
      return {
        date,
        concept,
        type,
        amount,
      };
    })
    .filter((tx: DetectedTransaction) => tx.amount > 0 && !isMobileUiNoiseLine(tx.concept));

  return {
    accountType,
    accountNumber,
    bankName,
    currency,
    currentBalance,
    status,
    detectedTransactions,
  };
}

/**
 * Zod-compatible schema wrapper for `DetectedTransaction` and `AccountScanSchema`.
 */
export const DetectedTransactionSchema = Object.freeze({
  parse(input: unknown): DetectedTransaction {
    const normalized = validateAndNormalizeAccountScan({
      detectedTransactions: [input],
    });
    if (normalized.detectedTransactions.length === 0) {
      throw new Error('Transacción detectada inválida.');
    }
    return normalized.detectedTransactions[0];
  },
  safeParse(input: unknown) {
    try {
      return { success: true as const, data: this.parse(input) };
    } catch (error) {
      return { success: false as const, error };
    }
  },
});

export const AccountScanSchema = Object.freeze({
  parse(input: unknown): AccountScanResult {
    return validateAndNormalizeAccountScan(input);
  },
  safeParse(input: unknown) {
    try {
      return { success: true as const, data: validateAndNormalizeAccountScan(input) };
    } catch (error) {
      return { success: false as const, error };
    }
  },
});

/**
 * JSON Schema passed to Gemini 1.5 Flash (`responseSchema`) for structured output.
 */
export const ACCOUNT_SCAN_RESPONSE_JSON_SCHEMA = Object.freeze({
  type: 'OBJECT',
  properties: {
    accountType: {
      type: 'STRING',
      description:
        'Tipo o descripción de la cuenta (ej. "CUENTA DE AHORRO SOS", "Cuenta de Ahorro", "Cuenta Cheques", "Tarjeta de Crédito")',
    },
    accountNumber: {
      type: 'STRING',
      description:
        'Para cuentas bancarias (Ahorro, Cheques, SOS, etc.) extrae el NÚMERO DE CUENTA COMPLETO (ej. "213130058771"). Usa últimos 4 dígitos ÚNICAMENTE si es una Tarjeta de Crédito/Débito enmascarada (ej. "0618").',
    },
    bankName: {
      type: 'STRING',
      description:
        'Nombre del banco detectado (Atlántida, BAC, Ficohsa, Banpais, Davivienda, Lafise, Promerica, Banco de Occidente o "Banco General")',
    },
    currency: {
      type: 'STRING',
      enum: ['HNL', 'USD'],
      description: '"HNL" si aparece el símbolo "L" o la palabra "Lempiras"; "USD" si aparece "$" o "USD" / "Dólares"',
    },
    currentBalance: {
      type: 'NUMBER',
      description:
        'Saldo actual/disponible como número FLOAT sin comas de miles (ej. "3,901.33" -> 3901.33)',
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
            description: 'Fecha en formato YYYY-MM-DD (ej. "15/10/2026" -> "2026-10-15")',
          },
          concept: {
            type: 'STRING',
            description:
              'Concepto o descripción de la transacción (ej. "DEPOSITO DE AHORRO CON T/D 37170597"), ignorando barra de estado (5:30, batería, WiFi) y botones ("Transferir", "Pagar")',
          },
          type: {
            type: 'STRING',
            enum: ['income', 'expense'],
            description:
              '"income" si indica Crédito o Depósito (ej. "DEPOSITO DE AHORRO CON T/D"); "expense" si indica Débito, Retiro o Compra',
          },
          amount: {
            type: 'NUMBER',
            description: 'Monto numérico FLOAT sin comas de miles (ej. 200.00)',
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

