/**
 * @fileoverview Firebase Auth, Firestore Profile Persistence (`users/{uid}`) & Local Gemini API Key Service (TypeScript).
 *
 * Implements:
 * 1. Firebase Auth: Google Sign-In + Email/Password Sign-In & Registration with Local-First Free-Tier Fallback.
 * 2. Firestore Persistence: Reads and writes user profile documents in `users/{uid}` (`setDoc(..., { merge: true })`, `getDoc`).
 * 3. Browser-Only Gemini API Key Storage: Persists user's Google AI Studio API Key strictly in `localStorage`
 *    so Genkit AI calls use the user's own key without backend key costs or cloud database exposure.
 * 4. Personal View Mode & Default Currency Filtering: Filters transactions by `ownerUid` and `currency`.
 * 5. Privacy & LocalStorage Isolation: Automatically purges sensitive keys (`pisto_user_gemini_api_key_v1`,
 *    `pisto_custom_firebase_config`, `pisto_firebase_web_config_v1`) upon sign-out.
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
  type FirebaseWebConfig,
  type UpdateFirebaseConfigResult,
} from './firebase.ts';
import { migrateTransactionsToSharedWorkspace } from './transactions.ts';

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
  type FirebaseWebConfig,
  type UpdateFirebaseConfigResult,
};

export interface AuthUser {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  provider: 'google' | 'password' | 'local';
  emailVerified?: boolean;
}

export interface UserProfile {
  uid: string;
  email: string;
  name: string;
  displayName: string;
  photoURL: string;
  country: string;
  defaultCurrency: string;
  personalViewMode: boolean;
  filterByDefaultCurrency: boolean;
  workspaceId: string;
  sharedWithEmails: string[];
  updatedAt: string;
  createdAt: string;
}

export interface PrivacyConsentState {
  accepted: boolean;
  localStorageEnabled: boolean;
  timestamp: string;
  version: string;
}

export interface TransactionRecord {
  id: string;
  type: string;
  amount: number;
  currency: string;
  categoryId: string;
  accountId: string;
  toAccountId?: string | null;
  note?: string;
  date: string;
  createdAt: string;
  createdByUid?: string;
  createdByEmail?: string;
  workspaceId?: string;
  ownerUid?: string;
  ownerName?: string;
}

export const GEMINI_API_KEY_STORAGE_KEY = 'pisto_user_gemini_api_key_v1';
export const FIREBASE_CONFIG_STORAGE_KEY = LEGACY_FIREBASE_CONFIG_STORAGE_KEY;
export const PRIVACY_CONSENT_STORAGE_KEY = 'pisto_privacy_consent_v1';
export const LOCAL_AUTH_SESSION_KEY = 'pisto_auth_session_v1';
export const LOCAL_USERS_DB_KEY = 'pisto_local_users_auth_v1';
export const FIRESTORE_USERS_CACHE_PREFIX = 'pisto_firestore_users_doc_';
export const FIRESTORE_WORKSPACES_CACHE_PREFIX = 'pisto_firestore_workspaces_doc_';
export const FIRESTORE_EMAIL_WORKSPACE_PREFIX = 'pisto_workspace_by_email_';

export const SUPPORTED_COUNTRIES: ReadonlyArray<{ code: string; name: string; flag: string; defaultCurrency: string }> = Object.freeze([
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
 */
export function formatFirebaseAuthDiagnosticMessage(errorCode: string, errorMessage: string): string {
  const code = String(errorCode || 'auth/unknown-error').trim();
  const msg = String(errorMessage || 'Error desconocido de Firebase Auth.').trim();

  const hints: Record<string, string> = {
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
 */
export function createUserProfile(input: Partial<UserProfile> & { uid: string }): UserProfile {
  const uid = String(input.uid || '').trim();
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
  const validCurrency = input.defaultCurrency && CURRENCIES[input.defaultCurrency as keyof typeof CURRENCIES]
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
    workspaceId: cleanWorkspaceId,
    sharedWithEmails: cleanSharedEmails,
    createdAt: input.createdAt || nowIso,
    updatedAt: input.updatedAt || nowIso,
  };
}

/**
 * Builds a lightweight Local-First in-memory index by `workspaceId` and `createdByUid`
 * so Dashboard and Ledger queries avoid repeated full scans when switching views.
 */
export function buildWorkspaceTransactionIndex<T extends TransactionRecord>(
  transactions: ReadonlyArray<T>
): {
  byWorkspace: Map<string, T[]>;
  byCreator: Map<string, T[]>;
} {
  const byWorkspace = new Map<string, T[]>();
  const byCreator = new Map<string, T[]>();

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
 */
export function filterTransactionsForUserView<T extends TransactionRecord>(
  transactions: ReadonlyArray<T>,
  options: {
    currentUid?: string | null;
    workspaceId?: string | null;
    personalViewMode?: boolean;
    currencyFilter?: string | null;
  } = {}
): T[] {
  const {
    currentUid = null,
    workspaceId = null,
    personalViewMode = false,
    currencyFilter = 'all',
  } = options;

  const index = buildWorkspaceTransactionIndex(transactions);

  let candidates: ReadonlyArray<T>;
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
  private storage: Storage | null;
  private memoryKey: string = '';

  constructor(storageBackend: Storage | null = typeof localStorage !== 'undefined' ? localStorage : null) {
    this.storage = storageBackend;
  }

  getApiKey(): string {
    if (this.storage) {
      return String(this.storage.getItem(GEMINI_API_KEY_STORAGE_KEY) || '').trim();
    }
    return this.memoryKey;
  }

  setApiKey(apiKey: string): void {
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

  hasApiKey(): boolean {
    return this.getApiKey().length >= 10;
  }
}

/**
 * Service managing Firebase Auth (Google + Email/Password) and Firestore `users/{uid}` persistence.
 */
export class FirebaseAuthProfileService {
  private storage: Storage | null;
  private memoryStore: Map<string, string> = new Map();
  private authListeners: Set<(user: AuthUser | null, profile: UserProfile | null) => void> = new Set();
  private currentUser: AuthUser | null = null;
  private currentProfile: UserProfile | null = null;
  private firebaseApp: any = null;
  private firebaseAuth: any = null;
  private firestoreDb: any = null;
  private firestoreModule: any = null;
  private authModule: any = null;
  public readonly geminiKeyStore: GeminiKeyLocalStore;

  constructor(storageBackend: Storage | null = typeof localStorage !== 'undefined' ? localStorage : null) {
    this.storage = storageBackend;
    this.geminiKeyStore = new GeminiKeyLocalStore(storageBackend);
  }

  private getItem(key: string): string | null {
    if (this.storage) return this.storage.getItem(key);
    return this.memoryStore.get(key) ?? null;
  }

  private setItem(key: string, value: string): void {
    if (this.storage) {
      this.storage.setItem(key, value);
    } else {
      this.memoryStore.set(key, value);
    }
  }

  private removeItem(key: string): void {
    if (this.storage) {
      this.storage.removeItem(key);
    } else {
      this.memoryStore.delete(key);
    }
  }

  private getStorageAdapter(): Storage {
    return {
      length: 0,
      clear: () => {
        this.memoryStore.clear();
      },
      key: () => null,
      getItem: (k: string) => this.getItem(k),
      setItem: (k: string, v: string) => this.setItem(k, v),
      removeItem: (k: string) => this.removeItem(k),
    };
  }

  getFirebaseConfig(): FirebaseWebConfig {
    return getFirebaseConfig(this.getStorageAdapter());
  }

  getCustomFirebaseConfig(): FirebaseWebConfig | null {
    return getCustomFirebaseConfig(this.getStorageAdapter());
  }

  getFirebaseConfigSource(): 'custom' | 'default' {
    return getFirebaseConfigSource(this.getStorageAdapter());
  }

  hasCustomFirebaseConfig(): boolean {
    return Boolean(this.getCustomFirebaseConfig());
  }

  async updateFirebaseConfig(
    userConfig: Partial<FirebaseWebConfig> | string | null
  ): Promise<UpdateFirebaseConfigResult> {
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

  saveFirebaseConfig(config: FirebaseWebConfig | null): void {
    void this.updateFirebaseConfig(config);
  }

  isLiveFirebaseConfigured(): boolean {
    const cfg = this.getFirebaseConfig();
    return Boolean(isLiveFirebaseCredentials(cfg) && this.firebaseAuth && this.firestoreDb);
  }

  async init(): Promise<{ user: AuthUser | null; profile: UserProfile | null }> {
    const { app, config } = await initializeFirebaseApp({
      storage: this.getStorageAdapter(),
    });
    this.firebaseApp = app;

    if (isLiveFirebaseCredentials(config) && typeof window !== 'undefined') {
      try {
        const [appMod, authMod, firestoreMod] = await Promise.all([
          import('https://www.gstatic.com/firebasejs/11.4.0/firebase-app.js' as any),
          import('https://www.gstatic.com/firebasejs/11.4.0/firebase-auth.js' as any),
          import('https://www.gstatic.com/firebasejs/11.4.0/firebase-firestore.js' as any),
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
          authMod.onAuthStateChanged(this.firebaseAuth, async (fbUser: any) => {
            if (fbUser) {
              const authUser: AuthUser = {
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
      } catch (err) {
        console.warn('[FirebaseAuthProfileService] Usando motor Local-First Free Tier para Auth/Firestore:', err);
      }
    }

    const rawSession = this.getItem(LOCAL_AUTH_SESSION_KEY);
    if (rawSession) {
      try {
        const parsedUser = JSON.parse(rawSession) as AuthUser;
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

  onAuthChange(listener: (user: AuthUser | null, profile: UserProfile | null) => void): () => void {
    this.authListeners.add(listener);
    return () => this.authListeners.delete(listener);
  }

  private notifyListeners(): void {
    for (const listener of this.authListeners) {
      listener(this.currentUser, this.currentProfile);
    }
  }

  getCurrentUser(): AuthUser | null {
    return this.currentUser;
  }

  getCurrentProfile(): UserProfile | null {
    return this.currentProfile;
  }

  getFirestoreContext(): {
    firestoreDb: any;
    firestoreModule: any;
    storage: Storage;
  } {
    return {
      firestoreDb: this.firestoreDb,
      firestoreModule: this.firestoreModule,
      storage: this.getStorageAdapter(),
    };
  }

  /**
   * Allows injecting Firebase Auth & Firestore runtime adapters in unit tests.
   */
  setFirebaseRuntimeForTesting(runtime: {
    firebaseAuth?: any;
    authModule?: any;
    firestoreDb?: any;
    firestoreModule?: any;
  }): void {
    if (runtime.firebaseAuth !== undefined) this.firebaseAuth = runtime.firebaseAuth;
    if (runtime.authModule !== undefined) this.authModule = runtime.authModule;
    if (runtime.firestoreDb !== undefined) this.firestoreDb = runtime.firestoreDb;
    if (runtime.firestoreModule !== undefined) this.firestoreModule = runtime.firestoreModule;
  }

  /**
   * Ensures Firebase Auth & Firestore SDKs are initialized when running in the browser with live credentials.
   * Throws an explicit `auth/configuration-not-found` error if Firebase credentials are not configured.
   */
  private async ensureFirebaseAuthSdkLoaded(): Promise<void> {
    if (this.firebaseAuth && this.authModule) {
      return;
    }

    const config = this.getFirebaseConfig();
    if (!isLiveFirebaseCredentials(config)) {
      const cfgError: any = new Error(
        'No se encontró una configuración activa de Firebase Auth (credenciales por defecto de demostración activas). Configura las credenciales de tu proyecto Firebase en la pestaña Perfil o usa "🚀 Probar Modo Demo".'
      );
      cfgError.code = 'auth/configuration-not-found';
      throw cfgError;
    }

    if (typeof window !== 'undefined') {
      const [appMod, authMod, firestoreMod] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/11.4.0/firebase-app.js' as any),
        import('https://www.gstatic.com/firebasejs/11.4.0/firebase-auth.js' as any),
        import('https://www.gstatic.com/firebasejs/11.4.0/firebase-firestore.js' as any),
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
  async syncGoogleUserWithFirestore(user: AuthUser): Promise<UserProfile> {
    const uid = String(user.uid || '').trim();
    const nowIso = new Date().toISOString();
    const initialWorkspaceId = uid || user.email || `ws_${uid}`;
    const docKey = `${FIRESTORE_USERS_CACHE_PREFIX}${uid}`;

    if (this.firestoreDb && this.firestoreModule) {
      try {
        const userDocRef = this.firestoreModule.doc(this.firestoreDb, 'users', uid);
        const snap = await this.firestoreModule.getDoc(userDocRef);

        if (snap.exists()) {
          const existingData = (snap.data() || {}) as Partial<UserProfile>;
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
      } catch (err) {
        console.warn('[Firestore users/{uid} post-login sync] Fallback a caché local:', err);
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
  async signInWithGoogle(customGoogleAccount?: {
    email?: string;
    name?: string;
    photoURL?: string;
  }): Promise<{
    user: AuthUser;
    profile: UserProfile;
  }> {
    // Headless Node unit test support when customGoogleAccount is explicitly provided without a live/mocked Firebase Auth instance
    if (!this.firebaseAuth && !this.authModule && customGoogleAccount && typeof window === 'undefined') {
      const email = String(customGoogleAccount.email || 'usuario.google@gmail.com')
        .trim()
        .toLowerCase();
      const displayName = String(customGoogleAccount.name || 'Usuario Google').trim();
      const photoURL = String(customGoogleAccount.photoURL || '').trim();
      const uid = `uid_google_${email.replace(/[^a-z0-9]/g, '_').slice(0, 24)}`;

      const user: AuthUser = {
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
      const initialAuthMod = this.authModule || (this as any).firebaseAuthModule;
      if (!this.firebaseAuth || !initialAuthMod) {
        await this.ensureFirebaseAuthSdkLoaded();
      }

      const activeAuthModule = this.authModule || (this as any).firebaseAuthModule;
      const GoogleAuthProvider = activeAuthModule?.GoogleAuthProvider;
      const signInWithPopup = activeAuthModule?.signInWithPopup;
      if (typeof GoogleAuthProvider !== 'function' || typeof signInWithPopup !== 'function') {
        const sdkErr: any = new Error(
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
        const missingUserErr: any = new Error(
          'No se recibieron los datos del usuario tras completar signInWithPopup con Google.'
        );
        missingUserErr.code = 'auth/internal-error';
        throw missingUserErr;
      }

      const user: AuthUser = {
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
    } catch (error: any) {
      const errorCode = String(error?.code || 'auth/unknown-error');
      const errorMessage = String(
        error?.originalMessage || error?.message || 'Error desconocido al iniciar sesión con Google.'
      );
      console.error(
        `[Firebase Auth - Google Sign-In Error] code=${errorCode} | message=${errorMessage}`,
        error
      );
      const formattedError: any = new Error(
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
  async signInWithDemoMode(customDemoAccount?: { email?: string; name?: string }): Promise<{
    user: AuthUser;
    profile: UserProfile;
  }> {
    const email = String(customDemoAccount?.email || 'catracho.google@gmail.com').trim().toLowerCase();
    const displayName = String(customDemoAccount?.name || 'Google Catracho (Demo)').trim();
    const uid = `uid_demo_${email.replace(/[^a-z0-9]/g, '_').slice(0, 24)}`;

    const user: AuthUser = {
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

  async signInDemoMode(customDemoAccount?: { email?: string; name?: string }): Promise<{
    user: AuthUser;
    profile: UserProfile;
  }> {
    return this.signInWithDemoMode(customDemoAccount);
  }

  async signInOrRegisterWithEmail(params: {
    email: string;
    password: string;
    name?: string;
    country?: string;
    defaultCurrency?: string;
    isRegister?: boolean;
  }): Promise<{ user: AuthUser; profile: UserProfile }> {
    const cleanEmail = String(params.email || '').trim().toLowerCase();
    const password = String(params.password || '');

    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      throw new Error('Ingresa un correo electrónico válido.');
    }
    if (password.length < 6) {
      throw new Error('La contraseña debe tener al menos 6 caracteres.');
    }

    if (this.firebaseAuth && this.authModule) {
      let fbUser: any;
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

      const user: AuthUser = {
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
    const usersDb: Record<string, { uid: string; email: string; passwordHash: string; displayName: string }> =
      usersDbRaw ? JSON.parse(usersDbRaw) : {};

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
    const user: AuthUser = {
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
  getPrivacyConsent(): PrivacyConsentState {
    const defaultState: PrivacyConsentState = {
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
   */
  savePrivacyConsent(accepted: boolean = true): PrivacyConsentState {
    const state: PrivacyConsentState = {
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
  async clearSensitiveLocalStorage(): Promise<void> {
    this.geminiKeyStore.setApiKey('');
    this.removeItem(GEMINI_API_KEY_STORAGE_KEY);
    this.removeItem(CUSTOM_FIREBASE_CONFIG_STORAGE_KEY);
    this.removeItem(LEGACY_FIREBASE_CONFIG_STORAGE_KEY);
    await this.updateFirebaseConfig(null);
  }

  /**
   * Signs out the active user from Firebase Auth, cleans sensitive `localStorage` credentials,
   * and clears the session.
   */
  async signOut(): Promise<void> {
    if (this.firebaseAuth && this.authModule) {
      await this.authModule.signOut(this.firebaseAuth);
    }
    this.removeItem(LOCAL_AUTH_SESSION_KEY);
    await this.clearSensitiveLocalStorage();
    this.currentUser = null;
    this.currentProfile = null;
    this.notifyListeners();
  }

  private isPersonalInitialWorkspace(wsId: string | undefined, uid: string, email?: string): boolean {
    if (!wsId || wsId === 'ws_default') return true;
    if (uid && (wsId === uid || wsId === `ws_${uid}`)) return true;
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (cleanEmail && wsId.toLowerCase() === cleanEmail) return true;
    return false;
  }

  private async resolveSharedWorkspaceForProfile(profile: UserProfile): Promise<UserProfile> {
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
        const parsedIdx = JSON.parse(emailIdxRaw) as {
          workspaceId?: string;
          memberEmails?: string[];
        };
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
                  ...wsData.memberEmails.filter((e: string) => e && e !== cleanEmail),
                ])
              );
            }
          }
        }
      } catch (err) {
        console.warn('[Firestore workspaces lookup] Fallback local:', err);
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

  async loadUserProfile(
    uid: string,
    defaults: Partial<UserProfile> = {}
  ): Promise<UserProfile> {
    const docKey = `${FIRESTORE_USERS_CACHE_PREFIX}${uid}`;

    if (this.firestoreDb && this.firestoreModule) {
      try {
        const userDocRef = this.firestoreModule.doc(this.firestoreDb, 'users', uid);
        const snap = await this.firestoreModule.getDoc(userDocRef);
        if (snap.exists()) {
          const data = snap.data() as Partial<UserProfile>;
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
      } catch (err) {
        console.warn('[Firestore users/{uid}] Fallback a caché local:', err);
      }
    }

    const cachedRaw = this.getItem(docKey);
    if (cachedRaw) {
      try {
        const parsed = JSON.parse(cachedRaw) as Partial<UserProfile>;
        let profile = createUserProfile({ ...defaults, ...parsed, uid });
        profile = await this.resolveSharedWorkspaceForProfile(profile);
        this.setItem(docKey, JSON.stringify(profile));
        this.currentProfile = profile;
        return profile;
      } catch {
        // Fallthrough to create fresh profile
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

  async saveUserProfile(
    uid: string,
    updates: Partial<UserProfile>
  ): Promise<UserProfile> {
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
      } catch (err) {
        console.warn('[Firestore users/{uid}] Guardado en mirror local (Firestore offline):', err);
      }
    }

    this.notifyListeners();
    return updatedProfile;
  }

  async shareWorkspaceWithEmail(targetEmail: string): Promise<{
    workspaceId: string;
    profile: UserProfile;
    linkedEmail: string;
  }> {
    const cleanTargetEmail = String(targetEmail || '').trim().toLowerCase();
    if (!cleanTargetEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanTargetEmail)) {
      throw new Error('Ingresa un correo electrónico válido para compartir el espacio financiero.');
    }

    const currentUid = this.currentUser?.uid || this.currentProfile?.uid || 'local_default_user';
    const myProfile = await this.loadUserProfile(currentUid);

    if (myProfile.email && myProfile.email.toLowerCase() === cleanTargetEmail) {
      throw new Error('No puedes compartir el espacio financiero con tu propio correo.');
    }

    const usersDbRaw = this.getItem(LOCAL_USERS_DB_KEY);
    const usersDb: Record<string, { uid: string; email: string; passwordHash: string; displayName: string }> =
      usersDbRaw ? JSON.parse(usersDbRaw) : {};

    let targetUid = usersDb[cleanTargetEmail]?.uid || `uid_${cleanTargetEmail.replace(/[^a-z0-9]/g, '_').slice(0, 24)}`;
    let targetExistingProfile: UserProfile | null = null;

    if (this.firestoreDb && this.firestoreModule) {
      try {
        const usersCol = this.firestoreModule.collection(this.firestoreDb, 'users');
        const q = this.firestoreModule.query(usersCol, this.firestoreModule.where('email', '==', cleanTargetEmail));
        const querySnap = await this.firestoreModule.getDocs(q);
        if (!querySnap.empty) {
          const docSnap = querySnap.docs[0];
          targetUid = docSnap.id;
          targetExistingProfile = createUserProfile({ ...(docSnap.data() as Partial<UserProfile>), uid: targetUid });
        }
      } catch (err) {
        console.warn('[Firestore Compartir Finanzas] Búsqueda local de usuario:', err);
      }
    }

    if (!targetExistingProfile) {
      const targetDocRaw = this.getItem(`${FIRESTORE_USERS_CACHE_PREFIX}${targetUid}`);
      if (targetDocRaw) {
        try {
          targetExistingProfile = createUserProfile({
            ...(JSON.parse(targetDocRaw) as Partial<UserProfile>),
            uid: targetUid,
          });
        } catch {
          targetExistingProfile = null;
        }
      }
    }

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
      } catch (err) {
        console.warn('[Firestore users/{targetUid}] Guardado local de vínculo familiar:', err);
      }
    }

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
      } catch (err) {
        console.warn('[Firestore workspaces/{workspaceId}] Guardado local de workspace:', err);
      }
    }

    await migrateTransactionsToSharedWorkspace(
      sharedWorkspaceId,
      [currentUid, targetUid],
      combinedEmails,
      this.storage,
      this.firestoreDb,
      this.firestoreModule
    );

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

  async unlinkSharedMember(emailToRemove: string): Promise<UserProfile> {
    const cleanRemove = String(emailToRemove || '').trim().toLowerCase();
    const currentUid = this.currentUser?.uid || this.currentProfile?.uid || 'local_default_user';
    const myProfile = await this.loadUserProfile(currentUid);
    const nextShared = (myProfile.sharedWithEmails || []).filter((e) => e !== cleanRemove);
    return await this.saveUserProfile(currentUid, {
      sharedWithEmails: nextShared,
    });
  }

  getFirestoreUserPath(uid: string): string {
    return `users/${uid}`;
  }
}

function BufferOrBtoa(str: string): string {
  if (typeof btoa === 'function') {
    return btoa(encodeURIComponent(str));
  }
  return Array.from(str)
    .map((c) => c.charCodeAt(0).toString(16))
    .join('');
}
