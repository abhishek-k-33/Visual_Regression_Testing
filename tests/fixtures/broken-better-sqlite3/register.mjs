// node --import <this file> ...: makes every import of better-sqlite3 fail, as if its
// native build had failed or the package were missing (tests/lazy-imports.test.js).
import { register } from 'node:module';

register('./hooks.mjs', import.meta.url);
