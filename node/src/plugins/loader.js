import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUILTIN_PROVIDER_IDS } from '../config.js';
import { ObjectProviderPlugin } from './base.js';
import { builtInProviders } from '../providers/index.js';

function isClassLike(fn) {
  if (typeof fn !== 'function') {
    return false;
  }
  const proto = fn.prototype;
  return !!proto && typeof proto === 'object' && typeof proto.sync === 'function';
}

async function coercePluginObject(moduleExports, moduleSpec, configuredId = null) {
  const candidates = [];
  if (moduleExports?.default !== undefined) {
    candidates.push(moduleExports.default);
  }
  candidates.push(moduleExports);
  if (moduleExports?.plugin !== undefined) {
    candidates.push(moduleExports.plugin);
  }
  if (moduleExports?.createPlugin !== undefined) {
    candidates.push(moduleExports.createPlugin);
  }

  let pluginObj = null;
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (typeof candidate === 'object' && typeof candidate.sync === 'function') {
      pluginObj = candidate;
      break;
    }
    if (isClassLike(candidate)) {
      pluginObj = new candidate();
      break;
    }
    if (typeof candidate === 'function') {
      const produced = candidate();
      pluginObj = produced && typeof produced.then === 'function' ? await produced : produced;
      if (pluginObj && typeof pluginObj.sync === 'function') {
        break;
      }
      pluginObj = null;
    }
  }

  if (!pluginObj || typeof pluginObj.sync !== 'function') {
    throw new Error(`Module ${moduleSpec} must export a provider object with a sync() method`);
  }
  if (!pluginObj.id || typeof pluginObj.id !== 'string') {
    throw new Error(`Module ${moduleSpec} provider is missing string id`);
  }
  if (configuredId && configuredId !== pluginObj.id) {
    throw new Error(`Plugin id mismatch for ${moduleSpec}: expected ${configuredId} but got ${pluginObj.id}`);
  }

  return new ObjectProviderPlugin(pluginObj.id, pluginObj, 'module', moduleSpec);
}

function resolveImportSpec(moduleSpec, cwd = process.cwd()) {
  if (moduleSpec.startsWith('.') || moduleSpec.startsWith('/')) {
    const absolute = path.resolve(cwd, moduleSpec);
    return pathToFileURL(absolute).href;
  }
  return moduleSpec;
}

async function loadFromModuleSpec(moduleSpec, configuredId = null, cwd = process.cwd()) {
  const importSpec = resolveImportSpec(moduleSpec, cwd);
  const mod = await import(importSpec);
  return coercePluginObject(mod, moduleSpec, configuredId);
}

function readPackageProviderSpecs(cwd = process.cwd()) {
  const packagePath = path.join(cwd, 'package.json');
  if (!fs.existsSync(packagePath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    const specs = parsed?.healthSyncProviders;
    if (!specs || typeof specs !== 'object' || Array.isArray(specs)) {
      return {};
    }
    return specs;
  } catch {
    return {};
  }
}

export async function loadProviders(config, options = {}) {
  const { cwd = process.cwd() } = options;
  const providers = new Map();
  const metadata = new Map();

  for (const plugin of builtInProviders()) {
    providers.set(plugin.id, plugin);
    metadata.set(plugin.id, {
      source: plugin.source,
      moduleSpec: null,
      builtin: true,
    });
  }

  const packageSpecs = readPackageProviderSpecs(cwd);
  for (const [id, moduleSpec] of Object.entries(packageSpecs)) {
    if (!moduleSpec || typeof moduleSpec !== 'string') {
      continue;
    }
    if (BUILTIN_PROVIDER_IDS.includes(id)) {
      console.warn(`Ignoring package provider override for built-in provider ${id}`);
      continue;
    }
    try {
      const plugin = await loadFromModuleSpec(moduleSpec, id, cwd);
      if (providers.has(plugin.id)) {
        console.warn(`Ignoring duplicate provider id ${plugin.id} from ${moduleSpec}`);
        continue;
      }
      providers.set(plugin.id, plugin);
      metadata.set(plugin.id, {
        source: plugin.source,
        moduleSpec,
        builtin: false,
      });
    } catch (err) {
      console.warn(`Failed to load package provider ${id} (${moduleSpec}): ${err.message}`);
    }
  }

  const pluginConfig = config?.plugins && typeof config.plugins === 'object' ? config.plugins : {};
  for (const [configuredId, pluginSection] of Object.entries(pluginConfig)) {
    if (!pluginSection || typeof pluginSection !== 'object' || Array.isArray(pluginSection)) {
      continue;
    }
    const moduleSpec = typeof pluginSection.module === 'string' ? pluginSection.module.trim() : '';
    if (!moduleSpec) {
      continue;
    }
    if (BUILTIN_PROVIDER_IDS.includes(configuredId)) {
      throw new Error(`Cannot override built-in provider \`${configuredId}\`.`);
    }

    let plugin;
    try {
      plugin = await loadFromModuleSpec(moduleSpec, configuredId, cwd);
    } catch (err) {
      throw new Error(`Failed to load configured plugin ${configuredId} (${moduleSpec}): ${err.message}`);
    }

    if (providers.has(plugin.id) && providers.get(plugin.id)?.source === 'builtin') {
      throw new Error(`Cannot override built-in provider \`${plugin.id}\`.`);
    }

    providers.set(plugin.id, plugin);
    metadata.set(plugin.id, {
      source: plugin.source,
      moduleSpec,
      builtin: false,
    });
  }

  return {
    providers,
    metadata,
  };
}
