import { describe, it, expect } from 'vitest';
import { getRouteSlug, getSnapshotFilename, buildDeterministicStyle } from '../src/cli/capture.js';

describe('Capture Utilities', () => {
  describe('getRouteSlug', () => {
    it('converts root route "/" to "index"', () => {
      expect(getRouteSlug('/')).toBe('index');
    });

    it('converts empty or falsy route to "index"', () => {
      expect(getRouteSlug('')).toBe('index');
      expect(getRouteSlug(null)).toBe('index');
    });

    it('strips leading and trailing slashes', () => {
      expect(getRouteSlug('/about/')).toBe('about');
      expect(getRouteSlug('///about///')).toBe('about');
    });

    it('replaces slashes and non-alphanumeric characters with underscores', () => {
      expect(getRouteSlug('/products/categories/books')).toBe('products_categories_books');
      expect(getRouteSlug('/search?q=test')).toBe('search_q_test');
    });

    it('preserves dashes and underscores', () => {
      expect(getRouteSlug('/user-profile_settings')).toBe('user-profile_settings');
    });
  });

  describe('getSnapshotFilename', () => {
    it('creates standard filename for route and viewport', () => {
      expect(getSnapshotFilename('/', 'desktop')).toBe('index-desktop.png');
      expect(getSnapshotFilename('/about', 'mobile')).toBe('about-mobile.png');
      expect(getSnapshotFilename('/dashboard/analytics', 'tablet')).toBe('dashboard_analytics-tablet.png');
    });
  });

  describe('buildDeterministicStyle', () => {
    it('generates base deterministic CSS disabling animations and transitions', () => {
      const css = buildDeterministicStyle();
      expect(css).toContain('animation: none !important');
      expect(css).toContain('transition: none !important');
      expect(css).toContain('caret-color: transparent !important');
      expect(css).toContain('scroll-behavior: auto !important');
    });

    it('appends visibility hidden for mask selectors', () => {
      const css = buildDeterministicStyle(['.timestamp', '#live-chat', 'img.avatar']);
      expect(css).toContain('.timestamp, #live-chat, img.avatar {');
      expect(css).toContain('visibility: hidden !important');
    });

    it('handles empty maskSelectors array without injecting selector rules', () => {
      const css = buildDeterministicStyle([]);
      expect(css).not.toContain('visibility: hidden !important');
    });
  });
});
