# Controlled Subscriptions journey

This run uses disposable devnet SOL and a newly created test token. It has not
been executed against devnet: the available disposable funder is unfunded.
Offline checks and native execution fixtures do not substitute for this run.

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
