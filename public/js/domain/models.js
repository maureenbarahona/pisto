/**
 * @fileoverview Core Domain Models, Value Objects & Constants.
 *
 * Follows Clean Code principles:
 * - Integer-cents arithmetic (Money Value Object) to prevent IEEE-754 floating point drift.
 * - Immutable domain constants for categories, currencies, and account types.
 * - Pure factory functions with explicit validation.
 */

export const CURRENCIES = Object.freeze({
  USD: { code: 'USD', symbol: '$', name: 'Dólar estadounidense', rateToUsd: 1.0 },
  HNL: { code: 'HNL', symbol: 'L', name: 'Lempira hondureño', rateToUsd: 0.0403 },
  EUR: { code: 'EUR', symbol: '€', name: 'Euro', rateToUsd: 1.08 },
  CRC: { code: 'CRC', symbol: '₡', name: 'Colón costarricense', rateToUsd: 0.00195 },
  MXN: { code: 'MXN', symbol: '$', name: 'Peso mexicano', rateToUsd: 0.056 },
  COP: { code: 'COP', symbol: '$', name: 'Peso colombiano', rateToUsd: 0.00025 },
  CLP: { code: 'CLP', symbol: '$', name: 'Peso chileno', rateToUsd: 0.00105 },
  ARS: { code: 'ARS', symbol: '$', name: 'Peso argentino', rateToUsd: 0.001 },
});

export const ACCOUNT_TYPES = Object.freeze({
  CASH: 'cash',
  BANK: 'bank',
  CARD: 'card',
  SAVINGS: 'savings',
  DEBT: 'debt',
});

export const TRANSACTION_TYPES = Object.freeze({
  EXPENSE: 'expense',
  INCOME: 'income',
  TRANSFER: 'transfer',
});

/**
 * Curated Pisto-inspired categories with harmonious palette colors and SVG icon keys.
 */
export const DEFAULT_CATEGORIES = Object.freeze([
  // Expense Categories
  { id: 'groceries', name: 'Supermercado', type: 'expense', color: '#10b981', icon: 'cart', defaultBudget: 450 },
  { id: 'food', name: 'Restaurantes', type: 'expense', color: '#f59e0b', icon: 'utensils', defaultBudget: 250 },
  { id: 'transport', name: 'Transporte', type: 'expense', color: '#3b82f6', icon: 'car', defaultBudget: 200 },
  { id: 'housing', name: 'Vivienda', type: 'expense', color: '#6366f1', icon: 'home', defaultBudget: 950 },
  { id: 'utilities', name: 'Servicios', type: 'expense', color: '#06b6d4', icon: 'bolt', defaultBudget: 180 },
  { id: 'health', name: 'Salud y Gym', type: 'expense', color: '#ec4899', icon: 'heart', defaultBudget: 150 },
  { id: 'entertainment', name: 'Ocio y Streaming', type: 'expense', color: '#8b5cf6', icon: 'film', defaultBudget: 120 },
  { id: 'shopping', name: 'Compras', type: 'expense', color: '#f43f5e', icon: 'bag', defaultBudget: 200 },
  { id: 'education', name: 'Educación', type: 'expense', color: '#14b8a6', icon: 'book', defaultBudget: 120 },
  { id: 'family', name: 'Hogar y Mascotas', type: 'expense', color: '#eab308', icon: 'sparkles', defaultBudget: 100 },

  // Income Categories
  { id: 'salary', name: 'Salario', type: 'income', color: '#10b981', icon: 'briefcase', defaultBudget: 0 },
  { id: 'freelance', name: 'Freelance', type: 'income', color: '#06b6d4', icon: 'laptop', defaultBudget: 0 },
  { id: 'investments', name: 'Inversiones', type: 'income', color: '#8b5cf6', icon: 'trending', defaultBudget: 0 },
  { id: 'gifts', name: 'Otros Ingresos', type: 'income', color: '#f59e0b', icon: 'gift', defaultBudget: 0 },
]);

/**
 * Money Value Object utilities using integer cents to guarantee exact accounting math.
 */
export const Money = Object.freeze({
  /**
   * Converts a decimal monetary amount to integer cents.
   * @param {number|string} amount
   * @returns {number}
   */
  toCents(amount) {
    const parsed = typeof amount === 'number' ? amount : Number.parseFloat(String(amount).replace(/,/g, '.'));
    if (!Number.isFinite(parsed)) return 0;
    return Math.round(parsed * 100);
  },

  /**
   * Converts integer cents back to a two-decimal number.
   * @param {number} cents
   * @returns {number}
   */
  fromCents(cents) {
    if (!Number.isFinite(cents)) return 0;
    return Math.round(cents) / 100;
  },

  /**
   * Safely adds two decimal amounts using integer cents.
   * @param {number} a
   * @param {number} b
   * @returns {number}
   */
  add(a, b) {
    return Money.fromCents(Money.toCents(a) + Money.toCents(b));
  },

  /**
   * Safely subtracts b from a using integer cents.
   * @param {number} a
   * @param {number} b
   * @returns {number}
   */
  subtract(a, b) {
    return Money.fromCents(Money.toCents(a) - Money.toCents(b));
  },

  /**
   * Converts an amount from one currency to another.
   * @param {number} amount
   * @param {string} fromCurrency
   * @param {string} toCurrency
   * @param {Record<string, { rateToUsd: number }>} [customRates]
   * @returns {number}
   */
  convert(amount, fromCurrency, toCurrency, customRates = CURRENCIES) {
    if (fromCurrency === toCurrency) return Money.fromCents(Money.toCents(amount));
    const fromRate = customRates[fromCurrency]?.rateToUsd ?? CURRENCIES[fromCurrency]?.rateToUsd ?? 1;
    const toRate = customRates[toCurrency]?.rateToUsd ?? CURRENCIES[toCurrency]?.rateToUsd ?? 1;
    const amountInUsd = Number(amount) * fromRate;
    const converted = amountInUsd / toRate;
    return Money.fromCents(Money.toCents(converted));
  },

  /**
   * Formats a number as a localized currency string.
   * @param {number} amount
   * @param {string} [currencyCode='USD']
   * @returns {string}
   */
  format(amount, currencyCode = 'USD') {
    const validCode = CURRENCIES[currencyCode] ? currencyCode : 'USD';
    const numeric = Number.isFinite(Number(amount)) ? Number(amount) : 0;
    try {
      return new Intl.NumberFormat('es-HN', {
        style: 'currency',
        currency: validCode,
        minimumFractionDigits: validCode === 'CRC' || validCode === 'CLP' || validCode === 'COP' ? 0 : 2,
        maximumFractionDigits: validCode === 'CRC' || validCode === 'CLP' || validCode === 'COP' ? 0 : 2,
      }).format(numeric);
    } catch {
      const symbol = CURRENCIES[validCode]?.symbol || '$';
      return `${symbol}${numeric.toFixed(2)}`;
    }
  },
});

/**
 * Generates a compact collision-resistant ID.
 * @param {string} [prefix='id']
 * @returns {string}
 */
export function generateId(prefix = 'id') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Creates a validated Transaction entity.
 * @param {object} input
 */
export function createTransaction({
  id = generateId('tx'),
  type = TRANSACTION_TYPES.EXPENSE,
  amount,
  currency = 'USD',
  categoryId = 'groceries',
  accountId = 'acc_bank',
  toAccountId = null,
  note = '',
  date = new Date().toISOString().slice(0, 10),
  createdAt = new Date().toISOString(),
  ownerUid = '',
  ownerName = '',
}) {
  const cleanAmount = Money.fromCents(Money.toCents(amount));
  if (cleanAmount <= 0) {
    throw new Error('El monto de la transacción debe ser mayor que cero.');
  }
  if (!Object.values(TRANSACTION_TYPES).includes(type)) {
    throw new Error(`Tipo de transacción inválido: ${type}`);
  }
  if (type === TRANSACTION_TYPES.TRANSFER && (!toAccountId || toAccountId === accountId)) {
    throw new Error('Una transferencia requiere una cuenta de destino distinta a la cuenta de origen.');
  }

  return {
    id,
    type,
    amount: cleanAmount,
    currency: CURRENCIES[currency] ? currency : 'USD',
    categoryId: type === TRANSACTION_TYPES.TRANSFER ? 'transfer' : categoryId,
    accountId,
    toAccountId: type === TRANSACTION_TYPES.TRANSFER ? toAccountId : null,
    note: String(note || '').trim().slice(0, 160),
    date: String(date).slice(0, 10),
    createdAt,
    ownerUid: String(ownerUid || '').trim(),
    ownerName: String(ownerName || '').trim().slice(0, 80),
  };
}

export const HONDURAS_FINANCIAL_ENTITIES = Object.freeze({
  bancos: Object.freeze([
    'Banco Atlántida',
    'BAC Credomatic Honduras',
    'Banco Ficohsa',
    'Banpaís (Banco del País)',
    'Banco de Occidente',
    'Banco Davivienda Honduras',
    'Banco Lafise Honduras',
    'Banco Promerica Honduras',
    'Ficensa (Banco Financiera Comercial Hondureña)',
    'Banco Azteca Honduras',
    'Banrural Honduras',
    'Banco Popular',
    'Banco Hondureño del Café (Banhcafé)',
    'Banco de los Trabajadores (Bantrab)',
    'Banhprovi (Banco Hondureño para la Producción y la Vivienda)',
    'Banadesa (Banco Nacional de Desarrollo Agrícola)',
  ]),
  cooperativas: Object.freeze([
    'Cooperativa Sagrada Familia',
    'Cooperativa ELGA',
    'Cooperativa Chorotega',
    'Cooperativa Guadalupe',
    'Cooperativa Ceibeña',
    'Cooperativa CACEENP',
    'Cooperativa Arsenault',
    'Cooperativa Juticalpa',
    'Cooperativa San Marqueña',
    'Cooperativa COMIXMUL',
    'Cooperativa CACIL',
    'Cooperativa COACEHL (Educadores de Honduras)',
    'Cooperativa Taulabé',
    'Cooperativa Apaguiz',
    'Cooperativa Ocotepeque',
    'Cooperativa Fe y Esperanza',
    'Cooperativa Maya',
    'Cooperativa Fraternidad Pespirense',
    'Cooperativa Sonaguera',
    'Cooperativa Talanga (COOPETALANGA)',
    'Cooperativa Río Grande',
    'Cooperativa La Paz',
    'Cooperativa Pinalejo',
    'Cooperativa Usula',
    'Cooperativa San Antonio María Claret',
    'Cooperativa El Negrito',
    'Cooperativa Nueva Vida',
    'Cooperativa San José Obrero',
    'Cooperativa Mixta Lempira',
  ]),
  financierasYBilleteras: Object.freeze([
    'Financiera FINSOL (Financiera Solidaria)',
    'Financiera FINCA Honduras',
    'Financiera CODIMERSA',
    'Financiera CrediQ',
    'ODEF Financiera',
    'Tigo Money Honduras',
    'Tengo (Billetera Digital)',
    'Dilo (Billetera Digital)',
    'Kash Honduras',
  ]),
});

/**
 * Extracts the last 4 numeric digits from a card number, IBAN, or account number string.
 * @param {string|number} rawAccountOrCard
 * @returns {string}
 */
export function extractLast4Digits(rawAccountOrCard) {
  const digitsOnly = String(rawAccountOrCard || '').replace(/\D+/g, '');
  if (digitsOnly.length < 4) return digitsOnly;
  return digitsOnly.slice(-4);
}

/**
 * Creates a validated Account / Wallet / Savings Goal / Debt entity.
 * @param {object} input
 */
export function createAccount({
  id = generateId('acc'),
  name,
  type = ACCOUNT_TYPES.BANK,
  institution = '',
  accountNumber = '',
  currency = 'USD',
  initialBalance = 0,
  targetAmount = 0,
  includeInTotal = true,
  color = '#10b981',
  icon = 'wallet',
}) {
  const cleanName = String(name || '').trim();
  if (!cleanName) {
    throw new Error('El nombre de la cuenta es obligatorio.');
  }

  return {
    id,
    name: cleanName.slice(0, 48),
    type,
    institution: String(institution || '').trim().slice(0, 80),
    accountNumber: String(accountNumber || '').trim().slice(0, 34),
    currency: CURRENCIES[currency] ? currency : 'USD',
    initialBalance: Money.fromCents(Money.toCents(initialBalance)),
    targetAmount: Money.fromCents(Money.toCents(targetAmount)),
    includeInTotal: Boolean(includeInTotal),
    color: String(color || '#10b981'),
    icon: String(icon || 'wallet'),
  };
}

/**
 * Creates or updates a validated Category entity.
 * @param {object} input
 */
export function createCategory({
  id = generateId('cat'),
  name,
  type = TRANSACTION_TYPES.EXPENSE,
  color = '#10b981',
  icon = 'cart',
  defaultBudget = 0,
}) {
  const cleanName = String(name || '').trim();
  if (!cleanName) {
    throw new Error('El nombre de la categoría es obligatorio.');
  }
  const validType = type === TRANSACTION_TYPES.INCOME ? TRANSACTION_TYPES.INCOME : TRANSACTION_TYPES.EXPENSE;
  const cleanBudget = validType === TRANSACTION_TYPES.EXPENSE
    ? Math.max(0, Money.fromCents(Money.toCents(defaultBudget)))
    : 0;

  return {
    id,
    name: cleanName.slice(0, 40),
    type: validType,
    color: String(color || '#10b981'),
    icon: String(icon || 'cart'),
    defaultBudget: cleanBudget,
  };
}

