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

export const ONBOARDING_WIZARD_MODAL_ID = 'onboarding-wizard-dialog';

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
 * Limpieza segura en Cierre de Sesión (`Logout`):
 * Remueve cualquier modal del Wizard montado en el DOM, oculta el botón de Cerrar Sesión y resetea los estados locales.
 *
 * @param {object} [options]
 * @param {any} [options.wizard]
 * @param {any} [options.state]
 * @param {Document} [options.docRef]
 */
export function cleanupOnboardingOnLogout(options = {}) {
  const wizard = options.wizard ?? globalThis.__PISTO_ONBOARDING_WIZARD_INSTANCE__ ?? null;
  if (wizard && typeof wizard.resetOnLogout === 'function') {
    wizard.resetOnLogout(options.docRef);
  } else {
    removeOnboardingWizardFromDom(options.docRef);
  }

  syncLogoutButtonVisibility({ currentUser: null }, options.docRef);

  if (options.state && typeof options.state === 'object') {
    if (options.state.settings && typeof options.state.settings === 'object') {
      options.state.settings.currentUid = 'local_default_user';
      options.state.settings.workspaceId = 'ws_default';
      options.state.settings.personalViewMode = false;
    }
  }

  return {
    modalRemoved: true,
    isOpen: false,
  };
}
