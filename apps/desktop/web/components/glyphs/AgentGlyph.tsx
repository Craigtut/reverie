import { css } from '../../styled-system/css';

// A 2x2 dot glyph tinted per agent kind (Claude / Codex / Cortex), used beside
// session titles so parallel sessions of the same CLI stay distinguishable.
export function AgentGlyph({ kind }: { kind: string }) {
  return (
    <span className={agentGlyphClass({ kind })} aria-hidden="true">
      <span /><span /><span /><span />
    </span>
  );
}

function agentGlyphClass({ kind }: { kind: string }) {
  const color = kind === 'claude_code' ? '#D97757' : kind === 'codex_cli' ? '#8FA5FF' : 'var(--good)';
  return css({
    width: '14px',
    height: '14px',
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gridTemplateRows: 'repeat(2, 1fr)',
    gap: '1.5px',
    flexShrink: 0,
    color,
    '& span': {
      borderRadius: '1px',
      background: 'currentColor',
      opacity: 0.45,
    },
    '& span:nth-child(1)': { opacity: kind === 'codex_cli' ? 0.45 : 1 },
    '& span:nth-child(2)': { opacity: kind === 'claude_code' ? 0.45 : 1 },
    '& span:nth-child(3)': { opacity: kind === 'claude_code' ? 0.45 : 1 },
    '& span:nth-child(4)': { opacity: kind === 'cortex_code' ? 0.45 : 1 },
  });
}
