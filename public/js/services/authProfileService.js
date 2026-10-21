/**
 * @fileoverview Firebase Auth, Firestore Profile Persistence (`users/{uid}`) & Local Gemini API Key Service.
 *
 * Implements:
 * 1. Firebase Auth: Google Sign-In + Email/Password Sign-In & Registration with Local-First Free-Tier Fallback.
 * 2. Firestore Persistence: Reads and writes user profile documents in `users/{uid}` (`setDoc(..., { merge: true })`, `getDoc`).
 * 3. Browser-Only Gemini API Key Storage: Persists user's Google AI Studio API Key strictly in `localStorage`
 *    so Genkit AI calls use the user's own key without backend key costs or cloud database exposure.
 * 4. Personal View Mode & Default Currency Filtering: Filters transactions by `ownerUid` and `currency`.
 */

import { CURRENCIES } from '../domain/models.js';
import {
  CUSTOM_FIREBASE_CONFIG_STORAGE_KEY,
  LEGACY_FIREBASE_CONFIG_STORAGE_KEY,
  defaultFirebaseConfig,
  getDefaultFirebaseConfig,
  isValidFirebaseConfig,
  normalizeFirebaseConfig,
  getCustomFirebaseConfig,
  getFirebaseConfigSource,
  getFirebaseConfig,
  isLiveFirebaseCredentials,
  registerFirebaseSdkAdapter,
  getApps,
  getApp,
  initializeFirebaseApp,
  onFirebaseConfigUpdated,
  updateFirebaseConfig,
} from './firebase.js';
import { migrateTransactionsToSharedWorkspace } from './transactions.js';

export {
  CUSTOM_FIREBASE_CONFIG_STORAGE_KEY,
  defaultFirebaseConfig,
  getDefaultFirebaseConfig,
  isValidFirebaseConfig,
  normalizeFirebaseConfig,
  getCustomFirebaseConfig,
  getFirebaseConfigSource,
  getFirebaseConfig,
  isLiveFirebaseCredentials,
  registerFirebaseSdkAdapter,
  getApps,
  getApp,
  initializeFirebaseApp,
  onFirebaseConfigUpdated,
  updateFirebaseConfig,
  migrateTransactionsToSharedWorkspace,
};

export const GEMINI_API_KEY_STORAGE_KEY = 'pisto_user_gemini_api_key_v1';
export const FIREBASE_CONFIG_STORAGE_KEY = LEGACY_FIREBASE_CONFIG_STORAGE_KEY;
export const PRIVACY_CONSENT_STORAGE_KEY = 'pisto_privacy_consent_v1';
export const LOCAL_AUTH_SESSION_KEY = 'pisto_auth_session_v1';
export const LOCAL_USERS_DB_KEY = 'pisto_local_users_auth_v1';
export const FIRESTORE_USERS_CACHE_PREFIX = 'pisto_firestore_users_doc_';
export const FIRESTORE_WORKSPACES_CACHE_PREFIX = 'pisto_firestore_workspaces_doc_';
export const FIRESTORE_EMAIL_WORKSPACE_PREFIX = 'pisto_workspace_by_email_';

export const SUPPORTED_COUNTRIES = Object.freeze([
  { code: 'HN', name: 'Honduras', flag: '🇭🇳', defaultCurrency: 'HNL' },
  { code: 'US', name: 'Estados Unidos', flag: '🇺🇸', defaultCurrency: 'USD' },
  { code: 'CR', name: 'Costa Rica', flag: '🇨🇷', defaultCurrency: 'CRC' },
  { code: 'MX', name: 'México', flag: '🇲🇽', defaultCurrency: 'MXN' },
  { code: 'GT', name: 'Guatemala', flag: '🇬🇹', defaultCurrency: 'USD' },
  { code: 'SV', name: 'El Salvador', flag: '🇸🇻', defaultCurrency: 'USD' },
  { code: 'NI', name: 'Nicaragua', flag: '🇳🇮', defaultCurrency: 'USD' },
  { code: 'PA', name: 'Panamá', flag: '🇵🇦', defaultCurrency: 'USD' },
  { code: 'CO', name: 'Colombia', flag: '🇨🇴', defaultCurrency: 'COP' },
  { code: 'CL', name: 'Chile', flag: '🇨🇱', defaultCurrency: 'CLP' },
  { code: 'AR', name: 'Argentina', flag: '🇦🇷', defaultCurrency: 'ARS' },
  { code: 'ES', name: 'España', flag: '🇪🇸', defaultCurrency: 'EUR' },
]);

/**
 * Formats a detailed diagnostic error message containing both `error.code` and `error.message`
 * plus actionable remediation advice for common Firebase Auth issues.
 * @param {string} errorCode
 * @param {string} errorMessage
 */
export function formatFirebaseAuthDiagnosticMessage(errorCode, errorMessage) {
  const code = String(errorCode || 'auth/unknown-error').trim();
  const msg = String(errorMessage || 'Error desconocido de Firebase Auth.').trim();

  const hints = {
    'auth/unauthorized-domain':
      'El dominio actual no está autorizado en Firebase. Agrégalo en Firebase Console > Authentication > Settings > Authorized domains.',
    'auth/popup-blocked':
      'El navegador bloqueó la ventana emergente de Google. Permite popups para este sitio e intenta de nuevo.',
    'auth/popup-closed-by-user':
      'La ventana emergente de Google fue cerrada antes de completar el inicio de sesión.',
    'auth/cancelled-popup-request':
      'Ya hay una solicitud de ventana emergente en curso.',
    'auth/configuration-not-found':
      'El proveedor de Google o la configuración de Firebase Auth no está habilitada. Revisa Firebase Console > Authentication > Sign-in method o tus credenciales Firebase.',
    'auth/operation-not-allowed':
      'El inicio de sesión con Google no está habilitado en tu proyecto de Firebase Console > Authentication > Sign-in method.',
    'auth/invalid-api-key':
      'La API Key de Firebase configurada no es válida. Verifica tus credenciales en la pestaña Perfil.',
  };

  const hint = hints[code] ? ` (${hints[code]})` : '';
  return `[${code}] ${msg}${hint}`;
}

/**
 * Pure factory that builds and validates a UserProfile entity for `users/{uid}`.
 * @param {object} input
 */
export function createUserProfile(input) {
  const uid = String(input?.uid || '').trim();
  if (!uid) {
    throw new Error('El identificador de usuario (uid) es obligatorio.');
  }

  const nowIso = new Date().toISOString();
  const cleanDisplayName =
    String(input.displayName || input.name || 'Usuario Catracho').trim().slice(0, 80) ||
    'Usuario Catracho';
  const cleanName =
    String(input.name || input.displayName || cleanDisplayName).trim().slice(0, 80) ||
    cleanDisplayName;
  const cleanEmail = String(input.email || '').trim().toLowerCase().slice(0, 120);
  const cleanPhotoURL = String(input.photoURL || '').trim().slice(0, 500);
  const validCountry = SUPPORTED_COUNTRIES.some((c) => c.code === input.country)
    ? String(input.country)
    : 'HN';
  const validCurrency = input.defaultCurrency && CURRENCIES[input.defaultCurrency]
    ? String(input.defaultCurrency)
    : 'HNL';
  const defaultWorkspaceId = `ws_${uid}`;
  const cleanWorkspaceId =
    String(
      input.workspaceId && input.workspaceId !== 'ws_default'
        ? input.workspaceId
        : defaultWorkspaceId
    )
      .trim()
      .slice(0, 80) || defaultWorkspaceId;
  const cleanSharedEmails = Array.isArray(input.sharedWithEmails)
    ? Array.from(
        new Set(
          input.sharedWithEmails
            .map((e) => String(e || '').trim().toLowerCase())
            .filter(Boolean)
        )
      )
    : [];

  return {
    uid,
    email: cleanEmail,
    name: cleanName,
    displayName: cleanDisplayName,
    photoURL: cleanPhotoURL,
    country: validCountry,
    defaultCurrency: validCurrency,
    personalViewMode: Boolean(input.personalViewMode ?? false),
    filterByDefaultCurrency: Boolean(input.filterByDefaultCurrency ?? true),
    hasCompletedOnboarding: Boolean(input.hasCompletedOnboarding ?? false),
    workspaceId: cleanWorkspaceId,
    sharedWithEmails: cleanSharedEmails,
    createdAt: input.createdAt || nowIso,
    updatedAt: input.updatedAt || nowIso,
  };
}

/**
 * Determines whether a user profile requires the First-Time Onboarding Wizard.
 * Returns `true` when `hasCompletedOnboarding` is `false` or does not exist.
 * @param {object|null|undefined} profile
 * @returns {boolean}
 */
export function shouldTriggerOnboarding(profile) {
  if (!profile || typeof profile !== 'object') return false;
  return profile.hasCompletedOnboarding !== true;
}

/**
 * Guarantees that the initial Firestore and local state for a first-time user's `workspaceId`
 * is completely CLEAN (0 accounts, 0 transactions, 0 budgets).
 *
 * @param {object} [options]
 * @param {string} [options.workspaceId]
 * @param {string} [options.uid]
 * @param {object} [options.state]
 * @param {any} [options.repo]
 * @param {any} [options.storage]
 * @param {any} [options.firestoreDb]
 * @param {any} [options.firestoreModule]
 */
export async function ensureCleanWorkspaceForFirstTimeUser(options = {}) {
  const {
    workspaceId = 'ws_default',
    uid = 'local_default_user',
    state = null,
    repo = null,
    storage = typeof localStorage !== 'undefined' ? localStorage : null,
    firestoreDb = null,
    firestoreModule = null,
  } = options;

  // 1. Clean in-memory application state (0 accounts, 0 transactions, 0 budgets)
  if (state && typeof state === 'object') {
    state.accounts = [];
    state.transactions = [];
    state.budgets = {};
    if (Array.isArray(state.categories)) {
      state.categories = state.categories.map((cat) => ({
        ...cat,
        defaultBudget: 0,
      }));
    }
    if (state.settings && typeof state.settings === 'object') {
      state.settings.workspaceId = workspaceId;
      state.settings.currentUid = uid;
    }
    if (repo && typeof repo.saveState === 'function') {
      repo.saveState(state);
    }
  }

  // 2. Clean local storage workspace caches
  if (storage && typeof storage.removeItem === 'function') {
    storage.removeItem(`pisto_firestore_accounts_ws_${workspaceId}`);
    storage.removeItem(`pisto_firestore_transactions_ws_${workspaceId}`);
    storage.removeItem(`pisto_firestore_budgets_ws_${workspaceId}`);
  }

  // 3. Clean Firestore collections (`accounts`, `transactions`, `budgets`) for `workspaceId` if present
  let deletedDocsCount = 0;
  if (
    firestoreDb &&
    firestoreModule &&
    typeof firestoreModule.collection === 'function' &&
    typeof firestoreModule.query === 'function' &&
    typeof firestoreModule.where === 'function' &&
    typeof firestoreModule.getDocs === 'function'
  ) {
    const collectionsToClean = ['accounts', 'transactions', 'budgets'];
    for (const colName of collectionsToClean) {
      try {
        const colRef = firestoreModule.collection(firestoreDb, colName);
        const q = firestoreModule.query(
          colRef,
          firestoreModule.where('workspaceId', '==', workspaceId)
        );
        const snap = await firestoreModule.getDocs(q);
        const docs = Array.isArray(snap?.docs) ? snap.docs : [];
        if (docs.length > 0) {
          if (typeof firestoreModule.writeBatch === 'function') {
            const batch = firestoreModule.writeBatch(firestoreDb);
            for (const d of docs) {
              const docRef =
                d.ref ||
                (typeof firestoreModule.doc === 'function'
                  ? firestoreModule.doc(firestoreDb, colName, d.id)
                  : null);
              if (docRef) {
                batch.delete(docRef);
                deletedDocsCount += 1;
              }
            }
            await batch.commit();
          } else if (typeof firestoreModule.deleteDoc === 'function') {
            for (const d of docs) {
              const docRef =
                d.ref ||
                (typeof firestoreModule.doc === 'function'
                  ? firestoreModule.doc(firestoreDb, colName, d.id)
                  : null);
              if (docRef) {
                await firestoreModule.deleteDoc(docRef);
                deletedDocsCount += 1;
              }
            }
          }
        }
      } catch {
        // Ignore offline Firestore cleanup errors
      }
    }
  }

  return {
    cleaned: true,
    workspaceId,
    accountsCount: 0,
    transactionsCount: 0,
    budgetsCount: 0,
    deletedDocsCount,
  };
}

/**
 * Marks `hasCompletedOnboarding: true` in Firestore `users/{uid}` and updates currency/country preferences.
 *
 * @param {string} uid
 * @param {object} [options]
 * @param {string} [options.defaultCurrency]
 * @param {string} [options.country]
 * @param {any} [options.authService]
 * @param {any} [options.firestoreDb]
 * @param {any} [options.firestoreModule]
 * @param {any} [options.storage]
 */
export async function completeUserOnboarding(uid, options = {}) {
  const cleanUid = String(uid || '').trim();
  if (!cleanUid) {
    throw new Error('El uid del usuario es obligatorio para completar el onboarding.');
  }

  const defaultCurrency = options.defaultCurrency && CURRENCIES[options.defaultCurrency]
    ? String(options.defaultCurrency)
    : 'HNL';
  const country = SUPPORTED_COUNTRIES.some((c) => c.code === options.country)
    ? String(options.country)
    : 'HN';
  const nowIso = new Date().toISOString();

  if (options.authService && typeof options.authService.saveUserProfile === 'function') {
    return await options.authService.saveUserProfile(cleanUid, {
      hasCompletedOnboarding: true,
      defaultCurrency,
      country,
    });
  }

  const payload = {
    uid: cleanUid,
    hasCompletedOnboarding: true,
    defaultCurrency,
    country,
    updatedAt: nowIso,
  };

  if (
    options.firestoreDb &&
    options.firestoreModule &&
    typeof options.firestoreModule.doc === 'function' &&
    typeof options.firestoreModule.setDoc === 'function'
  ) {
    const userDocRef = options.firestoreModule.doc(options.firestoreDb, 'users', cleanUid);
    await options.firestoreModule.setDoc(userDocRef, payload, { merge: true });
  }

  const storage = options.storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  if (storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function') {
    const docKey = `${FIRESTORE_USERS_CACHE_PREFIX}${cleanUid}`;
    let existing = {};
    try {
      const raw = storage.getItem(docKey);
      if (raw) existing = JSON.parse(raw) || {};
    } catch {
      existing = {};
    }
    const merged = createUserProfile({
      ...existing,
      ...payload,
      uid: cleanUid,
    });
    storage.setItem(docKey, JSON.stringify(merged));
    return merged;
  }

  return createUserProfile(payload);
}

/**
 * Builds a lightweight Local-First in-memory index by `workspaceId` and `createdByUid`
 * so Dashboard and Ledger queries avoid repeated full scans when switching views.
 * @param {Array<object>} transactions
 */
export function buildWorkspaceTransactionIndex(transactions) {
  const byWorkspace = new Map();
  const byCreator = new Map();

  for (const tx of transactions || []) {
    const wsId = String(tx.workspaceId || 'ws_default');
    const creatorUid = String(tx.createdByUid || tx.ownerUid || 'local_default_user');

    let wsList = byWorkspace.get(wsId);
    if (!wsList) {
      wsList = [];
      byWorkspace.set(wsId, wsList);
    }
    wsList.push(tx);

    let creatorList = byCreator.get(creatorUid);
    if (!creatorList) {
      creatorList = [];
      byCreator.set(creatorUid, creatorList);
    }
    creatorList.push(tx);
  }

  return { byWorkspace, byCreator };
}

/**
 * Filters transactions according to the active user profile & Shared Family Finances settings:
 * - If `personalViewMode` is `true` (ACTIVO) and `currentUid` is present:
 *   keeps ONLY transactions where `createdByUid === currentUid`.
 * - If `personalViewMode` is `false` (INACTIVO):
 *   keeps ALL transactions belonging to the active `workspaceId`.
 * - If `currencyFilter` is set (and not `'all'`), keeps only transactions matching that currency.
 * @param {Array<object>} transactions
 * @param {object} [options]
 */
export function filterTransactionsForUserView(transactions, options = {}) {
  const {
    currentUid = null,
    workspaceId = null,
    personalViewMode = false,
    currencyFilter = 'all',
  } = options;

  const index = buildWorkspaceTransactionIndex(transactions);

  let candidates;
  if (personalViewMode && currentUid) {
    candidates = index.byCreator.get(currentUid) || [];
  } else if (workspaceId && workspaceId !== 'all') {
    candidates = index.byWorkspace.get(workspaceId) || [];
  } else {
    candidates = transactions || [];
  }

  return candidates.filter((tx) => {
    if (currencyFilter && currencyFilter !== 'all') {
      if (tx.currency !== currencyFilter) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Browser-only storage manager for the user's Google AI Studio Gemini API Key.
 * Never persisted to Firestore or server databases.
 */
export class GeminiKeyLocalStore {
  constructor(storageBackend = typeof localStorage !== 'undefined' ? localStorage : null) {
    this.storage = storageBackend;
    this.memoryKey = '';
  }

  getApiKey() {
    if (this.storage) {
      return String(this.storage.getItem(GEMINI_API_KEY_STORAGE_KEY) || '').trim();
    }
    return this.memoryKey;
  }

  setApiKey(apiKey) {
    const clean = String(apiKey || '').trim();
    if (this.storage) {
      if (clean) {
        this.storage.setItem(GEMINI_API_KEY_STORAGE_KEY, clean);
      } else {
        this.storage.removeItem(GEMINI_API_KEY_STORAGE_KEY);
      }
    } else {
      this.memoryKey = clean;
    }
  }

  hasApiKey() {
    return this.getApiKey().length >= 10;
  }
}

/**
 * Service managing Firebase Auth (Google + Email/Password) and Firestore `users/{uid}` persistence.
 */
export class FirebaseAuthProfileService {
  constructor(storageBackend = typeof localStorage !== 'undefined' ? localStorage : null) {
    this.storage = storageBackend;
    this.memoryStore = new Map();
    this.authListeners = new Set();
    this.currentUser = null;
    this.currentProfile = null;
    this.firebaseApp = null;
    this.firebaseAuth = null;
    this.firestoreDb = null;
    this.firestoreModule = null;
    this.authModule = null;
    this.geminiKeyStore = new GeminiKeyLocalStore(storageBackend);
  }

  getItem(key) {
    if (this.storage) return this.storage.getItem(key);
    return this.memoryStore.get(key) ?? null;
  }

  setItem(key, value) {
    if (this.storage) {
      this.storage.setItem(key, value);
    } else {
      this.memoryStore.set(key, value);
    }
  }

  removeItem(key) {
    if (this.storage) {
      this.storage.removeItem(key);
    } else {
      this.memoryStore.delete(key);
    }
  }

  getStorageAdapter() {
    return {
      length: 0,
      clear: () => {
        this.memoryStore.clear();
      },
      key: () => null,
      getItem: (k) => this.getItem(k),
      setItem: (k, v) => this.setItem(k, v),
      removeItem: (k) => this.removeItem(k),
    };
  }

  getFirebaseConfig() {
    return getFirebaseConfig(this.getStorageAdapter());
  }

  getCustomFirebaseConfig() {
    return getCustomFirebaseConfig(this.getStorageAdapter());
  }

  getFirebaseConfigSource() {
    return getFirebaseConfigSource(this.getStorageAdapter());
  }

  hasCustomFirebaseConfig() {
    return Boolean(this.getCustomFirebaseConfig());
  }

  async updateFirebaseConfig(userConfig) {
    const result = await updateFirebaseConfig(userConfig, {
      storage: this.getStorageAdapter(),
    });
    this.firebaseApp = result.app;

    if (!isLiveFirebaseCredentials(result.config)) {
      this.firebaseAuth = null;
      this.firestoreDb = null;
    } else if (this.authModule && this.firestoreModule) {
      try {
        this.firebaseAuth = this.authModule.getAuth(this.firebaseApp);
        this.firestoreDb = this.firestoreModule.getFirestore(this.firebaseApp);
      } catch {
        // Keep Local-First fallback if remote SDK re-binding fails
      }
    }

    return result;
  }

  saveFirebaseConfig(config) {
    void this.updateFirebaseConfig(config);
  }

  isLiveFirebaseConfigured() {
    const cfg = this.getFirebaseConfig();
    return Boolean(isLiveFirebaseCredentials(cfg) && this.firebaseAuth && this.firestoreDb);
  }

  async init() {
    const { app, config } = await initializeFirebaseApp({
      storage: this.getStorageAdapter(),
    });
    this.firebaseApp = app;

    if (isLiveFirebaseCredentials(config) && typeof window !== 'undefined') {
      try {
        const [appMod, authMod, firestoreMod] = await Promise.all([
          import('https://www.gstatic.com/firebasejs/11.4.0/firebase-app.js'),
          import('https://www.gstatic.com/firebasejs/11.4.0/firebase-auth.js'),
          import('https://www.gstatic.com/firebasejs/11.4.0/firebase-firestore.js'),
        ]);

        registerFirebaseSdkAdapter(appMod);
        const liveInit = await initializeFirebaseApp({
          storage: this.getStorageAdapter(),
          sdk: appMod,
        });
        this.firebaseApp = liveInit.app;
        this.firebaseAuth = authMod.getAuth(this.firebaseApp);
        this.firestoreDb = firestoreMod.getFirestore(this.firebaseApp);
        this.authModule = authMod;
        this.firestoreModule = firestoreMod;

        return await new Promise((resolve) => {
          let resolvedOnce = false;
          authMod.onAuthStateChanged(this.firebaseAuth, async (fbUser) => {
            if (fbUser) {
              const authUser = {
                uid: fbUser.uid,
                email: fbUser.email || '',
                displayName: fbUser.displayName || fbUser.email?.split('@')[0] || 'Usuario Pisto',
                photoURL: fbUser.photoURL || '',
                provider: fbUser.providerData?.[0]?.providerId === 'google.com' ? 'google' : 'password',
                emailVerified: Boolean(fbUser.emailVerified),
              };
              this.currentUser = authUser;
              this.currentProfile = await this.loadUserProfile(authUser.uid, {
                email: authUser.email,
                name: authUser.displayName,
              });
            } else {
              this.currentUser = null;
              this.currentProfile = null;
            }
            this.notifyListeners();
            if (!resolvedOnce) {
              resolvedOnce = true;
              resolve({ user: this.currentUser, profile: this.currentProfile });
            }
          });
        });
      } catch {
        // Usando motor Local-First Free Tier para Auth/Firestore
      }
    }

    const rawSession = this.getItem(LOCAL_AUTH_SESSION_KEY);
    if (rawSession) {
      try {
        const parsedUser = JSON.parse(rawSession);
        if (parsedUser && parsedUser.uid) {
          this.currentUser = parsedUser;
          this.currentProfile = await this.loadUserProfile(parsedUser.uid, {
            email: parsedUser.email,
            name: parsedUser.displayName,
          });
        }
      } catch {
        this.currentUser = null;
        this.currentProfile = null;
      }
    }

    this.notifyListeners();
    return { user: this.currentUser, profile: this.currentProfile };
  }

  onAuthChange(listener) {
    this.authListeners.add(listener);
    return () => this.authListeners.delete(listener);
  }

  notifyListeners() {
    for (const listener of this.authListeners) {
      listener(this.currentUser, this.currentProfile);
    }
  }

  getCurrentUser() {
    return this.currentUser;
  }

  getCurrentProfile() {
    return this.currentProfile;
  }

  getFirestoreContext() {
    return {
      firestoreDb: this.firestoreDb,
      firestoreModule: this.firestoreModule,
      storage: this.getStorageAdapter(),
    };
  }

  /**
   * Allows injecting Firebase Auth & Firestore runtime adapters in unit tests.
   */
  setFirebaseRuntimeForTesting(runtime) {
    if (runtime.firebaseAuth !== undefined) this.firebaseAuth = runtime.firebaseAuth;
    if (runtime.authModule !== undefined) this.authModule = runtime.authModule;
    if (runtime.firestoreDb !== undefined) this.firestoreDb = runtime.firestoreDb;
    if (runtime.firestoreModule !== undefined) this.firestoreModule = runtime.firestoreModule;
  }

  /**
   * Ensures Firebase Auth & Firestore SDKs are initialized when running in the browser with live credentials.
   * Throws an explicit `auth/configuration-not-found` error if Firebase credentials are not configured.
   */
  async ensureFirebaseAuthSdkLoaded() {
    if (this.firebaseAuth && (this.authModule || this.firebaseAuthModule)) {
      return;
    }

    let config = this.getFirebaseConfig();
    if (!isLiveFirebaseCredentials(config) && typeof window !== 'undefined' && typeof fetch === 'function') {
      try {
        const res = await fetch('/api/config/firebase');
        if (res.ok) {
          const data = await res.json();
          if (data?.config && isValidFirebaseConfig(data.config)) {
            globalThis.__PISTO_FIREBASE_CONFIG__ = data.config;
            config = this.getFirebaseConfig();
          }
        }
      } catch {
        // Ignore fetch errors in offline mode
      }
    }

    if (!isLiveFirebaseCredentials(config)) {
      const cfgError = new Error(
        'No se encontró una configuración activa de Firebase Auth (credenciales por defecto de demostración activas). Configura las credenciales de tu proyecto Firebase en la pestaña Perfil o usa "🚀 Probar Modo Demo".'
      );
      cfgError.code = 'auth/configuration-not-found';
      throw cfgError;
    }

    if (typeof window !== 'undefined') {
      const [appMod, authMod, firestoreMod] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/11.4.0/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/11.4.0/firebase-auth.js'),
        import('https://www.gstatic.com/firebasejs/11.4.0/firebase-firestore.js'),
      ]);

      registerFirebaseSdkAdapter(appMod);
      const liveInit = await initializeFirebaseApp({
        storage: this.getStorageAdapter(),
        sdk: appMod,
      });
      this.firebaseApp = liveInit.app;
      this.firebaseAuth = authMod.getAuth(this.firebaseApp);
      this.firestoreDb = firestoreMod.getFirestore(this.firebaseApp);
      this.authModule = authMod;
      this.firestoreModule = firestoreMod;
    }
  }

  /**
   * Synchronizes the authenticated Google user with Firestore `users/{user.uid}`:
   * - Checks if `users/{user.uid}` exists via `getDoc`.
   * - If it does not exist or is missing required fields (`uid`, `displayName`, `email`, `photoURL`, `createdAt`, `workspaceId`),
   *   creates/updates the document with those fields and assigns an initial `workspaceId` (user's own `uid` or `email`).
   */
  async syncGoogleUserWithFirestore(user) {
    const uid = String(user.uid || '').trim();
    const nowIso = new Date().toISOString();
    const initialWorkspaceId = uid || user.email || `ws_${uid}`;
    const docKey = `${FIRESTORE_USERS_CACHE_PREFIX}${uid}`;

    if (this.firestoreDb && this.firestoreModule) {
      try {
        const userDocRef = this.firestoreModule.doc(this.firestoreDb, 'users', uid);
        const snap = await this.firestoreModule.getDoc(userDocRef);

        if (snap.exists()) {
          const existingData = snap.data() || {};
          const hasMissingFields =
            !existingData.uid ||
            !existingData.displayName ||
            !existingData.email ||
            typeof existingData.photoURL !== 'string' ||
            !existingData.createdAt ||
            !existingData.workspaceId ||
            existingData.workspaceId === 'ws_default';

          let profile = createUserProfile({
            ...existingData,
            uid,
            displayName:
              existingData.displayName || existingData.name || user.displayName || 'Usuario Google',
            name:
              existingData.name || existingData.displayName || user.displayName || 'Usuario Google',
            email: existingData.email || user.email || '',
            photoURL: existingData.photoURL || user.photoURL || '',
            createdAt: existingData.createdAt || nowIso,
            updatedAt: nowIso,
            workspaceId:
              existingData.workspaceId && existingData.workspaceId !== 'ws_default'
                ? existingData.workspaceId
                : initialWorkspaceId,
          });

          profile = await this.resolveSharedWorkspaceForProfile(profile);

          if (hasMissingFields || profile.workspaceId !== existingData.workspaceId) {
            await this.firestoreModule.setDoc(userDocRef, profile, { merge: true });
          }

          this.setItem(docKey, JSON.stringify(profile));
          this.currentProfile = profile;
          return profile;
        }

        let newProfile = createUserProfile({
          uid,
          displayName: user.displayName || 'Usuario Google',
          name: user.displayName || 'Usuario Google',
          email: user.email || '',
          photoURL: user.photoURL || '',
          country: 'HN',
          defaultCurrency: 'HNL',
          personalViewMode: false,
          filterByDefaultCurrency: true,
          workspaceId: initialWorkspaceId,
          createdAt: nowIso,
          updatedAt: nowIso,
        });

        newProfile = await this.resolveSharedWorkspaceForProfile(newProfile);
        await this.firestoreModule.setDoc(userDocRef, newProfile, { merge: true });
        this.setItem(docKey, JSON.stringify(newProfile));
        this.currentProfile = newProfile;
        return newProfile;
      } catch {
        // Fallback a caché local
      }
    }

    return await this.loadUserProfile(uid, {
      email: user.email,
      name: user.displayName,
      displayName: user.displayName,
      photoURL: user.photoURL || '',
      workspaceId: initialWorkspaceId,
      createdAt: nowIso,
    });
  }

  /**
   * Executes Google Sign-In using `GoogleAuthProvider` (`prompt: 'select_account'`) and `signInWithPopup(auth, provider)`.
   * Wrapped in a detailed `try/catch` that logs and surfaces `error.code` and `error.message`.
   * Post-login, verifies and synchronizes `users/{user.uid}` in Firestore.
   */
  async signInWithGoogle(customGoogleAccount) {
    if (!this.firebaseAuth && !this.authModule && customGoogleAccount && typeof window === 'undefined') {
      const email = String(customGoogleAccount.email || 'usuario.google@gmail.com')
        .trim()
        .toLowerCase();
      const displayName = String(customGoogleAccount.name || 'Usuario Google').trim();
      const photoURL = String(customGoogleAccount.photoURL || '').trim();
      const uid = `uid_google_${email.replace(/[^a-z0-9]/g, '_').slice(0, 24)}`;

      const user = {
        uid,
        email,
        displayName,
        photoURL,
        provider: 'google',
        emailVerified: true,
      };

      this.setItem(LOCAL_AUTH_SESSION_KEY, JSON.stringify(user));
      this.currentUser = user;
      this.currentProfile = await this.syncGoogleUserWithFirestore(user);
      this.notifyListeners();
      return { user, profile: this.currentProfile };
    }

    try {
      const initialAuthMod = this.authModule || this.firebaseAuthModule;
      if (!this.firebaseAuth || !initialAuthMod) {
        await this.ensureFirebaseAuthSdkLoaded();
      }

      const activeAuthModule = this.authModule || this.firebaseAuthModule;
      const GoogleAuthProvider = activeAuthModule?.GoogleAuthProvider;
      const signInWithPopup = activeAuthModule?.signInWithPopup;
      if (typeof GoogleAuthProvider !== 'function' || typeof signInWithPopup !== 'function') {
        const sdkErr = new Error(
          'GoogleAuthProvider o signInWithPopup no están disponibles en la configuración actual de Firebase Auth.'
        );
        sdkErr.code = 'auth/configuration-not-found';
        throw sdkErr;
      }

      const provider = new GoogleAuthProvider();
      if (typeof provider.setCustomParameters === 'function') {
        provider.setCustomParameters({ prompt: 'select_account' });
      }

      const result = await signInWithPopup(this.firebaseAuth, provider);
      const fbUser = result?.user;
      if (!fbUser || !fbUser.uid) {
        const missingUserErr = new Error(
          'No se recibieron los datos del usuario tras completar signInWithPopup con Google.'
        );
        missingUserErr.code = 'auth/internal-error';
        throw missingUserErr;
      }

      const user = {
        uid: fbUser.uid,
        email: fbUser.email || '',
        displayName: fbUser.displayName || fbUser.email?.split('@')[0] || 'Usuario Google',
        photoURL: fbUser.photoURL || '',
        provider: 'google',
        emailVerified: Boolean(fbUser.emailVerified ?? true),
      };

      this.currentUser = user;
      this.setItem(LOCAL_AUTH_SESSION_KEY, JSON.stringify(user));
      this.currentProfile = await this.syncGoogleUserWithFirestore(user);
      this.notifyListeners();
      return { user, profile: this.currentProfile };
    } catch (error) {
      const errorCode = String(error?.code || 'auth/unknown-error');
      const errorMessage = String(
        error?.originalMessage || error?.message || 'Error desconocido al iniciar sesión con Google.'
      );
      const formattedError = new Error(
        formatFirebaseAuthDiagnosticMessage(errorCode, errorMessage)
      );
      formattedError.code = errorCode;
      formattedError.originalMessage = errorMessage;
      formattedError.cause = error;
      throw formattedError;
    }
  }

  /**
   * Activates the local Demo Mode user ("Google Catracho") explicitly when the user clicks "🚀 Probar Modo Demo".
   */
  async signInWithDemoMode(customDemoAccount) {
    const email = String(customDemoAccount?.email || 'catracho.google@gmail.com').trim().toLowerCase();
    const displayName = String(customDemoAccount?.name || 'Google Catracho (Demo)').trim();
    const uid = `uid_demo_${email.replace(/[^a-z0-9]/g, '_').slice(0, 24)}`;

    const user = {
      uid,
      email,
      displayName,
      provider: 'google',
      emailVerified: true,
    };

    this.setItem(LOCAL_AUTH_SESSION_KEY, JSON.stringify(user));
    this.currentUser = user;
    this.currentProfile = await this.loadUserProfile(uid, {
      email,
      name: displayName,
    });
    this.notifyListeners();
    return { user, profile: this.currentProfile };
  }

  async signInDemoMode(customDemoAccount) {
    return this.signInWithDemoMode(customDemoAccount);
  }

  async signInOrRegisterWithEmail(params) {
    const cleanEmail = String(params?.email || '').trim().toLowerCase();
    const password = String(params?.password || '');

    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      throw new Error('Ingresa un correo electrónico válido.');
    }
    if (password.length < 6) {
      throw new Error('La contraseña debe tener al menos 6 caracteres.');
    }

    if (this.firebaseAuth && this.authModule) {
      let fbUser;
      if (params.isRegister) {
        const cred = await this.authModule.createUserWithEmailAndPassword(
          this.firebaseAuth,
          cleanEmail,
          password
        );
        fbUser = cred.user;
        if (params.name && typeof this.authModule.updateProfile === 'function') {
          await this.authModule.updateProfile(fbUser, { displayName: params.name });
        }
      } else {
        const cred = await this.authModule.signInWithEmailAndPassword(
          this.firebaseAuth,
          cleanEmail,
          password
        );
        fbUser = cred.user;
      }

      const user = {
        uid: fbUser.uid,
        email: fbUser.email || cleanEmail,
        displayName: params.name || fbUser.displayName || cleanEmail.split('@')[0],
        provider: 'password',
        emailVerified: Boolean(fbUser.emailVerified),
      };
      this.currentUser = user;
      this.currentProfile = await this.loadUserProfile(user.uid, {
        email: user.email,
        name: user.displayName,
        country: params.country,
        defaultCurrency: params.defaultCurrency,
      });
      this.notifyListeners();
      return { user, profile: this.currentProfile };
    }

    const usersDbRaw = this.getItem(LOCAL_USERS_DB_KEY);
    const usersDb = usersDbRaw ? JSON.parse(usersDbRaw) : {};

    const existingRecord = usersDb[cleanEmail];
    const simpleHash = `h_${BufferOrBtoa(password)}`;

    if (params.isRegister) {
      if (existingRecord) {
        throw new Error('Este correo electrónico ya está registrado. Inicia sesión con tu contraseña.');
      }
      const uid = `uid_${cleanEmail.replace(/[^a-z0-9]/g, '_').slice(0, 24)}`;
      const displayName = String(params.name || cleanEmail.split('@')[0]).trim();
      usersDb[cleanEmail] = {
        uid,
        email: cleanEmail,
        passwordHash: simpleHash,
        displayName,
      };
      this.setItem(LOCAL_USERS_DB_KEY, JSON.stringify(usersDb));
    } else {
      if (!existingRecord) {
        const uid = `uid_${cleanEmail.replace(/[^a-z0-9]/g, '_').slice(0, 24)}`;
        const displayName = String(params.name || cleanEmail.split('@')[0]).trim();
        usersDb[cleanEmail] = {
          uid,
          email: cleanEmail,
          passwordHash: simpleHash,
          displayName,
        };
        this.setItem(LOCAL_USERS_DB_KEY, JSON.stringify(usersDb));
      } else if (existingRecord.passwordHash !== simpleHash) {
        throw new Error('Contraseña incorrecta para este correo electrónico.');
      }
    }

    const record = usersDb[cleanEmail];
    const user = {
      uid: record.uid,
      email: record.email,
      displayName: params.name || record.displayName,
      provider: 'password',
      emailVerified: true,
    };

    this.setItem(LOCAL_AUTH_SESSION_KEY, JSON.stringify(user));
    this.currentUser = user;
    this.currentProfile = await this.loadUserProfile(user.uid, {
      email: user.email,
      name: user.displayName,
      country: params.country,
      defaultCurrency: params.defaultCurrency,
    });
    this.notifyListeners();
    return { user, profile: this.currentProfile };
  }

  /**
   * Returns the user's privacy & LocalStorage consent state.
   */
  getPrivacyConsent() {
    const defaultState = {
      accepted: false,
      localStorageEnabled: true,
      timestamp: '',
      version: '1.0',
    };
    const raw = this.getItem(PRIVACY_CONSENT_STORAGE_KEY);
    if (!raw) return defaultState;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.accepted === 'boolean') {
        return {
          accepted: Boolean(parsed.accepted),
          localStorageEnabled: Boolean(parsed.localStorageEnabled ?? true),
          timestamp: String(parsed.timestamp || new Date().toISOString()),
          version: String(parsed.version || '1.0'),
        };
      }
    } catch {
      // Ignore malformed consent state
    }
    return defaultState;
  }

  /**
   * Persists the user's privacy & LocalStorage consent decision.
   * @param {boolean} accepted
   */
  savePrivacyConsent(accepted = true) {
    const state = {
      accepted: Boolean(accepted),
      localStorageEnabled: true,
      timestamp: new Date().toISOString(),
      version: '1.0',
    };
    this.setItem(PRIVACY_CONSENT_STORAGE_KEY, JSON.stringify(state));
    return state;
  }

  /**
   * Purges sensitive credentials (Gemini API Key and custom Firebase configurations)
   * from `localStorage` and memory to guarantee strict session isolation.
   */
  async clearSensitiveLocalStorage() {
    this.geminiKeyStore.setApiKey('');
    this.removeItem(GEMINI_API_KEY_STORAGE_KEY);
    this.removeItem(CUSTOM_FIREBASE_CONFIG_STORAGE_KEY);
    this.removeItem(LEGACY_FIREBASE_CONFIG_STORAGE_KEY);
    await this.updateFirebaseConfig(null);
  }

  async signOut() {
    if (this.firebaseAuth && this.authModule) {
      await this.authModule.signOut(this.firebaseAuth);
    }
    this.removeItem(LOCAL_AUTH_SESSION_KEY);
    await this.clearSensitiveLocalStorage();
    this.currentUser = null;
    this.currentProfile = null;
    this.notifyListeners();
  }

  isPersonalInitialWorkspace(wsId, uid, email) {
    if (!wsId || wsId === 'ws_default') return true;
    if (uid && (wsId === uid || wsId === `ws_${uid}`)) return true;
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (cleanEmail && String(wsId).toLowerCase() === cleanEmail) return true;
    return false;
  }

  async resolveSharedWorkspaceForProfile(profile) {
    const cleanEmail = String(profile.email || this.currentUser?.email || '')
      .trim()
      .toLowerCase();
    if (!cleanEmail) return profile;

    let resolvedWorkspaceId = profile.workspaceId;
    let resolvedSharedEmails = Array.isArray(profile.sharedWithEmails)
      ? [...profile.sharedWithEmails]
      : [];

    const emailIdxRaw = this.getItem(`${FIRESTORE_EMAIL_WORKSPACE_PREFIX}${cleanEmail}`);
    if (emailIdxRaw) {
      try {
        const parsedIdx = JSON.parse(emailIdxRaw);
        if (
          parsedIdx.workspaceId &&
          parsedIdx.workspaceId !== 'ws_default' &&
          this.isPersonalInitialWorkspace(resolvedWorkspaceId, profile.uid, cleanEmail)
        ) {
          resolvedWorkspaceId = parsedIdx.workspaceId;
        }
        if (Array.isArray(parsedIdx.memberEmails)) {
          resolvedSharedEmails = Array.from(
            new Set([
              ...resolvedSharedEmails,
              ...parsedIdx.memberEmails.filter((e) => e && e !== cleanEmail),
            ])
          );
        }
      } catch {
        // Ignore malformed cache
      }
    }

    if (
      this.firestoreDb &&
      this.firestoreModule &&
      typeof this.firestoreModule.collection === 'function' &&
      this.isPersonalInitialWorkspace(resolvedWorkspaceId, profile.uid, cleanEmail)
    ) {
      try {
        const wsCol = this.firestoreModule.collection(this.firestoreDb, 'workspaces');
        const wsQuery = this.firestoreModule.query(
          wsCol,
          this.firestoreModule.where('memberEmails', 'array-contains', cleanEmail)
        );
        const wsSnap = await this.firestoreModule.getDocs(wsQuery);
        if (!wsSnap.empty) {
          const wsData = wsSnap.docs[0].data();
          const foundWsId = wsData.workspaceId || wsSnap.docs[0].id;
          if (foundWsId && foundWsId !== 'ws_default') {
            resolvedWorkspaceId = foundWsId;
            if (Array.isArray(wsData.memberEmails)) {
              resolvedSharedEmails = Array.from(
                new Set([
                  ...resolvedSharedEmails,
                  ...wsData.memberEmails.filter((e) => e && e !== cleanEmail),
                ])
              );
            }
          }
        }
      } catch {
        // Fallback local
      }
    }

    if (
      resolvedWorkspaceId !== profile.workspaceId ||
      resolvedSharedEmails.length !== (profile.sharedWithEmails || []).length
    ) {
      return createUserProfile({
        ...profile,
        workspaceId: resolvedWorkspaceId,
        sharedWithEmails: resolvedSharedEmails,
        updatedAt: new Date().toISOString(),
      });
    }

    return profile;
  }

  async loadUserProfile(uid, defaults = {}) {
    const docKey = `${FIRESTORE_USERS_CACHE_PREFIX}${uid}`;

    if (this.firestoreDb && this.firestoreModule) {
      try {
        const userDocRef = this.firestoreModule.doc(this.firestoreDb, 'users', uid);
        const snap = await this.firestoreModule.getDoc(userDocRef);
        if (snap.exists()) {
          const data = snap.data();
          let profile = createUserProfile({ ...defaults, ...data, uid });
          profile = await this.resolveSharedWorkspaceForProfile(profile);
          if (profile.workspaceId !== data.workspaceId) {
            await this.firestoreModule.setDoc(userDocRef, profile, { merge: true });
          }
          this.setItem(docKey, JSON.stringify(profile));
          this.currentProfile = profile;
          return profile;
        }
        let initialProfile = createUserProfile({
          uid,
          email: defaults.email || this.currentUser?.email || '',
          name: defaults.name || defaults.displayName || this.currentUser?.displayName || 'Usuario Catracho',
          displayName: defaults.displayName || defaults.name || this.currentUser?.displayName || 'Usuario Catracho',
          photoURL: defaults.photoURL || this.currentUser?.photoURL || '',
          country: defaults.country || 'HN',
          defaultCurrency: defaults.defaultCurrency || 'HNL',
          personalViewMode: defaults.personalViewMode ?? false,
          filterByDefaultCurrency: defaults.filterByDefaultCurrency ?? true,
          workspaceId: defaults.workspaceId,
          createdAt: defaults.createdAt,
        });
        initialProfile = await this.resolveSharedWorkspaceForProfile(initialProfile);
        await this.firestoreModule.setDoc(userDocRef, initialProfile, { merge: true });
        this.setItem(docKey, JSON.stringify(initialProfile));
        this.currentProfile = initialProfile;
        return initialProfile;
      } catch {
        // Fallback a caché local
      }
    }

    const cachedRaw = this.getItem(docKey);
    if (cachedRaw) {
      try {
        const parsed = JSON.parse(cachedRaw);
        let profile = createUserProfile({ ...defaults, ...parsed, uid });
        profile = await this.resolveSharedWorkspaceForProfile(profile);
        this.setItem(docKey, JSON.stringify(profile));
        this.currentProfile = profile;
        return profile;
      } catch {
        // Fallthrough
      }
    }

    let freshProfile = createUserProfile({
      uid,
      email: defaults.email || this.currentUser?.email || '',
      name: defaults.name || defaults.displayName || this.currentUser?.displayName || 'Usuario Catracho',
      displayName: defaults.displayName || defaults.name || this.currentUser?.displayName || 'Usuario Catracho',
      photoURL: defaults.photoURL || this.currentUser?.photoURL || '',
      country: defaults.country || 'HN',
      defaultCurrency: defaults.defaultCurrency || 'HNL',
      personalViewMode: defaults.personalViewMode ?? false,
      filterByDefaultCurrency: defaults.filterByDefaultCurrency ?? true,
      workspaceId: defaults.workspaceId,
      createdAt: defaults.createdAt,
    });
    freshProfile = await this.resolveSharedWorkspaceForProfile(freshProfile);
    this.setItem(docKey, JSON.stringify(freshProfile));
    this.currentProfile = freshProfile;
    return freshProfile;
  }

  async saveUserProfile(uid, updates) {
    const existing = this.currentProfile && this.currentProfile.uid === uid
      ? this.currentProfile
      : await this.loadUserProfile(uid);

    const updatedProfile = createUserProfile({
      ...existing,
      ...updates,
      uid,
      updatedAt: new Date().toISOString(),
    });

    const docKey = `${FIRESTORE_USERS_CACHE_PREFIX}${uid}`;
    this.setItem(docKey, JSON.stringify(updatedProfile));
    this.currentProfile = updatedProfile;

    if (this.currentUser && this.currentUser.uid === uid && updatedProfile.name) {
      this.currentUser = {
        ...this.currentUser,
        displayName: updatedProfile.name,
      };
      this.setItem(LOCAL_AUTH_SESSION_KEY, JSON.stringify(this.currentUser));
    }

    if (this.firestoreDb && this.firestoreModule) {
      try {
        const userDocRef = this.firestoreModule.doc(this.firestoreDb, 'users', uid);
        await this.firestoreModule.setDoc(userDocRef, updatedProfile, { merge: true });
      } catch {
        // Guardado en mirror local (Firestore offline)
      }
    }

    this.notifyListeners();
    return updatedProfile;
  }

  /**
   * Marks the user's Onboarding Wizard as completed (`hasCompletedOnboarding: true`)
   * in Firestore `users/{uid}` and persists selected country/defaultCurrency.
   * @param {string} [uid]
   * @param {object} [options]
   */
  async completeOnboarding(uid, options = {}) {
    const targetUid =
      String(uid || this.currentUser?.uid || this.currentProfile?.uid || '').trim();
    if (!targetUid) {
      throw new Error('No se encontró un usuario activo para completar el Onboarding.');
    }
    return await this.saveUserProfile(targetUid, {
      hasCompletedOnboarding: true,
      ...(options.defaultCurrency ? { defaultCurrency: options.defaultCurrency } : {}),
      ...(options.country ? { country: options.country } : {}),
    });
  }

  /**
   * Ensures a completely clean initial workspace (0 accounts, 0 transactions, 0 budgets)
   * when `hasCompletedOnboarding` is false or missing.
   * @param {object} [options]
   */
  async ensureCleanWorkspaceForUser(options = {}) {
    const uid =
      options.uid || this.currentUser?.uid || this.currentProfile?.uid || 'local_default_user';
    const workspaceId =
      options.workspaceId || this.currentProfile?.workspaceId || `ws_${uid}`;
    return await ensureCleanWorkspaceForFirstTimeUser({
      ...options,
      uid,
      workspaceId,
      storage: options.storage ?? this.getStorageAdapter(),
      firestoreDb: options.firestoreDb ?? this.firestoreDb,
      firestoreModule: options.firestoreModule ?? this.firestoreModule,
    });
  }

  /**
   * Links the active user's financial workspace (`workspaceId`) with another registered user by email
   * ("Compartir Finanzas"), updating both `users/{uid}` profiles, `workspaces/{workspaceId}`,
   * and migrating existing member transactions to `sharedWorkspaceId`.
   * @param {string} targetEmail
   */
  async shareWorkspaceWithEmail(targetEmail) {
    const cleanTargetEmail = String(targetEmail || '').trim().toLowerCase();
    if (!cleanTargetEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanTargetEmail)) {
      throw new Error('Ingresa un correo electrónico válido para compartir el espacio financiero.');
    }

    const currentUid = this.currentUser?.uid || this.currentProfile?.uid || 'local_default_user';
    const myProfile = await this.loadUserProfile(currentUid);

    if (myProfile.email && myProfile.email.toLowerCase() === cleanTargetEmail) {
      throw new Error('No puedes compartir el espacio financiero con tu propio correo.');
    }

    // 1. Resolve target user's UID and existing profile (from Firestore or Local-First user registry)
    const usersDbRaw = this.getItem(LOCAL_USERS_DB_KEY);
    const usersDb = usersDbRaw ? JSON.parse(usersDbRaw) : {};

    let targetUid = usersDb[cleanTargetEmail]?.uid || `uid_${cleanTargetEmail.replace(/[^a-z0-9]/g, '_').slice(0, 24)}`;
    let targetExistingProfile = null;

    if (this.firestoreDb && this.firestoreModule) {
      try {
        const usersCol = this.firestoreModule.collection(this.firestoreDb, 'users');
        const q = this.firestoreModule.query(usersCol, this.firestoreModule.where('email', '==', cleanTargetEmail));
        const querySnap = await this.firestoreModule.getDocs(q);
        if (!querySnap.empty) {
          const docSnap = querySnap.docs[0];
          targetUid = docSnap.id;
          targetExistingProfile = createUserProfile({ ...docSnap.data(), uid: targetUid });
        }
      } catch {
        // Búsqueda local de usuario
      }
    }

    if (!targetExistingProfile) {
      const targetDocRaw = this.getItem(`${FIRESTORE_USERS_CACHE_PREFIX}${targetUid}`);
      if (targetDocRaw) {
        try {
          targetExistingProfile = createUserProfile({
            ...JSON.parse(targetDocRaw),
            uid: targetUid,
          });
        } catch {
          targetExistingProfile = null;
        }
      }
    }

    // 2. Determine shared workspaceId
    let sharedWorkspaceId = myProfile.workspaceId;
    if (this.isPersonalInitialWorkspace(sharedWorkspaceId, currentUid, myProfile.email)) {
      if (
        targetExistingProfile?.workspaceId &&
        !this.isPersonalInitialWorkspace(
          targetExistingProfile.workspaceId,
          targetUid,
          cleanTargetEmail
        )
      ) {
        sharedWorkspaceId = targetExistingProfile.workspaceId;
      } else {
        const cleanSlug = currentUid.replace(/^uid_/, '').replace(/[^a-z0-9]/g, '').slice(0, 12) || 'hogar';
        sharedWorkspaceId = `ws_fam_${cleanSlug}`;
      }
    }

    const combinedEmails = Array.from(
      new Set([
        ...(myProfile.sharedWithEmails || []),
        ...(targetExistingProfile?.sharedWithEmails || []),
        cleanTargetEmail,
        ...(myProfile.email ? [myProfile.email.toLowerCase()] : []),
      ])
    );

    const mySharedList = combinedEmails.filter((e) => e !== myProfile.email?.toLowerCase());
    const targetSharedList = combinedEmails.filter((e) => e !== cleanTargetEmail);

    // 3. Persist target user's linked workspace profile
    const nowIso = new Date().toISOString();
    const updatedTargetProfile = createUserProfile({
      ...(targetExistingProfile || {
        uid: targetUid,
        email: cleanTargetEmail,
        name: cleanTargetEmail.split('@')[0],
      }),
      uid: targetUid,
      email: cleanTargetEmail,
      workspaceId: sharedWorkspaceId,
      sharedWithEmails: targetSharedList,
      updatedAt: nowIso,
    });
    this.setItem(`${FIRESTORE_USERS_CACHE_PREFIX}${targetUid}`, JSON.stringify(updatedTargetProfile));

    for (const memberEmail of combinedEmails) {
      const normalizedEmail = String(memberEmail || '').trim().toLowerCase();
      if (!normalizedEmail) continue;
      this.setItem(
        `${FIRESTORE_EMAIL_WORKSPACE_PREFIX}${normalizedEmail}`,
        JSON.stringify({
          workspaceId: sharedWorkspaceId,
          memberEmails: combinedEmails,
          updatedAt: nowIso,
        })
      );
    }

    if (this.firestoreDb && this.firestoreModule) {
      try {
        const targetRef = this.firestoreModule.doc(this.firestoreDb, 'users', targetUid);
        await this.firestoreModule.setDoc(
          targetRef,
          {
            workspaceId: sharedWorkspaceId,
            sharedWithEmails: targetSharedList,
            updatedAt: nowIso,
          },
          { merge: true }
        );
      } catch {
        // Guardado local de vínculo familiar
      }
    }

    // 4. Persist workspace document in `workspaces/{workspaceId}`
    const workspaceDoc = {
      workspaceId: sharedWorkspaceId,
      ownerUid: currentUid,
      memberUids: Array.from(new Set([currentUid, targetUid])),
      memberEmails: combinedEmails,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.setItem(`${FIRESTORE_WORKSPACES_CACHE_PREFIX}${sharedWorkspaceId}`, JSON.stringify(workspaceDoc));

    if (this.firestoreDb && this.firestoreModule) {
      try {
        const wsRef = this.firestoreModule.doc(this.firestoreDb, 'workspaces', sharedWorkspaceId);
        await this.firestoreModule.setDoc(wsRef, workspaceDoc, { merge: true });
      } catch {
        // Guardado local de workspace
      }
    }

    // 5. Migrate existing member transactions to the shared workspaceId
    await migrateTransactionsToSharedWorkspace(
      sharedWorkspaceId,
      [currentUid, targetUid],
      combinedEmails,
      this.storage,
      this.firestoreDb,
      this.firestoreModule
    );

    // 6. Save current user's profile with the shared workspaceId
    const updatedMyProfile = await this.saveUserProfile(currentUid, {
      workspaceId: sharedWorkspaceId,
      sharedWithEmails: mySharedList,
    });

    return {
      workspaceId: sharedWorkspaceId,
      profile: updatedMyProfile,
      linkedEmail: cleanTargetEmail,
    };
  }

  /**
   * Removes a shared member email from the current user's shared list.
   * @param {string} emailToRemove
   */
  async unlinkSharedMember(emailToRemove) {
    const cleanRemove = String(emailToRemove || '').trim().toLowerCase();
    const currentUid = this.currentUser?.uid || this.currentProfile?.uid || 'local_default_user';
    const myProfile = await this.loadUserProfile(currentUid);
    const nextShared = (myProfile.sharedWithEmails || []).filter((e) => e !== cleanRemove);
    return await this.saveUserProfile(currentUid, {
      sharedWithEmails: nextShared,
    });
  }

  generateAlphanumericInviteCode(length = 7) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let token = '';
    for (let i = 0; i < length; i += 1) {
      const randIdx = Math.floor(Math.random() * alphabet.length);
      token += alphabet[randIdx];
    }
    return token;
  }

  async ensureOrGenerateWorkspaceToken(options = {}) {
    const regenerate = Boolean(options.regenerate);
    const currentUid = this.currentUser?.uid || this.currentProfile?.uid || 'local_default_user';
    const myProfile = await this.loadUserProfile(currentUid);
    const cleanEmail = String(myProfile.email || this.currentUser?.email || '')
      .trim()
      .toLowerCase();
    const workspaceId =
      myProfile.workspaceId && myProfile.workspaceId !== 'ws_default'
        ? myProfile.workspaceId
        : currentUid;

    const nowIso = new Date().toISOString();
    let existingDoc = null;

    if (
      this.firestoreDb &&
      this.firestoreModule &&
      typeof this.firestoreModule.doc === 'function' &&
      typeof this.firestoreModule.getDoc === 'function'
    ) {
      try {
        const wsRef = this.firestoreModule.doc(this.firestoreDb, 'workspaces', workspaceId);
        const snap = await this.firestoreModule.getDoc(wsRef);
        if (snap.exists()) {
          existingDoc = snap.data();
        }
      } catch {
        // Lectura local
      }
    }

    if (!existingDoc) {
      const cachedRaw = this.getItem(`${FIRESTORE_WORKSPACES_CACHE_PREFIX}${workspaceId}`);
      if (cachedRaw) {
        try {
          existingDoc = JSON.parse(cachedRaw);
        } catch {
          existingDoc = null;
        }
      }
    }

    const baseMembers = Array.isArray(existingDoc?.members) ? [...existingDoc.members] : [];
    if (currentUid && !baseMembers.includes(currentUid)) {
      baseMembers.push(currentUid);
    }
    if (cleanEmail && !baseMembers.includes(cleanEmail)) {
      baseMembers.push(cleanEmail);
    }

    let inviteCode = String(existingDoc?.inviteCode || '').trim().toUpperCase();
    if (!inviteCode || regenerate) {
      let nextCode = this.generateAlphanumericInviteCode(7);
      while (nextCode === inviteCode) {
        nextCode = this.generateAlphanumericInviteCode(7);
      }
      inviteCode = nextCode;
    }

    const workspaceDoc = {
      workspaceId,
      inviteCode,
      ownerUid: existingDoc?.ownerUid || currentUid,
      members: baseMembers,
      createdAt: existingDoc?.createdAt || nowIso,
      updatedAt: nowIso,
    };

    this.setItem(
      `${FIRESTORE_WORKSPACES_CACHE_PREFIX}${workspaceId}`,
      JSON.stringify(workspaceDoc)
    );

    if (
      this.firestoreDb &&
      this.firestoreModule &&
      typeof this.firestoreModule.doc === 'function' &&
      typeof this.firestoreModule.setDoc === 'function'
    ) {
      try {
        const wsRef = this.firestoreModule.doc(this.firestoreDb, 'workspaces', workspaceId);
        await this.firestoreModule.setDoc(wsRef, workspaceDoc, { merge: true });
      } catch {
        // Guardado local de token
      }
    }

    if (myProfile.workspaceId !== workspaceId) {
      await this.saveUserProfile(currentUid, { workspaceId });
    }

    return workspaceDoc;
  }

  async joinWorkspaceByInviteCode(rawInviteCode) {
    const cleanCode = String(rawInviteCode || '').trim().toUpperCase();
    if (!cleanCode) {
      throw new Error('Código de invitación no válido o expirado');
    }

    const currentUid = this.currentUser?.uid || this.currentProfile?.uid || 'local_default_user';
    const myProfile = await this.loadUserProfile(currentUid);
    const cleanEmail = String(myProfile.email || this.currentUser?.email || '')
      .trim()
      .toLowerCase();

    let foundWorkspace = null;

    if (
      this.firestoreDb &&
      this.firestoreModule &&
      typeof this.firestoreModule.collection === 'function' &&
      typeof this.firestoreModule.query === 'function' &&
      typeof this.firestoreModule.where === 'function' &&
      typeof this.firestoreModule.getDocs === 'function'
    ) {
      const wsCol = this.firestoreModule.collection(this.firestoreDb, 'workspaces');
      const q = this.firestoreModule.query(
        wsCol,
        this.firestoreModule.where('inviteCode', '==', cleanCode)
      );
      const snap = await this.firestoreModule.getDocs(q);
      if (!snap.empty) {
        const firstDoc = snap.docs[0];
        const data = firstDoc.data() || {};
        foundWorkspace = {
          ...data,
          workspaceId: data.workspaceId || firstDoc.id,
        };
      }
    }

    if (!foundWorkspace) {
      throw new Error('Código de invitación no válido o expirado');
    }

    const targetWorkspaceId = String(foundWorkspace.workspaceId);
    const updatedMembers = Array.from(
      new Set([
        ...(Array.isArray(foundWorkspace.members) ? foundWorkspace.members : []),
        currentUid,
        ...(cleanEmail ? [cleanEmail] : []),
      ])
    );

    const nowIso = new Date().toISOString();
    const updatedWorkspace = {
      ...foundWorkspace,
      workspaceId: targetWorkspaceId,
      inviteCode: cleanCode,
      ownerUid: foundWorkspace.ownerUid || targetWorkspaceId,
      members: updatedMembers,
      updatedAt: nowIso,
    };

    this.setItem(
      `${FIRESTORE_WORKSPACES_CACHE_PREFIX}${targetWorkspaceId}`,
      JSON.stringify(updatedWorkspace)
    );

    if (
      this.firestoreDb &&
      this.firestoreModule &&
      typeof this.firestoreModule.doc === 'function' &&
      typeof this.firestoreModule.setDoc === 'function'
    ) {
      const wsRef = this.firestoreModule.doc(this.firestoreDb, 'workspaces', targetWorkspaceId);
      await this.firestoreModule.setDoc(wsRef, updatedWorkspace, { merge: true });
    }

    const updatedProfile = await this.saveUserProfile(currentUid, {
      workspaceId: targetWorkspaceId,
    });

    return {
      workspace: updatedWorkspace,
      profile: updatedProfile,
      message: '¡Te has unido exitosamente al Espacio Familiar!',
    };
  }

  async leaveSharedWorkspace() {
    const currentUid = this.currentUser?.uid || this.currentProfile?.uid || 'local_default_user';
    const myProfile = await this.loadUserProfile(currentUid);
    const cleanEmail = String(myProfile.email || this.currentUser?.email || '')
      .trim()
      .toLowerCase();
    const oldWorkspaceId = myProfile.workspaceId;

    if (
      oldWorkspaceId &&
      this.firestoreDb &&
      this.firestoreModule &&
      typeof this.firestoreModule.doc === 'function' &&
      typeof this.firestoreModule.getDoc === 'function' &&
      typeof this.firestoreModule.setDoc === 'function'
    ) {
      try {
        const wsRef = this.firestoreModule.doc(this.firestoreDb, 'workspaces', oldWorkspaceId);
        const snap = await this.firestoreModule.getDoc(wsRef);
        if (snap.exists()) {
          const data = snap.data() || {};
          const filteredMembers = (Array.isArray(data.members) ? data.members : []).filter(
            (m) => m !== currentUid && m !== cleanEmail
          );
          await this.firestoreModule.setDoc(
            wsRef,
            {
              ...data,
              members: filteredMembers,
              updatedAt: new Date().toISOString(),
            },
            { merge: true }
          );
        }
      } catch {
        // Fallback local
      }
    }

    const updatedProfile = await this.saveUserProfile(currentUid, {
      workspaceId: currentUid,
      sharedWithEmails: [],
    });

    return {
      workspaceId: currentUid,
      profile: updatedProfile,
    };
  }

  getFirestoreUserPath(uid) {
    return `users/${uid}`;
  }
}

function BufferOrBtoa(str) {
  if (typeof btoa === 'function') {
    return btoa(encodeURIComponent(str));
  }
  return Array.from(str)
    .map((c) => c.charCodeAt(0).toString(16))
    .join('');
}
