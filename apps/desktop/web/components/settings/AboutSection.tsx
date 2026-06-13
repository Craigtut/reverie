import { GithubLogo } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import { openExternalUrl } from '../../services/openApi';
import { Typography } from '../primitives/Typography';

// The project's public home and license, surfaced once in the About footer so
// the GitHub button and the license line both point at the canonical sources.
const GITHUB_URL = 'https://github.com/Craigtut/reverie';
const LICENSE_URL = 'https://github.com/Craigtut/reverie/blob/main/LICENSE';

// A quiet "about this software" footer pinned to the bottom of Settings: the
// running version, copyright, license, and a link out to the source. The
// version is the build-time package.json value (kept in sync across manifests
// by set-version.mjs), so it renders identically in the harness, dev, and
// production builds without depending on the updater being armed.
export function AboutSection() {
  const year = new Date().getFullYear();

  return (
    <footer className={aboutFooterClass} aria-label="About Reverie">
      <div className={aboutTextClass}>
        <Typography
          as="span"
          variant="smallBody"
          tone="default"
          style={{ letterSpacing: '-0.005em' }}
        >
          Reverie {__APP_VERSION__}
        </Typography>
        <Typography as="span" variant="caption" tone="faint" style={{ lineHeight: 1.6 }}>
          © {year} Craig Tuttle. Released under the{' '}
          <button
            type="button"
            className={aboutLinkClass}
            onClick={() => void openExternalUrl(LICENSE_URL)}
          >
            MIT License
          </button>
          .
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

const aboutLinkClass = css({
  appearance: 'none',
  border: 'none',
  background: 'none',
  padding: 0,
  font: 'inherit',
  color: 'var(--text-2)',
  textDecoration: 'underline',
  textUnderlineOffset: '2px',
  cursor: 'pointer',
  transition: 'color 140ms ease',
  _hover: { color: 'var(--text)' },
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
