// The calm parts of a wallet check: progress while it reads, what to do next, and doing it again.
import { icon, type IconName } from "./icons.ts";
import { short } from "./wire.ts";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  content = "",
  className = "",
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = content;
  element.className = className;
  return element;
}

export function button(label: string, mark: IconName | undefined, className: string, onClick: () => void) {
  const element = el("button", "", className);
  element.type = "button";
  if (mark) element.append(icon(mark));
  element.append(label);
  element.onclick = onClick;
  return element;
}

// A short-lived label on a control, so a click that changes nothing else still answers.
export function tip(target: HTMLElement, message: string) {
  target.dataset.tip = message;
  clearTimeout(Number(target.dataset.tipTimer));
  target.dataset.tipTimer = String(setTimeout(() => delete target.dataset.tip, 1600));
}

// Recent checks are a convenience in this browser only; storage that fails is ignored.
const RECENT = "velon.recent";
const RECENT_LIMIT = 5;
export function recentChecks(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(RECENT) ?? "[]");
    return Array.isArray(saved) ? saved.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
export function rememberCheck(address: string) {
  try {
    const next = [address, ...recentChecks().filter((item) => item !== address)].slice(0, RECENT_LIMIT);
    localStorage.setItem(RECENT, JSON.stringify(next));
  } catch {
    /* Recent checks are optional. */
  }
}
export function forgetChecks() {
  try {
    localStorage.removeItem(RECENT);
  } catch {
    /* Nothing was kept. */
  }
}

const STEPS = [
  "Find the wallet's approvals and subscriptions",
  "Check each one against the program's verified build",
  "Read balances and past charges",
];

export interface Progress {
  panel: HTMLElement;
  owner: string;
  step(index: number, note?: string): void;
  share(value: number): void;
  list(rows: HTMLElement): void;
}

// What a check is doing right now, so a wait never looks like a stuck page.
export function progress(owner: string): Progress {
  const panel = el("section", "", "progress-card");
  panel.setAttribute("aria-busy", "true");
  const head = el("div", "", "progress-head");
  const elapsed = el("span", "", "elapsed");
  head.append(el("h2", `Checking ${short(owner)}`), elapsed);
  const meter = el("div", "", "meter");
  const fill = el("span");
  meter.append(fill);
  const steps = el("ol", "", "progress-steps");
  steps.setAttribute("aria-live", "polite");
  const items = STEPS.map((label) => {
    const item = el("li");
    item.append(el("span", label), el("span", "", "step-note"));
    steps.append(item);
    return item;
  });
  const calm = el("p", "Read only. Nothing to sign, and you can check another wallet at any time.", "calm");
  const rows = el("div", "", "progress-rows");
  panel.append(head, meter, steps, calm, rows);
  const started = Date.now();
  const timer = setInterval(() => {
    if (!panel.isConnected && Date.now() - started > 2000) return clearInterval(timer);
    elapsed.textContent = `${Math.floor((Date.now() - started) / 1000)} s`;
  }, 1000);
  const share = (value: number) =>
    (fill.style.width = `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`);
  share(0.04);
  return {
    panel,
    owner,
    step(index, note = "") {
      items.forEach((item, at) => (item.className = at < index ? "done" : at === index ? "now" : ""));
      items[index]!.querySelector(".step-note")!.textContent = note;
      share([0.06, 0.12, 0.94][index] ?? 1);
    },
    share,
    list(list) {
      rows.replaceChildren(list);
    },
  };
}

// The answer's last word: what to do now, then the ways to look again.
export function nextPanel(steps: string[], actions: HTMLElement[]): HTMLElement {
  const panel = el("section", "", "next");
  panel.append(el("p", "What to do next", "eyebrow"));
  if (steps.length) {
    const list = el("ol", "", "next-steps");
    for (const line of steps) list.append(el("li", line));
    panel.append(list);
  }
  const row = el("div", "", "next-actions");
  row.append(...actions);
  panel.append(row);
  return panel;
}
