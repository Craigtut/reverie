import { describe, it, expect } from 'vitest';

import { droppedPathLabel, formatDroppedPaths, quoteShellPath } from './shellPath';

describe('quoteShellPath', () => {
  it('leaves shell-safe paths bare', () => {
    expect(quoteShellPath('/Users/craig/report.pdf')).toBe('/Users/craig/report.pdf');
    expect(quoteShellPath('./src/main.rs')).toBe('./src/main.rs');
    expect(quoteShellPath('a-b_c.2@v%1+x=y,z:w')).toBe('a-b_c.2@v%1+x=y,z:w');
  });

  it('single-quotes paths with spaces or glob characters', () => {
    expect(quoteShellPath('/Users/craig/my file.pdf')).toBe("'/Users/craig/my file.pdf'");
    expect(quoteShellPath('/tmp/[draft].md')).toBe("'/tmp/[draft].md'");
    expect(quoteShellPath('/tmp/a*b?.txt')).toBe("'/tmp/a*b?.txt'");
  });

  it('escapes embedded single quotes with the close/escape/reopen dance', () => {
    expect(quoteShellPath("/tmp/it's here.txt")).toBe("'/tmp/it'\\''s here.txt'");
  });

  it('quotes the empty string as an explicit empty argument', () => {
    expect(quoteShellPath('')).toBe("''");
  });
});

describe('formatDroppedPaths', () => {
  it('returns empty string when there is nothing to insert', () => {
    expect(formatDroppedPaths([])).toBe('');
    expect(formatDroppedPaths(['', ''])).toBe('');
  });

  it('joins quoted paths with spaces and a trailing space', () => {
    expect(formatDroppedPaths(['/a/b.txt', '/c/my file.md'])).toBe("/a/b.txt '/c/my file.md' ");
  });

  it('drops empty entries from a mixed list', () => {
    expect(formatDroppedPaths(['/a.txt', '', '/b.txt'])).toBe('/a.txt /b.txt ');
  });
});

describe('droppedPathLabel', () => {
  it('returns the final path segment', () => {
    expect(droppedPathLabel('/Users/craig/report.pdf')).toBe('report.pdf');
    expect(droppedPathLabel('report.pdf')).toBe('report.pdf');
  });

  it('trims a trailing separator on directories', () => {
    expect(droppedPathLabel('/Users/craig/notes/')).toBe('notes');
  });
});
