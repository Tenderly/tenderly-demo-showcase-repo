/**
 * Settings from environment variables, a fixed-clock ticker that stops on Ctrl-C, JSON-RPC error details, wrapped
 * error lines and time formatting for the long-running scripts (npm run mine, npm run watch-state).
 */
import * as log from "./log.js";

// ---- settings ------------------------------------------------------------------------------------

export function envFlag(name: string): boolean {
  const v = (process.env[name] ?? "").trim();
  if (/^(1|true|yes)$/i.test(v)) return true;
  if (/^(0|false|no)?$/i.test(v)) return false;
  throw new Error(`${name} must be true or false, got "${v}"`);
}

/** A block number, or undefined for the latest block. Accepts 26242540, 26_242_540 and 26,242,540. */
export function envBlock(name: string): number | undefined {
  const v = (process.env[name] ?? "").trim();
  if (v === "" || /^latest$/i.test(v)) return undefined;
  const n = Number(v.replace(/[_,]/g, ""));
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} must be a block number or latest, got "${v}"`);
  return n;
}

export function envSeconds(name: string, fallback: number): number {
  const v = (process.env[name] ?? "").trim();
  if (v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) throw new Error(`${name} must be a number of seconds, 1 or more, got "${v}"`);
  return n;
}

// ---- fixed clock ---------------------------------------------------------------------------------

let stopping = false;
let stoppedAt = 0;
let wake = (): void => {};

// The first Ctrl-C (or SIGTERM) lets the current tick finish, then the script prints its summary. npm and tsx pass the
// signal on too, so one key press can arrive two or three times within milliseconds: only a second press a second
// later exits at once.
function stopOnSignal(): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stopping) {
        if (Date.now() - stoppedAt > 1_000) process.exit(130);
        return;
      }
      stopping = true;
      stoppedAt = Date.now();
      wake();
    });
  }
}

const sleepUntil = (at: number): Promise<void> =>
  new Promise((done) => {
    const timer = setTimeout(done, Math.max(0, at - Date.now()));
    wake = () => {
      clearTimeout(timer);
      done();
    };
  });

/**
 * Yield on a fixed clock, tick n at start + n × interval, until Ctrl-C. A tick that runs long doesn't push the
 * later ones back: the clock skips to the next slot that is still ahead.
 */
export async function* ticks(intervalMs: number): AsyncGenerator<number> {
  stopOnSignal();
  const start = Date.now();
  let n = 1;
  while (!stopping) {
    await sleepUntil(start + n * intervalMs);
    if (stopping) return;
    yield n;
    n = Math.max(n + 1, Math.floor((Date.now() - start) / intervalMs) + 1);
  }
}

// ---- JSON-RPC errors -----------------------------------------------------------------------------

interface RpcError {
  code?: number;
  message?: string;
}

/** The JSON-RPC error inside an ethers error: in `error` after HTTP 200, in the response body after HTTP 403. */
function rpcError(err: unknown): RpcError {
  const e = (err ?? {}) as { error?: RpcError; info?: { responseBody?: string } };
  if (e.error?.code !== undefined) return e.error;
  try {
    return (JSON.parse(e.info?.responseBody ?? "") as { error?: RpcError }).error ?? {};
  } catch {
    return {};
  }
}

/**
 * JSON-RPC -32004 (HTTP 403): the environment's write limit or the monthly usage limit (the same quota message), or a
 * cheat code sent to the Public RPC ("try Admin RPC URL"). Retrying doesn't help.
 */
export const isRejected = (err: unknown): boolean => rpcError(err).code === -32004;

/** One short line for an error: the JSON-RPC message if there is one, else ethers' short message. */
export function reason(err: unknown): string {
  const e = (err ?? {}) as { shortMessage?: string; message?: string };
  const text = rpcError(err).message ?? e.shortMessage ?? e.message ?? String(err);
  return text.split("\n")[0].slice(0, 120);
}

// ---- output --------------------------------------------------------------------------------------

const WIDTH = 81; // tagged and sub lines start with 9 characters, and no line goes past 90

/**
 * Print text that can run past 90 characters, such as an API or RPC error: the first piece with `print` (log.fail,
 * log.warn), the rest on aligned lines under it. Secrets are masked before the split, so none is cut in two.
 */
export function wrapped(print: (msg: string) => void, text: string): void {
  const lines: string[] = [];
  let cur = "";
  for (let word of log.redact(text).split(/\s+/).filter(Boolean)) {
    if (cur && cur.length + 1 + word.length > WIDTH) {
      lines.push(cur);
      cur = "";
    }
    for (; word.length > WIDTH; word = word.slice(WIDTH)) lines.push(word.slice(0, WIDTH));
    cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) lines.push(cur);
  print(lines[0] ?? "");
  for (const l of lines.slice(1)) log.sub(l);
}

// ---- formatting ----------------------------------------------------------------------------------

export const num = (n: number): string => n.toLocaleString("en-US");

/** 16:25:11, UTC. */
export const hms = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString().slice(11, 19);

/** 2026-10-28 16:25:11 UTC. */
export const dateTime = (unixSeconds: number): string =>
  `${new Date(unixSeconds * 1000).toISOString().slice(0, 19).replace("T", " ")} UTC`;

/** The time between two blocks: +12 s, +4 min, +2.5 h, +6.8 days. */
export function gap(seconds: number): string {
  const sign = seconds < 0 ? "-" : "+";
  const s = Math.abs(seconds);
  if (s < 120) return `${sign}${s} s`;
  if (s < 7_200) return `${sign}${Math.round(s / 60)} min`;
  if (s < 172_800) return `${sign}${(s / 3_600).toFixed(1)} h`;
  return `${sign}${(s / 86_400).toFixed(1)} days`;
}
