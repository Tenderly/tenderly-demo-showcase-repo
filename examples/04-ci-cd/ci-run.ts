#!/usr/bin/env tsx
/**
 * Local emulation of the per-PR CI pipeline (what the GitHub Action does in CI).
 *
 *   npm run ci                 # provision a fresh ephemeral Environment, run the test, keep it
 *   npm run ci -- --pr 4217    # label it with a PR number
 *   npm run ci -- --cleanup    # tear the Environment down at the end (true CI behavior)
 *
 * The GitHub Action (../../.github/workflows/vnet-ci.yml) runs only in
 * GitHub. This script reproduces the same flow on your machine so you can DEMO it
 * and open the result in the dashboard UI:
 *
 *   1. provision a FRESH, ephemeral Virtual Environment for this "PR" (a real mainnet fork)
 *   2. run the settlement test against it (cheat-code seed -> impersonated settlements)
 *   3. leave decoded transactions in the dashboard to inspect (call trace, state diff,
 *      gas profiler) — or tear it down with --cleanup, exactly as CI mode does
 *
 * Each run makes a new environment (reuse off), just like a new PR gets its own.
 */
import { JsonRpcProvider, Interface, parseUnits, getAddress } from "ethers";
import assert from "node:assert/strict";
import { provisionTestNet, fundNative, setErc20Balance, deleteTestNets } from "./lib/testnet.js";

const USDC = getAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"); // mainnet USDC, 6 dp
const TREASURY = getAddress("0x1111111111111111111111111111111111111111");
const PAYROLL = getAddress("0x2222222222222222222222222222222222222222");
const VENDOR = getAddress("0x4444444444444444444444444444444444444444");

const SEED = parseUnits("1000000", 6);
const PAY_PAYROLL = parseUnits("250000", 6);
const PAY_VENDOR = parseUnits("100000", 6);

const erc20 = new Interface([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);
const toHex = (v: bigint): string => "0x" + v.toString(16);
const usd = (v: bigint): string => (v / 1_000_000n).toLocaleString("en-US") + " USDC";

function parseArgs(argv: string[]): { pr: string; cleanup: boolean } {
  let pr = "";
  let cleanup = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--pr") pr = argv[++i] ?? "";
    else if (argv[i] === "--cleanup") cleanup = true;
  }
  // A unique-ish label per run when no PR number is given.
  if (!pr) pr = String(Date.now()).slice(-5);
  return { pr, cleanup };
}

async function balanceOf(provider: JsonRpcProvider, owner: string): Promise<bigint> {
  return BigInt(await provider.call({ to: USDC, data: erc20.encodeFunctionData("balanceOf", [owner]) }));
}

async function settle(admin: JsonRpcProvider, to: string, amount: bigint): Promise<string> {
  // Impersonated, unsigned send — auto-mines one block, decoded in the dashboard.
  return admin.send("eth_sendTransaction", [
    { from: TREASURY, to: USDC, data: erc20.encodeFunctionData("transfer", [to, amount]) },
  ]);
}

async function main(): Promise<void> {
  const { pr, cleanup } = parseArgs(process.argv.slice(2));
  console.log(`CI pipeline (emulated) — PR #${pr}`);
  console.log("Provisioning a fresh, ephemeral Virtual Environment for this PR ...");

  // Fresh env every run (reuse: false) — a new PR gets its own private mainnet fork.
  const tn = await provisionTestNet({ env: `ci-pr-${pr}`, explorer: true, reuse: false });
  console.log(`  created: ${tn.displayName}  (chain ${tn.chainId})`);
  console.log(`  dashboard: ${tn.dashboardUrl}\n`);

  const admin = new JsonRpcProvider(tn.adminRpc);
  const pub = new JsonRpcProvider(tn.publicRpc);

  // --- the test: seed deterministic state, run two settlements, assert deltas ---
  try {
    await fundNative(tn.adminRpc, [TREASURY]);
    await setErc20Balance(tn.adminRpc, USDC, TREASURY, toHex(SEED));
    await setErc20Balance(tn.adminRpc, USDC, PAYROLL, "0x0");
    await setErc20Balance(tn.adminRpc, USDC, VENDOR, "0x0");
    console.log(`Seeded treasury with ${usd(SEED)} (cheat codes).`);

    const tx1 = await settle(admin, PAYROLL, PAY_PAYROLL);
    const tx2 = await settle(admin, VENDOR, PAY_VENDOR);
    console.log(`Settled ${usd(PAY_PAYROLL)} -> payroll   (${tx1})`);
    console.log(`Settled ${usd(PAY_VENDOR)} -> vendor    (${tx2})`);

    assert.equal(await balanceOf(pub, PAYROLL), PAY_PAYROLL, "payroll received 250,000 USDC");
    assert.equal(await balanceOf(pub, VENDOR), PAY_VENDOR, "vendor received 100,000 USDC");
    assert.equal(await balanceOf(pub, TREASURY), SEED - PAY_PAYROLL - PAY_VENDOR, "treasury debited 350,000 USDC");
    console.log("\n✔ settlement checks PASSED");
  } catch (err) {
    console.error("\n✖ settlement checks FAILED");
    console.error(err instanceof Error ? err.message : err);
    if (cleanup) await deleteTestNets([tn.id]);
    process.exit(1);
  }

  // --- CI teardown vs. keep-for-inspection ---
  if (cleanup) {
    await deleteTestNets([tn.id]);
    console.log("\nTore down the ephemeral Environment (mirrors CI mode).");
  } else {
    console.log("\nShowcase in the UI — open the Environment and inspect this PR's run:");
    console.log(`  ${tn.dashboardUrl}`);
    console.log("    • Transactions  — two decoded USDC settlements");
    console.log("    • Call trace    — open a settlement -> USDC.transfer, decoded");
    console.log("    • State diff    — balances moved on the settled accounts");
    console.log("    • Gas Profiler  — per-call gas for each settlement");
    console.log("  (In CI, mode:CI tears this down automatically. Re-run with --cleanup to do the same.)");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
