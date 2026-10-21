#!/usr/bin/env tsx
/**
 * Automated settlement test against a Tenderly Virtual Environment.
 *
 * This is what an automation/QA engineer writes to test the treasury app in a
 * higher environment. It uses the built-in Node test runner (`node:test`) and
 * ethers — no framework, no private keys, no faucet. The pattern is the usual
 * arrange / act / assert, but every step talks to a real fork of mainnet:
 *
 *   arrange  cheat codes seed deterministic state on the ADMIN RPC
 *            (tenderly_setErc20Balance mints USDC, tenderly_setBalance funds gas)
 *   act      impersonate the treasury wallet and settle USDC to a counterparty
 *            (unsigned eth_sendTransaction — auto-mines one block)
 *   assert   read balances back over JSON-RPC and check the deltas
 *   profile  read the receipt's gasUsed (the dashboard Gas Profiler breaks it
 *            down per internal call — link printed below)
 *   reset    evm_snapshot before a change and evm_revert to roll it back — how a
 *            suite isolates cases without re-provisioning
 *   time     evm_increaseTime advances the chain clock to test time-dependent logic
 *
 * Cheat codes used (Tenderly Admin RPC): tenderly_setErc20Balance, tenderly_setBalance,
 * impersonated eth_sendTransaction, evm_snapshot, evm_revert, evm_increaseTime.
 *
 * RPC resolution (runs locally AND in CI unchanged):
 *   - CI: the Tenderly GitHub Action exports TENDERLY_ADMIN_RPC_URL_1 /
 *     TENDERLY_PUBLIC_RPC_URL_1 — used as-is.
 *   - Local: falls back to TENDERLY_ADMIN_RPC / RPC_URL, else provisions (or
 *     reuses) the `qa` Virtual Environment via the shared library.
 *
 *   npm test                       # uses qa (or CI-provided RPC)
 *   TEST_ENV=uat npm test          # target a different environment
 */
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { JsonRpcProvider, Interface, parseUnits, getAddress } from "ethers";
import { provisionTestNet, fundNative, setErc20Balance } from "./lib/testnet.js";

// On-chain target: USDC on Ethereum mainnet (6 decimals). The fork has it for real.
const USDC = getAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");

// Shared team wallets (impersonated on the Admin RPC — no keys needed).
const TREASURY = getAddress("0x1111111111111111111111111111111111111111");
const COUNTERPARTY = getAddress("0x2222222222222222222222222222222222222222");

const SEED = parseUnits("1000000", 6); // 1,000,000 USDC starting treasury balance
const SETTLE = parseUnits("250000", 6); //   250,000 USDC settlement amount

const erc20 = new Interface([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);

const toHex = (v: bigint): string => "0x" + v.toString(16);

interface Env {
  adminUrl: string;
  admin: JsonRpcProvider;
  pub: JsonRpcProvider;
  dashboardUrl: string;
}

async function resolveEnv(): Promise<Env> {
  const adminUrl = process.env.TENDERLY_ADMIN_RPC_URL_1 ?? process.env.TENDERLY_ADMIN_RPC;
  const pubUrl = process.env.TENDERLY_PUBLIC_RPC_URL_1 ?? process.env.RPC_URL;
  if (adminUrl) {
    return {
      adminUrl,
      admin: new JsonRpcProvider(adminUrl),
      pub: new JsonRpcProvider(pubUrl ?? adminUrl),
      dashboardUrl: "(provided by CI)",
    };
  }
  const tn = await provisionTestNet({ env: process.env.TEST_ENV ?? "qa", explorer: true });
  return {
    adminUrl: tn.adminRpc,
    admin: new JsonRpcProvider(tn.adminRpc),
    pub: new JsonRpcProvider(tn.publicRpc),
    dashboardUrl: tn.dashboardUrl,
  };
}

async function balanceOf(provider: JsonRpcProvider, owner: string): Promise<bigint> {
  const data = erc20.encodeFunctionData("balanceOf", [owner]);
  return BigInt(await provider.call({ to: USDC, data }));
}

describe("treasury USDC settlement on a Virtual Environment", () => {
  let env: Env;
  let settlementTx: string;

  before(async () => {
    env = await resolveEnv();
    const net = await env.pub.getNetwork();
    console.log(`\nConnected to Virtual Environment (chainId=${net.chainId}). Dashboard: ${env.dashboardUrl}`);
  });

  test("arrange: cheat codes seed deterministic balances and gas", async () => {
    await fundNative(env.adminUrl, [TREASURY, COUNTERPARTY]);
    await setErc20Balance(env.adminUrl, USDC, TREASURY, toHex(SEED));
    await setErc20Balance(env.adminUrl, USDC, COUNTERPARTY, "0x0");

    assert.equal(await balanceOf(env.pub, TREASURY), SEED, "treasury seeded to 1,000,000 USDC");
    assert.equal(await balanceOf(env.pub, COUNTERPARTY), 0n, "counterparty reset to 0");
  });

  test("act + assert: settle 250,000 USDC and verify the deltas", async () => {
    const data = erc20.encodeFunctionData("transfer", [COUNTERPARTY, SETTLE]);
    // Impersonated, unsigned send — auto-mines one block on the Environment.
    settlementTx = await env.admin.send("eth_sendTransaction", [{ from: TREASURY, to: USDC, data }]);
    assert.match(settlementTx, /^0x[0-9a-fA-F]{64}$/, "got a tx hash");

    assert.equal(await balanceOf(env.pub, COUNTERPARTY), SETTLE, "counterparty received 250,000 USDC");
    assert.equal(await balanceOf(env.pub, TREASURY), SEED - SETTLE, "treasury debited 250,000 USDC");
  });

  test("profile: gas used is sane (Gas Profiler breaks it down in the dashboard)", async () => {
    assert.ok(settlementTx, "settlement tx ran first");
    const receipt = await env.admin.send("eth_getTransactionReceipt", [settlementTx]);
    const gasUsed = BigInt(receipt.gasUsed);
    console.log(`  settlement gasUsed = ${gasUsed}  (per-call breakdown on the dashboard Gas Profiler)`);
    assert.ok(gasUsed > 20_000n && gasUsed < 120_000n, "ERC-20 transfer gas in the expected band");
  });

  test("cheat code: evm_snapshot / evm_revert resets state between cases", async () => {
    // Snapshot the current state, make a change, then roll it back — how a suite
    // isolates test cases on a shared Environment without re-provisioning.
    const before = await balanceOf(env.pub, TREASURY);
    const snapshotId: string = await env.admin.send("evm_snapshot", []);
    assert.match(snapshotId, /^0x[0-9a-fA-F]+$/, "evm_snapshot returns a snapshot id");

    const probe = parseUnits("50000", 6);
    const data = erc20.encodeFunctionData("transfer", [COUNTERPARTY, probe]);
    await env.admin.send("eth_sendTransaction", [{ from: TREASURY, to: USDC, data }]);
    assert.equal(await balanceOf(env.pub, TREASURY), before - probe, "treasury debited inside the snapshot");

    const reverted: boolean = await env.admin.send("evm_revert", [snapshotId]);
    assert.equal(reverted, true, "evm_revert succeeded");
    assert.equal(await balanceOf(env.pub, TREASURY), before, "state rolled back to the snapshot");
  });

  test("cheat code: evm_increaseTime advances the chain clock", async () => {
    // Treasury logic is often time-dependent (settlement windows, accrual). Jump the
    // clock forward and confirm the next block's timestamp moved with it.
    const THIRTY_DAYS = 30 * 24 * 60 * 60;
    const t0 = (await env.pub.getBlock("latest"))!.timestamp;
    await env.admin.send("evm_increaseTime", ["0x" + BigInt(THIRTY_DAYS).toString(16)]);
    const t1 = (await env.pub.getBlock("latest"))!.timestamp;
    console.log(`  chain time advanced ${(t1 - t0) / 86_400} days (${t0} -> ${t1})`);
    assert.ok(t1 - t0 >= THIRTY_DAYS - 60, "block timestamp jumped ~30 days forward");
  });
});
