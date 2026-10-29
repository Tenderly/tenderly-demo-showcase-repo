/**
 * Logging for the examples. Each example ships its own copy, so its folder runs on its own.
 *
 *   run("Whale exit", "steakUSDC at block 26,242,540", 5)
 *   step("Fork Ethereum")                        [1/5] Fork Ethereum
 *   ok("environment at block 26,242,540")        [ok]   environment at block 26,242,540
 *   kv("paid", "29,333,973 USDC")                  paid         29,333,973 USDC
 *   link("environment", url)                     [link] environment  https://dashboard.tenderly.co/…
 *   result(true, "others can withdraw 53.1%")    RESULT  PASS   others can withdraw 53.1%   18s
 *
 * One short line per thing that happens, links at the end. Colors come from chalk, which drops them when
 * stdout is not a TTY, so CI logs stay plain text.
 */
import chalk from "chalk";

let current = 0;
let total = 0;
let startedAt = Date.now();

// ---- secrets -------------------------------------------------------------------------------
// RPC URLs carry access tokens (the Admin RPC is a live cheat-code endpoint). Errors from ethers can embed
// them, so every line this module prints goes through redact().

const secrets: Array<[string, string]> = [];
// \x1b stays out of the URL: a color code right after a URL must survive, or the color bleeds into later output.
const TENDERLY_RPC_URL = /(?:https?|wss?):\/\/[^\s"'()<>\x1b]*rpc\.tenderly\.co\/[^\s"'()<>\x1b]+/g;

/** Register a value that must never be printed, and the label to print instead. */
export function secret(value: string | undefined, label: string): void {
  if (value) secrets.push([value, label]);
}

/** Mask registered secrets, then any other Tenderly RPC URL. */
export function redact(s: string): string {
  let out = s;
  for (const [value, label] of secrets) out = out.split(value).join(label);
  return out.replace(TENDERLY_RPC_URL, "<rpc url>");
}

const TAG_WIDTH = 6;
const tagColor: Record<string, (s: string) => string> = {
  ok: chalk.green,
  wait: chalk.yellow,
  warn: chalk.yellow,
  FAIL: chalk.red.bold,
  file: chalk.gray,
  link: chalk.blue,
};

/** Print the run header (title and a one-sentence subtitle) and reset the step counter. */
export function run(title: string, subtitle: string, steps: number): void {
  current = 0;
  total = steps;
  startedAt = Date.now();
  console.log(chalk.bold(`Tenderly  ·  ${title}`));
  if (subtitle) console.log(chalk.gray(subtitle));
}

/** Start the next numbered step: `[4/6] Replay 10/10  |  blocks 23,549,800 → 23,550,300`. */
export function step(title: string): void {
  current += 1;
  console.log(`\n${chalk.bold(`[${current}/${total}] ${title}`)}`);
}

function tagged(tag: string, msg: string): void {
  const color = tagColor[tag] ?? ((s: string) => s);
  console.log(`  ${color(`[${tag}]`.padEnd(TAG_WIDTH))} ${redact(msg)}`);
}

/** A strategy decision: the rule's name in color, then what it does. */
export function rule(name: string, msg: string): void {
  console.log(`  ${chalk.magenta.bold(name.padEnd(12))} ${redact(msg)}`);
}

/** A label and its value, for the result block. */
export function kv(label: string, value: string): void {
  console.log(`  ${chalk.bold(label.padEnd(12))} ${redact(value)}`);
}

/** A continuation line aligned under the message column of a tagged line. */
export function sub(msg: string): void {
  console.log(`  ${" ".repeat(TAG_WIDTH)} ${redact(msg)}`);
}

export const ok = (msg: string): void => tagged("ok", msg);
export const wait = (msg: string): void => tagged("wait", msg);
export const warn = (msg: string): void => tagged("warn", msg);
export const fail = (msg: string): void => tagged("FAIL", msg);
export const file = (path: string, note = ""): void => tagged("file", `${path}${note ? `  ${chalk.gray(note)}` : ""}`);
export const link = (label: string, url: string): void => tagged("link", `${label.padEnd(15)} ${chalk.blue(url)}`);

/** An empty line, to set a block (findings, links) apart from the step above it. */
export const blank = (): void => console.log("");

/** Untagged line inside a step, e.g. one row of the replay. */
export const line = (msg: string): void => console.log(`  ${redact(msg)}`);
export const note = (msg: string): void => console.log(`  ${chalk.gray(redact(msg))}`);

/** Small aligned table. Cells may contain chalk colors; widths use the visible length. */
export function table(headers: string[], rows: string[][]): void {
  const visible = (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, "").length;
  const widths = headers.map((h, i) => Math.max(visible(h), ...rows.map((r) => visible(r[i] ?? ""))));
  const fmt = (cells: string[]): string =>
    cells.map((c, i) => c + " ".repeat(Math.max(0, widths[i] - visible(c)))).join("   ").trimEnd();
  console.log(`  ${chalk.gray(fmt(headers))}`);
  for (const r of rows) console.log(`  ${fmt(r)}`);
}

/** The one RESULT line at the end. Returns the process exit code. */
export function result(pass: boolean, summary: string): number {
  const secs = Math.round((Date.now() - startedAt) / 1000);
  const took = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
  const verdict = pass ? chalk.green.bold("PASS") : chalk.red.bold("FAIL");
  console.log(`\n${chalk.bold("RESULT")}  ${verdict}   ${redact(summary)}   ${chalk.gray(took)}`);
  return pass ? 0 : 1;
}

/** One clean line for an error that stops a run before it starts (bad flag, bad config, missing .env). No stack. */
export function fatal(err: unknown): number {
  console.error(`${chalk.red.bold("Error:")} ${redact(err instanceof Error ? err.message : String(err))}`);
  return 1;
}

/** 0x3c1e9b…  (keeps logs narrow; the full value is in the out/ report). */
export const short = (hex: string): string => (hex.length > 12 ? `${hex.slice(0, 8)}…` : hex);

export const pass = (s: string): string => chalk.green(s);
export const bad = (s: string): string => chalk.red(s);
export const dim = (s: string): string => chalk.gray(s);
export const bold = (s: string): string => chalk.bold(s);
