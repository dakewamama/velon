import type { Delegate } from "./tokens.ts";
import {
  array,
  integer,
  limitOf,
  mintOf,
  object,
  periodName,
  short,
  text,
  UNLIMITED,
  type Json,
  type ObjectValue,
} from "./wire.ts";

// The console's plain words for a permission. Each phrase comes from a field Velon read and
// verified; a missing fact gives a weaker phrase, never a guess.

// Earlier observations are shown without an availability; this stands in for one.
export const HISTORICAL = "historical";
export type Holder = Pick<Delegate, "kind" | "title">;
/// A token as tokenName reports it. Only a verified symbol is ever written into a sentence.
export type Token = { symbol?: string; name?: string; verified: boolean; decimals?: number };
export type Facts = {
  /// The wallet the view is for, and whether it is the connected one.
  viewer?: string;
  yours?: boolean;
  token?: Token;
  delegate?: Holder;
  now?: bigint;
  /// An earlier observation, told in the past tense.
  then?: boolean;
};
export type Status = { label: string; reason?: string };

export function decimal(units: bigint, scale: number): string {
  const base = 10n ** BigInt(scale);
  const whole = (units / base).toLocaleString("en-US");
  const fraction = (units % base).toString().padStart(scale, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

// Past 2^63 an approval is beyond any real balance, so it reads as no practical limit.
const NEAR_MAX = 2n ** 63n;
const SCALES: [number, string][] = [
  [1e18, "quintillion"],
  [1e15, "quadrillion"],
  [1e12, "trillion"],
  [1e9, "billion"],
  [1e6, "million"],
];

// One fixed UTC format, so a grant reads the same in every browser.
export function when(seconds: bigint): string | undefined {
  const date = new Date(Number(seconds) * 1000);
  if (Number.isNaN(date.getTime())) return undefined;
  return `${date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`;
}
const date = (seconds: bigint) => when(seconds) ?? "a date shown in Technical details";
const optional = (value: Json | undefined) => (value == null ? undefined : integer(value));

// The token a grant covers: its amount's asset, or the mint a permanent delegate is set on.
export function assetMint(grant: ObjectValue): string | undefined {
  const resource = object(grant.resource);
  return (
    mintOf(grant) ?? (resource.namespace === "solana:mint-token-accounts" ? text(resource.id) : undefined)
  );
}

// The approval a Subscriptions account rests on; its holder is the program's own authority.
export const subscriptionsAuthority = (grant: ObjectValue): boolean =>
  text(object(grant.native_context).protocol) === "subscriptions" &&
  object(grant.authority_kind).kind === "direct" &&
  grant.capability === "spend";

// A symbol is written only for a token in the bundled list.
const listed = (token?: Token) => (token?.verified && token.symbol) || undefined;

/// Who holds a grant. `inside` gives the form used mid-sentence; names keep their capitals.
export function who(grant: ObjectValue, facts: Facts = {}, inside = false): string {
  const phrase = holderOf(grant, facts);
  const named = subscriptionsAuthority(grant) || facts.delegate?.kind === "listed";
  return inside && !named ? phrase[0]!.toLowerCase() + phrase.slice(1) : phrase;
}

function holderOf(grant: ObjectValue, facts: Facts): string {
  if (subscriptionsAuthority(grant)) return "Solana Subscriptions";
  const principal = object(grant.principal);
  if (principal.kind === "any_of") return `Any of ${array(principal.value).length} keys`;
  if (principal.kind === "all_of") return `${array(principal.value).length} keys acting together`;
  const key = short(text(principal.value));
  const found = facts.delegate;
  switch (found?.kind) {
    case "listed":
      return found.title;
    case "wallet":
      return `Wallet ${key}`;
    case "program":
      return `Program ${key}`;
    case "owned":
      return `An account controlled by ${found.title} (${key})`;
    case "account":
      return `Program account ${key}`;
    default:
      return `Address ${key}`;
  }
}

function where(grant: ObjectValue, facts: Facts): { place: string; mine: boolean } {
  const subject = object(grant.subject);
  const resource = object(grant.resource);
  if (resource.namespace === "solana:mint-token-accounts")
    return { place: "any account that holds this token", mine: false };
  if (subject.kind !== "identity") return { place: `account ${short(text(resource.id))}`, mine: false };
  const owner = text(subject.value);
  if (owner !== facts.viewer) return { place: `an account owned by ${short(owner)}`, mine: false };
  return facts.yours ? { place: "your wallet", mine: true } : { place: "this wallet", mine: false };
}

/// An amount in the token's own units when its decimals are known, else in its smallest units.
export function amount(units: bigint, token?: Token): string {
  // Approvals set near the u64 ceiling are read in words; the exact figure stays under Details.
  if (units >= NEAR_MAX && units !== UNLIMITED) {
    const scale = token?.decimals;
    const value = Number(units) / 10 ** (scale ?? 0);
    const [size, name] = SCALES.find(([size]) => value >= size) ?? [1, ""];
    const words = `${Number((value / size).toFixed(1)).toLocaleString("en-US")}${name ? ` ${name}` : ""}`;
    return `${words} ${scale === undefined ? "of this token's smallest units" : (listed(token) ?? "of this token")} (no practical limit)`;
  }
  if (token?.decimals === undefined) return `${units.toLocaleString("en-US")} of this token's smallest units`;
  return `${decimal(units, token.decimals)} ${listed(token) ?? "of this token"}`;
}

// Extra rules are spelled out only when they all pay one recipient; anything else is pointed to.
function rules(grant: ObjectValue): string {
  const others = array(object(grant.constraints).value)
    .map(object)
    .filter((leaf) => leaf.kind === "constraint" && object(leaf.value).kind !== "amount_at_most")
    .map((leaf) => object(leaf.value));
  if (!others.length) return "";
  const paid = new Set(
    others.map((rule) =>
      rule.kind === "recipient" && object(rule.principal).kind === "identity"
        ? text(object(rule.principal).value)
        : "",
    ),
  );
  const [only] = paid;
  return paid.size === 1 && only
    ? `, paid only to ${short(only)}`
    : ", under other rules listed in Technical details";
}

const tense = (then = false) =>
  then ? (["could", "was", "had", "didn't"] as const) : (["can", "is", "has", "don't"] as const);

// The lifecycle and rules, read before any branch so no grant Velon read as unusable says it can act.
function standing(grant: ObjectValue, now?: bigint) {
  const lifecycle = object(grant.lifecycle);
  const from = optional(lifecycle.valid_from);
  const until = optional(lifecycle.valid_until);
  return {
    over: lifecycle.kind === "revoked" || (until !== undefined && now !== undefined && until <= now),
    held: lifecycle.kind === "suspended",
    barred: object(grant.constraints).kind === "false",
    starting: from !== undefined && now !== undefined && from > now ? `, starting ${date(from)}` : "",
    ending: until === undefined ? "" : ` until ${date(until)}`,
  };
}
type Standing = ReturnType<typeof standing>;

function power(grant: ObjectValue, holder: string, state: Standing, then = false): string {
  const [can, is, has, dont] = tense(then);
  const owns = then ? "owned" : "owns";
  const resource = object(grant.resource);
  const account = `account ${short(text(resource.id))}`;
  const plan =
    grant.capability === "modify_authority" &&
    text(object(grant.native_context).protocol) === "subscriptions" &&
    resource.namespace === "solana:authority-set";
  const act = plan
    ? "change who is allowed to charge through this subscription plan"
    : grant.capability === "modify_authority"
      ? `change who is allowed to act on ${account}`
      : grant.capability === "revoke_authority"
        ? `remove permissions on ${account}`
        : grant.capability === "close"
          ? `close ${account} and collect the SOL it holds`
          : undefined;
  const right = act
    ? `permission to ${act}`
    : `the "${text(grant.capability).replaceAll("_", " ")}" permission on ${account}`;
  if (state.over) return `${holder} no longer ${has} ${right}.`;
  if (state.held && plan)
    return `${holder} ${owns} this subscription plan, but changing who is allowed to charge through it ${is} on hold.`;
  if (state.held) return `${holder} ${has} ${right}, but it ${is} on hold.`;
  if (state.barred) return `${holder} ${has} ${right}, but its rules ${dont} allow any use.`;
  if (plan)
    return `${holder} ${owns} this subscription plan and ${can} change who is allowed to charge through it${state.starting}.`;
  return `${holder} ${act ? `${can} ${act}` : `${has} ${right}`}${state.starting}.`;
}

/// The one sentence a card leads with.
export function sentence(grant: ObjectValue, facts: Facts = {}): string {
  const [can, is, has, dont] = tense(facts.then);
  const holder = who(grant, facts);
  const state = standing(grant, facts.now);
  if (grant.capability !== "spend") return power(grant, holder, state, facts.then);
  const symbol = listed(facts.token);
  const { place, mine } = where(grant, facts);
  const limit = limitOf(grant);
  const usage = object(grant.usage);
  const recurring = usage.kind === "recurring";
  // Never "cancelled": a fixed delegation carries an end time from the start.
  if (state.over)
    return recurring
      ? `This subscription ${has} ended and ${can} no longer charge ${place}.`
      : `This approval ${has} ended and ${can} no longer take from ${place}.`;
  if (state.barred) return `${holder} ${is} approved on ${place}, but its rules ${dont} allow any use.`;
  if (usage.kind === "cumulative" && usage.remaining != null && integer(usage.remaining) === 0n)
    return `${holder} ${is} still approved on ${place} but ${has} nothing left to take.`;
  const unlimited = limit?.amount === UNLIMITED;
  const allowed = unlimited
    ? `any amount of ${symbol ?? "this token"}`
    : limit && `up to ${amount(limit.amount, facts.token)}`;
  const span = recurring
    ? ` every ${periodName(integer(usage.period_seconds))}`
    : usage.kind === "cumulative" && !unlimited && limit !== undefined && limit.amount < NEAR_MAX
      ? " in total"
      : "";
  const wide = object(grant.resource).namespace === "solana:mint-token-accounts";
  const act = wide
    ? `move ${symbol ?? "this token"} out of any account that holds it`
    : limit
      ? `${recurring ? "charge" : "take"} ${allowed}${span} from ${place}`
      : `take tokens from ${place} under rules listed in Technical details`;
  if (state.held) return `${holder} ${is} approved to ${act}, but it ${is} on hold.`;
  // The program enforces it on every account of the mint, so no holder signature can clear it.
  if (wide)
    return `${holder} ${can} ${act}${state.starting}. It ${is} set on the token itself, so holders ${facts.then ? "couldn't" : "can't"} remove it.`;
  if (!limit) return `${holder} ${can} ${act}${state.starting}.`;
  // The approval exists whether or not a subscription does, so its role is told, not its use.
  if (subscriptionsAuthority(grant))
    return `${holder} ${can} take ${allowed} from ${place}${state.starting}; it ${facts.then ? "used" : "uses"} this approval to collect payments for any subscription on this account.`;
  const asks =
    object(grant.authority_kind).kind === "direct"
      ? `${unlimited ? ", now and later," : ""} without asking ${mine ? "you " : ""}again`
      : "";
  return `${holder} ${can} ${act}${state.starting}${state.ending}${limit.more ? rules(grant) : ""}${asks}.`;
}

/// The "How much" cell of a wallet row. The token cell names the token, so a number stands alone
/// unless the token is listed; an unknown scale is said to be in smallest units.
export function allowance(grant: ObjectValue, token?: Token): string {
  const limit = limitOf(grant);
  if (!limit) return "Set by rules, see details";
  const usage = object(grant.usage);
  if (usage.kind === "cumulative" && usage.remaining != null && integer(usage.remaining) === 0n)
    return "Nothing left";
  if (limit.amount === UNLIMITED) return "No limit";
  if (limit.amount >= NEAR_MAX) return "No practical limit";
  const units =
    token?.decimals === undefined
      ? `${limit.amount.toLocaleString("en-US")} smallest units`
      : `${decimal(limit.amount, token.decimals)}${listed(token) ? ` ${listed(token)}` : ""}`;
  return usage.kind === "recurring"
    ? `Up to ${units} every ${periodName(integer(usage.period_seconds))}`
    : `Up to ${units}`;
}

// Mirrors the runtime's availability_at order, so the reason matches why it said so.
function inactive(grant: ObjectValue, now?: bigint): Status {
  const lifecycle = object(grant.lifecycle);
  if (lifecycle.kind === "revoked") return { label: "Ended", reason: "It has ended." };
  if (lifecycle.kind === "suspended")
    return { label: "On hold", reason: "It is on hold, so it can't be used right now." };
  const from = optional(lifecycle.valid_from);
  const until = optional(lifecycle.valid_until);
  if (now !== undefined && from !== undefined && now < from)
    return { label: "Not started", reason: `It starts on ${date(from)}.` };
  if (now !== undefined && until !== undefined && now >= until)
    return { label: "Ended", reason: `It ended on ${date(until)}.` };
  if (object(grant.constraints).kind === "false")
    return { label: "Not usable now", reason: "Its rules don't allow any use." };
  const usage = object(grant.usage);
  const spent = usage.remaining != null && integer(usage.remaining) === 0n;
  if ((usage.kind === "cumulative" && spent) || (usage.kind === "one_shot" && usage.consumed === true))
    return { label: "Used up", reason: "Nothing is left to take." };
  if (usage.kind === "recurring" && spent)
    return { label: "Used up for now", reason: "Nothing is left for this period." };
  return { label: "Not usable now" };
}

function unknown(grant: ObjectValue, now?: bigint): Status {
  const label = "Not confirmed";
  if (object(grant.lifecycle).kind === "unknown")
    return { label, reason: "Velon couldn't tell whether it has started or ended." };
  const usage = object(grant.usage);
  if (usage.kind === "recurring" && now !== undefined) {
    const start = integer(usage.observed_period_start);
    if (now >= start + integer(usage.period_seconds))
      return {
        label,
        reason: "Velon's reading is from an earlier period, so it can't say how much is left now.",
      };
    if (now < start)
      return {
        label,
        reason: "Velon's reading is for a later period, so it can't say how much is left now.",
      };
  }
  if (
    (["cumulative", "recurring"].includes(text(usage.kind)) && usage.remaining === null) ||
    (usage.kind === "one_shot" && usage.consumed === null)
  )
    return { label, reason: "Velon couldn't read how much is left." };
  if (grant.observability !== "exact")
    return { label, reason: "Velon can see who holds this, but not every rule the program applies." };
  if (object(grant.authority_kind).kind === "derived")
    return {
      label,
      reason: "It works through another approval on this account, so Velon doesn't confirm it on its own.",
    };
  return { label, reason: "Velon can't confirm it is usable right now." };
}

/// The chip is the runtime's evaluation in plain words; only a conditional grant reads as in force.
export function status(grant: ObjectValue, availability: string, now?: bigint): Status {
  switch (availability) {
    case "conditional":
      return { label: "In force" };
    case "inactive":
      return inactive(grant, now);
    case "unknown":
      return unknown(grant, now);
    case HISTORICAL:
      return {
        label: "Earlier state",
        reason: "This is an earlier reading, so Velon doesn't say whether it was usable then.",
      };
    default:
      return { label: availability };
  }
}

/// An approval as the RPC listed it, for a row Velon could not verify. It stays attributed.
export function reported(entry: {
  by?: string;
  delegate: string;
  ui: string;
  unlimited: boolean;
  where: string;
  token?: Token;
}): string {
  const symbol = listed(entry.token);
  const allowed = entry.unlimited
    ? `any amount of ${symbol ?? "this token"}`
    : `up to ${entry.ui} ${symbol ?? "of this token"}`;
  return `${entry.by ?? "The network"} reports that address ${short(entry.delegate)} can take ${allowed} from ${entry.where}.`;
}

// Why an observed approval is shown without Remove access. Velon never offers what it cannot prove.
export const UNVERIFIED: Record<string, string> = {
  UnsupportedVersion:
    "Velon hasn't verified the version of the token program this account uses, so it won't prepare a removal. This is what the network reports.",
  UnsupportedOperation:
    "This approval uses something Velon can't check exactly yet, such as a token extension that changes how transfers work or a delegate that needs several signatures. This is what the network reports.",
  default:
    "Velon couldn't verify this approval, so it can't remove it here. This is what the network reports.",
};

export const GLOSSARY: [string, string][] = [
  [
    "Approval",
    "Permission for an app or address to take one of your tokens without asking you each time, up to a limit or with none. Solana calls the holder a delegate.",
  ],
  [
    "Token account",
    "Solana keeps each token you hold in its own account that belongs to your wallet. An approval sits on one of these accounts, so it covers one token.",
  ],
  [
    "Subscription",
    "An approval through Solana Subscriptions that lets someone charge a set amount on a schedule until it ends.",
  ],
  [
    "Remove access",
    "A transaction you sign that clears an approval. Velon tries it against the chain first, you approve it in your wallet, and Velon reads the chain again to prove it is gone. Other tools call this revoking.",
  ],
  [
    "In force",
    "The approval can be used now, within its limits. It doesn't promise that any one transfer will succeed.",
  ],
  ["Not confirmed", "Velon read the approval but can't confirm it is usable right now. The card says why."],
  [
    "Smallest units",
    "A token's amount before its decimal point is placed. Velon shows these when it couldn't read how many decimals the token uses.",
  ],
  [
    "Not verified",
    "Velon read this from the network but couldn't check it exactly, so it shows it without offering to remove it.",
  ],
  [
    "Unverified name",
    "A name or logo the token's creator chose. Anyone can choose any name, so Velon marks it.",
  ],
];

/// A plan's terms as the plan account holds them.
export type PlanTerms = {
  amount: bigint;
  periodHours: bigint;
  endTs: bigint;
  destinations: string[];
};

/// What subscribing to a plan lets it charge, in one sentence.
export function planSentence(terms: PlanTerms, token?: Token): string {
  const until = terms.endTs === 0n ? "" : `, until ${date(terms.endTs)}`;
  const paid = terms.destinations.length
    ? `, paid only to ${terms.destinations.map((key) => short(key)).join(" or ")}`
    : "";
  return `Subscribing lets this plan charge up to ${amount(terms.amount, token)} every ${periodName(terms.periodHours * 3_600n)} from your wallet${until}${paid}.`;
}

/// Why a wallet shows the first subscribe as able to take any amount, and what limits it.
export function planApproval(terms: PlanTerms, token?: Token): string[] {
  const name = listed(token) ?? "this token";
  return [
    `The first time you subscribe with ${name}, your wallet is asked to approve Solana Subscriptions on your ${name} account. That approval carries no amount, so wallets show it as able to take any amount.`,
    `The program only moves ${name} through it for subscriptions and delegations you signed, each within its own terms. For this plan that is up to ${amount(terms.amount, token)} every ${periodName(terms.periodHours * 3_600n)}.`,
  ];
}

/// What the merchant can still change once you subscribe; the program fixes the rest.
export function planChanges(terms: PlanTerms): string {
  return terms.destinations.length
    ? "The price and period are fixed, and so is where payments go. The merchant can change who may charge, the end date, and whether the plan takes new subscribers."
    : "The price and period are fixed. The plan doesn't limit where payments go, and the merchant can change who may charge, the end date, and whether the plan takes new subscribers.";
}

/// The name a merchant gave its plan, if its metadata is the `{"n": name}` form the Foundation's
/// app writes. It is the merchant's own word, so it is always shown as unverified.
export function planName(metadata: string): string | undefined {
  try {
    const value: unknown = JSON.parse(metadata);
    const name = value && typeof value === "object" ? (value as Record<string, unknown>).n : undefined;
    return typeof name === "string" && name.trim() && name.length <= 64 ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

/// What an approval could take from its account right now, set against what the account holds.
/// Balances are the RPC's display figures; the approval itself is the verified fact.
export function exposure(limit: bigint | undefined, balance: bigint, token?: Token): string {
  if (balance === 0n) return "None of it is here now";
  if (limit === undefined) return `${amount(balance, token)} here now`;
  if (limit >= NEAR_MAX) return `All ${amount(balance, token)} here now, and anything sent later`;
  if (limit >= balance) return `All ${amount(balance, token)} here now`;
  return `${amount(limit, token)} of the ${amount(balance, token)} here now`;
}

/// Where a wallet check left things, as counts the next steps are chosen from.
export interface WalletState {
  total: number;
  /// Approvals the owner can remove here, now or once the wallet is connected.
  removable: number;
  unlimitedRemovable: number;
  /// Shown as the network reports them; Velon can't remove these yet.
  reported: number;
  /// Subscriptions still running, which the program lets no one remove yet.
  running: number;
  connected: boolean;
  owner: boolean;
  mainnet: boolean;
  unread: boolean;
}

/// What to do after a wallet check, most useful first and never more than three.
export function nextSteps(state: WalletState): string[] {
  const steps: string[] = [];
  if (state.unread)
    steps.push("Check again. Velon couldn't read everything this time, and a second look usually can.");
  if (state.removable && !state.connected)
    steps.push(
      "Connect this wallet. Velon only ever asks it to sign removals, and a removal moves no tokens.",
      `Remove the ones you don't use${state.unlimitedRemovable ? `, starting with the ${state.unlimitedRemovable === 1 ? "one" : state.unlimitedRemovable} with no limit` : ""}. Each is one signature${state.mainnet ? " and about 0.000015 SOL in fees" : ""}.`,
    );
  else if (state.removable && !state.owner)
    steps.push(
      "Only this wallet's owner can remove these. Send them this page's link, or connect the owner's wallet.",
    );
  else if (state.removable)
    steps.push(
      state.unlimitedRemovable > 1
        ? `Review the ${state.unlimitedRemovable} with no limit, one at a time. You confirm each one in your wallet, and Cancel keeps it.`
        : "Choose Remove access on one you don't use. You confirm it in your wallet, and Cancel keeps it.",
    );
  if (state.removable && (!state.connected || state.owner))
    steps.push(
      "After each removal is final, Velon reads the chain again to prove it and keeps a receipt in this browser.",
    );
  if (state.running)
    steps.push(
      "Velon can't remove a subscription or payment approval that is still running. A subscription can be removed here once it is cancelled and its paid period has ended.",
    );
  if (state.reported)
    steps.push(
      `Velon can't remove ${state.reported === 1 ? "the one" : `the ${state.reported}`} shown as the network reports yet. Details shows who holds ${state.reported === 1 ? "it" : "each one"}.`,
    );
  if (!state.total && !state.unread)
    steps.push("Nothing to do. Check again after you approve a new app, or check another wallet.");
  return steps.slice(0, 3);
}
