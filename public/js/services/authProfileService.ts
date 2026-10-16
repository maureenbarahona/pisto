/**
 * @fileoverview Firebase Auth, Firestore Profile Persistence (`users/{uid}`) & Local Gemini API Key Service (TypeScript).
 *
 * Implements:
 * 1. Firebase Auth: Google Sign-In + Email/Password Sign-In & Registration with Local-First Free-Tier Fallback.
 * 2. Firestore Persistence: Reads and writes user profile documents in `users/{uid}` (`setDoc(..., { merge: true })`, `getDoc`).
 * 3. Browser-Only Gemini API Key Storage: Persists user's Google AI Studio API Key strictly in `localStorage`
 *    so Genkit AI calls use the user's own key without backend key costs or cloud database exposure.
 * 4. Personal View Mode & Default Currency Filtering: Filters transactions by `ownerUid` and `currency`.
 */

import { CURRENCIES } from '../domain/models.js';

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
}

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
  country: string;
  defaultCurrency: string;
  personalViewMode: boolean;
  filterByDefaultCurrency: boolean;
  updatedAt: string;
  createdAt: string;
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
  ownerUid?: string;
  ownerName?: string;
}

export const GEMINI_API_KEY_STORAGE_KEY = 'pisto_user_gemini_api_key_v1';
export const FIREBASE_CONFIG_STORAGE_KEY = 'pisto_firebase_web_config_v1';
export const LOCAL_AUTH_SESSION_KEY = 'pisto_auth_session_v1';
export const LOCAL_USERS_DB_KEY = 'pisto_local_users_auth_v1';
export const FIRESTORE_USERS_CACHE_PREFIX = 'pisto_firestore_users_doc_';

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
 * Pure factory that builds and validates a UserProfile entity for `users/{uid}`.
 */
export function createUserProfile(input: Partial<UserProfile> & { uid: string }): UserProfile {
  const uid = String(input.uid || '').trim();
  if (!uid) {
    throw new Error('El identificador de usuario (uid) es obligatorio.');
  }

  const nowIso = new Date().toISOString();
  const cleanName = String(input.name || 'Usuario Catracho').trim().slice(0, 80) || 'Usuario Catracho';
  const cleanEmail = String(input.email || '').trim().toLowerCase().slice(0, 120);
  const validCountry = SUPPORTED_COUNTRIES.some((c) => c.code === input.country)
    ? String(input.country)
    : 'HN';
  const validCurrency = input.defaultCurrency && CURRENCIES[input.defaultCurrency as keyof typeof CURRENCIES]
    ? String(input.defaultCurrency)
    : 'HNL';

  return {
    uid,
    email: cleanEmail,
    name: cleanName,
    country: validCountry,
    defaultCurrency: validCurrency,
    personalViewMode: Boolean(input.personalViewMode ?? false),
    filterByDefaultCurrency: Boolean(input.filterByDefaultCurrency ?? true),
    createdAt: input.createdAt || nowIso,
    updatedAt: input.updatedAt || nowIso,
  };
}

/**
 * Filters transactions according to the active user profile settings:
 * - If `currencyFilter` is set (and not `'all'`), keeps only transactions matching that currency.
 * - If `personalViewMode` is `true` and `currentUid` is present, keeps only transactions owned by `currentUid`
 *   (or legacy unowned personal transactions when `includeUnownedInPersonalView` is true).
 */
export function filterTransactionsForUserView<T extends TransactionRecord>(
  transactions: ReadonlyArray<T>,
  options: {
    currentUid?: string | null;
    personalViewMode?: boolean;
    currencyFilter?: string | null;
  } = {}
): T[] {
  const {
    currentUid = null,
    personalViewMode = false,
    currencyFilter = 'all',
  } = options;

  return transactions.filter((tx) => {
    if (currencyFilter && currencyFilter !== 'all') {
      if (tx.currency !== currencyFilter) {
        return false;
      }
    }

    if (personalViewMode && currentUid) {
      const txOwner = tx.ownerUid || currentUid;
      if (txOwner !== currentUid) {
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
 * Automatically uses the official Firebase v11 Modular Web SDK when Firebase project credentials are configured,
 * and seamlessly provides a Local-First Free Tier emulator in the browser or Node test environment.
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

  /**
   * Returns saved Firebase Web Config if configured by the user or window globals.
   */
  getFirebaseConfig(): FirebaseWebConfig | null {
    try {
      const globalCfg = (globalThis as any).__PISTO_FIREBASE_CONFIG__;
      if (globalCfg && globalCfg.apiKey && globalCfg.projectId) {
        return globalCfg as FirebaseWebConfig;
      }
      const raw = this.getItem(FIREBASE_CONFIG_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.apiKey && parsed.projectId) {
        return parsed as FirebaseWebConfig;
      }
    } catch {
      // Ignore invalid JSON
    }
    return null;
  }

  saveFirebaseConfig(config: FirebaseWebConfig | null): void {
    if (!config || !config.apiKey || !config.projectId) {
      this.removeItem(FIREBASE_CONFIG_STORAGE_KEY);
      this.firebaseApp = null;
      this.firebaseAuth = null;
      this.firestoreDb = null;
      return;
    }
    this.setItem(FIREBASE_CONFIG_STORAGE_KEY, JSON.stringify(config));
  }

  isLiveFirebaseConfigured(): boolean {
    return Boolean(this.getFirebaseConfig() && this.firebaseAuth && this.firestoreDb);
  }

  /**
   * Initializes Firebase App, Auth, and Firestore (`users/{uid}`) if config is available,
   * then restores the user session and loads `users/{uid}` profile.
   */
  async init(): Promise<{ user: AuthUser | null; profile: UserProfile | null }> {
    const config = this.getFirebaseConfig();
    if (config && typeof window !== 'undefined') {
      try {
        const [appMod, authMod, firestoreMod] = await Promise.all([
          import('https://www.gstatic.com/firebasejs/11.4.0/firebase-app.js' as any),
          import('https://www.gstatic.com/firebasejs/11.4.0/firebase-auth.js' as any),
          import('https://www.gstatic.com/firebasejs/11.4.0/firebase-firestore.js' as any),
        ]);

        this.firebaseApp = appMod.initializeApp(config);
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

    // Local-First Free Tier session restoration
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

  /**
   * Signs in with Google via Firebase Auth `signInWithPopup(auth, new GoogleAuthProvider())`
   * or Local-First Google Account flow when running without remote Firebase credentials.
   */
  async signInWithGoogle(customGoogleAccount?: { email?: string; name?: string }): Promise<{
    user: AuthUser;
    profile: UserProfile;
  }> {
    if (this.firebaseAuth && this.authModule) {
      const provider = new this.authModule.GoogleAuthProvider();
      const result = await this.authModule.signInWithPopup(this.firebaseAuth, provider);
      const fbUser = result.user;
      const user: AuthUser = {
        uid: fbUser.uid,
        email: fbUser.email || '',
        displayName: fbUser.displayName || 'Usuario Google',
        photoURL: fbUser.photoURL || '',
        provider: 'google',
        emailVerified: true,
      };
      this.currentUser = user;
      this.currentProfile = await this.loadUserProfile(user.uid, {
        email: user.email,
        name: user.displayName,
      });
      this.notifyListeners();
      return { user, profile: this.currentProfile };
    }

    const email = String(customGoogleAccount?.email || 'catracho.google@gmail.com').trim().toLowerCase();
    const displayName = String(customGoogleAccount?.name || 'Usuario Google Catracho').trim();
    const uid = `uid_google_${email.replace(/[^a-z0-9]/g, '_').slice(0, 24)}`;

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

  /**
   * Signs in or registers a user with Email and Password via Firebase Auth
   * (`signInWithEmailAndPassword` / `createUserWithEmailAndPassword`).
   */
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

    // Local-First Free Tier Email/Password Auth Store
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
        // Auto-provision account on first sign-in for smooth onboarding if not registered yet
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
   * Signs out the active user from Firebase Auth and clears the session.
   */
  async signOut(): Promise<void> {
    if (this.firebaseAuth && this.authModule) {
      await this.authModule.signOut(this.firebaseAuth);
    }
    this.removeItem(LOCAL_AUTH_SESSION_KEY);
    this.currentUser = null;
    this.currentProfile = null;
    this.notifyListeners();
  }

  /**
   * Loads the user profile from Firestore collection `users/{uid}` (with local cache mirror).
   * Creates the initial `users/{uid}` document if it does not exist yet.
   */
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
          const profile = createUserProfile({ ...defaults, ...data, uid });
          this.setItem(docKey, JSON.stringify(profile));
          this.currentProfile = profile;
          return profile;
        }
        const initialProfile = createUserProfile({
          uid,
          email: defaults.email || this.currentUser?.email || '',
          name: defaults.name || this.currentUser?.displayName || 'Usuario Catracho',
          country: defaults.country || 'HN',
          defaultCurrency: defaults.defaultCurrency || 'HNL',
          personalViewMode: defaults.personalViewMode ?? false,
          filterByDefaultCurrency: defaults.filterByDefaultCurrency ?? true,
        });
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
        const profile = createUserProfile({ ...defaults, ...parsed, uid });
        this.currentProfile = profile;
        return profile;
      } catch {
        // Fallthrough to create fresh profile
      }
    }

    const freshProfile = createUserProfile({
      uid,
      email: defaults.email || this.currentUser?.email || '',
      name: defaults.name || this.currentUser?.displayName || 'Usuario Catracho',
      country: defaults.country || 'HN',
      defaultCurrency: defaults.defaultCurrency || 'HNL',
      personalViewMode: defaults.personalViewMode ?? false,
      filterByDefaultCurrency: defaults.filterByDefaultCurrency ?? true,
    });
    this.setItem(docKey, JSON.stringify(freshProfile));
    this.currentProfile = freshProfile;
    return freshProfile;
  }

  /**
   * Persists the updated user profile to Firestore `users/{uid}` (`setDoc(doc(db, 'users', uid), profile, { merge: true })`)
   * and updates the local mirror.
   */
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

  /**
   * Returns the Firestore document path for the given user ID.
   */
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
