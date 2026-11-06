import { blockhash } from "@solana/rpc-types";
import { getCompiledTransactionMessageDecoder } from "@solana/transaction-messages";
import { getTransactionDecoder } from "@solana/transactions";
import {
  call,
  array,
  grants,
  integer,
  object,
  readJson,
  text,
  writeJson,
  type Json,
  type ObjectValue,
} from "./wire.ts";

export type Control = {
  cluster: string;
  rpcUrl: string;
  network: "mainnet" | "devnet" | "localnet";
  /// The server can mint fresh test permissions on its disposable ledger.
  testBench?: boolean;
  /// The consoles for the other public networks, each a separate deployment.
  elsewhere?: Elsewhere[];
};
export type Elsewhere = { network: "mainnet" | "devnet"; url: string };

/// Reads `mainnet=https://…,devnet=https://…` into the consoles other than this one. Anything that
/// isn't a known network on https (or a local http address) is dropped, never linked.
export function otherConsoles(spec: string | undefined, current: string): Elsewhere[] {
  const found = new Map<Elsewhere["network"], string>();
  for (const entry of (spec ?? "").split(",")) {
    const [name, value] = entry.split("=").map((part) => part.trim());
    if ((name !== "mainnet" && name !== "devnet") || name === current || !value || found.has(name)) continue;
    try {
      const url = new URL(value);
      const local = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
      if ((url.protocol === "https:" || local) && !url.hash && !url.search && !url.username)
        found.set(name, url.href);
    } catch {
      /* Not a URL; left out. */
    }
  }
  return [...found].map(([network, url]) => ({ network, url }));
}
export type ActionState =
  "PREPARING" | "SIMULATED" | "AWAITING_SIGNATURE" | "SUBMITTING" | "FINALIZING" | "VERIFIED" | "FAILED";
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

export async function action(
  path: string,
  signal: AbortSignal,
  signedTransaction?: string,
): Promise<Response> {
  return call(
    `/api/${path}`,
    {
      method: "POST",
      headers: {
        "X-Velon-Action": "revoke",
        ...(signedTransaction ? { "Content-Type": "application/json" } : {}),
      },
      body: signedTransaction ? JSON.stringify({ signed_transaction: signedTransaction }) : undefined,
      signal,
    },
    60000,
  );
}

export async function result(response: Response): Promise<Json> {
  const raw = await response.text();
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      message = text(object(readJson(raw)).error);
    } catch {
      /* Providers may return non-JSON errors. */
    }
    throw new Error(message);
  }
  return readJson(raw);
}

export function reviewRevoke(
  value: Json,
  view: ObjectValue,
  grant: ObjectValue,
  owner: string,
  control: Control,
) {
  const simulation = object(value);
  const observation = object(simulation.observation);
  const changes = array(simulation.changes);
  const change = object(changes[0]);
  if (
    simulation.state_version !== view.state_version ||
    simulation.arm_schema_version !== "0.1" ||
    observation.origin !== "finalized" ||
    observation.cluster !== object(view.observation).cluster ||
    integer(observation.slot) !== integer(object(view.observation).slot) ||
    observation.cluster !== control.cluster ||
    (control.network === "devnet" && observation.cluster !== DEVNET_GENESIS) ||
    (control.network === "mainnet" && observation.cluster !== MAINNET_GENESIS) ||
    changes.length !== 1 ||
    change.kind !== "removed" ||
    writeJson(change.authorization!) !== writeJson(grant)
  )
    throw new Error("Simulation does not match the permission under review.");
  const nativeResponse = object(simulation.response);
  const native = object(nativeResponse.value);
  // The runtime executed in the observed bank; the provider's agreeing bank may be later.
  if (native.err !== null || integer(object(nativeResponse.context).slot) < integer(observation.slot))
    throw new Error("Simulation did not verify the observed state.");
  const bytes = Uint8Array.from(atob(text(simulation.signing_transaction)), (c) => c.charCodeAt(0));
  const transaction = getTransactionDecoder().decode(bytes);
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  if (
    message.version !== "legacy" ||
    Object.keys(transaction.signatures).length !== 1 ||
    Object.keys(transaction.signatures)[0] !== owner
  )
    throw new Error("The connected wallet is not the required owner.");
  const lifetime = object(native.replacementBlockhash);
  if (message.lifetimeToken !== lifetime.blockhash) throw new Error("Simulation blockhash mismatch.");
  return {
    bytes,
    genesisHash: text(observation.cluster),
    minContextSlot: integer(observation.slot),
    lifetime: {
      blockhash: blockhash(message.lifetimeToken),
      lastValidBlockHeight: integer(lifetime.lastValidBlockHeight),
    },
    evidence: simulation,
  };
}

export function verifiedRevoke(
  value: Json,
  latestValue: Json,
  stateVersion: string,
  grantId: string,
  signedTransaction: string,
) {
  const verification = object(value);
  const receipt = object(verification.transaction);
  const observed = object(verification.observation);
  const latest = object(latestValue);
  const id = text(verification.verification_id);
  const snapshot = object(observed.snapshot);
  const observation = object(snapshot.observation);
  const latestObservation = object(object(latest.snapshot).observation);
  const slot = integer(receipt.slot);
  if (
    !/^[a-f0-9]{64}$/.test(id) ||
    verification.state_version !== stateVersion ||
    object(receipt.meta).err !== null ||
    array(receipt.transaction)[0] !== signedTransaction ||
    array(receipt.transaction)[1] !== "base64" ||
    observation.origin !== "finalized" ||
    latestObservation.origin !== "finalized" ||
    latestObservation.cluster !== observation.cluster ||
    latest.id !== observed.id ||
    slot < 0n ||
    integer(observation.slot) < slot ||
    grants(observed.projection).some((grant) => grant.id === grantId) ||
    grants(latest.projection).some((grant) => grant.id === grantId)
  )
    throw new Error("Finalized verification and current permissions do not agree.");
  return { id, slot, observationSlot: integer(observation.slot) };
}
