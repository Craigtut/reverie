# Reverie Design Vision

> The visual and interaction language of Reverie, extracted from the current implementation (`apps/desktop/web/App.tsx`) and the design reference (`mockup.html` at the repo root). For the frontend's structural/architecture rules, see [`technical/frontend-architecture.md`](technical/frontend-architecture.md).

## Design thesis

Reverie should feel **calm, monochromatic, and quietly alive**. It is a home for agent work, so the chrome recedes and the agent output is the subject. The aesthetic leans into **warm-neutral monochrome surfaces** and a signature **field of slowly moving dots** — never colorful, never busy, never loud.

## Source of truth

- **`mockup.html`** (repo root) is the canonical design reference: tokens, layout, rim-lit panels, the ambient dot field, and the dot-matrix wordmark all live there as a self-contained prototype.
- **`apps/desktop/web/App.tsx`** is the live implementation of that language using Panda CSS. The warm-neutral token set is defined inline there (`appClass`, `rimLitPanel`, `ambientClass`).
- **Note / known drift:** `panda.config.ts` still carries an older blue/Nord-ish token set (`#070b16`, `cyan`, dark-only) that predates this direction. It is effectively stale — the live app does **not** use it. When formalizing tokens, reconcile `panda.config.ts` to the warm-neutral palette below rather than copying the blue one.

## Core principles

1. **Monochromatic.** The palette is a single warm-neutral ramp from near-black to near-cream. Color is reserved almost entirely for *status* (good / warn / bad) and is muted even then.
2. **Warm, barely-there neutrals.** Backgrounds carry a hint of cream/smoke so the UI never reads as cold or pure-gray, but it should never feel "colored."
3. **Light and dark are equals.** Both modes ship and share the exact same rim-lit panel language; neither is an afterthought. Theme is toggled with a floating control and stored as `data-theme` on the shell root.
4. **Quietly alive: the dot field.** A subtle ambient field of dim dots sits behind the workspace. It is *static-dim* by default; occasionally two adjacent dots trade places along a gentle arc. No twinkle, no flashing. This "moving dots" motif is the signature texture and also appears as the dot-matrix `REVERIE` wordmark and brand mark.
5. **Floating, rim-lit panels.** Surfaces are rounded (≈22px), shadowed, and edged with a 1.2px conic-gradient "rim light" that is brightest at the top-left and fades around — giving panels a soft physical presence against the dot field.
6. **No terminal chrome.** The terminal is the product. Session tabs and controls float *on* the terminal surface rather than being boxed in heavy chrome. Text sits on the body background.
7. **Restraint in motion.** Animation is reserved for shell-level moments — entrance/rise, view transitions, the dot swaps, the three-dot loader, the blinking caret. **Animation must never run inside the terminal paint loop.**
8. **Calm density.** Small type (13px UI base), tight letter-spacing (-0.005em), generous radii, and muted text ramps keep the interface dense but unhurried.

## Palette (warm-neutral monochrome)

Defined as CSS variables on the shell root, switched by `data-theme`. Values below are authoritative (mirrors `App.tsx` / `mockup.html`).

### Dark (default)

| Token | Value | Use |
| --- | --- | --- |
| `--bg` / `--bg-deep` | `#0B0A09` / `#060605` | App background gradient |
| `--surface-1..3` | `#131210` → `#221F1C` | Panel / row / active surfaces |
| `--surface-hi` | `#2A2622` | Hover / raised accents |
| `--line-faint/line/line-strong` | `rgba(245,235,220, .05 / .09 / .16)` | Hairlines and borders |
| `--text` / `--text-2/3/4` | `#EFE9DF` → `#4F4842` | Primary → progressively muted text |
| `--dot-bg/ambient/bright` | `rgba(239,233,223, .08 / .55 / .95)` | Dot field + dot-matrix marks |
| `--rim-1/2` | `rgba(255,250,240, .55 / .04)` | Panel rim-light gradient |
| `--terminal-bg` | `#060605` | Terminal canvas background |

### Light

| Token | Value |
| --- | --- |
| `--bg` / `--bg-deep` | `#F4F1EB` / `#ECE7DD` |
| `--surface-1..3` | `#FAF7F0` → `#E8E2D5` |
| `--surface-hi` | `#DDD6C7` |
| `--text` / `--text-2/3/4` | `#1B1814` → `#ADA395` |
| `--rim-1/2` | `rgba(255,255,255, .95 / .15)` |
| `--terminal-bg` | `#11100e` |

### Status colors (the only "color")

| Token | Dark | Light | Meaning |
| --- | --- | --- | --- |
| `--good` | `#6FB87A` | `#4A8F58` | running / approved / live |
| `--warn` | `#E5A24E` | `#B07A1E` | needs attention / auto-approve / YOLO |
| `--bad` | `#D96B5C` | `#B14738` | error / failed |

Use status color sparingly — a single dot, pill, or word, never a full surface.

## Typography

- **UI:** `Inter` (system-ui fallback). Base 13px, line-height 1.45, letter-spacing -0.005em. Weights 400–600.
- **Terminal / monospace:** `JetBrains Mono` (ui-monospace fallback), ~12.5px, line-height 1.65.
- Section labels are 10.5px, uppercase, letter-spacing ~0.08em, in `--text-3`.

## Iconography

**Phosphor Icons** (`@phosphor-icons/react`). Icons are small (13–16px), default to muted (`--text-3`), and brighten to `--text` on hover/active.

## Signature components

- **Dot-matrix brand mark** — a 4×4 grid forming an "R"; lit dots use `--text`, unlit dots sit at ~0.35 opacity.
- **`REVERIE` dot-matrix wordmark** — canvas-rendered 5×7 micro-font, used large in the empty state.
- **Ambient dot field** — fixed full-bleed canvas behind everything; shown in the empty state, faded out in the active state. Dots are dim with rare two-dot arc swaps.
- **Rim-lit panel** — the left nav and floating clusters; rounded 22px, shadowed, conic rim-light border, faint top-left inner glow.
- **Floating tab cluster & control chips** — session tabs and controls (e.g. the warn-colored "Auto-approve" chip) float on the terminal with pill/rounded surfaces and the shared shadow.
- **Status affordances** — live focus dots (`--good` with a soft ring), running-session dots, CLI pills, three-dot bounce loader, blinking block caret.

## Hard rules (do not violate)

- Do not introduce a second accent hue — Reverie is monochrome plus status colors only.
- Do not ship a feature in only one theme; light and dark are both first-class.
- Do not put the terminal in heavy chrome; controls float on the surface.
- Do not animate inside the terminal paint loop, and keep the dot field subtle (static-dim, rare slow swaps).
- Do not render terminal cells as styled DOM — that's a hard architecture boundary (see [`technical/frontend-architecture.md`](technical/frontend-architecture.md)).
- Do not reintroduce the stale blue palette from `panda.config.ts`.
