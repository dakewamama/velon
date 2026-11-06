import { expect, test } from "bun:test";
import {
  DEVNET_GENESIS,
  otherConsoles,
  reviewAction,
  reviewRevoke,
  verifiedAction,
  verifiedRevoke,
} from "../src/control.ts";
import { array, object, type ObjectValue } from "../src/wire.ts";
import fixture from "./fixtures/spl-control.json";

const devnet = { cluster: DEVNET_GENESIS, rpcUrl: "http://127.0.0.1:1", network: "devnet" } as const;

function input() {
  const grant = structuredClone(fixture.grant) as ObjectValue;
  const view = { ...fixture.view, observation: { origin: "finalized", cluster: DEVNET_GENESIS, slot: 10 } };
  const simulation = {
    state_version: view.state_version,
    arm_schema_version: "0.1",
    observation: view.observation,
    changes: [{ kind: "removed", authorization: grant }],
    signing_transaction: fixture.signing.signing_transaction,
    response: {
      context: { slot: 10 },
      value: {
        err: null,
        replacementBlockhash: {
          blockhash: fixture.signing.blockhash,
          lastValidBlockHeight: 100,
        },
      },
    },
  };
  return { grant, view, simulation };
}

test("review binds native revoke bytes, owner, permission and simulation bank", () => {
  const { grant, view, simulation } = input();
  const review = reviewRevoke(simulation, view, grant, fixture.signing.owner, devnet);
  expect(Buffer.from(review.bytes).toString("base64")).toBe(fixture.signing.signing_transaction);
  expect(review.minContextSlot).toBe(10n);
  expect(review.lifetime.lastValidBlockHeight).toBe(100n);
  expect(() => reviewRevoke(simulation, view, grant, fixture.signing.source, devnet)).toThrow(
    "required owner",
  );
  // A mainnet console never reviews bytes observed on another cluster, whatever it is told.
  const mainnet = { ...devnet, network: "mainnet" } as const;
  expect(() => reviewRevoke(simulation, view, grant, fixture.signing.owner, mainnet)).toThrow();
  const elsewhere = { ...devnet, cluster: "another-genesis", network: "localnet" } as const;
  expect(() => reviewRevoke(simulation, view, grant, fixture.signing.owner, elsewhere)).toThrow();
  for (const mutate of [
    (s: ObjectValue) => (s.state_version = "different"),
    (s: ObjectValue) => (object(s.observation).origin = "fixture"),
    (s: ObjectValue) => (object(s.observation).cluster = "wrong-chain"),
    (s: ObjectValue) => (object(s.observation).slot = 11),
    (s: ObjectValue) => (s.changes = []),
    (s: ObjectValue) => (object(object(s.response).value).err = "failed"),
    (s: ObjectValue) => (object(object(s.response).context).slot = 9),
    (s: ObjectValue) =>
      (object(object(object(s.response).value).replacementBlockhash).blockhash = "different"),
  ]) {
    const changed = structuredClone(simulation) as ObjectValue;
    mutate(changed);
    expect(() => reviewRevoke(changed, view, grant, fixture.signing.owner, devnet)).toThrow();
  }
  // The runtime executed in the observed bank; a provider may agree from a later one.
  const later = structuredClone(simulation) as ObjectValue;
  object(object(later.response).context).slot = 11;
  expect(() => reviewRevoke(later, view, grant, fixture.signing.owner, devnet)).not.toThrow();
});

function finalized() {
  const { grant, view } = input();
  const latest = {
    id: "b".repeat(64),
    snapshot: { observation: { origin: "finalized", cluster: DEVNET_GENESIS, slot: 12 } },
    projection: { status: "compiled", authorizations: [] },
  };
  const verification = {
    verification_id: "c".repeat(64),
    state_version: view.state_version,
    transaction: { slot: 11, meta: { err: null }, transaction: ["signed-exactly", "base64"] },
    observation: latest,
  };
  return { grant, view, latest, verification };
}

test("verified state requires the exact receipt and a current projection without the grant", () => {
  const { grant, view, latest, verification } = finalized();
  expect(
    verifiedRevoke(verification, latest, view.state_version, String(grant.id), "signed-exactly"),
  ).toEqual({
    id: "c".repeat(64),
    slot: 11n,
    observationSlot: 12n,
  });
  for (const mutate of [
    (v: ObjectValue) => (v.verification_id = "invalid"),
    (v: ObjectValue) => (v.state_version = "other"),
    (v: ObjectValue) => (object(v.transaction).transaction = ["different", "base64"]),
    (v: ObjectValue) => (object(object(v.transaction).meta).err = "failed"),
    (v: ObjectValue) => (object(v.transaction).slot = 13),
    (v: ObjectValue) => (object(object(object(v.observation).snapshot).observation).origin = "fixture"),
    (v: ObjectValue) => (object(v.observation).projection = { status: "compiled", authorizations: [grant] }),
  ]) {
    const changed = structuredClone(verification) as ObjectValue;
    mutate(changed);
    expect(() =>
      verifiedRevoke(changed, latest, view.state_version, String(grant.id), "signed-exactly"),
    ).toThrow();
  }
  const currents: ObjectValue[] = [
    { ...latest, id: "other" },
    { ...latest, projection: { status: "unsupported", reason: "upgrade" } },
    { ...latest, projection: { status: "compiled", authorizations: [grant] } },
  ];
  for (const current of currents)
    expect(() =>
      verifiedRevoke(verification, current, view.state_version, String(grant.id), "signed-exactly"),
    ).toThrow();
});

test("other consoles are read from PUBLIC_NETWORKS and never include this one or a bad link", () => {
  expect(
    otherConsoles(
      "mainnet=https://console.velonsecure.xyz, devnet=https://devnet.velonsecure.xyz/",
      "mainnet",
    ),
  ).toEqual([{ network: "devnet", url: "https://devnet.velonsecure.xyz/" }]);
  expect(otherConsoles("devnet=http://localhost:3490/app", "mainnet")).toEqual([
    { network: "devnet", url: "http://localhost:3490/app" },
  ]);
  expect(otherConsoles(undefined, "mainnet")).toEqual([]);
  for (const bad of [
    "devnet=http://evil.example",
    "devnet=javascript:alert(1)",
    "testnet=https://x.example",
    "devnet=https://x.example/#a",
    "devnet=",
  ])
    expect(otherConsoles(bad, "mainnet")).toEqual([]);
});

// A cancel keeps the grant and only sets its end, an hour after the reviewed observation.
const NOW = 1_800_000_000;
function cancelInput() {
  const { grant, view, simulation } = input();
  const observation = { ...view.observation, unix_timestamp: NOW };
  const after = { ...grant, lifecycle: { kind: "active", valid_from: null, valid_until: NOW + 3600 } };
  const cancel = {
    ...simulation,
    kind: "cancel",
    observation,
    changes: [{ kind: "changed", before: grant, after }],
  };
  return { grant, view: { ...view, observation }, cancel, simulation, after };
}

test("a cancel review binds the same grant, ending after the observation, and nothing else", () => {
  const { grant, view, cancel, simulation } = cancelInput();
  const owner = fixture.signing.owner;
  expect(reviewAction(cancel, view, grant, owner, devnet, "cancel").endsAt).toBe(BigInt(NOW + 3600));
  // A revoke's simulation is never reviewed as a cancel, nor a cancel as a revoke.
  expect(() => reviewAction(simulation, view, grant, owner, devnet, "cancel")).toThrow();
  expect(() => reviewAction(cancel, view, grant, owner, devnet, "revoke")).toThrow();
  const after = (s: ObjectValue) => object(object(array(s.changes)[0]).after);
  for (const mutate of [
    (s: ObjectValue) => (object(after(s).lifecycle).valid_until = NOW),
    (s: ObjectValue) => (object(after(s).lifecycle).valid_until = null),
    (s: ObjectValue) => (object(after(s).lifecycle).kind = "revoked"),
    (s: ObjectValue) => (after(s).principal = { kind: "identity", value: "someone-else" }),
    (s: ObjectValue) => (after(s).constraints = { kind: "unlimited" }),
    (s: ObjectValue) => (object(array(s.changes)[0]).before = { ...grant, id: "other" }),
    (s: ObjectValue) => delete s.kind,
  ]) {
    const changed = structuredClone(cancel) as ObjectValue;
    mutate(changed);
    expect(() => reviewAction(changed, view, grant, owner, devnet, "cancel")).toThrow();
  }
});

test("a verified cancel keeps the grant in both readings, ending exactly as reviewed", () => {
  const { grant, view, latest, verification } = finalized();
  const { after } = cancelInput();
  const kept = { ...latest, projection: { status: "compiled", authorizations: [after] } };
  const cancelled = { ...verification, kind: "cancel", observation: kept };
  const end = BigInt(NOW + 3600);
  const verify = (v: ObjectValue, current: ObjectValue, endsAt: bigint | undefined) =>
    verifiedAction(v, current, view.state_version, String(grant.id), "signed-exactly", "cancel", endsAt);
  expect(verify(cancelled, kept, end).id).toBe("c".repeat(64));
  const later = {
    ...kept,
    projection: {
      status: "compiled",
      authorizations: [
        { ...after, lifecycle: { kind: "active", valid_from: null, valid_until: NOW + 7200 } },
      ],
    },
  };
  for (const [v, current, endsAt] of [
    [{ ...cancelled, observation: latest }, latest, end],
    [cancelled, latest, end],
    [{ ...cancelled, observation: later }, later, end],
    [{ ...cancelled, kind: undefined }, kept, end],
    [cancelled, kept, undefined],
  ] as [ObjectValue, ObjectValue, bigint | undefined][])
    expect(() => verify(v, current, endsAt)).toThrow();
  // A revoke's verification is never read as a cancel's.
  expect(() =>
    verifiedRevoke(cancelled, kept, view.state_version, String(grant.id), "signed-exactly"),
  ).toThrow();
});
