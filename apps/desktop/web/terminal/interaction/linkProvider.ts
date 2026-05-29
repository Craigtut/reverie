// Regex-based link detection over a row's reconstructed plain text. This is the
// v1 link source: OSC 8 explicit hyperlinks (which survive wrapping) need
// backend support that libghostty-vt does not expose yet. Detection is per-row,
// so a URL wrapped across two visual lines is a known limitation.

export interface DetectedLink {
  start: number; // inclusive column
  end: number; // exclusive column
  href: string; // normalized, openable
}

// http/https URLs, or a bare www. host that we promote to https. We then trim
// trailing punctuation that is far more likely sentence punctuation than part of
// the URL.
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

function trimTrailingPunctuation(match: string): string {
  const stripped = match.replace(TRAILING_PUNCTUATION, '');
  // Keep a single closing paren if the URL opened one (balanced parens, e.g.
  // wikipedia URLs); otherwise the stripped form stands.
  if (match.endsWith(')') && match.includes('(') && !stripped.endsWith(')')) {
    return `${stripped})`;
  }
  return stripped;
}

export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  return /^www\./i.test(trimmed) ? `https://${trimmed}` : trimmed;
}

// Whether a scheme is safe to open externally. Outward-facing, so we allowlist.
export function isOpenableUrl(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

// If the entire (trimmed) text is a single URL, return the normalized href, else
// null. Used to decide whether a selection should offer "Open as URL". Trailing
// sentence punctuation is stripped the same way detectLinks does, so selecting
// "https://example.com." opens the clean URL rather than one with a stray dot.
export function asUrl(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) return null;
  const candidate = trimTrailingPunctuation(trimmed);
  if (!/^(?:https?:\/\/|www\.)\S+$/i.test(candidate)) return null;
  const href = normalizeUrl(candidate);
  return isOpenableUrl(href) ? href : null;
}

// All URL-like spans on a single row's plain text, as half-open column ranges.
export function detectLinks(rowText: string): DetectedLink[] {
  const links: DetectedLink[] = [];
  URL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null = URL_PATTERN.exec(rowText);
  while (match !== null) {
    const raw = match[0];
    const trimmed = trimTrailingPunctuation(raw);
    if (trimmed.length > 0) {
      const href = normalizeUrl(trimmed);
      if (isOpenableUrl(href)) {
        links.push({ start: match.index, end: match.index + trimmed.length, href });
      }
    }
    match = URL_PATTERN.exec(rowText);
  }
  return links;
}
