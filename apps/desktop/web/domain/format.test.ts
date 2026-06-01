import { describe, it, expect, beforeEach } from 'vitest';

import { setUserHome } from './constants';
import { average, errorMessage, folderNameFromPath, shortenCwd, shortId } from './format';

// shortenCwd reads the OS home the backend resolves at startup; pin a known
// value so home-substitution is deterministic in tests.
const HOME = '/Users/user';

describe('shortenCwd', () => {
  beforeEach(() => {
    setUserHome(HOME);
  });

  it('returns empty string for empty input', () => {
    expect(shortenCwd('')).toBe('');
  });

  it('substitutes the home directory with ~', () => {
    expect(shortenCwd(`${HOME}/Code/reverie`)).toBe('~/Code/reverie');
  });

  it('treats a bare home path as ~', () => {
    expect(shortenCwd(HOME)).toBe('~');
  });

  it('does not substitute ~ when the OS home is unknown', () => {
    setUserHome('');
    expect(shortenCwd(`${HOME}/Code/reverie`)).toBe(`${HOME}/Code/reverie`);
  });

  it('passes through paths of 48 chars or fewer unchanged', () => {
    const short = '/var/log/app';
    expect(short.length).toBeLessThanOrEqual(48);
    expect(shortenCwd(short)).toBe(short);
  });

  it('passes through a path that is exactly 48 chars', () => {
    // Build a non-home path exactly 48 chars long.
    const path = `/a${'b'.repeat(45)}`; // '/a' + 45 = 47 -> bump to 48
    const exact = `${path}c`;
    expect(exact.length).toBe(48);
    expect(shortenCwd(exact)).toBe(exact);
  });

  it('does not abbreviate long paths with 3 or fewer segments', () => {
    // Over 48 chars but only 3 segments: ['', 'aaa...', 'bbb...'] is 2; need 3.
    const path = `/${'a'.repeat(30)}/${'b'.repeat(30)}`; // segments: ['', a*30, b*30] => length 3
    expect(path.length).toBeGreaterThan(48);
    expect(path.split('/').length).toBe(3);
    expect(shortenCwd(path)).toBe(path);
  });

  it('elides the middle of long deep paths keeping the final two segments', () => {
    const path = `/Users/user/Code/reverie/apps/desktop/web/domain/subfolder/deeper`;
    // Home substitution applies first: ~/Code/reverie/apps/desktop/web/domain/subfolder/deeper (> 48 chars)
    expect(shortenCwd(path)).toBe('~/…/subfolder/deeper');
  });

  it('does not elide a deep home path that stays under 48 chars after substitution', () => {
    const path = `/Users/user/Code/reverie/apps/desktop/web/domain`;
    // After substitution this is only 38 chars, so it passes through unchanged.
    expect(shortenCwd(path)).toBe('~/Code/reverie/apps/desktop/web/domain');
  });

  it('elides a long non-home path using the leading empty segment', () => {
    const path = `/opt/data/${'x'.repeat(40)}/projects/current`;
    expect(path.length).toBeGreaterThan(48);
    // segments: ['', 'opt', 'data', x*40, 'projects', 'current']
    expect(shortenCwd(path)).toBe('/…/projects/current');
  });
});

describe('folderNameFromPath', () => {
  it('returns empty string for null', () => {
    expect(folderNameFromPath(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(folderNameFromPath(undefined)).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(folderNameFromPath('')).toBe('');
  });

  it('returns the final segment of a forward-slash path', () => {
    expect(folderNameFromPath('/Users/user/Code/reverie')).toBe('reverie');
  });

  it('ignores trailing slashes', () => {
    expect(folderNameFromPath('/Users/user/Code/reverie/')).toBe('reverie');
    expect(folderNameFromPath('/Users/user/Code/reverie///')).toBe('reverie');
  });

  it('handles backslash paths', () => {
    expect(folderNameFromPath('C:\\Users\\craig\\project')).toBe('project');
  });

  it('ignores trailing backslashes', () => {
    expect(folderNameFromPath('C:\\Users\\craig\\project\\')).toBe('project');
  });

  it('returns empty string for a path of only slashes', () => {
    expect(folderNameFromPath('///')).toBe('');
  });
});

describe('shortId', () => {
  it('returns undefined for undefined', () => {
    expect(shortId(undefined)).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(shortId(null)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(shortId('')).toBeUndefined();
  });

  it('slices to the first 8 characters', () => {
    expect(shortId('0123456789abcdef')).toBe('01234567');
  });

  it('returns the whole value when shorter than 8 chars', () => {
    expect(shortId('abc')).toBe('abc');
  });
});

describe('average', () => {
  it('returns 0 for an empty array', () => {
    expect(average([])).toBe(0);
  });

  it('returns the arithmetic mean', () => {
    expect(average([2, 4, 6])).toBe(4);
  });

  it('handles a single element', () => {
    expect(average([7])).toBe(7);
  });

  it('handles negative and fractional values', () => {
    expect(average([-1, 0, 1])).toBe(0);
    expect(average([1, 2])).toBe(1.5);
  });
});

describe('errorMessage', () => {
  it('returns the message of an Error instance', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns the message of an Error subclass', () => {
    expect(errorMessage(new TypeError('bad type'))).toBe('bad type');
  });

  it('stringifies non-Error values', () => {
    expect(errorMessage('plain string')).toBe('plain string');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(null)).toBe('null');
    expect(errorMessage(undefined)).toBe('undefined');
    expect(errorMessage({ toString: () => 'obj' })).toBe('obj');
  });
});
