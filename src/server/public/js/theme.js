/**
 * Light / dark theme toggle, loaded on every page by the footer partial.
 *
 * The inline script in the header partial already set <html data-theme> before the
 * first paint (stored choice, else the system preference), so there is no flash.
 * This module:
 *  - wires the navbar toggle ([data-theme-toggle], aria-pressed="true" = dark),
 *  - remembers an explicit choice in localStorage under 'vrt-theme',
 *  - follows live system changes while no choice is stored,
 *  - keeps other open tabs in sync, and re-checks when a page is restored from the
 *    back/forward cache (which receives no storage events).
 * Without JavaScript nothing sets data-theme and the page stays dark (the CSS default).
 */

export const STORAGE_KEY = 'vrt-theme';
const THEMES = ['light', 'dark'];

const root = document.documentElement;
const systemLight = typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: light)')
  : null;

/** The saved choice, or null when none is stored (or storage is unavailable). */
function storedTheme() {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return THEMES.includes(value) ? value : null;
  } catch {
    return null;
  }
}

// A choice made on this page, kept in memory too: if storage is blocked, the saved
// choice reads back as null, and a system change must still not override it.
let explicitChoice = null;

function saveTheme(theme) {
  explicitChoice = theme;
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Private mode or blocked storage: the toggle still works for this page view.
  }
}

const systemTheme = () => (systemLight && systemLight.matches ? 'light' : 'dark');
const currentTheme = () => (root.getAttribute('data-theme') === 'light' ? 'light' : 'dark');

function applyTheme(theme) {
  root.setAttribute('data-theme', theme);
  document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
    button.setAttribute('aria-pressed', String(theme === 'dark'));
  });
}

const preferredTheme = () => storedTheme() || explicitChoice || systemTheme();

applyTheme(preferredTheme());

document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
  button.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    saveTheme(next);
    applyTheme(next);
  });
});

if (systemLight) {
  const onSystemChange = () => {
    if (!storedTheme() && !explicitChoice) applyTheme(systemTheme());
  };
  if (typeof systemLight.addEventListener === 'function') systemLight.addEventListener('change', onSystemChange);
  else if (typeof systemLight.addListener === 'function') systemLight.addListener(onSystemChange);
}

window.addEventListener('storage', (event) => {
  if (event.key === STORAGE_KEY || event.key === null) applyTheme(preferredTheme());
});

// Pages restored from the back/forward cache missed any change made on other pages.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) applyTheme(preferredTheme());
});
