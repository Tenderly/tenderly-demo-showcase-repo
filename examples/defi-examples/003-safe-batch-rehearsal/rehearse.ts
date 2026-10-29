// Rehearse a Safe multisig batch on a Virtual Environment forked from Ethereum before anyone signs it. Each Safe
// transaction is simulated from the Safe's address with tenderly_simulateBundle, then executed by impersonated owners.
// npm run demo (batches/raise-cap.json), npm run demo:fail (batches/over-cap.json); --batch <file>, --block <n|latest>
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { getAddress, isAddress, type JsonRpcProvider } from "ethers";
import * as log from "./lib/log.js";
import { MULTICALL3, decodeCalls, encodeCalls, multicall, type ContractCall } from "./lib/multicall.js";
import {
  decodeMarketState, decodeRevert, marketOf, marketStateCalls, metaMorphoI, parseAmount, readVault, reallocation,
  type MarketState, type Target, type Vault,
} from "./lib/morpho.js";
import {
  buildSafeTx, executeThroughSafe, nextNonce, readSafe, safeError, safeTxHash, signersOf, type Call, type SafeInfo,
  type Send,
} from "./lib/safe.js";
import {
  createEnvironment, credentials, environmentUrl, increaseTime, providerFor, runSlug, sendAs, setNextBlockTimestamp,
  simulateBundle, transactionsUrl, txUrl, type Credentials, type Environment, type Network, type SimResult,
} from "./lib/tenderly.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FORK_BLOCK = 26_242_540;
/** A transaction marked afterTimelock runs this many seconds after the vault's timelock has passed. */
const MARGIN = 60;
/** Sender of the state reads in a bundle; any address works. */
const READER = "0x000000000000000000000000000000000000dEaD";
/** tenderly_simulateBundle takes up to 10 transactions: a read before and after leaves 8 calls per Safe transaction. */
const MAX_CALLS = 8;

// ---- the batch file ----------------------------------------------------------------------------------

interface MoveSpec { from: string; to: string; amount: string | number }
type CallSpec =
  | { submitCap: { market: string; cap: string | number } }
  | { acceptCap: { market: string } }
  | { reallocate: MoveSpec[] };
interface Batch { name: string; vault: string; transactions: Array<{ afterTimelock?: boolean; calls: CallSpec[] }> }

function loadBatch(path: string, shown: string): Batch {
  let b: Batch;
  try {
    b = JSON.parse(readFileSync(path, "utf8")) as Batch;
  } catch (err) {
    throw new Error(`can't read the batch file ${shown}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!b.name || !isAddress(b.vault) || !Array.isArray(b.transactions) || !b.transactions.length) {
    throw new Error(`${shown}: a batch needs a name, a vault address and at least one transaction`);
  }
  b.transactions.forEach((t, i) => {
    if (!Array.isArray(t.calls) || !t.calls.length || t.calls.length > MAX_CALLS) {
      throw new Error(`${shown}: transaction ${i + 1} needs 1 to ${MAX_CALLS} calls`);
    }
  });
  return b;
}

type State = Record<string, MarketState>;

interface SafeCall {
  fn: string;
  call: Call;
  /**
   * The call as signers read it: submitCap(FLHYon/USDC 86%, 20,000,000 USDC). A reallocate names what its last leg
   * supplies, which depends on the state it runs on: pass the state the simulation starts from.
   */
  text: (state: State) => string;
  /** reallocate: the target supply of each market it moves. */
  targets?: Target[];
}
interface SafeTransaction { afterTimelock: boolean; calls: SafeCall[] }

/** The calls the Safe makes for the batch. reallocate targets come from `state`, the vault when the run starts. */
function decodeBatch(b: Batch, v: Vault, state: State, fmt: (x: bigint) => string): SafeTransaction[] {
  const amount = (s: string | number): bigint => parseAmount(s, v.decimals);
  const encode = (fn: string, args: unknown[]): Call => ({ to: v.address, data: metaMorphoI.encodeFunctionData(fn, args) });
  const label = (id: string): string => v.markets.find((m) => m.id === id)!.label;
  return b.transactions.map((t, i) => ({
    afterTimelock: Boolean(t.afterTimelock),
    calls: t.calls.map((spec): SafeCall => {
      const [fn, arg] = Object.entries(spec)[0] ?? [];
      if (fn === "submitCap") {
        const { market, cap } = arg as { market: string; cap: string | number };
        const m = marketOf(v, market);
        const text = `submitCap(${m.label}, ${fmt(amount(cap))} ${v.assetSymbol})`;
        return { fn, call: encode(fn, [m.params, amount(cap)]), text: () => text };
      }
      if (fn === "acceptCap") {
        const m = marketOf(v, (arg as { market: string }).market);
        return { fn, call: encode(fn, [m.params]), text: () => `acceptCap(${m.label})` };
      }
      if (fn === "reallocate") {
        const moves = (arg as MoveSpec[]).map((mv) => ({
          from: marketOf(v, mv.from).id, to: marketOf(v, mv.to).id, amount: amount(mv.amount),
        }));
        const { allocations, targets } = reallocation(v, state, moves);
        // A target leg sets the market's supply; the last leg supplies whatever the withdrawals freed.
        const text = (now: State): string => `reallocate(${targets.map((tg) => (tg.rest
          ? `${fmt(suppliedTo(targets, now, tg.id))} to ${label(tg.id)}`
          : `${label(tg.id)} to ${fmt(tg.after)}`)).join(", ")})`;
        return { fn, call: encode(fn, [allocations]), text, targets };
      }
      throw new Error(`transaction ${i + 1}: unknown call "${fn}" (use submitCap, acceptCap or reallocate)`);
    }),
  }));
}

/** What a reallocate supplies to market `id` on `state`, computed the way the vault's reallocate does it. */
function suppliedTo(targets: Target[], state: State, id: string): bigint {
  let withdrawn = 0n;
  let supplied = 0n;
  for (const tg of targets) {
    const held = state[tg.id].supply;
    if (!tg.rest && held > tg.after) {
      withdrawn += held - tg.after;
      continue;
    }
    // The last supply leg is type(uint256).max: it takes what the withdrawals freed and the other legs left.
    const adds = tg.rest ? withdrawn - supplied : tg.after - held;
    if (tg.id === id) return adds > 0n ? adds : 0n;
    if (adds > 0n) supplied += adds;
  }
  return 0n;
}

/** Supply each market gained (+) or lost (-), from the vault's ReallocateSupply and ReallocateWithdraw events. */
function reallocated(v: Vault, logs: SimResult["logs"]): Map<string, bigint> {
  const moved = new Map<string, bigint>();
  const add = (id: string, d: bigint): void => void moved.set(id, (moved.get(id) ?? 0n) + d);
  for (const l of logs) {
    if (getAddress(l.address) !== v.address) continue;
    const ev = metaMorphoI.parseLog(l);
    if (ev?.name === "ReallocateSupply") add(ev.args.id, ev.args.suppliedAssets as bigint);
    if (ev?.name === "ReallocateWithdraw") add(ev.args.id, -(ev.args.withdrawnAssets as bigint));
  }
  return moved;
}

/** Why a call simulated from the Safe's address reverts. */
const WHY: Record<string, string> = {
  SupplyCapExceeded: "a reallocate can't leave a market above its cap",
  "insufficient liquidity": "borrowers hold that market's liquidity, so the vault can't withdraw that much",
  NotAllocatorRole: "the Safe isn't an allocator, the curator or the owner of the vault",
  NotCuratorRole: "only the curator or the owner can change caps",
  TimelockNotElapsed: "the pending cap's timelock hasn't passed",
  NoPendingValue: "the market has no pending cap",
  AlreadyPending: "a cap change for the market is already pending",
  AlreadySet: "the market already has this cap",
  UnauthorizedMarket: "the market has no cap on this vault",
  MarketNotEnabled: "the market isn't enabled on this vault",
  InconsistentReallocation: "the reallocate supplies a different amount than it withdraws",
};

// ---- formatting ---------------------------------------------------------------------------------------

const int = (n: number | bigint): string => n.toLocaleString("en-US");
const addr = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
const utc = (ts: number): string => `${new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const days = (s: number): string =>
  (s % 86_400 === 0 ? `${s / 86_400} days` : s % 3_600 === 0 ? `${s / 3_600} hours` : `${s} s`);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const ordinal = (n: number): string =>
  `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;

// ---- the rehearsal ------------------------------------------------------------------------------------

type Verdict = { pass: boolean; summary: string };

/** What every Safe transaction of the rehearsal needs. */
interface Ctx {
  c: Credentials;
  e: Environment;
  n: Network;
  p: JsonRpcProvider;
  v: Vault;
  safe: SafeInfo;
  /** marketStateCalls for every market of the vault. */
  reads: ContractCall[];
  links: Array<[string, string]>;
  /** The time of the last block the run mined. Every block gets its time pinned with tenderly_setNextBlockTimestamp. */
  clock: { time: number };
  /** Pins the next block 1 s after the last one, then sends. */
  send: Send;
  /** One whole unit of the vault's asset, in base units. */
  one: bigint;
  /** Whole units of the vault's asset, rounded down (toward zero). Every amount in the log goes through it. */
  units: (x: bigint) => bigint;
  fmt: (x: bigint) => string;
  label: (id: string) => string;
}

/** Pin the next block `seconds` after the last one the run mined. */
async function pin(x: Pick<Ctx, "p" | "clock">, seconds: number): Promise<void> {
  x.clock.time += seconds;
  await setNextBlockTimestamp(x.p, x.clock.time);
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { batch: { type: "string" }, block: { type: "string" } } });
  const batchPath = values.batch ? resolve(values.batch) : resolve(HERE, "batches/raise-cap.json");
  const batch = loadBatch(batchPath, batchPath.startsWith(`${HERE}/`) ? relative(HERE, batchPath) : batchPath);
  const block = values.block === "latest" ? undefined : Number(values.block ?? FORK_BLOCK);
  if (block !== undefined && !(Number.isInteger(block) && block > 0)) {
    throw new Error(`--block ${values.block}: use a block number or latest`);
  }
  const c = credentials();

  const at = block === undefined ? "latest block" : `block ${int(block)}`;
  log.run("Safe batch rehearsal", `${batch.name}, ${at}`, batch.transactions.length + 2);
  log.step("Fork Ethereum");
  const e = await createEnvironment(c, {
    displayName: "Safe batch rehearsal",
    slug: runSlug("safe-rehearsal"),
    networks: [{ networkId: 1, chainId: 73571, block }],
  });
  const links: Array<[string, string]> = [["environment", environmentUrl(c, e)], ["transactions", transactionsUrl(c, e)]];
  const verdict = await rehearse(c, e, batch, links).catch((err: unknown): Verdict => {
    log.fail(err instanceof Error ? err.message : String(err));
    return { pass: false, summary: "the rehearsal stopped at the [FAIL] above" };
  });
  log.blank();
  for (const [label, url] of links) log.link(label, url);
  return log.result(verdict.pass, verdict.summary);
}

async function rehearse(c: Credentials, e: Environment, batch: Batch, links: Array<[string, string]>): Promise<Verdict> {
  const n = e.networks[0];
  const p = providerFor(n.adminRpc, n.chainId);
  const fork = await p.getBlock("latest");
  if (!fork) throw new Error("the environment returned no latest block");
  log.ok(`environment ${e.slug}, block ${int(fork.number)}, chain id ${n.chainId}`);

  const v = await readVault(p, batch.vault);
  const one = 10n ** BigInt(v.decimals);
  const units = (x: bigint): bigint => x / one;
  const fmt = (x: bigint): string => int(units(x));
  const label = (id: string): string => v.markets.find((m) => m.id === id)!.label;
  log.ok(`${v.symbol}: ${fmt(v.totalAssets)} ${v.assetSymbol} in ${v.markets.length} markets, timelock ${days(v.timelock)}`);

  const safe = await readSafe(p, v.curator);
  const quorum = `${safe.threshold} of ${safe.owners.length}`;
  const reads = marketStateCalls(v);
  // The nonce signers get on Ethereum: after the Safe's nonce and what is queued in the Safe Transaction Service.
  const [next, state] = await Promise.all([nextNonce(safe.address, safe.nonce), multicall(p, reads)]);
  const nonce = next.fallback ? `nonce ${safe.nonce}` : `next free nonce ${next.nonce}`;
  log.ok(`curator Safe ${addr(safe.address)}: Safe ${safe.version}, ${quorum} owners, ${nonce}`);
  if (next.fallback) log.warn(`Safe Transaction Service ${next.fallback}: queued transactions unknown`);
  log.ok(`signers ${signersOf(safe).map(addr).join(", ")} (impersonated)`);

  const txs = decodeBatch(batch, v, decodeMarketState(v, state), fmt);
  // Every block the run mines comes 1 s after the one before, from the fork block's time on, so the amounts don't
  // depend on the day of the run or on how long it takes.
  const clock = { time: fork.timestamp };
  const send: Send = async (tx) => {
    await pin({ p, clock }, 1);
    return sendAs(p, tx);
  };
  const ctx: Ctx = { c, e, n, p, v, safe, reads, links, clock, send, one, units, fmt, label };
  for (const [k, t] of txs.entries()) {
    log.step(`Safe transaction ${k + 1} of ${txs.length}${t.afterTimelock ? ", after the timelock" : ""}`);
    const failed = await rehearseTransaction(ctx, t, k);
    if (failed) return failed;
  }

  // What signers see on Ethereum: the EIP-712 hash covers chain id 1 and the Safe's next free nonce there.
  log.step("Hashes for the signers");
  const chain = `for Ethereum (chain id ${n.networkId})`;
  if (next.fallback) {
    log.warn(`${chain}, at the Safe's own nonce (queue unknown)`);
  } else {
    const queued = next.queued.length ? `after ${plural(next.queued.length, "transaction")} queued` : "nothing queued";
    log.ok(`${chain}, ${queued} in Safe{Wallet}`);
  }
  for (const [k, t] of txs.entries()) {
    const at = next.nonce + BigInt(k);
    log.kv(`nonce ${at}`, safeTxHash(buildSafeTx(t.calls.map((s) => s.call), safe), safe.address, n.networkId, at));
  }
  return { pass: true, summary: `${plural(txs.length, "Safe transaction")} simulated, then executed by ${quorum} owners` };
}

/** One Safe transaction: time travel if it needs it, the simulation, what it changes, the execution. Returns a failure. */
async function rehearseTransaction(x: Ctx, t: SafeTransaction, k: number): Promise<Verdict | undefined> {
  const { p, v, safe, units, fmt, label } = x;
  const sym = v.assetSymbol;
  const quorum = `${safe.threshold} of ${safe.owners.length}`;
  if (t.afterTimelock) {
    // evm_increaseTime mines its block at the pinned time, so the pin includes the increase.
    await pin(x, v.timelock + MARGIN);
    await increaseTime(p, v.timelock + MARGIN);
    const now = (await p.getBlock("latest"))!;
    x.clock.time = now.timestamp; // later pins count from this block
    log.ok(`evm_increaseTime: ${days(v.timelock)} + ${MARGIN} s, block ${int(now.number)} at ${utc(now.timestamp)}`);
  }

  // The simulation: the vault's markets, each call sent from the Safe, the markets again, as one bundle on the latest
  // block. Nothing is committed.
  const read = { from: READER, to: MULTICALL3, data: encodeCalls(x.reads) };
  const sims = await simulateBundle(p, [read, ...t.calls.map((s) => ({ from: safe.address, ...s.call })), read]);
  if (!sims[0].ok || !sims[sims.length - 1].ok) throw new Error("the simulation's read of the vault reverted");
  const before = decodeMarketState(v, decodeCalls(x.reads, sims[0].output));
  for (const s of t.calls) log.line(s.text(before));

  const failed = t.calls.findIndex((_, i) => !sims[i + 1].ok);
  if (failed >= 0) {
    const s = t.calls[failed];
    const err = decodeRevert(sims[failed + 1].output);
    const id = err.args.find((a) => /^0x[0-9a-fA-F]{64}$/.test(a));
    const m = id ? v.markets.find((mk) => mk.id.toLowerCase() === id.toLowerCase())?.id : undefined;
    log.fail(`tenderly_simulateBundle: ${s.fn} reverts with ${err.text}`);
    let why = err.name === "unknown" ? err.text : err.name;
    if (err.name === "SupplyCapExceeded" && m && s.targets?.some((tg) => tg.id === m)) {
      // Whole units first, so the printed numbers add up: held + adds - cap = over. adds is the amount the reallocate
      // line above prints for the market.
      const [held, cap, adds] = [units(before[m].supply), units(before[m].cap), units(suppliedTo(s.targets, before, m))];
      const over = held + adds - cap;
      log.sub(`where  ${label(m)} holds ${int(held)} ${sym}, cap ${int(cap)}`);
      log.sub(`why    the batch adds ${int(adds)} ${sym}, ${int(over)} over the cap`);
      why = `${int(over)} ${sym} over the cap`;
    } else {
      const on = m ? ` on ${label(m)}` : "";
      log.sub(`where  call ${failed + 1} of ${t.calls.length}, ${s.fn}${on}, sent from the Safe`);
      log.sub(`why    ${WHY[err.name] ?? "it reverts the same way on Ethereum"}`);
    }
    log.sub(`       signed as is, it reverts with Safe error GS013 after ${quorum} owners sign`);
    return { pass: false, summary: `Safe transaction ${k + 1} would revert: ${why}` };
  }
  const after = decodeMarketState(v, decodeCalls(x.reads, sims[sims.length - 1].output));
  const calls = sims.slice(1, -1);
  checkReallocations(x, t, before, after, calls);
  const succeed = t.calls.length === 1 ? "succeeds" : `${t.calls.length} calls succeed`;
  log.ok(`tenderly_simulateBundle: ${succeed} when sent from the Safe`);
  printChanges(x, before, after, reallocated(v, calls.flatMap((sim) => sim.logs)));

  // The same calls through the Safe: threshold - 1 owners approve the hash, the next one executes.
  const safeTx = buildSafeTx(t.calls.map((s) => s.call), safe);
  const exec = await executeThroughSafe(p, safe, safeTx, {
    chainId: x.n.chainId,
    send: x.send,
    decode: (data) => {
      const r = decodeRevert(data);
      return /^GS\d{3}$/.test(r.name) ? safeError(r.name) : r.text;
    },
  });
  if (exec.execHash) x.links.push([`Safe tx ${k + 1}`, txUrl(x.c, x.e, x.n, exec.execHash)]);
  if (!exec.ok) {
    log.fail(`executing through the Safe fails: ${exec.error}`);
    log.sub(`where  Safe transaction ${k + 1}, signed by ${quorum} owners`);
    log.sub("why    signed as is, this Safe transaction fails the same way on Ethereum");
    return { pass: false, summary: `Safe transaction ${k + 1} failed when executed through the Safe` };
  }
  const approvers = exec.signers.length - 1;
  const approve = approvers === 1 ? "1 owner approves" : `${approvers} owners approve`;
  log.ok(approvers ? `${approve}, the ${ordinal(approvers + 1)} executes: success` : "1 owner executes: success");

  // The executed state against the simulation's: caps exact, supply within 1 unit, the precision the log prints. The
  // execution's block comes 1 s per signer after the simulated one, about 0.13 USDC of interest in steakUSDC's markets.
  const now = decodeMarketState(v, await multicall(p, x.reads));
  const gap = (a: bigint, b: bigint): bigint => (a > b ? a - b : b - a);
  const off = v.markets.find(({ id }) => now[id].cap !== after[id].cap || now[id].pendingCap !== after[id].pendingCap
    || gap(now[id].supply, after[id].supply) > x.one);
  if (off) {
    const [a, b] = [now[off.id], after[off.id]];
    const [what, got, want] = a.cap !== b.cap ? ["cap", a.cap, b.cap]
      : a.pendingCap !== b.pendingCap ? ["pending cap", a.pendingCap, b.pendingCap] : ["supply", a.supply, b.supply];
    log.fail(`result differs from the simulation on ${off.label}`);
    log.sub(`where  ${what} ${fmt(got)} ${sym}, the simulation had ${fmt(want)}`);
    log.sub("why    the Safe executed something other than the simulated calls");
    return { pass: false, summary: `Safe transaction ${k + 1} executed differently from its simulation` };
  }
  log.ok(`result matches the simulation (within 1 ${sym} per market)`);
  return undefined;
}

/**
 * The numbers a reallocate line prints, against the simulation, in whole units: what its last leg supplies (computed
 * from the state the simulation starts on) against the call's ReallocateSupply event, and each target against the
 * supply the simulation ends with. A target is checked when only one call of the transaction moves that market.
 */
function checkReallocations(x: Ctx, t: SafeTransaction, before: State, after: State, sims: SimResult[]): void {
  const { v, units, label } = x;
  const movers = new Map<string, number>();
  for (const s of t.calls) for (const tg of s.targets ?? []) movers.set(tg.id, (movers.get(tg.id) ?? 0) + 1);
  t.calls.forEach((s, i) => {
    if (!s.targets) return;
    const simulated = reallocated(v, sims[i].logs);
    for (const tg of s.targets) {
      if (!tg.rest && movers.get(tg.id) !== 1) continue;
      const [printed, got] = tg.rest
        ? [units(suppliedTo(s.targets, before, tg.id)), units(simulated.get(tg.id) ?? 0n)]
        : [units(tg.after), units(after[tg.id].supply)];
      if (printed !== got) {
        throw new Error(`numbers don't reconcile: ${label(tg.id)} ${int(printed)}, simulated ${int(got)}`);
      }
    }
  });
}

/**
 * What a Safe transaction changes, from the simulation. Supply moves come from the Reallocate events, so both sides of
 * a move print the same number, and after is what the simulation read, so it matches a reallocate target printed above.
 * The printed before is after minus change, checked against what the simulation read before the calls.
 */
function printChanges(x: Ctx, before: State, after: State, moved: Map<string, bigint>): void {
  const { v, units, fmt, label } = x;
  const rows: Array<{ cells: string[]; order: bigint }> = [];
  const row = (what: string, id: string, b: bigint, change: bigint, a: bigint, order: bigint): void => {
    const [au, cu] = [units(a), units(change)];
    const diff = au - cu - units(b);
    if (diff > 1n || diff < -1n) {
      throw new Error(`numbers don't reconcile: ${what} ${label(id)} ${int(au - cu)}, read ${fmt(b)}`);
    }
    const sign = cu > 0n ? "+" : "";
    rows.push({ cells: [`${what.padEnd(6)} ${label(id)}`, int(au - cu), int(au), `${sign}${int(cu)}`], order });
  };
  for (const { id } of v.markets) {
    const [b, a] = [before[id], after[id]];
    // Caps first, then supply: withdrawals before deposits.
    if (a.cap !== b.cap) row("cap", id, b.cap, a.cap - b.cap, a.cap, -(2n ** 255n));
    const d = moved.get(id);
    if (d) row("supply", id, b.supply, d, a.supply, d);
    if (a.pendingCap > 0n && a.pendingCap !== b.pendingCap) {
      log.ok(`${label(id)}: cap ${fmt(b.cap)} ${v.assetSymbol}, ${fmt(a.pendingCap)} pending for ${days(v.timelock)}`);
    }
  }
  rows.sort((r1, r2) => (r1.order < r2.order ? -1 : r1.order > r2.order ? 1 : 0));
  if (rows.length) log.table([v.assetSymbol, "before", "after", "change"], rows.map((r) => r.cells));
}

main().then((code) => process.exit(code), (err) => process.exit(log.fatal(err)));
