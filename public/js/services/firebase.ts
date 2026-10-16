/**
 * @fileoverview Firebase SDK v10+ Fallback Configuration & Dynamic Initialization Module.
 *
 * Implements the "Fallback Configuration" pattern for Pisto:
 * 1. Default Configuration (Spark Layer): `defaultFirebaseConfig` populated from standard environment
 *    variables (`import.meta.env.VITE_FIREBASE_*` or `process.env.NEXT_PUBLIC_FIREBASE_*`).
 * 2. Dynamic Initialization Logic: `getFirebaseConfig()` checks `localStorage` (`pisto_custom_firebase_config`).
 *    - If valid user credentials exist in `localStorage`, initializes Firebase (`initializeApp` / `getApps()`) with them.
 *    - If null/empty/unconfigured, automatically falls back to `defaultFirebaseConfig`.
 * 3. Re-initialization on Profile Save: `updateFirebaseConfig(userConfig)` persists custom credentials to
 *    `localStorage` and re-initializes the Firebase App softly without breaking the active user session.
 */

export const CUSTOM_FIREBASE_CONFIG_STORAGE_KEY = 'pisto_custom_firebase_config';
export const LEGACY_FIREBASE_CONFIG_STORAGE_KEY = 'pisto_firebase_web_config_v1';

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
}

export interface FirebaseAppInstance {
  name: string;
  options: FirebaseWebConfig;
  isCustomConfig: boolean;
}

export interface FirebaseSdkAdapter {
  initializeApp: (options: FirebaseWebConfig, name?: string) => any;
  getApps: () => any[];
  getApp: (name?: string) => any;
  deleteApp?: (app: any) => Promise<void>;
}

export interface UpdateFirebaseConfigResult {
  config: FirebaseWebConfig;
  source: 'custom' | 'default';
  app: any;
  reinitialized: boolean;
  sessionPreserved: boolean;
}

/**
 * Reads an environment variable safely across Vite (`import.meta.env.VITE_*`),
 * Next.js / Node (`process.env.NEXT_PUBLIC_*`), or global runtime injection.
 */
function readEnvVar(viteKey: string, nextPublicKey: string, fallbackValue: string): string {
  const metaEnv =
    typeof import.meta !== 'undefined' && (import.meta as any).env
      ? ((import.meta as any).env as Record<string, string | undefined>)
      : {};

  const procEnv =
    typeof process !== 'undefined' && process.env
      ? (process.env as Record<string, string | undefined>)
      : {};

  const val =
    metaEnv[viteKey] ||
    procEnv[nextPublicKey] ||
    procEnv[viteKey] ||
    '';

  return String(val || '').trim() || fallbackValue;
}

/**
 * 1. Default Configuration (Spark Layer):
 * Reads standard environment variables (`import.meta.env.VITE_FIREBASE_...` or `process.env.NEXT_PUBLIC_FIREBASE_...`).
 */
export const defaultFirebaseConfig: FirebaseWebConfig = {
  get apiKey(): string {
    return readEnvVar(
      'VITE_FIREBASE_API_KEY',
      'NEXT_PUBLIC_FIREBASE_API_KEY',
      'pisto-spark-default-api-key'
    );
  },
  get authDomain(): string {
    return readEnvVar(
      'VITE_FIREBASE_AUTH_DOMAIN',
      'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
      'pisto-spark-free.firebaseapp.com'
    );
  },
  get projectId(): string {
    return readEnvVar(
      'VITE_FIREBASE_PROJECT_ID',
      'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
      'pisto-spark-free'
    );
  },
  get storageBucket(): string {
    return readEnvVar(
      'VITE_FIREBASE_STORAGE_BUCKET',
      'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET',
      'pisto-spark-free.appspot.com'
    );
  },
  get messagingSenderId(): string {
    return readEnvVar(
      'VITE_FIREBASE_MESSAGING_SENDER_ID',
      'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
      '000000000000'
    );
  },
  get appId(): string {
    return readEnvVar(
      'VITE_FIREBASE_APP_ID',
      'NEXT_PUBLIC_FIREBASE_APP_ID',
      '1:000000000000:web:pistosparkdefault'
    );
  },
};

/**
 * Evaluates a snapshot of `defaultFirebaseConfig` considering any runtime env or global overrides.
 */
export function getDefaultFirebaseConfig(): FirebaseWebConfig {
  const globalCfg =
    typeof globalThis !== 'undefined' && (globalThis as any).__PISTO_FIREBASE_CONFIG__
      ? ((globalThis as any).__PISTO_FIREBASE_CONFIG__ as Partial<FirebaseWebConfig>)
      : null;

  if (globalCfg && isValidFirebaseConfig(globalCfg)) {
    return normalizeFirebaseConfig(globalCfg);
  }

  return {
    apiKey: readEnvVar(
      'VITE_FIREBASE_API_KEY',
      'NEXT_PUBLIC_FIREBASE_API_KEY',
      defaultFirebaseConfig.apiKey
    ),
    authDomain: readEnvVar(
      'VITE_FIREBASE_AUTH_DOMAIN',
      'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
      defaultFirebaseConfig.authDomain
    ),
    projectId: readEnvVar(
      'VITE_FIREBASE_PROJECT_ID',
      'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
      defaultFirebaseConfig.projectId
    ),
    storageBucket: readEnvVar(
      'VITE_FIREBASE_STORAGE_BUCKET',
      'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET',
      defaultFirebaseConfig.storageBucket || ''
    ),
    messagingSenderId: readEnvVar(
      'VITE_FIREBASE_MESSAGING_SENDER_ID',
      'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
      defaultFirebaseConfig.messagingSenderId || ''
    ),
    appId: readEnvVar(
      'VITE_FIREBASE_APP_ID',
      'NEXT_PUBLIC_FIREBASE_APP_ID',
      defaultFirebaseConfig.appId || ''
    ),
  };
}

/**
 * Validates that a Firebase configuration object has non-empty `apiKey` and `projectId`.
 */
export function isValidFirebaseConfig(
  config: Partial<FirebaseWebConfig> | null | undefined
): config is FirebaseWebConfig {
  if (!config || typeof config !== 'object') return false;
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  const projectId = typeof config.projectId === 'string' ? config.projectId.trim() : '';
  return apiKey.length > 0 && projectId.length > 0;
}

/**
 * Normalizes a partial Firebase configuration into a clean `FirebaseWebConfig`.
 */
export function normalizeFirebaseConfig(config: Partial<FirebaseWebConfig>): FirebaseWebConfig {
  const apiKey = String(config?.apiKey || '').trim();
  const projectId = String(config?.projectId || '').trim();
  const authDomain =
    String(config?.authDomain || '').trim() ||
    (projectId ? `${projectId}.firebaseapp.com` : '');
  const storageBucket =
    String(config?.storageBucket || '').trim() ||
    (projectId ? `${projectId}.appspot.com` : '');
  const messagingSenderId = String(config?.messagingSenderId || '').trim();
  const appId = String(config?.appId || '').trim();

  return {
    apiKey,
    authDomain,
    projectId,
    storageBucket,
    messagingSenderId,
    appId,
  };
}

/**
 * Resolves the storage backend (`localStorage` in browser or custom injected storage for tests).
 */
function resolveStorage(customStorage?: Storage | null): Storage | null {
  if (customStorage !== undefined) return customStorage;
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

/**
 * Returns the user's custom Firebase config from `localStorage` (`pisto_custom_firebase_config`),
 * or `null` if none is configured or if it is invalid.
 */
export function getCustomFirebaseConfig(storageBackend?: Storage | null): FirebaseWebConfig | null {
  const storage = resolveStorage(storageBackend);
  if (!storage) return null;

  try {
    const raw =
      storage.getItem(CUSTOM_FIREBASE_CONFIG_STORAGE_KEY) ??
      storage.getItem(LEGACY_FIREBASE_CONFIG_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<FirebaseWebConfig>;
    if (isValidFirebaseConfig(parsed)) {
      return normalizeFirebaseConfig(parsed);
    }
  } catch {
    // Ignore malformed JSON in localStorage
  }

  return null;
}

/**
 * Returns `'custom'` if the user has a valid custom Firebase config in `localStorage`, or `'default'` otherwise.
 */
export function getFirebaseConfigSource(storageBackend?: Storage | null): 'custom' | 'default' {
  return getCustomFirebaseConfig(storageBackend) ? 'custom' : 'default';
}

/**
 * 2. Dynamic Initialization Helper:
 * Checks if a valid custom configuration exists in `localStorage` (`pisto_custom_firebase_config`).
 * - If the user HAS a valid custom config in `localStorage`, returns those credentials.
 * - If the user has NOT configured anything (or key is null/invalid), automatically returns `defaultFirebaseConfig`.
 */
export function getFirebaseConfig(storageBackend?: Storage | null): FirebaseWebConfig {
  const customConfig = getCustomFirebaseConfig(storageBackend);
  if (customConfig) {
    return customConfig;
  }
  return getDefaultFirebaseConfig();
}

/**
 * Checks whether a Firebase config contains live remote credentials (as opposed to the offline Spark placeholder).
 */
export function isLiveFirebaseCredentials(config: FirebaseWebConfig | null | undefined): boolean {
  if (!config || !isValidFirebaseConfig(config)) return false;
  return config.apiKey !== 'pisto-spark-default-api-key';
}

// Internal registry compatible with Firebase SDK v10+ modular pattern (`initializeApp` / `getApps` / `getApp`)
const localAppRegistry = new Map<string, FirebaseAppInstance>();
let activeFirebaseSdk: FirebaseSdkAdapter | null = null;
const configChangeListeners = new Set<(result: UpdateFirebaseConfigResult) => void>();

const fallbackSdkAdapter: FirebaseSdkAdapter = {
  initializeApp(options: FirebaseWebConfig, name = '[DEFAULT]'): FirebaseAppInstance {
    const existing = localAppRegistry.get(name);
    if (existing) {
      return existing;
    }
    const appInstance: FirebaseAppInstance = {
      name,
      options: { ...options },
      isCustomConfig: options.apiKey !== defaultFirebaseConfig.apiKey,
    };
    localAppRegistry.set(name, appInstance);
    return appInstance;
  },
  getApps(): FirebaseAppInstance[] {
    return Array.from(localAppRegistry.values());
  },
  getApp(name = '[DEFAULT]'): FirebaseAppInstance {
    const app = localAppRegistry.get(name);
    if (!app) {
      throw new Error(`No Firebase App '${name}' has been created - call initializeApp() first.`);
    }
    return app;
  },
  async deleteApp(app: FirebaseAppInstance): Promise<void> {
    localAppRegistry.delete(app.name);
  },
};

/**
 * Registers an external Firebase v10+ modular SDK adapter (`{ initializeApp, getApps, getApp, deleteApp }`).
 */
export function registerFirebaseSdkAdapter(sdk: FirebaseSdkAdapter | null): void {
  activeFirebaseSdk = sdk;
}

/**
 * Compatible with Firebase SDK v10+ `getApps()`.
 */
export function getApps(): any[] {
  const sdk = activeFirebaseSdk || fallbackSdkAdapter;
  return sdk.getApps();
}

/**
 * Compatible with Firebase SDK v10+ `getApp()`.
 */
export function getApp(name = '[DEFAULT]'): any {
  const sdk = activeFirebaseSdk || fallbackSdkAdapter;
  return sdk.getApp(name);
}

/**
 * Initializes or returns the active Firebase App using `getFirebaseConfig()`:
 * - Uses user's custom config from `localStorage` if valid.
 * - Falls back to `defaultFirebaseConfig` automatically if unconfigured or null.
 * - Uses `getApps()` / `getApp()` / `initializeApp()` per Firebase v10+ modular SDK conventions.
 */
export async function initializeFirebaseApp(options: {
  storage?: Storage | null;
  sdk?: FirebaseSdkAdapter | null;
  forceReinit?: boolean;
} = {}): Promise<{
  app: any;
  config: FirebaseWebConfig;
  source: 'custom' | 'default';
}> {
  const storage = resolveStorage(options.storage);
  const sdk = options.sdk || activeFirebaseSdk || fallbackSdkAdapter;
  const config = getFirebaseConfig(storage);
  const source = getFirebaseConfigSource(storage);

  const existingApps = sdk.getApps();
  if (existingApps.length > 0) {
    const currentApp = sdk.getApp();
    const sameCredentials =
      currentApp?.options?.apiKey === config.apiKey &&
      currentApp?.options?.projectId === config.projectId &&
      currentApp?.options?.authDomain === config.authDomain;

    if (sameCredentials && !options.forceReinit) {
      return { app: currentApp, config, source };
    }

    if (typeof sdk.deleteApp === 'function') {
      try {
        await sdk.deleteApp(currentApp);
      } catch {
        localAppRegistry.clear();
      }
    } else {
      localAppRegistry.clear();
    }
  }

  localAppRegistry.clear();
  const app = sdk.initializeApp(config);
  localAppRegistry.set(app.name || '[DEFAULT]', app);

  return { app, config, source };
}

/**
 * Subscribes a listener to be notified whenever `updateFirebaseConfig` re-initializes the Firebase app.
 */
export function onFirebaseConfigUpdated(
  listener: (result: UpdateFirebaseConfigResult) => void
): () => void {
  configChangeListeners.add(listener);
  return () => configChangeListeners.delete(listener);
}

/**
 * 3. Re-initialization on Profile Save:
 * Persists the user's custom Firebase configuration in `localStorage` (`pisto_custom_firebase_config`)
 * and re-initializes the Firebase application softly without breaking the existing user session.
 * If `userConfig` is null or empty, clears the custom config and reverts to `defaultFirebaseConfig`.
 */
export async function updateFirebaseConfig(
  userConfig: Partial<FirebaseWebConfig> | null | undefined,
  options: {
    storage?: Storage | null;
    sdk?: FirebaseSdkAdapter | null;
    onSoftReload?: (result: UpdateFirebaseConfigResult) => void | Promise<void>;
  } = {}
): Promise<UpdateFirebaseConfigResult> {
  const storage = resolveStorage(options.storage);

  if (storage) {
    if (userConfig && isValidFirebaseConfig(userConfig)) {
      const normalized = normalizeFirebaseConfig(userConfig);
      const serialized = JSON.stringify(normalized);
      storage.setItem(CUSTOM_FIREBASE_CONFIG_STORAGE_KEY, serialized);
      storage.setItem(LEGACY_FIREBASE_CONFIG_STORAGE_KEY, serialized);
    } else {
      storage.removeItem(CUSTOM_FIREBASE_CONFIG_STORAGE_KEY);
      storage.removeItem(LEGACY_FIREBASE_CONFIG_STORAGE_KEY);
    }
  }

  const { app, config, source } = await initializeFirebaseApp({
    storage,
    sdk: options.sdk,
    forceReinit: true,
  });

  const result: UpdateFirebaseConfigResult = {
    config,
    source,
    app,
    reinitialized: true,
    sessionPreserved: true,
  };

  for (const listener of configChangeListeners) {
    try {
      listener(result);
    } catch {
      // Ignore listener errors
    }
  }

  if (typeof options.onSoftReload === 'function') {
    await options.onSoftReload(result);
  }

  return result;
}
