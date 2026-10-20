import {
  array,
  authorization,
  integer,
  KINDS,
  meaning,
  object,
  permissionLabel,
  principalLabel,
  readJson,
  STATUS,
  system,
  text,
  type ObjectValue,
} from "./wire.ts";

document.documentElement.classList.add("js");

const title = document.querySelector<HTMLElement>("#live-title")!;
const count = document.querySelector<HTMLElement>("#live-count")!;
const rows = document.querySelector<HTMLElement>("#live-rows")!;
const note = document.querySelector<HTMLElement>("#live-note")!;
const short = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

function row(href: string, left: string, right: string): HTMLAnchorElement {
  const link = document.createElement("a");
  link.href = href;
  for (const [value, className] of [
    [left, "address"],
    [right, "amount"],
  ] as const) {
    const cell = document.createElement("span");
    cell.textContent = value;
    cell.className = className;
    link.append(cell);
  }
  return link;
}

async function json(path: string) {
  const response = await fetch(`/api/${path}`);
  if (!response.ok) throw new Error(path);
  return readJson(await response.text());
}

async function liveNetwork() {
  const control = object(await json("control"));
  if (control.network === "localnet") return "Local validator";
  if (control.network === "devnet") return "Devnet";
  throw new Error("Unsupported live network");
}

// The panel shows what the server can read right now: a live ledger when one is wired,
// otherwise the recorded native evidence. Nothing here is typed into the page.
async function live() {
  const network = await liveNetwork();
  let shown = "";
  for (;;) {
    const response = await fetch("/api/live/spl/delegated");
    if (!response.ok) throw new Error("no live ledger");
    const raw = await response.text();
    if (raw !== shown) {
      shown = raw;
      const found = array(readJson(raw)).map(object);
      title.textContent = "Delegated right now";
      count.textContent = String(found.length);
      rows.replaceChildren(
        ...found
          .slice(0, 5)
          .map((entry: ObjectValue) =>
            row(
              `/app#${text(entry.source)}`,
              `${short(text(entry.delegate))} → ${short(text(entry.source))}`,
              integer(readJson(text(entry.amount))).toLocaleString("en-US"),
            ),
          ),
      );
      note.textContent = found.length
        ? `${network}. Open one to observe it with evidence.`
        : `${network}. No delegated accounts right now.`;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 3000));
  }
}

async function recorded() {
  const scenarios = array(await json("scenarios"))
    .map(object)
    .filter((scenario) => scenario.live !== true);
  title.textContent = "Recorded native evidence";
  count.textContent = String(scenarios.length);
  rows.replaceChildren(
    ...scenarios.map((scenario) =>
      row(
        "/app",
        text(scenario.name),
        `slot ${text(object(array(scenario.snapshots).at(-1) ?? {}).slot ?? "live")}`,
      ),
    ),
  );
  note.textContent = "Accounts captured from executed native tests.";
  // Without a chain behind this copy, the page must not promise the live flow.
  document.querySelector(".closing h2")!.textContent = "Explore the recorded evidence.";
  document.querySelector(".table .entry .extra p")!.textContent =
    "Who can spend from a token account and how much. Revoke runs against a live chain; this hosted copy shows recorded evidence only.";
}

live()
  .catch(recorded)
  .catch(() => {
    title.textContent = "Evidence unavailable";
  });

const seen = new IntersectionObserver(
  (entries) => {
    for (const entry of entries)
      if (entry.isIntersecting) {
        entry.target.classList.add("in");
        seen.unobserve(entry.target);
      }
  },
  { threshold: 0.05 },
);
for (const section of document.querySelectorAll("main > section, .bento article")) seen.observe(section);

// The showcase is Velon's real output: one permission observed through the runtime,
// rendered with the same words the console uses. Nothing in the card is typed into the page.
type Shown = { grant: ObjectValue; availability: string; slot: string; where: string; origin: string };

function element(tag: string, content = "", className = "") {
  const made = document.createElement(tag);
  made.textContent = content;
  made.className = className;
  return made;
}

async function observed(): Promise<Shown[]> {
  const listed = await fetch("/api/live/spl/delegated");
  if (listed.ok) {
    const network = await liveNetwork();
    const shown: Shown[] = [];
    for (const entry of array(readJson(await listed.text()))
      .map(object)
      .slice(0, 2)) {
      const source = text(entry.source);
      const response = await fetch("/api/live/spl/observe", {
        method: "POST",
        headers: { "X-Velon-Action": "observe", "Content-Type": "application/json" },
        body: JSON.stringify({ source }),
      });
      if (!response.ok) continue;
      const scope = text(object(readJson(await response.text())).scope_id);
      const view = object(await json(`scopes/${scope}/effective/${source}`));
      const first = object(array(object(view.projection).authorizations ?? [])[0]);
      shown.push({
        grant: authorization(first.authorization),
        availability: text(first.availability),
        slot: String(integer(object(view.observation).slot)),
        origin: text(object(view.observation).origin),
        where: network,
      });
    }
    if (shown.length) return shown;
  }
  // Without a live chain, the recorded native evidence is what Velon has read.
  const shown: Shown[] = [];
  for (const scenario of array(await json("scenarios")).map(object)) {
    const example = object(array(scenario.examples)[0] ?? {}).address;
    if (!scenario.scope || typeof example !== "string") continue;
    const view = object(await json(`scopes/${text(scenario.scope)}/effective/${example}`));
    for (const item of array(object(view.projection).authorizations ?? []).slice(0, 1))
      shown.push({
        grant: authorization(object(item).authorization),
        availability: text(object(item).availability),
        slot: String(integer(object(view.observation).slot)),
        origin: text(object(view.observation).origin),
        where: "recorded native executions",
      });
  }
  return shown;
}

function showcase(shown: Shown) {
  const { grant, availability, slot, where, origin } = shown;
  const card = document.querySelector<HTMLElement>("#showcase-card")!;
  const head = element("div", "", "permission-header");
  const kind = text(object(grant.authority_kind).kind);
  const state = element("span", STATUS[availability] ?? availability, "availability");
  state.dataset.state = availability;
  head.append(element("span", KINDS[kind] ?? kind, "badge"), state);
  const facts = element("dl");
  for (const [label, value] of [
    ...(object(grant.subject).kind === "identity"
      ? ([["Owner", text(object(grant.subject).value)]] as const)
      : []),
    ["Who", principalLabel(grant.principal)],
    ["From", text(object(grant.resource).id)],
    ["Native system", system(grant)],
  ] as const) {
    const row = element("div", "", "field");
    row.append(element("dt", label), element("dd", value));
    facts.append(row);
  }
  const fresh = element("div");
  fresh.append(
    head,
    element("h3", permissionLabel(grant)),
    element("p", meaning(grant), "explain"),
    facts,
    // The line states only what this record's own evidence supports.
    element(
      "p",
      origin === "finalized"
        ? `Finalized state, slot ${slot}. Program bytes matched their catalog record. Read from ${where}.`
        : `Recorded fixture, slot ${slot}. Not a live deployment. Read from ${where}.`,
      "muted",
    ),
  );
  card.replaceChildren(fresh);
  document.querySelector("#showcase-where")!.textContent = where;
}

// The proof player walks one revoke through its four checks, using the permission above.
const player = document.querySelector<HTMLElement>("#player")!;
const captions = [
  "Read once from finalized state.",
  "Simulated in that same state: exactly this is removed.",
  "The wallet signs the reviewed bytes, nothing else.",
  "Read again after finality: gone.",
];
let details: { account: string; delegate: string; amount: string } | undefined;
function step(index: number) {
  player.dataset.step = String(index);
  const done = index === 3;
  document.querySelector("#p-caption")!.textContent = captions[index]!;
  document.querySelector("#p-account")!.textContent = details?.account ?? "a token account";
  document.querySelector("#p-delegate")!.textContent = done ? "none" : (details?.delegate ?? "a delegate");
  document.querySelector("#p-amount")!.textContent = done ? "0" : (details?.amount ?? "its limit");
  for (const [at, item] of [...player.querySelectorAll<HTMLElement>(".rail li")].entries())
    item.classList.toggle("now", at === index);
}
let playing = setInterval(() => step((Number(player.dataset.step) + 1) % 4), 2600);
step(0);

observed()
  .then((shown) => {
    if (!shown.length) throw new Error("nothing observed");
    let index = 0;
    showcase(shown[0]!);
    const usage = object(shown[0]!.grant.usage);
    const principal = object(shown[0]!.grant.principal);
    details = {
      account: short(text(object(shown[0]!.grant.resource).id)),
      delegate: principal.kind === "identity" ? short(text(principal.value)) : "several keys",
      amount: usage.remaining == null ? "its limit" : integer(usage.remaining).toLocaleString("en-US"),
    };
    if (shown.length > 1) setInterval(() => showcase(shown[(index = (index + 1) % shown.length)]!), 7000);
  })
  .catch(() => {
    document
      .querySelector("#showcase-card")!
      .replaceChildren(
        element("p", "Nothing has been read yet. Open the console to observe an account.", "muted"),
      );
  });

// Each card, step and row opens its own summary; choosing a proof step also holds the player there.
for (const toggle of document.querySelectorAll<HTMLButtonElement>(".more"))
  toggle.onclick = () => {
    toggle.setAttribute("aria-expanded", String(toggle.getAttribute("aria-expanded") !== "true"));
    if (toggle.dataset.step === undefined) return;
    clearInterval(playing);
    step(Number(toggle.dataset.step));
    if (!player.querySelector('[aria-expanded="true"]'))
      playing = setInterval(() => step((Number(player.dataset.step) + 1) % 4), 2600);
  };
