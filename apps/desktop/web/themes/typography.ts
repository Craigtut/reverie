// Reverie typography scale.
//
// One ramp, thirteen named variants, consumed through the <Typography>
// primitive so every piece of text in the app pulls from a single source of
// truth. Font sizes step on a calm, human scale; line-heights snap to the 4px
// baseline grid. The "Alt" variants are the bold companions of body and
// smallBody. Sizes and line-heights are expressed in px for predictable
// baseline alignment in a fixed desktop shell.

export type TypographyVariant =
  | 'display'
  | 'display2'
  | 'display3'
  | 'title'
  | 'title2'
  | 'title3'
  | 'subtitle'
  | 'body'
  | 'bodyAlt'
  | 'smallBody'
  | 'smallBodyAlt'
  | 'caption'
  | 'tiny';

export interface TypeStyle {
  fontSize: string;
  lineHeight: string;
  fontWeight: number;
  letterSpacing: string;
}

// Source of truth for the ramp. Line-heights are all multiples of 4.
export const typeScale: Record<TypographyVariant, TypeStyle> = {
  display: { fontSize: '64px', lineHeight: '72px', fontWeight: 700, letterSpacing: '-0.022em' },
  display2: { fontSize: '48px', lineHeight: '56px', fontWeight: 700, letterSpacing: '-0.02em' },
  display3: { fontSize: '40px', lineHeight: '48px', fontWeight: 600, letterSpacing: '-0.018em' },
  title: { fontSize: '32px', lineHeight: '40px', fontWeight: 600, letterSpacing: '-0.014em' },
  title2: { fontSize: '28px', lineHeight: '36px', fontWeight: 600, letterSpacing: '-0.012em' },
  title3: { fontSize: '24px', lineHeight: '32px', fontWeight: 600, letterSpacing: '-0.01em' },
  subtitle: { fontSize: '20px', lineHeight: '28px', fontWeight: 500, letterSpacing: '-0.008em' },
  body: { fontSize: '16px', lineHeight: '24px', fontWeight: 400, letterSpacing: '-0.005em' },
  bodyAlt: { fontSize: '16px', lineHeight: '24px', fontWeight: 600, letterSpacing: '-0.005em' },
  smallBody: { fontSize: '14px', lineHeight: '20px', fontWeight: 400, letterSpacing: '-0.003em' },
  smallBodyAlt: { fontSize: '14px', lineHeight: '20px', fontWeight: 600, letterSpacing: '-0.003em' },
  caption: { fontSize: '12px', lineHeight: '16px', fontWeight: 400, letterSpacing: '0' },
  tiny: { fontSize: '10px', lineHeight: '12px', fontWeight: 400, letterSpacing: '0.005em' },
};
