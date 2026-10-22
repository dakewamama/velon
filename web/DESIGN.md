# Velon site: design notes

## Audience

- **Solana users** who have approved apps over the years and want to know which keys can still spend their tokens. They need one clear promise and a safe way to try it.
- **Wallet and treasury teams** deciding whether Velon's checks are strong enough to sit behind a "Revoke" button in their product or in a multisig workflow. They read the mechanism and the source.
- **The Solana Foundation and ecosystem reviewers**, who judge seriousness: is this precise, honest about its limits, and built with care?

All three are technical enough to distrust marketing. The site earns trust by being exact.

## The one idea

**Proof before you sign. Proof after.**

Velon executes the revoke itself before offering it for signature, and reads the chain again after finalization before it says "revoked". Every section of the page is a view of that sentence: the hero animates it, "How it works" slows it down, the receipt shows what it leaves behind.

## Concepts considered

1. **Instrument panel.** A dark hardware-like surface: segmented readouts, a four-position selector for observe, execute, sign, verify. Precise and memorable, but it puts the tool's chrome ahead of the evidence and reads as a dashboard rather than a statement.
2. **Explorer ledger.** Dense tables in the manner of a block explorer, monospaced throughout. Honest and serious, but flat: nothing tells a newcomer why a delegate matters, and it looks like the console rather than an argument for it.
3. **Printed proof (chosen).** Editorial print design applied to on-chain evidence. A warm paper ground, a serif display face for statements, a mono face for anything that came from the chain, and one recurring object: the receipt. The delegate is drawn as a literal thread between a token account and a key; revoking cuts the thread, and a receipt prints.

**Why printed proof.** Velon's product is, in the end, a document: a verification ID with evidence that replays later. Print design is the language people already trust for records (receipts, ledgers, certificates), and it lets the page be calm and exact instead of loud. The thread-and-receipt motif explains the product in one picture without a single diagram label, and it scales from the hero down to the footer.

## Type system

Three open-licence families, self-hosted as Latin-subset WOFF2 with `font-display: swap` and size-adjusted local fallbacks so the swap does not shift layout.

| Role | Family | Notes |
| --- | --- | --- |
| Display and section statements | Newsreader (variable, opsz 6–72, wght 200–800) | Optical size on, weight 380–420, slight negative tracking. Italic used once per statement at most. |
| Text and UI | Geist (variable) | 400 body, 520–560 for UI emphasis. |
| Evidence | Geist Mono (variable) | Addresses, slots, IDs, step labels. Tabular numerals. |

Scale (fluid between 360px and 1440px):

| Token | Size | Line height | Use |
| --- | --- | --- | --- |
| `--t-display` | 44 → 104px | 0.98 | Hero headline |
| `--t-h2` | 34 → 64px | 1.02 | Section statements |
| `--t-h3` | 20 → 24px | 1.25 | Sub-heads |
| `--t-lead` | 18 → 22px | 1.5 | Section leads |
| `--t-body` | 17px | 1.6 | Paragraphs, measure capped at 64ch |
| `--t-small` | 14px | 1.5 | Captions, table cells |
| `--t-label` | 12px mono, +0.08em, uppercase | 1.3 | Folios, kicker labels |

## Colour tokens

The old brand's mint stays as the "proven" signal; a vermilion marks live authority (an uncut thread). Nothing else carries hue.

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--paper` | `#f3f0e8` | `#0d110f` | Page ground |
| `--paper-2` | `#ebe7dc` | `#131815` | Inset panels |
| `--card` | `#fbfaf6` | `#171d1a` | Raised surfaces, the receipt |
| `--ink` | `#111814` | `#edf0eb` | Headlines, primary text |
| `--ink-2` | `#38433d` | `#b8c1bb` | Body |
| `--muted` | `#5b665f` | `#8d9891` | Secondary text (AA on paper and card) |
| `--rule` | `#d8d2c4` | `#252c28` | Hairlines |
| `--rule-strong` | `#aba493` | `#3a443f` | Emphasised rules, borders |
| `--proof` | `#08734f` | `#4be3ab` | Verified state, text-safe |
| `--mint` | `#3fe0a5` | `#3fe0a5` | Fills only, never text on paper |
| `--live` | `#b83a22` | `#ff8566` | Live delegate authority, the thread before it is cut |

The developer band inverts to the dark tokens in both themes.

## Grid and spacing

- 12 columns, max content width 1320px, gutter 24px, side margin `clamp(16px, 5vw, 64px)`.
- 4px base spacing scale, exposed as `--s-1` (4px) to `--s-24` (96px). Sections are separated by `--section` (96px on phones to 176px on desktop); elements inside a group by 8–24px. Values below 4px are optical nudges only.
- Section headers share one structure: a mono folio (`01 / The problem`) on a hairline, then the serif statement. That repetition is the page's spine.
- Radii: `--r-chip` 4px, `--r-sm` 6px, `--r-panel` 10px, `--r-card` 14px, `--r-pill` for buttons. Nothing else.

## Motion principles

- **Motion explains, never decorates.** Every animation shows a step in the revoke: a scan line reads rows, two results meet at an equals sign, a thread is cut, a receipt prints.
- **Four duration tokens**: `--d-fast` 160ms (hover, colour), `--d-ui` 280ms (state changes), `--d-move` 420ms (plates, the thread cut), `--d-print` 560ms (reveals, the receipt printing). All on `cubic-bezier(0.2, 0, 0, 1)` (ease-out). Only transforms, opacity and colours animate.
- **The hero loop pauses** when off-screen, when the tab is hidden, and on a visible pause control; each step is also a button.
- **Scroll-stepped, not scroll-jacked.** "How it works" changes plate as each step crosses the middle of the viewport (IntersectionObserver); native scrolling is never intercepted.
- **`prefers-reduced-motion: reduce`** sets `--motion: 0`, which zeroes every duration and delay token, and turns off autoplay. The hero shows the finished, verified state with the receipt printed; steps can still be viewed by pressing them, and state changes are instant.
