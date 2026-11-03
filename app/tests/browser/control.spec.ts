import { expect, test, type Page } from "@playwright/test";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { getAddressDecoder, getAddressEncoder, type Address } from "@solana/addresses";
import {
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
} from "@solana/transaction-messages";
import {
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  type TransactionMessageBytes,
} from "@solana/transactions";
import fixture from "../fixtures/spl-control.json" with { type: "json" };
import { DEVNET_GENESIS } from "../../src/control.ts";
import { short } from "../../src/wire.ts";

const SUBSCRIPTIONS = "De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44";
// Technical and derived grants compiled by the SDK from the Mollusk-executed recurring subscription
// (sdk/tests/fixtures/subscriptions-recurring.json). Node's JSON.rawJSON, not yet in TypeScript's
// lib, keeps u64 amounts above 2^53 exact.
const json = JSON as JSON & { rawJSON(text: string): unknown };
const [technical, derived] = JSON.parse(
  readFileSync(
    new URL("../../../sdk/tests/fixtures/subscriptions-recurring-arm.json", import.meta.url),
    "utf8",
  ),
  (_key, value, context?: { source: string }) =>
    typeof value === "number" && !Number.isSafeInteger(value) ? json.rawJSON(context!.source) : value,
);
// The delegation is named in the derived grant id `<program>:<delegation>:<init id>:spend`.
const delegation = derived.id.split(":")[1] as string;
const ended = derived.lifecycle.valid_until as number;
const bytes = (address: string) => Array.from(getAddressEncoder().encode(address as Address));

// `subscription` swaps the SPL grant for the subscription pair. "ended" observes at the cancel
// time, "active" is a controlled edit with no cancel time; the signing message is a controlled
// RevokeDelegation with the native account order, not a captured transaction. `permanent` adds a
// Token-2022 permanent delegate on the same mint, shaped as sdk/src/token2022.rs compiles it.
async function browserProvider(
  page: Page,
  mode = "success",
  subscription?: "ended" | "active",
  permanent = false,
) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPublic = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  const owner = getAddressDecoder().decode(rawPublic);
  const spl = structuredClone(fixture.grant);
  spl.subject.value = owner;
  const parent = { ...technical, subject: { kind: "identity", value: owner } };
  const grant: typeof spl = subscription
    ? {
        ...derived,
        subject: { kind: "identity", value: owner },
        lifecycle: subscription === "ended" ? derived.lifecycle : { ...derived.lifecycle, valid_until: null },
      }
    : spl;
  const key = subscription ? delegation : fixture.signing.source;
  const decoder = getTransactionDecoder();
  const original = decoder.decode(new Uint8Array(Buffer.from(fixture.signing.signing_transaction, "base64")));
  const message = getCompiledTransactionMessageDecoder().decode(original.messageBytes);
  if (message.version !== "legacy") throw new Error("Expected native legacy revoke fixture");
  const signing = Buffer.from(
    getTransactionEncoder().encode({
      messageBytes: getCompiledTransactionMessageEncoder().encode(
        subscription
          ? {
              ...message,
              header: { numSignerAccounts: 1, numReadonlySignerAccounts: 0, numReadonlyNonSignerAccounts: 2 },
              staticAccounts: [owner, delegation, grant.principal.value, SUBSCRIPTIONS] as Address[],
              instructions: [
                { programAddressIndex: 3, accountIndices: [0, 1, 2], data: new Uint8Array([3]) },
              ],
            }
          : { ...message, staticAccounts: [owner, ...message.staticAccounts.slice(1)] },
      ) as TransactionMessageBytes,
      signatures: { [owner]: null },
    }),
  ).toString("base64");
  const scope = "a".repeat(64);
  const beforeId = fixture.view.state_version;
  const afterId = "b".repeat(64);
  let finalized = false;
  let polls = 0;
  let sends = 0;
  let observes = 0;
  let signed = "";
  let stale = false;
  let changed = false;
  const observation = {
    origin: "finalized",
    cluster: DEVNET_GENESIS,
    bank: "browser-test",
    slot: 10,
    ...(subscription && { unix_timestamp: ended }),
  };
  const afterObservation = { ...observation, slot: 12 };
  const coverage = { complete: false, accounts: [], targets: [] };
  const current = () => (changed ? { ...grant, usage: { ...grant.usage, remaining: 24 } } : grant);
  const mint = spl.constraints.value.asset.id;
  const holder = {
    ...spl,
    id: `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb:${mint}:permanent-delegate:spend`,
    subject: { kind: "resource", value: { namespace: "solana:mint", id: mint } },
    resource: { namespace: "solana:mint-token-accounts", id: mint },
    constraints: { kind: "true" },
    usage: { kind: "unlimited" },
    native_context: { ...spl.native_context, protocol: "token-2022" },
  };
  // The SPL approval to the subscription authority outlives the closed delegation.
  const kept = [...(subscription ? [parent] : []), ...(permanent ? [holder] : [])];
  const view = () => ({
    state_version: finalized ? afterId : beforeId,
    observation: finalized ? afterObservation : observation,
    coverage,
    versions: [],
    sdk_revision: "browser-test",
    arm_schema_version: "0.1",
    projection: {
      status: "compiled",
      authorizations: [...kept, ...(finalized ? [] : [current()])].map((authorization) => ({
        authorization,
        availability: "conditional",
      })),
    },
  });
  const record = () => ({
    id: finalized ? afterId : stale ? "d".repeat(64) : beforeId,
    snapshot: {
      observation: finalized ? afterObservation : observation,
      targets: subscription
        ? [
            {
              kind: "subscription",
              delegation: bytes(delegation),
              authority: bytes(parent.principal.value),
              source: bytes(grant.resource.id),
              mint: bytes(grant.constraints.value.asset.id),
              plan: null,
            },
          ]
        : [],
    },
    projection: { status: "compiled", authorizations: [...kept, ...(finalized ? [] : [grant])] },
  });
  await page.addInitScript(
    ({ owner, pubkey, secret, mode }) => {
      const account = {
        address: owner,
        publicKey: new Uint8Array(pubkey),
        chains: ["solana:devnet"],
        features: ["solana:signTransaction"],
      };
      let changed = () => {};
      const wallet = {
        version: "1.0.0",
        name: "Test signing wallet",
        icon: "data:image/svg+xml,<svg/>",
        chains: ["solana:devnet"],
        accounts: [account],
        features: {
          "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
          "standard:events": {
            version: "1.0.0",
            on: (_event: string, callback: () => void) => {
              changed = callback;
              return () => {};
            },
          },
          "solana:signTransaction": {
            version: "1.0.0",
            supportedTransactionVersions: ["legacy"],
            signTransaction: async ({ transaction }: { transaction: Uint8Array }) => {
              if (mode === "rejected") throw new Error("User rejected the request");
              const bytes = new Uint8Array(transaction);
              if (mode === "tampered") bytes[bytes.length - 1] = 6;
              const key = await crypto.subtle.importKey(
                "pkcs8",
                new Uint8Array(secret),
                { name: "Ed25519" },
                false,
                ["sign"],
              );
              const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", key, bytes.slice(65)));
              bytes.set(signature, 1);
              if (mode === "changed-account") changed();
              return [{ signedTransaction: bytes }];
            },
          },
        },
      };
      window.addEventListener("wallet-standard:app-ready", (event) => {
        (event as CustomEvent<{ register: (wallet: unknown) => void }>).detail.register(wallet);
      });
    },
    {
      owner,
      pubkey: Array.from(rawPublic),
      secret: Array.from(privateKey.export({ format: "der", type: "pkcs8" })),
      mode,
    },
  );
  await page.route("**/api/control", (route) =>
    route.fulfill({
      json: { cluster: DEVNET_GENESIS, rpcUrl: "http://127.0.0.1:3390/wallet-test-rpc", network: "devnet" },
    }),
  );
  await page.route("**/api/scenarios", (route) =>
    route.fulfill({
      json: [
        {
          name: "Devnet browser test",
          scope: "",
          live: true,
          snapshots: [],
          examples: [
            { label: "Source account", address: subscription ? delegation : fixture.signing.source },
          ],
        },
      ],
    }),
  );
  await page.route("**/api/live/spl/observe", (route) => {
    observes++;
    expect(route.request().headers()["x-velon-action"]).toBe("observe");
    expect(route.request().postDataJSON()).toEqual({
      source: subscription ? delegation : fixture.signing.source,
    });
    return route.fulfill({ json: { scope_id: scope, record: record() } });
  });
  await page.route(`**/api/scopes/${scope}/effective/*`, (route) => route.fulfill({ json: view() }));
  await page.route(`**/api/scopes/${scope}`, (route) => route.fulfill({ json: record() }));
  // A pasted Subscriptions account is read as owned by the program, then observed.
  await page.route("**/api/live/wallet", (route) =>
    subscription && route.request().postDataJSON().owner === delegation
      ? route.fulfill({ json: { kind: "other", program: SUBSCRIPTIONS } })
      : route.fallback(),
  );
  await page.route(`**/api/scopes/${scope}/actions/revoke/${key}`, (route) => {
    stale = mode === "stale";
    changed = mode === "changed";
    const refused = { unsupported: 422, moved: 409 }[mode];
    return route.fulfill({
      status: refused ?? 200,
      json: refused
        ? {
            error:
              mode === "moved"
                ? "Invalid observation: simulation/context slot mismatch"
                : "Runtime evidence unavailable",
          }
        : {
            state_version: beforeId,
            arm_schema_version: "0.1",
            observation,
            changes: [
              mode === "cancelled"
                ? { kind: "changed", before: current(), after: current() }
                : { kind: "removed", authorization: current() },
            ],
            signing_transaction: signing,
            response: {
              context: { slot: 10 },
              value: {
                err: null,
                replacementBlockhash: { blockhash: fixture.signing.blockhash, lastValidBlockHeight: 100 },
              },
            },
          },
    });
  });
  await page.route("**/wallet-test-rpc", async (route) => {
    const request = route.request().postDataJSON();
    let result: unknown;
    if (request.method === "getGenesisHash") result = DEVNET_GENESIS;
    else if (request.method === "getBlockHeight") result = mode === "expired" ? 101 : 99;
    // The console names the delegate for display; the bench delegate is a plain wallet.
    else if (request.method === "getAccountInfo")
      result = {
        context: { slot: 10 },
        value: {
          owner: "11111111111111111111111111111111",
          executable: false,
          lamports: 1,
          data: ["", "base64"],
        },
      };
    else if (request.method === "isBlockhashValid") result = { context: { slot: 10 }, value: true };
    else if (request.method === "sendTransaction") {
      sends++;
      signed = request.params[0];
      const submitted = decoder.decode(new Uint8Array(Buffer.from(signed, "base64")));
      expect(submitted.messageBytes).toEqual(
        decoder.decode(new Uint8Array(Buffer.from(signing, "base64"))).messageBytes,
      );
      // A lost response leaves submission unknown; only finalized verification can settle it.
      if (mode === "unknown") return route.abort("connectionreset");
      result = getSignatureFromTransaction(submitted);
    } else if (request.method === "getSignatureStatuses")
      result = {
        context: { slot: 11 },
        value: [
          signed
            ? {
                slot: 11,
                confirmations: null,
                err: mode === "failed-on-chain" ? { InstructionError: [2, { Custom: 4 }] } : null,
                confirmationStatus: "confirmed",
              }
            : null,
        ],
      };
    else throw new Error(`Unexpected RPC ${request.method}`);
    await route.fulfill({ json: { jsonrpc: "2.0", id: request.id, result } });
  });
  await page.route("**/api/snapshots/*/actions/revoke/*/verify", (route) => {
    polls++;
    expect(new URL(route.request().url()).pathname).toBe(
      `/api/snapshots/${beforeId}/actions/revoke/${key}/verify`,
    );
    expect(route.request().postDataJSON()).toEqual({ signed_transaction: signed });
    if (polls === 1 || mode === "pending")
      return route.fulfill({ status: 404, json: { error: "not finalized" } });
    // A busy gateway or an unavailable provider while finalizing is asked again.
    if (mode === "busy" && polls === 2)
      return route.fulfill({ status: 429, body: "Demo busy; retry shortly" });
    if (mode === "busy" && polls === 3) return route.fulfill({ status: 502, body: "Demo unavailable" });
    if (mode === "verification-failed")
      return route.fulfill({ status: 409, json: { error: "Native state changed" } });
    finalized = true;
    const after = record();
    if (mode === "reapproved") after.projection.authorizations = [...kept, grant];
    return route.fulfill({
      json: {
        verification_id: "c".repeat(64),
        state_version: beforeId,
        transaction: { slot: 11, transaction: [signed, "base64"], meta: { err: null } },
        observation: after,
      },
    });
  });
  return { counts: () => ({ sends, polls, observes }) };
}

async function connectAndReview(page: Page) {
  await page.goto("/app");
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  await page.getByRole("button", { name: "Remove access", exact: true }).click();
}

test("wallet signs exact revoke and success waits for finalized verification and scope reload", async ({
  page,
}, info) => {
  const provider = await browserProvider(page);
  await connectAndReview(page);
  await expect(page.getByRole("dialog")).toContainText("25 base units");
  await expect(page.getByRole("heading", { name: "You are removing" })).toBeInViewport();
  await page.screenshot({ path: `test-results/${info.project.name}-review.png`, fullPage: true });
  await page.getByRole("button", { name: "Confirm in wallet" }).click();
  await expect(page.getByRole("heading", { name: "Finalizing", exact: true })).toBeVisible();
  // Access is reported removed as soon as the revoke lands, before finality proves it.
  await expect(page.locator("#action-result")).toContainText("Access removed");
  await expect(page.getByRole("heading", { name: "Removed and verified", exact: true })).toBeVisible();
  await expect(page.locator("#results article")).toHaveCount(0);
  await expect(page.locator("#action-result")).toContainText("the access is gone on devnet.");
  await expect(page.locator("#action-result")).toContainText("c".repeat(64));
  expect(provider.counts()).toEqual({ sends: 1, polls: 2, observes: 1 });
  await page.screenshot({ path: `test-results/${info.project.name}-verified.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const mode of [
  "rejected",
  "tampered",
  "changed-account",
  "stale",
  "expired",
  "verification-failed",
  "reapproved",
]) {
  test(`revoke fails closed: ${mode}`, async ({ page }) => {
    const provider = await browserProvider(page, mode);
    await connectAndReview(page);
    await page.getByRole("button", { name: "Confirm in wallet" }).click();
    // After a send, failure to verify establishes nothing about the chain.
    const sent = ["verification-failed", "reapproved"].includes(mode);
    await expect(
      page.getByRole("heading", { name: sent ? "Unconfirmed" : "Not submitted", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Removed and verified", exact: true })).toHaveCount(0);
    await expect(page.locator("#action-result dd")).toHaveCount(sent ? 1 : 0);
    expect(provider.counts().sends).toBe(sent ? 1 : 0);
  });
}

test("a revoke the network reports failed is shown at once, never as removed", async ({ page }) => {
  const provider = await browserProvider(page, "failed-on-chain");
  await connectAndReview(page);
  await page.getByRole("button", { name: "Confirm in wallet" }).click();
  await expect(page.locator("#action-result")).toContainText("the permission is still active");
  await expect(page.locator("#action-result")).not.toContainText("Access removed");
  await expect(page.getByRole("heading", { name: "Removed and verified", exact: true })).toHaveCount(0);
  expect(provider.counts().sends).toBe(1);
});

test("a busy gateway while finalizing is asked again, and the receipt is kept", async ({ page }) => {
  const provider = await browserProvider(page, "busy");
  await connectAndReview(page);
  await page.getByRole("button", { name: "Confirm in wallet" }).click();
  // Four polls two seconds apart.
  await expect(page.getByRole("heading", { name: "Removed and verified", exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator("#action-result")).toContainText("c".repeat(64));
  expect(provider.counts()).toMatchObject({ sends: 1, polls: 4 });
  expect(await page.evaluate(() => localStorage.getItem("velon:receipts"))).toContain("c".repeat(64));
});

test("an unknown submission is settled by finalized verification, never resent", async ({ page }) => {
  const provider = await browserProvider(page, "unknown");
  await connectAndReview(page);
  await page.getByRole("button", { name: "Confirm in wallet" }).click();
  await expect(page.locator("#action-result")).toContainText("didn't get a clear answer");
  await expect(page.getByRole("heading", { name: "Removed and verified", exact: true })).toBeVisible();
  await expect(page.locator("#results article")).toHaveCount(0);
  expect(provider.counts()).toMatchObject({ sends: 1, polls: 2 });
});

for (const [mode, reason] of [
  ["unsupported", "Runtime evidence unavailable"],
  ["moved", "Nothing was signed"],
  ["changed", "changed after the scan"],
]) {
  test(`no signing review opens: ${mode}`, async ({ page }) => {
    const provider = await browserProvider(page, mode);
    await connectAndReview(page);
    await expect(page.getByRole("heading", { name: "Not submitted", exact: true })).toBeVisible();
    await expect(page.locator("#action-result")).toContainText(reason!);
    await expect(page.getByRole("dialog")).not.toBeVisible();
    expect(provider.counts().sends).toBe(0);
  });
}

const card = (page: Page, id: string) => page.locator(`#results article[data-id="${id}"]`);

test("an ended subscription is revoked by its delegation and the token approval remains", async ({
  page,
}) => {
  const provider = await browserProvider(page, "success", "ended");
  await connectAndReview(page);
  await expect(
    card(page, technical.id).getByRole("button", { name: "Remove access", exact: true }),
  ).toHaveCount(0);
  // The delegation's rent goes to whoever paid for it, which need not be this wallet.
  await expect(page.getByRole("dialog")).toContainText(
    "The ended subscription's record is closed, and its SOL deposit goes back to whoever paid for it. The approval Solana Subscriptions holds on this account stays.",
  );
  await page.getByRole("button", { name: "Confirm in wallet" }).click();
  await expect(page.getByRole("heading", { name: "Removed and verified", exact: true })).toBeVisible();
  await expect(card(page, derived.id)).toHaveCount(0);
  await expect(card(page, technical.id)).toHaveCount(1);
  expect(provider.counts()).toEqual({ sends: 1, polls: 2, observes: 1 });
});

test("an active subscription and its technical approval offer no revoke", async ({ page }) => {
  await browserProvider(page, "success", "active");
  await page.goto("/app");
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  await expect(card(page, derived.id)).toBeVisible();
  await expect(card(page, technical.id)).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove access", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /remove access/i })).toHaveCount(0);
});

test("a subscription simulation that changes the grant instead of removing it is refused", async ({
  page,
}) => {
  const provider = await browserProvider(page, "cancelled", "ended");
  await connectAndReview(page);
  await expect(page.getByRole("heading", { name: "Not submitted", exact: true })).toBeVisible();
  await expect(page.locator("#action-result")).toContainText(
    "Simulation does not match the permission under review.",
  );
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(provider.counts().sends).toBe(0);
});

test("the card leads with one plain sentence and keeps the evidence under Technical details", async ({
  page,
}) => {
  await browserProvider(page);
  await page.goto("/app");
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  const row = card(page, fixture.grant.id);
  // The bench delegate is a plain wallet, as the RPC reports it; the sentence names it so.
  await expect(row.getByRole("heading", { level: 3 })).toHaveText(
    `Wallet ${short(fixture.grant.principal.value)} can take up to 25 of this token's smallest units in total from your wallet without asking you again.`,
  );
  await expect(row.locator(".availability")).toHaveText("In force");
  await expect(row.getByRole("button", { name: "Remove access", exact: true })).toBeVisible();
  const details = row.locator(".technical");
  await expect(details).toBeHidden();
  await expect(row).not.toContainText("base units", { useInnerText: true });
  await expect(row).not.toContainText("Acts directly", { useInnerText: true });
  const toggle = row.getByRole("button", { name: "Technical details" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(details).toBeVisible();
  await expect(details).toContainText("25 base units");
  await expect(details).toContainText("SPL Token");
  await expect(details).toContainText(fixture.signing.source);
  await expect(details.getByText("Exact ARM authorization", { exact: true })).toBeVisible();
  await toggle.click();
  await expect(details).toBeHidden();
});

test("a token name its creator chose is labelled and never enters the sentence", async ({ page }) => {
  await browserProvider(page);
  const mint = fixture.grant.constraints.value.asset.id;
  await page.route("**/api/live/tokens", (route) =>
    route.fulfill({ json: { [mint]: { name: "USD Coin", symbol: "USDC", image: null } } }),
  );
  await page.goto("/app");
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  const row = card(page, fixture.grant.id);
  await expect(row.locator(".token")).toContainText("USDC");
  await expect(row.locator(".token .unverified")).toHaveText("unverified");
  await expect(row.getByRole("heading", { level: 3 })).toContainText("25 of this token's smallest units");
  await expect(row.getByRole("heading", { level: 3 })).not.toContainText("USDC");
});

test("a permanent delegate is explained and never offered for removal", async ({ page }) => {
  await browserProvider(page, "success", undefined, true);
  await page.goto(`/app#${fixture.signing.source}`);
  const holder = page.locator('#results article[data-id$=":permanent-delegate:spend"]');
  await expect(holder.getByRole("heading", { level: 3 })).toContainText(
    "out of any account that holds it. It is set on the token itself, so holders can't remove it.",
  );
  // Before connecting, only what connecting could make removable offers it.
  await expect(
    card(page, fixture.grant.id).getByRole("button", { name: "Connect to remove access", exact: true }),
  ).toBeVisible();
  await expect(holder.getByRole("button", { name: /remove access/i })).toHaveCount(0);
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  await expect(
    card(page, fixture.grant.id).getByRole("button", { name: "Remove access", exact: true }),
  ).toBeVisible();
  await expect(holder.getByRole("button", { name: /remove access/i })).toHaveCount(0);
});
