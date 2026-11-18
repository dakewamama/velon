import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getAddressDecoder } from "@solana/addresses";
import { DEVNET_GENESIS } from "../../src/control.ts";

const fixturePath = process.env.LIVE_SUBSCRIPTION_FIXTURE;
const rpcUrl = process.env.RPC_URL;
test.skip(
  !fixturePath || !rpcUrl || process.env.LIVE_SUBSCRIPTION_CANCEL !== "1",
  "Requires the controlled active-charge fixture, RPC_URL and explicit LIVE_SUBSCRIPTION_CANCEL=1.",
);

// Real RPC, real disposable wallet signatures, real native execution. No route interception.
test("an active devnet subscription has a charge and the console cancels it with finalized proof", async ({
  page,
  request,
}) => {
  const fixture = JSON.parse(readFileSync(fixturePath!, "utf8"));
  expect(fixture.mode).toBe("active-charge");
  expect(fixture.cluster).toBe(DEVNET_GENESIS);
  expect(fixture.merchantIdentity).toBe("unverified");
  const rpc = async (method: string, params: unknown[] = []) => {
    // Only reads may retry; signed submissions belong exclusively to the console.
    expect(method.startsWith("get")).toBe(true);
    for (let attempt = 0; ; attempt++) {
      const reply = await request.post(rpcUrl!, { data: { jsonrpc: "2.0", id: 1, method, params } });
      if ((reply.status() === 429 || reply.status() === 503) && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      expect(reply.ok()).toBe(true);
      const body = await reply.json();
      expect(body.error).toBeUndefined();
      return body.result;
    }
  };
  expect(await rpc("getGenesisHash")).toBe(DEVNET_GENESIS);
  const configuration = await request.get("/api/control");
  expect(configuration.ok()).toBe(true);
  const control = await configuration.json();
  expect(control).toMatchObject({ network: "devnet", cluster: DEVNET_GENESIS, apiVersion: "1" });
  expect(new URL(control.rpcUrl).href).toBe(new URL(rpcUrl!).href);
  const account = async (key: string) => {
    const result = await rpc("getAccountInfo", [key, { commitment: "finalized", encoding: "base64" }]);
    expect(result.value).not.toBeNull();
    return { ...result.value, bytes: Buffer.from(result.value.data[0], "base64") };
  };
  const before = await account(fixture.subscription);
  expect(before.bytes.length).toBe(155);
  expect(before.bytes.readBigInt64LE(147)).toBe(0n);
  expect(before.bytes.readBigUInt64LE(131).toString()).toBe(fixture.amount);
  const chargeSignature = fixture.signatures.TransferSubscription;
  const charge = await rpc("getTransaction", [
    chargeSignature,
    { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 },
  ]);
  expect(charge).not.toBeNull();
  expect(charge.meta.err).toBeNull();
  const approval = (await account(fixture.source)).bytes;
  expect(getAddressDecoder().decode(approval.subarray(76, 108))).toBe(fixture.authority);
  expect((await account(fixture.receiver)).bytes.readBigUInt64LE(64).toString()).toBe(fixture.amount);

  // Only the fixture's generated subscriber is used. Never accept a personal wallet fallback.
  const secret: number[] = JSON.parse(
    readFileSync(resolve(dirname(fixturePath!), "subscriber.json"), "utf8"),
  );
  expect(secret).toHaveLength(64);
  expect(getAddressDecoder().decode(Uint8Array.from(secret.slice(32)))).toBe(fixture.subscriber);
  await page.addInitScript(
    ({ secret, owner }) => {
      const account = {
        address: owner,
        publicKey: new Uint8Array(secret.slice(32)),
        chains: ["solana:devnet"],
        features: ["solana:signTransaction"],
      };
      const wallet = {
        version: "1.0.0",
        name: "Disposable devnet subscriber",
        icon: "data:image/svg+xml,<svg/>",
        chains: ["solana:devnet"],
        accounts: [account],
        features: {
          "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
          "standard:events": { version: "1.0.0", on: () => () => {} },
          "solana:signTransaction": {
            version: "1.0.0",
            supportedTransactionVersions: ["legacy"],
            signTransaction: async ({ transaction }: { transaction: Uint8Array }) => {
              const bytes = new Uint8Array(transaction);
              const pkcs8 = new Uint8Array([
                48,
                46,
                2,
                1,
                0,
                48,
                5,
                6,
                3,
                43,
                101,
                112,
                4,
                34,
                4,
                32,
                ...secret.slice(0, 32),
              ]);
              const key = await crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", false, ["sign"]);
              bytes.set(new Uint8Array(await crypto.subtle.sign("Ed25519", key, bytes.slice(65))), 1);
              return [{ signedTransaction: bytes }];
            },
          },
        },
      };
      window.addEventListener("wallet-standard:app-ready", (event) => {
        (event as CustomEvent<{ register: (wallet: unknown) => void }>).detail.register(wallet);
      });
    },
    { secret, owner: fixture.subscriber },
  );
  await page.goto("/app");
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  const card = page.locator(`#results .permission[data-source="${fixture.source}"][data-cancellable]`);
  await expect(card).toHaveCount(1, { timeout: 60000 });
  await expect(card.getByText("Plan name set by the merchant", { exact: true })).toBeVisible();
  await expect(card.locator(`[title*="${fixture.planName}"]`)).toHaveAttribute("title", /not verified/);
  await card.getByRole("button", { name: "Details", exact: true }).click();
  await expect(card.locator(".charges")).toContainText("Reported transfer of 40 base units", {
    timeout: 60000,
  });
  await expect(card.locator(".charges")).toContainText(
    "these events have not been linked to the current permission",
  );
  const history = await request.post("/api/live/history", {
    headers: { "X-Velon-Action": "observe" },
    data: { delegation: fixture.subscription },
  });
  expect(history.ok()).toBe(true);
  const activity = await history.json();
  const payment = activity.events.find(
    (entry: { signature: string; kind: string }) =>
      entry.signature === chargeSignature && entry.kind === "pull",
  );
  expect(payment).toMatchObject({
    puller: fixture.merchant,
    receiver: fixture.merchant,
    mint: fixture.mint,
    amount: fixture.amount,
    receiverTokenAccount: fixture.receiver,
    finality: "finalized_rpc",
  });
  await expect(
    card.locator(`.charges a[href="https://explorer.solana.com/tx/${chargeSignature}?cluster=devnet"]`),
  ).toHaveText("Transaction");
  await card.getByText("Historical transaction evidence", { exact: true }).click();
  await expect(
    card.locator(`.charges a[href="/api/activity/transactions/${DEVNET_GENESIS}/${chargeSignature}"]`),
  ).toBeVisible();
  await card.getByRole("button", { name: "Cancel subscription", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("It can still charge until");
  await page.getByRole("button", { name: "Confirm in wallet", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Cancelled and verified", exact: true })).toBeVisible({
    timeout: 120000,
  });
  const values = await page.locator("#action-result dd").allTextContents();
  const verification = values.at(-1)!;
  const href = (await page.locator("#action-result dd a").getAttribute("href"))!;
  const signature = new URL(href).pathname.split("/").pop()!;
  const proof = await request.get(`/api/verifications/revoke/${verification}`);
  expect(proof.ok()).toBe(true);
  const receipt = await proof.json();
  expect(receipt.verification_id).toBe(verification);
  // Keep success evidence even if a later independent RPC read is unavailable.
  writeFileSync(
    resolve(dirname(fixturePath!), `console-receipt-${signature}.json`),
    JSON.stringify({ signature, verification, receipt }, null, 2),
    { flag: "wx", mode: 0o600 },
  );
  await page.screenshot({ path: resolve(dirname(fixturePath!), "console-finalized.png"), fullPage: true });
  const cancelled = await rpc("getTransaction", [
    signature,
    { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 },
  ]);
  expect(cancelled).not.toBeNull();
  expect(cancelled.meta.err).toBeNull();
  expect(String(cancelled.slot)).toBe(values[1]);
  const after = await account(fixture.subscription);
  expect(after.bytes.readBigInt64LE(147)).toBe(before.bytes.readBigInt64LE(139) + 3600n);
  expect((await account(fixture.source)).bytes).toEqual(approval);
  writeFileSync(
    resolve(dirname(fixturePath!), `console-cancel-${signature}.json`),
    JSON.stringify(
      { signature, verification, cancelled, subscriptionData: after.bytes.toString("base64"), receipt },
      null,
      2,
    ),
    { flag: "wx", mode: 0o600 },
  );
});
