# Velon site: design notes

## Idea

Proof before you sign, and proof after. The page shows that with the product itself: every
screen and value on it comes from a real run of Velon, not an illustration.

- Hero, bento and share image use captures of the real console: a revoke on a local Agave
  4.3.2 validator, finalized at slot 419,474,793.
- The token account in "The problem" was read with `getAccountInfo` from that validator.
- The evidence table is Velon's capture of Solana mainnet at finalized slot 460,066,667.
- The refusals under "Fails closed" are error strings from the runtime.

To refresh the captures, run the test bench (`app/`, `bun run local` then `bun run demo`) and
take element screenshots of the permission card, the review dialog, the result and the receipt
at device scale 2. Update the slot numbers in `index.html` to match.

## References studied

Product-led crypto and developer sites (Revoke.cash, Privy, Squads, Turnkey, Linear, Phantom) and
current Dribbble work for crypto security and fintech landing pages. What carried over: the real
product as the hero, short heavy headlines, bento tiles built from real UI, one accent colour and
alternating dark and light sections. What was left out: decorative 3D objects, glow blobs, logo
walls and invented numbers.

## Colour

The console's own palette, so the site and the product read as one thing.

| Token | Value | Use |
| --- | --- | --- |
| `--forest-950` | `#051f18` | Page background |
| `--forest-900` / `800` | `#072a21` / `#0b3529` | Raised surfaces, tiles |
| `--cream` | `#f1e9d8` | Light sections |
| `--mint` | `#3fe0a5` | Accent, primary actions, verified state |
| `--amber` | `#f0b46a` | The delegate, risk |

## Type

Geist for text and headlines, Geist Mono for anything read from the chain. Headlines are 600
weight with tight tracking (-0.045em at display size). Scale: 13, 15, 17, 20, 22 px for text;
`--h2` 36 to 64 px and `--h1` 44 to 76 px, fluid.

## Layout

12-column bento, 1240 px content width, gutters from 20 to 40 px. Sections are 88 to 152 px
apart. Radii come from five tokens (8, 14, 22, 32 px and pill).

## Motion

- The hero steps through the three real screens every 4.2 s; hover or a tab click holds it.
  It pauses off screen.
- Sections fade up 18 px once, staggered 70 ms.
- The "How it works" line fills with scroll.
- `prefers-reduced-motion` sets `--motion` to 0: no movement, and the hero shows the proof.
