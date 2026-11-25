/**
 * An error that carries one of the machine-readable codes of the visual-ci-result
 * JSON (see result.js). It lives in its own module, with no imports, so config.js and
 * capture.js can use it without an import cycle through the server modules.
 */
export class CliError extends Error {
  /**
   * @param {string} code - e.g. 'CONFIG_NOT_FOUND' (see ERROR_CODES in result.js)
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, options) {
    super(message, options);
    this.name = 'CliError';
    this.code = code;
  }
}
