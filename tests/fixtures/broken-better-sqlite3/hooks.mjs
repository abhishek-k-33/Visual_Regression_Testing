export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'better-sqlite3' || specifier.startsWith('better-sqlite3/')) {
    const err = new Error(`Cannot find package 'better-sqlite3' imported from ${context.parentURL} (simulated by the test loader)`);
    err.code = 'ERR_MODULE_NOT_FOUND';
    throw err;
  }
  return nextResolve(specifier, context);
}
