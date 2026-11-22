// File naming for screenshots, shared by capture, compare, config validation and
// run.json. Kept free of Playwright so lightweight modules can import it.

/**
 * Creates a clean filesystem-friendly slug from a URL route.
 *
 * @param {string} route - The route path (e.g. "/" or "/blog/post-1")
 * @returns {string} Clean file slug
 */
export function getRouteSlug(route) {// converts a web address into a safe legal framework on our computer 
  // what this function does is that if removes / from page names so that it can be saved as a file
  if (!route || route === '/') {
    return 'index'; // returns the name of the homepage which is generally named index.html
  }
  return route
    .replace(/^\/+/, '')// replaces the slashes at the very front of the address. ^ means at the beginning 
    .replace(/\/+$/, '')// replaces the slashes at the very last of the address ,$ means attthe end
    .replace(/[^a-zA-Z0-9_-]/g, '_');// ^ means anything except. replaces anything except atoz and 0to9 ,_,-with _
}

/**
 * Generates standard screenshot filename.
 *
 * @param {string} route - URL route
 * @param {string} viewportName - Viewport identifier
 * @returns {string} Filename (e.g. "index-desktop.png")
 */
export function getSnapshotFilename(route, viewportName) {
  const slug = getRouteSlug(route); // saves the slug of the address to slug variable 
  return `${slug}-${viewportName}.png`; // combines the slug the viewport name and the .png extension to form a clean organized filename
}

/**
 * Throws if two route/viewport pairs would write the same screenshot or diff file
 * (e.g. "/a-b" @ "c" and "/a" @ "b-c" are both a-b-c.png, and a viewport named
 * "m-diff" collides with the diff image of viewport "m"). Such runs silently
 * overwrite each other's images.
 *
 * @param {string[]} routes
 * @param {{ name: string }[]} viewports
 */
export function assertUniqueSnapshotFiles(routes, viewports) {
  const owners = new Map();
  for (const route of routes) {
    for (const viewport of viewports) {
      const owner = `route "${route}" @ viewport "${viewport.name}"`;
      const file = getSnapshotFilename(route, viewport.name);
      for (const name of [file, file.replace(/\.png$/, '-diff.png')]) {
        const existing = owners.get(name);
        if (existing) {
          throw new Error(
            `Invalid configuration: ${existing} and ${owner} would both write "${name}". ` +
            'Rename a route or viewport so every screenshot gets its own file.'
          );
        }
        owners.set(name, owner);
      }
    }
  }
}
