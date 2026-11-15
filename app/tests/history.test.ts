import { expect, test } from "bun:test";
import {
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
} from "@solana/addresses";
import { transactionEvents } from "../scripts/history.ts";
import { SUBSCRIPTIONS_PROGRAM } from "../scripts/catalog.ts";
import { EVENT_TAG } from "../scripts/subscriptions.ts";
import type { Json, ObjectValue } from "../src/wire.ts";

const key = (byte: number) => getAddressDecoder().decode(new Uint8Array(32).fill(byte));
const encode58 = (bytes: Uint8Array) => {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let result = "";
  while (number) {
    result = alphabet[Number(number % 58n)] + result;
    number /= 58n;
  }
  return result;
};
const pull = (older = false) => {
  const bytes = new Uint8Array(9 + (older ? 192 : 256));
  bytes.set(EVENT_TAG);
  bytes[8] = 2;
  for (const [offset, byte] of [
    [0, 1],
    [32, 2],
    [64, 3],
    [96, 4],
    [160, 5],
    [192, 6],
    [224, 7],
  ])
    if (offset! < bytes.length - 9) bytes.fill(byte!, offset! + 9, offset! + 41);
  new DataView(bytes.buffer).setBigUint64(137, 0xffffffffffffffffn, true);
  return encode58(bytes);
};
const tx = (data = pull()): ObjectValue => ({
  slot: 9007199254740993n,
  blockTime: 1800000000,
  transaction: { signatures: ["signature"], message: { accountKeys: [key(9)] } },
  meta: {
    err: null,
    loadedAddresses: { writable: [key(8)], readonly: [SUBSCRIPTIONS_PROGRAM] },
    innerInstructions: [{ index: 1, instructions: [{ programIdIndex: 2, data }] }],
  },
});
const read = (raw: Json, cluster = "cluster-a", address = key(1)) =>
  transactionEvents(cluster, address, "signature", 9007199254740993n, raw);

test("ALT ordering, lossless amount and slot, raw evidence, unresolved incarnation", async () => {
  const [row] = await read(tx());
  expect(row).toMatchObject({
    amount: "18446744073709551615",
    slot: "9007199254740993",
    puller: key(7),
    receiver: key(5),
    receiverTokenAccount: key(6),
    attribution: { status: "unresolved", incarnation: null, authorization: null, deployment: null },
    finality: "finalized_rpc",
  });
  expect(Buffer.from(row!.rawEvent as string, "base64").length).toBe(265);
  expect(row!.evidence).toMatch(/^rpc-transaction:sha256:[a-f0-9]{64}$/);
  expect(await read(tx())).toEqual([row!]);
  expect((await read(tx(), "cluster-b"))[0]!.id).not.toBe(row!.id);
});

test("identical events in different instruction positions retain separate identities", async () => {
  const raw = tx();
  const meta = raw.meta as ObjectValue;
  meta.innerInstructions = [
    {
      index: 1,
      instructions: [
        { programIdIndex: 2, data: pull() },
        { programIdIndex: 2, data: pull() },
      ],
    },
  ];
  const rows = await read(raw);
  expect(rows.length).toBe(2);
  expect(rows[0]!.id).not.toBe(rows[1]!.id);
});

test("unavailable metadata, missing keys, wrong slot/signature and failed execution reject", async () => {
  for (const change of [
    { meta: null },
    { slot: 12 },
    { transaction: { signatures: ["other"], message: { accountKeys: [] } } },
  ] as ObjectValue[])
    await expect(read({ ...tx(), ...change })).rejects.toThrow();
  for (const change of [{ err: {} }, { innerInstructions: null }, { loadedAddresses: {} }] as ObjectValue[]) {
    const raw = tx();
    raw.meta = { ...(raw.meta as ObjectValue), ...change };
    await expect(read(raw)).rejects.toThrow();
  }
});

test("older event layouts preserve unknown executor and destination account", async () => {
  const [row] = await read(tx(pull(true)));
  expect(row!.puller).toBeUndefined();
  expect(row!.receiverTokenAccount).toBeUndefined();
  expect(row!.attribution).toMatchObject({ status: "unresolved" });
});

test("unknown event versions produce an explicit evidence gap instead of disappearing", async () => {
  const raw = new Uint8Array([...EVENT_TAG, 99, 0]);
  await expect(read(tx(encode58(raw)))).rejects.toThrow("historical event layout");
});

test("closed subscription lifecycle events match their derived PDA without current state", async () => {
  const encoder = getAddressEncoder();
  const bytes = new Uint8Array(9 + 72);
  bytes.set(EVENT_TAG);
  bytes[8] = 1;
  bytes.set(encoder.encode(key(2)), 9);
  bytes.set(encoder.encode(key(3)), 41);
  const [address] = await getProgramDerivedAddress({
    programAddress: SUBSCRIPTIONS_PROGRAM as Address,
    seeds: [new TextEncoder().encode("subscription"), encoder.encode(key(2)), encoder.encode(key(3))],
  });
  expect((await read(tx(encode58(bytes)), "cluster-a", address))[0]!.kind).toBe("cancelled");
  expect(await read(tx(encode58(bytes)))).toEqual([]);
});
