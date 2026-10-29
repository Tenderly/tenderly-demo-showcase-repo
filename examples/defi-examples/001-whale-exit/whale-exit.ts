#!/usr/bin/env tsx
/**
 * Whale exit: a vault's largest depositor withdraws everything, on a Virtual Environment forked from Ethereum.
 *
 *   npm run demo                                   # steakUSDC's largest depositor, at a pinned block
 *   npm run demo -- --vault 0x… --block latest     # any MetaMorpho vault, any block
 *   npm run demo -- --holder 0x…                   # a given depositor instead of the largest
 *   npm run demo -- --min-exit-pct 60              # a stricter liquidity rule (npm run demo:fail)
 *   npm run demo -- --cleanup                      # delete the environment at the end
 *
 * With real state at the fork block it answers:
 *   1. How much can the largest depositor take out, and how much stays stuck?
 *   2. Which markets does the exit drain, and what happens to their utilization and borrow rate?
 *   3. What can the vault's other depositors still withdraw afterwards?
 *   4. Which other vaults lend in the same markets, and how much exit liquidity do they lose?
 *
 * The exit is rehearsed with tenderly_simulateBundle first, then sent for real as the impersonated holder (no key),
 * so the transaction stays in the environment to open in the dashboard. The script exits 1 when the depositor can't
 * leave in full, or when the vault's other depositors can withdraw less than --min-exit-pct of their deposits.
 */
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress } from "ethers";
import { createEnvironment, deleteEnvironment, providerFor, requireEnv, sendAs, setBalance, simulateBundle } from "./lib/tenderly.js";
import { multicall, type ContractCall } from "./lib/multicall.js";
import {
  borrowAprs, decodeRevert, exitCapacity, metaMorphoI, pulledPerMarket, readState, readVault, suppliersAmong, vaultCreationBlock, vaultsForAsset,
  type Vault, type VaultMarket, type VaultState,
} from "./lib/morpho.js";
import { holderLabels, holdersFromTransfers } from "./lib/holders.js";

const DEFAULT_VAULT = "0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB"; // Steakhouse USDC (steakUSDC), MetaMorpho on Ethereum
const DEFAULT_BLOCK = 26_242_540; // pinned so every run sees the same depositors and markets
const NETWORK_ID = 1;
const CHAIN_ID = 73571; // virtual chain id: the 7357 prefix + 1, so transactions can't be replayed on mainnet

const { values: args } = parseArgs({
  options: {
    vault: { type: "string" },
    block: { type: "string" },
    holder: { type: "string" },
    "min-exit-pct": { type: "string" },
    cleanup: { type: "boolean", default: false },
  },
});
const VAULT = getAddress(args.vault ?? DEFAULT_VAULT);
const BLOCK: number | "latest" = args.block === "latest" ? "latest" : Number(args.block ?? DEFAULT_BLOCK);
const MIN_EXIT_PCT = Number(args["min-exit-pct"] ?? 25);

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "out");
const started = Date.now();
const section = (t: string): void => console.log(`\n\x1b[1m${t}\x1b[0m`);
const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
const pct = (a: bigint, b: bigint): string => (b === 0n ? "0.0%" : `${(Number((a * 10_000n) / b) / 100).toFixed(1)}%`);
const util = (borrow: bigint, supply: bigint): string => pct(borrow, supply);
const apr = (x: number): string => `${(x * 100).toFixed(2)}%`;

async function main(): Promise<number> {
  const env = requireEnv();

  section("1. Environment");
  const e = await createEnvironment(env, `Whale exit ${short(VAULT)} @ ${BLOCK}`, NETWORK_ID, BLOCK, CHAIN_ID);
  const p = providerFor(e.adminRpc, CHAIN_ID);
  const fork = await p.getBlockNumber();
  console.log(`  created a Virtual Environment forking Ethereum at block ${fork.toLocaleString("en-US")} (chain ${CHAIN_ID})`);

  let sent = false;
  try {
    // ---- 2. the vault ----------------------------------------------------------------------------
    section("2. The vault");
    const v = await readVault(p, VAULT);
    const amt = (x: bigint): string => {
      const n = Number(x) / 10 ** v.assetDecimals;
      const s = n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n.toLocaleString("en-US", { maximumFractionDigits: n >= 1e3 ? 0 : 2 });
      return `${s} ${v.assetSymbol}`;
    };
    // One whole token: less than this left behind or lost counts as nothing (share rounding leaves a few wei).
    const unit = 10n ** BigInt(v.assetDecimals);
    const capBefore = exitCapacity(v.state);
    console.log(`  ${v.name} (${v.symbol}): ${amt(v.state.totalAssets)} deposited, ${v.markets.length} markets in the withdraw queue`);
    console.log(`  depositors can withdraw ${amt(capBefore)} right now, ${pct(capBefore, v.state.totalAssets)} of deposits. The rest is lent out.`);

    // ---- 3. depositors ---------------------------------------------------------------------------
    section("3. Depositors");
    const h = await holdersFromTransfers(p, v.address, await vaultCreationBlock(p, v.address, fork), fork);
    console.log(`  ${h.holders.length.toLocaleString("en-US")} holders from ${h.logs.toLocaleString("en-US")} Transfer logs${h.complete ? ", and their balances add up to totalSupply" : ". Their balances don't add up to totalSupply, so the list may be incomplete"}`);
    const top = h.holders.slice(0, 5);
    const whale = getAddress(args.holder ?? top[0].address);
    const listed = top.some((x) => x.address === whale) ? top.map((x) => x.address) : [...top.map((x) => x.address), whale];
    const [labels, shareReads] = await Promise.all([
      holderLabels(p, listed),
      multicall(p, listed.map((a): ContractCall => ({ target: v.address, iface: metaMorphoI, fn: "balanceOf", args: [a] }))),
    ]);
    const shares = shareReads.map((r) => r![0] as bigint);
    const assets = (await multicall(p, shares.map((s): ContractCall => ({ target: v.address, iface: metaMorphoI, fn: "convertToAssets", args: [s] })))).map((r) => r![0] as bigint);
    listed.forEach((a, i) => {
      const mark = a === whale ? "  ← the whale" : "";
      console.log(`  ${short(a)}  ${labels[i].slice(0, 44).padEnd(44)} ${amt(assets[i]).padStart(16)}  ${pct(shares[i], h.totalSupply).padStart(6)}${mark}`);
    });
    const wi = listed.indexOf(whale);
    const whaleShares = shares[wi];
    const whaleAssets = assets[wi];
    if (whaleShares === 0n) throw new Error(`${whale} holds no ${v.symbol} at block ${fork}`);

    // ---- 4. the exit -----------------------------------------------------------------------------
    section("4. The whale withdraws everything");
    // Gas first: a cheat code mines a block, and the interest it accrues shrinks what the markets can pay.
    await setBalance(p, [whale], 10n ** 18n);
    const [maxRedeem] = metaMorphoI.decodeFunctionResult("maxRedeem", await p.call({ to: v.address, data: metaMorphoI.encodeFunctionData("maxRedeem", [whale]) }));
    // maxRedeem sits a few wei under the balance from rounding even when liquidity is ample, so the markets only cap
    // the exit when they fall short by at least one whole token.
    const [shortfall] = metaMorphoI.decodeFunctionResult("convertToAssets", await p.call({ to: v.address, data: metaMorphoI.encodeFunctionData("convertToAssets", [whaleShares - (maxRedeem as bigint)]) }));
    const capped = (shortfall as bigint) >= unit;
    // The redeem mines a block later, with a little more interest owed, so it stays a margin under maxRedeem:
    // 0.1% when liquidity is the limit, a billionth when only rounding is.
    const redeemShares = capped ? ((maxRedeem as bigint) * 999n) / 1000n : (maxRedeem as bigint) - (maxRedeem as bigint) / 1_000_000_000n;
    const [canPay] = metaMorphoI.decodeFunctionResult("convertToAssets", await p.call({ to: v.address, data: metaMorphoI.encodeFunctionData("convertToAssets", [maxRedeem]) }));
    console.log(`  ${short(whale)} holds ${amt(whaleAssets)}, ${pct(whaleShares, h.totalSupply)} of the vault, and asks for all of it`);
    console.log(`  the markets in the withdraw queue can pay ${amt(canPay as bigint)} of it right now${capped ? ", so it redeems 99.9% of that to leave room for interest that accrues before the redeem mines" : ""}`);
    if (redeemShares === 0n) {
      throw new Error(`${v.symbol} can't pay ${short(whale)} anything right now: every market in its withdraw queue is fully lent out`);
    }
    const data = metaMorphoI.encodeFunctionData("redeem", [redeemShares, whale, whale]);
    const [rehearsal] = await simulateBundle(p, [{ from: whale, to: v.address, data }]);
    if (!rehearsal.ok) throw new Error(`the rehearsed redeem of ${redeemShares} shares reverted: ${decodeRevert(rehearsal.output)}`);
    const drainedIds = [...pulledPerMarket(rehearsal.logs, v.morpho, v.address).keys()];
    const drained = v.markets.filter((m) => drainedIds.includes(m.id));
    console.log(`  rehearsed with tenderly_simulateBundle: the redeem goes through and takes liquidity from ${drained.length} market${drained.length === 1 ? "" : "s"}`);

    // Before the real send: the other vaults lending in those markets, and the markets' borrow rates.
    const candidates = (await vaultsForAsset(p, v.asset, fork)).filter((a) => a !== v.address);
    const others = (await Promise.all((await suppliersAmong(p, v.morpho, candidates, drainedIds, unit)).map((a) => readVault(p, a).catch(() => undefined))))
      .filter((x): x is Vault => x !== undefined);
    const aprBefore = await borrowAprs(p, v.morpho, drained);

    const tx = await sendAs(p, whale, v.address, data);
    sent = true;
    if (tx.receipt?.status !== 1) throw new Error(`the redeem reverted on the environment: ${tx.hash}`);
    const withdrawEvent = metaMorphoI.getEvent("Withdraw")!;
    const paid = (tx.receipt.logs ?? [])
      .filter((l) => getAddress(l.address) === v.address && l.topics[0] === withdrawEvent.topicHash)
      .map((l) => metaMorphoI.decodeEventLog(withdrawEvent, l.data, l.topics))
      .filter((d) => getAddress(d.owner) === whale)
      .reduce((s, d) => s + (d.assets as bigint), 0n);
    const pulled = pulledPerMarket(tx.receipt.logs ?? [], v.morpho, v.address);
    const [leftShares] = metaMorphoI.decodeFunctionResult("balanceOf", await p.call({ to: v.address, data: metaMorphoI.encodeFunctionData("balanceOf", [whale]) }));
    const [stuck] = metaMorphoI.decodeFunctionResult("convertToAssets", await p.call({ to: v.address, data: metaMorphoI.encodeFunctionData("convertToAssets", [leftShares]) }));
    const fullExit = (stuck as bigint) < unit;
    console.log(`  sent for real as the holder (impersonated, no key): paid ${amt(paid)}${fullExit ? ", nothing left behind" : `, ${amt(stuck as bigint)} stays stuck in the vault`}`);

    // ---- 5. markets ------------------------------------------------------------------------------
    section("5. Markets the exit drained");
    const after = await readState(p, v);
    const aprAfter = await borrowAprs(p, v.morpho, drained);
    const marketRows = drained.map((m: VaultMarket) => {
      const b = v.state.markets[m.id];
      const a = after.markets[m.id];
      return {
        market: m.label, id: m.id, pulled: pulled.get(m.id) ?? 0n,
        liquidityBefore: b.liquidity, liquidityAfter: a.liquidity,
        utilizationBefore: util(b.totalBorrow, b.totalSupply), utilizationAfter: util(a.totalBorrow, a.totalSupply),
        borrowAprBefore: apr(aprBefore.get(m.id) ?? 0), borrowAprAfter: apr(aprAfter.get(m.id) ?? 0),
      };
    });
    // Markets that carried at least 0.1% of the exit; the rest only gave up dust and are summed up in one line.
    const mainRows = marketRows.filter((r) => r.pulled * 1000n >= paid);
    const dustMarkets = marketRows.length - mainRows.length;
    if (marketRows.length === 0) console.log("  none");
    else console.log(`  ${"market".padEnd(24)}${"pulled".padStart(14)}   ${"free liquidity".padEnd(26)}${"utilization".padEnd(18)}borrow APR`);
    for (const r of mainRows) {
      console.log(`  ${r.market.padEnd(24)}${amt(r.pulled).padStart(14)}   ${`${amt(r.liquidityBefore)} → ${amt(r.liquidityAfter)}`.padEnd(26)}${`${r.utilizationBefore} → ${r.utilizationAfter}`.padEnd(18)}${r.borrowAprBefore} → ${r.borrowAprAfter}`);
    }
    if (dustMarkets) console.log(`  and ${dustMarkets} more market${dustMarkets === 1 ? "" : "s"}, each with less than 0.1% of the exit`);

    // ---- 6. everyone else ------------------------------------------------------------------------
    section("6. Everyone else");
    const capAfter = exitCapacity(after);
    console.log(`  ${v.symbol}'s other depositors: ${amt(after.totalAssets)} deposited, can withdraw ${amt(capAfter)} now, ${pct(capAfter, after.totalAssets)} of deposits (before: ${pct(capBefore, v.state.totalAssets)})`);
    const meetsRule = (capacity: bigint, deposits: bigint): boolean => capacity * 100n >= deposits * BigInt(MIN_EXIT_PCT);
    const otherRows = (await Promise.all(others.map(async (o) => {
      const oAfter: VaultState = await readState(p, o);
      const before = exitCapacity(o.state);
      const now = exitCapacity(oAfter);
      return {
        vault: o.address, name: o.name, depositsBefore: o.state.totalAssets, depositsAfter: oAfter.totalAssets, capacityBefore: before, capacityAfter: now,
        lost: before > now ? before - now : 0n,
        crossedRule: meetsRule(before, o.state.totalAssets) && !meetsRule(now, oAfter.totalAssets),
      };
    }))).sort((a, b) => (b.lost > a.lost ? 1 : b.lost < a.lost ? -1 : 0));
    const hit = otherRows.filter((r) => r.lost >= unit);
    if (hit.length) console.log(`  other MetaMorpho vaults lending in the same markets, by what their depositors can withdraw:`);
    for (const r of hit) {
      console.log(`    ${r.name.slice(0, 32).padEnd(32)} ${`${amt(r.capacityBefore)} → ${amt(r.capacityAfter)}`.padEnd(30)} ${`${pct(r.capacityBefore, r.depositsBefore)} → ${pct(r.capacityAfter, r.depositsAfter)}`.padEnd(16)} of ${amt(r.depositsAfter)} deposits`);
    }
    const unhurt = otherRows.length - hit.length;
    if (unhurt) console.log(`  ${unhurt} more MetaMorpho vault${unhurt === 1 ? " lends" : "s lend"} there, but the exit didn't change what their depositors can withdraw`);
    // Whatever the vaults don't account for in a market is lent by others: Vault V2 adapters, other contracts, people.
    const lenderRows = drained.map((m) => {
      const b = v.state.markets[m.id];
      const byVaults = b.supply + others.reduce((s, o) => s + (o.state.markets[m.id]?.supply ?? 0n), 0n);
      return { market: m.label, otherLenders: b.totalSupply > byVaults ? b.totalSupply - byVaults : 0n, totalSupply: b.totalSupply };
    });
    for (const r of lenderRows.filter((x) => mainRows.some((m) => m.market === x.market))) {
      console.log(`  ${r.market}: other lenders (not MetaMorpho vaults) supply ${amt(r.otherLenders)} of ${amt(r.totalSupply)}, and share the same free liquidity`);
    }

    // ---- result ----------------------------------------------------------------------------------
    const liquidEnough = meetsRule(capAfter, after.totalAssets);
    const ok = fullExit && liquidEnough;
    console.log("");
    if (ok) {
      console.log(`\x1b[32mRESULT PASS\x1b[0m  the whale left in full with ${amt(paid)}, and ${v.symbol}'s other depositors can still withdraw ${pct(capAfter, after.totalAssets)} of their deposits (rule: at least ${MIN_EXIT_PCT}%)`);
    } else {
      console.log(`\x1b[31mRESULT FAIL\x1b[0m  ${!fullExit ? `the whale got ${amt(paid)} out and ${amt(stuck as bigint)} stays stuck` : `after the whale left, ${v.symbol}'s other depositors can withdraw only ${pct(capAfter, after.totalAssets)} of their deposits (rule: at least ${MIN_EXIT_PCT}%)`}`);
      if (!fullExit) {
        console.log(`  where  ${v.symbol} at block ${fork}: ${short(whale)} asked for ${amt(whaleAssets)} and got ${amt(paid)}, all the markets in the withdraw queue could pay`);
        console.log(`  why    the rest is lent to borrowers. It comes back only as they repay or new deposits arrive, and until then the vault can't pay it out`);
      }
      if (!liquidEnough) {
        const took = mainRows.map((r) => `${amt(r.pulled)} of the ${amt(r.liquidityBefore)} free in ${r.market}`).join(", ");
        console.log(`  where  ${v.symbol} after the exit: ${amt(capAfter)} withdrawable of ${amt(after.totalAssets)} deposits${took ? `. The exit took ${took}` : ""}`);
        console.log(`  why    a run on the vault would pay the first ${pct(capAfter, after.totalAssets)} of deposits and leave everyone else waiting for borrowers to repay`);
      }
    }
    const crossed = otherRows.filter((r) => r.crossedRule);
    if (crossed.length) console.log(`  note   the exit also took ${crossed.length} other vault${crossed.length === 1 ? "" : "s"} under ${MIN_EXIT_PCT}%: ${crossed.map((r) => r.name).join(", ")}`);

    // ---- report and links ------------------------------------------------------------------------
    const txUrl = e.explorerUrl ? `${e.explorerUrl}/tx/${tx.hash}` : "";
    mkdirSync(outDir, { recursive: true });
    const report = {
      block: fork,
      vault: { address: v.address, name: v.name, symbol: v.symbol, deposits: v.state.totalAssets, exitCapacityBefore: capBefore, depositsAfter: after.totalAssets, exitCapacityAfter: capAfter },
      whale: { address: whale, label: labels[wi], shares: whaleShares, assets: whaleAssets, paid, stuck, tx: tx.hash },
      markets: marketRows,
      otherVaults: otherRows,
      otherLenders: lenderRows,
      rule: { minExitPct: MIN_EXIT_PCT },
      result: ok ? "PASS" : "FAIL",
      links: { dashboard: e.dashboardUrl, explorer: e.explorerUrl, tx: txUrl },
    };
    writeFileSync(resolve(outDir, "report.json"), JSON.stringify(report, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2));

    console.log("\nLinks");
    console.log(`  dashboard  ${e.dashboardUrl}`);
    if (e.explorerUrl) console.log(`  explorer   ${e.explorerUrl}`);
    if (txUrl) console.log(`  exit tx    ${txUrl}`);
    console.log(`  report     out/report.json`);

    if (args.cleanup) {
      console.log(`\nDeleted the environment (--cleanup): ${(await deleteEnvironment(env, e.id)) ? "done" : "failed, delete it in the dashboard"}`);
    } else {
      console.log("\nThe environment stays up so the links keep working. Delete it in the dashboard, or run with --cleanup.");
    }
    console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
    return ok ? 0 : 1;
  } catch (err) {
    // Nothing was sent, so there's nothing to look at: don't leave the environment behind.
    if (!sent || args.cleanup) await deleteEnvironment(env, e.id);
    throw err;
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(`\n✖ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
