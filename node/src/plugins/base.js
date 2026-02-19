import { BUILTIN_PROVIDER_IDS } from '../config.js';

export function boolish(value, fallback = false) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 't', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'f', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

export function providerConfig(config, providerId) {
  if (BUILTIN_PROVIDER_IDS.includes(providerId)) {
    return config?.[providerId] ?? {};
  }
  const pluginSection = config?.plugins?.[providerId];
  return pluginSection && typeof pluginSection === 'object' ? pluginSection : {};
}

export function providerEnabled(config, providerId) {
  const section = providerConfig(config, providerId);
  return boolish(section.enabled, false);
}

export class PluginHelpers {
  constructor(config) {
    this.config = config;
  }

  configFor(providerId) {
    return providerConfig(this.config, providerId);
  }

  isEnabled(providerId) {
    return providerEnabled(this.config, providerId);
  }

  requireStr(providerId, key, customMessage = null) {
    const section = this.configFor(providerId);
    const value = section?.[key];
    if (value === null || value === undefined || String(value).trim() === '') {
      if (customMessage) {
        throw new Error(customMessage);
      }
      throw new Error(`Missing required config value: [${providerId}].${key}`);
    }
    return String(value).trim();
  }
}

export class FunctionalProviderPlugin {
  constructor({
    id,
    source = 'inline',
    description = '',
    supportsAuth = false,
    syncFn,
    authFn = null,
  }) {
    if (!id) {
      throw new Error('FunctionalProviderPlugin requires id');
    }
    if (typeof syncFn !== 'function') {
      throw new Error(`FunctionalProviderPlugin(${id}) requires syncFn`);
    }
    this.id = id;
    this.source = source;
    this.description = description;
    this.supportsAuth = supportsAuth || typeof authFn === 'function';
    this._syncFn = syncFn;
    this._authFn = authFn;
  }

  async sync(db, config, helpers, options = {}) {
    return this._syncFn(db, config, helpers, options);
  }

  async auth(db, config, helpers, options = {}) {
    if (typeof this._authFn !== 'function') {
      throw new Error(`Provider ${this.id} does not support auth`);
    }
    return this._authFn(db, config, helpers, options);
  }
}

export class ObjectProviderPlugin {
  constructor(id, pluginObject, source = 'module', moduleSpec = null) {
    this.id = id;
    this._object = pluginObject;
    this.source = pluginObject.source || source;
    this.description = pluginObject.description || '';
    this.supportsAuth = typeof pluginObject.auth === 'function';
    this.moduleSpec = moduleSpec;
  }

  async sync(db, config, helpers, options = {}) {
    return this._object.sync(db, config, helpers, options);
  }

  async auth(db, config, helpers, options = {}) {
    if (typeof this._object.auth !== 'function') {
      throw new Error(`Provider ${this.id} does not support auth`);
    }
    return this._object.auth(db, config, helpers, options);
  }
}
