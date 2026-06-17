import { useState } from 'react';
import { ArrowSquareOut, Check, Copy } from '@phosphor-icons/react';

import { css } from '../../styled-system/css';
import type { AgentInstallGuide } from '../../domain';
import { openExternalUrl } from '../../services/openApi';
import { useOverlayStore } from '../../store';
import { AgentGlyph } from '../glyphs';
import { Typography } from '../primitives/Typography';

// Shared "how to install an agent CLI" affordances, used both in the creation
// composer (when nothing is enabled to pick) and in the Agents settings rows
// (per CLI that is not detected). Reverie never installs anything itself: it
// hands over a copy-and-run command for the fast path and a docs link for every
// other install method. The install copy itself lives in AGENT_INSTALL_GUIDES.

// The command + docs link for one CLI. Degrades gracefully: a CLI with no
// one-liner shows only the link, and one with no public page yet shows a quiet
// "coming soon" note so the row never dead-ends.
export function CliInstallActions({ guide }: { guide: AgentInstallGuide }) {
  const hasCommand = Boolean(guide.quickInstall);
  const hasDocs = guide.docsUrl.length > 0;

  return (
    <div className={actionsClass} data-testid={`cli-install-actions-${guide.kind}`}>
      {hasCommand ? <CopyCommand guide={guide} /> : null}
      {hasDocs ? (
        <button
          type="button"
          className={docsLinkClass}
          data-testid={`cli-install-docs-${guide.kind}`}
          onClick={() => void openExternalUrl(guide.docsUrl)}
        >
          <Typography as="span" variant="caption" tone="inherit">
            {guide.docsLabel}
          </Typography>
          <ArrowSquareOut size={12} weight="bold" />
        </button>
      ) : !hasCommand ? (
        <Typography
          as="span"
          variant="caption"
          tone="faint"
          data-testid={`cli-install-soon-${guide.kind}`}
        >
          Installation instructions coming soon.
        </Typography>
      ) : null}
    </div>
  );
}

function CopyCommand({ guide }: { guide: AgentInstallGuide }) {
  const command = guide.quickInstall?.command ?? '';
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      useOverlayStore
        .getState()
        .pushToast({ message: `Copied ${guide.displayName} install command` });
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be unavailable (rare). The command is still visible to
      // copy by hand, so swallow rather than surface an error here.
    }
  }

  return (
    <button
      type="button"
      className={commandClass}
      data-testid={`cli-install-copy-${guide.kind}`}
      title="Copy install command"
      onClick={() => void copy()}
    >
      <Typography as="code" variant="caption" tone="inherit" className={commandTextClass}>
        {command}
      </Typography>
      <span className={copyIconClass} aria-hidden>
        {copied ? <Check size={13} weight="bold" /> : <Copy size={13} />}
      </span>
    </button>
  );
}

// The full card listing one row per CLI to install. Shown in the creation
// composer when there is no enabled+detected agent to pick.
export function AgentInstallGuideCard({
  guides,
  title,
  subtitle,
}: {
  guides: AgentInstallGuide[];
  title: string;
  subtitle: string;
}) {
  return (
    <div className={cardClass} data-testid="agent-install-guide">
      <div className={cardHeaderClass}>
        <Typography as="strong" variant="smallBodyAlt" tone="default">
          {title}
        </Typography>
        <Typography as="span" variant="caption" tone="faint" style={{ lineHeight: 1.5 }}>
          {subtitle}
        </Typography>
      </div>
      <ul className={guideListClass}>
        {guides.map(guide => (
          <li key={guide.kind} className={guideRowClass}>
            <span className={guideGlyphClass}>
              <AgentGlyph kind={guide.kind} />
            </span>
            <div className={guideBodyClass}>
              <Typography as="span" variant="smallBody" tone="default">
                {guide.displayName}
              </Typography>
              <CliInstallActions guide={guide} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const actionsClass = css({
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: '8px',
});

const commandClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '8px',
  maxWidth: '100%',
  padding: '5px 8px 5px 10px',
  borderRadius: '8px',
  border: '1px solid var(--line)',
  background: 'color-mix(in srgb, var(--surface-2) 70%, transparent)',
  color: 'var(--text-2)',
  cursor: 'pointer',
  transition: 'border-color 140ms ease, color 140ms ease, background 140ms ease',
  _hover: {
    color: 'var(--text)',
    borderColor: 'var(--line-strong)',
    background: 'var(--surface-3)',
  },
});

const commandTextClass = css({
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});

const copyIconClass = css({
  display: 'inline-flex',
  flexShrink: 0,
  color: 'var(--text-3)',
});

const docsLinkClass = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '5px',
  border: 0,
  background: 'transparent',
  padding: '4px 2px',
  color: 'var(--text-3)',
  cursor: 'pointer',
  textDecoration: 'underline',
  textUnderlineOffset: '2px',
  transition: 'color 140ms ease',
  _hover: { color: 'var(--text)' },
});

const cardClass = css({
  display: 'grid',
  gap: '14px',
  padding: '16px',
  borderRadius: '16px',
  border: '1px solid var(--line)',
  background: 'color-mix(in srgb, var(--surface-1) 80%, transparent)',
  textAlign: 'left',
});

const cardHeaderClass = css({
  display: 'grid',
  gap: '3px',
});

const guideListClass = css({
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'grid',
  gap: '12px',
});

const guideRowClass = css({
  display: 'grid',
  gridTemplateColumns: 'auto minmax(0, 1fr)',
  alignItems: 'start',
  gap: '12px',
});

const guideGlyphClass = css({
  width: '20px',
  height: '20px',
  marginTop: '1px',
  display: 'inline-flex',
});

const guideBodyClass = css({
  display: 'grid',
  gap: '6px',
  minWidth: 0,
});
