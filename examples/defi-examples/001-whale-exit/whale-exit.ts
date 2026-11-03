#!/usr/bin/env tsx
// A Morpho vault's largest depositor withdraws everything, on a Virtual Environment forked from Ethereum.
// npm run demo [-- --vault 0x… --block <number|latest> --holder 0x… --min-exit-pct <0-100>]; demo:fail uses 60.
// See README.md.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { getAddress, type JsonRpcProvider } from "ethers";
import * as log from "./lib/log.js";
import {
  createEnvironment, credentials, environmentUrl, providerFor, runSlug, sendAs, setNextBlockTimestamp, simulateBundle,
  transactionsUrl, txUrl, type Environment,
} from "./lib/tenderly.js";
import { PendingReads } from "./lib/pending.js";
import { multicall, type ContractCall } from "./lib/multicall.js";
import {
  borrowAprs, decodeRevert, exitCapacity, metaMorphoI, pulledPerMarket, readState, readVault, suppliersAmong,
  vaultCreationBlock, vaultsForAsset, type Vault,
} from "./lib/morpho.js";
import { holderLabels, holdersFromTransfers } from "./lib/holders.js";

const DEFAULT_VAULT = "0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB"; // Steakhouse USDC (steakUSDC), MetaMorpho
const DEFAULT_BLOCK = 26_242_540;
const CHAIN_ID = 73571; // the 7357 prefix + 1, so the environment's transactions can't be replayed on Ethereum
const TOP_HOLDERS = 5;
const REPORT = resolve(dirname(fileURLToPath(import.meta.url)), "out", "report.json");

const num = (x: number | bigint): string => x.toLocaleString("en-US");
const addr = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
const utc = (ts: number): string => `${new Date(ts * 1000).toISOString().slice(0, 19).replace("T", " ")} UTC`;
const plural = (k: number, word: string): string => `${num(k)} ${word}${k === 1 ? "" : "s"}`;
/** a as a percentage of b, one decimal, rounded to nearest, no % sign. Rules compare a and b, never this string. */
const pct = (a: bigint, b: bigint): string => {
  if (b === 0n) return "0.0";
  const tenths = (a * 2000n + b) / (2n * b);
  return `${tenths / 10n}.${tenths % 10n}`;
};
/** A rate where 1e18 is 100%, the same way. */
const apr = (x: bigint | undefined): string => (x === undefined ? "?" : pct(x, 10n ** 18n));
const andList = (items: string[]): string => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** An error in at most 3 lines of 79 characters, so no log line passes 90. out/report.json keeps the full text. */
function wrap(s: string): string[] {
  const lines: string[] = [];
  for (const w of s.split(/\s+/).filter(Boolean).map((x) => (x.length > 79 ? `${x.slice(0, 78)}…` : x))) {
    const i = lines.length - 1;
    if (i >= 0 && lines[i].length + 1 + w.length <= 79) lines[i] += ` ${w}`;
    else lines.push(w);
  }
  return lines.length > 3 ? [...lines.slice(0, 2), `${lines[2]} …`] : lines;
}

/**
 * Whole units that add up to the rounded-down total (largest-remainder rounding): each amount is rounded down, then
 * the units still missing go one each to the amounts with the largest remainders.
 */
function wholeParts(amounts: bigint[], unit: bigint): bigint[] {
  const parts = amounts.map((a) => a / unit);
  let missing = amounts.reduce((s, a) => s + a, 0n) / unit - parts.reduce((s, x) => s + x, 0n);
  const byRemainder = amounts.map((_, i) => i).sort((i, j) => {
    const d = (amounts[j] % unit) - (amounts[i] % unit);
    return d > 0n ? 1 : d < 0n ? -1 : i - j;
  });
  for (const i of byRemainder) {
    if (missing <= 0n) break;
    parts[i] += 1n;
    missing -= 1n;
  }
  return parts;
}

interface Flags {
  vault: string;
  block?: number;
  holder?: string;
  minExitPct: number;
}

function flags(): Flags {
  const { values } = parseArgs({
    options: { vault: { type: "string" }, block: { type: "string" }, holder: { type: "string" }, "min-exit-pct": { type: "string" } },
  });
  const address = (flag: string, s: string): string => {
    try {
      return getAddress(s);
    } catch {
      throw new Error(`--${flag} takes an address, not ${s}`);
    }
  };
  const block = values.block === undefined ? DEFAULT_BLOCK : values.block === "latest" ? undefined : Number(values.block);
  if (block !== undefined && !(Number.isInteger(block) && block > 0)) throw new Error(`--block takes a block number or latest, not ${values.block}`);
  const minExitPct = Number(values["min-exit-pct"] ?? 25);
  if (!(minExitPct >= 0 && minExitPct <= 100)) throw new Error(`--min-exit-pct takes 0 to 100, not ${values["min-exit-pct"]}`);
  return {
    vault: address("vault", values.vault ?? DEFAULT_VAULT),
    block,
    holder: values.holder ? address("holder", values.holder) : undefined,
    minExitPct,
  };
}

async function main(): Promise<number> {
  const f = flags();
  const c = credentials();
  const name = f.vault === DEFAULT_VAULT ? "steakUSDC" : addr(f.vault);
  log.run("Whale exit", `${name} at ${f.block === undefined ? "the latest block" : `block ${num(f.block)}`}`, 5);

  const report: Record<string, unknown> = { rule: { minExitPct: f.minExitPct } };
  const save = (): void => {
    mkdirSync(dirname(REPORT), { recursive: true });
    writeFileSync(REPORT, `${JSON.stringify(report, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2)}\n`);
  };
  let env: Environment | undefined;
  let exitTx: string | undefined;
  /** After the last step: the report file, then the links. Nothing to show before an environment exists. */
  const closing = (contents: string): void => {
    if (!env) return;
    const links = {
      environment: environmentUrl(c, env),
      transactions: transactionsUrl(c, env),
      exitTx: exitTx && txUrl(c, env, env.networks[0], exitTx),
    };
    report.links = links;
    save();
    log.blank();
    log.file("out/report.json", contents);
    log.link("environment", links.environment);
    log.link("transactions", links.transactions);
    if (links.exitTx) log.link("exit tx", links.exitTx);
  };
  let stage = "fork Ethereum";

  try {
    log.step("Fork Ethereum");
    env = await createEnvironment(c, {
      displayName: `Whale exit ${name}`,
      slug: runSlug("whale-exit"),
      networks: [{ networkId: 1, chainId: CHAIN_ID, block: f.block }],
    });
    const net = env.networks[0];
    const p = providerFor(net.adminRpc, net.chainId);
    const head = (await p.getBlock("latest"))!;
    const fork = head.number;
    // The exit block gets the fork block's time + 1 s instead of today's, so only 1 s of interest accrues before
    // the exit, and every run prints the same numbers.
    const exitTs = head.timestamp + 1;
    await setNextBlockTimestamp(p, exitTs);
    // Reads before the exit use the pending block: the current state at the exit block's pinned time. Before and
    // after then share one clock, and the amounts add up exactly.
    const pre = new PendingReads(net.adminRpc, net.chainId);
    log.ok(`environment ${env.slug}, block ${num(fork)}, chain id ${net.chainId}`);
    log.ok(`tenderly_setNextBlockTimestamp: new blocks keep the fork's date, ${utc(exitTs).slice(0, 10)}`);
    log.sub("so amounts are the same every run");
    report.environment = { id: env.id, slug: env.slug, forkBlock: fork, exitTimestamp: exitTs };

    stage = "read the vault";
    log.step("Read the vault");
    const v = await readVault(pre, f.vault);
    const unit = 10n ** BigInt(v.assetDecimals);
    /** Whole tokens, rounded down. */
    const whole = (x: bigint): string => num(x / unit);
    /** Every digit: 29,333,972 or 29,333,972.881943. */
    const exact = (x: bigint): string => {
      const a = x < 0n ? -x : x;
      const frac = (a % unit).toString().padStart(v.assetDecimals, "0").replace(/0+$/, "");
      return `${x < 0n ? "-" : ""}${num(a / unit)}${frac ? `.${frac}` : ""}`;
    };
    const sym = v.assetSymbol;
    const capBefore = exitCapacity(v.state);
    log.ok(`${v.name} (${v.symbol}), ${plural(v.markets.length, "market")} in the withdraw queue`);
    log.ok(`${whole(v.state.totalAssets)} ${sym} deposited, ${whole(capBefore)} withdrawable now (${pct(capBefore, v.state.totalAssets)}%)`);

    stage = "find the largest depositor";
    log.step("Find the largest depositor");
    const h = await holdersFromTransfers(p, v.address, await vaultCreationBlock(p, v.address, fork), fork);
    log.ok(`${plural(h.holders.length, "holder")} from ${num(h.logs)} Transfer logs, balances ${h.complete ? "add up to" : "short of"} the total supply`);
    const whale = f.holder ?? h.holders[0]?.address;
    if (!whale) throw new Error(`${v.symbol} has no holders at block ${num(fork)}`);
    const top = h.holders.slice(0, TOP_HOLDERS).map((x) => x.address);
    const listed = top.includes(whale) ? top : [...top, whale];
    const [labels, balances] = await Promise.all([
      holderLabels(p, listed),
      multicall(p, listed.map((a): ContractCall => ({ target: v.address, iface: metaMorphoI, fn: "balanceOf", args: [a] }))),
    ]);
    const shares = balances.map((r) => r![0] as bigint);
    const worth = (await multicall(pre, shares.map((s): ContractCall => ({ target: v.address, iface: metaMorphoI, fn: "convertToAssets", args: [s] }))))
      .map((r) => r![0] as bigint);
    const wi = listed.indexOf(whale);
    const holds = worth[wi];
    if (holds < unit) throw new Error(`${addr(whale)} holds less than 1 ${sym} in ${v.symbol}`);
    // Every digit: the exit asks for whole tokens, and step 4 prints the fraction that stays in the vault.
    log.ok(`${addr(whale)} holds ${exact(holds)} ${sym}, ${pct(shares[wi], h.totalSupply)}% of shares`);
    log.sub(labels[wi] === "EOA" ? "a wallet (EOA)" : `a ${labels[wi]}`);
    report.holders = listed.map((a, i) => ({ address: a, label: labels[i], shares: shares[i], assets: worth[i], pctOfShares: pct(shares[i], h.totalSupply) }));
    save();

    stage = "withdraw everything";
    log.step("Withdraw everything");
    const read = async (q: JsonRpcProvider, fn: string, args: unknown[]): Promise<bigint> =>
      metaMorphoI.decodeFunctionResult(fn, await q.call({ to: v.address, data: metaMorphoI.encodeFunctionData(fn, args) }))[0] as bigint;
    const canPay = await read(pre, "maxWithdraw", [whale]);
    // MetaMorpho's maxWithdraw equals the holding unless the markets can't pay all of it. When they fall short by a
    // whole token or more, the whale asks for 0.1% less than they can pay.
    const capped = holds - canPay >= unit;
    // A whole number of tokens, so the amounts printed below add up exactly.
    const ask = ((capped ? (canPay * 999n) / 1000n : canPay) / unit) * unit;
    if (ask === 0n) throw new Error(`the markets in ${v.symbol}'s withdraw queue can't pay 1 ${sym} now`);
    // Sent as shares: the rehearsal runs on the latest block, 1 s before the exit block, and shares are valid at both.
    const redeemShares = await read(pre, "previewWithdraw", [ask]);
    if (capped) log.warn(`the markets can pay ${whole(canPay)} of ${whole(holds)} ${sym}; it asks for 99.9% of that`);
    const data = metaMorphoI.encodeFunctionData("redeem", [redeemShares, whale, whale]);
    const [rehearsal] = await simulateBundle(p, [{ from: whale, to: v.address, data }]);
    if (!rehearsal.ok) throw new Error(`the rehearsed redeem reverts: ${decodeRevert(rehearsal.output)}`);
    const drainedIds = [...pulledPerMarket(rehearsal.logs, v.morpho, v.address).keys()];
    log.ok(`tenderly_simulateBundle: the redeem succeeds and draws on ${plural(drainedIds.length, "market")}`);

    // Before the send, at the exit's time: the other vaults lending in those markets, and the borrow rates.
    const candidates = (await vaultsForAsset(p, v.asset, fork)).filter((a) => a !== v.address);
    const others = (await Promise.all((await suppliersAmong(pre, v.morpho, candidates, drainedIds, unit))
      .map((a) => readVault(pre, a).catch(() => undefined)))).filter((x): x is Vault => x !== undefined);
    const aprBefore = await borrowAprs(pre, v.morpho, v.markets);

    stage = "send the exit";
    const sent = await sendAs(p, { from: whale, to: v.address, data });
    exitTx = sent.hash;
    if (sent.receipt.status !== 1) throw new Error(`the redeem reverted in block ${num(sent.receipt.blockNumber)}`);
    const withdrawEvent = metaMorphoI.getEvent("Withdraw")!;
    const paid = sent.receipt.logs
      .filter((l) => getAddress(l.address) === v.address && l.topics[0] === withdrawEvent.topicHash)
      .map((l) => metaMorphoI.decodeEventLog(withdrawEvent, l.data, l.topics))
      .filter((d) => getAddress(d.owner) === whale)
      .reduce((s, d) => s + (d.assets as bigint), 0n);
    const pulled = pulledPerMarket(sent.receipt.logs, v.morpho, v.address);
    const left = await read(p, "convertToAssets", [await read(p, "balanceOf", [whale])]);
    log.ok(`eth_sendTransaction: the redeem, sent as ${addr(whale)} without its key`);
    log.ok(`paid ${exact(paid)} ${sym}; ${exact(left)} ${sym} stays in the vault`);

    stage = "compare before and after";
    log.step("After the exit");
    const exitBlock = (await p.getBlock(sent.receipt.blockNumber))!;
    const after = await readState(p, v);
    const capAfter = exitCapacity(after);
    const drained = v.markets.filter((m) => pulled.has(m.id));
    const aprAfter = await borrowAprs(p, v.morpho, drained);
    // Pulled is printed in whole tokens that add up to paid (largest-remainder rounding), free liquidity before rounded
    // down, and after as before minus pulled, so each row and the pulled column add up.
    const pulledWhole = wholeParts(drained.map((m) => pulled.get(m.id)!), unit);
    const marketRows = drained.map((m, i) => {
      const b = v.state.markets[m.id];
      const a = after.markets[m.id];
      const before = b.liquidity / unit;
      return {
        market: m.label, id: m.id, pulled: pulled.get(m.id)!, liquidityBefore: b.liquidity, liquidityAfter: a.liquidity,
        printed: { pulled: pulledWhole[i], liquidityBefore: before, liquidityAfter: before - pulledWhole[i] },
        utilization: `${pct(b.totalBorrow, b.totalSupply)} → ${pct(a.totalBorrow, a.totalSupply)}%`,
        borrowApr: `${apr(aprBefore.get(m.id))} → ${apr(aprAfter.get(m.id))}%`,
      };
    });
    // Markets that gave at least 0.1% of the exit get a row; the rest gave dust and share one line.
    const mainRows = marketRows.filter((r) => r.pulled * 1000n >= paid);
    const dustRows = marketRows.filter((r) => r.pulled * 1000n < paid);
    const pulledWidth = Math.max(0, ...mainRows.map((r) => num(r.printed.pulled).length));
    log.table(
      [`market (${sym})`, "pulled", "free liquidity", "utilization", "borrow APR"],
      mainRows.map((r) => [
        r.market, num(r.printed.pulled).padStart(pulledWidth),
        `${num(r.printed.liquidityBefore)} → ${num(r.printed.liquidityAfter)}`, r.utilization, r.borrowApr,
      ]),
    );
    if (dustRows.length) {
      const dust = dustRows.reduce((s, r) => s + r.printed.pulled, 0n);
      log.note(`and ${plural(dustRows.length, "more market")}: ${num(dust)} ${sym}, each under 0.1% of the exit`);
    }
    // Whatever the vaults (MetaMorpho, Morpho Vault V1) don't account for in a market is lent by others: Vault V2
    // adapters, other contracts, people.
    const otherLenders = mainRows.map((r) => {
      const b = v.state.markets[r.id];
      const byVaults = b.supply + others.reduce((s, o) => s + (o.state.markets[r.id]?.supply ?? 0n), 0n);
      return { market: r.market, otherLenders: b.totalSupply > byVaults ? b.totalSupply - byVaults : 0n, totalSupply: b.totalSupply };
    });
    for (const o of otherLenders) {
      log.note(`${o.market}: other lenders (not vaults) supply ${whole(o.otherLenders)} of ${whole(o.totalSupply)} ${sym}`);
    }

    const rule = BigInt(Math.round(f.minExitPct * 100));
    const meets = (capacity: bigint, deposits: bigint): boolean => capacity * 10_000n >= deposits * rule;
    const otherRows = (await Promise.all(others.map(async (o) => {
      const oAfter = await readState(p, o);
      const before = exitCapacity(o.state);
      const now = exitCapacity(oAfter);
      return {
        vault: o.address, name: o.name, depositsBefore: o.state.totalAssets, depositsAfter: oAfter.totalAssets,
        withdrawableBefore: before, withdrawableAfter: now, lost: before > now ? before - now : 0n,
        crossedRule: meets(before, o.state.totalAssets) && !meets(now, oAfter.totalAssets),
      };
    }))).sort((a, b) => (b.lost > a.lost ? 1 : b.lost < a.lost ? -1 : 0));
    const hit = otherRows.filter((r) => r.lost >= unit);
    log.blank();
    log.table(
      [`vault (${sym})`, "deposits after", "withdrawable", "% of deposits"],
      [
        [v.symbol, whole(after.totalAssets), `${whole(capBefore)} → ${whole(capAfter)}`, `${pct(capBefore, v.state.totalAssets)} → ${pct(capAfter, after.totalAssets)}%`],
        ...hit.map((r) => [
          r.name.slice(0, 26), whole(r.depositsAfter), `${whole(r.withdrawableBefore)} → ${whole(r.withdrawableAfter)}`,
          `${pct(r.withdrawableBefore, r.depositsBefore)} → ${pct(r.withdrawableAfter, r.depositsAfter)}%`,
        ]),
      ],
    );
    const unhurt = otherRows.length - hit.length;
    if (unhurt) log.note(`${plural(unhurt, "more vault")} lend${unhurt === 1 ? "s" : ""} there; the exit doesn't change what they can withdraw`);

    // The printed amounts must add up: before minus paid is after in whole tokens, the whale's holding to the last
    // digit (it is printed in full), and the pulled rows add up to paid. Underneath, the markets must give exactly
    // what the vault paid, and each market's free liquidity must fall by it.
    const problems: string[] = [];
    const addsUp = (what: string, before: bigint, change: bigint, after: bigint): void => {
      if (before / unit - change / unit !== after / unit) problems.push(`${what} ${whole(before)} − ${whole(change)} ≠ ${whole(after)}`);
    };
    if (exitBlock.timestamp !== exitTs) problems.push(`exit block time ${utc(exitBlock.timestamp)}, pinned ${utc(exitTs)}`);
    addsUp(`${v.symbol} deposits`, v.state.totalAssets, paid, after.totalAssets);
    addsUp(`${v.symbol} withdrawable`, capBefore, paid, capAfter);
    if (holds - paid !== left) problems.push(`the whale's holding ${exact(holds)} − ${exact(paid)} ≠ ${exact(left)}`);
    const printedTotal = marketRows.reduce((s, r) => s + r.printed.pulled, 0n);
    if (printedTotal !== paid / unit) problems.push(`the pulled rows add up to ${num(printedTotal)} ${sym}, paid ${whole(paid)}`);
    const pulledTotal = marketRows.reduce((s, r) => s + r.pulled, 0n);
    if (pulledTotal !== paid) problems.push(`the markets gave ${exact(pulledTotal)} ${sym}, the vault paid ${exact(paid)}`);
    for (const r of marketRows) {
      if (r.liquidityBefore - r.pulled !== r.liquidityAfter) {
        problems.push(`${r.market}: free liquidity fell ${exact(r.liquidityBefore - r.liquidityAfter)}, pulled ${exact(r.pulled)}`);
      }
    }

    const full = left < unit;
    const liquid = meets(capAfter, after.totalAssets);
    const crossed = otherRows.filter((r) => r.crossedRule).map((r) => r.name);
    const ok = problems.length === 0 && full && liquid;
    Object.assign(report, {
      vault: {
        address: v.address, name: v.name, symbol: v.symbol, asset: sym, decimals: v.assetDecimals,
        before: { deposits: v.state.totalAssets, withdrawable: capBefore },
        after: { deposits: after.totalAssets, withdrawable: capAfter, block: exitBlock.number },
      },
      whale: { address: whale, label: labels[wi], shares: shares[wi], holds, canPay, asked: ask, redeemShares, paid, left, tx: sent.hash },
      markets: marketRows,
      otherVaults: otherRows,
      otherLenders,
      problems,
      result: ok ? "PASS" : "FAIL",
    });

    if (!ok) log.blank();
    if (problems.length) {
      log.fail(problems[0]);
      for (const pr of problems.slice(1)) log.sub(pr);
    }
    const where = `${v.symbol} at block ${num(exitBlock.number)}`;
    if (!full) {
      log.fail(`${where}: the whale got ${whole(paid)} of ${whole(holds)} ${sym}`);
      log.sub(`${whole(left)} ${sym} stay in the vault until borrowers repay or new deposits arrive`);
    }
    if (!liquid) {
      log.fail(`${where}: others can withdraw ${pct(capAfter, after.totalAssets)}% of deposits, rule ${f.minExitPct}%`);
      const biggest = [...mainRows].sort((a, b) => (b.pulled > a.pulled ? 1 : -1))[0];
      if (biggest) {
        log.sub(`the exit took ${num(biggest.printed.pulled)} of the ${num(biggest.printed.liquidityBefore)} ${sym} free in ${biggest.market}`);
      }
      const names = `${andList(crossed)} also fell under ${f.minExitPct}%`;
      if (crossed.length) log.sub(names.length <= 81 ? names : `${plural(crossed.length, "other vault")} also fell under ${f.minExitPct}%`);
    }
    closing(`exact amounts, the ${TOP_HOLDERS} largest holders and ${plural(others.length, "other vault")}`);
    if (problems.length) return log.result(false, "the printed amounts don't add up");
    if (!full) return log.result(false, `whale got ${whole(paid)} of ${whole(holds)} ${sym}`);
    if (!liquid) return log.result(false, `others can withdraw ${pct(capAfter, after.totalAssets)}%, under the ${f.minExitPct}% rule`);
    return log.result(true, `exit paid, others can withdraw ${pct(capAfter, after.totalAssets)}% (rule ${f.minExitPct}%)`);
  } catch (err) {
    const why = log.redact(`${stage}: ${err instanceof Error ? err.message : String(err)}`);
    const [first, ...rest] = wrap(why);
    log.fail(first);
    for (const l of rest) log.sub(l);
    report.error = why;
    closing("what the run read before it stopped");
    return log.result(false, `stopped at: ${stage}`);
  }
}

main().then((code) => process.exit(code), (err) => process.exit(log.fatal(err)));
