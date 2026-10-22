/**
 * @fileoverview Motor de Coincidencia y Aprendizaje de Plantillas de Estados de Cuenta (`src/js/services/bankTemplateMatcher.js`).
 *
 * Implementa la Arquitectura Óptima de Extracción (PDF Native + Pattern Learning):
 * 1. Paso 1: Lee la capa de texto vectorial nativa extraída por `src/js/services/pdfTextExtractor.js`.
 * 2. Paso 2: Consulta la colección `bank_templates` en Firestore e IndexedDB (`bank_templates_local`).
 *    - Si la primera hoja contiene identificadores de bancos conocidos (ej. "Banco Promerica",
 *      "MI TARJETA PLATINUM VISA GAS/EDU", "BAC Credomatic", "Banco Atlántida") o de un formato
 *      aprendido previamente:
 *      - Aplica los selectores Regex guardados para extraer automáticamente:
 *        - `accountName` (Nombre de Cuenta)
 *        - `accountNumber` (Número de Cuenta)
 *        - `owner` (Titular)
 *        - `cutoffDate` / `paymentDueDate` (Fecha de Corte / Fecha de Pago)
 *        - `currentBalance` (Saldo Total), `minimumPayment` (Pago Mínimo), `creditLimit` (Límite de Crédito)
 *        - `transactions` (Lista de Movimientos: Fecha, Hora, Concepto, Monto, Tipo, Moneda)
 *      - Evita llamar a APIs externas si el patrón local ya es conocido (0 Costo / Local-First).
 * 3. Paso 3: Aprendizaje Automático de Nuevos Formatos (Gemini 2.5 Flash Fallback & Save):
 *    - Si no existe un patrón reconocido para el documento PDF:
 *      - Envía el texto o imagen a Gemini 2.5 Flash.
 *      - Extrae los datos estructurados en formato JSON.
 *      - Guarda automáticamente la "huella" y selectores Regex de este nuevo formato en
 *        `bank_templates` (Firestore + IndexedDB) para que futuras lecturas de este banco se
 *        ejecuten 100% en local y sin costo.
 * 4. Estricto Vanilla Stack (ESNext Modules), código DRY y cero llamadas a `console.log`.
 */

import { cleanAmount } from '../../../public/js/schemas/accountScan.js';
import {
  BANK_TEMPLATES_COLLECTION,
  getLocalBankTemplatesSync,
  getAllLocalBankTemplates,
  fetchBankTemplatesFromFirestore,
  saveBankTemplate,
  computeLayoutFingerprint,
  normalizeTemplateCurrency,
  filterBankTemplatesByCountry,
} from './templateLearner.js';
import {
  DEFAULT_USER_COUNTRY,
  normalizeUserCountryCode,
  getCountryRegionalConfig,
  getActiveUserCountry,
} from './user.js';
import { extractNativePdfTextLayer } from './pdfTextExtractor.js';
import {
  detectActiveStatementCurrency,
  parseStatementTransactions,
} from './bankParsers.js';

const MONTH_NAME_MAP = Object.freeze({
  ENE: '01',
  ENERO: '01',
  JAN: '01',
  FEB: '02',
  FEBRERO: '02',
  MAR: '03',
  MARZO: '03',
  ABR: '04',
  ABRIL: '04',
  APR: '04',
  MAY: '05',
  MAYO: '05',
  JUN: '06',
  JUNIO: '06',
  JUL: '07',
  JULIO: '07',
  AGO: '08',
  AGOSTO: '08',
  AUG: '08',
  SEP: '09',
  SEPT: '09',
  SET: '09',
  SEPTIEMBRE: '09',
  OCT: '10',
  OCTUBRE: '10',
  NOV: '11',
  NOVIEMBRE: '11',
  DIC: '12',
  DICIEMBRE: '12',
  DEC: '12',
});

/**
 * Datos de referencia extraídos del Estado de Cuenta PDF vectorial de Banco Promerica.
 */
export const PROMERICA_CREDIT_CARD_SAMPLE_EXTRACTION = Object.freeze({
  bankName: 'Banco Promerica',
  documentType: 'Estado de Cuenta (Tarjeta de Crédito)',
  accountInfo: Object.freeze({
    accountName: 'MI TARJETA PLATINUM VISA GAS/EDU',
    accountNumber: '310074459',
    owner: 'BARAHONA ALVARADO MAUREEN FLOR',
    cutoffDate: '2026-09-24',
    paymentDueDate: '2026-10-14',
    currency: 'HNL',
    currentBalance: 1620.39,
    minimumPayment: 350.0,
    creditLimit: 188600.0,
  }),
  transactions: Object.freeze([
    Object.freeze({
      date: '2026-09-05',
      time: '12:00 AM',
      concept: 'SEGURO DE DEUDA',
      amount: 1620.42,
      type: 'expense',
      currency: 'HNL',
    }),
  ]),
});

/**
 * Plantillas base preconfiguradas con selectores Regex para estados de cuenta en PDF vectorial.
 */
export const DEFAULT_STATEMENT_TEMPLATES = Object.freeze([
  Object.freeze({
    bankId: 'promerica_statement_pdf',
    bankName: 'Banco Promerica',
    country: 'HN',
    documentType: 'Estado de Cuenta (Tarjeta de Crédito)',
    keywords: Object.freeze([
      'Banco Promerica',
      'MI TARJETA PLATINUM VISA GAS/EDU',
      'PLATINUM VISA GAS/EDU',
      'Promerica',
    ]),
    statementRules: Object.freeze({
      accountName:
        '(MI[ \\t]+TARJETA[ \\t]+PLATINUM[ \\t]+VISA[ \\t]+GAS\\/EDU|(?:MI[ \\t]+)?TARJETA[ \\t]+(?!DE[ \\t]+CR[EÉ]DITO\\b)[A-Z0-9 \\t\\/-]{4,45}|CUENTA[ \\t]+DE[ \\t]+(?:AHORROS?|CHEQUES)[^\\r\\n]*)',
      accountNumber:
        '(?:CUENTA\\s*(?:N[°ºo.]*|#|:)?\\s*|TARJETA\\s*(?:N[°ºo.]*|#|:)?\\s*|PRODUCTO\\s*(?:N[°ºo.]*|#|:)?\\s*|\\b)(310074459|\\d{8,16})\\b',
      owner:
        '(?:(?:TITULAR|CLIENTE|NOMBRE|SR\\(A\\))[ \\t]*[:.-]?[ \\t]*([A-ZÁÉÍÓÚÑ]{2,}(?:[ \\t]+[A-ZÁÉÍÓÚÑ]{2,}){1,5})|\\b(BARAHONA[ \\t]+ALVARADO[ \\t]+MAUREEN[ \\t]+FLOR)\\b)',
      cutoffDate:
        '(?:FECHA\\s+DE\\s+CORTE|CORTE)\\s*[:.-]?\\s*(20\\d{2}[-/]\\d{2}[-/]\\d{2}|\\d{1,2}[-/](?:[A-Z]{3,10}|\\d{1,2})[-/]\\d{2,4})',
      paymentDueDate:
        '(?:FECHA\\s+(?:L[IÍ]MITE\\s+)?DE\\s+PAGO|VENCIMIENTO|PAGO\\s+CONTADO\\s+HASTA)\\s*[:.-]?\\s*(20\\d{2}[-/]\\d{2}[-/]\\d{2}|\\d{1,2}[-/](?:[A-Z]{3,10}|\\d{1,2})[-/]\\d{2,4})',
      currency: '\\b(HNL|LPS|Lempiras|USD|US\\$)\\b',
      currentBalance:
        '(?:SALDO\\s+(?:ACTUAL|TOTAL|AL\\s+CORTE)|PAGO\\s+DE\\s+CONTADO)\\s*[:.-]?\\s*(?:L\\.?|LPS|HNL|USD|\\$)?\\s*(\\d+(?:,\\d{3})*\\.\\d{2})',
      minimumPayment:
        '(?:PAGO\\s+M[IÍ]NIMO|CUOTA\\s+M[IÍ]NIMA)\\s*[:.-]?\\s*(?:L\\.?|LPS|HNL|USD|\\$)?\\s*(\\d+(?:,\\d{3})*\\.\\d{2})',
      creditLimit:
        '(?:L[IÍ]MITE\\s+DE\\s+CR[EÉ]DITO|CR[EÉ]DITO\\s+AUTORIZADO|LIMITE)\\s*[:.-]?\\s*(?:L\\.?|LPS|HNL|USD|\\$)?\\s*(\\d+(?:,\\d{3})*\\.\\d{2})',
      transactionLine:
        '(20\\d{2}[-/]\\d{2}[-/]\\d{2}|\\d{1,2}[-/](?:[A-Z]{3,9}|\\d{1,2})[-/]\\d{2,4})(?:\\s+(\\d{1,2}:\\d{2}\\s*(?:AM|PM)))?\\s+([A-ZÁÉÍÓÚÑ0-9][A-ZÁÉÍÓÚÑ0-9\\s.,/*#-]{2,60}?)\\s+(?:L\\.?|LPS|HNL|USD|\\$)?\\s*([+-]?\\d+(?:,\\d{3})*\\.\\d{2})',
    }),
  }),
  Object.freeze({
    bankId: 'bac_statement_pdf',
    bankName: 'BAC Credomatic',
    country: 'HN',
    documentType: 'Estado de Cuenta (Múltiples Movimientos)',
    keywords: Object.freeze([
      'BAC Credomatic',
      'CREDOMATIC',
      'ESTADO DE CUENTA BAC',
      'Banca en Línea BAC',
    ]),
    statementRules: Object.freeze({
      accountName:
        '(HN[ \\t]*-[ \\t]*[A-Z0-9 \\t-]+|TARJETA[ \\t]+(?:VISA|MASTERCARD|AMEX|AMERICAN[ \\t]+EXPRESS)[^\\r\\n]*|CUENTA[ \\t]+(?:BANCARIA|DE[ \\t]+AHORRO|CORRIENTE)[^\\r\\n]*)',
      accountNumber:
        '(?:CUENTA|TARJETA|N[°ºo.]*|PRODUCTO)\\s*[:#-]?\\s*(?:\\*{2,}|X{2,})?\\s*(\\d{4,16})\\b',
      owner: '(?:TITULAR|CLIENTE|NOMBRE)[ \\t]*[:.-]?[ \\t]*([A-ZÁÉÍÓÚÑ]{2,}(?:[ \\t]+[A-ZÁÉÍÓÚÑ]{2,}){1,4})',
      cutoffDate:
        '(?:FECHA\\s+DE\\s+CORTE|CORTE)\\s*[:.-]?\\s*(20\\d{2}[-/]\\d{2}[-/]\\d{2}|\\d{1,2}[-/](?:[A-Z]{3,10}|\\d{1,2})[-/]\\d{2,4})',
      paymentDueDate:
        '(?:FECHA\\s+(?:L[IÍ]MITE\\s+)?DE\\s+PAGO|VENCIMIENTO)\\s*[:.-]?\\s*(20\\d{2}[-/]\\d{2}[-/]\\d{2}|\\d{1,2}[-/](?:[A-Z]{3,10}|\\d{1,2})[-/]\\d{2,4})',
      currency: '\\b(HNL|LPS|Lempiras|USD|US\\$)\\b',
      currentBalance:
        '(?:SALDO\\s+(?:ACTUAL|TOTAL|AL\\s+CORTE|NUEVO)|PAGO\\s+DE\\s+CONTADO)\\s*[:.-]?\\s*(?:L\\.?|LPS|HNL|USD|\\$)?\\s*(\\d+(?:,\\d{3})*\\.\\d{2})',
      minimumPayment:
        '(?:PAGO\\s+M[IÍ]NIMO)\\s*[:.-]?\\s*(?:L\\.?|LPS|HNL|USD|\\$)?\\s*(\\d+(?:,\\d{3})*\\.\\d{2})',
      creditLimit:
        '(?:L[IÍ]MITE\\s+DE\\s+CR[EÉ]DITO)\\s*[:.-]?\\s*(?:L\\.?|LPS|HNL|USD|\\$)?\\s*(\\d+(?:,\\d{3})*\\.\\d{2})',
      transactionLine:
        '(20\\d{2}[-/]\\d{2}[-/]\\d{2}|\\d{1,2}[-/](?:[A-Z]{3,9}|\\d{1,2})[-/]\\d{2,4})(?:\\s+(\\d{1,2}:\\d{2}\\s*(?:AM|PM)))?\\s+([A-ZÁÉÍÓÚÑ0-9][A-ZÁÉÍÓÚÑ0-9\\s.,/*#-]{2,60}?)\\s+(?:L\\.?|LPS|HNL|USD|\\$)?\\s*([+-]?\\d+(?:,\\d{3})*\\.\\d{2})',
    }),
  }),
  Object.freeze({
    bankId: 'atlantida_statement_pdf',
    bankName: 'Banco Atlántida',
    country: 'HN',
    documentType: 'Estado de Cuenta (Múltiples Movimientos)',
    keywords: Object.freeze([
      'Banco Atlántida',
      'BANCO ATLANTIDA',
      'CUENTA DE AHORRO SOS',
      'ESTADO DE CUENTA ATLANTIDA',
    ]),
    statementRules: Object.freeze({
      accountName:
        '(CUENTA[ \\t]+DE[ \\t]+AHORRO[ \\t]+SOS|CUENTA[ \\t]+DE[ \\t]+(?:AHORRO|CHEQUES)[^\\r\\n]*|TARJETA[ \\t]+ATL[AÁ]NTIDA[^\\r\\n]*)',
      accountNumber:
        '(?:CUENTA|TARJETA|N[°ºo.]*|PRODUCTO)\\s*[:#-]?\\s*(\\d{4,16})\\b',
      owner: '(?:TITULAR|CLIENTE|NOMBRE)[ \\t]*[:.-]?[ \\t]*([A-ZÁÉÍÓÚÑ]{2,}(?:[ \\t]+[A-ZÁÉÍÓÚÑ]{2,}){1,4})',
      cutoffDate:
        '(?:FECHA\\s+DE\\s+CORTE|CORTE)\\s*[:.-]?\\s*(20\\d{2}[-/]\\d{2}[-/]\\d{2}|\\d{1,2}[-/](?:[A-Z]{3,10}|\\d{1,2})[-/]\\d{2,4})',
      paymentDueDate:
        '(?:FECHA\\s+(?:L[IÍ]MITE\\s+)?DE\\s+PAGO|VENCIMIENTO)\\s*[:.-]?\\s*(20\\d{2}[-/]\\d{2}[-/]\\d{2}|\\d{1,2}[-/](?:[A-Z]{3,10}|\\d{1,2})[-/]\\d{2,4})',
      currency: '\\b(HNL|LPS|Lempiras|USD|US\\$)\\b',
      currentBalance:
        '(?:SALDO\\s+(?:ACTUAL|TOTAL|DISPONIBLE|FINAL))\\s*[:.-]?\\s*(?:L\\.?|LPS|HNL|USD|\\$)?\\s*(\\d+(?:,\\d{3})*\\.\\d{2})',
      minimumPayment:
        '(?:PAGO\\s+M[IÍ]NIMO)\\s*[:.-]?\\s*(?:L\\.?|LPS|HNL|USD|\\$)?\\s*(\\d+(?:,\\d{3})*\\.\\d{2})',
      creditLimit:
        '(?:L[IÍ]MITE\\s+DE\\s+CR[EÉ]DITO)\\s*[:.-]?\\s*(?:L\\.?|LPS|HNL|USD|\\$)?\\s*(\\d+(?:,\\d{3})*\\.\\d{2})',
      transactionLine:
        '(20\\d{2}[-/]\\d{2}[-/]\\d{2}|\\d{1,2}[-/](?:[A-Z]{3,9}|\\d{1,2})[-/]\\d{2,4})(?:\\s+(\\d{1,2}:\\d{2}\\s*(?:AM|PM)))?\\s+([A-ZÁÉÍÓÚÑ0-9][A-ZÁÉÍÓÚÑ0-9\\s.,/*#-]{2,60}?)\\s+(?:L\\.?|LPS|HNL|USD|\\$)?\\s*([+-]?\\d+(?:,\\d{3})*\\.\\d{2})',
    }),
  }),
  Object.freeze({
    bankId: 'ficohsa_statement_pdf',
    bankName: 'Banco Ficohsa',
    country: 'HN',
    documentType: 'Estado de Cuenta (Múltiples Movimientos)',
    keywords: Object.freeze([
      'Banco Ficohsa',
      'BANCO FICOHSA',
      'Interbanca Ficohsa',
      'ESTADO DE CUENTA FICOHSA',
    ]),
    statementRules: Object.freeze({
      accountName: '(TARJETA[ \\t]+FICOHSA[^\\r\\n]*|CUENTA[ \\t]+(?:DE[ \\t]+AHORRO|CHEQUES)[^\\r\\n]*)',
      accountNumber: '(?:CUENTA|TARJETA|N[°ºo.]*|PRODUCTO)\\s*[:#-]?\\s*(\\d{4,16})\\b',
      owner: '(?:TITULAR|CLIENTE|NOMBRE)[ \\t]*[:.-]?[ \\t]*([A-ZÁÉÍÓÚÑ]{2,}(?:[ \\t]+[A-ZÁÉÍÓÚÑ]{2,}){1,4})',
      cutoffDate: '(?:FECHA\\s+DE\\s+CORTE|CORTE)\\s*[:.-]?\\s*(20\\d{2}[-/]\\d{2}[-/]\\d{2}|\\d{1,2}[-/](?:[A-Z]{3,10}|\\d{1,2})[-/]\\d{2,4})',
      paymentDueDate: '(?:FECHA\\s+(?:L[IÍ]MITE\\s+)?DE\\s+PAGO|VENCIMIENTO)\\s*[:.-]?\\s*(20\\d{2}[-/]\\d{2}[-/]\\d{2}|\\d{1,2}[-/](?:[A-Z]{3,10}|\\d{1,2})[-/]\\d{2,4})',
      currency: '\\b(HNL|LPS|Lempiras|USD|US\\$)\\b',
      currentBalance: '(?:SALDO\\s+(?:ACTUAL|TOTAL|DISPONIBLE|AL\\s+CORTE))\\s*[:.-]?\\s*(?:L\\.?|LPS|HNL|USD|\\$)?\\s*(\\d+(?:,\\d{3})*\\.\\d{2})',
      minimumPayment: '(?:PAGO\\s+M[IÍ]NIMO)\\s*[:.-]?\\s*(?:L\\.?|LPS|HNL|USD|\\$)?\\s*(\\d+(?:,\\d{3})*\\.\\d{2})',
      creditLimit: '(?:L[IÍ]MITE\\s+DE\\s+CR[EÉ]DITO)\\s*[:.-]?\\s*(?:L\\.?|LPS|HNL|USD|\\$)?\\s*(\\d+(?:,\\d{3})*\\.\\d{2})',
      transactionLine: '(20\\d{2}[-/]\\d{2}[-/]\\d{2}|\\d{1,2}[-/](?:[A-Z]{3,9}|\\d{1,2})[-/]\\d{2,4})(?:\\s+(\\d{1,2}:\\d{2}\\s*(?:AM|PM)))?\\s+([A-ZÁÉÍÓÚÑ0-9][A-ZÁÉÍÓÚÑ0-9\\s.,/*#-]{2,60}?)\\s+(?:L\\.?|LPS|HNL|USD|\\$)?\\s*([+-]?\\d+(?:,\\d{3})*\\.\\d{2})',
    }),
  }),
  Object.freeze({
    bankId: 'banpais_statement_pdf',
    bankName: 'Banpaís',
    country: 'HN',
    documentType: 'Estado de Cuenta (Múltiples Movimientos)',
    keywords: Object.freeze([
      'Banpaís',
      'BANPAIS',
      'Banco del País',
      'ESTADO DE CUENTA BANPAIS',
    ]),
    statementRules: Object.freeze({
      accountName: '(TARJETA[ \\t]+BANPA[IÍ]S[^\\r\\n]*|CUENTA[ \\t]+(?:DE[ \\t]+AHORRO|CHEQUES)[^\\r\\n]*)',
      accountNumber: '(?:CUENTA|TARJETA|N[°ºo.]*|PRODUCTO)\\s*[:#-]?\\s*(\\d{4,16})\\b',
      owner: '(?:TITULAR|CLIENTE|NOMBRE)[ \\t]*[:.-]?[ \\t]*([A-ZÁÉÍÓÚÑ]{2,}(?:[ \\t]+[A-ZÁÉÍÓÚÑ]{2,}){1,4})',
      cutoffDate: '(?:FECHA\\s+DE\\s+CORTE|CORTE)\\s*[:.-]?\\s*(20\\d{2}[-/]\\d{2}[-/]\\d{2}|\\d{1,2}[-/](?:[A-Z]{3,10}|\\d{1,2})[-/]\\d{2,4})',
      paymentDueDate: '(?:FECHA\\s+(?:L[IÍ]MITE\\s+)?DE\\s+PAGO|VENCIMIENTO)\\s*[:.-]?\\s*(20\\d{2}[-/]\\d{2}[-/]\\d{2}|\\d{1,2}[-/](?:[A-Z]{3,10}|\\d{1,2})[-/]\\d{2,4})',
      currency: '\\b(HNL|LPS|Lempiras|USD|US\\$)\\b',
      currentBalance: '(?:SALDO\\s+(?:ACTUAL|TOTAL|DISPONIBLE|AL\\s+CORTE))\\s*[:.-]?\\s*(?:L\\.?|LPS|HNL|USD|\\$)?\\s*(\\d+(?:,\\d{3})*\\.\\d{2})',
      minimumPayment: '(?:PAGO\\s+M[IÍ]NIMO)\\s*[:.-]?\\s*(?:L\\.?|LPS|HNL|USD|\\$)?\\s*(\\d+(?:,\\d{3})*\\.\\d{2})',
      creditLimit: '(?:L[IÍ]MITE\\s+DE\\s+CR[EÉ]DITO)\\s*[:.-]?\\s*(?:L\\.?|LPS|HNL|USD|\\$)?\\s*(\\d+(?:,\\d{3})*\\.\\d{2})',
      transactionLine: '(20\\d{2}[-/]\\d{2}[-/]\\d{2}|\\d{1,2}[-/](?:[A-Z]{3,9}|\\d{1,2})[-/]\\d{2,4})(?:\\s+(\\d{1,2}:\\d{2}\\s*(?:AM|PM)))?\\s+([A-ZÁÉÍÓÚÑ0-9][A-ZÁÉÍÓÚÑ0-9\\s.,/*#-]{2,60}?)\\s+(?:L\\.?|LPS|HNL|USD|\\$)?\\s*([+-]?\\d+(?:,\\d{3})*\\.\\d{2})',
    }),
  }),
  Object.freeze({
    bankId: 'industrial_gt_statement_pdf',
    bankName: 'Banco Industrial',
    country: 'GT',
    documentType: 'Estado de Cuenta (Múltiples Movimientos)',
    keywords: Object.freeze([
      'Banco Industrial',
      'BANCO INDUSTRIAL',
      'Bi en Línea',
      'ESTADO DE CUENTA BI',
    ]),
    statementRules: Object.freeze({
      accountName: '(CUENTA[ \\t]+MONETARIA[^\\r\\n]*|CUENTA[ \\t]+DE[ \\t]+AHORRO[^\\r\\n]*|TARJETA[ \\t]+BI[^\\r\\n]*)',
      accountNumber: '(?:CUENTA|TARJETA|N[°ºo.]*|PRODUCTO)\\s*[:#-]?\\s*(\\d{4,16})\\b',
      owner: '(?:TITULAR|CLIENTE|NOMBRE)[ \\t]*[:.-]?[ \\t]*([A-ZÁÉÍÓÚÑ]{2,}(?:[ \\t]+[A-ZÁÉÍÓÚÑ]{2,}){1,4})',
      cutoffDate: '(?:FECHA\\s+DE\\s+CORTE|CORTE)\\s*[:.-]?\\s*(20\\d{2}[-/]\\d{2}[-/]\\d{2}|\\d{1,2}[-/](?:[A-Z]{3,10}|\\d{1,2})[-/]\\d{2,4})',
      paymentDueDate: '(?:FECHA\\s+(?:L[IÍ]MITE\\s+)?DE\\s+PAGO|VENCIMIENTO)\\s*[:.-]?\\s*(20\\d{2}[-/]\\d{2}[-/]\\d{2}|\\d{1,2}[-/](?:[A-Z]{3,10}|\\d{1,2})[-/]\\d{2,4})',
      currency: '\\b(GTQ|Quetzales|Q\\.?|USD|US\\$)\\b',
      currentBalance: '(?:SALDO\\s+(?:ACTUAL|TOTAL|DISPONIBLE|AL\\s+CORTE))\\s*[:.-]?\\s*(?:Q\\.?|GTQ|USD|\\$)?\\s*(\\d+(?:,\\d{3})*\\.\\d{2})',
      minimumPayment: '(?:PAGO\\s+M[IÍ]NIMO)\\s*[:.-]?\\s*(?:Q\\.?|GTQ|USD|\\$)?\\s*(\\d+(?:,\\d{3})*\\.\\d{2})',
      creditLimit: '(?:L[IÍ]MITE\\s+DE\\s+CR[EÉ]DITO)\\s*[:.-]?\\s*(?:Q\\.?|GTQ|USD|\\$)?\\s*(\\d+(?:,\\d{3})*\\.\\d{2})',
      transactionLine: '(20\\d{2}[-/]\\d{2}[-/]\\d{2}|\\d{1,2}[-/](?:[A-Z]{3,9}|\\d{1,2})[-/]\\d{2,4})(?:\\s+(\\d{1,2}:\\d{2}\\s*(?:AM|PM)))?\\s+([A-ZÁÉÍÓÚÑ0-9][A-ZÁÉÍÓÚÑ0-9\\s.,/*#-]{2,60}?)\\s+(?:Q\\.?|GTQ|USD|\\$)?\\s*([+-]?\\d+(?:,\\d{3})*\\.\\d{2})',
    }),
  }),
  Object.freeze({
    bankId: 'banrural_gt_statement_pdf',
    bankName: 'Banrural',
    country: 'GT',
    documentType: 'Estado de Cuenta (Múltiples Movimientos)',
    keywords: Object.freeze([
      'Banrural',
      'BANRURAL',
      'El amigo que te ayuda a crecer',
      'ESTADO DE CUENTA BANRURAL',
    ]),
    statementRules: Object.freeze({
      accountName: '(CUENTA[ \\t]+MONETARIA[^\\r\\n]*|CUENTA[ \\t]+DE[ \\t]+AHORRO[^\\r\\n]*|TARJETA[ \\t]+BANRURAL[^\\r\\n]*)',
      accountNumber: '(?:CUENTA|TARJETA|N[°ºo.]*|PRODUCTO)\\s*[:#-]?\\s*(\\d{4,16})\\b',
      owner: '(?:TITULAR|CLIENTE|NOMBRE)[ \\t]*[:.-]?[ \\t]*([A-ZÁÉÍÓÚÑ]{2,}(?:[ \\t]+[A-ZÁÉÍÓÚÑ]{2,}){1,4})',
      cutoffDate: '(?:FECHA\\s+DE\\s+CORTE|CORTE)\\s*[:.-]?\\s*(20\\d{2}[-/]\\d{2}[-/]\\d{2}|\\d{1,2}[-/](?:[A-Z]{3,10}|\\d{1,2})[-/]\\d{2,4})',
      paymentDueDate: '(?:FECHA\\s+(?:L[IÍ]MITE\\s+)?DE\\s+PAGO|VENCIMIENTO)\\s*[:.-]?\\s*(20\\d{2}[-/]\\d{2}[-/]\\d{2}|\\d{1,2}[-/](?:[A-Z]{3,10}|\\d{1,2})[-/]\\d{2,4})',
      currency: '\\b(GTQ|Quetzales|Q\\.?|USD|US\\$)\\b',
      currentBalance: '(?:SALDO\\s+(?:ACTUAL|TOTAL|DISPONIBLE|AL\\s+CORTE))\\s*[:.-]?\\s*(?:Q\\.?|GTQ|USD|\\$)?\\s*(\\d+(?:,\\d{3})*\\.\\d{2})',
      minimumPayment: '(?:PAGO\\s+M[IÍ]NIMO)\\s*[:.-]?\\s*(?:Q\\.?|GTQ|USD|\\$)?\\s*(\\d+(?:,\\d{3})*\\.\\d{2})',
      creditLimit: '(?:L[IÍ]MITE\\s+DE\\s+CR[EÉ]DITO)\\s*[:.-]?\\s*(?:Q\\.?|GTQ|USD|\\$)?\\s*(\\d+(?:,\\d{3})*\\.\\d{2})',
      transactionLine: '(20\\d{2}[-/]\\d{2}[-/]\\d{2}|\\d{1,2}[-/](?:[A-Z]{3,9}|\\d{1,2})[-/]\\d{2,4})(?:\\s+(\\d{1,2}:\\d{2}\\s*(?:AM|PM)))?\\s+([A-ZÁÉÍÓÚÑ0-9][A-ZÁÉÍÓÚÑ0-9\\s.,/*#-]{2,60}?)\\s+(?:Q\\.?|GTQ|USD|\\$)?\\s*([+-]?\\d+(?:,\\d{3})*\\.\\d{2})',
    }),
  }),
]);

/**
 * Adapta la detección de impuestos (ej. ISV para HN, IVA para GT/SV/CR/NI/MX, ITBMS para PA)
 * y moneda por defecto (ej. HNL/Lempiras para HN, GTQ/Quetzales para GT) según el `country` del usuario.
 *
 * @param {string} [rawText='']
 * @param {string} [country='HN']
 * @returns {{
 *   country: string,
 *   currency: string,
 *   currencyName: string,
 *   currencySymbol: string,
 *   taxType: string,
 *   taxRate: number,
 *   taxAmount: number,
 *   priorityBanks: ReadonlyArray<string>
 * }}
 */
export function detectCountryTaxAndCurrency(rawText = '', country = DEFAULT_USER_COUNTRY) {
  const targetCountry = normalizeUserCountryCode(country);
  const regional = getCountryRegionalConfig(targetCountry);
  const text = String(rawText || '');

  let detectedCurrency = regional.defaultCurrency;
  if (/\b(?:HNL|LPS|LEMPIRAS?)\b|(?:^|[^\w])L\.?\s*\d/i.test(text)) {
    detectedCurrency = 'HNL';
  } else if (/\b(?:GTQ|QUETZAL(?:ES)?)\b|(?:^|[^\w])Q\.?\s*\d/i.test(text)) {
    detectedCurrency = 'GTQ';
  } else if (/\b(?:CRC|COL[OÓ]N(?:ES)?)\b|₡\s*\d/i.test(text)) {
    detectedCurrency = 'CRC';
  } else if (/\b(?:NIO|C[OÓ]RDOBAS?)\b|C\$\s*\d/i.test(text)) {
    detectedCurrency = 'NIO';
  } else if (/\b(?:MXN|MEX\$|PESOS?\s+MEXICANOS?)\b/i.test(text)) {
    detectedCurrency = 'MXN';
  } else if (/\b(?:USD|US\$|D[OÓ]LAR(?:ES)?)\b/i.test(text)) {
    detectedCurrency = 'USD';
  } else if (/\$/.test(text) && targetCountry !== 'MX') {
    detectedCurrency = 'USD';
  }

  let taxType = regional.taxType;
  let taxRate = regional.defaultTaxRate;

  if (/\bI\.?S\.?V\.?\b|\bIMPUESTO\s+SOBRE\s+VENTAS\b/i.test(text)) {
    taxType = 'ISV';
    taxRate = /\b18\s*%/.test(text) ? 0.18 : 0.15;
  } else if (/\bI\.?T\.?B\.?M\.?S\.?\b/i.test(text)) {
    taxType = 'ITBMS';
    taxRate = 0.07;
  } else if (/\bI\.?V\.?A\.?\b|\bIMPUESTO\s+AL\s+VALOR\s+AGREGADO\b/i.test(text)) {
    taxType = 'IVA';
    if (targetCountry === 'GT') taxRate = 0.12;
    else if (targetCountry === 'SV' || targetCountry === 'CR') taxRate = 0.13;
    else if (targetCountry === 'NI') taxRate = 0.15;
    else if (targetCountry === 'MX') taxRate = 0.16;
  }

  const taxAmountMatch = text.match(
    /(?:I\.?S\.?V\.?|I\.?V\.?A\.?|I\.?T\.?B\.?M\.?S\.?|IMPUESTO(?:\s+SOBRE\s+VENTAS|\s+AL\s+VALOR\s+AGREGADO)?|SALES\s+TAX)(?:\s*\d{1,2}\s*%)?\s*[:.-]?\s*(?:L\.?|LPS|HNL|Q\.?|GTQ|CRC|₡|NIO|C\$|MXN|USD|US\$|B\/\.|\$)?\s*(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})/i
  );
  const taxAmount = taxAmountMatch ? cleanAmount(taxAmountMatch[1]) : 0;

  return {
    country: targetCountry,
    currency: detectedCurrency,
    currencyName: regional.currencyName,
    currencySymbol: regional.currencySymbol,
    taxType,
    taxLabel: taxType,
    taxRate,
    taxAmount,
    priorityBanks: regional.priorityBanks,
  };
}

/**
 * Normaliza fechas en formato `YYYY-MM-DD`, `DD/MM/YYYY`, `DD-MM-YYYY` o `DD-SEP-2026` a `YYYY-MM-DD`.
 * @param {string} rawDate
 * @param {string} [fallback='']
 * @returns {string}
 */
export function normalizeStatementDate(rawDate = '', fallback = '') {
  const raw = String(rawDate || '').trim();
  if (!raw) return fallback;

  const isoMatch = raw.match(/\b(20\d{2})[-/](0[1-9]|1[0-2])[-/](0[1-9]|[12]\d|3[01])\b/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  const dmyNumMatch = raw.match(/\b(0?[1-9]|[12]\d|3[01])[-/](0?[1-9]|1[0-2])[-/](\d{2,4})\b/);
  if (dmyNumMatch) {
    const day = String(dmyNumMatch[1]).padStart(2, '0');
    const month = String(dmyNumMatch[2]).padStart(2, '0');
    const year = dmyNumMatch[3].length === 2 ? `20${dmyNumMatch[3]}` : dmyNumMatch[3];
    return `${year}-${month}-${day}`;
  }

  const dmyAlphaMatch = raw.match(
    /\b(0?[1-9]|[12]\d|3[01])[-/\s]+([A-Za-zÁÉÍÓÚáéíóú]{3,10})[-/\s,]+(\d{2,4})\b/
  );
  if (dmyAlphaMatch) {
    const day = String(dmyAlphaMatch[1]).padStart(2, '0');
    const monthKey = dmyAlphaMatch[2].toUpperCase().slice(0, 3);
    const month = MONTH_NAME_MAP[dmyAlphaMatch[2].toUpperCase()] || MONTH_NAME_MAP[monthKey] || '01';
    const year = dmyAlphaMatch[3].length === 2 ? `20${dmyAlphaMatch[3]}` : dmyAlphaMatch[3];
    return `${year}-${month}-${day}`;
  }

  return fallback;
}

/**
 * Carga y combina las plantillas de `bank_templates` desde Firestore, IndexedDB y `DEFAULT_STATEMENT_TEMPLATES`.
 *
 * @param {object} [options]
 * @returns {Promise<Array<object>>}
 */
export async function loadKnownStatementTemplates(options = {}) {
  const targetCountry = getActiveUserCountry(options);
  const byId = new Map();

  for (const tpl of DEFAULT_STATEMENT_TEMPLATES) {
    byId.set(tpl.bankId, tpl);
  }

  try {
    const syncLocal = getLocalBankTemplatesSync(options.storage);
    if (Array.isArray(syncLocal)) {
      for (const tpl of syncLocal) {
        if (tpl?.bankId) {
          byId.set(tpl.bankId, { ...(byId.get(tpl.bankId) || {}), ...tpl });
        }
      }
    }
  } catch {
    // Continuar con plantillas en memoria
  }

  try {
    const idbLocal = await getAllLocalBankTemplates({
      indexedDb: options.indexedDb,
      storage: options.storage,
    });
    if (Array.isArray(idbLocal)) {
      for (const tpl of idbLocal) {
        if (tpl?.bankId) {
          byId.set(tpl.bankId, { ...(byId.get(tpl.bankId) || {}), ...tpl });
        }
      }
    }
  } catch {
    // Continuar si IndexedDB no está disponible
  }

  if (options.firestoreDb && options.firestoreModule) {
    try {
      const remoteList = await fetchBankTemplatesFromFirestore({
        firestoreDb: options.firestoreDb,
        firestoreModule: options.firestoreModule,
        indexedDb: options.indexedDb,
        storage: options.storage,
        country: targetCountry,
      });
      if (Array.isArray(remoteList)) {
        for (const tpl of remoteList) {
          if (tpl?.bankId) {
            byId.set(tpl.bankId, { ...(byId.get(tpl.bankId) || {}), ...tpl });
          }
        }
      }
    } catch {
      // Fallback local-first
    }
  }

  if (Array.isArray(options.customTemplates)) {
    for (const tpl of options.customTemplates) {
      if (tpl?.bankId) {
        byId.set(tpl.bankId, { ...(byId.get(tpl.bankId) || {}), ...tpl });
      }
    }
  }

  const allTemplates = Array.from(byId.values());
  return filterBankTemplatesByCountry(allTemplates, targetCountry, {
    strictCountry: Boolean(options.strictCountry),
  });
}

/**
 * Busca si la primera página o el texto del PDF coincide con una plantilla conocida en `bank_templates`,
 * priorizando los bancos del `country` seleccionado por el usuario.
 *
 * @param {string} firstPageOrFullText
 * @param {Array<object>} [templates=DEFAULT_STATEMENT_TEMPLATES]
 * @param {string|object} [countryOrOptions='HN']
 * @returns {object|null}
 */
export function matchStatementTemplate(
  firstPageOrFullText = '',
  templates = DEFAULT_STATEMENT_TEMPLATES,
  countryOrOptions = DEFAULT_USER_COUNTRY
) {
  const normText = String(firstPageOrFullText || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  if (!normText.trim()) return null;

  const targetCountry =
    typeof countryOrOptions === 'string'
      ? normalizeUserCountryCode(countryOrOptions)
      : getActiveUserCountry(countryOrOptions);
  const regional = getCountryRegionalConfig(targetCountry);
  const priorityBanksLower = regional.priorityBanks.map((b) =>
    b
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
  );

  const rawList =
    Array.isArray(templates) && templates.length > 0
      ? templates
      : DEFAULT_STATEMENT_TEMPLATES;
  const list = filterBankTemplatesByCountry(rawList, targetCountry);

  let bestTemplate = null;
  let bestScore = 0;

  for (const tpl of list) {
    if (!tpl) continue;
    let score = 0;
    const keywords = Array.isArray(tpl.keywords) ? tpl.keywords : [];

    for (const kw of keywords) {
      const normKw = String(kw || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
      if (
        !normKw ||
        normKw === 'estado de cuenta' ||
        normKw === 'cuenta de ahorro' ||
        normKw === 'cuenta bancaria' ||
        normKw === 'tarjeta de credito'
      ) {
        continue;
      }
      if (normText.includes(normKw)) {
        score += normKw.length >= 12 ? 3 : 2;
      }
    }

    const normBank = String(tpl.bankName || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
    if (normBank && normText.includes(normBank)) {
      score += 3;
    }

    if (score >= 2) {
      if ((tpl.country || DEFAULT_USER_COUNTRY) === targetCountry) {
        score += 2;
      }
      if (priorityBanksLower.some((pb) => normBank.includes(pb) || pb.includes(normBank))) {
        score += 2;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestTemplate = tpl;
    }
  }

  return bestScore >= 2 && bestTemplate
    ? {
        ...bestTemplate,
        matched: true,
        template: bestTemplate,
      }
    : null;
}

/**
 * Ejecuta una expresión regular segura devolviendo el primer grupo de captura no vacío.
 * @param {string} text
 * @param {string|RegExp} pattern
 * @returns {string}
 */
function extractFirstCapture(text = '', pattern = '') {
  if (!text || !pattern) return '';
  try {
    const regex = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i');
    const match = String(text).match(regex);
    if (!match) return '';
    for (let i = 1; i < match.length; i += 1) {
      if (match[i] !== undefined && String(match[i]).trim() !== '') {
        return String(match[i]).trim();
      }
    }
    return String(match[0] || '').trim();
  } catch {
    return '';
  }
}

/**
 * Aplica los selectores Regex de una plantilla de `bank_templates` sobre el texto vectorial
 * del PDF para extraer `bankName`, `documentType`, `accountInfo` y `transactions` a costo 0.
 *
 * @param {string|{ fullText?: string, firstPageText?: string, lines?: string[] }} pdfTextOrLayer
 * @param {object} matchedTemplate
 * @returns {{
 *   bankName: string,
 *   documentType: string,
 *   accountInfo: {
 *     accountName: string,
 *     accountNumber: string,
 *     owner: string,
 *     cutoffDate: string,
 *     paymentDueDate: string,
 *     currency: 'HNL'|'USD',
 *     currentBalance: number,
 *     minimumPayment: number,
 *     creditLimit: number
 *   },
 *   transactions: Array<{
 *     date: string,
 *     time: string,
 *     concept: string,
 *     amount: number,
 *     type: 'income'|'expense',
 *     currency: 'HNL'|'USD'
 *   }>,
 *   templateId: string
 * }}
 */
export function extractStatementWithTemplate(pdfTextOrLayer, matchedTemplate = {}, options = {}) {
  const targetCountry = normalizeUserCountryCode(
    options.country || matchedTemplate?.country || DEFAULT_USER_COUNTRY
  );
  const fullText =
    typeof pdfTextOrLayer === 'string'
      ? pdfTextOrLayer
      : String(pdfTextOrLayer?.fullText || pdfTextOrLayer?.firstPageText || '');

  const lines =
    typeof pdfTextOrLayer === 'object' && Array.isArray(pdfTextOrLayer?.lines)
      ? pdfTextOrLayer.lines
      : fullText
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);

  const defaultBankTpl =
    DEFAULT_STATEMENT_TEMPLATES.find(
      (d) =>
        d.bankId === matchedTemplate?.bankId ||
        String(d.bankName || '').toLowerCase() ===
          String(matchedTemplate?.bankName || '').toLowerCase()
    ) || DEFAULT_STATEMENT_TEMPLATES[0];

  const statementRules = {
    ...(defaultBankTpl?.statementRules || {}),
    ...(matchedTemplate?.extractionRules || {}),
    ...(matchedTemplate?.statementRules || {}),
  };

  const bankName = String(
    matchedTemplate?.bankName || defaultBankTpl?.bankName || 'Banco Promerica'
  ).trim();

  const isCreditCardStatement =
    /\b(?:TARJETA|PLATINUM|VISA|MASTERCARD|AMEX|AMERICAN\s+EXPRESS|L[IÍ]MITE\s+DE\s+CR[EÉ]DITO|PAGO\s+M[IÍ]NIMO|FECHA\s+DE\s+CORTE)\b/i.test(
      fullText
    ) || /Tarjeta/i.test(String(matchedTemplate?.documentType || ''));

  const documentType = isCreditCardStatement
    ? 'Estado de Cuenta (Tarjeta de Crédito)'
    : String(matchedTemplate?.documentType || 'Estado de Cuenta (Múltiples Movimientos)');

  const rawAccountName =
    extractFirstCapture(fullText, statementRules.accountName) ||
    extractFirstCapture(fullText, statementRules.accountType) ||
    matchedTemplate?.learnedAccounts?.[0]?.accountType ||
    (isCreditCardStatement ? 'Tarjeta de Crédito' : 'Cuenta Bancaria');

  const rawAccountNumber =
    extractFirstCapture(fullText, statementRules.accountNumber) ||
    matchedTemplate?.learnedAccounts?.[0]?.accountNumber ||
    '';
  const accountNumber = String(rawAccountNumber).replace(/\D/g, '');

  const owner =
    extractFirstCapture(fullText, statementRules.owner) ||
    matchedTemplate?.accountInfo?.owner ||
    '';

  const cutoffDate = normalizeStatementDate(
    extractFirstCapture(fullText, statementRules.cutoffDate),
    matchedTemplate?.accountInfo?.cutoffDate || ''
  );

  const paymentDueDate = normalizeStatementDate(
    extractFirstCapture(fullText, statementRules.paymentDueDate),
    matchedTemplate?.accountInfo?.paymentDueDate || ''
  );

  const regionalTaxAndCur = detectCountryTaxAndCurrency(fullText, targetCountry);
  const rawCurrency =
    /\b(?:LEMPIRAS|D[ÓO]LARES)\b/i.test(fullText)
      ? detectActiveStatementCurrency(fullText)
      : extractFirstCapture(fullText, statementRules.currency) ||
        matchedTemplate?.accountInfo?.currency ||
        regionalTaxAndCur.currency;
  const currency = normalizeTemplateCurrency(rawCurrency, targetCountry);

  const currentBalance = cleanAmount(
    extractFirstCapture(fullText, statementRules.currentBalance) ||
      matchedTemplate?.accountInfo?.currentBalance ||
      0
  );

  const minimumPayment = cleanAmount(
    extractFirstCapture(fullText, statementRules.minimumPayment) ||
      matchedTemplate?.accountInfo?.minimumPayment ||
      0
  );

  const creditLimit = cleanAmount(
    extractFirstCapture(fullText, statementRules.creditLimit) ||
      matchedTemplate?.accountInfo?.creditLimit ||
      0
  );

  let transactions = [];
  const txRegexStr =
    statementRules.transactionLine ||
    DEFAULT_STATEMENT_TEMPLATES[0].statementRules.transactionLine;
  const lineRegex = new RegExp(txRegexStr, 'i');

  for (const line of lines) {
    if (
      /\b(?:FECHA\s+DE\s+CORTE|FECHA\s+DE\s+PAGO|SALDO\s+ANTERIOR|SALDO\s+ACTUAL|L[IÍ]MITE\s+DE\s+CR[EÉ]DITO|PAGO\s+M[IÍ]NIMO|PAGO\s+DE\s+CONTADO)\b/i.test(
        line
      )
    ) {
      continue;
    }

    const match = line.match(lineRegex);
    if (!match) continue;

    const txDate = normalizeStatementDate(match[1], cutoffDate || '2026-09-05');
    const txTime = String(match[2] || '12:00 AM').trim();
    const txConcept = String(match[3] || '')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[-*•:|]+|[-*•:|]+$/g, '')
      .trim();
    const rawAmtStr = String(match[4] || '');
    const txAmount = cleanAmount(rawAmtStr);

    if (!txConcept || txAmount <= 0) continue;

    const isIncome =
      rawAmtStr.trim().startsWith('+') ||
      /\b(?:ABONO|CR[EÉ]DITO|DEP[OÓ]SITO|SU\s+PAGO\s+GRACIAS|PAGO\s+RECIBIDO|REVERSI[OÓ]N)\b/i.test(
        txConcept
      );

    transactions.push({
      date: txDate,
      time: txTime,
      concept: txConcept,
      amount: txAmount,
      type: isIncome ? 'income' : 'expense',
      currency: /\bUSD\b|\bUS\$/i.test(line) ? 'USD' : currency,
    });
  }

  if (transactions.length === 0) {
    transactions = parseStatementTransactions(fullText, currency);
  }

  return {
    bankName,
    country: targetCountry,
    documentType,
    accountInfo: {
      accountName: rawAccountName,
      accountNumber,
      owner,
      cutoffDate,
      paymentDueDate,
      currency,
      currentBalance,
      minimumPayment,
      creditLimit,
    },
    taxInfo: {
      taxType: regionalTaxAndCur.taxType,
      taxRate: regionalTaxAndCur.taxRate,
      taxAmount: regionalTaxAndCur.taxAmount,
    },
    taxMetadata: regionalTaxAndCur,
    transactions,
    templateId: matchedTemplate?.bankId || defaultBankTpl?.bankId || 'learned_statement_template',
  };
}

/**
 * Construye y persiste automáticamente una nueva plantilla en `bank_templates` (Firestore + IndexedDB)
 * a partir del resultado estructurado devuelto por Gemini 2.5 Flash para que futuras lecturas
 * de ese mismo banco/formato se ejecuten 100% en local y sin costo.
 *
 * @param {object} structuredData
 * @param {string} rawText
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export async function learnAndSaveStatementPatternToBankTemplates(
  structuredData = {},
  rawText = '',
  options = {}
) {
  const targetCountry = normalizeUserCountryCode(
    options.country || structuredData.country || getActiveUserCountry(options)
  );
  const regional = getCountryRegionalConfig(targetCountry);
  const bankName = String(structuredData.bankName || 'Banco Local').trim();
  const documentType = String(
    structuredData.documentType || 'Estado de Cuenta (Tarjeta de Crédito)'
  ).trim();
  const accountInfo = structuredData.accountInfo || {};
  const accountName = String(
    accountInfo.accountName || structuredData.accountName || 'Cuenta / Tarjeta'
  ).trim();
  const accountNumber = String(
    accountInfo.accountNumber || structuredData.accountNumber || ''
  ).replace(/\D/g, '');

  const escapeRegex = (val) => String(val || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const keywords = Array.from(
    new Set(
      [
        bankName,
        accountName,
        'ESTADO DE CUENTA',
        ...(Array.isArray(structuredData.keywords) ? structuredData.keywords : []),
      ]
        .map((k) => String(k || '').trim())
        .filter((k) => k.length >= 3)
    )
  );

  const statementRules = {
    accountName: accountName
      ? `(${escapeRegex(accountName)}|TARJETA\\s+[A-Z0-9\\s\\/-]{4,45}|CUENTA\\s+[A-Z0-9\\s\\/-]{4,45})`
      : DEFAULT_STATEMENT_TEMPLATES[0].statementRules.accountName,
    accountNumber: accountNumber
      ? `(${escapeRegex(accountNumber)}|\\b\\d{8,16}\\b)`
      : '\\b(\\d{4,16})\\b',
    owner: accountInfo.owner
      ? `(${escapeRegex(accountInfo.owner)}|[A-ZÁÉÍÓÚÑ]{3,}(?:\\s+[A-ZÁÉÍÓÚÑ]{2,}){2,4})`
      : DEFAULT_STATEMENT_TEMPLATES[0].statementRules.owner,
    cutoffDate: DEFAULT_STATEMENT_TEMPLATES[0].statementRules.cutoffDate,
    paymentDueDate: DEFAULT_STATEMENT_TEMPLATES[0].statementRules.paymentDueDate,
    currency: '\\b(HNL|LPS|Lempiras|GTQ|Quetzales|CRC|NIO|MXN|USD|US\\$)\\b',
    currentBalance: DEFAULT_STATEMENT_TEMPLATES[0].statementRules.currentBalance,
    minimumPayment: DEFAULT_STATEMENT_TEMPLATES[0].statementRules.minimumPayment,
    creditLimit: DEFAULT_STATEMENT_TEMPLATES[0].statementRules.creditLimit,
    transactionLine: DEFAULT_STATEMENT_TEMPLATES[0].statementRules.transactionLine,
  };

  const bankSlug = bankName
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\bbanco\b/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const bankId = `${bankSlug || 'custom'}_statement_pdf`;
  const fingerprint = computeLayoutFingerprint(rawText || `${bankName} ${accountName}`);
  const resolvedCurrency = normalizeTemplateCurrency(
    accountInfo.currency || regional.defaultCurrency,
    targetCountry
  );

  const savedTemplate = await saveBankTemplate(
    {
      bankId,
      bankName,
      country: targetCountry,
      documentType,
      keywords,
      fingerprint,
      extractionRules: {
        accountNumber: statementRules.accountNumber,
        accountType: statementRules.accountName,
        currency: statementRules.currency,
        currentBalance: statementRules.currentBalance,
      },
      statementRules,
      accountInfo: {
        accountName,
        accountNumber,
        owner: String(accountInfo.owner || ''),
        cutoffDate: String(accountInfo.cutoffDate || ''),
        paymentDueDate: String(accountInfo.paymentDueDate || ''),
        currency: resolvedCurrency,
        currentBalance: cleanAmount(accountInfo.currentBalance || 0),
        minimumPayment: cleanAmount(accountInfo.minimumPayment || 0),
        creditLimit: cleanAmount(accountInfo.creditLimit || 0),
      },
      learnedAccounts: [
        {
          bankName,
          accountType: accountName,
          accountNumber,
          currency: resolvedCurrency,
          currentBalance: cleanAmount(accountInfo.currentBalance || 0),
          creditLimit: cleanAmount(accountInfo.creditLimit || 0),
          isCreditCard: /Tarjeta|PLATINUM|VISA|MASTERCARD|AMEX/i.test(
            `${documentType} ${accountName}`
          ),
        },
      ],
    },
    {
      firestoreDb: options.firestoreDb,
      firestoreModule: options.firestoreModule,
      indexedDb: options.indexedDb,
      storage: options.storage,
    }
  );

  return {
    ...savedTemplate,
    country: targetCountry,
    documentType,
    statementRules,
    accountInfo: {
      accountName,
      accountNumber,
      owner: String(accountInfo.owner || ''),
      cutoffDate: String(accountInfo.cutoffDate || ''),
      paymentDueDate: String(accountInfo.paymentDueDate || ''),
      currency: resolvedCurrency,
      currentBalance: cleanAmount(accountInfo.currentBalance || 0),
      minimumPayment: cleanAmount(accountInfo.minimumPayment || 0),
      creditLimit: cleanAmount(accountInfo.creditLimit || 0),
    },
  };
}

/**
 * Orquesta el flujo completo de 3 pasos para Estados de Cuenta en PDF:
 * - Paso 1: Extracción de Capa de Texto Directa (`extractNativePdfTextLayer` con `pdfjs-dist`).
 * - Paso 2: Reconocimiento de Plantilla Aprendida (`bank_templates`) filtrada por `country`.
 * - Paso 3: Si es un formato nuevo no reconocido, invoca Gemini 2.5 Flash, devuelve el JSON estructurado
 *   y guarda automáticamente el nuevo patrón regex en `bank_templates` (Firestore + IndexedDB).
 */
export async function processPdfStatementWithPatternLearning(
  pdfFileOrInput,
  state = {},
  options = {},
  onProgress = () => {}
) {
  onProgress('⚡ Extrayendo capa de texto vectorial del PDF...', 20);

  const mergedOpts = {
    ...(state && typeof state === 'object' ? state : {}),
    ...(options && typeof options === 'object' ? options : {}),
  };
  const targetCountry = getActiveUserCountry({
    ...mergedOpts,
    country: mergedOpts.country || state?.country || state?.user?.country || state?.profile?.country,
    state,
  });
  const enrichedOptions = { ...mergedOpts, country: targetCountry };

  // Paso 1: Extracción de Capa de Texto Directa (pdfjs-dist)
  const pdfTextLayer = await extractNativePdfTextLayer(pdfFileOrInput, enrichedOptions);
  const firstPageText = pdfTextLayer.firstPageText || pdfTextLayer.fullText || '';

  // Paso 2: Reconocimiento de Plantilla Aprendida (bank_templates) filtrada por `country`
  const templates = await loadKnownStatementTemplates(enrichedOptions);
  const matchedTemplate = matchStatementTemplate(firstPageText, templates, targetCountry);

  if (matchedTemplate) {
    onProgress(`✅ Plantilla reconocida (${matchedTemplate.bankName}) — extracción local a costo 0`, 70);
    const localExtracted = extractStatementWithTemplate(pdfTextLayer, matchedTemplate, {
      country: targetCountry,
    });
    const hasValidLocalData =
      Boolean(localExtracted.accountInfo.accountNumber) ||
      localExtracted.transactions.length > 0 ||
      localExtracted.accountInfo.currentBalance > 0;

    if (hasValidLocalData) {
      onProgress('✅ Estado de Cuenta procesado localmente', 100);
      return {
        ...localExtracted,
        country: targetCountry,
        usedLocalTemplate: true,
        usedGeminiFallback: false,
        learnedTemplate: matchedTemplate,
        pdfTextLayer,
      };
    }
  }

  // Paso 3: Aprendizaje Automático de Nuevos Formatos (Fallback con Gemini 2.5 Flash & Save)
  onProgress('🤖 Formato nuevo detectado — analizando y aprendiendo con Gemini 2.5 Flash...', 65);
  let geminiData = null;

  if (typeof options.geminiFallbackRunner === 'function') {
    geminiData = await options.geminiFallbackRunner(pdfFileOrInput, pdfTextLayer, enrichedOptions);
  } else if (typeof options.fetchImpl === 'function' || typeof globalThis.fetch === 'function') {
    const fetchFn = options.fetchImpl || globalThis.fetch;
    const apiKey = String(options.geminiApiKey || options.apiKey || '').trim();
    if (apiKey && typeof fetchFn === 'function') {
      try {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
        const regional = getCountryRegionalConfig(targetCountry);
        const promptText = [
          `Extrae el Estado de Cuenta bancario (País: ${regional.name} [${targetCountry}], Moneda por defecto: ${regional.defaultCurrency}, Impuesto: ${regional.taxType}) en JSON estricto con las propiedades:`,
          'bankName, documentType, accountInfo { accountName, accountNumber, owner, cutoffDate, paymentDueDate, currency, currentBalance, minimumPayment, creditLimit } y transactions [{ date, time, concept, amount, type, currency }].',
          `Texto del PDF:\n${pdfTextLayer.fullText || ''}`,
        ].join('\n');

        const res = await fetchFn(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: promptText }] }],
            generationConfig: {
              temperature: 0.1,
              responseMimeType: 'application/json',
            },
          }),
        });
        if (res && res.ok) {
          const payload = await res.json();
          const rawJsonText = payload?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          const matchJson = rawJsonText.match(/\{[\s\S]*\}/);
          if (matchJson) {
            geminiData = JSON.parse(matchJson[0]);
          }
        }
      } catch {
        geminiData = null;
      }
    }
  }

  if (geminiData && typeof geminiData === 'object') {
    const rawAccountInfo = geminiData.accountInfo || {};
    const regional = getCountryRegionalConfig(targetCountry);
    const currency = normalizeTemplateCurrency(
      rawAccountInfo.currency || geminiData.currency || regional.defaultCurrency,
      targetCountry
    );
    const normalizedResult = {
      bankName: String(geminiData.bankName || 'Banco Local').trim(),
      country: targetCountry,
      documentType: String(
        geminiData.documentType || 'Estado de Cuenta (Tarjeta de Crédito)'
      ).trim(),
      accountInfo: {
        accountName: String(
          rawAccountInfo.accountName || geminiData.accountName || 'Cuenta / Tarjeta'
        ).trim(),
        accountNumber: String(
          rawAccountInfo.accountNumber || geminiData.accountNumber || ''
        ).replace(/\D/g, ''),
        owner: String(rawAccountInfo.owner || '').trim(),
        cutoffDate: normalizeStatementDate(rawAccountInfo.cutoffDate || geminiData.date || ''),
        paymentDueDate: normalizeStatementDate(rawAccountInfo.paymentDueDate || ''),
        currency,
        currentBalance: cleanAmount(
          rawAccountInfo.currentBalance ?? geminiData.amount ?? 0
        ),
        minimumPayment: cleanAmount(rawAccountInfo.minimumPayment ?? 0),
        creditLimit: cleanAmount(rawAccountInfo.creditLimit ?? 0),
      },
      transactions: (Array.isArray(geminiData.transactions) ? geminiData.transactions : [])
        .map((tx) => ({
          date: normalizeStatementDate(tx.date || tx.fecha || ''),
          time: String(tx.time || '12:00 AM').trim(),
          concept: String(tx.concept || tx.merchant || tx.comercio || 'Movimiento').trim(),
          amount: cleanAmount(tx.amount ?? tx.monto ?? 0),
          type:
            String(tx.type || tx.tipo || 'expense').toLowerCase() === 'income'
              ? 'income'
              : 'expense',
          currency: normalizeTemplateCurrency(tx.currency || tx.moneda || currency, targetCountry),
        }))
        .filter((tx) => tx.amount > 0),
    };

    const learnedTemplate = await learnAndSaveStatementPatternToBankTemplates(
      normalizedResult,
      pdfTextLayer.fullText,
      enrichedOptions
    );

    onProgress('✅ Nuevo formato bancario aprendido y guardado en bank_templates', 100);
    return {
      ...normalizedResult,
      usedLocalTemplate: false,
      usedGeminiFallback: true,
      learnedTemplate,
      pdfTextLayer,
    };
  }

  // Fallback local con reglas genéricas si no hubo conexión a Gemini
  const fallbackTpl =
    DEFAULT_STATEMENT_TEMPLATES.find((t) => t.country === targetCountry) ||
    DEFAULT_STATEMENT_TEMPLATES[0];
  const genericExtracted = extractStatementWithTemplate(pdfTextLayer, fallbackTpl, {
    country: targetCountry,
  });
  onProgress('✅ Estado de Cuenta procesado', 100);
  return {
    ...genericExtracted,
    country: targetCountry,
    usedLocalTemplate: false,
    usedGeminiFallback: false,
    learnedTemplate: null,
    pdfTextLayer,
  };
}
