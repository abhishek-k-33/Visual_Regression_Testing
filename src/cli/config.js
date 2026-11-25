import fs from 'node:fs'; // imports the node js file system
import path from 'node:path';//helper function that glues folder names together correctly
import { assertUniqueSnapshotFiles } from './naming.js';
import { CliError } from './errors.js';

/**
 * Validates and normalizes visual regression test configuration.
 *
 * @param {object} config - Configuration object to validate
 * @returns {object} Normalized configuration object
 * @throws {Error} If configuration fails schema validation
 */
export function validateConfig(config) {// when we use the export function that means other files in our project can use this function
  if (!config || typeof config !== 'object' || Array.isArray(config)) {// if the config is not an object or is not given or is an array
    // then this block of code will be executed
    throw new Error('Configuration must be a valid JSON object.');
  }

  // 1. Validate baseUrl
  if (!config.baseUrl || typeof config.baseUrl !== 'string') {// if url in config is not given or is not a string then this block of code
    // is executed
    throw new Error('Invalid configuration: "baseUrl" is required and must be a string.');
  }

  let parsedUrl; 
  try {// this block of code checks if the base url is valid or is just gibberish and executes further code accordingly
    parsedUrl = new URL(config.baseUrl);// this url method combines valid urls and throws an error for invalid urls
  } catch {
    throw new Error(`Invalid configuration: "baseUrl" must be a valid URL. Received: "${config.baseUrl}"`);
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {// checks the protocol that is being used in the url
    throw new Error(`Invalid configuration: "baseUrl" protocol must be http: or https:. Received: "${parsedUrl.protocol}"`);
  }

  // Normalize baseUrl by stripping trailing slash
  const normalizedBaseUrl = config.baseUrl.replace(/\/+$/, '');//autocleaner prevents the // error

  // 2. Validate routes
  if (!Array.isArray(config.routes) || config.routes.length === 0) {// checks if routes exist 
    throw new Error('Invalid configuration: "routes" must be a non-empty array of URL paths.');
  }

  const normalizedRoutes = config.routes.map((route, idx) => {// const.routes is the array of all routes the user gave us
    //.map is a javascript function that iterates each item from the list, run its through a code block the output is obtained as a new list
    // route and idx are the routes and indexes of the routes from the list 
    if (typeof route !== 'string' || route.trim() === '') {// route.trim removes the spaces from the string 
      throw new Error(`Invalid configuration: Route at index ${idx} must be a non-empty string.`);
    }
    const trimmed = route.trim();
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`; // returnes the trimmed variable by adding / automatically if someone forgets
  });

  // 3. Validate viewports
  if (!Array.isArray(config.viewports) || config.viewports.length === 0) {// checks if viewports exist or not 
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
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmedName)) {// the code inside the /'s is a regular expression. It defines the exact pattern of 
      //characters that are allowed through the value 
      throw new Error(`Invalid configuration: Viewport "${trimmedName}" name may only contain alphanumeric characters, hyphens, and underscores.`);
    }

    if (viewportNames.has(trimmedName)) {// throws an error if 2 devices have the exact same viewport name
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

  // Every route/viewport pair must get its own screenshot and diff file
  assertUniqueSnapshotFiles(normalizedRoutes, normalizedViewports);

  // 4. Validate maskSelectors (optional, defaults to [])
  let normalizedMaskSelectors = [];// an empty list for the css selectors to hide. Default initialized so that If not specified by the user
  // the code do not crash
  if (config.maskSelectors !== undefined) {
    if (!Array.isArray(config.maskSelectors)) {
      throw new Error('Invalid configuration: "maskSelectors" must be an array of CSS selector strings.');
    }
    normalizedMaskSelectors = config.maskSelectors.map((sel, idx) => {
      if (typeof sel !== 'string' || sel.trim() === '') {
        throw new Error(`Invalid configuration: Mask selector at index ${idx} must be a non-empty string.`);
      }
      const trimmed = sel.trim();
      if (trimmed.includes('{') || trimmed.includes('}')) {// prevent a famous vulnarability css injection
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
  const storageDir = validateStorageDir(config.storageDir);

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
 * Validates the optional storageDir and returns it (default "storage").
 * It must be a subdirectory of the project (cwd).
 *
 * @param {unknown} value
 * @returns {string}
 */
export function validateStorageDir(value) {
  const storageDir = typeof value === 'string' && value.trim() !== '' ? value.trim() : 'storage';

  // Compare path segments: a prefix check would accept "/proj-evil" for "/proj".
  const relativeStorage = path.relative(process.cwd(), path.resolve(process.cwd(), storageDir));
  if (relativeStorage === '') {
    throw new Error('Invalid configuration: "storageDir" must be a subdirectory, not the project root itself.');
  }
  if (relativeStorage === '..' || relativeStorage.startsWith(`..${path.sep}`) || path.isAbsolute(relativeStorage)) {
    throw new Error('Invalid configuration: "storageDir" must be located inside the project workspace.');
  }
  return storageDir;
}

/**
 * Safely strips single-line (//) and multi-line (/* ... * /) comments from JSON strings
 * while strictly preserving string literals (including URLs with //).
 *
 * @param {string} jsonString - Raw JSON string with potential comments
 * @returns {string} Clean JSON string without comments
 */
export function stripJsonComments(jsonString) {
  const sanitizedInput = (jsonString || '').replace(/^\uFEFF/, '');
  let insideString = false;
  let isEscaped = false;
  let result = '';

  for (let i = 0; i < sanitizedInput.length; i++) {
    const char = sanitizedInput[i];
    const nextChar = sanitizedInput[i + 1];

    if (insideString) {
      result += char;
      if (isEscaped) {
        isEscaped = false;
      } else if (char === '\\') {
        isEscaped = true;
      } else if (char === '"') {
        insideString = false;
      }
    } else {
      if (char === '"') {
        insideString = true;
        result += char;
      } else if (char === '/' && nextChar === '/') {
        while (i < sanitizedInput.length && sanitizedInput[i] !== '\n' && sanitizedInput[i] !== '\r') {
          i++;
        }
        if (i < sanitizedInput.length) {
          result += sanitizedInput[i];
        }
      } else if (char === '/' && nextChar === '*') {
        i += 2;
        while (i < sanitizedInput.length - 1 && !(sanitizedInput[i] === '*' && sanitizedInput[i + 1] === '/')) {
          i++;
        }
        i++;
      } else {
        result += char;
      }
    }
  }

  return result;
}

/**
 * Reads only "storageDir" from a config file, for commands that don't visit a site
 * (e.g. `import`), so a config without baseUrl still works.
 *
 * @param {string} [customPath] - Config path given by the user (must exist)
 * @returns {string|null} The validated storageDir, or null when no config file is used
 *   (no customPath and no ./visual.config.json)
 * @throws {Error} If the file is missing (customPath only), unreadable, not JSON, or
 *   its storageDir is invalid
 */
export function readConfiguredStorageDir(customPath) {
  const resolvedPath = path.resolve(process.cwd(), customPath || 'visual.config.json');
  if (!fs.existsSync(resolvedPath)) {
    if (customPath) throw new CliError('CONFIG_NOT_FOUND', `Configuration file not found at: ${resolvedPath}`);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(stripJsonComments(fs.readFileSync(resolvedPath, 'utf8')));
  } catch (err) {
    throw new CliError('CONFIG_INVALID', `Failed to parse configuration file ${resolvedPath} as JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError('CONFIG_INVALID', `Configuration file ${resolvedPath} must contain a JSON object.`);
  }
  try {
    return validateStorageDir(parsed.storageDir);
  } catch (err) {
    throw new CliError('CONFIG_INVALID', err.message, { cause: err });
  }
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
    ? path.resolve(process.cwd(), customPath)// path.resolver glues the process current working directory with the custom path name
    : path.resolve(process.cwd(), 'visual.config.json');// glues the process cwd with the visual.config.json 

  if (!fs.existsSync(resolvedPath)) {// fs.existsSync check the path specified as an argument exists or not
    throw new CliError('CONFIG_NOT_FOUND', `Configuration file not found at: ${resolvedPath}`);
  }

  let fileContent;
  try {
    fileContent = fs.readFileSync(resolvedPath, 'utf8');// reads the file at the address
  } catch (err) {
    throw new CliError('CONFIG_INVALID', `Failed to read configuration file at ${resolvedPath}: ${err.message}`);
  }

  let parsedConfig;
  try {
    const sanitized = stripJsonComments(fileContent);
    parsedConfig = JSON.parse(sanitized);// converts the file content to json format
  } catch (err) {
    throw new CliError('CONFIG_INVALID', `Failed to parse configuration file as JSON: ${err.message}`);
  }

  // Merge overrides
  const mergedConfig = {// the ... are known as the spread operators in javascript. These 2 cofigs dumps their content to the mergedConfig
    ...parsedConfig,
    ...overrides
  };

  try {
    return validateConfig(mergedConfig);// takes the mergedConfig and runs it into validate config for validation.
  } catch (err) {
    throw new CliError('CONFIG_INVALID', err.message, { cause: err });
  }
}
