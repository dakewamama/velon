import { expect, test, type Page } from "@playwright/test";
import { generateKeyPairSync } from "node:crypto";
import { getAddressDecoder } from "@solana/addresses";
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

async function browserProvider(page: Page, mode = "success") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPublic = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  const owner = getAddressDecoder().decode(rawPublic);
  const grant = structuredClone(fixture.grant);
  grant.subject.value = owner;
  const decoder = getTransactionDecoder();
  const original = decoder.decode(new Uint8Array(Buffer.from(fixture.signing.signing_transaction, "base64")));
  const message = getCompiledTransactionMessageDecoder().decode(original.messageBytes);
  if (message.version !== "legacy") throw new Error("Expected native legacy revoke fixture");
  const signing = Buffer.from(
    getTransactionEncoder().encode({
      messageBytes: getCompiledTransactionMessageEncoder().encode({
        ...message,
        staticAccounts: [owner, ...message.staticAccounts.slice(1)],
      }) as TransactionMessageBytes,
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
  const observation = { origin: "finalized", cluster: DEVNET_GENESIS, bank: "browser-test", slot: 10 };
  const afterObservation = { ...observation, slot: 12 };
  const coverage = { complete: false, accounts: [], targets: [] };
  const current = () => (changed ? { ...grant, usage: { ...grant.usage, remaining: 24 } } : grant);
  const view = () => ({
    state_version: finalized ? afterId : beforeId,
    observation: finalized ? afterObservation : observation,
    coverage,
    versions: [],
    sdk_revision: "browser-test",
    arm_schema_version: "0.1",
    projection: {
      status: "compiled",
      authorizations: finalized ? [] : [{ authorization: current(), availability: "active" }],
    },
  });
  const record = () => ({
    id: finalized ? afterId : stale ? "d".repeat(64) : beforeId,
    snapshot: { observation: finalized ? afterObservation : observation },
    projection: { status: "compiled", authorizations: finalized ? [] : [grant] },
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
          examples: [{ label: "Source account", address: fixture.signing.source }],
        },
      ],
    }),
  );
  await page.route("**/api/live/spl/observe", (route) => {
    observes++;
    expect(route.request().headers()["x-velon-action"]).toBe("observe");
    expect(route.request().postDataJSON()).toEqual({ source: fixture.signing.source });
    return route.fulfill({ json: { scope_id: scope, record: record() } });
  });
  await page.route(`**/api/scopes/${scope}/effective/*`, (route) => route.fulfill({ json: view() }));
  await page.route(`**/api/scopes/${scope}`, (route) => route.fulfill({ json: record() }));
  await page.route(`**/api/scopes/${scope}/actions/revoke/${fixture.signing.source}`, (route) => {
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
            changes: [{ kind: "removed", authorization: current() }],
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
    } else throw new Error(`Unexpected RPC ${request.method}`);
    await route.fulfill({ json: { jsonrpc: "2.0", id: request.id, result } });
  });
  await page.route("**/api/snapshots/*/actions/revoke/*/verify", (route) => {
    polls++;
    expect(route.request().postDataJSON()).toEqual({ signed_transaction: signed });
    if (polls === 1 || mode === "pending")
      return route.fulfill({ status: 404, json: { error: "not finalized" } });
    if (mode === "verification-failed")
      return route.fulfill({ status: 409, json: { error: "Native state changed" } });
    finalized = true;
    const after = record();
    if (mode === "reapproved") after.projection.authorizations = [grant];
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
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
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
  await expect(page.getByRole("heading", { name: "Revoked", exact: true })).toBeVisible();
  await expect(page.locator("#results article")).toHaveCount(0);
  await expect(page.locator("#action-result")).toContainText("Verified on chain (devnet).");
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
    await expect(page.getByRole("heading", { name: "Revoked", exact: true })).toHaveCount(0);
    await expect(page.locator("#action-result dd")).toHaveCount(sent ? 1 : 0);
    expect(provider.counts().sends).toBe(sent ? 1 : 0);
  });
}

test("an unknown submission is settled by finalized verification, never resent", async ({ page }) => {
  const provider = await browserProvider(page, "unknown");
  await connectAndReview(page);
  await page.getByRole("button", { name: "Confirm in wallet" }).click();
  await expect(page.locator("#action-result")).toContainText("Submission response is uncertain");
  await expect(page.getByRole("heading", { name: "Revoked", exact: true })).toBeVisible();
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
