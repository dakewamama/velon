# Controlled Subscriptions journey

This run uses disposable devnet SOL and a newly created test token. The complete
desktop browser journey passed on 2026-11-18 against real Devnet RPC and native
program execution. This is Devnet action evidence, not a mainnet action test or
independent security review.

Requirements: the pinned Solana CLI, `solana-keygen`, `spl-token`, Bun, and an
optimized `authorization-api` built from the same clean commit as the app.
Use a browser-safe devnet RPC URL and a funded **disposable** `DEVNET_FUNDER`;
there is no default personal key or automatic faucet request. At least 0.11
devnet SOL must be available at finalized commitment. Never supply a mainnet key.

Create the active fixture explicitly, from `app/`:

```sh
export DEVNET_RPC_URL=https://api.devnet.solana.com
export DEVNET_FUNDER=/absolute/path/to/disposable-devnet-funder.json
export AUTHZ_BIN=/absolute/path/to/release/authorization-api
export CATALOGER_DIR=/absolute/path/to/velon/runtime
export CATALOGER_REVISION=$(git rev-parse HEAD)
export DEVNET_FIXTURE_DIR=/absolute/new/path/to/devnet-journey
DEVNET_FIXTURE_MODE=active-charge bun scripts/devnet-subscription.ts
```

The cluster and supported executable/runtime catalog are checked before funding
or signing. The fixture directory must not exist; failed and completed attempts
retain their keys and evidence. A nonempty directory is never reset or reused.
The tool creates a 100-base-unit hourly subscription and one 40-base-unit charge
to the merchant's token account, then verifies finalized balances and an active
subscription. Its plan name is explicitly merchant-provided, not verified business
identity. Cancellation is left to the console. The default `expired` mode retains
the previous immediate-cancellation fixture behavior.

Each signed native instruction's signature is recorded **before** submission.
Unknown submission results stop the run; inspect the retained attempt and network
status before deciding what to do. Do not rerun into another directory merely to
retry an uncertain charge. `journey.json` retains the finalized charge transaction,
accounts, public addresses and signatures; private keys remain separate.

Start an isolated local console backend using the same runtime/revision:

```sh
RPC_URL="$DEVNET_RPC_URL" PUBLIC_RPC_URL="$DEVNET_RPC_URL" LIVE_NETWORK=devnet \
  PORT=3000 RUNTIME_PORT=3001 bun scripts/demo.ts
```

In another shell, run only the Subscriptions journey:

```sh
RPC_URL="$DEVNET_RPC_URL" LIVE_URL=http://127.0.0.1:3000 \
  LIVE_SUBSCRIPTION_FIXTURE="$DEVNET_FIXTURE_DIR/journey.json" \
  LIVE_SUBSCRIPTION_CANCEL=1 \
  bun run test:live --grep 'active devnet subscription'
```

The test registers only the fixture's disposable subscriber wallet. RPC responses
are not intercepted. It checks automatic discovery, merchant-name disclosure,
the actual charge/puller/receiver and transaction link, incomplete historical
attribution disclosure, console cancellation, finalized native post-state,
unchanged parent token approval and a replayable verification receipt. It retains
the resulting transaction and receipt beside the fixture. This consumes the active
fixture; a later run must fail its active-state precondition, not silently reuse it.

The construction follows the official TypeScript lifecycle sequence at
`solana-foundation/subscriptions` revision
`57290f41e42606696e70d5cf703df6bbc88301ea`,
`clients/typescript/test/subscription-lifecycle.test.ts`. The upstream Surfpool
test harness is not a devnet runner. Velon's independent 73-byte transfer encoder
and exact account roles are compared with the official 0.5.0 Rust client's native
execution trace in `sdk/tests/fixtures/subscriptions-lifecycle.json`; the existing
native lifecycle test regenerates that trace. No production Kit dependency changes
or new transaction framework are introduced.

## Executed evidence — 2026-11-18 UTC

App and optimized native runtime revision:
`0393ff62ac26dd5865ab9f1d9b00463f9839023b`.
Subscriptions executable: padded SHA-256
`2675ad1d2b5068d47fc5d169156cf4859a9c21c0406ce63e3828e3b7320fddbf`,
deployment slot `506642674`. The fixture used classic SPL Token. The different
Devnet Token-2022 executable remained unverified and was not used.

The test connected a generated disposable wallet, discovered subscription
`J3spvkEJTs9eZCAhRmWpkwHiFwf7qsawUefbQcXASntL`, read its verified native terms,
displayed its merchant-provided name as unverified, and checked the actual 40-unit
charge, mint, puller and receiver token account. It then reviewed, signed and
cancelled through the console and independently checked the finalized transaction,
exact native end time, unchanged shared token approval and durable receipt.

- [Finalized payment](https://explorer.solana.com/tx/3ea8dPbuDNUNE71wS4dqhRBFcaG1P9AwUtLSwFWVtTjiBMg1KfPwGwwLFyiF8mdgLA8mcWDDVvZkpS3FYegjWb5E?cluster=devnet).
- [Finalized cancellation](https://explorer.solana.com/tx/2o1BSTRXJ7C1TzaY6DTqJ4qByrynFSt6BwGmMZ7NpbqQkBPeah5oeAzW8uL1BhvGNb3Y6Zvc77RkCoeDa4sGCVNi?cluster=devnet), slot `523576548`.
- Verification receipt: `e08ac74c6f9228dd92e66355a02d063c6dc07a0e82619736ca58244d1ccb7f31`.

The command documented above reported **1 passed (26.4s)**. The same revision's
app unit tests reported **97 passed**, browser regression tests with `--workers=2`
reported **102 passed**, and TypeScript typechecking passed. The initial
nine-worker browser run had process crashes; the bounded two-worker run passed.

Earlier live attempts exposed and fixed history serialization of exact integers
and an asynchronous account lookup overwriting the merchant disclosure. The live
test also needed distinct selectors for transaction and retained-evidence links.
One attempt stopped before submission when RPC revalidation failed; its trace
contained zero `sendTransaction` calls. Another cancellation succeeded but the
test's subsequent independent read hit a rate limit; those checks were completed
without resubmission. The final run above passed from creation through proof.
Only the test's read requests retry bounded 429/503 responses; signed submissions
are never retried by the harness. Receipts are saved before follow-up reads.

Private artifacts outside Git retain the fixture keys, native attempts, RPC
transaction evidence, cancellation receipt, finalized screenshot, checksummed
runtime executable and coherent SQLite backup. A separate restore replayed all
10 retained snapshots without RPC and retained the verification receipt. Production
data and public sites were unchanged.

Historical account-incarnation and historical executable attribution still display
as unresolved; the successful current-state control does not resolve those claims.
The run used a controlled test wallet implementing Wallet Standard, not a human
wallet extension or mobile wallet application. Mobile browser regressions passed;
this live run exercised the desktop configuration.
