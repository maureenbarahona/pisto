/**
 * @fileoverview Profile Settings UI Component (`src/js/components/ProfileView.js`).
 *
 * Implements:
 * 1. Country selector `<select id="user-country">` in the Profile view with standard ISO options
 *    (Honduras, Guatemala, El Salvador, Costa Rica, Nicaragua, Panama, Mexico, United States, etc.).
 * 2. Seamless country preference updates and form persistence to Firestore (`users/{uid}` via `updateDoc`),
 *    in-memory user profile state, and `localStorage`.
 * 3. Strict Vanilla JS (ESNext), HTML5, CSS3, zero `console.log` statements.
 */

import { ProfileViewController } from '../../../public/js/ui/profileView.js';
import {
  SUPPORTED_COUNTRIES,
  DEFAULT_USER_COUNTRY,
  COUNTRY_REGIONAL_CONFIG,
  normalizeUserCountryCode,
  getCountryRegionalConfig,
  getActiveUserCountry,
  updateUserProfile,
} from '../services/user.js';

export const USER_COUNTRY_SELECT_ID = 'user-country';

export const PROFILE_COUNTRY_OPTIONS = Object.freeze(
  SUPPORTED_COUNTRIES.map((country) => {
    const regional = COUNTRY_REGIONAL_CONFIG[country.code] || COUNTRY_REGIONAL_CONFIG.HN;
    return Object.freeze({
      code: country.code,
      name: country.name,
      flag: country.flag,
      defaultCurrency: regional.defaultCurrency,
      taxType: regional.taxType,
      label: `${country.flag} ${country.name} (${regional.defaultCurrency} · ${regional.taxType})`,
    });
  })
);

/**
 * Generates the HTML string for `<select id="user-country">` with standard country options.
 *
 * @param {string} [selectedCountry='HN']
 * @returns {string}
 */
export function renderUserCountrySelectorHtml(selectedCountry = DEFAULT_USER_COUNTRY) {
  const activeCode = normalizeUserCountryCode(selectedCountry);
  const optionsHtml = PROFILE_COUNTRY_OPTIONS.map((opt) => {
    const selectedAttr = opt.code === activeCode ? ' selected' : '';
    return `<option value="${opt.code}"${selectedAttr}>${opt.label}</option>`;
  }).join('');

  return [
    '<div class="field">',
    '  <label for="user-country">País de residencia</label>',
    '  <span id="user-country-hint" class="hint">Configura bancos, plantillas OCR e impuestos regionales (ISV/IVA)</span>',
    `  <select id="${USER_COUNTRY_SELECT_ID}" name="country" aria-describedby="user-country-hint" data-legacy-id="profile-country-select">`,
    `    ${optionsHtml}`,
    '  </select>',
    '</div>',
  ].join('\n');
}

/**
 * Ensures `<select id="user-country">` is present and populated in the provided DOM document or container.
 *
 * @param {Document|HTMLElement|null} [docOrContainer]
 * @param {string} [selectedCountry='HN']
 * @returns {HTMLSelectElement|null}
 */
export function ensureUserCountrySelectorInDom(
  docOrContainer = typeof document !== 'undefined' ? document : null,
  selectedCountry = DEFAULT_USER_COUNTRY
) {
  if (!docOrContainer) return null;

  const activeCode = normalizeUserCountryCode(selectedCountry);
  const getById =
    typeof docOrContainer.getElementById === 'function'
      ? (id) => docOrContainer.getElementById(id)
      : typeof docOrContainer.querySelector === 'function'
        ? (id) => docOrContainer.querySelector(`#${id}`)
        : () => null;

  let selectEl = getById(USER_COUNTRY_SELECT_ID) || getById('profile-country-select');

  if (!selectEl && typeof docOrContainer.querySelector === 'function') {
    const formEl =
      getById('profile-settings-form') ||
      docOrContainer.querySelector('form') ||
      docOrContainer;
    if (formEl && typeof formEl.insertAdjacentHTML === 'function') {
      formEl.insertAdjacentHTML('beforeend', renderUserCountrySelectorHtml(activeCode));
      selectEl = getById(USER_COUNTRY_SELECT_ID);
    }
  }

  if (selectEl) {
    selectEl.id = USER_COUNTRY_SELECT_ID;
    if (!selectEl.options || selectEl.options.length === 0) {
      selectEl.innerHTML = PROFILE_COUNTRY_OPTIONS.map((opt) => {
        const selectedAttr = opt.code === activeCode ? ' selected' : '';
        return `<option value="${opt.code}"${selectedAttr}>${opt.label}</option>`;
      }).join('');
    }
    selectEl.value = activeCode;
  }

  return selectEl;
}

/**
 * Profile Settings UI Component managing `<select id="user-country">` and profile updates.
 */
export class ProfileView extends ProfileViewController {
  /**
   * @param {any} [authServiceOrOptions]
   * @param {object} [callbacks]
   * @param {object} [options]
   */
  constructor(authServiceOrOptions = null, callbacks = {}, options = {}) {
    const isOptionsFirst =
      authServiceOrOptions &&
      typeof authServiceOrOptions === 'object' &&
      typeof authServiceOrOptions.saveUserProfile !== 'function' &&
      typeof authServiceOrOptions.getCurrentProfile !== 'function' &&
      ('uid' in authServiceOrOptions ||
        'storage' in authServiceOrOptions ||
        'firestoreDb' in authServiceOrOptions ||
        'firestoreModule' in authServiceOrOptions ||
        'onCountryChanged' in authServiceOrOptions ||
        'docRef' in authServiceOrOptions);

    const resolvedAuthService = isOptionsFirst
      ? authServiceOrOptions.authService || null
      : authServiceOrOptions;
    const resolvedOptions = isOptionsFirst
      ? { ...authServiceOrOptions, ...(options || {}) }
      : options || {};

    const safeCallbacks = {
      showToast: () => {},
      onAuthAndProfileUpdated: () => {},
      ...(isOptionsFirst && authServiceOrOptions.callbacks ? authServiceOrOptions.callbacks : {}),
      ...(callbacks || {}),
    };
    super(resolvedAuthService, safeCallbacks);
    this.options = resolvedOptions;
    this.docRef =
      resolvedOptions.docRef ||
      resolvedOptions.document ||
      (typeof document !== 'undefined' ? document : null);
  }

  /**
   * Returns the `<select id="user-country">` element from the DOM.
   * @returns {HTMLSelectElement|null}
   */
  getCountrySelectElement() {
    if (!this.docRef) return null;
    if (typeof this.docRef.getElementById === 'function') {
      return (
        this.docRef.getElementById(USER_COUNTRY_SELECT_ID) ||
        this.docRef.getElementById('profile-country-select')
      );
    }
    if (typeof this.docRef.querySelector === 'function') {
      return (
        this.docRef.querySelector(`#${USER_COUNTRY_SELECT_ID}`) ||
        this.docRef.querySelector('#profile-country-select')
      );
    }
    return null;
  }

  /**
   * Renders or hydrates `<select id="user-country">` and binds change/submit handlers.
   */
  mount(container = null) {
    const targetRoot = container || this.docRef;
    const currentCountry = getActiveUserCountry({
      authService: this.authService,
      storage: this.options.storage,
      state: this.options.state,
    });
    const selectEl = ensureUserCountrySelectorInDom(targetRoot, currentCountry);

    if (selectEl && !selectEl.dataset.countryListenerBound) {
      selectEl.dataset.countryListenerBound = 'true';
      selectEl.addEventListener('change', async () => {
        await this.updateCountryPreference(selectEl.value);
      });
    }

    if (this.authService && typeof super.init === 'function' && targetRoot === document) {
      super.init();
    }

    return selectEl;
  }

  /**
   * Updates the user's `country` preference in Firestore (`updateDoc`), memory, and `localStorage`,
   * and synchronizes the `<select id="user-country">` UI value.
   *
   * @param {string} newCountryCode
   * @param {object} [extraUpdates]
   * @returns {Promise<object>}
   */
  async updateCountryPreference(newCountryCode, extraUpdates = {}) {
    const normalizedCountry = normalizeUserCountryCode(newCountryCode);
    const selectEl = this.getCountrySelectElement();
    if (selectEl) {
      selectEl.value = normalizedCountry;
    }

    const uid =
      this.options.uid ||
      this.authService?.getCurrentUser?.()?.uid ||
      this.authService?.getCurrentProfile?.()?.uid ||
      'local_default_user';

    const updatedProfile = await updateUserProfile(
      uid,
      {
        ...extraUpdates,
        country: normalizedCountry,
      },
      {
        authService: this.authService,
        storage: this.options.storage,
        firestoreDb: this.options.firestoreDb,
        firestoreModule: this.options.firestoreModule,
        state: this.options.state,
      }
    );

    const regional = getCountryRegionalConfig(normalizedCountry);
    this.callbacks?.showToast?.(
      `🌎 País actualizado a ${regional.flag} ${regional.name} (${regional.code})`
    );
    await this.callbacks?.onAuthAndProfileUpdated?.(
      this.authService?.getCurrentUser?.() || { uid, country: normalizedCountry },
      updatedProfile,
      'country-changed'
    );
    await this.options?.onCountryChanged?.(updatedProfile, normalizedCountry);

    return updatedProfile;
  }
}

export { ProfileViewController, SUPPORTED_COUNTRIES };
