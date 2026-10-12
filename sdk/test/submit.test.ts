import { afterEach, beforeAll, expect, test } from "bun:test";
import { getAddressFromPublicKey } from "@solana/addresses";
import { generateKeyPair } from "@solana/keys";
import { createSolanaRpc } from "@solana/rpc";
import { blockhash } from "@solana/rpc-types";
import {
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
} from "@solana/transaction-messages";
import {
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  type TransactionMessageBytes,
} from "@solana/transactions";
import { signAndSubmitReviewedTransaction } from "../index";
import fixture from "./fixtures/spl-revoke-signing.json";

const decoder = getTransactionDecoder();
const encoder = getTransactionEncoder();
const messageDecoder = getCompiledTransactionMessageDecoder();
let owner: CryptoKeyPair;
let reviewed: Uint8Array;
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

beforeAll(async () => {
  owner = await generateKeyPair();
  const ownerAddress = await getAddressFromPublicKey(owner.publicKey);
  const original = decoder.decode(
    new Uint8Array(Buffer.from(fixture.signing_transaction, "base64")),
  );
  const message = messageDecoder.decode(original.messageBytes);
  if (message.version !== "legacy") throw new Error("Expected legacy fixture");
  reviewed = new Uint8Array(
    encoder.encode({
      messageBytes: getCompiledTransactionMessageEncoder().encode({
        ...message,
        staticAccounts: [ownerAddress, ...message.staticAccounts.slice(1)],
      }) as TransactionMessageBytes,
      signatures: { [ownerAddress]: null },
    }),
  );
});

function config() {
  const message = messageDecoder.decode(decoder.decode(reviewed).messageBytes);
  if (message.version !== "legacy") throw new Error("Expected legacy fixture");
  return {
    genesisHash: fixture.source,
    minContextSlot: 10n,
    lifetime: {
      blockhash: blockhash(message.lifetimeToken),
      lastValidBlockHeight: 100n,
    },
  };
}

async function sign(bytes: Uint8Array) {
  return new Uint8Array(
    encoder.encode(
      await partiallySignTransaction([owner], decoder.decode(bytes)),
    ),
  );
}

function provider() {
  const state = {
    genesis: fixture.source,
    height: "100",
    slot: "10",
    valid: true,
    failure: "",
    signatureMismatch: false,
  };
  const requests: { method: string; params: unknown[] }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const payload = (await request.json()) as {
        id: string;
        method: string;
        params: unknown[];
      };
      requests.push(payload);
      if (state.failure === payload.method)
        return new Response("unavailable", { status: 503 });
      let result: string;
      switch (payload.method) {
        case "getGenesisHash":
          result = JSON.stringify(state.genesis);
          break;
        case "getBlockHeight":
          result = state.height;
          break;
        case "isBlockhashValid":
          result = `{"context":{"slot":${state.slot}},"value":${state.valid}}`;
          break;
        case "sendTransaction": {
          const bytes = new Uint8Array(
            Buffer.from(payload.params[0] as string, "base64"),
          );
          result = JSON.stringify(
            state.signatureMismatch
              ? "different"
              : getSignatureFromTransaction(decoder.decode(bytes)),
          );
          break;
        }
        default:
          throw new Error(`Unexpected RPC method ${payload.method}`);
      }
      return new Response(
        `{"jsonrpc":"2.0","id":${JSON.stringify(payload.id)},"result":${result}}`,
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  servers.push(server);
  return { state, requests, rpc: createSolanaRpc(String(server.url)) };
}

function sent(requests: { method: string }[]) {
  return requests.filter((r) => r.method === "sendTransaction");
}

test("submits exact verified bytes once at the inclusive lifetime boundary using Kit HTTP", async () => {
  const { rpc, requests } = provider();
  let signatures = 0;
  const result = await signAndSubmitReviewedTransaction(
    rpc,
    reviewed,
    async (bytes) => {
      signatures++;
      return sign(bytes);
    },
    config(),
  );
  expect(result.status).toBe("submitted");
  expect(signatures).toBe(1);
  expect(requests.filter((r) => r.method === "getBlockHeight")).toHaveLength(2);
  expect(requests.filter((r) => r.method === "getGenesisHash")).toHaveLength(2);
  expect(sent(requests)).toHaveLength(1);
  // Kit removes explicit finalized commitment because it is the RPC server default.
  expect(requests.at(-1)?.method).toBe("sendTransaction");
  expect(requests.at(-1)?.params).toEqual([
    result.signedTransaction,
    {
      encoding: "base64",
      skipPreflight: false,
      minContextSlot: 10,
    },
  ]);
  for (const request of requests.filter((r) => r.method === "getBlockHeight")) {
    expect(request.params).toEqual([{ minContextSlot: 10 }]);
  }
  for (const request of requests.filter(
    (r) => r.method === "isBlockhashValid",
  )) {
    expect(request.params).toEqual([fixture.blockhash, { minContextSlot: 10 }]);
  }
  const submitted = decoder.decode(
    new Uint8Array(Buffer.from(result.signedTransaction, "base64")),
  );
  expect(submitted.messageBytes).toEqual(decoder.decode(reviewed).messageBytes);
  expect(result.signature).toBe(getSignatureFromTransaction(submitted));
});

test.each([
  "expired",
  "missing hash",
  "cluster",
  "stale slot",
  "bad height",
  "provider",
])("rejects %s before requesting a wallet signature", async (fault) => {
  const { rpc, state, requests } = provider();
  if (fault === "expired") state.height = "101";
  if (fault === "missing hash") state.valid = false;
  if (fault === "cluster") state.genesis = fixture.owner;
  if (fault === "stale slot") state.slot = "9";
  if (fault === "bad height") state.height = '"100"';
  if (fault === "provider") state.failure = "getBlockHeight";
  let signatures = 0;
  await expect(
    signAndSubmitReviewedTransaction(
      rpc,
      reviewed,
      async (bytes) => {
        signatures++;
        return sign(bytes);
      },
      config(),
    ),
  ).rejects.toThrow();
  expect(signatures).toBe(0);
  expect(sent(requests)).toHaveLength(0);
});

test.each(["expired", "missing hash", "cluster", "provider"])(
  "rechecks %s after the wallet returns",
  async (fault) => {
    const { rpc, state, requests } = provider();
    await expect(
      signAndSubmitReviewedTransaction(
        rpc,
        reviewed,
        async (bytes) => {
          if (fault === "expired") state.height = "101";
          if (fault === "missing hash") state.valid = false;
          if (fault === "cluster") state.genesis = fixture.owner;
          if (fault === "provider") state.failure = "getBlockHeight";
          return sign(bytes);
        },
        config(),
      ),
    ).rejects.toThrow();
    expect(sent(requests)).toHaveLength(0);
  },
);

test.each(["rejection", "changed message", "forged signature"])(
  "wallet %s never reaches send",
  async (fault) => {
    const { rpc, requests } = provider();
    await expect(
      signAndSubmitReviewedTransaction(
        rpc,
        reviewed,
        async (bytes) => {
          if (fault === "rejection") throw new Error("Wallet rejected");
          if (fault === "forged signature") return bytes;
          bytes[bytes.length - 1] = 9;
          return sign(bytes);
        },
        config(),
      ),
    ).rejects.toThrow();
    expect(sent(requests)).toHaveLength(0);
  },
);

test.each(["transport", "signature"])(
  "retains signed recovery evidence after send %s failure",
  async (fault) => {
    const { rpc, state, requests } = provider();
    if (fault === "transport") state.failure = "sendTransaction";
    else state.signatureMismatch = true;
    const result = await signAndSubmitReviewedTransaction(
      rpc,
      reviewed,
      sign,
      config(),
    );
    expect(result.status).toBe("unknown");
    expect(sent(requests)).toHaveLength(1);
    expect(result.signature).toBe(
      getSignatureFromTransaction(
        decoder.decode(
          new Uint8Array(Buffer.from(result.signedTransaction, "base64")),
        ),
      ),
    );
    if (result.status === "unknown") expect(result.error).toBeDefined();
  },
);

test("caller mutation cannot replace the retained review or extend its lifetime", async () => {
  const { rpc, state, requests } = provider();
  const options = config();
  const bytes = new Uint8Array(reviewed);
  await expect(
    signAndSubmitReviewedTransaction(
      rpc,
      bytes,
      async (walletBytes) => {
        options.lifetime.lastValidBlockHeight = 1000n;
        options.genesisHash = fixture.owner;
        bytes[bytes.length - 1] = 9;
        state.height = "101";
        return sign(walletBytes);
      },
      options,
    ),
  ).rejects.toThrow("expired");
  expect(sent(requests)).toHaveLength(0);
});

test.each([
  "blockhash",
  "negative slot",
  "zero height",
  "overflow height",
  "trailing bytes",
])("invalid %s rejects without RPC or signing", async (fault) => {
  const { rpc, requests } = provider();
  const options = config();
  let input = reviewed;
  if (fault === "blockhash")
    options.lifetime.blockhash = blockhash(fixture.source);
  if (fault === "negative slot") options.minContextSlot = -1n;
  if (fault === "zero height") options.lifetime.lastValidBlockHeight = 0n;
  if (fault === "overflow height")
    options.lifetime.lastValidBlockHeight = 1n << 64n;
  if (fault === "trailing bytes") input = new Uint8Array([...reviewed, 0]);
  let called = false;
  await expect(
    signAndSubmitReviewedTransaction(
      rpc,
      input,
      async (bytes) => {
        called = true;
        return sign(bytes);
      },
      options,
    ),
  ).rejects.toThrow();
  expect(called).toBe(false);
  expect(requests).toHaveLength(0);
});

test("block height stays exact above JavaScript's safe integer boundary", async () => {
  const { rpc, state, requests } = provider();
  const options = config();
  options.lifetime.lastValidBlockHeight = 9007199254740992n;
  state.height = "9007199254740993";
  await expect(
    signAndSubmitReviewedTransaction(rpc, reviewed, sign, options),
  ).rejects.toThrow("expired");
  expect(sent(requests)).toHaveLength(0);
});

test.each(["before", "wallet"])(
  "abort %s signing prevents submission",
  async (phase) => {
    const { rpc, requests } = provider();
    const controller = new AbortController();
    if (phase === "before") controller.abort();
    let called = false;
    await expect(
      signAndSubmitReviewedTransaction(
        rpc,
        reviewed,
        async (bytes) => {
          called = true;
          controller.abort();
          return sign(bytes);
        },
        { ...config(), abortSignal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(called).toBe(phase === "wallet");
    expect(sent(requests)).toHaveLength(0);
  },
);
