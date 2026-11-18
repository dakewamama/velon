import { expect, test } from "bun:test";
import { address, getAddressDecoder } from "@solana/addresses";
import { fixtureMode, requireDisposableFunding, subscriptionCharge } from "../scripts/devnet-journey.ts";

test("fixture mode is explicit and insufficient disposable funding fails closed", () => {
  expect(fixtureMode(undefined)).toBe("expired");
  expect(fixtureMode("active-charge")).toBe("active-charge");
  expect(() => fixtureMode("mainnet")).toThrow();
  expect(() => requireDisposableFunding(109_999_999n)).toThrow();
  requireDisposableFunding(110_000_000n);
});

test("charge bytes and signer/writable roles equal the official client's natively executed fixture", async () => {
  const fixture = await Bun.file(
    new URL("../../sdk/tests/fixtures/subscriptions-lifecycle.json", import.meta.url),
  ).json();
  const transition = fixture.transitions.find((entry: { name: string }) => entry.name === "owner_pull_60");
  expect(transition.outcome).toBe("Ok(())");
  const native = transition.instruction;
  const keys = native.accounts.map((entry: { address: string }) => address(entry.address));
  const data = Buffer.from(native.data, "hex");
  const input = {
    subscription: keys[0]!,
    plan: keys[1]!,
    authority: keys[2]!,
    source: keys[3]!,
    receiver: keys[4]!,
    puller: keys[5]!,
    mint: keys[6]!,
    tokenProgram: keys[7]!,
    eventAuthority: keys[8]!,
    program: keys[9]!,
    owner: getAddressDecoder().decode(data.subarray(9, 41)),
    amount: 60n,
  };
  const charge = subscriptionCharge(input);
  expect(Buffer.from(charge.data).toString("hex")).toBe(native.data);
  expect(
    charge.accounts.map((entry) => ({
      address: entry.address,
      signer: (entry.role & 2) !== 0,
      writable: (entry.role & 1) !== 0,
    })),
  ).toEqual(native.accounts);
  expect(() => subscriptionCharge({ ...input, amount: 0n })).toThrow();
  expect(() => subscriptionCharge({ ...input, amount: 1n << 64n })).toThrow();
  expect(
    new DataView(subscriptionCharge({ ...input, amount: (1n << 64n) - 1n }).data.buffer).getBigUint64(
      1,
      true,
    ),
  ).toBe((1n << 64n) - 1n);
});
