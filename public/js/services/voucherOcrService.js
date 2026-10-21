/**
 * @fileoverview Open-Source Machine Learning Voucher & PDF Invoice Decoder Service.
 *
 * Architecture (0 Cloud AI Tokens required):
 * 1. Vision Pre-processing Pipeline (Canvas 2D / MediaPipe-inspired adaptive contrast,
 *    luminance grayscale, and unsharp-mask sharpening for shadowed thermal POS receipts).
 * 2. Open-Source Neural OCR & PDF Engine:
 *    - Images (JPG/PNG/WEBP/Camera): Tesseract.js v5 WebAssembly LSTM Neural Network (spa+eng).
 *    - PDFs (Facturas SAR / Estados): Mozilla PDF.js digital text extraction + raster OCR fallback.
 * 3. Deterministic Entity Extractor for Honduran & LATAM POS Vouchers (BAC Credomatic,
 *    Atlántida, Ficohsa, Banpaís, Lafise, Promerica, Davivienda, Facturas SAR):
 *    - Extracts Merchant (Comercio) and maps it to a Category.
 *    - Extracts Card Last 4 Digits / Account Number and links to the matching Account.
 *    - Extracts Date (including POS formats like "OCT 15, 26" and "DD/MM/YYYY").
 *    - Extracts Total Amount, Currency (HNL / USD / etc.), and reconciles MONTO + ISV - DEVOL.ISV.
 */

import { Money, extractLast4Digits } from '../domain/models.js';

/**
 * Dictionary mapping Honduran and regional merchants/keywords to Pisto category IDs.
 */
const MERCHANT_CATEGORY_RULES = Object.freeze([
  {
    categoryId: 'groceries',
    keywords: [
      'price smart', 'pricesmart', 'price shart', 'la colonia', 'supermercados la colonia',
      'la colon', 'super paiz', 'walmart', 'paiz', 'maxi despensa', 'despensa familiar',
      'duns', 'el colonial', 'la antorcha', 'supermercado', 'minimarket', 'mercadito',
      'abarroteria', 'carniceria', 'delikatessen', 'mas x menos', 'comisariato', 'bodega',
    ],
  },
  {
    categoryId: 'food',
    keywords: [
      'espresso americano', 'burger king', 'mcdonald', 'pizza hut', 'little caesars',
      'domino', 'kfc', 'kentucky', 'wendy', 'pollo campero', 'popeyes', 'subway',
      'starbucks', 'dunkin', 'cinnabon', 'chili', 'applebee', 'denny', 'ihop', 'taco bell',
      'restaurante', 'palacio real', 'taqueria', 'cafe', 'cafeteria', 'panaderia',
      'reposteria', 'baleadas', 'asados', 'parrillada', 'sushi', 'pizzeria', 'pedidosya',
      'hugo', 'rappi', 'uber eats', 'bigos', 'matambritas', 'la cumbre', 'el patio',
      'coco baleadas', 'pasteleria',
    ],
  },
  {
    categoryId: 'transport',
    keywords: [
      'puma energy', 'puma', 'uno', 'texaco', 'shell', 'chevron', 'gasolinera',
      'estacion de servicio', 'combustible', 'fuel', 'uber', 'indriver', 'didi', 'taxi',
      'peaje', 'covi', 'parqueo', 'estacionamiento', 'taller', 'llantas', 'autopartes',
      'repuestos', 'avianca', 'copa airlines', 'spirit', 'american airlines', 'united',
      'delta', 'palmerola', 'toncontin', 'aeropuerto', 'car wash', 'autolote',
    ],
  },
  {
    categoryId: 'health',
    keywords: [
      'kielsa', 'farmacia siman', 'farmacity', 'farmacia del ahorro', 'punto farma',
      'farmacia', 'drogueria', 'hospital', 'medical center', 'honduras medical', 'cemesa',
      'viera', 'san jorge', 'dimacov', 'laboratorio', 'bueso arias', 'clinica', 'dental',
      'odontologia', 'optica', 'santa lucia', 'platinum gym', 'fitne', 'gym', 'smart fit',
      'crossfit', 'gimnasio', 'medico', 'salud', 'sala de belleza', 'beauty supply', 'salon',
    ],
  },
  {
    categoryId: 'utilities',
    keywords: [
      'enee', 'eeh', 'sanaa', 'aguas de san pedro', 'aguas de choloma', 'tigo', 'claro',
      'hondutel', 'cable color', 'igo', 'starlink', 'internet', 'energia', 'electricidad',
      'agua potable', 'telecomunicaciones',
    ],
  },
  {
    categoryId: 'shopping',
    keywords: [
      'diunsa', 'siman', 'almacenes el titan', 'el titan', 'carrion', 'mendels', 'lady lee',
      'larach', 'acosa', 'novacentro', 'cemaco', 'ferreteria', 'indufoam', 'jetstereo',
      'radioshack', 'elektra', 'monge', 'gallo mas gallo', 'la curacao', 'tropigas',
      'zara', 'bershka', 'pull&bear', 'stradivarius', 'nike', 'adidas', 'payless',
      'amazon', 'shein', 'temu', 'aliexpress', 'tutis', 'bazar canton', 'bazar',
      'tiendas ariel', 'multiplaza', 'cascadas mall', 'city mall', 'metromall',
    ],
  },
  {
    categoryId: 'entertainment',
    keywords: [
      'cinemark', 'metrocinemas', 'cinepolis', 'cine', 'netflix', 'spotify', 'disneyplus',
      'disney', 'hbo', 'max', 'prime video', 'youtube', 'playstation', 'xbox', 'steam',
      'nintendo', 'eticket', 'boleto', 'concierto', 'hotel', 'airbnb', 'booking', 'resort',
    ],
  },
  {
    categoryId: 'education',
    keywords: [
      'unah', 'matriculas', 'unitec', 'ceutec', 'uth', 'unicah', 'ujcv', 'zamorano', 'upnfm',
      'universidad', 'colegio', 'escuela', 'instituto', 'libreria', 'pacasa',
      'metromedia', 'udemy', 'coursera', 'platzi',
    ],
  },
  {
    categoryId: 'housing',
    keywords: [
      'alquiler', 'renta', 'condominio', 'mantenimiento residencial', 'hipoteca',
    ],
  },
  {
    categoryId: 'family',
    keywords: [
      'veterinaria', 'mascotas', 'pet shop', 'agropecuaria', 'lavanderia', 'dryclean',
    ],
  },
]);

/**
 * Known POS header/footer boilerplate and Mobile Banking UI / Status Bar patterns
 * that should NOT be mistaken for the Merchant / Concept name.
 */
const POS_BOILERPLATE_PATTERNS = [
  /^BAC\s*CREDOMATIC$/i,
  /^CREDOMATIC$/i,
  /^BAC$/i,
  /^BANCO\s+(ATL[AÁ]NTIDA|FICOHSA|DE\s+OCCIDENTE|DAVIVIENDA|LAFISE|PROMERICA|AZTECA|POPULAR|DEL\s+PA[IÍ]S|GENERAL)/i,
  /^ATL[AÁ]NTIDA$/i,
  /^BANPA[IÍ]S$/i,
  /^FICOHSA$/i,
  /^SW\s*[:.]/i,
  /^REV\s*[:.]/i,
  /^VENTAS?$/i,
  /^GRACIAS\s+POR\s+PREFERIRNOS/i,
  /^CAJERO\s*[:.]/i,
  /^COMPRA$/i,
  /^AUTO\s*[:.]/i,
  /^FACT\s*[:.]/i,
  /^REF\s*[:.]/i,
  /^FECHA\s*[:.]/i,
  /^MONTO\s*[:.]/i,
  /^SUB\s*TOTAL/i,
  /^ISV\s*[:.]/i,
  /^DEVOL\.?\s*ISV/i,
  /^PROPINA/i,
  /^TOTAL/i,
  /^VALIDO\s+SIN\s+FIRMA/i,
  /^COPIA\s+(DE\s+)?(CLIENTE|COMERCIO)/i,
  /^MASTERCARD$/i,
  /^VISA$/i,
  /^AMERICAN\s+EXPRESS$/i,
  /^AID\s*[:.]/i,
  /^ARQC\s*[:.]/i,
  /^TC\s*[:.]/i,
  /^TERMINAL\s*[:.]/i,
  /^LOTE\s*[:.]/i,
  /^AFILIACION/i,
  /^RTN\s*[:.]/i,
  /^CAI\s*[:.]/i,
  // Mobile Status Bar (clock 5:30, 4G/5G/LTE/WiFi, battery %) & Navigation UI buttons
  /^\s*\d{1,2}:\d{2}(?:\s*(?:AM|PM|a\.?\s*m\.?|p\.?\s*m\.?))?(?:\s+(?:4G|5G|LTE|WiFi|VoLTE|\d{1,3}%|[•|📶🔋⚡]))*\s*$/i,
  /^(?:4G|5G|LTE|WIFI|VOLTE|\d{1,3}%)$/i,
  /^(?:[<>←→✕×]\s*)?(?:DETALLE\s+DE\s+CUENTA|DETALLE\s+DE\s+MOVIMIENTOS|MOVIMIENTOS|[UÚ]LTIMOS\s+MOVIMIENTOS|ESTADO\s+DE\s+CUENTA)$/i,
  /^(?:TRANSFERIR|PAGAR|COMPARTIR|DESCARGAR|RECARGAR|RETIRAR|CONFIGURAR|VER\s+M[AÁ]S|ATR[AÁ]S|VOLVER|INICIO|MEN[UÚ])$/i,
  /^(?:TRANSFERIR\s+PAGAR|PAGAR\s+TRANSFERIR)$/i,
  /^(?:SALDO\s+DISPONIBLE|SALDO\s+ACTUAL|SALDO\s+TOTAL|SALDO\s+EN\s+LIBROS|N[UÚ]MERO\s+DE\s+CUENTA|TIPO\s+DE\s+CUENTA|ESTADO|ACTIVA|INACTIVA|MONEDA|CR[EÉ]DITO|D[EÉ]BITO|DESCRIPCI[OÓ]N|CONCEPTO)$/i,
  /^[\d\s*#X•·.,:/-]+$/,
];

const MONTH_NAME_MAP = Object.freeze({
  JAN: '01', ENE: '01', ENERO: '01',
  FEB: '02', FEBRERO: '02',
  MAR: '03', MARZO: '03',
  APR: '04', ABR: '04', ABRIL: '04',
  MAY: '05', MAYO: '05',
  JUN: '06', JUNIO: '06',
  JUL: '07', JULIO: '07',
  AUG: '08', AGO: '08', AGOSTO: '08',
  SEP: '09', SEPT: '09', SET: '09', SEPTIEMBRE: '09',
  OCT: '10', '0CT': '10', OCTUBRE: '10',
  NOV: '11', NOVIEMBRE: '11',
  DEC: '12', DIC: '12', DICIEMBRE: '12',
});

/**
 * Normalizes strings for accent-insensitive comparison.
 * @param {string} str
 * @returns {string}
 */
function normalizeText(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Corrects common OCR digit confusions in 4-digit card suffixes or numbers (e.g. O -> 0, I/l -> 1, S -> 5).
 * @param {string} token
 * @returns {string}
 */
function normalizeOcrDigits(token) {
  return String(token || '')
    .replace(/[OoQq]/g, '0')
    .replace(/[Il|!]/g, '1')
    .replace(/[Zz]/g, '2')
    .replace(/[Ss]/g, '5')
    .replace(/[Bb]/g, '8');
}

/**
 * Helper function that sanitizes monetary amounts from OCR / Vision strings (`cleanAmount`).
 * Cleans thousand-separator commas (`,`) BEFORE converting to FLOAT (`parseFloat`).
 * Example: "3,901.33" -> remove commas -> "3901.33" -> parseFloat("3901.33") -> 3901.33
 *
 * @param {string|number} rawNum
 * @returns {number}
 */
export function cleanAmount(rawNum) {
  if (typeof rawNum === 'number') {
    return Number.isFinite(rawNum) ? Money.fromCents(Money.toCents(rawNum)) : 0;
  }
  if (rawNum === null || rawNum === undefined) return 0;

  let cleaned = String(rawNum)
    .trim()
    // Strip currency prefix ("HNL", "USD", "LPS", "US$", "L", "$") without touching numeric digits
    .replace(/^(?:HNL|USD|LPS|US\$|EUR|CRC|MXN|[LlI|$€₡])\s*\.?\s*/i, '')
    // Collapse OCR spaces around commas and decimal dots ("3, 901. 33" -> "3,901.33")
    .replace(/\s*([,.])\s*/g, '$1')
    .replace(/\s+/g, '');

  if (!cleaned) return 0;

  if (cleaned.includes(',') && cleaned.includes('.')) {
    if (cleaned.lastIndexOf(',') < cleaned.lastIndexOf('.')) {
      // Standard thousand-separator commas: "3,901.33" -> "3901.33"
      cleaned = cleaned.replace(/,/g, '');
    } else {
      // European format: "3.901,33" -> "3901.33"
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    }
  } else if (/^-?\d{1,3}(?:,\d{3})+$/.test(cleaned)) {
    // Integer with thousand commas: "3,901" -> "3901"
    cleaned = cleaned.replace(/,/g, '');
  } else if (/^-?\d+,\d{2}$/.test(cleaned)) {
    // Decimal comma without thousand separator: "200,00" -> "200.00"
    cleaned = cleaned.replace(',', '.');
  } else {
    // Remove any remaining commas BEFORE parseFloat
    cleaned = cleaned.replace(/,/g, '');
  }

  cleaned = cleaned.replace(/[^0-9.-]/g, '');
  const val = Number.parseFloat(cleaned);
  return Number.isFinite(val) ? Money.fromCents(Money.toCents(val)) : 0;
}

/**
 * Strips mobile UI chrome (status bar clock `5:30`, battery/WiFi icons, navigation buttons "Transferir" / "Pagar")
 * from a line of OCR text.
 * @param {string} line
 * @returns {string}
 */
export function stripMobileUiChromeFromLine(line) {
  return String(line || '')
    .replace(/[|_~`^]/g, ' ')
    // Strip status bar time prefix e.g. "5:30 " or "05:30 4G 85% "
    .replace(/^\s*\d{1,2}:\d{2}(?:\s*(?:AM|PM|a\.?\s*m\.?|p\.?\s*m\.?))?(?:\s+(?:4G|5G|LTE|WiFi|VoLTE|\d{1,3}%))*\s*/i, '')
    // Strip trailing currency/amount if attached to a transaction concept line
    .replace(/\s+(?:HNL|USD|LPS|L\.?|\$)\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})\s*$/i, '')
    // Strip navigation action button pairs
    .replace(/\b(?:Transferir|Pagar)\s+(?:Pagar|Transferir)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extracts the Merchant (Comercio) or Banking Concept from raw OCR voucher / mobile screenshot lines.
 * Ignores mobile status bar elements (clock `5:30`, WiFi/battery icons, navigation buttons "Transferir" / "Pagar")
 * and prioritizes transaction concepts (e.g. "DEPOSITO DE AHORRO CON T/D") or account descriptions
 * (e.g. "CUENTA DE AHORRO SOS").
 *
 * @param {string[]} lines
 * @returns {string}
 */
export function extractMerchantFromLines(lines) {
  const cleanLines = lines
    .map((l) => stripMobileUiChromeFromLine(l))
    .filter((l) => l.length >= 3 && !isBoilerplateLine(l));

  // 1. Explicit label pattern: "COMERCIO: XYZ" or "CONCEPTO: XYZ" or "DESCRIPCIÓN: XYZ"
  for (const line of cleanLines) {
    const labelMatch = line.match(
      /^(?:COMERCIO|ESTABLECIMIENTO|NEGOCIO|TIENDA|RAZON\s+SOCIAL|CONCEPTO|DESCRIPCI[OÓ]N)\s*[:.]\s*(.+)$/i
    );
    if (labelMatch && labelMatch[1].trim().length >= 3 && !isBoilerplateLine(labelMatch[1])) {
      return cleanMerchantTypos(labelMatch[1].trim());
    }
  }

  // 2. Mobile Banking Transaction Description (e.g., "DEPOSITO DE AHORRO CON T/D", "TRANSFERENCIA ACH", "RETIRO ATM")
  for (const line of cleanLines) {
    if (
      /\b(?:DEP[OÓ]SITO\s+DE\s+AHORRO|DEP[OÓ]SITO|TRANSFERENCIA\s+(?:ACH|ENTRE|A\s+TERCEROS|RECIBIDA|ENVIADA)|NOTA\s+DE\s+(?:CR[EÉ]DITO|D[EÉ]BITO)|RETIRO\s+(?:ATM|CAJERO|VENTANILLA)|ABONO\s+A\s+CUENTA|PAGO\s+DE\s+SERVICIO)/i.test(
        line
      )
    ) {
      return cleanMerchantTypos(line);
    }
  }

  // 3. Mobile Banking Account Description (e.g., "CUENTA DE AHORRO SOS", "CUENTA DE AHORRO", "CUENTA CHEQUES")
  for (const line of cleanLines) {
    if (/\b(?:CUENTA\s+DE\s+AHORRO|CUENTA\s+CORRIENTE|CUENTA\s+CHEQUES|AHORRO\s+SOS)\b/i.test(line)) {
      return cleanMerchantTypos(line);
    }
  }

  // 4. Line immediately following "VENTAS" or "SW: ..." (Standard BAC Credomatic / POS layout in Honduras)
  const rawTrimmedLines = lines
    .map((l) => l.replace(/[|_~`^]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((l) => l.length >= 3);
  for (let i = 0; i < rawTrimmedLines.length - 1; i += 1) {
    if (/^VENTAS?$/i.test(rawTrimmedLines[i])) {
      const candidate = stripMobileUiChromeFromLine(rawTrimmedLines[i + 1]);
      if (candidate && !isBoilerplateLine(candidate)) {
        return cleanMerchantTypos(candidate);
      }
    }
  }

  // 5. Line immediately preceding "GRACIAS POR PREFERIRNOS"
  for (let i = 1; i < rawTrimmedLines.length; i += 1) {
    if (/GRACIAS\s+POR\s+PREFERIRNOS/i.test(rawTrimmedLines[i])) {
      const candidate = stripMobileUiChromeFromLine(rawTrimmedLines[i - 1]);
      if (candidate && !isBoilerplateLine(candidate)) {
        return cleanMerchantTypos(candidate);
      }
    }
  }

  // 6. First known merchant in any line (from MERCHANT_CATEGORY_RULES)
  for (const line of cleanLines) {
    const norm = normalizeText(line);
    for (const rule of MERCHANT_CATEGORY_RULES) {
      for (const kw of rule.keywords) {
        if (norm.includes(kw)) {
          return cleanMerchantTypos(line);
        }
      }
    }
  }

  // 7. Fallback: first non-boilerplate line in top half with letters
  const topHalf = cleanLines.slice(0, Math.min(12, cleanLines.length));
  for (const line of topHalf) {
    if (!isBoilerplateLine(line) && /[A-Za-zÁÉÍÓÚÑ]{3,}/.test(line)) {
      return cleanMerchantTypos(line);
    }
  }

  return 'Comercio en Voucher';
}

function isBoilerplateLine(line) {
  const trimmed = String(line || '').trim();
  if (trimmed.length < 3) return true;
  return POS_BOILERPLATE_PATTERNS.some((rx) => rx.test(trimmed));
}

function cleanMerchantTypos(merchant) {
  return String(merchant || '')
    .replace(/PRICE\s*SHART/gi, 'PRICE SMART')
    .replace(/PRICESHART/gi, 'PRICE SMART')
    .replace(/\bTE6\b/gi, 'TEG')
    .replace(/^[^A-Za-z0-9ÁÉÍÓÚÑ]+|[^A-Za-z0-9ÁÉÍÓÚÑ)]+$/g, '')
    .trim()
    .slice(0, 60);
}

/**
 * Detects whether the OCR / Vision text corresponds to an Income (`"income"`) or Expense (`"expense"`)
 * in the Honduras banking context.
 * If a movement has the label "Crédito" or "Depósito" (e.g. "DEPOSITO DE AHORRO CON T/D L 200.00"),
 * it is automatically classified as `type: "income"`.
 *
 * @param {string} rawText
 * @param {string} [merchantOrConcept='']
 * @returns {'income' | 'expense'}
 */
export function detectVoucherTransactionType(rawText, merchantOrConcept = '') {
  const combined = `${String(merchantOrConcept || '')}\n${String(rawText || '')}`;
  const isPosReceipt =
    /\b(?:VENTAS?|GRACIAS\s+POR\s+PREFERIRNOS|DEVOL\.?\s*ISV|PROPINA|COPIA\s+DE\s+CLIENTE)\b/i.test(
      combined
    );
  if (isPosReceipt) {
    return 'expense';
  }

  if (
    /\b(?:DEP[OÓ]SITO\s+DE\s+AHORRO|DEP[OÓ]SITO|CR[EÉ]DITO|ABONO\s+A\s+CUENTA|NOTA\s+DE\s+CR[EÉ]DITO|INTERESES\s+GANADOS|TRANSFERENCIA\s+RECIBIDA)\b/i.test(
      combined
    ) &&
    !/\bTARJETA\s+DE\s+CR[EÉ]DITO\b/i.test(combined)
  ) {
    return 'income';
  }

  return 'expense';
}

/**
 * Infers the best Category ID based on the extracted Merchant/Concept, full text, and transaction type.
 * @param {string} merchant
 * @param {string} rawText
 * @param {Array<{id: string, name: string, type: string}>} [categories]
 * @param {'income' | 'expense'} [txType='expense']
 * @returns {{ categoryId: string, confidence: string }}
 */
export function inferCategoryFromMerchant(
  merchant,
  rawText = '',
  categories = [],
  txType = 'expense'
) {
  const combinedNorm = `${normalizeText(merchant)} ${normalizeText(rawText)}`;
  const merchantNorm = normalizeText(merchant);

  if (txType === 'income') {
    if (/\b(?:salario|planilla|nomina|sueldo)\b/i.test(combinedNorm)) {
      return { categoryId: 'salary', confidence: 'high' };
    }
    if (/\b(?:interes|rendimiento|inversion|dividendo)\b/i.test(combinedNorm)) {
      return { categoryId: 'investments', confidence: 'high' };
    }
    if (/\b(?:freelance|honorarios|consultoria)\b/i.test(combinedNorm)) {
      return { categoryId: 'freelance', confidence: 'high' };
    }
    const incomeCat = categories.find((c) => c.type === 'income');
    return { categoryId: incomeCat ? incomeCat.id : 'salary', confidence: 'high' };
  }

  // 1. Check merchant name first for high precision
  for (const rule of MERCHANT_CATEGORY_RULES) {
    for (const kw of rule.keywords) {
      if (merchantNorm.includes(kw)) {
        return { categoryId: rule.categoryId, confidence: 'high' };
      }
    }
  }

  // 2. Check custom user categories by name
  for (const cat of categories) {
    if (cat.type === 'expense') {
      const catNorm = normalizeText(cat.name);
      if (catNorm.length >= 3 && (merchantNorm.includes(catNorm) || combinedNorm.includes(catNorm))) {
        return { categoryId: cat.id, confidence: 'high' };
      }
    }
  }

  // 3. Check full receipt text against merchant rules
  for (const rule of MERCHANT_CATEGORY_RULES) {
    for (const kw of rule.keywords) {
      if (combinedNorm.includes(kw)) {
        return { categoryId: rule.categoryId, confidence: 'medium' };
      }
    }
  }

  return { categoryId: 'shopping', confidence: 'fallback' };
}

/**
 * Extracts the Account Number or Card Last 4 Digits and Bank Info from a voucher or mobile banking screenshot:
 * - For Bank Accounts (Ahorro, Cheques, SOS, etc.): extracts and stores the FULL ACCOUNT NUMBER (e.g. "213130058771").
 * - Reserves the "last 4 digits" rule ONLY when a Credit / Debit Card is explicitly detected (e.g. "**** **** **** 0618").
 *
 * @param {string} rawText
 * @returns {{
 *   cardLast4: string,
 *   accountNumber: string,
 *   isCard: boolean,
 *   currencySuffix: string | null,
 *   detectedBank: string | null
 * }}
 */
export function extractCardAndBankInfo(rawText) {
  const text = String(rawText || '');
  let cardLast4 = '';
  let accountNumber = '';
  let isCard = false;
  let currencySuffix = null;

  // 1. Check for FULL Bank Account Number (Ahorro, Cheques, SOS, Número de cuenta, etc., e.g. "213130058771")
  const bankAccLabelMatch = text.match(
    /(?:CUENTA\s+DE\s+AHORRO(?:\s+SOS)?|CUENTA\s+CHEQUES|CUENTA\s+CORRIENTE|AHORRO\s+SOS|N[UÚ]MERO\s+DE\s+CUENTA|NRO\.?\s*DE\s*CUENTA|CUENTA\s*[:#]?)[^\d*X\n]{0,40}?(\d{6,22})\b/i
  );
  if (bankAccLabelMatch) {
    accountNumber = bankAccLabelMatch[1].trim();
    cardLast4 = accountNumber;
    isCard = false;
  } else {
    // Also check standalone line with 10-20 unmasked digits (typical mobile banking account detail header)
    const standaloneAccMatch = text.match(/(?:^|\n)\s*(\d{10,20})\s*(?:\n|$)/);
    if (standaloneAccMatch) {
      accountNumber = standaloneAccMatch[1].trim();
      cardLast4 = accountNumber;
      isCard = false;
    }
  }

  // 2. Only apply the "last 4 digits" rule if no full bank account was found AND a Credit/Debit card is explicitly detected
  if (!accountNumber) {
    // Pattern 2A: Masked asterisks/X followed by 4 digits (e.g. "**** **** **** 0618" or "************0618-L")
    const maskedMatch = text.match(
      /[*X#•·~+.-]{3,}(?:\s*[*X#•·~+.-]{3,})*\s*([0-9OIlSB]{4})\s*(?:-\s*([A-Z1l]))?/i
    );
    if (maskedMatch) {
      const candidate = normalizeOcrDigits(maskedMatch[1]);
      if (/^\d{4}$/.test(candidate)) {
        cardLast4 = candidate;
        accountNumber = candidate;
        isCard = true;
        currencySuffix = maskedMatch[2] ? maskedMatch[2].toUpperCase() : null;
      }
    }

    // Pattern 2B: Explicit 4 digits with -L or -D suffix (BAC Credomatic Honduras POS format: "0618-L")
    if (!cardLast4) {
      const suffixMatch = text.match(/\b([0-9OIlSB]{4})\s*-\s*([LD$])\b/i);
      if (suffixMatch) {
        const candidate = normalizeOcrDigits(suffixMatch[1]);
        if (/^\d{4}$/.test(candidate)) {
          cardLast4 = candidate;
          accountNumber = candidate;
          isCard = true;
          currencySuffix = suffixMatch[2].toUpperCase();
        }
      }
    }

    // Pattern 2C: Explicit Card keyword (CREDOMATIC / TARJETA / CARD / VISA / MASTERCARD / AMEX) + 4 digits
    if (!cardLast4) {
      const cardLineMatch = text.match(
        /(?:CREDOMATIC|TARJETA|CARD|VISA|MASTERCARD|AMEX)[^\n]{0,30}?([0-9OIlSB]{4})(?:\s*-\s*([A-Z]))?(?:\s|$)/i
      );
      if (cardLineMatch) {
        const candidate = normalizeOcrDigits(cardLineMatch[1]);
        if (/^\d{4}$/.test(candidate)) {
          cardLast4 = candidate;
          accountNumber = candidate;
          isCard = true;
          currencySuffix = cardLineMatch[2] ? cardLineMatch[2].toUpperCase() : null;
        }
      }
    }
  }

  // Detect Bank / Processor mentioned on the voucher or screenshot
  let detectedBank = null;
  if (/\b(?:BAC|CREDOMATIC)\b/i.test(text)) detectedBank = 'BAC Credomatic Honduras';
  else if (/\bATL[AÁ]NTIDA\b/i.test(text)) detectedBank = 'Banco Atlántida';
  else if (/\bFICOHSA\b/i.test(text)) detectedBank = 'Banco Ficohsa';
  else if (/\b(?:BANPA[IÍ]S|BANCO\s+DEL\s+PA[IÍ]S)\b/i.test(text)) detectedBank = 'Banpaís (Banco del País)';
  else if (/\bOCCIDENTE\b/i.test(text)) detectedBank = 'Banco de Occidente';
  else if (/\bDAVIVIENDA\b/i.test(text)) detectedBank = 'Banco Davivienda Honduras';
  else if (/\bLAFISE\b/i.test(text)) detectedBank = 'Banco Lafise Honduras';
  else if (/\bPROMERICA\b/i.test(text)) detectedBank = 'Banco Promerica Honduras';
  else if (/\bBANRURAL\b/i.test(text)) detectedBank = 'Banrural Honduras';
  else if (/\bAZTECA\b/i.test(text)) detectedBank = 'Banco Azteca Honduras';
  else if (/\bCUENTA\s+DE\s+AHORRO\s+SOS\b/i.test(text)) detectedBank = 'Banco Atlántida';

  return { cardLast4, accountNumber, isCard, currencySuffix, detectedBank };
}

/**
 * Associates the extracted accountNumber / cardLast4 and detectedBank with the user's accounts.
 * @param {Array<object>} accounts
 * @param {string} accountOrCardDigits
 * @param {string|null} detectedBank
 * @returns {{ accountId: string, matchType: 'account_number' | 'institution' | 'fallback', matchedAccount: object | null }}
 */
export function matchAccountForVoucher(accounts = [], accountOrCardDigits = '', detectedBank = null) {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return { accountId: 'acc_bank', matchType: 'fallback', matchedAccount: null };
  }

  const cleanInputDigits = String(accountOrCardDigits || '').replace(/\D+/g, '');

  // 1A. Exact full account number match first
  if (cleanInputDigits.length >= 6) {
    const byFullAccount = accounts.find((acc) => {
      const accDigits = String(acc.accountNumber || '').replace(/\D+/g, '');
      return accDigits && accDigits === cleanInputDigits;
    });
    if (byFullAccount) {
      return {
        accountId: byFullAccount.id,
        matchType: 'account_number',
        matchedAccount: byFullAccount,
      };
    }
  }

  // 1B. Match by last 4 digits on account.accountNumber or account.name
  if (cleanInputDigits.length >= 4) {
    const targetLast4 = cleanInputDigits.slice(-4);
    const byDigits = accounts.find((acc) => {
      const accLast4 = extractLast4Digits(acc.accountNumber);
      if (accLast4 && accLast4 === targetLast4) return true;
      const nameDigits = extractLast4Digits(acc.name);
      return nameDigits && nameDigits === targetLast4;
    });
    if (byDigits) {
      return { accountId: byDigits.id, matchType: 'account_number', matchedAccount: byDigits };
    }
  }

  // 2. Match by Financial Institution (Entidad Bancaria) or Bank Name
  if (detectedBank) {
    const bankNorm = normalizeText(detectedBank);
    const byBank = accounts.find((acc) => {
      const instNorm = normalizeText(acc.institution);
      const nameNorm = normalizeText(acc.name);
      return (
        (instNorm && (instNorm.includes(bankNorm) || bankNorm.includes(instNorm))) ||
        (nameNorm && (nameNorm.includes('bac') && bankNorm.includes('bac'))) ||
        (nameNorm && (nameNorm.includes('atlantida') && bankNorm.includes('atlantida'))) ||
        (nameNorm && instNorm && nameNorm.includes(instNorm))
      );
    });
    if (byBank) {
      return { accountId: byBank.id, matchType: 'institution', matchedAccount: byBank };
    }
  }

  // 3. Fallback to first card or bank account
  const cardOrBank = accounts.find((a) => a.type === 'card' || a.type === 'bank') || accounts[0];
  return { accountId: cardOrBank.id, matchType: 'fallback', matchedAccount: cardOrBank };
}

/**
 * Extracts and normalizes the voucher date to ISO YYYY-MM-DD.
 * Supports:
 * - "FECHA: OCT 15, 26 - 11:55" -> "2026-10-15"
 * - "15/10/2026" or "15-10-26" -> "2026-10-15"
 * - "2026-10-15" -> "2026-10-15"
 * @param {string} rawText
 * @returns {string}
 */
export function extractVoucherDate(rawText) {
  const text = String(rawText || '').toUpperCase();

  // 1. Month Name + Day + Year (e.g., "FECHA: OCT 15, 26" or "OCT 15, 2026" or "0CT 15. 26")
  const monthFirstRegex = /\b([A-Z0]{3,10})\s+([0-9OIl]{1,2})\s*[,./-]\s*([0-9OIl]{2,4})\b/g;
  let match;
  while ((match = monthFirstRegex.exec(text)) !== null) {
    const monthCode = MONTH_NAME_MAP[match[1]] || MONTH_NAME_MAP[match[1].replace(/0/g, 'O')];
    if (monthCode) {
      const dayNum = Number.parseInt(normalizeOcrDigits(match[2]), 10);
      let yearStr = normalizeOcrDigits(match[3]);
      if (yearStr.length === 2) yearStr = `20${yearStr}`;
      const yearNum = Number.parseInt(yearStr, 10);
      if (dayNum >= 1 && dayNum <= 31 && yearNum >= 2000 && yearNum <= 2100) {
        return `${yearNum}-${monthCode}-${String(dayNum).padStart(2, '0')}`;
      }
    }
  }

  // 2. Day + Month Name + Year (e.g., "15 OCT 2026" or "15 DE OCTUBRE DE 2026")
  const dayFirstMonthNameRegex = /\b([0-9OIl]{1,2})\s*(?:DE\s+|[/.-])?([A-Z0]{3,10})\s*(?:DE\s+|[,./-])?\s*([0-9OIl]{2,4})\b/g;
  while ((match = dayFirstMonthNameRegex.exec(text)) !== null) {
    const monthCode = MONTH_NAME_MAP[match[2]] || MONTH_NAME_MAP[match[2].replace(/0/g, 'O')];
    if (monthCode) {
      const dayNum = Number.parseInt(normalizeOcrDigits(match[1]), 10);
      let yearStr = normalizeOcrDigits(match[3]);
      if (yearStr.length === 2) yearStr = `20${yearStr}`;
      const yearNum = Number.parseInt(yearStr, 10);
      if (dayNum >= 1 && dayNum <= 31 && yearNum >= 2000 && yearNum <= 2100) {
        return `${yearNum}-${monthCode}-${String(dayNum).padStart(2, '0')}`;
      }
    }
  }

  // 3. ISO YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = text.match(/\b(20\d{2})[/-](0[1-9]|1[0-2])[/-](0[1-9]|[12]\d|3[01])\b/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  // 4. Latin American DD/MM/YYYY or DD-MM-YY
  const dmyMatch = text.match(/\b(0?[1-9]|[12]\d|3[01])[/-](0?[1-9]|1[0-2])[/-](\d{2,4})\b/);
  if (dmyMatch) {
    const d = String(dmyMatch[1]).padStart(2, '0');
    const m = String(dmyMatch[2]).padStart(2, '0');
    const y = dmyMatch[3].length === 2 ? `20${dmyMatch[3]}` : dmyMatch[3];
    return `${y}-${m}-${d}`;
  }

  return new Date().toISOString().slice(0, 10);
}

/**
 * Parses a numeric amount string from OCR text using `cleanAmount`
 * (cleaning thousand-separator commas `,` BEFORE `parseFloat`).
 * @param {string|number} rawNum
 * @returns {number}
 */
function parseOcrNumber(rawNum) {
  return cleanAmount(rawNum);
}

/**
 * Extracts Amount, Subtotal/Tax breakdown, and Currency from voucher or mobile banking text.
 * - Cleans thousand-separator commas `,` BEFORE `parseFloat` (e.g. "3,901.33" -> 3901.33).
 * - Maps "L" or "Lempiras" to `HNL`, and "$" or "USD"/"Dólares" to `USD`.
 * - Includes mathematical cross-check (MONTO + ISV - DEVOL.ISV = TOTAL) for POS receipts.
 *
 * @param {string} rawText
 * @param {string|null} currencySuffix
 * @returns {{ amount: number, currentBalance: number, currency: string, breakdown: { subtotal: number, isv: number, devolIsv: number } }}
 */
export function extractAmountAndCurrency(rawText, currencySuffix = null) {
  const text = String(rawText || '');

  // Detect currency (Honduras Context: "L" / "Lempiras" -> HNL, "$" / "USD" / "Dólares" -> USD)
  let currency = 'USD';
  const hasHnlIndicators =
    currencySuffix === 'L' ||
    /\b(?:HNL|LPS|LEMPIRAS?|ISV|DEVOL\.?\s*ISV|TEG|TEGUCIGALPA|SPS|HONDURAS|ATL[AÁ]NTIDA|FICOHSA|BANPA[IÍ]S)\b/i.test(
      text
    ) ||
    /(?:^|\n|\s|[+-])L\.?\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})\b/im.test(text) ||
    /(?:TOTAL|MONTO|ISV|SALDO)\s*[:.]?\s*-?\s*L\.?\s*\d/i.test(text);

  const hasExplicitUsdIndicators =
    currencySuffix === 'D' ||
    currencySuffix === '$' ||
    /\b(?:USD|US\$|D[OÓ]LAR(?:ES)?)\b/i.test(text) ||
    /(?:^|\n|\s|[+-])\$\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})\b/im.test(text);

  if (hasHnlIndicators && !/\b(?:USD|US\$|D[OÓ]LAR(?:ES)?)\b/i.test(text)) {
    currency = 'HNL';
  } else if (hasExplicitUsdIndicators) {
    currency = 'USD';
  } else if (/\bEUR\b|€/i.test(text)) {
    currency = 'EUR';
  } else if (/\bCRC\b|₡/i.test(text)) {
    currency = 'CRC';
  } else if (/\bMXN\b/i.test(text)) {
    currency = 'MXN';
  }

  const amountPattern = '(\\d{1,3}(?:,\\d{3})+\\.\\d{2}|\\d{1,9}[.,]\\d{2})';

  // Extract MONTO (Subtotal), ISV, DEVOL.ISV, and TOTAL
  const montoMatch = text.match(
    new RegExp(`\\bMONTO\\s*[:.]?\\s*(?:HNL|LPS|USD|L\\.?|\\$)?\\s*${amountPattern}`, 'i')
  );
  const isvMatch = text.match(
    new RegExp(`(?:^|\\n|\\s)ISV\\s*[:.]?\\s*(?:HNL|LPS|USD|L\\.?|\\$)?\\s*${amountPattern}`, 'i')
  );
  const devolMatch = text.match(
    new RegExp(
      `DEVOL\\.?\\s*ISV\\s*[:.]?\\s*-?\\s*(?:HNL|LPS|USD|L\\.?|\\$)?\\s*-?\\s*${amountPattern}`,
      'i'
    )
  );
  const totalMatches = [
    ...text.matchAll(
      new RegExp(
        `\\bTOTAL\\s*(?:A\\s*PAGAR|PAGADO|GENERAL)?\\s*[:.]?\\s*(?:HNL|LPS|USD|US\\$|L\\.?|\\$)?\\s*${amountPattern}`,
        'gi'
      )
    ),
  ];

  let subtotal = montoMatch ? cleanAmount(montoMatch[1]) : 0;
  let isv = isvMatch ? cleanAmount(isvMatch[1]) : 0;
  let devolIsv = devolMatch ? cleanAmount(devolMatch[1]) : 0;
  let rawTotal =
    totalMatches.length > 0 ? cleanAmount(totalMatches[totalMatches.length - 1][1]) : 0;

  // Helper to strip a false leading "1" caused by OCR reading "L252.29" as "1252.29" on POS receipts
  const stripLeadingOne = (num) => {
    const str = num.toFixed(2);
    if (str.length >= 6 && str.startsWith('1')) {
      return Number.parseFloat(str.slice(1));
    }
    return num;
  };

  // Reconcile subtotal + isv - devolIsv against rawTotal
  if (subtotal > 0 && isv >= 0) {
    const candidatesSub = [subtotal, stripLeadingOne(subtotal)];
    const candidatesIsv = [isv, stripLeadingOne(isv)];
    const candidatesDevol = [devolIsv, stripLeadingOne(devolIsv)];
    const candidatesTotal = rawTotal > 0 ? [rawTotal, stripLeadingOne(rawTotal)] : [];

    let matchedReconciliation = null;
    for (const s of candidatesSub) {
      for (const tax of candidatesIsv) {
        for (const dev of candidatesDevol) {
          const expected = Money.fromCents(
            Money.toCents(s) + Money.toCents(tax) - Money.toCents(dev)
          );
          const expectedNoDev = Money.fromCents(Money.toCents(s) + Money.toCents(tax));
          for (const tot of candidatesTotal) {
            if (Math.abs(tot - expected) <= 0.05) {
              matchedReconciliation = { subtotal: s, isv: tax, devolIsv: dev, total: tot };
              break;
            }
            if (Math.abs(tot - expectedNoDev) <= 0.05) {
              matchedReconciliation = { subtotal: s, isv: tax, devolIsv: 0, total: tot };
              break;
            }
          }
        }
      }
    }

    if (matchedReconciliation) {
      subtotal = matchedReconciliation.subtotal;
      isv = matchedReconciliation.isv;
      devolIsv = matchedReconciliation.devolIsv;
      rawTotal = matchedReconciliation.total;
    } else if (rawTotal === 0) {
      rawTotal = Money.fromCents(
        Money.toCents(subtotal) + Money.toCents(isv) - Money.toCents(devolIsv)
      );
    }
  }

  // Fallback: match decimal amounts WITH thousand-separator commas intact before calling cleanAmount
  // e.g. "3,901.33" -> cleanAmount("3,901.33") -> 3901.33 (never clipping the "3,"!)
  const allDecimals = [
    ...text.matchAll(
      /(?:L\.?|\$|HNL|USD|LPS)?\s*(\d{1,3}(?:,\d{3})+\.\d{2}|\d{1,9}[.,]\d{2})\b/gi
    ),
  ]
    .map((m) => cleanAmount(m[1]))
    .filter((n) => n > 0 && n < 100000000);

  const currentBalance = allDecimals.length > 0 ? Math.max(...allDecimals) : rawTotal;
  if (rawTotal <= 0 && allDecimals.length > 0) {
    rawTotal = Math.max(...allDecimals);
  }

  return {
    amount: rawTotal,
    currentBalance,
    currency,
    breakdown: {
      subtotal,
      isv,
      devolIsv,
    },
  };
}

/**
 * Full deterministic parser that converts raw OCR / PDF text from a voucher or mobile banking screenshot
 * into a structured transaction/account proposal linked to the user's categories and accounts.
 *
 * @param {string} rawText
 * @param {object} state
 * @returns {object}
 */
export function parseVoucherText(rawText, state = {}) {
  const lines = String(rawText || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const merchant = extractMerchantFromLines(lines);
  const type = detectVoucherTransactionType(rawText, merchant);
  const { categoryId, confidence: categoryConfidence } = inferCategoryFromMerchant(
    merchant,
    rawText,
    state.categories || [],
    type
  );

  const { cardLast4, accountNumber, isCard, currencySuffix, detectedBank } =
    extractCardAndBankInfo(rawText);
  const resolvedAccountOrCard = accountNumber || cardLast4;
  const accountMatch = matchAccountForVoucher(
    state.accounts || [],
    resolvedAccountOrCard,
    detectedBank
  );
  const date = extractVoucherDate(rawText);
  const { amount, currentBalance, currency, breakdown } = extractAmountAndCurrency(
    rawText,
    currencySuffix
  );

  // Extract optional Factura / Autorización reference numbers for the transaction note
  const factMatch = rawText.match(/\bFACT(?:URA)?\s*[:.#]?\s*(\d{3,12})\b/i);
  const autoMatch = rawText.match(/\bAUTO(?:RIZACION)?\s*[:.#]?\s*(\d{4,10})\b/i);
  const refParts = [merchant];
  if (resolvedAccountOrCard) {
    refParts.push(isCard ? `Tarjeta *${resolvedAccountOrCard}` : `Cuenta #${resolvedAccountOrCard}`);
  }
  if (factMatch) refParts.push(`Fact #${factMatch[1]}`);
  else if (autoMatch) refParts.push(`Auto #${autoMatch[1]}`);

  return {
    merchant,
    type,
    categoryId,
    categoryConfidence,
    date,
    amount,
    currentBalance,
    currency,
    cardLast4: resolvedAccountOrCard,
    accountNumber: resolvedAccountOrCard,
    isCard,
    detectedBank,
    accountId: accountMatch.accountId,
    accountMatchType: accountMatch.matchType,
    matchedAccountName: accountMatch.matchedAccount?.name || '',
    breakdown,
    note: refParts.join(' · ').slice(0, 140),
    rawText: String(rawText || '').trim(),
  };
}

/**
 * Pre-processes a voucher image on an HTML5 <canvas> using computer vision filters:
 * - Resizes to optimal OCR resolution (max 1600px)
 * - Converts to luminance grayscale
 * - Applies percentile contrast stretching to remove uneven camera shadows on thermal paper
 *
 * @param {Blob|File|HTMLImageElement} imageSource
 * @returns {Promise<{ processedDataUrl: string, originalDataUrl: string, width: number, height: number }>}
 */
export async function preprocessVoucherImage(imageSource) {
  const img = await loadImageElement(imageSource);
  const maxDim = 1600;
  let width = img.naturalWidth || img.width;
  let height = img.naturalHeight || img.height;

  if (width > maxDim || height > maxDim) {
    const scale = maxDim / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  } else if (width < 800 && height < 800) {
    // Upscale small images for better LSTM glyph recognition
    const scale = Math.min(2, 1200 / Math.max(width, height));
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  const origCanvas = document.createElement('canvas');
  origCanvas.width = width;
  origCanvas.height = height;
  const origCtx = origCanvas.getContext('2d', { willReadFrequently: true });
  origCtx.drawImage(img, 0, 0, width, height);
  const originalDataUrl = origCanvas.toDataURL('image/jpeg', 0.92);

  // Computer Vision Grayscale + Adaptive Contrast Stretching
  const procCanvas = document.createElement('canvas');
  procCanvas.width = width;
  procCanvas.height = height;
  const procCtx = procCanvas.getContext('2d', { willReadFrequently: true });
  procCtx.drawImage(img, 0, 0, width, height);

  const imgData = procCtx.getImageData(0, 0, width, height);
  const data = imgData.data;
  const lumHist = new Uint32Array(256);

  for (let i = 0; i < data.length; i += 4) {
    const lum = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    data[i] = lum;
    data[i + 1] = lum;
    data[i + 2] = lum;
    lumHist[lum] += 1;
  }

  const totalPixels = width * height;
  let lowBound = 0;
  let highBound = 255;
  let acc = 0;
  for (let i = 0; i < 256; i += 1) {
    acc += lumHist[i];
    if (acc >= totalPixels * 0.04) {
      lowBound = i;
      break;
    }
  }
  acc = 0;
  for (let i = 255; i >= 0; i -= 1) {
    acc += lumHist[i];
    if (acc >= totalPixels * 0.08) {
      highBound = i;
      break;
    }
  }

  const range = Math.max(20, highBound - lowBound);
  for (let i = 0; i < data.length; i += 4) {
    const normalized = ((data[i] - lowBound) / range) * 255;
    // Slight gamma boost to whiten thermal receipt background while keeping dark ink sharp
    const boosted = normalized > 185 ? Math.min(255, normalized * 1.12) : Math.max(0, normalized * 0.85);
    const val = Math.round(Math.max(0, Math.min(255, boosted)));
    data[i] = val;
    data[i + 1] = val;
    data[i + 2] = val;
  }

  procCtx.putImageData(imgData, 0, 0);
  const processedDataUrl = procCanvas.toDataURL('image/png');

  return {
    processedDataUrl,
    originalDataUrl,
    width,
    height,
  };
}

function loadImageElement(source) {
  return new Promise((resolve, reject) => {
    if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) {
      resolve(source);
      return;
    }
    const url = URL.createObjectURL(source);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('No se pudo cargar la imagen del voucher.'));
    };
    img.src = url;
  });
}

/**
 * Extracts text from a PDF file using Mozilla PDF.js (digital text layer first, raster OCR fallback).
 * @param {File} pdfFile
 * @param {(status: string, pct: number) => void} [onProgress]
 * @returns {Promise<{ text: string, previewDataUrl: string }>}
 */
async function extractFromPdfFile(pdfFile, onProgress) {
  onProgress?.('Cargando motor Open-Source PDF.js...', 15);
  const pdfjsLib = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/+esm');
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs';

  const arrayBuffer = await pdfFile.arrayBuffer();
  const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const page = await pdfDoc.getPage(1);

  onProgress?.('Renderizando vista previa del documento PDF...', 35);
  const viewport = page.getViewport({ scale: 2.0 });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
  const previewDataUrl = canvas.toDataURL('image/png');

  // 1. Extract digital text layer
  onProgress?.('Extrayendo capa de texto digital del PDF...', 55);
  const textContent = await page.getTextContent();
  const digitalText = textContent.items.map((item) => item.str).join('\n');

  if (digitalText.replace(/\s+/g, '').length >= 20) {
    onProgress?.('Texto digital extraído con éxito (0 tokens).', 100);
    return { text: digitalText, previewDataUrl, processedDataUrl: previewDataUrl };
  }

  // 2. Fallback to WASM OCR if the PDF is a scanned image
  onProgress?.('PDF escaneado detectado: ejecutando red neuronal OCR...', 65);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const ocrRes = await runTesseractOcr(blob, onProgress);
  return {
    text: ocrRes.text,
    previewDataUrl,
    processedDataUrl: ocrRes.processedDataUrl,
  };
}

/**
 * Runs Tesseract.js v5 (WASM LSTM Neural Network) on an image file/blob.
 * Performs dual-pass recognition (enhanced vision canvas + original image) for maximum recall
 * on shadowed thermal POS receipts.
 *
 * @param {File|Blob} imageFile
 * @param {(status: string, pct: number) => void} [onProgress]
 * @returns {Promise<{ text: string, originalDataUrl: string, processedDataUrl: string }>}
 */
async function runTesseractOcr(imageFile, onProgress) {
  onProgress?.('Preprocesando imagen con filtros de Visión (Contraste adaptativo)...', 15);
  const { processedDataUrl, originalDataUrl } = await preprocessVoucherImage(imageFile);

  onProgress?.('Inicializando red neuronal Open-Source OCR (Tesseract WASM)...', 30);
  const TesseractModule = await import('https://cdn.jsdelivr.net/npm/tesseract.js@5/+esm');
  const Tesseract = TesseractModule.default || TesseractModule;

  const worker = await Tesseract.createWorker('spa+eng', 1, {
    logger: (m) => {
      if (m.status === 'recognizing text' && typeof m.progress === 'number') {
        const pct = Math.min(92, Math.round(35 + m.progress * 55));
        onProgress?.(`Decodificando voucher con ML OCR (${Math.round(m.progress * 100)}%)...`, pct);
      }
    },
  });

  try {
    const pass1 = await worker.recognize(processedDataUrl);
    const text1 = pass1?.data?.text || '';

    // Also run a fast pass on original image and merge lines so neither shadow nor threshold clips any digits
    onProgress?.('Verificando dígitos de tarjeta y montos (2ª pasada)...', 93);
    const pass2 = await worker.recognize(originalDataUrl);
    const text2 = pass2?.data?.text || '';

    const combinedText = `${text1}\n${text2}`.trim();
    onProgress?.('Voucher decodificado con éxito.', 100);

    return {
      text: combinedText,
      originalDataUrl,
      processedDataUrl,
    };
  } finally {
    await worker.terminate();
  }
}

/**
 * Main entry point: takes an Image or PDF file of a voucher/invoice, runs the Open-Source
 * ML OCR / PDF pipeline, and returns the decoded fields ready for transaction creation.
 *
 * @param {File} file
 * @param {object} state
 * @param {(status: string, pct: number) => void} [onProgress]
 * @returns {Promise<object>}
 */
export async function decodeVoucherFile(file, state, onProgress) {
  if (!file) {
    throw new Error('Seleccione una imagen o archivo PDF de factura/voucher.');
  }

  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
  let extraction;

  if (isPdf) {
    extraction = await extractFromPdfFile(file, onProgress);
  } else {
    extraction = await runTesseractOcr(file, onProgress);
  }

  const parsed = parseVoucherText(extraction.text, state);
  return {
    ...parsed,
    originalDataUrl: extraction.originalDataUrl || extraction.previewDataUrl,
    processedDataUrl: extraction.processedDataUrl || extraction.previewDataUrl,
  };
}

/**
 * Checks whether a statement transaction row matches an existing voucher/transaction in history
 * for the given account (by exact Date + Amount, or Near-Date ±2 days + Amount).
 *
 * @param {{ date: string, amount: number, currency: string, concept: string }} row
 * @param {Array<object>} existingTransactions
 * @param {string} targetAccountId
 * @returns {{ isDuplicate: boolean, duplicateType: 'exact' | 'near_date' | null, matchedTransaction: object | null, duplicateReason: string }}
 */
export function findDuplicateTransaction(row, existingTransactions = [], targetAccountId = '') {
  const rowCents = Money.toCents(row.amount);
  if (rowCents <= 0 || !Array.isArray(existingTransactions)) {
    return {
      isDuplicate: false,
      duplicateType: null,
      matchType: null,
      matchedTransaction: null,
      duplicateTx: null,
      duplicateReason: '',
    };
  }

  // 1. Exact Match: Same Account + Same Date + Same Amount
  const exactMatch = existingTransactions.find((tx) => {
    const sameAccount = !targetAccountId || tx.accountId === targetAccountId;
    const sameAmount = Math.abs(Money.toCents(tx.amount) - rowCents) === 0;
    const sameDate = tx.date === row.date;
    return sameAccount && sameAmount && sameDate;
  });

  if (exactMatch) {
    return {
      isDuplicate: true,
      duplicateType: 'exact',
      matchType: 'exact',
      matchedTransaction: exactMatch,
      duplicateTx: exactMatch,
      duplicateReason: `Voucher ya registrado el ${exactMatch.date} por ${Money.format(exactMatch.amount, exactMatch.currency)} (${exactMatch.note || 'mismo monto y fecha'})`,
    };
  }

  // 2. Near-Date Match (±2 days): POS voucher date vs bank posting date with exact same amount & account
  const rowTime = Date.parse(`${row.date}T00:00:00Z`);
  if (Number.isFinite(rowTime)) {
    const nearMatch = existingTransactions.find((tx) => {
      const sameAccount = !targetAccountId || tx.accountId === targetAccountId;
      const sameAmount = Math.abs(Money.toCents(tx.amount) - rowCents) === 0;
      if (!sameAccount || !sameAmount) return false;
      const txTime = Date.parse(`${tx.date}T00:00:00Z`);
      if (!Number.isFinite(txTime)) return false;
      const diffDays = Math.abs(Math.round((rowTime - txTime) / (1000 * 60 * 60 * 24)));
      return diffDays > 0 && diffDays <= 2;
    });

    if (nearMatch) {
      return {
        isDuplicate: true,
        duplicateType: 'near_date',
        matchType: 'near_date',
        matchedTransaction: nearMatch,
        duplicateTx: nearMatch,
        duplicateReason: `Posible duplicado (±2 días): voucher del ${nearMatch.date} por ${Money.format(nearMatch.amount, nearMatch.currency)} (${nearMatch.note || 'mismo monto'})`,
      };
    }
  }

  return {
    isDuplicate: false,
    duplicateType: null,
    matchType: null,
    matchedTransaction: null,
    duplicateTx: null,
    duplicateReason: '',
  };
}

/**
 * Cleans up a raw bank statement concept string for human readability.
 * Example: "TAQUERIA HIDALGO\ TEGUCIGALPA\ HND" -> "TAQUERIA HIDALGO"
 * @param {string} rawConcept
 * @returns {string}
 */
function cleanStatementConcept(rawConcept) {
  return String(rawConcept || '')
    .replace(/\\\s*(?:TEGUCIGALPA|DISTRITO\s*CEN\w*|SAN\s*PEDRO\s*SULA|HND|IRL|BURBANK)[^\\]*/gi, '')
    .replace(/3DSTegucigalpa\\\s*HND/gi, '')
    .replace(/Tegucigalpa\\\s*HND/gi, '')
    .replace(/\b\d{2}:\d{2}\b/g, '')
    .replace(/\\/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 75);
}

/**
 * Parses a statement row date token (such as "SEP/01", "SEP/O1", "15/09/2026", "2026-09-15") into ISO YYYY-MM-DD.
 * @param {string} dateToken
 * @param {number} defaultYear
 * @returns {string|null}
 */
function parseStatementRowDate(dateToken, defaultYear) {
  const token = String(dateToken || '')
    .trim()
    .toUpperCase()
    .replace(/\s*([/.-])\s*/g, '$1');

  const cleanDigits = (str) =>
    String(str || '')
      .replace(/O/g, '0')
      .replace(/[IL|]/g, '1')
      .replace(/S/g, '5')
      .replace(/B/g, '8');

  // Format 1: MMM/DD or MMM-DD (e.g., "SEP/01", "OCT/15", "SEP/O1")
  const mmmFirst = token.match(/^([A-Z0]{3})[/.-]([0-9OILS]{1,2})(?:[/.-]([0-9OILS]{2,4}))?$/);
  if (mmmFirst) {
    const monthCode =
      MONTH_NAME_MAP[mmmFirst[1]] || MONTH_NAME_MAP[mmmFirst[1].replace(/0/g, 'O')];
    const dayNum = Number.parseInt(cleanDigits(mmmFirst[2]), 10);
    if (monthCode && dayNum >= 1 && dayNum <= 31) {
      const day = String(dayNum).padStart(2, '0');
      let year = defaultYear;
      if (mmmFirst[3]) {
        const yClean = cleanDigits(mmmFirst[3]);
        year = yClean.length === 2 ? Number.parseInt(`20${yClean}`, 10) : Number.parseInt(yClean, 10);
      }
      return `${year}-${monthCode}-${day}`;
    }
  }

  // Format 2: DD/MMM or DD-MMM-YY (e.g., "01/SEP", "15/OCT/26")
  const dayFirstMmm = token.match(/^([0-9OILS]{1,2})[/.-]([A-Z0]{3})(?:[/.-]([0-9OILS]{2,4}))?$/);
  if (dayFirstMmm) {
    const monthCode =
      MONTH_NAME_MAP[dayFirstMmm[2]] || MONTH_NAME_MAP[dayFirstMmm[2].replace(/0/g, 'O')];
    const dayNum = Number.parseInt(cleanDigits(dayFirstMmm[1]), 10);
    if (monthCode && dayNum >= 1 && dayNum <= 31) {
      const day = String(dayNum).padStart(2, '0');
      let year = defaultYear;
      if (dayFirstMmm[3]) {
        const yClean = cleanDigits(dayFirstMmm[3]);
        year = yClean.length === 2 ? Number.parseInt(`20${yClean}`, 10) : Number.parseInt(yClean, 10);
      }
      return `${year}-${monthCode}-${day}`;
    }
  }

  // Format 3: DD/MM/YYYY or DD/MM/YY
  const dmy = token.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (dmy) {
    const dayNum = Number.parseInt(dmy[1], 10);
    const monthNum = Number.parseInt(dmy[2], 10);
    if (monthNum >= 1 && monthNum <= 12 && dayNum >= 1 && dayNum <= 31) {
      const day = String(dayNum).padStart(2, '0');
      const month = String(monthNum).padStart(2, '0');
      const year = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
      return `${year}-${month}-${day}`;
    }
  }

  // Format 4: YYYY-MM-DD
  const iso = token.match(/^(20\d{2})[/.-](\d{2})[/.-](\d{2})$/);
  if (iso) {
    return `${iso[1]}-${iso[2]}-${iso[3]}`;
  }

  return null;
}

/**
 * Normalizes a raw statement line so split dates ("SEP / 01"), split amounts ("$ 11.49"),
 * or dual-column zero amounts ("325.98 0.00" / "0.00 11.49") parse cleanly.
 * @param {string} rawLine
 * @returns {string}
 */
function normalizeStatementLine(rawLine) {
  let s = String(rawLine || '')
    .replace(/\s+/g, ' ')
    .trim();

  // Collapse spaces around slash in MMM / DD dates (e.g. "SEP / 01" -> "SEP/01")
  s = s.replace(
    /\b(ENE|FEB|MAR|ABR|APR|MAY|JUN|JUL|AGO|AUG|SEP|SET|OCT|0CT|NOV|N0V|DIC|DEC)\s*[/.-]\s*([0-9OILS]{1,2})\b/gi,
    '$1/$2'
  );

  // Collapse spaces around slashes in DD / MMM / YYYY or DD / MM / YYYY dates (e.g. "10 / SEP / 2026" -> "10/SEP/2026")
  s = s.replace(
    /^(\d{1,2})\s*[/.-]\s*([A-Z0-9]{2,3})(?:\s*[/.-]\s*(\d{2,4}))?\b/i,
    (_, d, m, y) => (y ? `${d}/${m}/${y}` : `${d}/${m}`)
  );

  // Collapse space after $ or L currency symbol before digits ("$ 11.49" -> "$11.49")
  s = s.replace(/(\$)\s+(\d)/g, '$1$2');

  // If line has two columns at the end where the second column (USD) is 0.00 (e.g., "325.98 0.00" or "325.98 $0.00")
  s = s.replace(
    /(\d{1,3}(?:,\d{3})*\.\d{2})\s+(?:\[USD\]\s*)?\$?0\.00$/i,
    '$1'
  );

  // If line has 0.00 in the first column (HNL) and a non-zero amount in the second column (USD)
  s = s.replace(
    /\b(?:L\s*)?0\.00\s+(?:\[USD\]\s*)?\$?(\d{1,3}(?:,\d{3})*\.\d{2})$/i,
    '$$$1'
  );

  return s;
}

/**
 * Parses a multi-line Bank / Credit Card Statement text (e.g. BAC Credomatic Honduras PDF statement)
 * into structured transaction items with automatic currency separation (Lempiras vs Dólares),
 * category assignment, and duplicate detection against existing vouchers in state.transactions.
 *
 * @param {string} rawText
 * @param {object} state
 * @param {{ accountId?: string, targetAccountId?: string, statementYear?: number, fallbackYear?: number }} [options]
 * @returns {{
 *   rawText: string,
 *   items: Array<object>,
 *   accountId: string,
 *   targetAccountId: string,
 *   detectedBank: string | null,
 *   cardLast4: string,
 *   totalHnl: number,
 *   totalUsd: number,
 *   duplicatesCount: number,
 *   newCount: number
 * }}
 */
export function parseBankStatementText(rawText, state = {}, options = {}) {
  const text = String(rawText || '');
  const lines = text
    .split(/\r?\n/)
    .map((l) => normalizeStatementLine(l))
    .filter(Boolean);

  // Detect default statement year from options or header if present, otherwise current year
  const yearMatch = text.match(/\b(202[4-9]|203\d)\b/);
  const defaultYear =
    options.fallbackYear ||
    options.statementYear ||
    (yearMatch ? Number.parseInt(yearMatch[1], 10) : new Date().getFullYear());

  // Detect bank & card digits from statement header
  const { cardLast4, detectedBank } = extractCardAndBankInfo(text);
  const accountMatch = matchAccountForVoucher(state.accounts || [], cardLast4, detectedBank);
  const targetAccountId = options.targetAccountId || options.accountId || accountMatch.accountId;

  // Detect if statement defaults to HNL (Lempiras)
  const isHondurasStatement =
    /\b(?:LEMPIRAS|HND|TEGUCIGALPA|HONDURAS|BAC\s*CREDOMATIC|ATLANTIDA|FICOHSA|BANPAIS|LAFISE|PROMERICA|HNL)\b/i.test(text);
  const defaultStatementCurrency = isHondurasStatement ? 'HNL' : (state.settings?.baseCurrency || 'USD');

  const rowRegex = new RegExp(
    '^' +
      // Optional Reference Number (e.g., "11 0901101124149005" or "25 0913101002510000" or OCR-spaced digits)
      '(?:([0-9][0-9\\s-]{3,26}?)\\s+)?' +
      // Date Token (e.g., "SEP/01", "SEP/O1", "15/09/2026", "2026-09-15")
      '([A-Z0]{3}[/.-][0-9OILS]{1,2}(?:[/.-][0-9OILS]{2,4})?|[0-9OILS]{1,2}[/.-][A-Z0]{3}(?:[/.-][0-9OILS]{2,4})?|\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}|20\\d{2}[/.-]\\d{2}[/.-]\\d{2})\\s+' +
      // Concept / Merchant description
      '(.+?)\\s+' +
      // Currency marker & Amount at end of row (e.g., "325.98", "1,004.41", "$11.49", "[USD] 11.49", "L 860.00")
      '(\\[USD\\]|\\[HNL\\]|US\\$|USD|HNL|LPS|\\$|L)?\\s*([+-]?\\d{1,3}(?:,\\d{3})*\\.\\d{2}|[+-]?\\d+\\.\\d{2})(?:\\s*(CR|DB|-))?$',
    'i'
  );

  const items = [];
  let totalHnl = 0;
  let totalUsd = 0;
  let duplicatesCount = 0;
  let newCount = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // Skip summary / installment plan table headers or payment credit lines
    if (
      /^(?:No\.\s*de\s*referencia|Producto\s+Monto\s+Otorgado|SEGUROS\s+CREFISA\s+EXT|SALDO\s+ANTERIOR|PAGO\s+MINIMO|PAGO\s+DE\s+CONTADO)/i.test(
        line
      )
    ) {
      continue;
    }

    const match = line.match(rowRegex);
    if (!match) continue;

    const referenceNumber = (match[1] || '').trim();
    const rawDateToken = match[2];
    const rawConcept = match[3].trim();
    const currencyPrefix = (match[4] || '').toUpperCase();
    const rawAmountStr = match[5];
    const creditDebitSuffix = (match[6] || '').toUpperCase();

    // Skip payment credits ("SU PAGO GRACIAS", "PAGO EN LINEA", or CR suffix)
    if (
      creditDebitSuffix === 'CR' ||
      /\b(?:SU\s+PAGO|PAGO\s+RECIBIDO|ABONO\s+A\s+CUENTA|GRACIAS\s+POR\s+SU\s+PAGO)\b/i.test(
        rawConcept
      )
    ) {
      continue;
    }

    const isoDate = parseStatementRowDate(rawDateToken, defaultYear);
    if (!isoDate) continue;

    const amount = Math.abs(parseOcrNumber(rawAmountStr));
    if (amount <= 0) continue;

    // Determine row currency (USD if explicitly marked with $, USD, US$, or [USD] column coordinate tag)
    let currency = defaultStatementCurrency;
    if (
      currencyPrefix === '$' ||
      currencyPrefix === 'USD' ||
      currencyPrefix === 'US$' ||
      currencyPrefix === '[USD]'
    ) {
      currency = 'USD';
    } else if (
      currencyPrefix === 'L' ||
      currencyPrefix === 'HNL' ||
      currencyPrefix === 'LPS' ||
      currencyPrefix === '[HNL]'
    ) {
      currency = 'HNL';
    }

    const cleanConcept = cleanStatementConcept(rawConcept);
    const { categoryId } = inferCategoryFromMerchant(
      cleanConcept,
      rawConcept,
      state.categories || []
    );

    const dupCheck = findDuplicateTransaction(
      { date: isoDate, amount, currency, concept: cleanConcept },
      state.transactions || [],
      targetAccountId
    );

    if (currency === 'USD') {
      totalUsd = Money.add(totalUsd, amount);
    } else {
      totalHnl = Money.add(totalHnl, amount);
    }

    if (dupCheck.isDuplicate) {
      duplicatesCount += 1;
    } else {
      newCount += 1;
    }

    items.push({
      id: `stmt_row_${i}_${Date.now().toString(36)}`,
      reference: referenceNumber,
      referenceNumber,
      rawDate: rawDateToken,
      date: isoDate,
      rawConcept,
      concept: cleanConcept || rawConcept,
      categoryId,
      amount,
      currency,
      isDuplicate: dupCheck.isDuplicate,
      duplicateType: dupCheck.duplicateType,
      duplicateReason: dupCheck.duplicateReason,
      duplicateTx: dupCheck.matchedTransaction,
      matchedTransactionId: dupCheck.matchedTransaction?.id || null,
      selected: !dupCheck.isDuplicate, // Pre-uncheck duplicates by default (UI/UX Best Practice)
    });
  }

  return {
    rawText: text,
    items,
    accountId: targetAccountId,
    targetAccountId,
    detectedBank,
    cardLast4,
    totalHnl,
    totalUsd,
    duplicatesCount,
    newCount,
  };
}

/**
 * Extracts multi-page Bank Statement rows from a PDF file (or image screenshot) using Mozilla PDF.js
 * with coordinate-aware column detection (distinguishing the "Lempiras" and "Dólares" columns)
 * and automatic multi-page Tesseract.js WASM OCR fallback for scanned PDFs or image screenshots.
 *
 * @param {File} pdfFile
 * @param {object} state
 * @param {{ accountId?: string, targetAccountId?: string, statementYear?: number, fallbackYear?: number }} [options]
 * @param {(status: string, pct: number) => void} [onProgress]
 * @returns {Promise<object>}
 */
export async function decodeBankStatementPdf(pdfFile, state = {}, options = {}, onProgress) {
  if (!pdfFile) {
    throw new Error('Seleccione un archivo PDF o imagen de estado de cuenta.');
  }

  const isPdf =
    pdfFile.type === 'application/pdf' || pdfFile.name?.toLowerCase().endsWith('.pdf');

  // If the user uploaded an image screenshot of a bank statement, run vision preprocessing + OCR
  if (!isPdf) {
    onProgress?.('Preprocesando captura de Estado de Cuenta para OCR...', 20);
    const ocrRes = await runTesseractOcr(pdfFile, onProgress);
    onProgress?.('Conciliando movimientos contra vouchers registrados...', 95);
    const result = parseBankStatementText(ocrRes.text, state, options);
    onProgress?.('Estado de cuenta procesado con éxito.', 100);
    return result;
  }

  onProgress?.('Cargando motor Open-Source PDF.js para Estado de Cuenta...', 10);
  const pdfjsLib = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/+esm');
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.mjs';

  const arrayBuffer = await pdfFile.arrayBuffer();
  const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const totalPages = pdfDoc.numPages;
  const reconstructedLines = [];

  for (let pageNum = 1; pageNum <= totalPages; pageNum += 1) {
    const pct = Math.round(15 + (pageNum / totalPages) * 55);
    onProgress?.(`Analizando página ${pageNum} de ${totalPages} del Estado de Cuenta...`, pct);

    const page = await pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const rawItems = textContent.items || [];

    // Detect X coordinates of "Lempiras" and "Dólares" column headers on this page if present
    let lempirasX = null;
    let dolaresX = null;
    for (const item of rawItems) {
      const s = String(item.str || '').trim();
      if (/^Lempiras$/i.test(s) && item.transform) lempirasX = item.transform[4];
      if (/^D[oó]lares$/i.test(s) && item.transform) dolaresX = item.transform[4];
    }
    const usdColMinX =
      lempirasX !== null && dolaresX !== null && dolaresX > lempirasX
        ? (lempirasX + dolaresX) / 2
        : 495;

    // Group text items into horizontal rows by Y coordinate (within 4.5pt tolerance)
    const rowsByY = [];
    for (const item of rawItems) {
      const str = String(item.str || '');
      if (!str.trim() || !item.transform) continue;
      const x = item.transform[4];
      const y = item.transform[5];
      const width = item.width || str.length * 4.5;

      let targetRow = rowsByY.find((r) => Math.abs(r.y - y) <= 4.5);
      if (!targetRow) {
        targetRow = { y, cells: [] };
        rowsByY.push(targetRow);
      }
      targetRow.cells.push({ x, width, str: str.trim() });
    }

    // Sort rows top-to-bottom (descending Y in PDF coordinate space)
    rowsByY.sort((a, b) => b.y - a.y);

    for (const row of rowsByY) {
      row.cells.sort((a, b) => a.x - b.x);
      const lastCell = row.cells[row.cells.length - 1];
      if (
        lastCell &&
        lastCell.x >= usdColMinX &&
        /^\$?\d{1,3}(?:,\d{3})*\.\d{2}$/.test(lastCell.str) &&
        !lastCell.str.startsWith('$')
      ) {
        lastCell.str = `[USD] ${lastCell.str}`;
      }

      // Join touching fragments without extra space, and column-separated cells with a single space
      let rowStr = '';
      let prevRight = null;
      for (const cell of row.cells) {
        if (prevRight !== null && cell.x - prevRight < 1.8) {
          rowStr += cell.str;
        } else {
          rowStr += (rowStr ? ' ' : '') + cell.str;
        }
        prevRight = cell.x + (cell.width || 0);
      }
      reconstructedLines.push(rowStr);
    }
  }

  let fullText = reconstructedLines.join('\n');
  let result = parseBankStatementText(fullText, state, options);

  // Fallback to multi-page OCR if the PDF is a scanned image or embedded raster with no text rows
  if (result.items.length === 0) {
    const ocrTexts = [];
    const maxOcrPages = Math.min(totalPages, 6);
    for (let pageNum = 1; pageNum <= maxOcrPages; pageNum += 1) {
      const pct = Math.round(72 + (pageNum / maxOcrPages) * 22);
      onProgress?.(`PDF escaneado: ejecutando OCR en página ${pageNum} de ${maxOcrPages}...`, pct);
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 2.2 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      const pageBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      const ocrRes = await runTesseractOcr(pageBlob);
      if (ocrRes?.text) {
        ocrTexts.push(ocrRes.text);
      }
    }
    fullText = ocrTexts.join('\n');
    result = parseBankStatementText(fullText, state, options);
  }

  onProgress?.('Cruzando movimientos con historial de vouchers para evitar duplicados...', 96);
  onProgress?.('Estado de cuenta procesado con éxito.', 100);
  return result;
}

/**
 * Builds the system/user prompt for Gemini Vision (`gemini-1.5-flash`) when analyzing
 * Mobile Banking Screenshots, Account Detail Views, or POS Vouchers.
 *
 * Enforces:
 * 1. Amount Sanitization (`cleanAmount`): Strip thousand-separator commas `,` BEFORE converting to FLOAT
 *    (e.g. "3,901.33" -> "3901.33" -> 3901.33; never clip the leading digit before the comma).
 * 2. Account Number Extraction Rules:
 *    - For Bank Accounts (Ahorro, Cheques, SOS, etc.), extract and store the FULL ACCOUNT NUMBER (e.g. "213130058771").
 *    - Reserve the "last 4 digits" rule ONLY when a Credit / Debit Card is explicitly detected (e.g. "**** **** **** 0618").
 * 3. Currency & Transaction Type Detection (Honduras Context):
 *    - Map symbol "L" or word "Lempiras" to currency `HNL`.
 *    - Map symbol "$" or words "USD" / "Dólares" to currency `USD`.
 *    - If a movement has the label "Crédito" or "Depósito" (e.g. "DEPOSITO DE AHORRO CON T/D L 200.00"),
 *      classify it automatically as an Income transaction (`type: "income"`).
 * 4. UI / Status Bar Filtering (Clean Text):
 *    - Ignore phone status bar elements (clock time `5:30`, battery/WiFi/signal icons) and navigation buttons ("Transferir", "Pagar").
 *    - Take the "Comercio" or "Concepto" from the account description (e.g. "CUENTA DE AHORRO SOS")
 *      or from the bottom transaction description (e.g. "DEPOSITO DE AHORRO CON T/D").
 *
 * @returns {string}
 */
export function buildGeminiVisionPrompt() {
  return [
    'Eres un extractor financiero experto en capturas de pantalla de banca móvil, detalles de cuenta y vouchers POS en Honduras y Latinoamérica.',
    '',
    'REGLAS ESTRICTAS DE EXTRACCIÓN:',
    '1. PARSER DE MONTOS (Sin recortar dígitos antes de la coma):',
    '   - Limpia todos los separadores de miles (comas `,`) ANTES de convertir a número FLOAT.',
    '   - Ejemplo: "L 3,901.33" -> remover comas -> "3901.33" -> 3901.33 (NUNCA recortes el primer dígito dejando "901.33").',
    '2. REGLAS DE EXTRACCIÓN DE NÚMERO DE CUENTA:',
    '   - Para cuentas bancarias (Ahorro, Cheques, SOS, etc.), extrae y almacena el NÚMERO DE CUENTA COMPLETO (ej. "213130058771").',
    '   - Reserva la regla de "últimos 4 dígitos" ÚNICAMENTE si se detecta explícitamente una Tarjeta de Crédito o Débito enmascarada (ej. "**** **** **** 0618" -> "0618").',
    '3. DETECCIÓN DE MONEDA Y TIPO DE TRANSACCIÓN (Contexto Honduras):',
    '   - Mapea el símbolo "L" o la palabra "Lempiras" a la moneda "HNL".',
    '   - Mapea el símbolo "$" o las palabras "USD" / "Dólares" a la moneda "USD".',
    '   - Si en el detalle de la pantalla aparece un movimiento con la etiqueta "Crédito" o "Depósito" (ej. "DEPOSITO DE AHORRO CON T/D L 200.00"), clasifícalo automáticamente como una Transacción de Ingreso (`type: "income"`). Si indica "Débito", "Retiro" o "Compra", clasifícalo como `type: "expense"`.',
    '4. FILTRADO DE UI / BARRA DE ESTADO (Clean Text):',
    '   - Ignora por completo los elementos de la interfaz del teléfono: hora de la barra de estado (ej. "5:30"), iconos de batería/WiFi/señal (4G, 5G, LTE) y botones de navegación ("Transferir", "Pagar", "Compartir", "Detalle de cuenta").',
    '   - El "Comercio" o "Concepto" debe tomarse de la descripción de la cuenta (ej. "CUENTA DE AHORRO SOS") o de la descripción de la transacción inferior (ej. "DEPOSITO DE AHORRO CON T/D").',
  ].join('\n');
}


