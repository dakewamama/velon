import { createHash } from "node:crypto";
import { getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/addresses";
import { array, integer, object, text, writeJson, type Json, type ObjectValue } from "../src/wire.ts";
import { SUBSCRIPTIONS_PROGRAM } from "../scripts/catalog.ts";
import { base58, event, EVENT_TAG, type Event } from "../scripts/subscriptions.ts";

// This reader establishes transaction facts under RPC trust. It does not resolve a
// historical executable, account incarnation or the plan's historical constraints.
async function mentions(value: Event, address: string): Promise<boolean> {
  if (value.kind === "pull") return value.delegation === address;
  const encoder = getAddressEncoder();
  const [derived] = await getProgramDerivedAddress({
    programAddress: SUBSCRIPTIONS_PROGRAM as Address,
    seeds: [
      new TextEncoder().encode("subscription"),
      encoder.encode(value.plan),
      encoder.encode(value.subscriber),
    ],
  });
  return derived === address;
}

export async function transactionEvents(
  cluster: string,
  address: string,
  signature: string,
  expectedSlot: Json,
  raw: Json,
): Promise<ObjectValue[]> {
  const tx = object(raw);
  const slot = integer(tx.slot);
  if (slot < 0n || slot > 0xffffffffffffffffn || slot !== integer(expectedSlot))
    throw new Error("Transaction slot disagrees with signature evidence.");
  const transaction = object(tx.transaction);
  if (array(transaction.signatures)[0] !== signature)
    throw new Error("Transaction signature disagrees with requested evidence.");
  const meta = object(tx.meta);
  if (meta.err !== null) throw new Error("Transaction was not successful.");
  // null means recording was unavailable, not that no inner instructions ran.
  const groups = array(meta.innerInstructions);
  const loaded = object(meta.loadedAddresses ?? {});
  const keys = [
    ...array(object(transaction.message).accountKeys),
    ...array(loaded.writable ?? []),
    ...array(loaded.readonly ?? []),
  ].map(text);
  const evidenceHash = createHash("sha256").update(writeJson(tx)).digest("hex");
  const result: ObjectValue[] = [];
  const positions = new Set<string>();
  for (const group of groups.map(object)) {
    const outer = integer(group.index);
    if (outer < 0n || outer > 255n) throw new Error("Invalid outer instruction position.");
    const instructions = array(group.instructions);
    for (let inner = 0; inner < instructions.length; inner++) {
      const instruction = object(instructions[inner]);
      const index = integer(instruction.programIdIndex);
      if (index < 0n || index >= BigInt(keys.length)) throw new Error("Missing transaction account keys.");
      if (keys[Number(index)] !== SUBSCRIPTIONS_PROGRAM) continue;
      const bytes = base58(text(instruction.data));
      const value = bytes && event(bytes);
      if (bytes && EVENT_TAG.every((byte, offset) => bytes[offset] === byte) && !value)
        throw new Error("Unsupported or malformed historical event layout.");
      if (!value || !(await mentions(value, address))) continue;
      const position = `${outer}:${inner}`;
      if (positions.has(position)) throw new Error("Duplicate instruction position.");
      positions.add(position);
      const id = createHash("sha256")
        .update(JSON.stringify(["velon:event:1", cluster, SUBSCRIPTIONS_PROGRAM, signature, position]))
        .digest("hex");
      result.push({
        ...Object.fromEntries(
          Object.entries(value)
            .filter(([, data]) => data !== undefined)
            .map(([field, data]) => [field, typeof data === "bigint" ? String(data) : data]),
        ),
        id,
        signature,
        slot: slot.toString(),
        time: tx.blockTime == null ? null : integer(tx.blockTime).toString(),
        outer: Number(outer),
        inner,
        cluster,
        program: SUBSCRIPTIONS_PROGRAM,
        rawEvent: Buffer.from(bytes!).toString("base64"),
        evidence: `rpc-transaction:sha256:${evidenceHash}`,
        finality: "finalized_rpc",
        interpretation: "unverified_event_layout",
        attribution: {
          status: "unresolved",
          reason: "Historical creation and account-state evidence are unavailable.",
          authorization: null,
          incarnation: null,
          deployment: null,
          stateVersion: null,
        },
      });
    }
  }
  return result;
}
