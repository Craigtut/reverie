import { css } from '../../styled-system/css';

// Renders the REVERIE wordmark as a 5x7 dot matrix per letter.
export function DotMatrixWord() {
  const letters = 'REVERIE'.split('');
  return (
    <div className={wordMarkClass} aria-hidden="true">
      {letters.map((letter, letterIndex) => (
        <span key={`${letter}-${letterIndex}`} className={wordLetterClass}>
          {Array.from({ length: 35 }).map((_, dotIndex) => (
            <i key={dotIndex} data-on={isWordDotOn(letter, dotIndex) ? 'true' : 'false'} />
          ))}
        </span>
      ))}
    </div>
  );
}

function isWordDotOn(letter: string, dotIndex: number) {
  const patterns: Record<string, string[]> = {
    R: ['11110', '10010', '11110', '10100', '10010', '10010', '10001'],
    E: ['11111', '10000', '11110', '10000', '10000', '10000', '11111'],
    V: ['10001', '10001', '10001', '01010', '01010', '00100', '00100'],
    I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  };
  const row = Math.floor(dotIndex / 5);
  const col = dotIndex % 5;
  return patterns[letter]?.[row]?.[col] === '1';
}

const wordMarkClass = css({
  display: 'flex',
  gap: '10px',
});

const wordLetterClass = css({
  display: 'grid',
  gridTemplateColumns: 'repeat(5, 9px)',
  gridTemplateRows: 'repeat(7, 9px)',
  gap: '4px',
  '& i': {
    width: '9px',
    height: '9px',
    borderRadius: '2px',
    background: 'var(--dot-bg)',
  },
  '& i[data-on="true"]': {
    background: 'var(--dot-bright)',
    boxShadow: '0 0 26px color-mix(in srgb, var(--dot-bright) 15%, transparent)',
  },
});
