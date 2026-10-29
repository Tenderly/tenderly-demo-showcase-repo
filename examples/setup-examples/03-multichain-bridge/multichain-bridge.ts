// One environment forks Ethereum and Base with the bridge module on. A 100,000 USDC CCTP V2 burn on Ethereum is
// relayed and minted on Base, and the run fails if the mint doesn't land within 90 s.
import {
  Interface, ZeroAddress, ZeroHash, dataSlice, formatUnits, getAddress, parseUnits, zeroPadValue,
  type JsonRpcProvider, type Log,
} from "ethers";
import * as log from "./lib/log.js";
import {
  bridgesUrl, createEnvironment, credentials, environmentUrl, providerFor, runSlug, sendAs, setErc20Balance,
  transactionsUrl, txUrl, type Environment, type Network,
} from "./lib/tenderly.js";

const ETHEREUM = { networkId: 1, chainId: 73571, usdc: getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48") };
const BASE = { networkId: 8453, chainId: 73578453, usdc: getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") };
const TOKEN_MESSENGER_V2 = getAddress("0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d"); // same address on both chains
const DOMAIN = { Ethereum: 0, Base: 6 }; // CCTP domain ids; the log names the burn's destination from this table
const STANDARD = 2000; // minFinalityThreshold of a standard transfer (a fast one is 1000)

const TREASURY = getAddress("0x3333333333333333333333333333333333333333");
const AMOUNT = parseUnits("100000", 6);
const MAX_FEE = 0n; // no fee can be taken, so Base mints the full amount
const POLL_MS = 250;
const TIMEOUT_MS = 90_000;
const WIDTH = 90; // the longest output line, [link] lines aside

const erc20 = new Interface([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const cctp = new Interface([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
  "event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)",
  "event MessageSent(bytes message)",
]);

const num = (v: number | bigint): string => v.toLocaleString("en-US");
const amount = (v: bigint): string => Number(formatUnits(v, 6)).toLocaleString("en-US", { maximumFractionDigits: 6 });
const usdc = (v: bigint): string => `${amount(v)} USDC`;
const addr = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
const label = (table: Record<string, number>, value: bigint): string =>
  Object.keys(table).find((k) => BigInt(table[k]) === value) ?? "unknown";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** An error in one short line: the JSON-RPC method and the node's message when there is one, else ethers' summary. */
const reason = (err: unknown): string => {
  const e = (err ?? {}) as {
    error?: { message?: string }; payload?: { method?: string }; shortMessage?: string; message?: string;
  };
  if (e.error?.message) return `${e.payload?.method ?? "JSON-RPC"} failed: ${e.error.message}`;
  return (e.shortMessage ?? e.message ?? String(err)).split("\n")[0];
};

/** A check that failed: where and why go on the [FAIL] line, the summary on the RESULT line. */
class Failed extends Error {
  constructor(where: string, why: string, readonly summary: string) {
    super(`${where}: ${why}`);
  }
}

/** The [FAIL] line, wrapped at spaces onto lines under its message, so a long node error stays within WIDTH. */
function printFail(msg: string): void {
  const room = WIDTH - 9; // "  [FAIL] " and the continuation indent are 9 characters
  const lines = [""];
  for (const word of msg.split(" ")) {
    const last = lines[lines.length - 1];
    if (last && last.length + 1 + word.length > room) lines.push(word);
    else lines[lines.length - 1] = last ? `${last} ${word}` : word;
  }
  log.fail(lines[0]);
  for (const rest of lines.slice(1)) log.sub(rest);
}

function network(e: Environment, networkId: number): Network {
  const n = e.networks.find((x) => x.networkId === networkId);
  if (!n) throw new Error(`the environment has no network ${networkId}`);
  return n;
}

async function balanceOf(p: JsonRpcProvider, token: string, owner: string): Promise<bigint> {
  return BigInt(await p.call({ to: token, data: erc20.encodeFunctionData("balanceOf", [owner]) }));
}

/** USDC mints to the treasury on Base from a block on: Transfer logs from the zero address (eth_getLogs). */
async function findMints(p: JsonRpcProvider, fromBlock: number, deadline: number): Promise<Log[]> {
  const topics = [erc20.getEvent("Transfer")!.topicHash, zeroPadValue(ZeroAddress, 32), zeroPadValue(TREASURY, 32)];
  for (;;) {
    const logs = await p.getLogs({ address: BASE.usdc, topics, fromBlock });
    if (logs.length > 0 || Date.now() >= deadline) return logs;
    await sleep(POLL_MS);
  }
}

async function main(): Promise<number> {
  const c = credentials();
  log.run("Multichain bridge", "100,000 USDC from Ethereum to Base over CCTP V2", 4);
  const links: Array<[string, string]> = [];
  let stage = "Tenderly API";
  let pass = false;
  let summary = "";
  try {
    log.step("Fork Ethereum and Base with the bridge module on");
    const env = await createEnvironment(c, {
      displayName: "Multichain bridge",
      slug: runSlug("multichain-bridge"),
      networks: [
        { networkId: ETHEREUM.networkId, chainId: ETHEREUM.chainId },
        { networkId: BASE.networkId, chainId: BASE.chainId },
      ],
      bridge: true,
    });
    links.push(
      ["environment", environmentUrl(c, env)],
      ["transactions", transactionsUrl(c, env)],
      ["bridges", bridgesUrl(c, env)],
    );
    const ethNet = network(env, ETHEREUM.networkId);
    const baseNet = network(env, BASE.networkId);
    const ethereum = providerFor(ethNet.adminRpc, ethNet.chainId);
    const baseAdmin = providerFor(baseNet.adminRpc, baseNet.chainId);
    // Base reads go through the Public RPC, as an app's do.
    const base = providerFor(baseNet.publicRpc, baseNet.chainId);
    log.ok(`environment ${env.slug}`);
    log.ok(`Ethereum block ${num(ethNet.forkBlock)}, chain id ${ethNet.chainId}`);
    log.ok(`Base block ${num(baseNet.forkBlock)}, chain id ${baseNet.chainId}`);

    log.step("Set USDC balances");
    stage = "cheat codes";
    await Promise.all([
      setErc20Balance(ethereum, ETHEREUM.usdc, TREASURY, AMOUNT),
      setErc20Balance(baseAdmin, BASE.usdc, TREASURY, 0n),
    ]);
    const [ethBefore, baseBefore, baseFrom] = await Promise.all([
      balanceOf(ethereum, ETHEREUM.usdc, TREASURY),
      balanceOf(base, BASE.usdc, TREASURY),
      base.getBlockNumber(),
    ]);
    if (ethBefore !== AMOUNT) {
      const why = `${addr(TREASURY)} holds ${usdc(ethBefore)} after the seed, not ${usdc(AMOUNT)}`;
      throw new Failed("Ethereum", why, "seed failed");
    }
    if (baseBefore !== 0n) {
      throw new Failed("Base", `${addr(TREASURY)} holds ${usdc(baseBefore)} after the reset, not 0`, "reset failed");
    }
    log.ok(`tenderly_setErc20Balance: ${addr(TREASURY)} holds ${usdc(ethBefore)} on Ethereum`);
    log.ok(`${addr(TREASURY)} holds ${usdc(baseBefore)} on Base`);

    log.step("Burn on Ethereum");
    stage = "Ethereum";
    const approve = await sendAs(ethereum, {
      from: TREASURY,
      to: ETHEREUM.usdc,
      data: erc20.encodeFunctionData("approve", [TOKEN_MESSENGER_V2, AMOUNT]),
    });
    if (approve.receipt.status !== 1) {
      throw new Failed("Ethereum", `approve reverted in block ${num(approve.receipt.blockNumber)}`, "approve reverted");
    }
    log.ok(`approve ${usdc(AMOUNT)} for TokenMessengerV2 ${addr(TOKEN_MESSENGER_V2)}`);
    const burn = await sendAs(ethereum, {
      from: TREASURY,
      to: TOKEN_MESSENGER_V2,
      data: cctp.encodeFunctionData("depositForBurn", [
        AMOUNT, DOMAIN.Base, zeroPadValue(TREASURY, 32), ETHEREUM.usdc, ZeroHash, MAX_FEE, STANDARD,
      ]),
    });
    links.push(["burn tx", txUrl(c, env, ethNet, burn.hash)]);
    const burnBlock = burn.receipt.blockNumber;
    if (burn.receipt.status !== 1) {
      throw new Failed("Ethereum", `depositForBurn reverted in block ${num(burnBlock)}`, "burn reverted");
    }
    const events = burn.receipt.logs.map((l) => {
      try {
        return cctp.parseLog(l);
      } catch {
        return null; // another contract's event
      }
    });
    const deposit = events.find(
      (e, i) => e?.name === "DepositForBurn" && burn.receipt.logs[i].address === TOKEN_MESSENGER_V2,
    );
    if (!deposit || !events.some((e) => e?.name === "MessageSent")) {
      const missing = deposit ? "MessageSent" : "DepositForBurn";
      throw new Failed("Ethereum", `the burn in block ${num(burnBlock)} emitted no ${missing}`, "no CCTP message");
    }
    const burned: bigint = deposit.args.amount;
    const recipient = getAddress(dataSlice(deposit.args.mintRecipient, 12));
    const ethAfter = await balanceOf(ethereum, ETHEREUM.usdc, TREASURY);
    if (burned !== AMOUNT || recipient !== TREASURY || ethAfter !== ethBefore - burned) {
      const why = `burned ${usdc(burned)} for ${addr(recipient)}, balance ${amount(ethBefore)} → ${usdc(ethAfter)}`;
      throw new Failed("Ethereum", why, "burn amounts don't add up");
    }
    const domain: bigint = deposit.args.destinationDomain;
    const to = `${addr(recipient)} on domain ${domain} (${label(DOMAIN, domain)})`;
    log.ok(`depositForBurn ${usdc(burned)} to ${to}, block ${num(burnBlock)}`);
    log.ok(`Ethereum balance ${amount(ethBefore)} → ${usdc(ethAfter)}`);

    log.step("Mint on Base");
    stage = "Base";
    log.wait(`up to ${TIMEOUT_MS / 1000} s for the bridge to relay the burn`);
    const deadline = Date.now() + TIMEOUT_MS;
    let baseAfter = await balanceOf(base, BASE.usdc, TREASURY);
    while (baseAfter === baseBefore && Date.now() < deadline) {
      await sleep(POLL_MS);
      baseAfter = await balanceOf(base, BASE.usdc, TREASURY);
    }
    if (baseAfter === baseBefore) {
      const head = await base.getBlockNumber(); // only the relay mines Base blocks after the reset
      const why = head === baseFrom ? "the bridge sent nothing to Base" : "what the bridge sent minted nothing";
      const where = `no USDC minted to ${addr(TREASURY)} in ${TIMEOUT_MS / 1000} s`;
      throw new Failed("Base", `${where}, ${why}`, `no mint on Base within ${TIMEOUT_MS / 1000} s`);
    }
    const mints = await findMints(base, baseFrom, deadline);
    if (mints.length !== 1) {
      const why = `${mints.length} USDC mints to ${addr(TREASURY)} since block ${num(baseFrom)}, expected 1`;
      throw new Failed("Base", why, `Base balance ${amount(baseBefore)} → ${usdc(baseAfter)}, mint not found`);
    }
    const mint = mints[0];
    const minted = BigInt(mint.data);
    links.push(["mint tx", txUrl(c, env, baseNet, mint.transactionHash)]);
    if (minted !== burned || baseAfter !== baseBefore + minted) {
      const balance = `${amount(baseBefore)} → ${usdc(baseAfter)}`;
      const why = `minted ${usdc(minted)} for a ${usdc(burned)} burn, balance ${balance}`;
      throw new Failed("Base", why, "mint amounts don't add up");
    }
    log.ok(`${usdc(minted)} minted to ${addr(TREASURY)} in Base block ${num(mint.blockNumber)}`);
    pass = true;
    summary = `Base balance ${amount(baseBefore)} → ${usdc(baseAfter)}`;
  } catch (err) {
    if (err instanceof Failed) {
      printFail(err.message);
      summary = err.summary;
    } else {
      printFail(`${stage}: ${reason(err)}`);
      summary = `${stage} error`;
    }
  }
  if (links.length > 0) {
    log.blank();
    for (const [name, url] of links) log.link(name, url);
  }
  return log.result(pass, summary);
}

main().then((code) => process.exit(code), (err) => process.exit(log.fatal(err)));
