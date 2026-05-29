import { describe, it, expect } from 'vitest';
import { asUrl, detectLinks, isOpenableUrl, normalizeUrl } from './linkProvider';

describe('normalizeUrl', () => {
  it('promotes a bare www host to https', () => {
    expect(normalizeUrl('www.example.com')).toBe('https://www.example.com');
    expect(normalizeUrl('https://example.com')).toBe('https://example.com');
  });
});

describe('isOpenableUrl', () => {
  it('allowlists http/https only', () => {
    expect(isOpenableUrl('https://example.com')).toBe(true);
    expect(isOpenableUrl('http://example.com')).toBe(true);
    expect(isOpenableUrl('file:///etc/passwd')).toBe(false);
    expect(isOpenableUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('asUrl', () => {
  it('returns the href when the whole string is one URL', () => {
    expect(asUrl('  https://example.com/path  ')).toBe('https://example.com/path');
    expect(asUrl('www.example.com')).toBe('https://www.example.com');
  });

  it('strips trailing sentence punctuation (matching detectLinks)', () => {
    expect(asUrl('https://example.com.')).toBe('https://example.com');
    expect(asUrl('https://example.com/path,')).toBe('https://example.com/path');
  });

  it('returns null for prose or multi-token text', () => {
    expect(asUrl('see https://example.com here')).toBeNull();
    expect(asUrl('hello')).toBeNull();
    expect(asUrl('')).toBeNull();
  });
});

describe('detectLinks', () => {
  it('finds a URL span with correct column bounds', () => {
    const text = 'go to https://example.com now';
    expect(detectLinks(text)).toEqual([{ start: 6, end: 25, href: 'https://example.com' }]);
  });

  it('strips trailing sentence punctuation', () => {
    expect(detectLinks('see https://example.com.')).toEqual([
      { start: 4, end: 23, href: 'https://example.com' },
    ]);
  });

  it('finds multiple links on a line', () => {
    const links = detectLinks('http://a.com and www.b.com');
    expect(links.map(l => l.href)).toEqual(['http://a.com', 'https://www.b.com']);
  });

  it('ignores non-url text', () => {
    expect(detectLinks('just some words')).toEqual([]);
  });
});
