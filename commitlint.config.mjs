// Commit message rules for Reverie. These mirror the Conventional Commit
// conventions documented in CLAUDE.md. commitlint validates messages and
// rejects non-conforming ones with a helpful error; it does not auto-rewrite
// them, so fix the message and commit again.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // type(scope): description  -- single line.
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'refactor', 'docs', 'test', 'chore', 'perf', 'style'],
    ],
    // A scope is required and must be one of the project scopes.
    'scope-empty': [2, 'never'],
    'scope-enum': [
      2,
      'always',
      ['core', 'desktop', 'web', 'terminal', 'adapters', 'docs', 'ci', 'release'],
    ],
    // Imperative, lower-case subject, no trailing period, under 100 chars total.
    'subject-empty': [2, 'never'],
    'subject-full-stop': [2, 'never', '.'],
    'header-max-length': [2, 'always', 100],
  },
};
