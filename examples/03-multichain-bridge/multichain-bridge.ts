#!/usr/bin/env tsx
/**
 * Multichain Virtual Environment + a real cross-chain settlement, relayed by Tenderly.
 *
 *   npm run bridge
 *
 * Stands up ONE Virtual Environment that spans two real chains, Ethereum mainnet and
 * Base, with the Tenderly bridge module enabled. Then it sends a real cross-chain
 * USDC transfer over Circle's CCTP V2 from Ethereum to Base and waits for Tenderly's
 * auto-relay to mint the USDC on the destination fork.
 *
 * What this proves, concretely and verifiably:
 *   1. one Environment, two forked chains (real USDC + real CCTP contracts on both)
 *   2. seeding + initiating the cross-chain transfer with cheat codes (no keys)
 *   3. the source emits the bridge events the relay listens for
 *      (CCTP V2 DepositForBurn + MessageTransmitterV2 MessageSent), decoded below
 *   4. the bridge module relays the message and the USDC is minted on Base
 *
 * The bridge module relays CCTP V2. It doesn't relay the older CCTP V1 contracts,
 * so this script burns through TokenMessengerV2. It exits 1 if the mint doesn't
 * land on Base in time.
 */
import { JsonRpcProvider, Interface, ZeroHash, parseUnits, getAddress } from "ethers";
import { provisionTestNet, fundNative, setErc20Balance, type RpcEndpoints } from "./lib/testnet.js";

// USDC per chain, and the CCTP V2 TokenMessenger (same address on Ethereum and Base).
const TOKEN_MESSENGER_V2 = getAddress("0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d");
const ETH = {
  networkId: 1,
  usdc: getAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"),
};
const BASE = {
  networkId: 8453,
  usdc: getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
  domain: 6, // CCTP domain id for Base
};
const TREASURY = getAddress("0x3333333333333333333333333333333333333333");
const AMOUNT = parseUnits("100000", 6); // 100,000 USDC to move cross-chain (one message carries up to 10M)
const MAX_FEE = 0n; // no relayer fee with standard finality
const STANDARD_FINALITY = 2000; // 1000 is the fast transfer, which needs a fee
const RELAY_TIMEOUT_MS = 90_000;

const erc20 = new Interface([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);
const cctp = new Interface([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
  "event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)",
  "event MessageSent(bytes message)",
]);

const toHex = (v: bigint): string => "0x" + v.toString(16);
const toBytes32 = (addr: string): string => "0x" + addr.slice(2).toLowerCase().padStart(64, "0");
const usd = (v: bigint): string => (v / 1_000_000n).toLocaleString("en-US") + " USDC";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function balanceOf(provider: JsonRpcProvider, token: string, owner: string): Promise<bigint> {
  return BigInt(await provider.call({ to: token, data: erc20.encodeFunctionData("balanceOf", [owner]) }));
}

function pick(networks: RpcEndpoints[], networkId: number): RpcEndpoints {
  const n = networks.find((x) => x.networkId === networkId);
  if (!n) throw new Error(`network ${networkId} not present in the multichain Environment`);
  return n;
}

/** Decode and print the CCTP cross-chain message the relay listens for. */
function reportBridgeEvent(logs: Array<{ address: string; topics: string[]; data: string }>): boolean {
  let found = false;
  for (const log of logs) {
    let parsed;
    try {
      parsed = cctp.parseLog(log);
    } catch {
      continue;
    }
    if (parsed?.name === "DepositForBurn") {
      found = true;
      console.log("  bridge event: CCTP V2 DepositForBurn");
      console.log(`    amount             : ${usd(parsed.args.amount)}`);
      console.log(`    destinationDomain  : ${parsed.args.destinationDomain} (Base)`);
      console.log(`    mintRecipient      : ${parsed.args.mintRecipient}`);
      console.log(`    finality threshold : ${parsed.args.minFinalityThreshold} (standard)`);
    } else if (parsed?.name === "MessageSent") {
      console.log("  bridge event: MessageTransmitterV2 MessageSent (the message Tenderly relays)");
    }
  }
  return found;
}

async function main(): Promise<void> {
  console.log("Provisioning a multichain Virtual Environment (Ethereum + Base) with the bridge module on ...");
  const tn = await provisionTestNet({
    env: "bridge",
    networks: [{ networkId: ETH.networkId }, { networkId: BASE.networkId }],
    bridge: true,
    explorer: true,
  });
  const eth = pick(tn.networks, ETH.networkId);
  const base = pick(tn.networks, BASE.networkId);
  console.log(`  ${tn.reused ? "reused" : "created"}: ${tn.displayName}`);
  console.log(`  dashboard : ${tn.dashboardUrl}  (Bridge view shows relayed deliveries)`);
  console.log(`  Ethereum  : chain ${eth.chainId}`);
  console.log(`  Base      : chain ${base.chainId}\n`);

  const ethAdmin = new JsonRpcProvider(eth.adminRpc);
  const baseProvider = new JsonRpcProvider(base.publicRpc);

  // 1. Seed the treasury wallet on Ethereum with USDC + gas (cheat codes, no keys).
  await fundNative(eth.adminRpc, [TREASURY]);
  await setErc20Balance(eth.adminRpc, ETH.usdc, TREASURY, toHex(AMOUNT));
  const baseBefore = await balanceOf(baseProvider, BASE.usdc, TREASURY);
  console.log(`Seeded ${usd(AMOUNT)} on Ethereum. Destination (Base) balance before = ${usd(baseBefore)}.\n`);

  // 2. Initiate the cross-chain transfer: approve + CCTP V2 depositForBurn on Ethereum.
  await ethAdmin.send("eth_sendTransaction", [
    { from: TREASURY, to: ETH.usdc, data: erc20.encodeFunctionData("approve", [TOKEN_MESSENGER_V2, AMOUNT]) },
  ]);
  const burnTx: string = await ethAdmin.send("eth_sendTransaction", [
    {
      from: TREASURY,
      to: TOKEN_MESSENGER_V2,
      data: cctp.encodeFunctionData("depositForBurn", [
        AMOUNT, BASE.domain, toBytes32(TREASURY), ETH.usdc, ZeroHash, MAX_FEE, STANDARD_FINALITY,
      ]),
    },
  ]);
  const receipt = await ethAdmin.send("eth_getTransactionReceipt", [burnTx]);
  if (receipt?.status !== "0x1") throw new Error(`CCTP depositForBurn failed: ${burnTx}`);
  console.log(`Initiated cross-chain transfer on Ethereum: ${burnTx}`);
  if (!reportBridgeEvent(receipt.logs ?? [])) {
    throw new Error("no CCTP bridge event emitted, check the TokenMessenger address / route");
  }

  // 3. Wait for Tenderly's auto-relay to mint the USDC on Base.
  console.log("\nWaiting for Tenderly auto-relay to deliver on Base ...");
  const started = Date.now();
  let baseAfter = baseBefore;
  while (Date.now() - started < RELAY_TIMEOUT_MS) {
    await sleep(2_000);
    baseAfter = await balanceOf(baseProvider, BASE.usdc, TREASURY);
    if (baseAfter - baseBefore >= AMOUNT) break;
    process.stdout.write(".");
  }
  console.log("");

  const delivered = baseAfter - baseBefore;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (delivered < AMOUNT) {
    console.error(`✖ The relayed mint didn't land on Base within ${RELAY_TIMEOUT_MS / 1000} s.`);
    console.error(`  where: Base, treasury ${TREASURY}, received ${usd(delivered)} of ${usd(AMOUNT)}`);
    console.error("  why  : the burn on Ethereum went through, but the bridge module hasn't relayed the message.");
    console.error(`  Check the Bridge view: ${tn.dashboardUrl}`);
    process.exit(1);
  }
  console.log(`✔ Auto-relay delivered ${usd(delivered)} on Base in about ${seconds} s (balance now ${usd(baseAfter)}).`);
  console.log("  One Environment, two chains, real CCTP V2 contracts. The relay completed the destination mint.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
