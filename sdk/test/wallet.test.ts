import { beforeAll, expect, test } from "bun:test";
import { address, getAddressFromPublicKey } from "@solana/addresses";
import { generateKeyPair, signatureBytes } from "@solana/keys";
import {
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
} from "@solana/transaction-messages";
import {
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  type Transaction,
  type TransactionMessageBytes,
} from "@solana/transactions";
import { signReviewedTransaction } from "../index";
import fixture from "./fixtures/spl-revoke-signing.json";

const decoder = getTransactionDecoder();
const encoder = getTransactionEncoder();
const messageDecoder = getCompiledTransactionMessageDecoder();
const messageEncoder = getCompiledTransactionMessageEncoder();
const wire = new Uint8Array(Buffer.from(fixture.signing_transaction, "base64"));
let owner: CryptoKeyPair;
let cosigner: CryptoKeyPair;
let transaction: Transaction;
let reviewed: Uint8Array;

beforeAll(async () => {
  owner = await generateKeyPair();
  cosigner = await generateKeyPair();
  const ownerAddress = await getAddressFromPublicKey(owner.publicKey);
  const original = decoder.decode(wire);
  const message = legacyMessage(original);
  // Use a test signer in the runtime's revoke fixture; the captured owner key is unavailable.
  transaction = {
    messageBytes: messageEncoder.encode({
      ...message,
      staticAccounts: [ownerAddress, ...message.staticAccounts.slice(1)],
    }) as TransactionMessageBytes,
    signatures: { [ownerAddress]: null },
  };
  reviewed = new Uint8Array(encoder.encode(transaction));
});

function legacyMessage(value: Transaction) {
  const message = messageDecoder.decode(value.messageBytes);
  if (message.version !== "legacy") throw new Error("Expected legacy test fixture");
  return message;
}

async function sign(bytes: Uint8Array, keys = [owner]) {
  return new Uint8Array(encoder.encode(await partiallySignTransaction(keys, decoder.decode(bytes))));
}

test("runtime revoke fixture round trips through Kit without changing bytes", () => {
  expect(new Uint8Array(encoder.encode(decoder.decode(wire)))).toEqual(wire);
  const message = legacyMessage(decoder.decode(wire));
  expect(message.version).toBe("legacy");
  expect(message.staticAccounts[0]).toBe(address(fixture.owner));
  expect(message.lifetimeToken).toBe(fixture.blockhash);
  expect(message.instructions).toEqual([
    { programAddressIndex: 2, accountIndices: [1, 0], data: Uint8Array.of(5) },
  ]);
});

test("returns the exact signed wire bytes after verifying the reviewed message", async () => {
  const signed = await sign(reviewed);
  expect(await signReviewedTransaction(reviewed, async () => signed)).toEqual(signed);
  expect(decoder.decode(signed).messageBytes).toEqual(transaction.messageBytes);
});

test.each(["instruction", "blockhash", "account", "program", "extra instruction"])(
  "rejects a valid signature over a changed %s",
  async (change) => {
    const message = legacyMessage(transaction);
    const replacement = await getAddressFromPublicKey(cosigner.publicKey);
    const first = message.instructions[0]!;
    const altered = {
      ...message,
      ...(change === "instruction" && {
        instructions: [{ ...first, data: Uint8Array.of(9) }],
      }),
      ...(change === "blockhash" && { lifetimeToken: fixture.source }),
      ...(change === "account" && {
        staticAccounts: [message.staticAccounts[0]!, replacement, message.staticAccounts[2]!],
      }),
      ...(change === "program" && {
        staticAccounts: [message.staticAccounts[0]!, message.staticAccounts[1]!, replacement],
      }),
      ...(change === "extra instruction" && { instructions: [first, first] }),
    };
    const changed = new Uint8Array(encoder.encode({
      ...transaction,
      messageBytes: messageEncoder.encode(altered) as TransactionMessageBytes,
    }));
    await expect(signReviewedTransaction(reviewed, () => sign(changed))).rejects.toThrow(
      "Wallet changed the reviewed transaction message",
    );
  },
);

test("rejects missing and forged signatures on an unchanged message", async () => {
  await expect(signReviewedTransaction(reviewed, async (bytes) => bytes)).rejects.toThrow("Missing wallet signature");
  const forged = new Uint8Array(encoder.encode({
    ...transaction,
    signatures: { [Object.keys(transaction.signatures)[0]!]: signatureBytes(new Uint8Array(64).fill(1)) },
  }));
  await expect(signReviewedTransaction(reviewed, async () => forged)).rejects.toThrow("Invalid wallet signature");
});

test("rejects a replacement fee payer even with a valid signature", async () => {
  const replacement = await getAddressFromPublicKey(cosigner.publicKey);
  const message = legacyMessage(transaction);
  const changed = new Uint8Array(encoder.encode({
    messageBytes: messageEncoder.encode({
      ...message,
      staticAccounts: [replacement, ...message.staticAccounts.slice(1)],
    }) as TransactionMessageBytes,
    signatures: { [replacement]: null },
  }));
  await expect(signReviewedTransaction(reviewed, () => sign(changed, [cosigner]))).rejects.toThrow(
    "Wallet changed the reviewed transaction message",
  );
});

test("requires every signer and verifies the second signature", async () => {
  const second = await getAddressFromPublicKey(cosigner.publicKey);
  const message = legacyMessage(transaction);
  const multiple: Transaction = {
    messageBytes: messageEncoder.encode({
      ...message,
      header: { ...message.header, numSignerAccounts: 2 },
      staticAccounts: [message.staticAccounts[0]!, second, message.staticAccounts[2]!],
    }) as TransactionMessageBytes,
    signatures: { ...transaction.signatures, [second]: null },
  };
  const input = new Uint8Array(encoder.encode(multiple));
  await expect(signReviewedTransaction(input, (bytes) => sign(bytes))).rejects.toThrow("Missing wallet signature");
  const complete = await sign(input, [owner, cosigner]);
  expect(await signReviewedTransaction(input, async () => complete)).toEqual(complete);
  const forged = new Uint8Array(encoder.encode({
    ...decoder.decode(complete),
    signatures: {
      ...decoder.decode(complete).signatures,
      [second]: signatureBytes(new Uint8Array(64).fill(1)),
    },
  }));
  await expect(signReviewedTransaction(input, async () => forged)).rejects.toThrow("Invalid wallet signature");
});

test("wallet mutations cannot replace the retained review snapshot", async () => {
  const input = new Uint8Array(reviewed);
  await expect(signReviewedTransaction(input, async (walletBytes) => {
    walletBytes[walletBytes.length - 1] = 9;
    input.set(walletBytes);
    return sign(walletBytes);
  })).rejects.toThrow("Wallet changed the reviewed transaction message");
});

test("returned bytes do not alias a buffer retained by the wallet", async () => {
  const signed = await sign(reviewed);
  const result = await signReviewedTransaction(reviewed, async () => signed);
  const expected = new Uint8Array(result);
  signed.fill(0);
  expect(result).toEqual(expected);
});

test("propagates wallet rejection without retrying", async () => {
  const rejection = new Error("User rejected");
  let calls = 0;
  await expect(signReviewedTransaction(reviewed, async () => {
    calls++;
    throw rejection;
  })).rejects.toBe(rejection);
  expect(calls).toBe(1);
});

test.each([0, 10, wire.length - 1])("rejects a truncated review at %i before invoking a wallet", async (length) => {
  let called = false;
  await expect(signReviewedTransaction(wire.slice(0, length), async (bytes) => {
    called = true;
    return bytes;
  })).rejects.toThrow();
  expect(called).toBe(false);
});

test("rejects trailing message bytes and unsupported versions before signing", async () => {
  const trailing = new Uint8Array([...reviewed, 0]);
  await expect(signReviewedTransaction(trailing, sign)).rejects.toThrow("Trailing reviewed message bytes");
  const message = legacyMessage(transaction);
  const versioned = new Uint8Array(encoder.encode({
    ...transaction,
    messageBytes: messageEncoder.encode({ ...message, version: 0 }) as TransactionMessageBytes,
  }));
  await expect(signReviewedTransaction(versioned, sign)).rejects.toThrow("Unsupported reviewed transaction version");
  const unknown = new Uint8Array([...reviewed.slice(0, 65), 0xff, ...reviewed.slice(65)]);
  await expect(signReviewedTransaction(unknown, sign)).rejects.toThrow();
});

test("rejects truncated wallet output", async () => {
  const signed = await sign(reviewed);
  await expect(signReviewedTransaction(reviewed, async () => signed.slice(0, -1))).rejects.toThrow();
});

test("rejects a review with no required signer before calling the wallet", async () => {
  const message = legacyMessage(transaction);
  const input = new Uint8Array([0, ...messageEncoder.encode({
    ...message,
    header: { ...message.header, numSignerAccounts: 0 },
  })]);
  let called = false;
  await expect(signReviewedTransaction(input, async (bytes) => {
    called = true;
    return bytes;
  })).rejects.toThrow("Invalid reviewed transaction signers");
  expect(called).toBe(false);
});

test("rejects duplicate required signers before calling the wallet", async () => {
  const message = legacyMessage(transaction);
  const bytes = messageEncoder.encode({
    ...message,
    header: { ...message.header, numSignerAccounts: 2 },
    staticAccounts: [message.staticAccounts[0]!, message.staticAccounts[0]!, message.staticAccounts[2]!],
  });
  const input = new Uint8Array([2, ...new Uint8Array(128), ...bytes]);
  let called = false;
  await expect(signReviewedTransaction(input, async (value) => {
    called = true;
    return value;
  })).rejects.toThrow("Invalid reviewed transaction signers");
  expect(called).toBe(false);
});
