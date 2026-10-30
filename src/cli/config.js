import fs from 'node:fs';
import path from 'node:path';

/**
 * Validates and normalizes visual regression test configuration.
 *
 * @param {object} config - Configuration object to validate
 * @returns {object} Normalized configuration object
 * @throws {Error} If configuration fails schema validation
 */
export function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Configuration must be a valid JSON object.');
  }

  // 1. Validate baseUrl
  if (!config.baseUrl || typeof config.baseUrl !== 'string') {
    throw new Error('Invalid configuration: "baseUrl" is required and must be a string.');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(config.baseUrl);
  } catch {
    throw new Error(`Invalid configuration: "baseUrl" must be a valid URL. Received: "${config.baseUrl}"`);
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`Invalid configuration: "baseUrl" protocol must be http: or https:. Received: "${parsedUrl.protocol}"`);
  }

  // Normalize baseUrl by stripping trailing slash
  const normalizedBaseUrl = config.baseUrl.replace(/\/+$/, '');

  // 2. Validate routes
  if (!Array.isArray(config.routes) || config.routes.length === 0) {
    throw new Error('Invalid configuration: "routes" must be a non-empty array of URL paths.');
  }

  const normalizedRoutes = config.routes.map((route, idx) => {
    if (typeof route !== 'string' || route.trim() === '') {
      throw new Error(`Invalid configuration: Route at index ${idx} must be a non-empty string.`);
    }
    const trimmed = route.trim();
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  });

  // 3. Validate viewports
  if (!Array.isArray(config.viewports) || config.viewports.length === 0) {
    throw new Error('Invalid configuration: "viewports" must be a non-empty array of viewport definitions.');
  }

  const viewportNames = new Set();
  const normalizedViewports = config.viewports.map((vp, idx) => {
    if (!vp || typeof vp !== 'object' || Array.isArray(vp)) {
      throw new Error(`Invalid configuration: Viewport at index ${idx} must be an object with name, width, and height.`);
    }

    if (!vp.name || typeof vp.name !== 'string' || vp.name.trim() === '') {
      throw new Error(`Invalid configuration: Viewport at index ${idx} must have a non-empty "name" string.`);
    }

    const trimmedName = vp.name.trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmedName)) {
      throw new Error(`Invalid configuration: Viewport "${trimmedName}" name may only contain alphanumeric characters, hyphens, and underscores.`);
    }

    if (viewportNames.has(trimmedName)) {
      throw new Error(`Invalid configuration: Duplicate viewport name "${trimmedName}" found.`);
    }
    viewportNames.add(trimmedName);

    if (typeof vp.width !== 'number' || !Number.isInteger(vp.width) || vp.width <= 0) {
      throw new Error(`Invalid configuration: Viewport "${trimmedName}" width must be a positive integer. Received: ${vp.width}`);
    }

    if (typeof vp.height !== 'number' || !Number.isInteger(vp.height) || vp.height <= 0) {
      throw new Error(`Invalid configuration: Viewport "${trimmedName}" height must be a positive integer. Received: ${vp.height}`);
    }

    return {
      name: trimmedName,
      width: vp.width,
      height: vp.height
    };
  });

  // 4. Validate maskSelectors (optional, defaults to [])
  let normalizedMaskSelectors = [];
  if (config.maskSelectors !== undefined) {
    if (!Array.isArray(config.maskSelectors)) {
      throw new Error('Invalid configuration: "maskSelectors" must be an array of CSS selector strings.');
    }
    normalizedMaskSelectors = config.maskSelectors.map((sel, idx) => {
      if (typeof sel !== 'string' || sel.trim() === '') {
        throw new Error(`Invalid configuration: Mask selector at index ${idx} must be a non-empty string.`);
      }
      const trimmed = sel.trim();
      if (trimmed.includes('{') || trimmed.includes('}')) {
        throw new Error(`Invalid configuration: Mask selector at index ${idx} contains invalid characters "{" or "}".`);
      }
      return trimmed;
    });
  }

  // 5. Validate threshold (optional, defaults to 0.01)
  let normalizedThreshold = 0.01;
  if (config.threshold !== undefined) {
    if (typeof config.threshold !== 'number' || Number.isNaN(config.threshold) || config.threshold < 0 || config.threshold > 1) {
      throw new Error(`Invalid configuration: "threshold" must be a number between 0 and 1. Received: ${config.threshold}`);
    }
    normalizedThreshold = config.threshold;
  }

  // 6. Optional storageDir
  const storageDir = typeof config.storageDir === 'string' && config.storageDir.trim() !== ''
    ? config.storageDir.trim()
    : 'storage';

  return {
    baseUrl: normalizedBaseUrl,
    routes: normalizedRoutes,
    viewports: normalizedViewports,
    maskSelectors: normalizedMaskSelectors,
    threshold: normalizedThreshold,
    storageDir
  };
}

/**
 * Loads, parses, and validates the visual regression configuration file.
 *
 * @param {string} [customPath] - Optional path to visual.config.json
 * @param {object} [overrides={}] - Optional runtime overrides (e.g. from CLI flags)
 * @returns {object} Validated configuration object
 */
export function loadConfig(customPath, overrides = {}) {
  const resolvedPath = customPath
    ? path.resolve(process.cwd(), customPath)
    : path.resolve(process.cwd(), 'visual.config.json');

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Configuration file not found at: ${resolvedPath}`);
  }

  let fileContent;
  try {
    fileContent = fs.readFileSync(resolvedPath, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read configuration file at ${resolvedPath}: ${err.message}`);
  }

  let parsedConfig;
  try {
    parsedConfig = JSON.parse(fileContent);
  } catch (err) {
    throw new Error(`Failed to parse configuration file as JSON: ${err.message}`);
  }

  // Merge overrides
  const mergedConfig = {
    ...parsedConfig,
    ...overrides
  };

  return validateConfig(mergedConfig);
}
