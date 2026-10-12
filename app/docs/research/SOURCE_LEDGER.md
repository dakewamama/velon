# Source ledger

| Source                                                                        | Revision                                      | License                        | Inspection                                                        | Reuse                                                                    |
| ----------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [Cataloger](https://github.com/dakewamama/cataloger)                          | `37732273c0bf8f921155de11e7949d3888852aa6`    | No repository license declared | TARGETED SOURCE, EXECUTED LOCALLY                                 | PUBLIC API                                                               |
| [Catalyst SDK](https://github.com/dakewamama/catalyst-sdk)                    | `bdd9e865882c663598b271c45922492c8e3de251`    | MIT package declaration        | TARGETED SOURCE, EXECUTED LOCALLY                                 | DEPEND for wallet submission; runtime independently pins Rust SDK54ed06a |
| [Kit addresses](https://github.com/anza-xyz/kit/tree/main/packages/addresses) | `@solana/addresses` 8.4.0, npm lock integrity | MIT                            | TARGETED SOURCE of public types/codecs                            | DEPEND                                                                   |
| [lossless-json](https://github.com/josdejong/lossless-json)                   | 4.3.1, npm lock integrity                     | MIT                            | TARGETED SOURCE of parse/stringify API and installed declarations | DEPEND                                                                   |
| [Bun](https://bun.sh/docs/bundler/fullstack)                                  | 1.3.14 locally                                | MIT                            | Public HTML bundler/server documentation                          | PUBLIC API                                                               |
| [Playwright](https://github.com/microsoft/playwright)                         | 1.64.0, npm lock integrity                    | Apache-2.0                     | Public test/viewport API                                          | DEPEND, development only                                                 |

No external implementation is copied. The control-test fixture retains our existing
Cataloger SPL projection and Catalyst native signing bytes at the revisions above.
The launcher consumes the existing Cataloger fixture files through its CLI.
Their original source hashes, native execution revisions and account-selection
limits remain in Cataloger's fixture README. The runtime pins ARM 0.1 and the
executed adapter revision. The browser carries wire data, not another policy engine.

Preserved experience: account state and technical authority do not establish human
intent; administrative and direct spend power can survive independently; identical
principals do not imply independent budgets. Observation coverage remains separate
from deployment support. Lossless parsing preserves protocol integers without
inventing a browser-specific amount representation or token-decimal assumption.

Wallet control uses `@wallet-standard/app` and `@wallet-standard/features`1.1.1
([Wallet Standard](https://github.com/wallet-standard/wallet-standard)) and
`@solana/wallet-standard-features`1.5.0
([Solana Wallet Standard](https://github.com/anza-xyz/wallet-standard)), Apache-2.0.
Reuse: DEPEND, pinned package-lock integrity. Inspection: TARGETED SOURCE of
installed discovery/events implementation and connect/signTransaction declarations;
EXECUTED LOCALLY in Chromium with an ephemeral registered wallet. No implementation
copied. Account-change notifications invalidate an outstanding review; a returned
signed transaction must still pass Catalyst's message and signature checks.

Kit RPC, transaction codecs and blockhash validation8.4.0 use their public APIs.
The browser runs Catalyst's existing `signAndSubmitReviewedTransaction`, not a
second submission implementation. Synthetic browser RPC responses establish no
public finality or deployment identity. No program gate is weakened for the UI.
