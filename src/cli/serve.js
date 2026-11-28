import { CliError } from './errors.js';

export const DEFAULT_PORT = 4000;
export const DEFAULT_HOST = '127.0.0.1';

/**
 * A TCP port from a flag or an environment variable: a whole number from 0 to 65535
 * (0 picks a free port).
 *
 * @param {unknown} value
 * @param {string} source - Where it came from, for the error message (e.g. "--port")
 * @returns {number}
 * @throws {CliError} INVALID_ARGUMENT
 */
export function parsePort(value, source) {
  const text = String(value ?? '').trim();
  if (/^\d{1,5}$/.test(text) && Number(text) <= 65535) return Number(text);
  throw new CliError('INVALID_ARGUMENT', `Invalid port ${JSON.stringify(String(value ?? ''))} (from ${source}): use a whole number from 0 to 65535.`);
}

/**
 * Port and host for `visual-ci serve`: the flags, else PORT / HOST from the
 * environment (as `node src/server/app.js` uses them), else 4000 and 127.0.0.1.
 *
 * @param {{ port?: string, host?: string }} options - Parsed flags
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {{ port: number, host: string }}
 */
export function resolveServeOptions(options, env = process.env) {
  const port = options.port !== undefined
    ? parsePort(options.port, '--port')
    : env.PORT ? parsePort(env.PORT, 'the PORT environment variable') : DEFAULT_PORT;

  let host = DEFAULT_HOST;
  if (options.host !== undefined) {
    host = String(options.host).trim();
    if (!host) throw new CliError('INVALID_ARGUMENT', '--host cannot be empty.');
  } else if (env.HOST) {
    host = env.HOST;
  }
  return { port, host };
}
