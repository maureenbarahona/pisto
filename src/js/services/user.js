/**
 * @fileoverview User Profile Data Model, Country Configuration & Firestore Persistence (`src/js/services/user.js`).
 *
 * Implements:
 * 1. User creation/sync schema in `users/{uid}` including the `country` attribute:
 *    - Default value: `"HN"` (Honduras).
 *    - Supports ISO country codes (`"HN"`, `"GT"`, `"SV"`, `"CR"`, `"NI"`, `"PA"`, `"MX"`, `"US"`, etc.).
 * 2. Profile update persistence (`updateUserProfile`):
 *    - Persists changes to Firestore (`updateDoc(doc(db, 'users', uid), ...)`) with safe merge fallback.
 *    - Updates the local user/profile object in memory and `localStorage`.
 * 3. Region-specific tax, currency, and priority bank metadata for OCR / template matching.
 * 4. Strict Vanilla JS (ESNext), zero dead code, zero `console.log` statements.
 */

import { CURRENCIES } from '../../../public/js/domain/models.js';
import {
  SUPPORTED_COUNTRIES,
  FIRESTORE_USERS_CACHE_PREFIX,
  LOCAL_AUTH_SESSION_KEY,
  normalizeCountryCode,
  createUserProfile,
} from '../../../public/js/services/authProfileService.js';

export const DEFAULT_USER_COUNTRY = 'HN';

export const SUPPORTED_ISO_COUNTRY_CODES = Object.freeze([
  'HN',
  'GT',
  'SV',
  'CR',
  'NI',
  'PA',
  'MX',
  'US',
  'CO',
  'CL',
  'AR',
  'ES',
]);

/**
 * Regional configuration per ISO country code including default currency, tax label/rate,
 * currency tokens for OCR detection, and prioritized regional banking institutions.
 */
export const COUNTRY_REGIONAL_CONFIG = Object.freeze({
  HN: Object.freeze({
    code: 'HN',
    name: 'Honduras',
    flag: '🇭🇳',
    defaultCurrency: 'HNL',
    currencyName: 'Lempiras',
    currencySymbol: 'L',
    currencyTokens: Object.freeze(['HNL', 'LPS', 'LEMPIRAS', 'LEMPIRA', 'L.', 'L']),
    taxType: 'ISV',
    taxKeywords: Object.freeze(['ISV', 'I.S.V.', 'IMPUESTO SOBRE VENTAS', '15% ISV', '18% ISV']),
    defaultTaxRate: 0.15,
    priorityBanks: Object.freeze([
      'Banco Atlántida',
      'BAC Credomatic',
      'Banco Ficohsa',
      'Banco Promerica',
      'Banpaís',
      'Banco de Occidente',
      'Davivienda',
      'Banco Lafise',
      'Banrural',
      'Banhcafé',
    ]),
  }),
  GT: Object.freeze({
    code: 'GT',
    name: 'Guatemala',
    flag: '🇬🇹',
    defaultCurrency: 'GTQ',
    currencyName: 'Quetzales',
    currencySymbol: 'Q',
    currencyTokens: Object.freeze(['GTQ', 'QUETZALES', 'QUETZAL', 'Q.', 'Q']),
    taxType: 'IVA',
    taxKeywords: Object.freeze(['IVA', 'I.V.A.', 'IMPUESTO AL VALOR AGREGADO', '12% IVA', 'NIT']),
    defaultTaxRate: 0.12,
    priorityBanks: Object.freeze([
      'Banco Industrial',
      'Banrural',
      'G&T Continental',
      'BAM',
      'BAC Credomatic',
      'Banco Promerica',
      'Banco Ficohsa',
      'Bantrab',
    ]),
  }),
  SV: Object.freeze({
    code: 'SV',
    name: 'El Salvador',
    flag: '🇸🇻',
    defaultCurrency: 'USD',
    currencyName: 'Dólares',
    currencySymbol: '$',
    currencyTokens: Object.freeze(['USD', 'US$', 'DOLARES', 'DÓLARES', '$']),
    taxType: 'IVA',
    taxKeywords: Object.freeze(['IVA', 'I.V.A.', '13% IVA', 'CREDITO FISCAL', 'NRC']),
    defaultTaxRate: 0.13,
    priorityBanks: Object.freeze([
      'Banco Agrícola',
      'Banco Cuscatlán',
      'BAC Credomatic',
      'Davivienda',
      'Banco Promerica',
      'Banco Azul',
      'Banco Hipotecario',
    ]),
  }),
  CR: Object.freeze({
    code: 'CR',
    name: 'Costa Rica',
    flag: '🇨🇷',
    defaultCurrency: 'CRC',
    currencyName: 'Colones',
    currencySymbol: '₡',
    currencyTokens: Object.freeze(['CRC', 'COLONES', 'COLON', 'COLÓN', '₡']),
    taxType: 'IVA',
    taxKeywords: Object.freeze(['IVA', 'I.V.A.', '13% IVA', 'IMPUESTO AL VALOR AGREGADO']),
    defaultTaxRate: 0.13,
    priorityBanks: Object.freeze([
      'Banco Nacional',
      'Banco de Costa Rica',
      'BAC Credomatic',
      'Banco Popular',
      'Banco Promerica',
      'Davivienda',
      'Scotiabank',
    ]),
  }),
  NI: Object.freeze({
    code: 'NI',
    name: 'Nicaragua',
    flag: '🇳🇮',
    defaultCurrency: 'NIO',
    currencyName: 'Córdobas',
    currencySymbol: 'C$',
    currencyTokens: Object.freeze(['NIO', 'CORDOBAS', 'CÓRDOBAS', 'CORDOBA', 'C$']),
    taxType: 'IVA',
    taxKeywords: Object.freeze(['IVA', 'I.V.A.', '15% IVA', 'RUC']),
    defaultTaxRate: 0.15,
    priorityBanks: Object.freeze([
      'Banpro',
      'BAC Credomatic',
      'LAFISE Bancentro',
      'BDF',
      'Banco Ficohsa',
      'Avanz',
    ]),
  }),
  PA: Object.freeze({
    code: 'PA',
    name: 'Panamá',
    flag: '🇵🇦',
    defaultCurrency: 'USD',
    currencyName: 'Balboas / Dólares',
    currencySymbol: 'B/.',
    currencyTokens: Object.freeze(['USD', 'PAB', 'BALBOAS', 'B/.', '$']),
    taxType: 'ITBMS',
    taxKeywords: Object.freeze(['ITBMS', 'I.T.B.M.S.', '7% ITBMS']),
    defaultTaxRate: 0.07,
    priorityBanks: Object.freeze([
      'Banco General',
      'Banistmo',
      'BAC Credomatic',
      'Global Bank',
      'Caja de Ahorros',
      'Banco Nacional de Panamá',
      'Multibank',
    ]),
  }),
  MX: Object.freeze({
    code: 'MX',
    name: 'México',
    flag: '🇲🇽',
    defaultCurrency: 'MXN',
    currencyName: 'Pesos Mexicanos',
    currencySymbol: '$',
    currencyTokens: Object.freeze(['MXN', 'MN', 'M.N.', 'PESOS', 'MEX$', '$']),
    taxType: 'IVA',
    taxKeywords: Object.freeze(['IVA', 'I.V.A.', '16% IVA', 'RFC', 'CFDI']),
    defaultTaxRate: 0.16,
    priorityBanks: Object.freeze([
      'BBVA México',
      'Banorte',
      'Citibanamex',
      'Santander',
      'HSBC',
      'Banco Azteca',
      'Scotiabank',
    ]),
  }),
  US: Object.freeze({
    code: 'US',
    name: 'Estados Unidos',
    flag: '🇺🇸',
    defaultCurrency: 'USD',
    currencyName: 'US Dollars',
    currencySymbol: '$',
    currencyTokens: Object.freeze(['USD', 'US$', 'DOLLARS', '$']),
    taxType: 'Sales Tax',
    taxKeywords: Object.freeze(['SALES TAX', 'TAX', 'STATE TAX']),
    defaultTaxRate: 0.08,
    priorityBanks: Object.freeze([
      'Chase',
      'Bank of America',
      'Wells Fargo',
      'Citibank',
      'Capital One',
      'American Express',
    ]),
  }),
  CO: Object.freeze({
    code: 'CO',
    name: 'Colombia',
    flag: '🇨🇴',
    defaultCurrency: 'COP',
    currencyName: 'Pesos Colombianos',
    currencySymbol: '$',
    currencyTokens: Object.freeze(['COP', 'PESOS', '$']),
    taxType: 'IVA',
    taxKeywords: Object.freeze(['IVA', '19% IVA', 'INC']),
    defaultTaxRate: 0.19,
    priorityBanks: Object.freeze(['Bancolombia', 'Davivienda', 'Banco de Bogotá', 'BBVA']),
  }),
  CL: Object.freeze({
    code: 'CL',
    name: 'Chile',
    flag: '🇨🇱',
    defaultCurrency: 'CLP',
    currencyName: 'Pesos Chilenos',
    currencySymbol: '$',
    currencyTokens: Object.freeze(['CLP', 'PESOS', '$']),
    taxType: 'IVA',
    taxKeywords: Object.freeze(['IVA', '19% IVA', 'RUT']),
    defaultTaxRate: 0.19,
    priorityBanks: Object.freeze(['Banco de Chile', 'BancoEstado', 'Santander', 'BCI']),
  }),
  AR: Object.freeze({
    code: 'AR',
    name: 'Argentina',
    flag: '🇦🇷',
    defaultCurrency: 'ARS',
    currencyName: 'Pesos Argentinos',
    currencySymbol: '$',
    currencyTokens: Object.freeze(['ARS', 'PESOS', '$']),
    taxType: 'IVA',
    taxKeywords: Object.freeze(['IVA', '21% IVA', 'CUIT']),
    defaultTaxRate: 0.21,
    priorityBanks: Object.freeze(['Banco Nación', 'Banco Galicia', 'Santander', 'BBVA']),
  }),
  ES: Object.freeze({
    code: 'ES',
    name: 'España',
    flag: '🇪🇸',
    defaultCurrency: 'EUR',
    currencyName: 'Euros',
    currencySymbol: '€',
    currencyTokens: Object.freeze(['EUR', 'EUROS', 'EURO', '€']),
    taxType: 'IVA',
    taxKeywords: Object.freeze(['IVA', '21% IVA', 'NIF', 'CIF']),
    defaultTaxRate: 0.21,
    priorityBanks: Object.freeze(['Santander', 'BBVA', 'CaixaBank', 'Sabadell']),
  }),
});

let inMemoryCurrentUserProfile = null;

/**
 * Normalizes an ISO country code (e.g., "HN", "GT", "SV", "CR", "NI", "PA", "MX", "US"),
 * defaulting to "HN" (Honduras) when empty or unrecognized.
 *
 * @param {unknown} rawCountry
 * @returns {string}
 */
export function normalizeUserCountryCode(rawCountry = DEFAULT_USER_COUNTRY) {
  return normalizeCountryCode(rawCountry);
}

/**
 * Returns the regional configuration (default currency, tax type/rate, priority banks)
 * for the specified ISO country code (defaults to "HN").
 *
 * @param {string} [country='HN']
 * @returns {typeof COUNTRY_REGIONAL_CONFIG['HN']}
 */
export function getCountryRegionalConfig(country = DEFAULT_USER_COUNTRY) {
  const code = normalizeUserCountryCode(country);
  const cfg = COUNTRY_REGIONAL_CONFIG[code] || COUNTRY_REGIONAL_CONFIG.HN;
  return {
    ...cfg,
    currency: cfg.defaultCurrency,
  };
}

/**
 * Builds and validates a `users/{uid}` profile object ensuring the `country` attribute
 * defaults to `"HN"` and supports ISO country codes.
 *
 * @param {object} userInput
 * @returns {ReturnType<typeof createUserProfile>}
 */
export function buildUserProfileSchema(userInput = {}) {
  const country = normalizeUserCountryCode(userInput?.country || DEFAULT_USER_COUNTRY);
  const regional = getCountryRegionalConfig(country);
  const resolvedDefaultCurrency =
    userInput?.defaultCurrency && CURRENCIES[userInput.defaultCurrency]
      ? String(userInput.defaultCurrency)
      : regional.defaultCurrency || 'HNL';

  return createUserProfile({
    ...userInput,
    country,
    defaultCurrency: resolvedDefaultCurrency,
  });
}

/**
 * Resolves the storage adapter (`localStorage` or injected test storage).
 * @param {object} [options]
 * @returns {Storage|null}
 */
function resolveStorage(options = {}) {
  if (options.storage !== undefined) return options.storage;
  if (options.authService && typeof options.authService.getStorageAdapter === 'function') {
    return options.authService.getStorageAdapter();
  }
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

/**
 * Reads the currently active user profile from memory, `authService`, or `localStorage`.
 *
 * @param {object} [options]
 * @returns {object|null}
 */
export function getCurrentUserProfile(options = {}) {
  if (options.authService && typeof options.authService.getCurrentProfile === 'function') {
    const svcProfile = options.authService.getCurrentProfile();
    if (svcProfile) {
      const normalized = buildUserProfileSchema(svcProfile);
      inMemoryCurrentUserProfile = normalized;
      return normalized;
    }
  }

  const storage = resolveStorage(options);
  const targetUid = String(
    options.uid ||
      options.authService?.getCurrentUser?.()?.uid ||
      inMemoryCurrentUserProfile?.uid ||
      ''
  ).trim();

  if (storage && typeof storage.getItem === 'function') {
    if (targetUid) {
      const rawDoc = storage.getItem(`${FIRESTORE_USERS_CACHE_PREFIX}${targetUid}`);
      if (rawDoc) {
        try {
          const parsed = JSON.parse(rawDoc);
          if (parsed && parsed.uid) {
            const normalized = buildUserProfileSchema(parsed);
            inMemoryCurrentUserProfile = normalized;
            return normalized;
          }
        } catch {
          // Ignore malformed JSON
        }
      }
    }

    const rawSession = storage.getItem(LOCAL_AUTH_SESSION_KEY);
    if (rawSession) {
      try {
        const sessionUser = JSON.parse(rawSession);
        if (sessionUser?.uid) {
          const rawCached = storage.getItem(`${FIRESTORE_USERS_CACHE_PREFIX}${sessionUser.uid}`);
          if (rawCached) {
            const parsedCached = JSON.parse(rawCached);
            const normalized = buildUserProfileSchema({ ...sessionUser, ...parsedCached });
            inMemoryCurrentUserProfile = normalized;
            return normalized;
          }
          const normalized = buildUserProfileSchema(sessionUser);
          inMemoryCurrentUserProfile = normalized;
          return normalized;
        }
      } catch {
        // Ignore malformed session
      }
    }
  }

  return inMemoryCurrentUserProfile;
}

/**
 * Resolves the active user's ISO `country` code (defaults to `"HN"`).
 *
 * @param {object|string} [optionsOrCountry]
 * @returns {string}
 */
export function getActiveUserCountry(optionsOrCountry = {}) {
  if (typeof optionsOrCountry === 'string' && optionsOrCountry.trim()) {
    return normalizeUserCountryCode(optionsOrCountry);
  }
  const opts = optionsOrCountry && typeof optionsOrCountry === 'object' ? optionsOrCountry : {};
  if (opts.country) {
    return normalizeUserCountryCode(opts.country);
  }
  if (opts.user?.country) {
    return normalizeUserCountryCode(opts.user.country);
  }
  if (opts.profile?.country) {
    return normalizeUserCountryCode(opts.profile.country);
  }
  if (opts.state?.user?.country) {
    return normalizeUserCountryCode(opts.state.user.country);
  }
  if (opts.state?.profile?.country) {
    return normalizeUserCountryCode(opts.state.profile.country);
  }
  const activeProfile = getCurrentUserProfile(opts);
  if (activeProfile?.country) {
    return normalizeUserCountryCode(activeProfile.country);
  }
  return DEFAULT_USER_COUNTRY;
}

/**
 * Creates or synchronizes a user document in `users/{uid}` (both in Firestore and locally),
 * ensuring `country` defaults to `"HN"` when not specified.
 *
 * @param {object} userInput
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export async function syncUserProfileDocument(userInput = {}, options = {}) {
  const uid = String(userInput?.uid || options?.uid || '').trim();
  if (!uid) {
    throw new Error('El uid del usuario es obligatorio para sincronizar users/{uid}.');
  }

  const storage = resolveStorage(options);
  const docKey = `${FIRESTORE_USERS_CACHE_PREFIX}${uid}`;
  let existingLocal = {};
  if (storage && typeof storage.getItem === 'function') {
    try {
      const raw = storage.getItem(docKey);
      if (raw) existingLocal = JSON.parse(raw) || {};
    } catch {
      existingLocal = {};
    }
  }

  const db =
    options.db ??
    options.firestoreDb ??
    options.authService?.firestoreDb ??
    null;
  const fsMod =
    options.firestoreModule ??
    options.authService?.firestoreModule ??
    null;
  const docFn = options.doc ?? fsMod?.doc;
  const getDocFn = options.getDoc ?? fsMod?.getDoc;
  const setDocFn = options.setDoc ?? fsMod?.setDoc;
  const updateDocFn = options.updateDoc ?? fsMod?.updateDoc;

  let existingRemote = {};
  let remoteDocExists = false;
  if (db && typeof docFn === 'function' && typeof getDocFn === 'function') {
    try {
      const userRef = docFn(db, 'users', uid);
      const snap = await getDocFn(userRef);
      if (snap && typeof snap.exists === 'function' && snap.exists()) {
        remoteDocExists = true;
        existingRemote = snap.data() || {};
      }
    } catch {
      remoteDocExists = false;
    }
  }

  const resolvedCountry = normalizeUserCountryCode(
    userInput.country || existingRemote.country || existingLocal.country || DEFAULT_USER_COUNTRY
  );

  const profileDoc = buildUserProfileSchema({
    ...existingLocal,
    ...existingRemote,
    ...userInput,
    uid,
    country: resolvedCountry,
  });

  inMemoryCurrentUserProfile = profileDoc;
  globalThis.__PISTO_CURRENT_USER_PROFILE__ = profileDoc;

  if (storage && typeof storage.setItem === 'function') {
    storage.setItem(docKey, JSON.stringify(profileDoc));
    storage.setItem(`pisto_profile_${uid}`, JSON.stringify(profileDoc));
  }

  if (db && typeof docFn === 'function') {
    const userRef = docFn(db, 'users', uid);
    if (remoteDocExists && !existingRemote.country && typeof updateDocFn === 'function') {
      try {
        await updateDocFn(userRef, {
          country: profileDoc.country,
          updatedAt: profileDoc.updatedAt,
        });
      } catch {
        if (typeof setDocFn === 'function') {
          try {
            await setDocFn(userRef, profileDoc, { merge: true });
          } catch {
            // Local mirror already updated
          }
        }
      }
    } else if (typeof setDocFn === 'function') {
      try {
        await setDocFn(userRef, profileDoc, { merge: true });
      } catch {
        // Local mirror already updated
      }
    }
  }

  return profileDoc;
}

/**
 * Updates the user profile in Firestore (`updateDoc(doc(db, 'users', uid), ...)`),
 * in memory (`inMemoryCurrentUserProfile`, `authService.currentProfile`, `authService.currentUser`),
 * and in `localStorage` (`pisto_firestore_users_doc_${uid}` and `pisto_auth_session_v1`).
 *
 * @param {string|object} uidOrUpdates
 * @param {object} [maybeUpdates]
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export async function updateUserProfile(uidOrUpdates, maybeUpdates = {}, options = {}) {
  const isUidFirst = typeof uidOrUpdates === 'string';
  const rawUpdates = isUidFirst ? maybeUpdates || {} : uidOrUpdates || {};
  const opts = isUidFirst ? options || {} : maybeUpdates || {};

  const authService = opts.authService || null;
  const resolvedUid = String(
    (isUidFirst ? uidOrUpdates : rawUpdates.uid) ||
      opts.uid ||
      authService?.getCurrentUser?.()?.uid ||
      authService?.getCurrentProfile?.()?.uid ||
      inMemoryCurrentUserProfile?.uid ||
      'local_default_user'
  ).trim();

  if (!resolvedUid) {
    throw new Error('El uid del usuario es obligatorio para actualizar el perfil.');
  }

  const normalizedCountry =
    rawUpdates.country !== undefined
      ? normalizeUserCountryCode(rawUpdates.country)
      : undefined;

  const regional = normalizedCountry ? getCountryRegionalConfig(normalizedCountry) : null;
  const cleanUpdates = {
    ...rawUpdates,
    ...(normalizedCountry ? { country: normalizedCountry } : {}),
    ...(regional && !rawUpdates.defaultCurrency
      ? { defaultCurrency: regional.defaultCurrency }
      : {}),
  };
  delete cleanUpdates.adaptCurrencyToCountry;

  // If authService is provided, delegate and also ensure explicit updateDoc & local sync
  if (authService && typeof authService.saveUserProfile === 'function') {
    const saved = await authService.saveUserProfile(resolvedUid, cleanUpdates);
    inMemoryCurrentUserProfile = saved;
    globalThis.__PISTO_CURRENT_USER_PROFILE__ = saved;
    if (opts.state && typeof opts.state === 'object') {
      opts.state.user = {
        ...(opts.state.user || {}),
        uid: saved.uid,
        name: saved.name,
        country: saved.country,
        defaultCurrency: saved.defaultCurrency,
      };
      opts.state.profile = saved;
    }
    return saved;
  }

  const storage = resolveStorage(opts);
  const docKey = `${FIRESTORE_USERS_CACHE_PREFIX}${resolvedUid}`;
  const legacyProfileKey = `pisto_profile_${resolvedUid}`;
  let existing = inMemoryCurrentUserProfile?.uid === resolvedUid ? inMemoryCurrentUserProfile : {};

  if (storage && typeof storage.getItem === 'function') {
    try {
      const rawCached = storage.getItem(docKey) || storage.getItem(legacyProfileKey);
      if (rawCached) {
        existing = { ...existing, ...(JSON.parse(rawCached) || {}) };
      }
    } catch {
      // Ignore parse errors
    }
  }

  const nowIso = new Date().toISOString();
  const updatedProfile = buildUserProfileSchema({
    ...existing,
    ...cleanUpdates,
    uid: resolvedUid,
    country: normalizeUserCountryCode(cleanUpdates.country || existing.country || DEFAULT_USER_COUNTRY),
    updatedAt: nowIso,
  });

  // 1. Update in-memory references
  inMemoryCurrentUserProfile = updatedProfile;
  globalThis.__PISTO_CURRENT_USER_PROFILE__ = updatedProfile;
  if (opts.state && typeof opts.state === 'object') {
    opts.state.user = {
      ...(opts.state.user || {}),
      uid: updatedProfile.uid,
      name: updatedProfile.name,
      country: updatedProfile.country,
      defaultCurrency: updatedProfile.defaultCurrency,
    };
    opts.state.profile = updatedProfile;
  }

  // 2. Persist in localStorage (`users/{uid}` cache + `pisto_profile_${uid}` + active auth session)
  if (storage && typeof storage.setItem === 'function') {
    storage.setItem(docKey, JSON.stringify(updatedProfile));
    storage.setItem(legacyProfileKey, JSON.stringify(updatedProfile));
    if (typeof storage.getItem === 'function') {
      try {
        const rawSession = storage.getItem(LOCAL_AUTH_SESSION_KEY);
        if (rawSession) {
          const parsedSession = JSON.parse(rawSession);
          if (parsedSession && (!parsedSession.uid || parsedSession.uid === resolvedUid)) {
            const updatedSession = {
              ...parsedSession,
              uid: resolvedUid,
              displayName: updatedProfile.name || parsedSession.displayName,
              country: updatedProfile.country,
              defaultCurrency: updatedProfile.defaultCurrency,
            };
            storage.setItem(LOCAL_AUTH_SESSION_KEY, JSON.stringify(updatedSession));
          }
        }
      } catch {
        // Ignore session update errors
      }
    }
  }

  // 3. Persist in Firestore (`users/{uid}`) via `updateDoc`
  const db = opts.db ?? opts.firestoreDb ?? null;
  const fsMod = opts.firestoreModule ?? null;
  const docFn = opts.doc ?? fsMod?.doc;
  const updateDocFn = opts.updateDoc ?? fsMod?.updateDoc;
  const setDocFn = opts.setDoc ?? fsMod?.setDoc;

  if (db && typeof docFn === 'function') {
    const userDocRef = docFn(db, 'users', resolvedUid);
    const firestorePayload = {
      ...cleanUpdates,
      country: updatedProfile.country,
      updatedAt: updatedProfile.updatedAt,
    };
    let updatedViaUpdateDoc = false;
    if (typeof updateDocFn === 'function') {
      try {
        await updateDocFn(userDocRef, firestorePayload);
        updatedViaUpdateDoc = true;
      } catch {
        updatedViaUpdateDoc = false;
      }
    }
    if (!updatedViaUpdateDoc && typeof setDocFn === 'function') {
      try {
        await setDocFn(userDocRef, updatedProfile, { merge: true });
      } catch {
        // Local mirror already updated
      }
    }
  }

  return updatedProfile;
}

/**
 * Service wrapper for managing User Profile & Country preferences locally and in Firestore.
 */
export class UserService {
  /**
   * @param {object} [options]
   */
  constructor(options = {}) {
    this.authService = options.authService || null;
    this.storage = resolveStorage(options);
    this.firestoreDb = options.firestoreDb ?? options.db ?? null;
    this.firestoreModule = options.firestoreModule ?? null;
    this.state = options.state || null;
  }

  getProfile(uid) {
    return getCurrentUserProfile({
      uid,
      authService: this.authService,
      storage: this.storage,
    });
  }

  getCountry() {
    return getActiveUserCountry({
      authService: this.authService,
      storage: this.storage,
      state: this.state,
    });
  }

  getRegionalConfig(country) {
    return getCountryRegionalConfig(country || this.getCountry());
  }

  async syncUser(userInput) {
    return syncUserProfileDocument(userInput, {
      authService: this.authService,
      storage: this.storage,
      firestoreDb: this.firestoreDb,
      firestoreModule: this.firestoreModule,
    });
  }

  async updateProfile(uidOrUpdates, maybeUpdates = {}) {
    return updateUserProfile(uidOrUpdates, maybeUpdates, {
      authService: this.authService,
      storage: this.storage,
      firestoreDb: this.firestoreDb,
      firestoreModule: this.firestoreModule,
      state: this.state,
    });
  }
}

export { SUPPORTED_COUNTRIES, createUserProfile };
