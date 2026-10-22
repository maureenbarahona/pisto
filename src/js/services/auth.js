/**
 * @fileoverview Servicio de Autenticación y Persistencia de Onboarding en Firestore (`src/js/services/auth.js`).
 *
 * Responsabilidades:
 * 1. Verificación y Creación del Campo por Defecto (`users/{uid}`):
 *    - Al registrar o crear un nuevo documento de usuario en la colección `users`, incluye explícitamente:
 *      `hasCompletedOnboarding: false`
 * 2. Lectura en Inicio de Sesión (`users/{uid}`):
 *    - Si `hasCompletedOnboarding === true`, NO invoca ni renderiza el Onboarding Wizard (y remueve cualquier modal residual).
 *    - Si `hasCompletedOnboarding === false` (o `undefined`), inicializa el Onboarding Wizard.
 * 3. Actualización Explícita al Finalizar el Wizard:
 *    - Obtiene `auth.currentUser.uid` y ejecuta:
 *      `await updateDoc(doc(db, "users", auth.currentUser.uid), { hasCompletedOnboarding: true });`
 * 4. Limpieza Segura en Cierre de Sesión (`Logout`):
 *    - Remueve cualquier elemento modal del Wizard montado en el DOM y resetea los estados locales.
 */

import {
  FirebaseAuthProfileService,
  GeminiKeyLocalStore,
  SUPPORTED_COUNTRIES,
  FIRESTORE_USERS_CACHE_PREFIX,
  LOCAL_AUTH_SESSION_KEY,
  createUserProfile,
  shouldTriggerOnboarding,
  ensureCleanWorkspaceForFirstTimeUser,
  completeUserOnboarding,
  buildWorkspaceTransactionIndex,
  filterTransactionsForUserView,
  formatFirebaseAuthDiagnosticMessage,
} from '../../../public/js/services/authProfileService.js';
import {
  ZERO_DASHBOARD_METRICS,
  clearDashboardDomContainers,
  resetDashboardDomToZeroAndEmpty,
} from './dashboard.js';

export const ONBOARDING_WIZARD_MODAL_ID = 'onboarding-wizard-dialog';
export const AUTH_LOGIN_MODAL_ID = 'auth-dialog';
export const RESIDUAL_WORKSPACE_STORAGE_PREFIXES = Object.freeze([
  'Pisto_open_finance_state_v1',
  'pisto_local_auth_session_v1',
  'pisto_gemini_api_key_v1',
  'pisto_custom_firebase_config',
  'pisto_firebase_web_config_v1',
  'pisto_firestore_accounts_ws_',
  'pisto_firestore_transactions_ws_',
  'pisto_firestore_budgets_ws_',
  'pisto_dashboard_metrics_ws_',
  'pisto_shared_ws_tx_',
  'pisto_active_workspace',
]);

export {
  FirebaseAuthProfileService,
  GeminiKeyLocalStore,
  SUPPORTED_COUNTRIES,
  FIRESTORE_USERS_CACHE_PREFIX,
  LOCAL_AUTH_SESSION_KEY,
  createUserProfile,
  shouldTriggerOnboarding,
  ensureCleanWorkspaceForFirstTimeUser,
  completeUserOnboarding,
  buildWorkspaceTransactionIndex,
  filterTransactionsForUserView,
  formatFirebaseAuthDiagnosticMessage,
  clearDashboardDomContainers,
  resetDashboardDomToZeroAndEmpty,
};

/**
 * Construye el documento de usuario para un nuevo registro en la colección `users`,
 * garantizando por defecto `hasCompletedOnboarding: false`.
 *
 * @param {object} userInput
 * @returns {object}
 */
export function buildDefaultUserDocument(userInput = {}) {
  const profile = createUserProfile({
    ...userInput,
    hasCompletedOnboarding:
      userInput?.hasCompletedOnboarding === true ? true : false,
  });
  return {
    ...profile,
    hasCompletedOnboarding:
      userInput?.hasCompletedOnboarding === true ? true : false,
  };
}

/**
 * Crea o registra un nuevo documento de usuario en `users/{uid}` asegurando
 * explícitamente la propiedad `hasCompletedOnboarding: false`.
 *
 * @param {object} user
 * @param {object} [options]
 * @param {any} [options.db]
 * @param {any} [options.firestoreDb]
 * @param {any} [options.firestoreModule]
 * @param {function} [options.doc]
 * @param {function} [options.setDoc]
 * @param {any} [options.storage]
 * @returns {Promise<object>}
 */
export async function registerNewUserDocument(user, options = {}) {
  const uid = String(user?.uid || options?.uid || '').trim();
  if (!uid) {
    throw new Error('El uid del usuario es obligatorio para crear el documento en users/{uid}.');
  }

  const newUserDoc = buildDefaultUserDocument({
    ...user,
    uid,
    hasCompletedOnboarding: false,
  });

  const db = options.db ?? options.firestoreDb ?? null;
  const fsMod = options.firestoreModule ?? null;
  const docFn = options.doc ?? fsMod?.doc;
  const setDocFn = options.setDoc ?? fsMod?.setDoc;

  if (db && typeof docFn === 'function' && typeof setDocFn === 'function') {
    const userRef = docFn(db, 'users', uid);
    await setDocFn(userRef, newUserDoc, { merge: true });
  }

  const storage =
    options.storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  if (storage && typeof storage.setItem === 'function') {
    storage.setItem(`${FIRESTORE_USERS_CACHE_PREFIX}${uid}`, JSON.stringify(newUserDoc));
  }

  return newUserDoc;
}

/**
 * Ejecuta la actualización asíncrona explícita en Firestore al presionar "🚀 Comenzar a usar Pisto":
 * `await updateDoc(doc(db, "users", auth.currentUser.uid), { hasCompletedOnboarding: true });`
 *
 * @param {object} [params]
 * @param {any} [params.auth]
 * @param {any} [params.db]
 * @param {any} [params.firestoreDb]
 * @param {any} [params.firestoreModule]
 * @param {function} [params.doc]
 * @param {function} [params.updateDoc]
 * @param {function} [params.setDoc]
 * @param {string} [params.uid]
 * @param {object} [params.extraFields]
 * @param {any} [params.storage]
 * @returns {Promise<{ uid: string, hasCompletedOnboarding: true, updatedInFirestore: boolean }>}
 */
export async function persistOnboardingCompletionInFirestore(params = {}) {
  const authObj =
    params.auth ||
    params.authService?.firebaseAuth ||
    globalThis.__PISTO_FIREBASE_AUTH__ || {
      currentUser:
        params.authService?.getCurrentUser?.() ||
        params.currentUser ||
        (params.uid ? { uid: params.uid } : null),
    };

  const resolvedUid = String(
    authObj?.currentUser?.uid ||
      params.uid ||
      params.authService?.getCurrentUser?.()?.uid ||
      params.authService?.getCurrentProfile?.()?.uid ||
      ''
  ).trim();

  if (!resolvedUid) {
    throw new Error('No se encontró un usuario autenticado (auth.currentUser.uid) para actualizar el Onboarding.');
  }

  const auth = authObj?.currentUser?.uid
    ? authObj
    : { ...authObj, currentUser: { ...(authObj?.currentUser || {}), uid: resolvedUid } };

  const fsContext =
    params.authService && typeof params.authService.getFirestoreContext === 'function'
      ? params.authService.getFirestoreContext()
      : {};

  const storage =
    params.storage ??
    fsContext.storage ??
    (typeof localStorage !== 'undefined' ? localStorage : null);

  if (storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function') {
    const docKey = `${FIRESTORE_USERS_CACHE_PREFIX}${auth.currentUser.uid}`;
    let existing = {};
    try {
      const raw = storage.getItem(docKey);
      if (raw) existing = JSON.parse(raw) || {};
    } catch {
      existing = {};
    }
    const updatedProfile = createUserProfile({
      ...existing,
      ...(params.extraFields || {}),
      uid: auth.currentUser.uid,
      hasCompletedOnboarding: true,
      updatedAt: new Date().toISOString(),
    });
    storage.setItem(docKey, JSON.stringify(updatedProfile));
    storage.setItem(`pisto_onboarding_completed_${auth.currentUser.uid}`, 'true');
    const cleanEmail = String(updatedProfile.email || auth.currentUser?.email || '')
      .trim()
      .toLowerCase();
    if (cleanEmail) {
      storage.setItem(`pisto_onboarding_completed_${cleanEmail}`, 'true');
    }
  }

  const db = params.db ?? params.firestoreDb ?? fsContext.firestoreDb ?? null;
  const fsMod = params.firestoreModule ?? fsContext.firestoreModule ?? null;
  const doc = params.doc ?? fsMod?.doc;
  const updateDoc = params.updateDoc ?? fsMod?.updateDoc;
  const setDoc = params.setDoc ?? fsMod?.setDoc;

  let updatedInFirestore = false;

  if (db && typeof doc === 'function') {
    if (typeof updateDoc === 'function') {
      try {
        await updateDoc(doc(db, 'users', auth.currentUser.uid), {
          hasCompletedOnboarding: true,
          ...(params.extraFields || {}),
        });
        updatedInFirestore = true;
      } catch {
        if (typeof setDoc === 'function') {
          try {
            await setDoc(
              doc(db, 'users', auth.currentUser.uid),
              {
                hasCompletedOnboarding: true,
                ...(params.extraFields || {}),
              },
              { merge: true }
            );
            updatedInFirestore = true;
          } catch {
            updatedInFirestore = false;
          }
        }
      }
    } else if (typeof setDoc === 'function') {
      try {
        await setDoc(
          doc(db, 'users', auth.currentUser.uid),
          {
            hasCompletedOnboarding: true,
            ...(params.extraFields || {}),
          },
          { merge: true }
        );
        updatedInFirestore = true;
      } catch {
        updatedInFirestore = false;
      }
    }
  }

  if (params.authService && typeof params.authService.saveUserProfile === 'function') {
    try {
      await params.authService.saveUserProfile(auth.currentUser.uid, {
        hasCompletedOnboarding: true,
        ...(params.extraFields || {}),
      });
    } catch {
      // Ya persistido en caché Local-First
    }
  }

  return {
    uid: auth.currentUser.uid,
    hasCompletedOnboarding: true,
    updatedInFirestore,
  };
}

/**
 * Sincroniza la visibilidad condicional del botón "Cerrar Sesión" (`#btn-profile-signout`):
 * - Se muestra ÚNICAMENTE cuando existe un usuario autenticado activo (`auth.currentUser !== null`).
 * - Si no hay sesión iniciada (`auth.currentUser === null`), se oculta por completo (`display: none`, `.is-hidden`, `hidden`).
 *
 * @param {any} [authOrUser]
 * @param {Document} [docRef]
 * @returns {boolean} `true` si el botón queda visible, `false` si se oculta.
 */
export function syncLogoutButtonVisibility(
  authOrUser = null,
  docRef = typeof document !== 'undefined' ? document : null
) {
  const candidateUser =
    authOrUser && typeof authOrUser === 'object' && 'currentUser' in authOrUser
      ? authOrUser.currentUser
      : authOrUser;

  const isAuthenticated = Boolean(
    candidateUser !== null &&
      candidateUser !== undefined &&
      typeof candidateUser === 'object' &&
      String(candidateUser.uid || '').trim() !== '' &&
      String(candidateUser.uid || '').trim() !== 'local_default_user'
  );

  if (docRef && typeof docRef.getElementById === 'function') {
    const signOutBtn = docRef.getElementById('btn-profile-signout');
    if (signOutBtn) {
      if (isAuthenticated) {
        signOutBtn.classList?.remove?.('is-hidden');
        signOutBtn.hidden = false;
        signOutBtn.removeAttribute?.('hidden');
        if (signOutBtn.style) {
          signOutBtn.style.display = '';
        }
      } else {
        signOutBtn.classList?.add?.('is-hidden');
        signOutBtn.hidden = true;
        signOutBtn.setAttribute?.('hidden', '');
        if (signOutBtn.style) {
          signOutBtn.style.display = 'none';
        }
      }
    }
  }

  return isAuthenticated;
}

/**
 * Remueve de forma segura cualquier elemento modal del Onboarding Wizard que esté montado en el DOM
 * y resetea las banderas globales.
 *
 * @param {Document} [docRef]
 */
export function removeOnboardingWizardFromDom(
  docRef = typeof document !== 'undefined' ? document : null
) {
  globalThis.__PISTO_ONBOARDING_WIZARD_OPEN__ = false;

  if (!docRef) return false;

  let removed = false;
  const dialogEl =
    typeof docRef.getElementById === 'function'
      ? docRef.getElementById(ONBOARDING_WIZARD_MODAL_ID)
      : null;

  if (dialogEl) {
    if (typeof dialogEl.close === 'function' && dialogEl.open) {
      try {
        dialogEl.close();
      } catch {
        dialogEl.removeAttribute?.('open');
      }
    } else {
      dialogEl.removeAttribute?.('open');
    }
    if (typeof dialogEl.remove === 'function') {
      dialogEl.remove();
      removed = true;
    } else if (dialogEl.parentNode) {
      dialogEl.parentNode.removeChild(dialogEl);
      removed = true;
    }
  }

  if (typeof docRef.querySelectorAll === 'function') {
    const extraNodes = docRef.querySelectorAll(
      `#${ONBOARDING_WIZARD_MODAL_ID}, dialog.onboarding-wizard-dialog`
    );
    extraNodes.forEach((node) => {
      if (typeof node.close === 'function' && node.open) {
        try {
          node.close();
        } catch {
          node.removeAttribute?.('open');
        }
      }
      if (typeof node.remove === 'function') {
        node.remove();
        removed = true;
      } else if (node.parentNode) {
        node.parentNode.removeChild(node);
        removed = true;
      }
    });
  }

  return removed;
}

/**
 * Al iniciar sesión, lee el documento `users/{uid}` de Firestore:
 * - Si `hasCompletedOnboarding === true`, NO invoca ni renderiza el Wizard bajo ninguna circunstancia (y limpia cualquier modal en el DOM).
 * - Si `hasCompletedOnboarding === false` (o `undefined`), inicializa el Wizard.
 *
 * @param {string|object} uidOrOptions
 * @param {object} [maybeOptions]
 * @returns {Promise<{ profile: object, hasCompletedOnboarding: boolean, wizardInitialized: boolean, shouldShowWizard: boolean }>}
 */
export async function verifyUserOnboardingOnSignIn(uidOrOptions, maybeOptions = {}) {
  const options =
    uidOrOptions && typeof uidOrOptions === 'object' ? uidOrOptions : maybeOptions || {};
  const explicitUid = typeof uidOrOptions === 'string' ? uidOrOptions : options.uid;
  const authObj = options.auth ?? options.firebaseAuth ?? null;
  const cleanUid = String(
    explicitUid || options.user?.uid || authObj?.currentUser?.uid || ''
  ).trim();
  if (!cleanUid) {
    throw new Error('El uid del usuario es obligatorio al verificar el inicio de sesión.');
  }

  syncLogoutButtonVisibility(
    { currentUser: options.user || authObj?.currentUser || { uid: cleanUid } },
    options.docRef
  );

  const db = options.db ?? options.firestoreDb ?? null;
  const fsMod = options.firestoreModule ?? null;
  const docFn = options.doc ?? fsMod?.doc;
  const getDocFn = options.getDoc ?? fsMod?.getDoc;
  const setDocFn = options.setDoc ?? fsMod?.setDoc;
  const storage =
    options.storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);

  let cachedData = null;
  if (storage && typeof storage.getItem === 'function') {
    try {
      const raw = storage.getItem(`${FIRESTORE_USERS_CACHE_PREFIX}${cleanUid}`);
      if (raw) cachedData = JSON.parse(raw);
    } catch {
      cachedData = null;
    }
  }

  const cleanEmail = String(
    options.user?.email || authObj?.currentUser?.email || cachedData?.email || ''
  )
    .trim()
    .toLowerCase();

  const localCompletedFlag =
    storage && typeof storage.getItem === 'function'
      ? storage.getItem(`pisto_onboarding_completed_${cleanUid}`) === 'true' ||
        (cleanEmail !== '' && storage.getItem(`pisto_onboarding_completed_${cleanEmail}`) === 'true')
      : false;

  let userData = null;

  if (db && typeof docFn === 'function' && typeof getDocFn === 'function') {
    try {
      const userRef = docFn(db, 'users', cleanUid);
      const snap = await getDocFn(userRef);
      if (snap && typeof snap.exists === 'function' && snap.exists()) {
        userData = snap.data() || {};
      } else if (typeof setDocFn === 'function') {
        const created = buildDefaultUserDocument({
          ...(options.user || authObj?.currentUser || {}),
          uid: cleanUid,
          hasCompletedOnboarding: Boolean(
            cachedData?.hasCompletedOnboarding === true || localCompletedFlag
          ),
        });
        userData = created;
        try {
          await setDocFn(userRef, created, { merge: true });
        } catch {
          // Respaldo Local-First
        }
      }
    } catch {
      // Fallback a caché local
    }
  }

  if (!userData && cachedData) {
    userData = cachedData;
  }

  const isCompleted = Boolean(
    userData?.hasCompletedOnboarding === true ||
      cachedData?.hasCompletedOnboarding === true ||
      localCompletedFlag
  );

  const profile = createUserProfile({
    ...(options.user || authObj?.currentUser || {}),
    ...(userData || {}),
    uid: cleanUid,
    hasCompletedOnboarding: isCompleted,
  });

  if (storage && typeof storage.setItem === 'function') {
    storage.setItem(`${FIRESTORE_USERS_CACHE_PREFIX}${cleanUid}`, JSON.stringify(profile));
    if (isCompleted) {
      storage.setItem(`pisto_onboarding_completed_${cleanUid}`, 'true');
      if (cleanEmail) {
        storage.setItem(`pisto_onboarding_completed_${cleanEmail}`, 'true');
      }
    }
  }

  if (profile.hasCompletedOnboarding === true) {
    removeOnboardingWizardFromDom(options.docRef);
    return {
      profile,
      hasCompletedOnboarding: true,
      wizardInitialized: false,
      shouldShowWizard: false,
    };
  }

  if (options.wizard) {
    const userTarget = options.user || authObj?.currentUser || { uid: cleanUid };
    if (typeof options.wizard.checkAndStartForUser === 'function') {
      await options.wizard.checkAndStartForUser(userTarget, profile, options);
    } else if (typeof options.wizard.open === 'function') {
      options.wizard.open({ user: userTarget, profile });
    }
  }

  return {
    profile,
    hasCompletedOnboarding: false,
    wizardInitialized: true,
    shouldShowWizard: true,
  };
}

/**
 * Limpia las claves residuales del almacenamiento local o de sesión asociadas al usuario
 * y al workspace simulado (`Pisto_open_finance_state_v1`, `pisto_local_auth_session_v1`,
 * `pisto_firestore_accounts_ws_*`, `pisto_firestore_transactions_ws_*`, `pisto_firestore_budgets_ws_*`,
 * `pisto_dashboard_metrics_ws_*`, etc.).
 * Si `options.clearAll === true`, ejecuta `localStorage.clear()` y `sessionStorage.clear()`.
 *
 * @param {object} [options]
 * @param {Storage|object|null} [options.storage]
 * @param {Storage|object|null} [options.sessionStorage]
 * @param {string|null} [options.workspaceId]
 * @param {string|null} [options.uid]
 * @param {boolean} [options.clearAll=false]
 * @returns {Array<string>} Claves eliminadas.
 */
export function clearUserAndWorkspaceStorageKeys(options = {}) {
  const storage =
    options.storage !== undefined
      ? options.storage
      : typeof localStorage !== 'undefined'
        ? localStorage
        : null;
  const sessionStore =
    options.sessionStorage !== undefined
      ? options.sessionStorage
      : typeof sessionStorage !== 'undefined'
        ? sessionStorage
        : null;
  const workspaceId = options.workspaceId ? String(options.workspaceId).trim() : null;
  const removedKeys = [];

  if (sessionStore && typeof sessionStore.clear === 'function') {
    try {
      sessionStore.clear();
    } catch {
      // Ignore sessionStorage errors
    }
  }

  if (!storage) return removedKeys;

  if (options.clearAll === true && typeof storage.clear === 'function') {
    try {
      storage.clear();
      return ['*'];
    } catch {
      // Fallback to selective key removal
    }
  }

  const fixedKeysToRemove = [
    'Pisto_open_finance_state_v1',
    LOCAL_AUTH_SESSION_KEY,
    'pisto_gemini_api_key_v1',
    'pisto_custom_firebase_config',
    'pisto_firebase_web_config_v1',
    'pisto_firestore_accounts_ws_ws_default',
    'pisto_firestore_transactions_ws_ws_default',
    'pisto_firestore_budgets_ws_ws_default',
    'pisto_dashboard_metrics_ws_ws_default',
  ];

  if (workspaceId) {
    fixedKeysToRemove.push(
      `pisto_firestore_accounts_ws_${workspaceId}`,
      `pisto_firestore_transactions_ws_${workspaceId}`,
      `pisto_firestore_budgets_ws_${workspaceId}`,
      `pisto_dashboard_metrics_ws_${workspaceId}`,
      `pisto_shared_ws_tx_${workspaceId}`
    );
  }

  if (typeof storage.removeItem === 'function') {
    for (const key of fixedKeysToRemove) {
      try {
        storage.removeItem(key);
        removedKeys.push(key);
      } catch {
        // Ignore storage errors
      }
    }
  }

  const discoveredKeys = new Set();
  if (typeof storage.length === 'number' && typeof storage.key === 'function') {
    for (let i = 0; i < storage.length; i += 1) {
      const k = storage.key(i);
      if (k) discoveredKeys.add(k);
    }
  }
  if (storage.map instanceof Map) {
    for (const k of storage.map.keys()) {
      if (k) discoveredKeys.add(String(k));
    }
  }
  try {
    for (const k of Object.keys(storage)) {
      if (k && k !== 'map' && typeof storage[k] !== 'function') {
        discoveredKeys.add(k);
      }
    }
  } catch {
    // Ignore non-enumerable storage
  }

  const residualPattern =
    /^(Pisto_open_finance_state_v1|pisto_local_auth_session_v1|pisto_firestore_(accounts|transactions|budgets)_ws_|pisto_dashboard_metrics_ws_|pisto_shared_ws_tx_|pisto_active_workspace)/i;

  for (const key of discoveredKeys) {
    if (residualPattern.test(key) && typeof storage.removeItem === 'function') {
      try {
        storage.removeItem(key);
        if (!removedKeys.includes(key)) {
          removedKeys.push(key);
        }
      } catch {
        // Ignore removal errors
      }
    }
  }

  return removedKeys;
}

/**
 * Limpia todas las variables de estado en memoria (`currentWorkspaceId = null`,
 * `accounts = []`, `transactions = []`, `budgets = {}`) en el estado de la aplicación y controladores.
 *
 * @param {object} [options]
 * @param {any} [options.state]
 * @param {any} [options.app]
 * @param {any} [options.authService]
 * @param {any} [options.repo]
 */
export function resetInMemoryStateOnLogout(options = {}) {
  const { state = null, app = null, authService = null, repo = null } = options;

  if (state && typeof state === 'object') {
    state.currentWorkspaceId = null;
    state.accounts = [];
    state.transactions = [];
    state.budgets = {};
    state.dashboardMetrics = { ...ZERO_DASHBOARD_METRICS };
    if (!state.settings || typeof state.settings !== 'object') {
      state.settings = {};
    }
    state.settings.workspaceId = null;
    state.settings.currentUid = null;
    state.settings.personalViewMode = false;
    state.settings.baseCurrency = 'HNL';
    state.settings.currencyFilter = 'HNL';
  }

  if (app && typeof app === 'object') {
    app.currentWorkspaceId = null;
    app.accounts = [];
    app.transactions = [];
    app.activeDetailAccountId = null;
    app.lastInsightsResult = null;
    app.lastScannedVoucher = null;
    app.currentStatementData = null;
    if (app.ledgerFilters && typeof app.ledgerFilters === 'object') {
      app.ledgerFilters.currencyFilter = 'HNL';
      app.ledgerFilters.accountFilter = 'all';
      app.ledgerFilters.typeFilter = 'all';
      app.ledgerFilters.searchQuery = '';
    }
  }

  if (authService && typeof authService === 'object') {
    authService.currentUser = null;
    authService.currentProfile = null;
    authService.currentWorkspaceId = null;
    authService.accounts = [];
    authService.transactions = [];
  }

  if (repo && typeof repo === 'object') {
    repo.memoryFallback = null;
  }

  return {
    currentWorkspaceId: null,
    accounts: [],
    transactions: [],
    budgets: {},
  };
}

/**
 * Redirige inmediatamente a la pantalla o modal de Inicio de Sesión / Registro (`#auth-dialog`).
 *
 * @param {Document|object|null} [docRef]
 * @param {any} [profileView]
 * @param {boolean} [registerMode=false]
 * @returns {boolean} `true` si el modal de autenticación quedó abierto.
 */
export function redirectToLoginModal(
  docRef = typeof document !== 'undefined' ? document : null,
  profileView = null,
  registerMode = false
) {
  let opened = false;

  if (profileView && typeof profileView.openAuthModal === 'function') {
    try {
      profileView.openAuthModal(Boolean(registerMode));
      opened = true;
    } catch {
      opened = false;
    }
  }

  if (docRef && typeof docRef.getElementById === 'function') {
    const authDialog = docRef.getElementById(AUTH_LOGIN_MODAL_ID);
    if (authDialog) {
      if (!authDialog.open) {
        if (typeof authDialog.showModal === 'function') {
          try {
            authDialog.showModal();
          } catch {
            authDialog.setAttribute?.('open', '');
          }
        } else {
          authDialog.setAttribute?.('open', '');
        }
        authDialog.open = true;
      }
      opened = true;
    }
  }

  return opened;
}

/**
 * Ejecuta la Limpieza Completa de Estado en Logout (`signOut(auth)`) o cuando no hay sesión activa:
 * 1. Limpia todas las variables de estado en memoria (`currentWorkspaceId = null`, `accounts = []`, `transactions = []`).
 * 2. Resetea explícitamente los elementos de la interfaz del Dashboard a cero/vacío en el DOM:
 *    - Patrimonios/Cuentas: `"L 0.00"`
 *    - Ingresos del Período: `"+ L 0.00"`
 *    - Gastos del Período: `"- L 0.00"`
 *    - Tasa de Ahorro: `"0%"`
 *    - Tablas de transacciones y tarjetas de cuentas: Limpiar contenedor (`innerHTML = ''`).
 * 3. Limpia las claves residuales del almacenamiento local o de sesión (`localStorage` / `sessionStorage`).
 * 4. Redirige inmediatamente al modal de Inicio de Sesión / Registro (`#auth-dialog`).
 *
 * @param {object} [options]
 * @param {any} [options.wizard]
 * @param {any} [options.state]
 * @param {any} [options.app]
 * @param {any} [options.authService]
 * @param {any} [options.profileView]
 * @param {any} [options.repo]
 * @param {Storage|object|null} [options.storage]
 * @param {Storage|object|null} [options.sessionStorage]
 * @param {string|null} [options.workspaceId]
 * @param {boolean} [options.clearAllStorage=false]
 * @param {boolean} [options.redirectToLogin=true]
 * @param {Document|object|null} [options.docRef]
 */
export function cleanupOnboardingOnLogout(options = {}) {
  const docRef =
    options.docRef !== undefined
      ? options.docRef
      : typeof document !== 'undefined'
        ? document
        : null;
  const prevWorkspaceId =
    options.workspaceId ||
    options.state?.settings?.workspaceId ||
    options.state?.currentWorkspaceId ||
    options.app?.currentWorkspaceId ||
    options.authService?.currentWorkspaceId ||
    options.authService?.currentProfile?.workspaceId ||
    null;

  const wizard = options.wizard ?? globalThis.__PISTO_ONBOARDING_WIZARD_INSTANCE__ ?? null;
  if (wizard && typeof wizard.resetOnLogout === 'function') {
    wizard.resetOnLogout(docRef);
  } else {
    removeOnboardingWizardFromDom(docRef);
  }

  syncLogoutButtonVisibility({ currentUser: null }, docRef);

  // 1a. Limpiar todas las variables de estado en memoria (currentWorkspaceId = null, accounts = [], transactions = [])
  const memoryReset = resetInMemoryStateOnLogout({
    state: options.state,
    app: options.app,
    authService: options.authService,
    repo: options.repo,
  });

  // 1b. Resetear explícitamente los elementos de la interfaz del Dashboard a cero/vacío en el DOM
  const domReset = resetDashboardDomToZeroAndEmpty(docRef, 'HNL');

  // 1c. Limpiar claves residuales del almacenamiento local o de sesión
  const removedKeys = clearUserAndWorkspaceStorageKeys({
    storage: options.storage,
    sessionStorage: options.sessionStorage,
    workspaceId: prevWorkspaceId,
    clearAll: Boolean(options.clearAllStorage),
  });

  // 2. Redirigir al modal de Inicio de Sesión / Registro si está habilitado
  const redirectedToLogin =
    options.redirectToLogin !== false
      ? redirectToLoginModal(docRef, options.profileView || options.app?.profileView, false)
      : false;

  return {
    modalRemoved: true,
    isOpen: false,
    currentWorkspaceId: memoryReset.currentWorkspaceId,
    accounts: memoryReset.accounts,
    transactions: memoryReset.transactions,
    domReset,
    removedKeys,
    redirectedToLogin,
  };
}

export const performCompleteLogoutCleanup = cleanupOnboardingOnLogout;

/**
 * Garantiza el Estado Inicial por Defecto para Visitantes / No Logueados
 * cuando la aplicación carga inicialmente en la raíz o pantalla de bienvenida/login
 * (`auth.onAuthStateChanged` con `user === null`):
 * - Mantiene los contadores en `0` estricto (`"L 0.00"`, `"+ L 0.00"`, `"- L 0.00"`, `"0%"`)
 *   sin mostrar transacciones ni cuentas residuales de sesiones pasadas (`innerHTML = ''`).
 * - Redirige inmediatamente a la pantalla o modal de Inicio de Sesión / Registro (`#auth-dialog`).
 *
 * @param {object} [options]
 */
export function handleUnauthenticatedVisitorState(options = {}) {
  return cleanupOnboardingOnLogout({
    ...options,
    redirectToLogin: options.redirectToLogin ?? true,
  });
}

/**
 * Ejecuta `signOut(auth)` junto con la limpieza completa de estado en memoria,
 * reseteo explícito del DOM del Dashboard a cero/vacío, limpieza de `localStorage`/`sessionStorage`
 * y redirección inmediata al modal de Inicio de Sesión.
 *
 * @param {object} [options]
 */
export async function signOutWithCompleteCleanup(options = {}) {
  const authService = options.authService || null;
  const firebaseAuth = options.auth || authService?.firebaseAuth || null;
  const signOutFn =
    options.signOut ||
    authService?.authModule?.signOut ||
    authService?.firebaseAuthModule?.signOut ||
    null;

  if (authService && typeof authService.signOut === 'function') {
    await authService.signOut();
  } else if (firebaseAuth && typeof signOutFn === 'function') {
    await signOutFn(firebaseAuth);
  }

  return cleanupOnboardingOnLogout({
    ...options,
    redirectToLogin: options.redirectToLogin ?? true,
  });
}
