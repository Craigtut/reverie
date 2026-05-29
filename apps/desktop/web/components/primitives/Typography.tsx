import type { CSSProperties, ElementType, HTMLAttributes, ReactNode } from 'react';

import { css } from '../../styled-system/css';
import { typeScale, type TypographyVariant } from '../../themes/typography';

// The single text primitive for the app. Visual size is decoupled from the
// rendered element: pick a `variant` for the ramp step and `as` for semantics
// (h1, p, span, label, ...). Font metrics are applied as inline style straight
// from the typography scale so the scale stays the one source of truth; the
// resettable bits (margin, font-family inheritance, truncation) are Panda
// classes. Color comes from the palette via `tone`, never a raw hex.

export type TypographyTone =
  | 'default'
  | 'muted'
  | 'faint'
  | 'ghost'
  | 'good'
  | 'warn'
  | 'bad'
  | 'inherit';

const toneColor: Record<TypographyTone, string> = {
  default: 'var(--text)',
  muted: 'var(--text-2)',
  faint: 'var(--text-3)',
  ghost: 'var(--text-4)',
  good: 'var(--good)',
  warn: 'var(--warn)',
  bad: 'var(--bad)',
  inherit: 'inherit',
};

export interface TypographyProps extends Omit<HTMLAttributes<HTMLElement>, 'color'> {
  variant?: TypographyVariant;
  as?: ElementType;
  tone?: TypographyTone;
  align?: CSSProperties['textAlign'];
  truncate?: boolean;
  uppercase?: boolean;
  children?: ReactNode;
}

export function Typography({
  variant = 'body',
  as,
  tone = 'default',
  align,
  truncate = false,
  uppercase = false,
  className,
  style,
  children,
  ...rest
}: TypographyProps) {
  const Component = (as ?? 'span') as ElementType;
  const scale = typeScale[variant];

  const composedStyle: CSSProperties = {
    fontSize: scale.fontSize,
    lineHeight: scale.lineHeight,
    fontWeight: scale.fontWeight,
    letterSpacing: scale.letterSpacing,
    color: toneColor[tone],
    textAlign: align,
    textTransform: uppercase ? 'uppercase' : undefined,
    ...style,
  };

  const composedClass = [baseClass, truncate ? truncateClass : '', className]
    .filter(Boolean)
    .join(' ');

  return (
    <Component className={composedClass} style={composedStyle} {...rest}>
      {children}
    </Component>
  );
}

const baseClass = css({
  margin: 0,
  padding: 0,
  fontFamily: 'inherit',
});

const truncateClass = css({
  display: 'block',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  minWidth: 0,
});
