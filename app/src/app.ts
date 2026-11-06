import { createSolanaRpc } from "@solana/rpc";
import { signAndSubmitReviewedTransaction } from "catalyst-sdk/src/submit";
import {
  action,
  otherConsoles,
  result,
  reviewRevoke,
  verifiedRevoke,
  type Control,
  type ActionState,
} from "./control.ts";
import {
  forget,
  PHONE_WALLET,
  registerPhoneWallets,
  wallets,
  signingWallets,
  testWallet,
  type SigningWallet,
} from "./wallet.ts";
import { connectFailure, deviceOf, INSTALL, openInWallet } from "./reach.ts";
import velonIcon from "./assets/velon-192.png";
import { address as toAddress, isAddress } from "@solana/addresses";
import {
  appendTransactionMessageInstruction,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/transaction-messages";
import {
  compileTransaction,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
} from "@solana/transactions";
import { avatar, icon, solana, type IconName } from "./icons.ts";
import {
  button as act,
  forgetChecks,
  nextPanel,
  progress as checkingCard,
  recentChecks,
  rememberCheck,
  tip,
  type Progress,
} from "./flow.ts";
import {
  PROGRAMS,
  TOKENS,
  describeDelegate,
  nameTokens,
  rpcHeaders,
  tokenLogo,
  tokenName,
  type Delegate,
} from "./tokens.ts";
import {
  assetMint,
  decimal,
  GLOSSARY,
  HISTORICAL,
  reported as networkReport,
  sentence,
  status as rate,
  allowance as allowanceCell,
  exposure,
  nextSteps,
  planApproval,
  planChanges,
  planName,
  planSentence,
  amount as quantity,
  when,
  subscriptionsAuthority,
  UNVERIFIED,
  who,
  type Facts,
  type Status,
} from "./plain.ts";
import {
  call,
  array,
  authorization,
  compare,
  grants,
  integer,
  object,
  mintOf,
  permissionLabel,
  principalLabel,
  publicKey,
  readJson,
  KINDS,
  limitOf,
  semantic,
  short,
  system,
  text,
  UNLIMITED,
  writeJson,
  type Json,
  type ObjectValue,
} from "./wire.ts";

type Scenario = {
  name: string;
  scope: string;
  live: boolean;
  snapshots: { id: string; slot: string }[];
  examples: { label: string; address: string }[];
};
// The account each live scope was observed for, so another address is never read from it.
const observedFor = new WeakMap<Scenario, string>();
const form = document.querySelector<HTMLFormElement>("#scan-form")!;
const input = document.querySelector<HTMLInputElement>("#address")!;
const select = document.querySelector<HTMLSelectElement>("#scenario")!;
const scanButton = document.querySelector<HTMLButtonElement>("#scan")!;
const results = document.querySelector<HTMLElement>("#results")!;
const diff = document.querySelector<HTMLElement>("#diff")!;
const notice = document.querySelector<HTMLElement>("#notice")!;
let scenarios: Scenario[] = [];
let request: AbortController | undefined;
let mode: "scan" | "diff" = "scan";

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  content = "",
  className = "",
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  result.textContent = content;
  result.className = className;
  return result;
}

async function get(path: string, signal?: AbortSignal): Promise<Json> {
  const response = await call(`/api/${path}`, { signal });
  if (!response.ok) {
    if (response.status === 409)
      throw new Error("Conflicting observations at the same slot. No current permission can be shown.");
    if (response.status === 404) throw new Error("No observation is available for this scope.");
    throw new Error("The observation provider is unavailable. Try scanning again.");
  }
  return readJson(await response.text());
}

function status(message: string, error = false) {
  notice.replaceChildren(node("p", message, error ? "error" : "notice"));
}

function raw(title: string, value: Json): HTMLDetailsElement {
  const section = node("details");
  section.append(node("summary", title), node("pre", writeJson(value, 2)));
  return section;
}

function field(title: string, value: string): HTMLElement {
  const row = node("div", "", "field");
  row.append(node("dt", title), node("dd", value));
  return row;
}

// Announces a copy to screen readers; the icon swap alone is silent.
const copied = node("span", "", "visually-hidden");
copied.setAttribute("role", "status");
document.body.append(copied);

// An address with its avatar and a copy button; the full key stays selectable.
function address(title: string, value: string, noun = title.toLowerCase()): HTMLElement {
  const row = field(title, "");
  const cell = row.querySelector("dd")!;
  cell.classList.add("address-cell");
  const copy = node("button", "", "icon-button");
  copy.type = "button";
  copy.title = "Copy address";
  copy.setAttribute("aria-label", `Copy ${noun} address`);
  copy.append(icon("copy"));
  const shown = node("span", value, "mono");
  copy.onclick = async () => {
    const done = await navigator.clipboard?.writeText(value).then(
      () => true,
      () => false,
    );
    // Without clipboard access the address is selected instead, ready for the keyboard.
    if (!done) getSelection()?.selectAllChildren(shown);
    copied.textContent = done ? "Address copied" : "Address selected. Press Ctrl+C to copy it.";
    tip(copy, done ? "Copied" : "Selected. Press Ctrl+C");
    copy.replaceChildren(icon(done ? "check" : "copy"));
    setTimeout(() => copy.replaceChildren(icon("copy")), 1200);
  };
  cell.append(avatar(value), shown, copy);
  return row;
}

// A button or link that leads with its icon.
function labelled<T extends HTMLElement>(element: T, name: IconName): T {
  element.prepend(icon(name));
  return element;
}

// The header names the network, with Solana's mark whenever a real cluster is behind it. Where
// another network has its own console, the name is a menu that opens it with the same wallet.
const NETWORK_NOTE = { mainnet: "Real wallets and funds", devnet: "Test tokens, for builders" } as const;
function badge(label: string, chain = true) {
  const target = document.querySelector<HTMLElement>(".header-links .badge")!;
  const mark = chain && control ? [solana()] : [];
  const others = chain ? (control?.elsewhere ?? []) : [];
  const name = node("span", label, "network-name");
  target.title = "";
  if (!others.length || !control || control.network === "localnet") {
    target.replaceChildren(...mark, name);
    target.title = mark.length ? `Velon reads Solana ${label.toLowerCase()}` : "";
    return;
  }
  const button = node("button", "", "network");
  button.type = "button";
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-label", `Network: ${label}. Switch network`);
  button.append(...mark, name, icon("chevron"));
  const menu = node("div", "", "network-menu");
  menu.hidden = true;
  const here = node("div", "", "network-option current");
  here.append(node("strong", label), node("span", NETWORK_NOTE[control.network]), icon("check"));
  menu.append(here);
  for (const other of others) {
    const option = node("a", "", "network-option");
    option.href = other.url;
    // The wallet on screen comes along: an address is the same on every network.
    option.onclick = () => (option.href = `${other.url}${location.hash}`);
    option.append(node("strong", NETWORKS[other.network].label), node("span", NETWORK_NOTE[other.network]));
    menu.append(option);
  }
  button.onclick = () => openNetworks(menu.hidden === true);
  target.replaceChildren(button, menu);
}
function openNetworks(open: boolean) {
  const menu = document.querySelector<HTMLElement>(".network-menu");
  if (!menu) return;
  menu.hidden = !open;
  document.querySelector(".network")?.setAttribute("aria-expanded", String(open));
}
addEventListener("click", (event) => {
  if (!(event.target as Element).closest?.(".header-links .badge")) openNetworks(false);
});
addEventListener("keydown", (event) => (event as KeyboardEvent).key === "Escape" && openNetworks(false));

// What was read, in one plain line; the slot, origin and provenance wait under Technical details.
// A wallet keeps its caveat whatever the view's coverage says: the view covers one account.
function metadata(view: ObjectValue, wallet?: { read: number; listed: number }): HTMLElement {
  const observation = object(view.observation);
  const coverage = object(view.coverage);
  const block = node("section", "", "state-meta");
  const checked =
    wallet && wallet.read < wallet.listed
      ? `Velon checked ${wallet.read} of the ${wallet.listed} token approvals and Solana Subscriptions the network lists for this wallet.`
      : "Velon checked the token approvals and Solana Subscriptions the network lists for this wallet.";
  block.append(
    node(
      "p",
      wallet
        ? `${checked} Other kinds of permission aren't read yet, so an empty list isn't an all-clear.`
        : coverage.complete === true
          ? "Velon read everything this view covers."
          : "Velon read only this account. Other permissions may exist elsewhere, so an empty list isn't an all-clear.",
      "coverage-note",
    ),
  );
  const provenance = raw("Technical details", {
    state_version: view.state_version!,
    observation,
    coverage,
    versions: view.versions!,
    sdk_revision: view.sdk_revision!,
    arm_schema_version: view.arm_schema_version!,
  });
  provenance.className = "provenance";
  provenance
    .querySelector("summary")!
    .after(
      node(
        "p",
        `${text(observation.origin)} evidence · slot ${integer(observation.slot)} · ${coverage.complete === true ? "Reported complete coverage" : "Partial coverage"}`,
        "eyebrow",
      ),
    );
  block.append(provenance);
  return block;
}

// The words the cards use, explained once per list.
function glossary(): HTMLElement {
  const block = node("details", "", "glossary");
  const terms = node("dl");
  for (const [term, meaning] of GLOSSARY) {
    const row = node("div");
    row.append(node("dt", term), node("dd", meaning));
    terms.append(row);
  }
  block.append(node("summary", "What these words mean"), terms);
  return block;
}

// The specialist's view of one permission. Addresses are built with the card so full keys stay
// searchable; the raw evidence is built when the panel first opens. In a wallet's list the plain
// facts come first and this record folds beneath them.
function technical(grant: ObjectValue, availability: string, rating: Status, list = false): HTMLElement {
  const panel = node("section", "", "detail technical");
  panel.hidden = true;
  if (list) {
    const record = node("details", "", "record");
    record.append(node("summary", "Technical record"), technicalFacts(grant, availability, rating));
    panel.append(plainFacts(grant), record);
    return panel;
  }
  panel.append(technicalFacts(grant, availability, rating));
  return panel;
}

// What a person needs about one permission: who, how much is left, when it renews or ends, and
// where it draws from.
function plainFacts(grant: ObjectValue): HTMLElement {
  const source = text(object(grant.resource).id);
  const mint = assetMint(grant);
  const usage = object(grant.usage);
  const lifecycle = object(grant.lifecycle);
  const principal = object(grant.principal);
  const facts = node("dl", "", "plain-facts");
  facts.append(
    principal.kind === "identity"
      ? address("Who can take it", text(principal.value), "holder")
      : field("Who can take it", principalLabel(grant.principal)),
  );
  if (usage.remaining !== undefined && usage.remaining !== null)
    facts.append(
      field(
        usage.kind === "recurring" ? "Left this period" : "Left to take",
        integer(usage.remaining) === UNLIMITED
          ? "Every token this account will ever hold"
          : (tokens(integer(usage.remaining), source, mint) ??
              allowance(source, integer(usage.remaining), mint)),
      ),
    );
  if (usage.kind === "recurring" && usage.observed_period_start != null && usage.period_seconds != null)
    facts.append(
      field(
        "Next period starts",
        when(integer(usage.observed_period_start) + integer(usage.period_seconds)) ?? "Unknown",
      ),
    );
  if (lifecycle.kind === "active")
    facts.append(
      field(
        "Ends",
        lifecycle.valid_until == null ? "No end date" : (when(integer(lifecycle.valid_until)) ?? "Unknown"),
      ),
    );
  facts.append(
    object(grant.resource).namespace === "solana:token-account"
      ? address("Draws from", source, "token account")
      : address("Applies to", source, "account"),
  );
  if (mint && mint !== source) facts.append(address("Token", mint));
  return facts;
}

function technicalFacts(grant: ObjectValue, availability: string, rating: Status): HTMLElement {
  const source = text(object(grant.resource).id);
  const mint = assetMint(grant);
  const usage = object(grant.usage);
  const kind = text(object(grant.authority_kind).kind);
  const facts = node("dl");
  facts.append(
    field("Exact terms", permissionLabel(grant)),
    field(
      "Runtime status",
      availability === HISTORICAL
        ? "Not evaluated for an earlier reading"
        : `${rating.label === availability ? availability : `${rating.label} (${availability})`}${rating.reason ? `. ${rating.reason}` : ""}`,
    ),
    field("Kind", KINDS[kind] ?? kind),
  );
  if (usage.remaining !== undefined)
    facts.append(
      field(
        "Left when Velon read it",
        usage.remaining === null ? "Unknown" : allowance(source, integer(usage.remaining), mint),
      ),
    );
  const holder = object(grant.subject);
  if (holder.kind === "identity") facts.append(address("Owner", text(holder.value)));
  const principal = object(grant.principal);
  facts.append(
    principal.kind === "identity"
      ? address("Who", text(principal.value), "holder")
      : field("Who", principalLabel(grant.principal)),
    object(grant.resource).namespace === "solana:token-account"
      ? address("Token account", source)
      : address("Applies to", source, "account"),
  );
  if (mint && mint !== source) facts.append(address("Token", mint));
  facts.append(field("Program", system(grant)));
  return facts;
}

function evidence(grant: ObjectValue): HTMLElement[] {
  const facts = node("dl", "", "facts");
  facts.append(
    field("Enforcement", text(grant.enforcement)),
    field("Observability", text(grant.observability)),
    field("Lifecycle", text(object(grant.lifecycle).kind)),
    field("Usage", text(object(grant.usage).kind)),
  );
  const parts: HTMLElement[] = [facts];
  if (object(grant.principal).kind !== "identity")
    parts.push(
      node(
        "p",
        "These principals share one permission and one allowance. The budget is not duplicated for each signer.",
        "notice",
      ),
    );
  if (object(grant.authority_kind).kind === "derived")
    parts.push(
      node(
        "p",
        "This authority depends on its parent grant. Generic availability remains unknown until those dependencies are resolved.",
        "notice",
      ),
    );
  parts.push(
    raw("Full constraints and lineage", {
      constraints: grant.constraints!,
      authority_kind: grant.authority_kind!,
      usage: grant.usage!,
    }),
    raw("Native context and evidence", { native_context: grant.native_context!, evidence: grant.evidence! }),
    raw("Exact ARM authorization", grant),
  );
  return parts;
}

// One card's technical details are open at a time. Only card toggles are closed here, so the
// holdings panel keeps its own state.
function toggleDetail(button: HTMLButtonElement, panel: HTMLElement, grant?: ObjectValue) {
  const open = button.getAttribute("aria-expanded") === "true";
  for (const other of results.querySelectorAll<HTMLButtonElement>(".permission-actions [aria-expanded]")) {
    other.setAttribute("aria-expanded", "false");
    document.getElementById(other.getAttribute("aria-controls") ?? "")?.setAttribute("hidden", "");
  }
  if (open) return;
  if (grant && !panel.dataset.built) {
    (panel.querySelector(".record") ?? panel).append(...evidence(grant));
    panel.dataset.built = "true";
  }
  button.setAttribute("aria-expanded", "true");
  panel.hidden = false;
}

function summary(permissions: { grant: ObjectValue }[], view: ObjectValue): HTMLElement {
  const count = (matches: (grant: ObjectValue) => boolean) =>
    String(permissions.filter(({ grant }) => matches(grant)).length);
  const block = node("div", "", "summary");
  for (const [value, label] of [
    [String(permissions.length), "Permissions found"],
    [count((grant) => object(grant.usage).kind === "recurring"), "Repeat on a schedule"],
    [count((grant) => object(grant.authority_kind).kind === "administrative"), "Can change the rules"],
    [object(view.coverage).complete === true ? "Complete" : "Partial", "How much was read"],
  ] as const) {
    const tile = node("div");
    tile.append(node("strong", value), node("span", label));
    block.append(tile);
  }
  return block;
}

// Revokes the visitor asked to review in a row. Each still gets its own review and signature.
let queue: (() => void)[] = [];
const revocable = new WeakMap<HTMLElement, () => void>();

// The wallet a view is for: the connected one, or a pasted wallet that cannot sign here.
type Viewer = { address?: string; yours: boolean };
// What each delegate key turned out to be once the chain was asked. Display only.
const holders = new Map<string, Delegate>();

// What a sentence may draw on. plain.ts writes a token's symbol only when it is a listed one.
function factsFor(grant: ObjectValue, view: ObjectValue, viewer: Viewer): Facts {
  const mint = assetMint(grant);
  const principal = object(grant.principal);
  const key = principal.kind === "identity" ? text(principal.value) : "";
  const now = object(view.observation).unix_timestamp;
  return {
    viewer: viewer.address,
    yours: viewer.yours,
    token: mint
      ? {
          ...tokenName(mint),
          decimals: TOKENS[mint]?.decimals ?? decimals.get(text(object(grant.resource).id)),
        }
      : undefined,
    delegate: holders.get(key) ?? (PROGRAMS[key] ? { kind: "listed", title: PROGRAMS[key]! } : undefined),
    now: now == null ? undefined : integer(now),
  };
}

// What each token account holds, as the RPC reports it. Display only: it sets an approval against
// the balance it could take, never decides what is verified.
const balances = new Map<string, { amount: bigint; decimals: number }>();

// Plan names from the wallet listing, keyed by subscription. The merchant chose them; display only.
const planNames = new Map<string, string>();
// Each Subscriptions delegation's kind, from the wallet's listing: a fixed or recurring payment
// approval can be removed by its owner at any time; a subscription only once it has ended.
const delegationKinds = new Map<string, string>();
const paymentApproval = (grant: ObjectValue) =>
  ["fixed", "recurring"].includes(delegationKinds.get(revokeKey(grant) ?? "") ?? "");

// Numbers each card so its buttons can point at its own sentence and token.
let cardCount = 0;

// The token a card covers. A creator can name a token anything, including a link; only listed
// tokens are verified, so any other name carries the mark.
function tokenChip(mint: string | undefined, id: string): HTMLElement {
  const asset = node("span", "", "token");
  asset.id = id;
  if (!mint) return asset;
  const label = tokenName(mint);
  asset.append(tokenLogo(mint), node("span", label.symbol ?? label.name ?? `Token ${short(mint)}`));
  if (!label.verified && (label.symbol || label.name)) asset.append(node("span", "unverified", "unverified"));
  asset.title = `${label.name ?? "Token"}${label.verified ? "" : " (name set by its creator, not verified)"}: ${mint}`;
  return asset;
}

// The face says who can do what, in one sentence, with one status and one action. In a wallet's
// list it is one row: token, holder and amount, with the sentence as its name and under Details.
function card(
  grant: ObjectValue,
  view: ObjectValue,
  availability: string,
  scope?: string,
  viewer: Viewer = { address: connected?.account.address, yours: true },
  list = false,
): HTMLElement {
  const row = node("article", "", list ? "permission compact" : "permission");
  row.dataset.id = text(grant.id);
  const actor = object(grant.principal);
  row.dataset.who = actor.kind === "identity" ? short(text(actor.value)) : "several keys";
  const left = object(grant.usage).remaining;
  row.dataset.amount = left == null ? "" : compact(integer(left));
  row.dataset.system = text(object(grant.native_context).protocol);
  if (paymentApproval(grant)) row.dataset.payment = "";
  const source = text(object(grant.resource).id);
  row.dataset.source = source;
  const rowMint = assetMint(grant);
  row.dataset.mint = rowMint ?? "";
  if (rowMint && TOKENS[rowMint]) row.dataset.listed = "true";
  const rowLimit = limitOf(grant);
  if (rowLimit) row.dataset.limit = String(rowLimit.amount);
  row.classList.toggle("unlimited", left != null && integer(left) === UNLIMITED);
  const known = { ...factsFor(grant, view, viewer), then: availability === HISTORICAL };
  const rating = rate(grant, availability, known.now);
  const header = node("div", "", "permission-header");
  const state = node("span", rating.label, "availability");
  state.dataset.state = availability;
  const title = node("h3", sentence(grant, known));
  title.id = `permission-${++cardCount}`;
  const asset = tokenChip(assetMint(grant), `${title.id}-token`);
  // Every card's buttons share their names, so each also points at its own token and sentence.
  const about = `${asset.id} ${title.id}`;
  header.append(asset, state);
  row.setAttribute("aria-labelledby", title.id);
  // A row shows its sentence only under Details; screen readers get it as the row's name.
  const said = node("p", title.textContent, "sentence");
  said.setAttribute("aria-hidden", "true");
  if (list) title.className = "visually-hidden";
  row.append(header, title);
  // A subscription always acts through the approval it rests on, so the runtime never confirms it
  // alone; on a wallet's row that is noise, and the reason stays under Details.
  const structural = list && object(grant.authority_kind).kind === "derived" && availability === "unknown";
  if (structural) row.classList.add("derived");
  else if (rating.reason) row.append(node("p", rating.reason, "why"));
  row.append(
    delegate(
      grant,
      (found) => (title.textContent = said.textContent = sentence(grant, { ...known, delegate: found })),
      list,
    ),
  );
  // A subscription's charging keys are named by the plan's own name, marked as the merchant's.
  const merchant = planNames.get(revokeKey(grant) ?? "");
  if (merchant && object(grant.authority_kind).kind === "derived") {
    const line = row.querySelector(".delegate");
    line?.querySelector("strong")?.replaceChildren(merchant);
    line?.querySelector(".muted")?.replaceChildren("Plan name set by the merchant");
    line?.setAttribute("title", `${merchant}: plan name set by the merchant, not verified`);
  }
  if (list) row.append(node("span", allowanceCell(grant, known.token), "row-amount"));
  const actions = node("div", "", "permission-actions");
  const panel = technical(grant, availability, rating, list);
  panel.id = `${title.id}-details`;
  if (list) panel.prepend(said);
  // A subscription or delegation shows what it has actually charged, read from finalized transactions.
  const delegation = revokeKey(grant);
  if (
    control &&
    text(object(grant.native_context).protocol) === "subscriptions" &&
    object(grant.authority_kind).kind === "derived" &&
    delegation
  )
    charges(row, panel, delegation, known.token);
  const button = node("button", list ? "Details" : "Technical details", "link-button");
  button.type = "button";
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", panel.id);
  button.setAttribute("aria-describedby", about);
  button.onclick = () => toggleDetail(button, panel, grant);
  actions.append(button);
  row.append(actions, panel);
  const protocol = text(object(grant.native_context).protocol);
  // Only the token account's owner can sign a revoke; that is the chain's rule, not a setting.
  // Never offered for a permanent delegate, a subscription's technical approval or a subscription
  // that has not ended: connecting would not make any of them removable.
  const holder = object(grant.subject);
  const owner = holder.kind === "identity" ? text(holder.value) : "";
  const removable =
    owner !== "" &&
    grant.capability === "spend" &&
    object(grant.lifecycle).kind === "active" &&
    (protocol !== "subscriptions" || ended(grant, view) || paymentApproval(grant));
  if (scope && removable) row.dataset.removable = owner;
  if (
    control &&
    scope &&
    connected &&
    object(view.observation).origin === "finalized" &&
    grant.observability === "exact" &&
    grant.capability === "spend" &&
    ((["spl-token", "token-2022"].includes(protocol) &&
      object(grant.authority_kind).kind === "direct" &&
      object(grant.lifecycle).kind === "active") ||
      (protocol === "subscriptions" &&
        (ended(grant, view) || paymentApproval(grant)) &&
        revokeKey(grant) !== undefined)) &&
    object(grant.subject).kind === "identity" &&
    object(grant.subject).value === connected.account.address
  ) {
    const revoke = labelled(node("button", "Remove access", "action-button"), "revoke");
    revoke.setAttribute("aria-describedby", about);
    const start = () => void prepare(grant, scope);
    revoke.onclick = () => {
      queue = [];
      start();
    };
    revocable.set(row, start);
    actions.prepend(revoke);
  } else if (scope && grant.capability === "spend" && !list) {
    // A wallet's list says this once, above its rows.
    if (!connected) {
      if (removable) {
        const start = labelled(node("button", "Connect to remove access", "action-button"), "wallet");
        start.setAttribute("aria-describedby", about);
        start.onclick = () => connectButton.click();
        actions.prepend(start);
      }
    } else if (removable && owner !== connected.account.address)
      actions.append(node("span", `Only its owner, ${short(owner)}, can remove this.`, "muted"));
  }
  return row;
}

const SUBSCRIPTIONS = "De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44";

// A subscription grant whose cancellation has taken effect at this observation. Only then does the
// program close its delegation; an active subscription can only be cancelled, and the technical
// approval it rests on is direct and never closed here.
function ended(grant: ObjectValue, view: ObjectValue): boolean {
  const lifecycle = object(grant.lifecycle);
  const now = object(view.observation).unix_timestamp;
  return (
    object(grant.authority_kind).kind === "derived" &&
    lifecycle.kind === "active" &&
    lifecycle.valid_until != null &&
    now != null &&
    integer(lifecycle.valid_until) <= integer(now)
  );
}

// The account a revoke is keyed by: the token account for SPL, and for Subscriptions the
// delegation named in the grant id `<program>:<delegation>:<init id>:spend`, never the shared
// token account.
function revokeKey(grant: ObjectValue): string | undefined {
  if (text(object(grant.native_context).protocol) !== "subscriptions") return text(object(grant.resource).id);
  const [program, delegation, init, capability, ...rest] = text(grant.id).split(":");
  return program === SUBSCRIPTIONS &&
    delegation !== undefined &&
    isAddress(delegation) &&
    /^-?\d+$/.test(init ?? "") &&
    capability === "spend" &&
    rest.length === 0
    ? delegation
    : undefined;
}

// Past charges are read a few at a time, so a wallet with many subscriptions doesn't flood the RPC.
let reading = 0;
const queued: (() => void)[] = [];
async function oneOf<T>(work: () => Promise<T>): Promise<T> {
  if (reading >= 3) await new Promise<void>((resolve) => queued.push(resolve));
  reading++;
  try {
    return await work();
  } finally {
    reading--;
    queued.shift()?.();
  }
}

// Amounts arrive as decimal strings, so a u64 survives JSON; anything else is refused.
const amountOf = (value: Json | undefined) => {
  const digits = text(value);
  if (!/^\d{1,20}$/.test(digits) || BigInt(digits) > UNLIMITED) throw new Error("Malformed amount.");
  return BigInt(digits);
};
const day = (seconds: Json | undefined) =>
  seconds == null
    ? "an unknown date"
    : (when(integer(seconds))?.split(",").slice(0, 2).join(",") ?? "an unknown date");

// The last charge goes on the row; every charge and change, with its transaction, goes under Details.
function charges(row: HTMLElement, panel: HTMLElement, delegation: string, token: Facts["token"]) {
  const line = node("span", "Reading past charges…", "last-charge");
  (row.querySelector(".row-amount") ?? row.querySelector(".delegate") ?? row).append(line);
  void oneOf(async () => {
    const response = await call("/api/live/history", {
      method: "POST",
      headers: { "X-Velon-Action": "observe", "Content-Type": "application/json" },
      body: JSON.stringify({ delegation }),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error("History unavailable");
    return object(readJson(await response.text()));
  })
    .then((body) => {
      if (!body) return line.remove();
      const events = array(body.events).map(object);
      const pulls = events.filter((entry) => entry.kind === "pull");
      const last = pulls[0];
      line.textContent = last
        ? `Last charged ${quantity(amountOf(last.amount), token)} on ${day(last.time)}`
        : "No charges yet";
      const section = node("section", "", "charges");
      section.append(node("h4", "Charges and changes"));
      const list = node("ol");
      for (const entry of events) {
        const item = node("li");
        const said =
          entry.kind === "pull"
            ? `Charged ${quantity(amountOf(entry.amount), token)}, paid to ${short(text(entry.receiver))}${entry.puller ? `, by ${short(text(entry.puller))}` : ""}`
            : entry.kind === "created"
              ? "Subscribed"
              : entry.kind === "cancelled"
                ? `Cancelled; it ends on ${day(entry.expiresAt)}`
                : "Resumed";
        const open = node("a", "Transaction", "link-button");
        open.href = explorer("tx", text(entry.signature));
        open.target = "_blank";
        open.rel = "noreferrer";
        item.append(node("span", day(entry.time), "charge-date"), node("span", said), open);
        list.append(item);
      }
      section.append(
        events.length ? list : node("p", "No charges or changes yet.", "muted"),
        node(
          "p",
          body.complete === true
            ? "Read from every finalized transaction for this permission."
            : "Read from its 25 most recent finalized transactions; older ones aren't shown.",
          "muted",
        ),
      );
      // The history reads before the folded technical record, which stays last.
      const record = panel.querySelector(".record");
      if (record) record.before(section);
      else panel.append(section);
    })
    .catch(() => {
      line.textContent = "Velon couldn't read past charges.";
    });
}

// Who holds the permission, named from what the chain says the key is. The card's sentence is
// told once the answer arrives; until then, or if it never does, the key is only an address.
function delegate(grant: ObjectValue, named: (found: Delegate) => void, brief = false): HTMLElement {
  const actor = object(grant.principal);
  const line = node("div", "", "delegate");
  if (actor.kind !== "identity") {
    line.append(
      node("strong", "Several keys"),
      node("span", "Any of them can use this one shared permission", "muted"),
    );
    return line;
  }
  const key = text(actor.value);
  // The Subscriptions authority is named by the verified grant, not by the RPC.
  const subscriptions = subscriptionsAuthority(grant);
  const name = node("strong", subscriptions ? "Solana Subscriptions" : short(key));
  const detail = node(
    "span",
    subscriptions ? `Program authority · ${short(key)}` : brief ? "" : "Address",
    "muted",
  );
  line.append(avatar(key), name, detail);
  if (control && !subscriptions)
    void describeDelegate(control.rpcUrl, key)
      .then((found) => {
        holders.set(key, found);
        // An address with no account says nothing more than its key, so the key stays.
        if (found.kind !== "none") name.textContent = found.title;
        detail.textContent =
          brief && found.kind !== "none" ? short(key) : brief ? "" : `${found.detail} · ${short(key)}`;
        named(found);
      })
      .catch(() => {});
  return line;
}

// Short enough for the diagram's node: 25, 1.2K, 4.5M, then powers of ten.
function compact(units: bigint): string {
  if (units === UNLIMITED) return "∞";
  if (units < 1_000_000_000_000n)
    return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(units);
  const digits = units.toString();
  return `${digits[0]}.${digits[1]}e${digits.length - 1}`;
}

function currentScenario(): Scenario {
  const scenario = scenarios[Number(select.value)];
  if (!scenario) throw new Error("No native observation selected.");
  return scenario;
}

// What the address is on chain: a wallet, an SPL Token account, a Token-2022 account or something else.
// Undefined when the RPC did not answer.
async function addressKind(
  address: string,
  signal: AbortSignal,
): Promise<{ kind: string; wallet?: ObjectValue } | undefined> {
  const response = await call("/api/live/wallet", {
    method: "POST",
    headers: { "X-Velon-Action": "observe", "Content-Type": "application/json" },
    body: JSON.stringify({ owner: address }),
    signal,
  }).catch(() => undefined);
  // A server without this endpoint reads every address as a token account, as before.
  if (response?.status === 404) return { kind: "token-account" };
  if (!response?.ok) return undefined;
  const wallet = object(readJson(await response.text()));
  return { kind: text(wallet.kind), wallet };
}

// A pasted subscription delegation's grants are read through the token account it draws from.
const drawsFrom = new Map<string, string>();

async function scan(historical = false, refresh = false) {
  invalidateReview();
  request?.abort();
  request = new AbortController();
  const signal = request.signal;
  const address = input.value.trim() || subject;
  // Switching back to this tab shows this lookup again, even if it was refused.
  reload = () => scan();
  document.body.classList.remove("first-screen");
  results.replaceChildren();
  scanButton.disabled = false;
  if (!isAddress(address)) {
    if (currentScenario().live) status("Pick an account from the list, or paste a token account.");
    else status("Enter a valid Solana address.", true);
    return;
  }
  scanButton.disabled = true;
  // A public lookup shows its progress in place; the recorded bench keeps its status line.
  if (document.body.classList.contains("public")) {
    notice.replaceChildren();
    results.replaceChildren(progressFor(address).panel);
  } else status("Loading the selected observation...");
  try {
    const scenario = currentScenario();
    const live = scenario.live;
    compareTab(!live);
    let subscription = false;
    // On a public cluster a pasted wallet is read like a connected one, without signing rights.
    if (live && control?.network !== "localnet") {
      const found = await addressKind(address, signal);
      const kind = found?.kind;
      const refused: Record<string, string> = {
        mint: "This is a token mint, not a wallet or a token account. Paste the wallet that holds the token instead.",
        "token-2022-account":
          "This is a Token-2022 account. Velon checks Token-2022 accounts as part of their wallet, so paste the owner's wallet address instead.",
        other:
          "This address is owned by a program, not a wallet or an SPL Token account. Paste a wallet address or one of its token accounts.",
      };
      // A Subscriptions account is observed; the runtime reads it only as a subscription delegation.
      subscription = kind === "other" && found!.wallet!.program === SUBSCRIPTIONS;
      if (kind === undefined || (refused[kind] && !subscription)) {
        scanButton.disabled = false;
        results.replaceChildren();
        status(
          kind ? refused[kind]! : "The RPC did not answer. It may be rate limiting; try again in a minute.",
          true,
        );
        return;
      }
      // A plan isn't anyone's permission yet; it is shown as what subscribing to it would allow.
      if (subscription && (await showPlan(address))) {
        scanButton.disabled = false;
        return;
      }
      if (kind === "wallet") {
        scanButton.disabled = false;
        if (!document.body.classList.contains("public")) status("Reading the wallet's token accounts...");
        // A wallet is never re-read as a single token account.
        await scanWallet(address, found!.wallet);
        return;
      }
    }
    // A live scope belongs to the account it observed; any other address is observed afresh.
    if (live && (refresh || !scenario.scope || observedFor.get(scenario) !== address)) {
      status("Reading the account's final state on chain...");
      const observed = await call("/api/live/spl/observe", {
        method: "POST",
        headers: { "X-Velon-Action": "observe", "Content-Type": "application/json" },
        body: JSON.stringify({ source: address }),
        signal,
      });
      const observation = object(await result(observed));
      scenario.scope = text(observation.scope_id);
      observedFor.set(scenario, address);
      if (subscription) {
        const target = array(object(object(observation.record).snapshot).targets)
          .map(object)
          .find((target) => target.kind === "subscription" && publicKey(target.delegation) === address);
        if (!target) throw new Error("This Subscriptions account is not a subscription delegation.");
        drawsFrom.set(address, publicKey(target.source));
      }
    }
    badge(live ? network().label : "Recorded native evidence", live);
    document.querySelector(".scope-note")!.textContent = live
      ? "Read from the chain's final state for this token account. Velon read only this account."
      : "Read from accounts recorded when the real programs ran in tests, not from a live chain.";
    const path = historical
      ? `snapshots/${scenario.snapshots[0]!.id}/authorizations/${address}`
      : `scopes/${scenario.scope}/effective/${drawsFrom.get(address) ?? address}`;
    const view = object(await get(path, signal));
    if (view.arm_schema_version !== "0.1")
      throw new Error("Unsupported ARM schema. Permission interpretation is unavailable.");
    const entries = array(object(view.projection).authorizations ?? []);
    if (object(view.projection).status !== "compiled") {
      grants(view.projection);
    }
    const permissions = entries.map((entry) =>
      historical
        ? { grant: authorization(entry), availability: HISTORICAL }
        : {
            grant: authorization(object(entry).authorization),
            availability: text(object(entry).availability),
          },
    );
    if (live)
      await nameTokens(
        permissions.flatMap(({ grant }) => assetMint(grant) ?? []),
        signal,
      ).catch(() => undefined);
    const content = document.createDocumentFragment();
    const heading = node("div", "", "section-heading");
    heading.append(node("h2", historical ? "Who could act on it earlier" : "Who can act on this account"));
    if (scenario.snapshots.length > 1) {
      const toggle = node(
        "button",
        historical ? "View current observation" : `View earlier slot ${scenario.snapshots[0]!.slot}`,
        "link-button",
      );
      toggle.onclick = () => scan(!historical);
      heading.append(toggle);
    }
    content.append(summary(permissions, view), heading, glossary(), metadata(view));
    if (permissions.length === 0)
      content.append(
        node(
          "p",
          "Velon found no permissions on this account. It read only this account, so this isn't an all-clear.",
          "empty",
        ),
      );
    else
      for (const { grant, availability } of permissions)
        content.append(card(grant, view, availability, live ? scenario.scope : undefined));
    reload = () => scan();
    if (signal.aborted) return;
    results.replaceChildren(content);
    guide(permissions.length && results.querySelector(".action-button") ? 3 : 2);
    if (refresh && innerWidth < 960) results.scrollIntoView({ block: "start" });
    notice.replaceChildren();
    for (const row of feed.querySelectorAll<HTMLElement>(".feed-row"))
      row.toggleAttribute("aria-current", row.dataset.source === address);
    return true;
  } catch (error) {
    if (!signal.aborted)
      failed(error instanceof Error ? error.message : "Unable to read the observation.", () =>
        setMode("scan", true),
      );
  } finally {
    if (!signal.aborted) scanButton.disabled = false;
  }
}

// The progress panel for the wallet being checked; a new address gets a fresh one.
let meter: Progress | undefined;
function progressFor(owner: string): Progress {
  if (meter?.owner === owner && meter.panel.isConnected) return meter;
  return (meter = checkingCard(owner));
}

// A failed check says what happened and offers the way on: the same check again.
function failed(message: string, retry: () => void) {
  results.replaceChildren();
  const line = node("p", message, "error");
  line.append(" ", act("Try again", "refresh", "link-button", retry));
  notice.replaceChildren(line);
}

async function showDiff() {
  request?.abort();
  request = new AbortController();
  const signal = request.signal;
  diff.replaceChildren();
  const scenario = currentScenario();
  if (scenario.snapshots.length < 2) {
    status("This fixture has one observation. A comparison requires two native states.");
    return;
  }
  status("Comparing the two recorded native states...");
  try {
    const [before, after] = await Promise.all([
      get(`snapshots/${scenario.snapshots[0]!.id}`, signal),
      get(`scopes/${scenario.scope}`, signal),
    ]);
    const changes = compare(before!, after!);
    if (signal.aborted) return;
    diff.append(
      node(
        "h2",
        `Observed changes: slot ${scenario.snapshots[0]!.slot} → ${integer(object(object(object(after).snapshot).observation).slot)}`,
      ),
    );
    diff.append(
      node(
        "p",
        "This compares recorded states across several native transitions. It does not predict a transaction or attribute every change to revoke alone.",
        "notice",
      ),
    );
    if (changes.length === 0)
      diff.append(node("p", "No semantic authorization changes between these observations.", "empty"));
    for (const change of changes) {
      const grant = change.after ?? change.before!;
      const row = node("article", "", "permission");
      const header = node("div", "", "permission-header");
      const kind = text(object(grant.authority_kind).kind);
      header.append(node("span", change.kind, "badge change"), node("span", KINDS[kind] ?? kind, "badge"));
      row.append(header, node("h3", permissionLabel(grant)));
      row.append(node("p", principalLabel(grant.principal), "address"));
      if (change.before) row.append(raw("Before", change.before));
      if (change.after) row.append(raw("After", change.after));
      diff.append(row);
    }
    diff.append(
      raw("Observation provenance", {
        before: {
          id: object(before).id!,
          observation: object(object(before).snapshot).observation!,
          versions: object(before).versions!,
        },
        after: {
          id: object(after).id!,
          observation: object(object(after).snapshot).observation!,
          versions: object(after).versions!,
        },
      }),
    );
    status("Comparison complete. Source evidence is retained in both records.");
  } catch (error) {
    if (!signal.aborted) {
      diff.replaceChildren();
      status(error instanceof Error ? error.message : "Comparison unavailable.", true);
    }
  }
}

function setMode(next: "scan" | "diff", refresh = false) {
  if (actionState && ["AWAITING_SIGNATURE", "SUBMITTING", "FINALIZING"].includes(actionState)) return;
  receipts.hidden = true;
  document.querySelector("#receipts-tab")!.classList.remove("selected");
  invalidateReview();
  mode = next;
  results.hidden = next !== "scan";
  diff.hidden = next !== "diff";
  document.querySelector("#scan-tab")!.classList.toggle("selected", next === "scan");
  document.querySelector("#diff-tab")!.classList.toggle("selected", next === "diff");
  if (next === "diff") {
    scanButton.disabled = false;
    void showDiff();
  } else void (refresh ? scan(false, true) : reload());
}

// The account shown when the visitor has not typed or picked one.
let subject = "";
function selectScenario() {
  const scenario = currentScenario();
  const examples = document.querySelector<HTMLElement>("#examples")!;
  examples.replaceChildren();
  // A live ledger lists its own accounts; fixed examples belong to recorded evidence.
  examples.hidden = scenario.live && control?.network === "localnet";
  if (scenario.examples.length) examples.append(node("span", "Try", "muted"));
  for (const example of scenario.examples) {
    const button = node("button", example.label, "example");
    button.onclick = () => {
      input.value = example.address;
      setMode("scan", true);
    };
    examples.append(button);
  }
  // The first example opens with the set, but the box stays the visitor's to fill.
  subject = scenario.examples[0]?.address ?? "";
  input.value = "";
  if (mode === "diff") void showDiff();
  else void scan();
}

let control: Control | null = null;
// Wallet Standard chain, plain name and Explorer suffix for the server's network.
const NETWORKS = {
  mainnet: { chain: "solana:mainnet", label: "Mainnet", explorer: () => "" },
  devnet: { chain: "solana:devnet", label: "Devnet", explorer: () => "?cluster=devnet" },
  localnet: {
    chain: "solana:localnet",
    label: "Local validator",
    explorer: () => `?cluster=custom&customUrl=${encodeURIComponent(control?.rpcUrl ?? "")}`,
  },
} as const;
const network = () => NETWORKS[control?.network ?? "localnet"];
const explorer = (kind: "address" | "tx", value: string) =>
  `https://explorer.solana.com/${kind}/${value}${network().explorer()}`;
// Mint decimals as the RPC's token index reported them, keyed by token account. Display only:
// every check and every signed byte stays in base units.
const decimals = new Map<string, number>();
function tokens(units: bigint, source: string, mint?: string): string | undefined {
  const known = mint ? TOKENS[mint] : undefined;
  const scale = known?.decimals ?? decimals.get(source);
  if (scale === undefined) return undefined;
  return `${decimal(units, scale)} ${known?.symbol ?? "tokens"}`;
}
function allowance(source: string, units: bigint, mint?: string): string {
  if (units === UNLIMITED) return "Unlimited: every token this account will ever hold";
  const base = `${units.toLocaleString("en-US")} base units`;
  const shown = tokens(units, source, mint);
  return shown ? `${shown} (${base})` : base;
}
let connected: { wallet: SigningWallet; account: SigningWallet["accounts"][number] } | undefined;
let unsubscribe: (() => void) | undefined;
let actionAbort: AbortController | undefined;
let actionState: ActionState | undefined;
const chooser = document.querySelector<HTMLDialogElement>("#wallet-chooser")!;
const connectButton = document.querySelector<HTMLButtonElement>("#connect-wallet")!;
const disconnectButton = document.querySelector<HTMLButtonElement>("#disconnect-wallet")!;
const walletStatus = document.querySelector<HTMLElement>("#wallet-status")!;
const review = document.querySelector<HTMLDialogElement>("#revoke-review")!;
const actionResult = document.querySelector<HTMLElement>("#action-result")!;

// The card the open review came from.
let reviewed = "";

function invalidateReview() {
  if (actionState === "PREPARING" || actionState === "SIMULATED") {
    actionAbort?.abort();
    review.close();
    actionState = undefined;
  }
}

function refreshWallets() {
  const available = signingWallets();
  connectButton.hidden = !!connected;
  connectButton.disabled = !scenarios.length;
  connectButton.title = available.length ? "" : "No Solana wallet with signTransaction was detected.";
}
wallets.on("register", refreshWallets);
wallets.on("unregister", () => {
  if (connected && !wallets.get().includes(connected.wallet)) disconnected();
  refreshWallets();
});
connectButton.prepend(icon("wallet"));
refreshWallets();

function disconnected() {
  actionAbort?.abort();
  review.close();
  unsubscribe?.();
  unsubscribe = undefined;
  connected = undefined;
  disconnectButton.hidden = true;
  tryPanel.dataset.state = "";
  delete stage.dataset.state;
  draw();
  document.querySelector("#try-status")!.textContent = "Test chain. Test tokens. Your signature.";
  bench.hidden = !control?.testBench;
  walletStatus.textContent = "";
  refreshWallets();
  if (actionState)
    setAction("FAILED", "Wallet changed. Any submitted transaction must still be checked on chain.");
  // The wallet's view goes with the wallet; a live console returns to its first screen.
  reload = () => scan();
  if (document.body.classList.contains("is-live")) lesson();
  else void scan();
}
disconnectButton.onclick = () => {
  if (actionState && ["AWAITING_SIGNATURE", "SUBMITTING", "FINALIZING"].includes(actionState)) return;
  const wallet = connected?.wallet;
  disconnected();
  if (wallet) void forget(wallet);
};
// A phone's wallet apps arrive under the protocol's name; people know them as their wallet app.
const walletName = (wallet: SigningWallet) =>
  wallet.name === PHONE_WALLET ? "A wallet app on this phone" : wallet.name;
// One button for every Wallet Standard wallet; a chooser appears only when several are installed.
connectButton.onclick = () => {
  if (actionState && ["AWAITING_SIGNATURE", "SUBMITTING", "FINALIZING"].includes(actionState)) return;
  const available = signingWallets();
  if (!available.length) return noWallet();
  if (available.length < 2) return void connect(available[0]);
  chooser.replaceChildren(
    node("h2", "Connect a wallet"),
    ...available.map((wallet) => {
      const option = node("button", "", "wallet-option");
      const icon = node("img");
      icon.src = wallet.icon;
      icon.alt = "";
      option.append(icon, node("span", walletName(wallet)));
      option.onclick = () => {
        chooser.close();
        void connect(wallet);
      };
      return option;
    }),
  );
  chooser.showModal();
};

// Connecting needs a wallet that can reach this page. Each device is told its own way there:
// a phone opens the page inside a wallet app, keeping the wallet being checked; a computer installs one.
function noWallet(noPhoneApp = false) {
  const device = deviceOf(navigator.userAgent, navigator.maxTouchPoints);
  const phone = device !== "desktop";
  const links = node("p", "", "wallet-links");
  for (const { name, href } of phone ? openInWallet(location.href) : INSTALL) {
    const anchor = labelled(node("a", phone ? `Open in ${name}` : name, "link-button"), "external");
    anchor.href = href;
    // A phone hands the link to the wallet app; a computer keeps this page open beside the download.
    if (!phone) anchor.target = "_blank";
    anchor.rel = "noreferrer";
    links.append(anchor);
  }
  const close = node("button", "Close", "action-button");
  close.type = "button";
  close.onclick = () => chooser.close();
  const [title, line] = noPhoneApp
    ? [
        "No wallet app found on this phone",
        "Velon looked for a Solana wallet app on this phone and didn't find one. Install one, or open this page inside a wallet app you already use. The wallet you're checking comes with it.",
      ]
    : device === "ios"
      ? [
          "Connect from your wallet app",
          "On iPhone and iPad, Solana wallets connect inside their own app. Open this page there. The wallet you're checking comes with it.",
        ]
      : device === "android"
        ? [
            "This browser can't reach your wallet app",
            "Open this page inside your wallet app, or in Chrome, to connect. The wallet you're checking comes with it.",
          ]
        : [
            "No Solana wallet in this browser",
            "To remove an approval, Velon asks your wallet to sign it, so a wallet needs to be installed here.",
          ];
  chooser.replaceChildren(
    node("h2", title),
    node("p", line, "muted"),
    links,
    ...(phone
      ? [node("p", `Another wallet? Open its app's browser and go to ${location.host}.`, "muted")]
      : []),
    node("p", "You can still check any wallet without one: paste its address.", "muted"),
    close,
  );
  if (!chooser.open) chooser.showModal();
}

// While a wallet is asked, the button says so; a phone may be switching to its wallet app.
function connecting(busy: boolean) {
  connectButton.setAttribute("aria-busy", String(busy));
  connectButton.lastChild!.textContent = busy ? "Connecting…" : "Connect wallet";
  if (busy) connectButton.disabled = true;
  else refreshWallets();
}

async function connect(wallet: SigningWallet | undefined) {
  try {
    invalidateReview();
    if (!wallet) throw new Error("Install a Wallet Standard wallet with signTransaction support.");
    connecting(true);
    const { accounts } = await wallet.features["standard:connect"].connect();
    // A phone wallet reports what it can do once connected, under the protocol's own names. Velon
    // signs only what it reviewed and sends it itself, so sign-and-send alone isn't enough.
    const phone = wallet.name === PHONE_WALLET;
    if (phone && !("solana:signTransaction" in wallet.features))
      throw new Error(
        "This wallet app only signs and sends in one step, so Velon couldn't check the exact transaction before it goes out. Try another wallet app.",
      );
    const account = accounts.find(
      (account) =>
        (phone || account.features.includes("solana:signTransaction")) &&
        (control?.network === "localnet" || account.chains.includes(network().chain)),
    );
    if (!account) throw new Error("This wallet has no compatible Solana signing account.");
    unsubscribe?.();
    connected = { wallet, account };
    unsubscribe = wallet.features["standard:events"].on("change", disconnected);
    const logo = node("img", "", "wallet-icon");
    logo.src = wallet.icon;
    logo.alt = "";
    walletStatus.replaceChildren(logo, `${account.address.slice(0, 4)}…${account.address.slice(-4)}`);
    walletStatus.title = `${walletName(wallet)}: ${account.address}`;
    disconnectButton.hidden = false;
    refreshWallets();
    document.querySelector("#app")!.scrollIntoView();
    bench.hidden = true;
    tryPanel.dataset.state = "connected";
    draw();
    if (control?.testBench)
      document.querySelector("#try-status")!.textContent = "Test tokens arrive, then you sign one approval.";
    const live = scenarios.findIndex((scenario) => scenario.live);
    if (live >= 0) select.value = String(live);
    if (control && (await scanWallet())) return;
    if (live >= 0) selectScenario();
    else {
      input.value = account.address;
      setMode("scan");
    }
  } catch (error) {
    const said = connectFailure(error instanceof Error ? error.message : "");
    if (said) status(said.text, said.error);
  } finally {
    connecting(false);
  }
}

// Tells the wallet which cluster the bytes belong to. Without it a wallet assumes its own
// network, cannot simulate a test-chain transaction there and may rewrite the blockhash.
function chainFor(wallet: SigningWallet) {
  const { chain } = network();
  return wallet.chains.includes(chain) ? { chain } : {};
}

// Extensions simulate on the network they are set to. On the test chain that check fails
// inside the wallet unless it is pointed at the same chain, so the visitor is told beforehand.
function walletHint(): string {
  if (control?.network !== "localnet" || !connected || connected.wallet.name === "Velon test wallet")
    return "";
  return `${connected.wallet.name} checks transactions against its own network. Set it to Localnet first (Phantom: Settings, Developer Settings, Testnet Mode, Solana Localnet), or it will warn that simulation failed.`;
}

const tryPanel = document.querySelector<HTMLElement>("#try")!;
const grantButton = document.querySelector<HTMLButtonElement>("#grant")!;
document.querySelector<HTMLButtonElement>("#use-test-wallet")!.onclick = async () =>
  connect(await testWallet());
document.querySelector<HTMLButtonElement>("#connect-own")!.onclick = () => connectButton.click();
// Comparing two recorded states only exists for recorded examples.
const compareTab = (shown: boolean) => (document.querySelector<HTMLElement>("#diff-tab")!.hidden = !shown);

const WSOL = "So11111111111111111111111111111111111111112";
function units(amount: bigint, scale: number): string {
  // A nonzero amount never reads as zero.
  if (amount > 0n && amount * 10_000n < 10n ** BigInt(scale)) return "<0.0001";
  const whole = (amount / 10n ** BigInt(scale)).toLocaleString("en-US");
  const fraction = (amount % 10n ** BigInt(scale))
    .toString()
    .padStart(scale, "0")
    .slice(0, 4)
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

// What the wallet holds, as its RPC reports it, and whether any other key can spend each token.
// Display only: the permissions below are the ones Velon observed and can act on.
// Amounts arrive as decimal strings so u64 values survive JSON.
async function holdingsPanel(
  owner: string,
  signal: AbortSignal,
  prefetched?: ObjectValue,
): Promise<HTMLElement | undefined> {
  const yours = owner === connected?.account.address;
  let wallet = prefetched;
  if (!wallet) {
    const response = await call("/api/live/wallet", {
      method: "POST",
      headers: { "X-Velon-Action": "observe", "Content-Type": "application/json" },
      body: JSON.stringify({ owner }),
      signal,
    }).catch(() => undefined);
    if (!response?.ok) return undefined;
    wallet = object(readJson(await response.text()));
  }
  if (wallet.kind !== "wallet") return undefined;
  const all = array(wallet.tokens).map(object);
  for (const entry of all)
    balances.set(text(entry.source), {
      amount: BigInt(text(entry.amount)),
      decimals: Number(entry.decimals),
    });
  const shown = all
    .filter((entry) => entry.delegate !== null || text(entry.amount) !== "0")
    .sort(
      (a, b) =>
        Number(b.delegate !== null) - Number(a.delegate !== null) ||
        Number(Boolean(TOKENS[text(b.mint)])) - Number(Boolean(TOKENS[text(a.mint)])),
    );
  const panel = node("section", "", "holdings");
  const head = node("div", "", "holdings-head");
  const link = labelled(node("a", "Explorer", "link-button"), "external");
  link.href = explorer("address", owner);
  link.target = "_blank";
  link.rel = "noreferrer";
  head.append(node("h2", yours ? "Your wallet" : "This wallet"), node("span", short(owner), "mono"), link);
  const list = node("ul", "", "holdings-list");
  const row = (logo: Element, name: string, detail: string, amount: string, status: HTMLElement) => {
    const item = node("li", "", "holding");
    const label = node("div", "", "holding-name");
    label.append(node("strong", name), node("span", detail, "muted"));
    item.append(logo, label, node("span", amount, "holding-amount"), status);
    return item;
  };
  // Only the account's own delegate is read here; a Token-2022 mint can still name a permanent
  // delegate, so that case is not called safe.
  const safe = (entry: ObjectValue) =>
    entry.program === "spl-token-2022"
      ? node("span", "No approval · token settings not checked", "holding-status")
      : node("span", "No approval", "holding-status ok");
  // Names are display only; a lookup that fails leaves the addresses in place.
  await nameTokens(
    shown.map((entry) => text(entry.mint)),
    signal,
  ).catch(() => undefined);
  // Native SOL cannot be delegated; only the wallet's own key moves it.
  const own = node(
    "span",
    yours ? "Only you can move it" : "Only the owner can move it",
    "holding-status ok",
  );
  list.append(row(tokenLogo(WSOL), "SOL", "Native balance", units(BigInt(text(wallet.lamports)), 9), own));
  for (const entry of shown) {
    const mint = text(entry.mint);
    const scale = Number(entry.decimals);
    let status = safe(entry);
    if (entry.delegate !== null) {
      const delegated = BigInt(text(entry.delegated));
      const limit =
        delegated === UNLIMITED
          ? "any amount"
          : delegated >= 2n ** 63n
            ? "with no practical limit"
            : `up to ${units(delegated, scale)}`;
      const key = text(entry.delegate);
      const said = node("span", `${short(key)} can take ${limit}`, "holding-status risk");
      said.dataset.delegate = key;
      said.dataset.limit = limit;
      // A known program, or an account one controls (such as the Subscriptions authority), is named.
      if (control)
        void describeDelegate(control.rpcUrl, key)
          .then((found) => {
            if (found.kind === "listed" || found.kind === "owned")
              said.textContent = `${found.title} can take ${limit}`;
          })
          .catch(() => {});
      status = said;
    }
    const label = tokenName(mint);
    const detail = `${label.name ?? "Unlisted token"}${label.verified || !label.name ? "" : " · unverified"}${entry.program === "spl-token-2022" ? " · Token-2022" : ""}`;
    list.append(
      row(
        tokenLogo(mint),
        label.symbol ?? label.name ?? `Token ${short(mint)}`,
        detail,
        units(BigInt(text(entry.amount)), scale),
        status,
      ),
    );
  }
  panel.append(head, list);
  // A wallet with many tokens folds to one line; the approvals below are what needs attention.
  if (shown.length > 4) {
    const delegated = shown.filter((entry) => entry.delegate !== null).length;
    const sol = units(BigInt(text(wallet.lamports)), 9);
    const summary = node(
      "p",
      `${sol} SOL · ${shown.length} tokens${delegated ? ` · ${delegated} with an approval` : ""}`,
      "holdings-summary",
    );
    const toggle = node("button", "Show tokens", "link-button");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "false");
    toggle.onclick = () => {
      const open = panel.classList.toggle("unfolded");
      toggle.setAttribute("aria-expanded", String(open));
      toggle.textContent = open ? "Hide tokens" : "Show tokens";
    };
    head.after(summary);
    summary.append(toggle);
    panel.classList.add("folded");
  }
  const hidden = Number(wallet.omitted ?? 0) + Number(wallet.skipped ?? 0);
  if (hidden)
    panel.append(
      node("p", `${hidden} more token account${hidden === 1 ? "" : "s"} could not be shown.`, "muted"),
    );
  const empty = all.length - shown.length;
  if (empty)
    panel.append(
      node(
        "p",
        `${empty} empty token account${empty === 1 ? "" : "s"} with no approval ${empty === 1 ? "is" : "are"} hidden.`,
        "muted",
      ),
    );
  return panel;
}

// An approval Velon could not verify: the network's report, the reason, and no removal.
function unverified(
  entry: ObjectValue,
  said: string,
  reason: string,
  link: string,
  extra: HTMLElement[] = [],
): HTMLElement {
  const row = node("article", "", "permission reported");
  const header = node("div", "", "permission-header");
  const mint = text(entry.mint);
  const title = node("h3", said);
  title.id = `permission-${++cardCount}`;
  row.setAttribute("aria-labelledby", title.id);
  header.append(tokenChip(mint, `${title.id}-token`), node("span", "Not verified", "availability"));
  const open = labelled(node("a", "Open on Solana Explorer", "link-button"), "external");
  open.href = link;
  open.target = "_blank";
  open.rel = "noreferrer";
  const actions = node("div", "", "permission-actions");
  actions.append(open);
  const facts = node("dl");
  facts.append(
    address("Who", text(entry.delegate), "holder"),
    address("Token account", text(entry.source)),
    address("Owner", text(entry.owner)),
    address("Token", mint),
    ...extra,
  );
  const details = node("details", "", "technical");
  details.append(node("summary", "Technical details"), facts);
  row.append(header, title, node("p", reason, "why"), actions, details);
  return row;
}

// An approval Velon could not verify, as one row of a wallet's list. Why is said once per group.
function reportedRow(entry: ObjectValue, said: string, link: string, extra: HTMLElement[]): HTMLElement {
  const row = node("article", "", "permission compact reported");
  const mint = text(entry.mint);
  const title = node("h3", said, "visually-hidden");
  title.id = `permission-${++cardCount}`;
  row.setAttribute("aria-labelledby", title.id);
  const header = node("div", "", "permission-header");
  header.append(tokenChip(mint, `${title.id}-token`));
  const key = text(entry.delegate);
  const who = node("div", "", "delegate");
  // The key itself until the chain says what it is, as on a verified row.
  const name = node("strong", short(key));
  const kind = node("span", "", "muted");
  who.append(avatar(key), name, kind);
  if (control)
    void describeDelegate(control.rpcUrl, key)
      .then((found) => {
        if (found.kind === "none") return;
        name.textContent = found.title;
        kind.textContent = short(key);
      })
      .catch(() => {});
  const open = labelled(node("a", "Explorer", "link-button"), "external");
  open.href = link;
  open.target = "_blank";
  open.rel = "noreferrer";
  open.setAttribute("aria-describedby", `${title.id}-token ${title.id}`);
  // The same Details toggle as a verified row, so both kinds of row work alike.
  const panel = node("section", "", "detail technical");
  panel.id = `${title.id}-details`;
  panel.hidden = true;
  const toggle = node("button", "Details", "link-button");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", panel.id);
  toggle.setAttribute("aria-describedby", `${title.id}-token ${title.id}`);
  toggle.onclick = () => toggleDetail(toggle, panel);
  const actions = node("div", "", "permission-actions");
  actions.append(open, toggle);
  const facts = node("dl");
  facts.append(
    address("Who", key, "holder"),
    address("Token account", text(entry.source)),
    address("Owner", text(entry.owner)),
    address("Token", mint),
    ...extra,
  );
  const sentence = node("p", said, "sentence");
  sentence.setAttribute("aria-hidden", "true");
  panel.append(sentence, facts);
  const amount = text(entry.amount) === String(UNLIMITED) ? "No limit" : `Up to ${text(entry.ui)}`;
  row.append(header, title, who, node("span", amount, "row-amount"), actions, panel);
  return row;
}

// A titled group of wallet rows, with the column names the rows line up under.
function group(heading: string, about: string[], rows: HTMLElement[], folded = false): HTMLElement {
  const block = node(folded ? "details" : "section", "", "approval-group");
  const head = node("div", "", "approvals-head");
  head.setAttribute("aria-hidden", "true");
  head.append(node("span", "Token"), node("span", "Who can take it"), node("span", "How much"));
  block.append(
    node(folded ? "summary" : "h2", heading),
    ...about.map((line) => node("p", line, "group-note")),
    head,
    ...rows,
  );
  return block;
}

// Every permission across the connected wallet's token accounts.
// Each account is observed through the runtime; the RPC's index only says where to look.
// Any wallet can be read; only the connected owner can sign a revoke for it.
async function scanWallet(
  owner = connected?.account.address,
  prefetched?: ObjectValue,
): Promise<boolean | undefined> {
  if (!owner) return false;
  const yours = owner === connected?.account.address;
  request?.abort();
  request = new AbortController();
  const signal = request.signal;
  const wallet = holdingsPanel(owner, signal, prefetched);
  // Display only: a panel that cannot be read must not surface as an unhandled rejection.
  void wallet.catch(() => undefined);
  const meter = progressFor(owner);
  meter.step(0);
  if (!meter.panel.isConnected) results.replaceChildren(meter.panel);
  notice.replaceChildren();
  // Only a ledger we started can be enumerated; public clusters answer per owner.
  const listed =
    control?.network === "localnet"
      ? await call("/api/live/spl/delegated", { signal })
      : await call("/api/live/spl/owned", {
          method: "POST",
          headers: { "X-Velon-Action": "observe", "Content-Type": "application/json" },
          body: JSON.stringify({ owner }),
          signal,
        });
  if (!listed.ok) {
    failed(
      listed.status === 429
        ? "Too many requests right now. Wait a minute, then try again."
        : "The wallet's token accounts could not be read.",
      () => void scanWallet(owner),
    );
    return false;
  }
  mode = "scan";
  diff.hidden = true;
  receipts.hidden = true;
  results.hidden = false;
  // The localnet index is a plain list; an owner's list also counts accounts the RPC could not describe.
  const answer = readJson(await listed.text());
  const skipped = Array.isArray(answer) ? 0 : Number(object(answer).skipped ?? 0);
  const subscriptionsUnread = !Array.isArray(answer) && object(answer).subscriptionsUnread === true;
  const reported = array(Array.isArray(answer) ? answer : object(answer).accounts!)
    .map(object)
    .filter((entry) => entry.owner === owner);
  for (const entry of reported) {
    if (typeof entry.decimals === "number") decimals.set(text(entry.source), entry.decimals);
    if (entry.program === "subscriptions" && typeof entry.planName === "string")
      planNames.set(text(entry.source), entry.planName);
    if (entry.program === "subscriptions" && typeof entry.delegationKind === "string")
      delegationKinds.set(text(entry.source), entry.delegationKind);
  }
  // Every delegated account, SPL Token or Token-2022, is observed through the runtime.
  const owned = reported;
  // Accounts the runtime observed but could not model exactly, with the reason it gave.
  const unsupported: [ObjectValue, string][] = [];
  const content = document.createDocumentFragment();
  const cards: HTMLElement[] = [];
  let last: ObjectValue | undefined;
  let unread = 0;
  // Keys the verified rows can name, so the wallet panel calls each delegate what its row does.
  const named = new Map<string, string>();
  // While the chain is read, every account is listed at once and marked as its batch returns.
  const checking = node("ol", "", "checking");
  const rows = owned.map((entry) => {
    const row = node("li", "", "pending");
    const delegate = text(entry.delegate);
    row.append(
      node("span", "", "checking-token"),
      node("span", `${delegate.slice(0, 4)}…${delegate.slice(-4)}`, "checking-who"),
      node("span", text(entry.amount) === String(UNLIMITED) ? "any amount" : "limited", "checking-amount"),
      node("span", "Checking", "checking-state"),
    );
    checking.append(row);
    return row;
  });
  const label = () =>
    owned.forEach((entry, index) => {
      const mint = text(entry.mint);
      const token = tokenName(mint);
      const name = token.symbol ?? token.name;
      // A creator's name is marked here too, before the cards are built.
      const cell = rows[index]!.querySelector(".checking-token")!;
      cell.replaceChildren(name ?? short(mint));
      if (name && !token.verified) cell.append(node("span", "unverified", "unverified"));
    });
  label();
  if (owned.length) meter.list(checking);
  const mark = (index: number, view: [ObjectValue, string] | undefined) => {
    const projection = view ? object(view[0].projection) : undefined;
    const [state, kind] = !projection
      ? ["Couldn't read", "unread"]
      : projection.status !== "compiled"
        ? ["As reported", "reported"]
        : array(projection.authorizations ?? []).length
          ? ["Checked", "verified"]
          : ["No approval", "clear"];
    rows[index]!.className = kind;
    rows[index]!.querySelector(".checking-state")!.textContent = state;
  };
  // Names arrive while the accounts are checked; the list is relabelled when they do.
  const naming = nameTokens(
    owned.map((entry) => text(entry.mint)),
    signal,
  )
    .then(label)
    .catch(() => undefined);
  try {
    // A few accounts are observed at once; cards keep the order the RPC listed them in.
    // Public RPCs rate limit, so an account is retried before it is reported as unread.
    const views: ([ObjectValue, string] | undefined)[] = new Array(owned.length);
    // Accounts are observed in batches: the runtime starts and checks the program once per batch.
    const observe = async (sources: string[]) => {
      for (let attempt = 0; ; attempt++) {
        try {
          const observed = await call("/api/live/spl/observe", {
            method: "POST",
            headers: { "X-Velon-Action": "observe", "Content-Type": "application/json" },
            body: JSON.stringify({ sources }),
            signal,
          });
          const reply = object(await result(observed));
          const scope = text(reply.scope_id);
          if (sources.length > 1) batchScopes.add(scope);
          // The server returns each account's view with the observation; an older server does not,
          // and then each view is read on its own, four at a time.
          const bundled = reply.views ? object(reply.views) : {};
          const views: [ObjectValue, string][] = new Array(sources.length);
          let next = 0;
          const read = async () => {
            for (let index = next++; index < sources.length; index = next++) {
              const included = bundled[sources[index]!];
              if (included) {
                views[index] = [object(included), scope];
                continue;
              }
              for (let attempt = 0; ; attempt++) {
                const response = await call(`/api/scopes/${scope}/effective/${sources[index]}`, { signal });
                if (response.status === 429 && attempt < 5) {
                  await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
                  continue;
                }
                if (!response.ok)
                  throw new Error("The observation provider is unavailable. Try scanning again.");
                views[index] = [object(readJson(await response.text())), scope];
                break;
              }
            }
          };
          await Promise.all(Array.from({ length: Math.min(4, sources.length) }, read));
          return views;
        } catch (error) {
          if (signal.aborted || attempt === 3) throw error;
          await new Promise((resolve) => setTimeout(resolve, 1500 * 2 ** attempt));
        }
      }
    };
    // A batch holds one token program's accounts: a program Velon cannot verify makes the whole
    // observation read-only, so it must not take the other program's accounts with it.
    // An account with any other Token-2022 extension is read alone, so if Velon can't model it,
    // it doesn't take the plain accounts with it. The runtime still decides every verdict.
    const plain = (entry: ObjectValue) =>
      array(entry.extensions ?? []).every((extension) => extension === "immutableOwner");
    const batches: number[][] = [];
    for (const program of new Set(owned.map((entry) => String(entry.program)))) {
      const indexes = [...owned.keys()].filter((index) => String(owned[index]!.program) === program);
      const together = indexes.filter((index) => plain(owned[index]!));
      for (let start = 0; start < together.length; start += observeBatch)
        batches.push(together.slice(start, start + observeBatch));
      for (const index of indexes) if (!plain(owned[index]!)) batches.push([index]);
    }
    let done = 0;
    const progress = () => {
      meter.step(1, `${done} of ${owned.length}`);
      meter.share(0.12 + (0.8 * done) / owned.length);
    };
    if (owned.length) progress();
    else meter.step(2);
    // A batch that still fails after its retries is split in half, down to single accounts, so a
    // provider's rate limit costs time rather than the rows of a whole batch.
    const check = async (indexes: number[]): Promise<void> => {
      const results = await observe(indexes.map((index) => text(owned[index]!.source))).catch(() => {
        if (signal.aborted) throw signal.reason;
        return undefined;
      });
      // A batch is one projection, so one account Velon can't model would mark every other one;
      // it is split too. An unverified program version is the same answer for all of them.
      const verdict = results?.[0] ? object(results[0][0].projection) : undefined;
      // A Subscriptions batch spans mints on different token programs, so every refusal is split.
      const mixed =
        verdict !== undefined &&
        verdict.status !== "compiled" &&
        (verdict.reason !== "UnsupportedVersion" || owned[indexes[0]!]!.program === "subscriptions");
      if ((!results || mixed) && indexes.length > 1) {
        const half = Math.ceil(indexes.length / 2);
        await check(indexes.slice(0, half));
        return check(indexes.slice(half));
      }
      indexes.forEach((index, offset) => {
        views[index] = results?.[offset];
        mark(index, views[index]);
      });
      done += indexes.length;
      if (!signal.aborted) progress();
    };
    // Two batches at a time: each is one runtime run and one response.
    let nextBatch = 0;
    const worker = async () => {
      for (let batch = nextBatch++; batch < batches.length; batch = nextBatch++) await check(batches[batch]!);
    };
    await Promise.all(Array.from({ length: Math.min(2, batches.length) }, worker));
    meter.step(2);
    unread = views.filter((view) => !view).length;
    views.forEach((view, index) => {
      const projection = view ? object(view[0].projection) : undefined;
      if (projection && projection.status !== "compiled")
        unsupported.push([owned[index]!, text(projection.reason ?? projection.status)]);
    });
    await naming;
    // The approval a subscription rests on is read from its token account and from the subscription
    // itself; it is one permission, so it is shown once, as the Subscriptions approval it is.
    const found = views.flatMap((entry) =>
      entry
        ? array(object(entry[0].projection).authorizations ?? []).map((item) => ({
            grant: authorization(object(item).authorization),
            availability: text(object(item).availability),
            view: entry[0],
            scope: entry[1],
          }))
        : [],
    );
    for (const { grant } of found)
      if (subscriptionsAuthority(grant))
        named.set(text(object(grant.principal).value), "Solana Subscriptions");
    const holds = (grant: ObjectValue) =>
      `${text(object(grant.resource).id)}:${text(object(grant.principal).value)}`;
    const covered = new Set(
      found.filter(({ grant }) => subscriptionsAuthority(grant)).map(({ grant }) => holds(grant)),
    );
    const shown = new Set<string>();
    for (const { grant, availability, view, scope } of found) {
      last = view;
      const copy = text(object(grant.native_context).protocol) === "spl-token" && covered.has(holds(grant));
      if (copy || shown.has(text(grant.id))) continue;
      shown.add(text(grant.id));
      cards.push(card(grant, view, availability, scope, { address: owner, yours }, true));
    }
  } catch (error) {
    if (!signal.aborted)
      failed(
        error instanceof Error ? error.message : "Your wallet could not be read.",
        () => void scanWallet(owner),
      );
    return false;
  }
  if (signal.aborted) return false;
  badge(network().label);
  // The panel is display only; if it cannot be read, the permissions still are.
  const holdings = await wallet.catch(() => undefined);
  if (signal.aborted) return false;

  const reportedRows = unsupported.map(([entry, reason]) => ({
    reason,
    unlimited: text(entry.amount) === String(UNLIMITED),
    row: reportedRow(
      entry,
      networkReport({
        delegate: text(entry.delegate),
        ui: text(entry.ui),
        unlimited: text(entry.amount) === String(UNLIMITED),
        where: yours ? "your wallet" : "this wallet",
        token: tokenName(text(entry.mint)),
      }),
      explorer("address", text(entry.source)),
      [
        field(
          "Program",
          { "spl-token-2022": "Token-2022", subscriptions: "Solana Subscriptions" }[text(entry.program)] ??
            "SPL Token",
        ),
      ],
    ),
  }));
  const total = cards.length + reportedRows.length;
  const unlimited =
    cards.filter((row) => row.dataset.amount === "∞").length +
    reportedRows.filter((row) => row.unlimited).length;
  const whose = yours ? "your wallet" : "this wallet";
  // The answer first: how many, how many have no limit, and the one thing to do about it.
  const lead = node("section", "", "wallet-summary");
  const primary: HTMLElement[] = [];
  if (total) {
    lead.classList.add(unlimited ? "exposed" : "standing");
    const title = node("h2");
    title.append(
      node("span", String(total), "count"),
      ` ${total === 1 ? "permission" : "permissions"} can take tokens from ${whose}`,
    );
    const subscriptions = cards.filter(
      (row) =>
        row.dataset.system === "subscriptions" &&
        row.classList.contains("derived") &&
        row.dataset.payment === undefined,
    ).length;
    const payments = cards.filter((row) => row.dataset.payment !== undefined).length;
    const stats = node("ul", "", "stats");
    const stat = (count: number, label: string, kind: string) => {
      if (!count) return;
      const item = node("li", "", kind);
      item.append(node("strong", String(count)), label);
      stats.append(item);
    };
    // The same split as one bar: subscriptions, no limit, limited, and those only reported.
    const charging = cards.filter((row) => row.dataset.system === "subscriptions").length;
    const open = cards.filter(
      (row) => row.dataset.system !== "subscriptions" && row.dataset.amount === "∞",
    ).length;
    const parts: [number, string][] = [
      [charging, "sub"],
      [open, "risk"],
      [cards.length - charging - open, "limited"],
      [reportedRows.length, "plain"],
    ];
    stat(unlimited, "with no limit", "risk");
    stat(cards.length - charging - open, "with a limit", "limited");
    stat(subscriptions, subscriptions === 1 ? "subscription" : "subscriptions", "sub");
    stat(payments, payments === 1 ? "payment approval" : "payment approvals", "sub");
    stat(cards.length, "checked by Velon", "ok");
    stat(reportedRows.length, "shown as the network reports", "plain");
    const bar = node("div", "", "composition");
    bar.setAttribute("aria-hidden", "true");
    for (const [count, kind] of parts)
      if (count) {
        const part = node("span", "", kind);
        part.style.flexGrow = String(count);
        bar.append(part);
      }
    const observation = last ? object(last.observation) : undefined;
    lead.append(
      ...(observation
        ? [
            node(
              "p",
              `Finalized slot ${integer(observation.slot).toLocaleString("en-US")}${observation.unix_timestamp == null ? "" : ` · ${when(integer(observation.unix_timestamp))}`}`,
              "proof",
            ),
          ]
        : []),
      title,
      node("p", "Each one lets someone take tokens from it without asking again."),
      bar,
      stats,
    );
    const removable = cards.filter((row) => row.dataset.removable);
    const batch = cards.filter((row) => row.dataset.amount === "∞" && revocable.has(row));
    if (!connected && removable.length) {
      const start = labelled(
        node("button", yours ? "Connect wallet to remove" : "Connect this wallet to remove", "action-button"),
        "wallet",
      );
      start.type = "button";
      start.onclick = () => connectButton.click();
      primary.push(start);
    } else if (batch.length > 1) {
      const all = labelled(node("button", `Review all ${batch.length} unlimited`, "action-button"), "revoke");
      all.type = "button";
      all.onclick = () => {
        const [first, ...rest] = batch.map((row) => revocable.get(row)!);
        queue = rest;
        first!();
      };
      primary.push(all);
    }
  } else {
    if (!unread && !skipped && !subscriptionsUnread) lead.classList.add("clear");
    lead.append(
      node(
        "h2",
        unread || skipped || subscriptionsUnread
          ? `Velon couldn't check all of ${whose}`
          : `No token approvals or subscriptions found on ${whose}`,
      ),
      ...(unread || skipped || subscriptionsUnread
        ? []
        : [
            node(
              "p",
              "Velon checked the token approvals and Solana Subscriptions the network lists for this wallet and found none. Other kinds of permission aren't read yet.",
              "muted",
            ),
          ]),
    );
  }
  const removableRows = cards.filter((row) => row.dataset.removable);
  lead.append(
    nextPanel(
      nextSteps({
        total,
        removable: removableRows.length,
        unlimitedRemovable: removableRows.filter((row) => row.dataset.amount === "∞").length,
        reported: reportedRows.length,
        // Only a subscription waits on its paid period; the approval it rests on is not counted.
        running: cards.filter(
          (row) =>
            row.dataset.system === "subscriptions" &&
            row.classList.contains("derived") &&
            row.dataset.payment === undefined &&
            !row.dataset.removable,
        ).length,
        connected: connected !== undefined,
        owner: connected?.account.address === owner,
        mainnet: control?.network === "mainnet",
        unread: Boolean(unread || skipped || subscriptionsUnread),
      }),
      [...primary, ...again(owner)],
    ),
  );
  content.append(lead);
  if (unread)
    content.append(
      node(
        "p",
        `Velon couldn't read ${unread} of the ${owned.length} approvals and subscriptions it found. Check the wallet again to retry them.`,
        "notice",
      ),
    );
  if (subscriptionsUnread)
    content.append(
      node(
        "p",
        "Velon couldn't list this wallet's Solana Subscriptions right now. Check the wallet again to retry.",
        "notice",
      ),
    );
  if (skipped)
    content.append(
      node(
        "p",
        `The network couldn't describe ${skipped} of this wallet's token account${skipped === 1 ? "" : "s"}, so Velon couldn't check ${skipped === 1 ? "it" : "them"} for approvals.`,
        "notice",
      ),
    );
  // Each row is set against what its account holds now, once the wallet's balances are in.
  for (const row of cards) {
    const held = balances.get(row.dataset.source ?? "");
    const cell = row.querySelector(".row-amount");
    if (!held || !cell || row.dataset.system === "subscriptions") continue;
    const mint = row.dataset.mint ?? "";
    const token = { ...tokenName(mint), decimals: TOKENS[mint]?.decimals ?? held.decimals };
    const limit = row.dataset.limit ? BigInt(row.dataset.limit) : undefined;
    cell.append(node("span", exposure(limit, held.amount, token), "exposure"));
  }
  cards.sort((a, b) => Number(b.dataset.amount === "∞") - Number(a.dataset.amount === "∞"));
  const charging = cards.filter((row) => row.dataset.system === "subscriptions");
  const tokens = cards.filter((row) => row.dataset.system !== "subscriptions");
  const known = tokens.filter((row) => row.dataset.listed);
  const unknown = tokens.filter((row) => !row.dataset.listed);
  if (charging.length) content.append(group(`Subscriptions and payments (${charging.length})`, [], charging));
  const fold = unknown.length > 4;
  if (known.length || (unknown.length && !fold))
    content.append(
      group(
        `Token approvals (${known.length + (fold ? 0 : unknown.length)})`,
        [],
        fold ? known : [...known, ...unknown],
      ),
    );
  if (fold)
    content.append(
      group(
        `Approvals on tokens Velon can't identify (${unknown.length})`,
        [
          "Their names were chosen by whoever created them, so Velon marks them unverified. Unasked-for tokens often arrive with approvals like these.",
        ],
        unknown,
        true,
      ),
    );
  // "None found" is only true when every listed account was actually read and modelled.
  else if (!unread && !skipped && !subscriptionsUnread && control?.testBench)
    content.append(node("p", "Get a test permission above, then remove it here.", "empty"));
  if (reportedRows.length) {
    reportedRows.sort((a, b) => Number(b.unlimited) - Number(a.unlimited));
    const reasons = [...new Set(reportedRows.map(({ reason }) => UNVERIFIED[reason] ?? UNVERIFIED.default!))];
    content.append(
      group(
        `Velon can show these, but can't remove them yet (${reportedRows.length})`,
        reasons,
        reportedRows.map(({ row }) => row),
      ),
    );
  }
  if (holdings) {
    for (const pill of holdings.querySelectorAll<HTMLElement>("[data-delegate]")) {
      const name = named.get(pill.dataset.delegate ?? "");
      if (name) pill.textContent = `${name} can take ${pill.dataset.limit}`;
    }
    content.append(holdings);
  }
  // The fine print comes last: what was read, what wasn't, and the words used.
  const footer = node("section", "", "wallet-footer");
  if (last) footer.append(metadata(last, { read: owned.length - unread, listed: owned.length }));
  footer.append(glossary());
  content.append(footer);
  compareTab(false);
  results.replaceChildren(content);
  notice.replaceChildren();
  reload = () => scanWallet(owner);
  guide(cards.length ? 3 : 2);
  return true;
}

// Test bench: the visitor's own wallet receives a token account, then signs an ordinary
// SPL approval. That approval is test setup; only the revoke goes through Velon's checks.
grantButton.onclick = async () => {
  if (!connected || !control) return;
  const session = connected;
  const say = (message: string) => (document.querySelector("#try-status")!.textContent = message);
  tryPanel.dataset.busy = "";
  grantButton.disabled = true;
  try {
    say("Preparing a test token account…");
    const funded = await call("/api/test/account", {
      method: "POST",
      headers: { "X-Velon-Action": "test", "Content-Type": "application/json" },
      body: JSON.stringify({ owner: session.account.address }),
    });
    const account = object(await result(funded));
    const source = toAddress(text(account.source));
    const rpc = createSolanaRpc(control.rpcUrl, { headers: rpcHeaders(control.rpcUrl) });
    for (let attempt = 0; ; attempt++) {
      const held = await rpc
        .getTokenAccountBalance(source, { commitment: "confirmed" })
        .send({ abortSignal: AbortSignal.timeout(15000) })
        .catch(() => null);
      if (held && held.value.amount !== "0") break;
      if (attempt === 60) throw new Error("The test account did not arrive. Try again.");
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    }
    const allowance = 1n + BigInt(crypto.getRandomValues(new Uint32Array(1))[0]! % 500);
    const data = new Uint8Array(9);
    data[0] = 4;
    new DataView(data.buffer).setBigUint64(1, allowance, true);
    const owner = toAddress(session.account.address);
    const { value: latest } = await rpc
      .getLatestBlockhash({ commitment: "confirmed" })
      .send({ abortSignal: AbortSignal.timeout(15000) });
    const message = appendTransactionMessageInstruction(
      {
        programAddress: toAddress("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        accounts: [
          { address: source, role: 1 },
          { address: toAddress(text(account.delegate)), role: 0 },
          { address: owner, role: 2 },
        ],
        data,
      },
      setTransactionMessageLifetimeUsingBlockhash(
        latest,
        setTransactionMessageFeePayer(owner, createTransactionMessage({ version: "legacy" })),
      ),
    );
    say(`Sign to let a test key take up to ${allowance} of the test token's smallest units. ${walletHint()}`);
    const [signed] = await session.wallet.features["solana:signTransaction"].signTransaction({
      account: session.account,
      transaction: new Uint8Array(getTransactionEncoder().encode(compileTransaction(message))),
      ...chainFor(session.wallet),
    });
    await rpc
      .sendTransaction(
        getBase64EncodedWireTransaction(getTransactionDecoder().decode(signed!.signedTransaction)),
        {
          encoding: "base64",
          preflightCommitment: "confirmed",
        },
      )
      .send({ abortSignal: AbortSignal.timeout(30000) });
    say("Approved. Waiting for the chain to make it final…");
    // Live means the finalized chain reports this delegate with this allowance, not that time passed.
    let finalized = false;
    for (let attempt = 0; attempt < 60 && connected === session && !finalized; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
      try {
        const listed = await call("/api/live/spl/delegated", {}, 10000);
        finalized =
          listed.ok &&
          array(readJson(await listed.text()))
            .map(object)
            .some(
              (entry) =>
                entry.source === source &&
                entry.delegate === account.delegate &&
                entry.amount === String(allowance),
            );
      } catch {
        /* A slow read is retried; only the chain's answer ends the wait. */
      }
    }
    if (!finalized)
      throw new Error(
        "The approval was sent but is not finalized yet, so it is not shown as live. Try again shortly.",
      );
    say(
      (await scanWallet())
        ? "Your permission is live. Remove it below."
        : "Your permission is live on chain, but the wallet couldn't be read. Check it again.",
    );
  } catch (error) {
    say(error instanceof Error ? error.message : "The test permission failed.");
  } finally {
    grantButton.disabled = false;
    delete tryPanel.dataset.busy;
  }
};

// Receipts of verified revokes, kept in this browser and replayable from the journal.
type Receipt = { id: string; signature: string; slot: string; source: string; network: string; at: string };
const receipts = document.querySelector<HTMLElement>("#receipts")!;
const kept = (): Receipt[] => {
  try {
    return JSON.parse(localStorage.getItem("velon:receipts") ?? "[]");
  } catch {
    return [];
  }
};
function remember(receipt: Receipt) {
  try {
    localStorage.setItem("velon:receipts", JSON.stringify([receipt, ...kept()].slice(0, 20)));
  } catch {
    /* Blocked or full storage: the verification ID stays on screen and in the journal. */
  }
}
document.querySelector<HTMLButtonElement>("#receipts-tab")!.onclick = () => {
  if (actionState && ["AWAITING_SIGNATURE", "SUBMITTING", "FINALIZING"].includes(actionState)) return;
  results.hidden = true;
  diff.hidden = true;
  receipts.hidden = false;
  for (const tab of document.querySelectorAll(".tabs button")) tab.classList.remove("selected");
  document.querySelector("#receipts-tab")!.classList.add("selected");
  const list = kept();
  receipts.replaceChildren(node("h2", "Your receipts"));
  if (!list.length)
    receipts.append(
      node("p", "Each time Velon verifies a removal in this browser, its receipt appears here.", "empty"),
    );
  for (const receipt of list) {
    const row = node("article", "", "permission");
    const facts = node("dl");
    facts.append(
      field("Account", receipt.source),
      field("Final at slot", receipt.slot),
      field("Transaction", receipt.signature),
      field("Receipt ID", receipt.id),
    );
    const replay = node("button", "Replay proof", "action-button");
    const outcome = node("span", "", "muted");
    replay.onclick = async () => {
      replay.disabled = true;
      outcome.textContent = "Replaying from the journal…";
      try {
        const response = await call(`/api/verifications/revoke/${receipt.id}`);
        if (response.status === 404) {
          outcome.textContent = "This server doesn't have the record for this receipt.";
          return;
        }
        if (!response.ok) throw new Error();
        const body = await response.text();
        outcome.textContent =
          "Replayed without the chain: the removal and the cleared approval still check out.";
        const save = node("a", "Download evidence", "link-button");
        save.href = URL.createObjectURL(new Blob([body], { type: "application/json" }));
        save.download = `velon-revoke-${receipt.id.slice(0, 12)}.json`;
        actions.append(save);
      } catch {
        outcome.textContent = "Velon couldn't replay this receipt right now. Try again.";
      } finally {
        replay.disabled = false;
      }
    };
    const actions = node("div", "", "permission-actions");
    actions.append(replay, outcome);
    row.append(
      node(
        "h3",
        `Access removed on ${{ mainnet: "mainnet", devnet: "devnet" }[receipt.network] ?? "the test chain"}`,
      ),
      node("p", new Date(receipt.at).toLocaleString(), "remaining"),
      facts,
      actions,
    );
    receipts.append(row);
  }
};

const STATES: Record<ActionState, string> = {
  PREPARING: "Preparing",
  SIMULATED: "Review",
  AWAITING_SIGNATURE: "Waiting for your wallet",
  SUBMITTING: "Sending",
  FINALIZING: "Finalizing",
  VERIFIED: "Removed and verified",
  FAILED: "Not submitted",
};
// Once the helper reaches for sendTransaction, only finalized verification can settle the outcome.
let sendRequested = false;
// Whatever view is on screen knows how to load itself again after a revoke.
let reload: () => Promise<boolean | undefined> = () => scan();
let progress = 0;

// The verified mark draws itself once the chain has been read again.
function seal(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 48 48");
  svg.setAttribute("class", "seal");
  svg.innerHTML = '<circle cx="24" cy="24" r="21" /><path d="M14 24.5 21.5 32 35 17" />';
  return svg;
}

// The diagram is the console's main view: the wallet in the centre, one node per permission.
// It is drawn from the cards on screen, so it can never show something the list does not.
const stage = document.querySelector<HTMLElement>("#stage")!;
const orbit = document.querySelector<SVGSVGElement>("#orbit")!;
const SPOTS = [
  [170, 90],
  [830, 90],
  [170, 290],
  [830, 290],
  [390, 40],
  [610, 340],
] as const;
const still = matchMedia("(prefers-reduced-motion: reduce)");
function draw() {
  const cards = [...results.querySelectorAll<HTMLElement>(".permission[data-id]")].slice(0, SPOTS.length);
  const parts: string[] = [];
  for (const [index, item] of cards.entries()) {
    const [x, y] =
      cards.length === 1
        ? [190, 190]
        : cards.length === 2
          ? [
              [170, 190],
              [830, 190],
            ][index]!
          : SPOTS[index]!;
    const bend = x < 500 ? x + 170 : x - 170;
    const path = `M${x} ${y}C${bend} ${y} ${bend} 190 500 190`;
    const kind = ["spl-token", "token-2022"].includes(item.dataset.system ?? "") ? "spl" : "sub";
    const target = item.dataset.id === stage.dataset.target ? " target" : "";
    parts.push(
      `<g class="branch ${kind}${target}" data-index="${index}" tabindex="0" role="button">` +
        `<path class="link" d="${path}"/>` +
        // CSS cannot stop SMIL, so a visitor who asked for less motion gets still dots.
        `<circle class="dot" r="5">${still.matches ? "" : `<animateMotion dur="${2.2 + index * 0.3}s" repeatCount="indefinite" path="${path}"/>`}</circle>` +
        `<circle class="node" cx="${x}" cy="${y}" r="34"/>` +
        `<text class="amount" x="${x}" y="${y + 5}" text-anchor="middle">${item.dataset.amount || "·"}</text>` +
        `<text x="${x}" y="${y + 58}" text-anchor="middle">${item.dataset.who}</text></g>`,
    );
  }
  const owner = connected ? short(connected.account.address) : "";
  orbit.innerHTML =
    parts.join("") +
    `<rect class="wallet" x="440" y="130" width="120" height="120" rx="34"/>` +
    `<path class="tick" d="M472 184 493 216 530 166"/><text class="owner" x="500" y="290" text-anchor="middle">${owner}</text>`;
  stage.dataset.count = String(cards.length);
  for (const branch of orbit.querySelectorAll<SVGGElement>(".branch")) {
    const item = cards[Number(branch.dataset.index)]!;
    // Named after its card's sentence, set as an attribute so no text is parsed as markup.
    branch.setAttribute("aria-label", item.querySelector("h3")?.textContent ?? "Permission");
    const open = () => {
      item.scrollIntoView({ block: "center", behavior: still.matches ? "auto" : "smooth" });
      item.classList.add("picked");
      setTimeout(() => item.classList.remove("picked"), 1600);
    };
    branch.onclick = open;
    branch.onkeydown = (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      open();
    };
  }
}
still.addEventListener("change", draw);
new MutationObserver(draw).observe(results, { childList: true });
const browse = document.querySelector<HTMLButtonElement>("#browse")!;
const rail = document.querySelector<HTMLElement>(".rail-panel")!;
// On a live console the list is a drawer; while it is closed it is off screen, so it is
// also taken out of the tab order and away from the pointer.
function setBrowse(open: boolean) {
  document.body.classList.toggle("browsing", open);
  browse.setAttribute("aria-expanded", String(open));
  rail.inert = document.body.classList.contains("is-live") && !open;
}
browse.onclick = () => setBrowse(!document.body.classList.contains("browsing"));
addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key === "Escape" && document.body.classList.contains("browsing")) {
    setBrowse(false);
    browse.focus();
  }
});
// Choosing an account closes the list so the result is not covered.
function closeBrowse() {
  setBrowse(false);
}

// Marks how far the visitor is in the three-step guide.
function guide(step: number) {
  for (const [index, item] of [...document.querySelectorAll<HTMLElement>(".guide li")].entries()) {
    item.classList.toggle("done", index + 1 < step);
    item.classList.toggle("now", index + 1 === step);
  }
}

function setAction(state: ActionState, message: string) {
  actionState = state;
  stage.dataset.state = state.toLowerCase();
  actionResult.hidden = false;
  const title = state === "FAILED" && sendRequested ? "Unconfirmed" : STATES[state];
  // Progress through the revoke; a failure leaves the bar where it stopped.
  const reached = [
    "PREPARING",
    "SIMULATED",
    "AWAITING_SIGNATURE",
    "SUBMITTING",
    "FINALIZING",
    "VERIFIED",
  ].indexOf(state);
  if (reached >= 0) progress = reached;
  const steps = node("ol", "", "steps");
  steps.dataset.state = state === "FAILED" ? "failed" : state === "VERIFIED" ? "done" : "busy";
  for (const [index, label] of ["Read", "Review", "Sign", "Send", "Finalize", "Verified"].entries()) {
    const step = node("li", label);
    if (index < progress || state === "VERIFIED") step.className = "done";
    else if (index === progress) step.className = "now";
    steps.append(step);
  }
  actionResult.replaceChildren(steps, node("h2", title), node("p", message));
  if (state === "PREPARING" || state === "FAILED")
    actionResult.scrollIntoView({ behavior: "smooth", block: "nearest" });
  if (state === "VERIFIED") {
    guide(4);
    if (connected && control?.testBench)
      document.querySelector("#try-status")!.textContent =
        "Access removed and verified. Run it again, or replay the proof under Receipts.";
    actionResult.prepend(seal());
  }
  const busy = ["PREPARING", "AWAITING_SIGNATURE", "SUBMITTING", "FINALIZING"].includes(state);
  connectButton.disabled = busy;
  select.disabled = busy;
  scanButton.disabled = busy;
  document
    .querySelectorAll<HTMLButtonElement>(".action-button")
    .forEach((button) => (button.disabled = busy));
}

// What the RPC reports about a sent transaction. Display only: a timeout or error reads as unknown.
async function signatureStatus(
  rpcUrl: string,
  signature: string,
  signal: AbortSignal,
): Promise<{ slot?: unknown; err?: unknown; confirmationStatus?: unknown } | undefined> {
  try {
    const response = await call(
      rpcUrl,
      {
        method: "POST",
        headers: { ...rpcHeaders(rpcUrl), "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getSignatureStatuses",
          params: [[signature]],
        }),
        signal,
      },
      5000,
    );
    if (!response.ok) return undefined;
    const value = (await response.json())?.result?.value?.[0];
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

// Scopes that cover a batch of accounts. A revoke is reviewed against one account's own
// observation, so preparing one from a batch observes that account again first.
const batchScopes = new Set<string>();
// The most accounts the server accepts in one observation (observeBatch in server.ts).
const observeBatch = 25;

async function prepare(scanned: ObjectValue, scope: string) {
  if (
    !control ||
    !connected ||
    (actionState && ["AWAITING_SIGNATURE", "SUBMITTING", "FINALIZING"].includes(actionState))
  )
    return;
  actionAbort?.abort();
  actionAbort = new AbortController();
  const signal = actionAbort.signal;
  const session = connected;
  const config = control;
  const source = text(object(scanned.resource).id);
  const subscription = text(object(scanned.native_context).protocol) === "subscriptions";
  const key = revokeKey(scanned);
  stage.dataset.target = text(scanned.id);
  reviewed = text(scanned.id);
  draw();
  sendRequested = false;
  try {
    setAction("PREPARING", "Reading the account's latest final state…");
    if (!key) throw new Error("This permission has no account Velon can revoke it by.");
    if (batchScopes.has(scope)) {
      const observed = await call("/api/live/spl/observe", {
        method: "POST",
        headers: { "X-Velon-Action": "observe", "Content-Type": "application/json" },
        body: JSON.stringify({ source: key }),
        signal,
      });
      scope = text(object(await result(observed)).scope_id);
    }
    const response = await action(`scopes/${scope}/actions/revoke/${key}`, signal);
    if (response.status === 409)
      throw new Error("The finalized state moved during simulation. Nothing was signed; try again.");
    const simulated = await result(response);
    // The runtime simulated a fresh observation; review that state, not the earlier scan.
    const view = object(await get(`scopes/${scope}/effective/${session.account.address}`, signal));
    signal.throwIfAborted();
    const grant = array(object(view.projection).authorizations ?? [])
      .map((entry) => authorization(object(entry).authorization))
      .find((current) => current.id === scanned.id);
    if (!grant || writeJson(semantic(grant)) !== writeJson(semantic(scanned)))
      throw new Error("This permission changed after the scan. Scan and review again.");
    const stateVersion = text(view.state_version);
    const path = `snapshots/${stateVersion}/actions/revoke/${key}/verify`;
    const prepared = reviewRevoke(simulated, view, grant, session.account.address, config);
    setAction("SIMULATED", "Review what your wallet will sign.");
    const title = node("h2", "You are removing");
    title.tabIndex = -1;
    const known = factsFor(grant, view, { address: session.account.address, yours: true });
    review.replaceChildren(
      title,
      node("p", sentence(grant, known), "review-lead"),
      node(
        "p",
        "Your wallet will ask you to sign exactly this change. Check the network fee in your wallet before you confirm.",
        "muted",
      ),
    );
    if (walletHint()) review.append(node("p", walletHint(), "notice"));
    if (config.network === "mainnet")
      review.append(
        node(
          "p",
          "This is mainnet. The fee is about 0.000015 SOL, and nothing else leaves your wallet.",
          "notice",
        ),
      );
    const principal = object(grant.principal);
    const summary = node("dl", "", "facts");
    // The face names the token too, so two reviews for one holder never read the same.
    const mint = assetMint(grant);
    const label = mint ? tokenName(mint) : undefined;
    const named = label?.symbol ?? label?.name;
    summary.append(
      principal.kind === "identity"
        ? address("Who", text(principal.value), "holder")
        : field("Who", principalLabel(grant.principal)),
      field(
        "Token",
        `${named ? `${named}${label!.verified ? "" : " (name set by its creator, not verified)"} · ` : ""}${mint ? `mint ${short(mint)} · ` : ""}account ${short(source)}`,
      ),
      field(
        "What changes",
        subscription && paymentApproval(grant)
          ? `The payment approval is closed, so ${who(grant, known, true)} can't take any more, and its SOL deposit goes back to whoever paid for it. The approval Solana Subscriptions holds on this account stays.`
          : subscription
            ? "The ended subscription's record is closed, and its SOL deposit goes back to whoever paid for it. The approval Solana Subscriptions holds on this account stays."
            : `The approval for ${who(grant, known, true)} is cleared. Nothing else changes.`,
      ),
      field("Network", network().label),
    );
    const more = node("dl", "", "facts");
    more.append(
      address("Token account", source),
      field("Limit", allowance(source, integer(object(grant.usage).remaining), mintOf(grant))),
      field("Program", system(grant)),
      field("Program build", "Verified"),
    );
    if (config.network === "mainnet")
      more.append(field("Fee", "The 5,000-lamport base fee plus a fixed 10,000-lamport priority fee"));
    const details = node("details", "", "technical");
    details.append(
      node("summary", "Technical details"),
      more,
      raw("View technical evidence", prepared.evidence),
    );
    const confirm = node("button", "Confirm in wallet", "action-button");
    const cancel = node("button", "Cancel", "link-button");
    cancel.onclick = () => {
      invalidateReview();
      actionResult.hidden = true;
    };
    review.append(summary, details, confirm, cancel);
    review.showModal();
    title.focus({ preventScroll: true });
    review.scrollTop = 0;
    confirm.onclick = async () => {
      confirm.disabled = true;
      // Keep the diagram in view while it follows the transaction.
      scrollTo({ top: 0, behavior: "smooth" });
      let submittedSignature: string | undefined;
      try {
        const latest = object(await get(`scopes/${scope}`, signal));
        if (latest.id !== stateVersion)
          throw new Error("Permission evidence changed. Scan and review again.");
        signal.throwIfAborted();
        if (connected !== session) throw new Error("Wallet changed. Review again.");
        review.close();
        const sent = await signAndSubmitReviewedTransaction(
          new Proxy(createSolanaRpc(config.rpcUrl, { headers: rpcHeaders(config.rpcUrl) }), {
            get(rpc, method, receiver) {
              if (method === "sendTransaction") sendRequested = true;
              return Reflect.get(rpc, method, receiver);
            },
          }),
          prepared.bytes,
          async (bytes) => {
            signal.throwIfAborted();
            if (connected !== session) throw new Error("Wallet changed. Review again.");
            setAction("AWAITING_SIGNATURE", "Confirm the removal in your wallet.");
            const signed = await session.wallet.features["solana:signTransaction"].signTransaction({
              account: session.account,
              transaction: bytes,
              ...chainFor(session.wallet),
            });
            signal.throwIfAborted();
            if (connected !== session || signed.length !== 1)
              throw new Error("Wallet signing response changed.");
            const current = object(await get(`scopes/${scope}`, signal));
            if (current.id !== stateVersion)
              throw new Error("Permission evidence changed while signing. Review again.");
            setAction("SUBMITTING", "Sending exactly the transaction you reviewed…");
            return signed[0]!.signedTransaction;
          },
          { ...prepared, abortSignal: signal },
        );
        submittedSignature = sent.signature;
        setAction(
          "FINALIZING",
          sent.status === "unknown"
            ? "Velon didn't get a clear answer after sending, so it is checking the chain without sending again."
            : "Waiting for the chain to make it final, then Velon checks again…",
        );
        actionResult.append(link("Transaction", sent.signature));
        const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 2000));
        let landed = false;
        for (let attempt = 0; attempt < 60; attempt++) {
          signal.throwIfAborted();
          // Access ends when the revoke lands, about a second after sending; finality, about 13
          // seconds, is only when Velon can prove it. The RPC's status is shown, never trusted.
          if (!landed) {
            const status = await signatureStatus(config.rpcUrl, sent.signature, signal);
            if (status?.err)
              throw new Error(
                `The network reports that the revoke failed (${JSON.stringify(status.err)}). Nothing was removed; the permission is still active.`,
              );
            if (status && ["confirmed", "finalized"].includes(String(status.confirmationStatus))) {
              landed = true;
              setAction(
                "FINALIZING",
                `${sent.status === "unknown" ? "Velon didn't get a clear answer after sending, but the network reports that the removal landed. " : ""}Access removed. The removal is confirmed on ${network().label.toLowerCase()} at slot ${status.slot}. Velon is waiting for it to be final to verify it and issue the receipt.`,
              );
              actionResult.append(link("Transaction", sent.signature));
            }
          }
          // The transaction is already sent. Not finalized yet, a busy gateway, an unavailable
          // provider or a dropped connection are asked again; any other answer is final.
          const response = await action(path, signal, sent.signedTransaction).catch((error) => {
            if (signal.aborted) throw error;
            return undefined;
          });
          if (!response || [404, 429, 502, 503, 504].includes(response.status)) {
            await pause();
            continue;
          }
          const verification = await result(response);
          const current = await get(`scopes/${scope}`, signal).catch((error) => {
            if (signal.aborted) throw error;
            return undefined;
          });
          if (!current) {
            await pause();
            continue;
          }
          const checked = verifiedRevoke(
            verification,
            current,
            stateVersion,
            text(grant.id),
            sent.signedTransaction,
          );
          // The revoked card leaves the page before the fresh state replaces it.
          const gone = [...results.querySelectorAll<HTMLElement>(".permission")].find(
            (item) => item.dataset.id === grant.id,
          );
          gone?.classList.add("leaving");
          stage.dataset.state = "cut";
          if (gone) await new Promise<void>((resolve) => setTimeout(resolve, 1200));
          // The receipt and the result come first; refreshing the list is display only.
          remember({
            id: checked.id,
            signature: sent.signature,
            slot: String(checked.slot),
            source: key,
            network: config.network,
            at: new Date().toISOString(),
          });
          setAction(
            "VERIFIED",
            `Velon read the chain again once it was final: the access is gone on ${network().label.toLowerCase()}.`,
          );
          actionResult.append(
            link("Transaction", sent.signature),
            field("Final at slot", String(checked.slot)),
            field("Receipt ID", checked.id),
          );
          if (!(await reload().catch(() => false)))
            actionResult.append(
              node(
                "p",
                "The removal is verified. The list couldn't be refreshed; check the wallet again to see it.",
                "notice",
              ),
            );
          // The next queued revoke opens only when the visitor asks for it.
          const after = node("div", "", "next-actions");
          if (queue.length) {
            const next = labelled(
              node("button", `Review next · ${queue.length} left`, "action-button"),
              "revoke",
            );
            next.type = "button";
            next.onclick = () => queue.shift()?.();
            after.append(next);
          }
          after.append(
            act("Back to the list", undefined, "link-button", () =>
              results.scrollIntoView({ behavior: "smooth", block: "start" }),
            ),
            act("See receipts", "receipt", "link-button", () =>
              document.querySelector<HTMLButtonElement>("#receipts-tab")!.click(),
            ),
          );
          actionResult.append(after);
          return;
        }
        throw new Error(
          "Finalization is still unconfirmed. Keep the transaction signature; do not assume either outcome or submit again.",
        );
      } catch (error) {
        review.close();

        const reason = error instanceof Error ? error.message : "Revoke verification failed.";
        setAction(
          "FAILED",
          /message|changed/i.test(reason) && !sendRequested
            ? `Your wallet altered the transaction before signing, so Velon did not send it. Set the wallet to ${network().label} and try again.`
            : reason,
        );
        if (submittedSignature) actionResult.append(field("Transaction", submittedSignature));
        actionResult.append(recovery());
      }
    };
  } catch (error) {
    if (signal.aborted) return;
    const reason = error instanceof Error ? error.message : "Simulation failed.";
    // The Subscriptions program lets a subscriber remove a delegation only once it is cancelled
    // and its paid period has ended; the runtime refuses anything else before a signature.
    const subscription = object(scanned.native_context).protocol === "subscriptions";
    setAction(
      "FAILED",
      subscription && reason === "UnsupportedOperation"
        ? "This subscription can't be removed yet. The Subscriptions program only allows it after the subscription is cancelled and its paid period has ended. Nothing was signed."
        : reason,
    );
    actionResult.append(recovery());
  }
}

// A removal that stopped offers a fresh read. Once anything was sent, the outcome stays on screen.
function recovery(): HTMLElement {
  const row = node("div", "", "next-actions");
  row.append(
    act("Check the wallet again", "refresh", "link-button", () => {
      if (!sendRequested) actionResult.hidden = true;
      void reload();
    }),
  );
  if (!sendRequested) row.append(act("Close", undefined, "link-button", () => (actionResult.hidden = true)));
  return row;
}

// The ways to look again: the same wallet, another one, or a link to this answer.
function again(owner: string): HTMLElement[] {
  if (!document.body.classList.contains("public"))
    return [act("Check again", "refresh", "link-button", () => void reload())];
  const share = act("Copy link", "link", "link-button", async () => {
    const url = `${location.origin}${location.pathname}#${owner}`;
    const done = await navigator.clipboard?.writeText(url).then(
      () => true,
      () => false,
    );
    tip(share, done ? "Link copied" : "Copy it from the address bar");
  });
  return [
    act("Check again", "refresh", "link-button", () => checkWallet(owner, false)),
    act("Check another wallet", "search", "link-button", anotherWallet),
    share,
  ];
}

function anotherWallet() {
  lookupInput.value = "";
  scrollTo({ top: 0, behavior: "smooth" });
  lookupInput.focus({ preventScroll: true });
}
review.addEventListener("cancel", invalidateReview);
// A dismissed review hands focus back to the card it came from, or to the list if it is gone.
review.addEventListener("close", () => {
  if (actionState !== undefined) return;
  const row = [...results.querySelectorAll<HTMLElement>(".permission[data-id]")].find(
    (item) => item.dataset.id === reviewed,
  );
  const target =
    row?.querySelector<HTMLElement>(".action-button:not(:disabled)") ??
    results.querySelector<HTMLElement>("h2");
  if (target && target.tagName !== "BUTTON") target.tabIndex = -1;
  target?.focus();
});

// Mainnet and devnet consoles are for real wallets: a lookup first, no recorded fixtures.
function publicMode() {
  if (!control || control.testBench) return;
  lookup.hidden = false;
  document.querySelector<HTMLElement>("#recorded")!.hidden = true;
  document.body.classList.add("public");
}

// The first screen explains the three ideas the rest of the console relies on.
function lesson() {
  compareTab(false);
  results.replaceChildren();
  // On a public cluster, looking needs nothing; removing needs the owner's wallet.
  if (control && !control.testBench && !connected) {
    document.body.classList.toggle("first-screen", !kept().length);
    const panel = node("section", "", "start");
    panel.append(
      node(
        "p",
        `See who can take tokens from any ${network().label.toLowerCase()} wallet, how much, and what they have already charged. Looking signs nothing.`,
        "start-lead",
      ),
    );
    const recent = recentChecks();
    if (recent.length) panel.append(recentRow(recent));
    // The whole journey up front, so no step comes as a surprise.
    const how = node("ol", "", "how");
    for (const [title, line] of [
      ["Paste an address", "Velon reads the chain's final state. There is nothing to sign."],
      [
        "See who can take what",
        "Every approval and subscription in plain words: who, how much, and what it has charged.",
      ],
      [
        "Remove what you don't use",
        "Connect the wallet and sign each removal. Velon proves it on chain and keeps a receipt.",
      ],
    ] as const) {
      const item = node("li");
      item.append(node("strong", title), node("span", line));
      how.append(item);
    }
    const start = labelled(node("button", "Connect your wallet", "link-button"), "wallet");
    start.type = "button";
    start.onclick = () => connectButton.click();
    how.lastElementChild!.append(start);
    panel.append(how);
    results.append(panel);
  }
  badge(network().label);
}

// Wallets checked in this browser, one click from being checked again.
function recentRow(addresses: string[]): HTMLElement {
  const row = node("div", "", "recent");
  row.append(node("span", "Recent", "eyebrow"));
  for (const address of addresses) {
    const chip = node("button", "", "recent-chip");
    chip.type = "button";
    chip.title = address;
    chip.append(avatar(address), short(address));
    chip.onclick = () => checkWallet(address);
    row.append(chip);
  }
  row.append(
    act("Clear", undefined, "link-button", () => {
      forgetChecks();
      refreshRecent();
      row.remove();
    }),
  );
  return row;
}

function refreshRecent() {
  document.querySelector("#recent-wallets")?.replaceChildren(
    ...recentChecks().map((address) => {
      const option = node("option");
      option.value = address;
      return option;
    }),
  );
}

// The address in the URL is the one on screen, so a check can be linked, shared and gone back to.
let routed = "";
function checkWallet(address: string, push = true) {
  lookupInput.value = address;
  if (document.body.classList.contains("public")) {
    if (push && routed !== address) history.pushState(null, "", `#${address}`);
    routed = address;
    rememberCheck(address);
    refreshRecent();
  }
  openLive(address);
}

// Back to the first screen, with nothing left running.
function home() {
  request?.abort();
  lookupInput.value = "";
  input.value = "";
  notice.replaceChildren();
  receipts.hidden = true;
  results.hidden = false;
  document.querySelector("#receipts-tab")!.classList.remove("selected");
  document.querySelector("#scan-tab")!.classList.add("selected");
  lesson();
}

// A signature the visitor can open on Solana Explorer.
function link(title: string, signature: string): HTMLElement {
  const row = field(title, "");
  const anchor = labelled(node("a", short(signature)), "external");
  anchor.href = explorer("tx", signature);
  anchor.target = "_blank";
  anchor.rel = "noreferrer";
  row.querySelector("dd")!.append(anchor);
  return row;
}

// A row from another cluster is shown as its RPC reports it. This console holds evidence only
// for its own cluster, so nothing here is presented as a verified permission or revocable.
let publicNet: "devnet" | "mainnet" = "devnet";
// What subscribing to a plan allows, read from the plan account. An integrator can link a checkout
// here, so the wallet's "any amount" warning comes with the plan's real limits next to it.
async function showPlan(planKey: string): Promise<boolean> {
  const response = await call("/api/live/plan", {
    method: "POST",
    headers: { "X-Velon-Action": "observe", "Content-Type": "application/json" },
    body: JSON.stringify({ plan: planKey }),
  }).catch(() => undefined);
  if (!response?.ok) return false;
  const body = object(readJson(await response.text()));
  const mint = text(body.mint);
  await nameTokens([mint]).catch(() => undefined);
  const named = tokenName(mint);
  const decimals =
    TOKENS[mint]?.decimals ?? (body.decimals == null ? undefined : Number(integer(body.decimals)));
  const token = { ...named, decimals };
  const terms = {
    amount: amountOf(body.amount),
    periodHours: amountOf(body.periodHours),
    endTs: integer(readJson(text(body.endTs))),
    destinations: array(body.destinations).map(text),
  };
  const content = document.createDocumentFragment();
  const lead = node("section", "", "wallet-summary");
  const name = planName(text(body.metadataUri));
  lead.append(
    node("h2", "What subscribing to this plan allows"),
    ...(name ? [node("p", `“${name}”, a name set by the merchant and not verified`, "plan-name")] : []),
    tokenChip(mint, "plan-token"),
    node("p", planSentence(terms, token), "plan-lead"),
    node("p", planChanges(terms), "muted"),
  );
  const why = node("section", "", "plan-why");
  why.append(node("h3", "Why your wallet may say it can take any amount"));
  for (const line of planApproval(terms, token)) why.append(node("p", line));
  const facts = node("dl", "", "facts plan-facts");
  facts.append(
    address("Merchant (plan owner)", text(body.owner), "merchant"),
    ...array(body.pullers).map((key) => address("Can also charge", text(key), "puller")),
    ...(terms.destinations.length
      ? terms.destinations.map((key) => address("Payments go to", key, "destination"))
      : [field("Payments go to", "Any wallet; the plan doesn't limit it")]),
    field(
      "New subscribers",
      body.open === true ? "Open" : "Closed; existing subscriptions run to the end date",
    ),
    field("Ends", terms.endTs === 0n ? "No end date" : (when(terms.endTs) ?? "Unknown")),
    field("Subscribers on chain", String(integer(body.subscribers))),
    field(
      "Program",
      body.verifiedBuild
        ? `Solana Subscriptions, a build Velon verified from ${text(body.verifiedBuild)}`
        : "Solana Subscriptions, not a build Velon has verified",
    ),
    body.upgradeAuthority
      ? address("Can upgrade the program", text(body.upgradeAuthority), "upgrade authority")
      : field("Can upgrade the program", "No one; it is immutable"),
  );
  if (text(body.metadataUri) && !name)
    facts.append(field("Merchant's own description (not verified)", text(body.metadataUri)));
  const next = nextPanel(
    [
      "If you subscribe, check your wallet here afterwards to see the subscription and every charge it makes.",
    ],
    again(planKey),
  );
  content.append(lead, why, facts, next);
  mode = "scan";
  diff.hidden = true;
  receipts.hidden = true;
  results.hidden = false;
  notice.replaceChildren();
  compareTab(false);
  results.replaceChildren(content);
  badge(network().label);
  return true;
}

function showMainnet(entry: ObjectValue) {
  const net = publicNet;
  const name = net === "devnet" ? "Devnet" : "Mainnet";
  closeBrowse();
  const row = unverified(
    entry,
    networkReport({
      by: name,
      delegate: text(entry.delegate),
      ui: text(entry.ui),
      unlimited: text(entry.amount) === String(UNLIMITED),
      where: `an account owned by ${short(text(entry.owner))}`,
      token: tokenName(text(entry.mint)),
    }),
    `This is what ${net} reported a moment ago. This console checks and removes access on ${network().label.toLowerCase()}; open Velon on ${net} to act on it.`,
    `https://explorer.solana.com/address/${text(entry.source)}${net === "devnet" ? "?cluster=devnet" : ""}`,
    [field("Network", `Solana ${net}`)],
  );
  mode = "scan";
  diff.hidden = true;
  results.hidden = false;
  actionResult.hidden = true;
  notice.replaceChildren();
  compareTab(false);
  results.replaceChildren(node("h2", `Seen on ${net}`), row);
  badge(`${name}, read only`);
  guide(2);
  if (innerWidth < 960) results.scrollIntoView({ block: "start" });
}

async function watchMainnet() {
  const list = document.querySelector<HTMLElement>("#mainnet-feed")!;
  const mode = document.querySelector<HTMLElement>("#mainnet-mode")!;
  let shown = "";
  // Rows on the console's own cluster can be verified and revoked; others are only reported.
  const choose = (choice: HTMLButtonElement) => {
    publicNet = choice.dataset.net as typeof publicNet;
    shown = "";
    list.replaceChildren(node("p", `Reading recent ${publicNet} blocks…`, "muted"));
    for (const other of document.querySelectorAll(".segmented button"))
      other.classList.toggle("selected", other === choice);
    mode.textContent = control?.network === publicNet ? "Check and remove" : "Read only";
  };
  for (const choice of document.querySelectorAll<HTMLButtonElement>(".segmented button")) {
    choice.onclick = () => choose(choice);
    if (choice.dataset.net === control?.network) choose(choice);
  }
  for (;;) {
    try {
      const response = await call(`/api/${publicNet}/delegated`);
      if (response.status === 404) {
        // A network the server was not given is removed from the choice, not shown empty.
        const missing = document.querySelector<HTMLElement>(`.segmented [data-net="${publicNet}"]`)!;
        if (missing.hidden) return;
        missing.hidden = true;
        choose(
          document.querySelector<HTMLButtonElement>(
            `.segmented [data-net="${publicNet === "devnet" ? "mainnet" : "devnet"}"]`,
          )!,
        );
        continue;
      }
      const raw = await response.text();
      if (response.ok && raw !== shown) {
        shown = raw;
        document.querySelector<HTMLElement>("#mainnet")!.hidden = false;
        const rows = array(readJson(raw)).map(object);
        list.replaceChildren(
          ...rows.map((entry) => {
            const row = node("button", "", "feed-row");
            row.type = "button";
            const amount =
              text(entry.amount) === String(UNLIMITED) ? "any amount" : `up to ${text(entry.ui)}`;
            row.append(
              node("span", short(text(entry.owner)), "address"),
              node("span", `${short(text(entry.delegate))} can take ${amount}`, "muted"),
            );
            row.onclick = () => {
              for (const other of document.querySelectorAll(".feed-row"))
                other.removeAttribute("aria-current");
              row.setAttribute("aria-current", "");
              // On the cluster this console runs on, the row opens the verified flow.
              if (control?.network === publicNet) openLive(text(entry.source));
              else showMainnet(entry);
            };
            return row;
          }),
        );
        if (!rows.length)
          list.append(
            node("p", `No token approvals in the recent ${publicNet} blocks read so far.`, "muted"),
          );
      }
    } catch {
      /* The next poll retries. */
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5000));
  }
}

// A listed account is only a lead: opening it observes it through the runtime first.
function openLive(source: string) {
  const live = scenarios.findIndex((scenario) => scenario.live);
  if (live < 0 || select.disabled) return;
  closeBrowse();
  select.value = String(live);
  selectScenario();
  input.value = source;
  setMode("scan", true);
}

const feed = document.querySelector<HTMLElement>("#feed")!;
const bench = document.querySelector<HTMLButtonElement>("#new-permission")!;
// Lists what the validator reports as delegated right now. Discovery is not evidence:
// choosing a row observes that account through the runtime before anything is shown.
async function watch() {
  document.querySelector<HTMLElement>("#live")!.hidden = false;
  bench.hidden = !control?.testBench || !!connected;
  tryPanel.hidden = !control?.testBench;
  let shown = "";
  for (;;) {
    try {
      const response = await call("/api/live/spl/delegated");
      if (response.status === 404) return;
      const raw = await response.text();
      if (response.ok && raw !== shown) {
        const before = new Set(
          [...feed.querySelectorAll<HTMLElement>(".feed-row")].map((row) => row.dataset.source),
        );
        const first = shown === "";
        shown = raw;
        const rows = array(readJson(raw)).map(object);
        feed.replaceChildren(
          ...rows.map((entry) => {
            const row = node("button", "", "feed-row");
            row.type = "button";
            row.dataset.source = text(entry.source);
            if (!first && !before.has(row.dataset.source)) row.classList.add("fresh");
            row.toggleAttribute("aria-current", input.value === row.dataset.source);
            const amount = integer(readJson(text(entry.amount))).toLocaleString("en-US");
            row.append(
              node("span", short(text(entry.source)), "address"),
              node("span", `${short(text(entry.delegate))} can take up to ${amount} smallest units`, "muted"),
            );
            if (connected && entry.owner === connected.account.address)
              row.append(node("span", "Yours", "badge"));
            row.onclick = () => openLive(text(entry.source));
            return row;
          }),
        );
        if (!rows.length) feed.append(node("p", "No delegated token accounts right now.", "muted"));
      }
    } catch {
      /* The next poll retries. */
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 3000));
  }
}

bench.onclick = async () => {
  bench.disabled = true;
  bench.textContent = "Approving on chain…";
  try {
    const response = await call("/api/live/spl/approve", {
      method: "POST",
      headers: { "X-Velon-Action": "test" },
    });
    const outcome = object(await result(response));
    status(`Approving ${text(outcome.allowance)} base units on chain. It appears below once finalized.`);
  } catch (error) {
    status(error instanceof Error ? error.message : "The test approval failed.", true);
  } finally {
    bench.disabled = false;
    bench.textContent = "Add a demo permission";
  }
};

form.onsubmit = (event) => {
  event.preventDefault();
  closeBrowse();
  setMode("scan", true);
};
// On a public cluster the first thing a visitor can do is look up any wallet.
const lookup = document.querySelector<HTMLFormElement>("#lookup")!;
const lookupInput = document.querySelector<HTMLInputElement>("#lookup-address")!;
lookup.noValidate = true;
lookup.onsubmit = (event) => {
  event.preventDefault();
  const address = lookupInput.value.trim();
  if (!address) {
    lookupInput.focus();
    return status("Paste a wallet address to check it.");
  }
  if (!isAddress(address))
    return status(
      "That isn't a Solana address. A wallet or token account address is 32 to 44 letters and numbers.",
      true,
    );
  checkWallet(address);
};
select.onchange = selectScenario;
document.querySelector<HTMLButtonElement>("#scan-tab")!.onclick = () => setMode("scan");
document.querySelector<HTMLButtonElement>("#diff-tab")!.onclick = () => setMode("diff");
try {
  const [scenarioData, controlData] = await Promise.all([get("scenarios"), get("control")]);
  if (controlData !== null) {
    const config = object(controlData);
    if (config.network !== "mainnet" && config.network !== "devnet" && config.network !== "localnet")
      throw new Error("Unsupported control network.");
    const rpcUrl = new URL(text(config.rpcUrl));
    if (!["http:", "https:"].includes(rpcUrl.protocol)) throw new Error("Invalid public RPC URL.");
    // The other consoles are checked again here, so only a known network on a safe link is offered.
    const elsewhere = otherConsoles(
      array(config.elsewhere ?? [])
        .map(object)
        .map((entry) => `${text(entry.network)}=${text(entry.url)}`)
        .join(","),
      config.network,
    );
    control = {
      cluster: text(config.cluster),
      rpcUrl: rpcUrl.href,
      network: config.network,
      testBench: config.testBench === true,
      elsewhere,
    };
    // A phone's wallet apps are reached once the network is known; the test chain has none.
    if (control.network !== "localnet")
      registerPhoneWallets(
        network().chain as `solana:${string}`,
        new URL(velonIcon, location.href).pathname.slice(1),
        () => noWallet(true),
      );
  }
  const manifest = array(scenarioData);
  scenarios = manifest.map((value) => {
    const scenario = object(value);
    return {
      name: text(scenario.name),
      scope: text(scenario.scope),
      live: scenario.live === true,
      snapshots: array(scenario.snapshots).map((value) => ({
        id: text(object(value).id),
        slot: text(object(value).slot),
      })),
      examples: array(scenario.examples).map((value) => ({
        label: text(object(value).label),
        address: text(object(value).address),
      })),
    };
  });
  if (scenarios.length === 0) throw new Error("No native observations have been loaded.");
  select.replaceChildren(
    ...scenarios.map((scenario, index) => {
      const option = node("option", scenario.name);
      option.value = String(index);
      return option;
    }),
  );
  select.disabled = false;
  scanButton.disabled = false;
  refreshWallets();
  // A link from the product page names the account to open.
  const linked = decodeURIComponent(location.hash.slice(1));
  const live = scenarios.findIndex((scenario) => scenario.live);
  if (live >= 0 && isAddress(linked)) {
    document.body.classList.add("is-live");
    setBrowse(false);
    publicMode();
    select.value = String(live);
    selectScenario();
    input.value = linked;
    lookupInput.value = linked;
    routed = linked;
    rememberCheck(linked);
    setMode("scan", true);
  } else if (live >= 0) {
    select.value = String(live);
    document.body.classList.add("is-live");
    setBrowse(false);
    publicMode();
    lesson();
    draw();
  } else {
    // Without a live chain the recorded examples are the whole console, so show them open.
    for (const panel of document.querySelectorAll<HTMLDetailsElement>("details.search-panel"))
      panel.open = true;
    selectScenario();
  }
  if (control?.network === "localnet") void watch();
  // The public console has no drawer to feed, so it doesn't poll for recent approvals.
  if (!document.body.classList.contains("public")) void watchMainnet();
  refreshRecent();
  // A pasted link, Back and Forward all open the address the URL names, or the first screen.
  const route = () => {
    const next = decodeURIComponent(location.hash.slice(1));
    if (next === routed || !document.body.classList.contains("public")) return;
    routed = next;
    if (isAddress(next)) checkWallet(next, false);
    else home();
  };
  addEventListener("hashchange", route);
  addEventListener("popstate", route);
} catch (error) {
  status(error instanceof Error ? error.message : "Observations are unavailable.", true);
}
