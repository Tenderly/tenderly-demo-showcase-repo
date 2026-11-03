/**
 * The agent's rules and what they read: steakUSDC, Morpho Blue's WBTC/USDC market, its oracle and two Chainlink feeds.
 * Every read goes to the environment, so the rules see its state, including what earlier intents changed.
 */
import { AbiCoder, Interface, getAddress, keccak256, toBeHex, type JsonRpcProvider } from "ethers";

export const USDC = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
export const WBTC = getAddress("0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599");
/** Steakhouse USDC, a MetaMorpho vault. */
export const STEAKUSDC = getAddress("0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB");
export const MORPHO = getAddress("0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb");
/** Chainlink BTC/USD, the price the oracle rule compares against. */
export const BTC_USD = getAddress("0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c");
/** Chainlink WBTC/BTC. The market oracle multiplies it with BTC/USD (and divides by USDC/USD). */
export const WBTC_BTC = getAddress("0xfdFD9C85aD200c506Cf9e21F1FD8dd01932FBB23");
/** Tornado Cash router, the example entry on the screening list. */
export const TORNADO_ROUTER = getAddress("0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b");

/** Morpho Blue's WBTC/USDC market with an 86% liquidation LTV (Morpho's lltv). */
export const MARKET = {
  loanToken: USDC,
  collateralToken: WBTC,
  oracle: getAddress("0xDddd770BADd886dF3864029e4B377B5F6a2B6b83"),
  irm: getAddress("0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC"),
  lltv: 860_000_000_000_000_000n,
};
const params = [MARKET.loanToken, MARKET.collateralToken, MARKET.oracle, MARKET.irm, MARKET.lltv];
const abi = AbiCoder.defaultAbiCoder();
export const MARKET_ID = keccak256(abi.encode(["address", "address", "address", "address", "uint256"], params));

const erc20I = new Interface([
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const vaultI = new Interface(["function deposit(uint256 assets, address receiver) returns (uint256)"]);
const morphoI = new Interface([
  "function supplyCollateral((address,address,address,address,uint256),uint256,address,bytes)",
  "function borrow((address,address,address,address,uint256),uint256,uint256,address,address) returns (uint256,uint256)",
  "function market(bytes32) view returns (uint128,uint128,uint128,uint128,uint128,uint128)",
  "function position(bytes32,address) view returns (uint256,uint128,uint128)",
]);
const oracleI = new Interface(["function price() view returns (uint256)"]);
const feedI = new Interface([
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function aggregator() view returns (address)",
]);

async function read(p: JsonRpcProvider, to: string, iface: Interface, fn: string, args: unknown[] = []) {
  return iface.decodeFunctionResult(fn, await p.call({ to, data: iface.encodeFunctionData(fn, args) }));
}

// ---- units and formatting -----------------------------------------------------------------------

export const usdc = (n: number): bigint => BigInt(n) * 1_000_000n;
export const wbtc = (n: number): bigint => BigInt(n) * 100_000_000n;

/** Whole units with thousands separators, rounded half up: 1,500,000. */
function whole(v: bigint, decimals: number): string {
  const one = 10n ** BigInt(decimals);
  return ((v + one / 2n) / one).toLocaleString("en-US");
}
export const fmtUsdc = (v: bigint): string => whole(v, 6);
export const fmtWbtc = (v: bigint): string => whole(v, 8);

/** An exact fraction. The rules compare these, so only the printed percentage is rounded. */
export interface Ratio {
  num: bigint;
  den: bigint;
}
/** Above a limit given in parts per million, compared exactly. */
export const above = (r: Ratio, ppm: bigint): boolean => r.num * 1_000_000n > ppm * r.den;
/** A fraction as a percentage, whole when it is exactly whole, else rounded half up to 0.1%: 2%, 77.4%. */
export function fmtPct({ num, den }: Ratio): string {
  if ((num * 100n) % den === 0n) return `${((num * 100n) / den).toLocaleString("en-US")}%`;
  const tenths = (num * 2_000n + den) / (2n * den);
  return `${(tenths / 10n).toLocaleString("en-US")}.${tenths % 10n}%`;
}
/** Parts per million as a percentage: 774,000 → 77.4%, 20,000 → 2%. */
export const fmtPpm = (ppm: bigint): string => fmtPct({ num: ppm, den: 1_000_000n });
/** 0x334F…2A7b */
export const shortAddr = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

// ---- transactions -------------------------------------------------------------------------------

export interface Call {
  to: string;
  data: string;
}

export const calls = {
  approve: (token: string, spender: string, amount: bigint): Call => ({
    to: token,
    data: erc20I.encodeFunctionData("approve", [spender, amount]),
  }),
  deposit: (assets: bigint, receiver: string): Call => ({
    to: STEAKUSDC,
    data: vaultI.encodeFunctionData("deposit", [assets, receiver]),
  }),
  supplyCollateral: (assets: bigint, onBehalf: string): Call => ({
    to: MORPHO,
    data: morphoI.encodeFunctionData("supplyCollateral", [params, assets, onBehalf, "0x"]),
  }),
  borrow: (assets: bigint, onBehalf: string, receiver: string): Call => ({
    to: MORPHO,
    data: morphoI.encodeFunctionData("borrow", [params, assets, 0n, onBehalf, receiver]),
  }),
};

/** The reason string of a revert (Error(string)), or the raw selector when it is a custom error. */
export function revertReason(output: string): string {
  if (output.startsWith("0x08c379a0")) return abi.decode(["string"], `0x${output.slice(10)}`)[0] as string;
  return output.length >= 10 ? `error ${output.slice(0, 10)}` : "reverted";
}

// ---- reads --------------------------------------------------------------------------------------

export const balanceOf = async (p: JsonRpcProvider, token: string, holder: string): Promise<bigint> =>
  BigInt((await read(p, token, erc20I, "balanceOf", [holder]))[0]);

/** The market's totals, as stored (interest accrues on the next borrow, supply, withdraw or repay). */
export async function marketState(p: JsonRpcProvider): Promise<{ supply: bigint; borrow: bigint; borrowShares: bigint }> {
  const m = await read(p, MORPHO, morphoI, "market", [MARKET_ID]);
  return { supply: BigInt(m[0]), borrow: BigInt(m[2]), borrowShares: BigInt(m[3]) };
}

/** A position's collateral (WBTC) and debt (USDC). Debt rounds up from shares, as Morpho does (1e6 virtual shares). */
export async function position(p: JsonRpcProvider, user: string): Promise<{ collateral: bigint; debt: bigint }> {
  const [pos, m] = await Promise.all([read(p, MORPHO, morphoI, "position", [MARKET_ID, user]), marketState(p)]);
  const shares = BigInt(pos[1]);
  const denom = m.borrowShares + 1_000_000n;
  return { collateral: BigInt(pos[2]), debt: (shares * (m.borrow + 1n) + denom - 1n) / denom };
}

/** The market oracle's price: USDC units per WBTC unit, scaled by 1e36. */
export const oraclePrice = async (p: JsonRpcProvider): Promise<bigint> => BigInt((await read(p, MARKET.oracle, oracleI, "price"))[0]);
/** USDC (6 decimals) per 1 WBTC. */
export const usdcPerWbtc = (price: bigint): bigint => (price * 100_000_000n) / 10n ** 36n;
/** A Chainlink feed's latest answer (8 decimals for both feeds used here). */
export const feedAnswer = async (p: JsonRpcProvider, feed: string): Promise<bigint> =>
  BigInt((await read(p, feed, feedI, "latestRoundData"))[1]);

/**
 * How far the market oracle is from Chainlink BTC/USD, as a fraction of BTC/USD (USDC taken at 1 USD). The oracle's
 * price is USDC units per WBTC unit times 1e36, so price / 1e26 is USD per BTC with the feed's 8 decimals.
 */
export function oracleGap(price: bigint, btcUsd: bigint): Ratio {
  const feed = btcUsd * 10n ** 26n;
  return { num: price > feed ? price - feed : feed - price, den: feed };
}

/** A position's LTV: debt (USDC units) over collateral (WBTC units) at the oracle's price. */
export const ltvOf = (collateral: bigint, debt: bigint, price: bigint): Ratio => ({
  num: debt * 10n ** 36n,
  den: collateral * price,
});

// ---- the WBTC/BTC feed's latest answer, in storage ---------------------------------------------------

const ANSWER_MASK = (1n << 192n) - 1n;

export interface FeedSlot {
  aggregator: string;
  slot: string;
  /** The slot's value before any change: the answer in the low 192 bits, two timestamps above it. */
  value: string;
}

/**
 * Where the WBTC/BTC feed keeps its latest answer: s_transmissions[latest round] in Chainlink's OCR2 aggregator, a
 * mapping at storage slot 12. Throws when the slot doesn't hold the answer the feed returns.
 */
export async function wbtcBtcSlot(p: JsonRpcProvider): Promise<FeedSlot> {
  const [agg, round] = await Promise.all([read(p, WBTC_BTC, feedI, "aggregator"), read(p, WBTC_BTC, feedI, "latestRoundData")]);
  const aggregator = getAddress(agg[0] as string);
  const roundId = BigInt(round[0]) & ((1n << 64n) - 1n); // the proxy puts the phase id in the upper bits
  const slot = keccak256(abi.encode(["uint256", "uint256"], [roundId, 12n]));
  const value = await p.getStorage(aggregator, slot);
  if ((BigInt(value) & ANSWER_MASK) !== BigInt(round[1])) {
    throw new Error(`WBTC/BTC answer not in the OCR2 slot of ${shortAddr(aggregator)}`);
  }
  return { aggregator, slot, value };
}

/** tenderly_setStorageAt: replace the feed's latest answer, keep its timestamps. */
export async function setFeedAnswer(p: JsonRpcProvider, f: FeedSlot, answer: bigint): Promise<void> {
  const value = (BigInt(f.value) & ~ANSWER_MASK) | (answer & ANSWER_MASK);
  await p.send("tenderly_setStorageAt", [f.aggregator, f.slot, toBeHex(value, 32)]);
}

/** tenderly_setStorageAt: put the slot back as it was. */
export async function restoreFeed(p: JsonRpcProvider, f: FeedSlot): Promise<void> {
  await p.send("tenderly_setStorageAt", [f.aggregator, f.slot, f.value]);
}

// ---- rules ----------------------------------------------------------------------------------------

export type RuleName = "screening" | "supply cap" | "LTV buffer" | "oracle";

export interface Rules {
  /** No intent may come from or go to these addresses. */
  screened: string[];
  /** Deposits into steakUSDC, in total (USDC, 6 decimals). */
  supplyCap: bigint;
  /** Position LTV after a borrow, in parts per million. */
  maxLtv: bigint;
  /** Market oracle against Chainlink BTC/USD, in parts per million. */
  maxOracleGap: bigint;
}

export type Intent =
  | { kind: "deposit"; amount: bigint; receiver: string }
  | { kind: "borrow"; collateral: bigint; amount: bigint };

/** The first rule an intent breaks (null when it breaks none), and the number that decided it. */
export interface Decision {
  rule: RuleName | null;
  detail: string;
}

/**
 * Check an intent against the rules, in order: screening, then supply cap for deposits, or oracle then LTV buffer for
 * borrows (the LTV uses the oracle's price, so the oracle comes first). `deposited` is what the agent has sent so far.
 */
export async function checkRules(
  p: JsonRpcProvider,
  rules: Rules,
  agent: string,
  intent: Intent,
  deposited: bigint,
): Promise<Decision> {
  const listed = new Set(rules.screened.map((a) => a.toLowerCase()));
  if (listed.has(agent.toLowerCase())) return { rule: "screening", detail: "sender on the list" };
  if (intent.kind === "deposit") {
    if (listed.has(intent.receiver.toLowerCase())) return { rule: "screening", detail: "receiver on the list" };
    const total = deposited + intent.amount;
    return { rule: total > rules.supplyCap ? "supply cap" : null, detail: `total ${fmtUsdc(total)} USDC` };
  }
  const [price, btcUsd, pos] = await Promise.all([oraclePrice(p), feedAnswer(p, BTC_USD), position(p, agent)]);
  const gap = oracleGap(price, btcUsd);
  if (above(gap, rules.maxOracleGap)) return { rule: "oracle", detail: `${fmtPct(gap)} off BTC/USD` };
  const collateral = pos.collateral + intent.collateral;
  if (collateral === 0n) return { rule: "LTV buffer", detail: "no collateral" };
  const ltv = ltvOf(collateral, pos.debt + intent.amount, price);
  return { rule: above(ltv, rules.maxLtv) ? "LTV buffer" : null, detail: `LTV ${fmtPct(ltv)}` };
}
