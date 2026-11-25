/**
 * Human-readable CLI output. Normally progress goes to stdout and warnings/errors to
 * stderr; with `--json -` stdout is reserved for the JSON result, so everything goes
 * to stderr.
 *
 * @param {{ stdoutReserved?: boolean }} [options]
 * @returns {{ info: (...args: unknown[]) => void, warn: (...args: unknown[]) => void, error: (...args: unknown[]) => void }}
 */
export function createLogger({ stdoutReserved = false } = {}) {
  return {
    info: (...args) => (stdoutReserved ? console.error(...args) : console.log(...args)),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args)
  };
}
