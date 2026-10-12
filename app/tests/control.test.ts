import { expect, test } from "bun:test";
import { DEVNET_GENESIS, reviewRevoke, verifiedRevoke } from "../src/control.ts";
import { object, type ObjectValue } from "../src/wire.ts";
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
  const elsewhere = { ...devnet, cluster: "another-genesis", network: "localnet" } as const;
  expect(() => reviewRevoke(simulation, view, grant, fixture.signing.owner, elsewhere)).toThrow();
  for (const mutate of [
    (s: ObjectValue) => (s.state_version = "different"),
    (s: ObjectValue) => (object(s.observation).origin = "fixture"),
    (s: ObjectValue) => (object(s.observation).cluster = "wrong-chain"),
    (s: ObjectValue) => (object(s.observation).slot = 11),
    (s: ObjectValue) => (s.changes = []),
    (s: ObjectValue) => (object(object(s.response).value).err = "failed"),
    (s: ObjectValue) => (object(object(s.response).context).slot = 11),
    (s: ObjectValue) =>
      (object(object(object(s.response).value).replacementBlockhash).blockhash = "different"),
  ]) {
    const changed = structuredClone(simulation) as ObjectValue;
    mutate(changed);
    expect(() => reviewRevoke(changed, view, grant, fixture.signing.owner, devnet)).toThrow();
  }
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
