import { GithubLogo } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import { openExternalUrl } from '../../services/openApi';
import { Typography } from '../primitives/Typography';

// The project's public home, surfaced once in the About footer so the GitHub
// button points at the canonical source.
const GITHUB_URL = 'https://github.com/Craigtut/reverie';

// A quiet "about this software" footer pinned to the bottom of Settings: the
// running version and a link out to the source. The version is the build-time
// package.json value (kept in sync across manifests by set-version.mjs), so it
// renders identically in the harness, dev, and production builds without
// depending on the updater being armed.
export function AboutSection() {
  return (
    <footer className={aboutFooterClass}>
      <div className={aboutTextClass}>
        <Typography
          as="span"
          variant="smallBody"
          tone="default"
          style={{ letterSpacing: '-0.005em' }}
        >
          Reverie {__APP_VERSION__}
        </Typography>
      </div>
      <button
        type="button"
        className={githubButtonClass}
        aria-label="View Reverie on GitHub"
        title="View Reverie on GitHub"
        data-testid="about-github-link"
        onClick={() => void openExternalUrl(GITHUB_URL)}
      >
        <GithubLogo size={18} />
      </button>
    </footer>
  );
}

const aboutFooterClass = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '24px',
  marginTop: '12px',
  paddingTop: '24px',
  borderTop: '1px solid var(--line-faint)',
});

const aboutTextClass = css({
  display: 'grid',
  gap: '3px',
  minWidth: 0,
});

const githubButtonClass = css({
  flexShrink: 0,
  width: '36px',
  height: '36px',
  display: 'grid',
  placeItems: 'center',
  borderRadius: '10px',
  border: '1px solid var(--line)',
  background: 'color-mix(in srgb, var(--surface-1) 80%, transparent)',
  color: 'var(--text-2)',
  cursor: 'pointer',
  transition: 'color 140ms ease, border-color 140ms ease, background 140ms ease',
  _hover: {
    color: 'var(--text)',
    borderColor: 'var(--line-strong)',
    background: 'var(--surface-3)',
  },
  _focusVisible: {
    outline: 'none',
    borderColor: 'var(--line-strong)',
    boxShadow: '0 0 0 3px color-mix(in srgb, var(--text) 8%, transparent)',
  },
});
