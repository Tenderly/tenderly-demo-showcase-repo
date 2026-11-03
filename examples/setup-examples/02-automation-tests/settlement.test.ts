// node:test suite on an Ethereum fork: seed balances with cheat codes, settle 250,000 USDC, snapshot and revert, and
// move the clock 30 days. It creates an environment of its own, or uses TENDERLY_ADMIN_RPC_URL_1 (example 04, CI).
// npm test runs it with lib/reporter.ts, which replaces node:test's output and prints the RESULT line.
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import {
  Interface, formatEther, formatUnits, getAddress, parseEther, parseUnits, toQuantity, type JsonRpcProvider,
} from "ethers";
import * as log from "./lib/log.js";
import {
  createEnvironment, credentials, dashboardLinks, environmentUrl, increaseTime, providerFor, revert, runSlug, sendAs,
  setBalance, setErc20Balance, snapshot, transactionsUrl, txUrl, type Credentials,
} from "./lib/tenderly.js";

const USDC = getAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"); // 6 decimals
const TREASURY = getAddress("0x1111111111111111111111111111111111111111");
const COUNTERPARTY = getAddress("0x2222222222222222222222222222222222222222");
const SEED = parseUnits("1000000", 6);
const SETTLE = parseUnits("250000", 6);
const PROBE = parseUnits("50000", 6);
const SEED_ETH = parseEther("100"); // shows tenderly_setBalance; impersonated sends run at gas price 0
const DAYS = 30;

const erc20 = new Interface([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);
const num = (n: number): string => n.toLocaleString("en-US");
const usd = (v: bigint): string => `${Number(formatUnits(v, 6)).toLocaleString("en-US")} USDC`;
const eth = (v: bigint): string => `${Number(formatEther(v)).toLocaleString("en-US")} ETH`;
const addr = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
const date = (unix: number): string => new Date(unix * 1000).toISOString().slice(0, 10);

interface Links {
  environment: string;
  transactions: string;
  tx: (hash: string) => string;
}

interface Target {
  admin: JsonRpcProvider; // cheat codes and impersonated sends
  pub: JsonRpcProvider; // reads, as an app makes them
  links?: Links;
}

let settlementTx = "";

/** One line on why something failed: the JSON-RPC method and the node's message when there is one. */
function why(err: unknown): string {
  const e = err as {
    shortMessage?: string;
    message?: string;
    error?: { message?: string }; // the JSON-RPC error, when the node answered with one
    payload?: { method?: string };
  };
  if (e?.payload?.method && e.error?.message) return `${e.payload.method}: ${e.error.message}`;
  // node:assert adds the compared values on the lines after a custom message.
  return (e?.shortMessage ?? e?.message ?? String(err)).split("\n")[0];
}

function printLinks(links: Links | undefined): void {
  if (!links) {
    log.warn("no links: set TENDERLY_ENVIRONMENT_ID, TENDERLY_INSTANCE_ID, TENDERLY_VNET_ID_1");
    return;
  }
  log.link("environment", links.environment);
  log.link("transactions", links.transactions);
  if (settlementTx) log.link("settlement tx", links.tx(settlementTx));
}

/** Dashboard links for an environment created elsewhere, from the ids example 04 passes along. */
function linksFromIds(): Links | undefined {
  const { TENDERLY_ACCOUNT: account, TENDERLY_PROJECT: project } = process.env;
  const { TENDERLY_ENVIRONMENT_ID: id, TENDERLY_INSTANCE_ID: instanceId, TENDERLY_VNET_ID_1: vnetId } = process.env;
  if (!account || !project || !id || !instanceId || !vnetId) return undefined;
  const d = dashboardLinks(account, project, id, instanceId);
  return { environment: d.environment, transactions: d.transactions, tx: (hash) => d.tx(vnetId, hash) };
}

/** Step 1: the environment from TENDERLY_ADMIN_RPC_URL_1, or a new one. Undefined when the tests can't run. */
async function connect(): Promise<Target | undefined> {
  const { TENDERLY_ADMIN_RPC_URL_1: adminRpc, TENDERLY_PUBLIC_RPC_URL_1: publicRpc } = process.env;
  let plan: Credentials | { adminRpc: string; publicRpc: string };
  try {
    if (!adminRpc) plan = credentials();
    else if (publicRpc) plan = { adminRpc, publicRpc };
    else throw new Error("TENDERLY_ADMIN_RPC_URL_1 is set, so set TENDERLY_PUBLIC_RPC_URL_1 too");
  } catch (err) {
    process.exitCode = log.fatal(err);
    return undefined;
  }
  log.run("Settlement tests", `a ${usd(SETTLE)} treasury settlement, tested on an Ethereum fork`, 5);
  log.step("Environment");
  let links: Links | undefined; // known before the first RPC call, so a failure below still prints them
  let rpc = ""; // which RPC the reads go to, for the [FAIL] line
  try {
    let name: string;
    let chainId: number;
    let target: Target;
    if ("accessKey" in plan) {
      const e = await createEnvironment(plan, {
        displayName: "Acme Treasury tests",
        slug: runSlug("acme-treasury-tests"),
        networks: [{ networkId: 1, chainId: 73571 }],
      });
      const n = e.networks[0];
      links = {
        environment: environmentUrl(plan, e),
        transactions: transactionsUrl(plan, e),
        tx: (hash) => txUrl(plan, e, n, hash),
      };
      chainId = n.chainId;
      target = { admin: providerFor(n.adminRpc, chainId), pub: providerFor(n.publicRpc, chainId), links };
      name = e.slug;
      rpc = "Public RPC";
    } else {
      rpc = "TENDERLY_PUBLIC_RPC_URL_1";
      log.secret(plan.adminRpc, "<admin rpc>");
      log.secret(plan.publicRpc, "<public rpc>");
      links = linksFromIds();
      // providerFor() takes the chain id up front, so read it with a throwaway provider first.
      chainId = Number(await providerFor(plan.publicRpc, 1).send("eth_chainId", []));
      target = { admin: providerFor(plan.adminRpc, chainId), pub: providerFor(plan.publicRpc, chainId), links };
      name = "from TENDERLY_ADMIN_RPC_URL_1";
    }
    const block = Number(await target.pub.send("eth_blockNumber", []));
    log.ok(`environment ${name}, block ${num(block)}, chain id ${chainId}`);
    return target;
  } catch (err) {
    log.fail(rpc ? `${rpc}: ${why(err)}` : why(err));
    if (links) {
      log.blank();
      printLinks(links);
    }
    process.exitCode = log.result(false, "no tests ran");
    return undefined;
  }
}

/** One test is one step. A failing test prints [FAIL] with the reason here, in order, and node:test counts it. */
function check(title: string, fn: () => Promise<void>): void {
  test(title, async () => {
    log.step(title);
    try {
      await fn();
    } catch (err) {
      log.fail(why(err));
      throw err;
    }
  });
}

function suite(t: Target): void {
  // Reads go through send(): ethers answers a repeated provider.call() from a 250 ms cache, which can predate a send.
  const usdcOf = async (who: string): Promise<bigint> =>
    BigInt(await t.pub.send("eth_call", [{ to: USDC, data: erc20.encodeFunctionData("balanceOf", [who]) }, "latest"]));
  const ethOf = async (who: string): Promise<bigint> => BigInt(await t.pub.send("eth_getBalance", [who, "latest"]));
  const head = async (): Promise<{ number: number; timestamp: number }> => {
    const b = await t.pub.send("eth_getBlockByNumber", ["latest", false]);
    return { number: Number(b.number), timestamp: Number(b.timestamp) };
  };
  // The treasury sends without its key: an impersonated eth_sendTransaction on the Admin RPC.
  const pay = (amount: bigint) =>
    sendAs(t.admin, { from: TREASURY, to: USDC, data: erc20.encodeFunctionData("transfer", [COUNTERPARTY, amount]) });

  describe("treasury settlement", () => {
    check("Seed balances", async () => {
      await setErc20Balance(t.admin, USDC, TREASURY, SEED);
      await setErc20Balance(t.admin, USDC, COUNTERPARTY, 0n);
      const [treasury, counterparty] = [await usdcOf(TREASURY), await usdcOf(COUNTERPARTY)];
      assert.equal(treasury, SEED, `treasury has ${usd(treasury)}, expected ${usd(SEED)}`);
      assert.equal(counterparty, 0n, `counterparty has ${usd(counterparty)}, expected ${usd(0n)}`);
      log.ok(`tenderly_setErc20Balance: treasury ${addr(TREASURY)} holds ${usd(treasury)}`);
      log.ok(`counterparty ${addr(COUNTERPARTY)} holds ${usd(counterparty)}`);

      await setBalance(t.admin, [TREASURY, COUNTERPARTY], SEED_ETH);
      for (const [name, who] of [["treasury", TREASURY], ["counterparty", COUNTERPARTY]] as const) {
        const ether = await ethOf(who);
        assert.equal(ether, SEED_ETH, `${name} has ${eth(ether)}, expected ${eth(SEED_ETH)}`);
      }
      log.ok(`tenderly_setBalance: both hold ${eth(SEED_ETH)}`);
    });

    check(`Settle ${usd(SETTLE)}`, async () => {
      const { hash, receipt } = await pay(SETTLE);
      settlementTx = hash; // linked at the end, also when it reverted
      assert.equal(receipt.status, 1, `settlement ${log.short(hash)} reverted`);
      const gas = Number(receipt.gasUsed);
      assert.ok(gas > 20_000 && gas < 120_000, `gas used ${num(gas)}, expected 20,000 to 120,000 for a USDC transfer`);
      log.ok(`sent without the treasury's key, block ${num(receipt.blockNumber)}, gas used ${num(gas)}`);
      const [treasury, counterparty] = [await usdcOf(TREASURY), await usdcOf(COUNTERPARTY)];
      assert.equal(treasury, SEED - SETTLE, `treasury has ${usd(treasury)}, expected ${usd(SEED - SETTLE)}`);
      assert.equal(counterparty, SETTLE, `counterparty has ${usd(counterparty)}, expected ${usd(SETTLE)}`);
      log.ok(`treasury ${usd(treasury)}, counterparty ${usd(counterparty)}`);
    });

    check("Snapshot and revert", async () => {
      const before = await usdcOf(TREASURY);
      assert.equal(before, SEED - SETTLE, `treasury has ${usd(before)} before the probe, expected ${usd(SEED - SETTLE)}`);
      const start = await head();
      const id = await snapshot(t.admin);
      log.ok(`evm_snapshot: taken at block ${num(start.number)}`);
      const probe = await pay(PROBE);
      const during = await usdcOf(TREASURY);
      assert.equal(during, before - PROBE, `treasury has ${usd(during)} after the probe, expected ${usd(before - PROBE)}`);
      log.ok(`${usd(PROBE)} probe in block ${num(probe.receipt.blockNumber)}, treasury ${usd(during)}`);

      assert.equal(await revert(t.admin, id), true, "evm_revert returned false");
      const end = await head();
      const receipt = await t.pub.send("eth_getTransactionReceipt", [probe.hash]);
      const block = await t.pub.send("eth_getBlockByNumber", [toQuantity(probe.receipt.blockNumber), false]);
      const back = await usdcOf(TREASURY);
      assert.equal(end.number, start.number, `head is block ${num(end.number)} after evm_revert, expected ${num(start.number)}`);
      assert.equal(receipt, null, `probe ${log.short(probe.hash)} is still on chain after evm_revert`);
      assert.equal(block, null, `block ${num(probe.receipt.blockNumber)} is still on chain after evm_revert`);
      assert.equal(back, before, `treasury has ${usd(back)} after evm_revert, expected ${usd(before)}`);
      // The next block gets the probe block's number, so say that the probe's block is gone.
      log.ok(`evm_revert: back to block ${num(end.number)}, the probe and its block are gone`);
      log.ok(`treasury ${usd(back)} again`);
    });

    check(`Move the clock ${DAYS} days`, async () => {
      const from = await head();
      await increaseTime(t.admin, DAYS * 86_400);
      const to = await head();
      const seconds = to.timestamp - from.timestamp;
      assert.equal(to.number, from.number + 1, `evm_increaseTime mined ${to.number - from.number} blocks, expected 1`);
      // Block times carry the seconds that passed between the two blocks, so allow a minute.
      assert.ok(Math.abs(seconds - DAYS * 86_400) <= 60, `the clock moved ${num(seconds)} s, expected ${DAYS} days`);
      // Print dates, not minutes, because a minute can roll over in the seconds between the blocks, and a date
      // rarely does.
      const shown = (Date.parse(date(to.timestamp)) - Date.parse(date(from.timestamp))) / 86_400_000;
      assert.equal(shown, DAYS, `the dates ${date(from.timestamp)} and ${date(to.timestamp)} are ${shown} days apart`);
      const clock = `${date(from.timestamp)} → ${date(to.timestamp)} UTC`;
      log.ok(`evm_increaseTime: new block ${num(to.number)}, clock ${clock}`);
    });

    after(() => {
      log.blank();
      printLinks(t.links);
    });
  });
}

const target = await connect();
if (target) suite(target);
