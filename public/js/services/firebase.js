/**
 * @fileoverview Firebase SDK v10+ Fallback Configuration & Dynamic Initialization Module (ES Module companion).
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

function readEnvVar(viteKey, nextPublicKey, fallbackValue) {
  const metaEnv =
    typeof import.meta !== 'undefined' && import.meta.env
      ? import.meta.env
      : {};

  const procEnv =
    typeof process !== 'undefined' && process.env
      ? process.env
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
export const defaultFirebaseConfig = {
  get apiKey() {
    return readEnvVar(
      'VITE_FIREBASE_API_KEY',
      'NEXT_PUBLIC_FIREBASE_API_KEY',
      'pisto-spark-default-api-key'
    );
  },
  get authDomain() {
    return readEnvVar(
      'VITE_FIREBASE_AUTH_DOMAIN',
      'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
      'pisto-spark-free.firebaseapp.com'
    );
  },
  get projectId() {
    return readEnvVar(
      'VITE_FIREBASE_PROJECT_ID',
      'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
      'pisto-spark-free'
    );
  },
  get storageBucket() {
    return readEnvVar(
      'VITE_FIREBASE_STORAGE_BUCKET',
      'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET',
      'pisto-spark-free.appspot.com'
    );
  },
  get messagingSenderId() {
    return readEnvVar(
      'VITE_FIREBASE_MESSAGING_SENDER_ID',
      'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
      '000000000000'
    );
  },
  get appId() {
    return readEnvVar(
      'VITE_FIREBASE_APP_ID',
      'NEXT_PUBLIC_FIREBASE_APP_ID',
      '1:000000000000:web:pistosparkdefault'
    );
  },
};

export function getDefaultFirebaseConfig() {
  const globalCfg =
    typeof globalThis !== 'undefined' && globalThis.__PISTO_FIREBASE_CONFIG__
      ? globalThis.__PISTO_FIREBASE_CONFIG__
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

export function isValidFirebaseConfig(config) {
  if (!config || typeof config !== 'object') return false;
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  const projectId = typeof config.projectId === 'string' ? config.projectId.trim() : '';
  return apiKey.length > 0 && projectId.length > 0;
}

export function normalizeFirebaseConfig(config) {
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

function resolveStorage(customStorage) {
  if (customStorage !== undefined) return customStorage;
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

export function getCustomFirebaseConfig(storageBackend) {
  const storage = resolveStorage(storageBackend);
  if (!storage) return null;

  try {
    const raw =
      storage.getItem(CUSTOM_FIREBASE_CONFIG_STORAGE_KEY) ??
      storage.getItem(LEGACY_FIREBASE_CONFIG_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (isValidFirebaseConfig(parsed)) {
      return normalizeFirebaseConfig(parsed);
    }
  } catch {
    // Ignore malformed JSON in localStorage
  }

  return null;
}

export function getFirebaseConfigSource(storageBackend) {
  return getCustomFirebaseConfig(storageBackend) ? 'custom' : 'default';
}

/**
 * 2. Dynamic Initialization Helper:
 * Checks if a valid custom configuration exists in `localStorage` (`pisto_custom_firebase_config`).
 * - If the user HAS a valid custom config in `localStorage`, returns those credentials.
 * - If the user has NOT configured anything (or key is null/invalid), automatically returns `defaultFirebaseConfig`.
 */
export function getFirebaseConfig(storageBackend) {
  const customConfig = getCustomFirebaseConfig(storageBackend);
  if (customConfig) {
    return customConfig;
  }
  return getDefaultFirebaseConfig();
}

export function isLiveFirebaseCredentials(config) {
  if (!config || !isValidFirebaseConfig(config)) return false;
  return config.apiKey !== 'pisto-spark-default-api-key';
}

const localAppRegistry = new Map();
let activeFirebaseSdk = null;
const configChangeListeners = new Set();

const fallbackSdkAdapter = {
  initializeApp(options, name = '[DEFAULT]') {
    const existing = localAppRegistry.get(name);
    if (existing) {
      return existing;
    }
    const appInstance = {
      name,
      options: { ...options },
      isCustomConfig: options.apiKey !== defaultFirebaseConfig.apiKey,
    };
    localAppRegistry.set(name, appInstance);
    return appInstance;
  },
  getApps() {
    return Array.from(localAppRegistry.values());
  },
  getApp(name = '[DEFAULT]') {
    const app = localAppRegistry.get(name);
    if (!app) {
      throw new Error(`No Firebase App '${name}' has been created - call initializeApp() first.`);
    }
    return app;
  },
  async deleteApp(app) {
    localAppRegistry.delete(app.name);
  },
};

export function registerFirebaseSdkAdapter(sdk) {
  activeFirebaseSdk = sdk;
}

export function getApps() {
  const sdk = activeFirebaseSdk || fallbackSdkAdapter;
  return sdk.getApps();
}

export function getApp(name = '[DEFAULT]') {
  const sdk = activeFirebaseSdk || fallbackSdkAdapter;
  return sdk.getApp(name);
}

export async function initializeFirebaseApp(options = {}) {
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

export function onFirebaseConfigUpdated(listener) {
  configChangeListeners.add(listener);
  return () => configChangeListeners.delete(listener);
}

/**
 * 3. Re-initialization on Profile Save:
 * Persists the user's custom Firebase configuration in `localStorage` (`pisto_custom_firebase_config`)
 * and re-initializes the Firebase application softly without breaking the existing user session.
 */
export async function updateFirebaseConfig(userConfig, options = {}) {
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

  const result = {
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
