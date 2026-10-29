/**
 * Morpho reads for the whale exit: a MetaMorpho (Morpho Vault V1) vault and the Morpho Blue markets in its withdraw
 * queue, what its depositors could withdraw right now, the markets' borrow rates, and every MetaMorpho vault of the
 * same asset, from the factories' logs.
 */
import { AbiCoder, Interface, ZeroAddress, getAddress, id as topicId, zeroPadValue, type JsonRpcProvider, type Log } from "ethers";
import { multicall, type ContractCall } from "./multicall.js";
import { getLogsChunked } from "./logs.js";

const MARKET_PARAMS = "(address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)";
const MARKET = "(uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)";

export const metaMorphoI = new Interface([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function maxRedeem(address owner) view returns (uint256)",
  "function maxWithdraw(address owner) view returns (uint256)",
  "function previewWithdraw(uint256 assets) view returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)",
  "function MORPHO() view returns (address)",
  "function withdrawQueueLength() view returns (uint256)",
  "function withdrawQueue(uint256) view returns (bytes32)",
  "event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
]);

export const morphoBlueI = new Interface([
  `function idToMarketParams(bytes32 id) view returns ${MARKET_PARAMS}`,
  `function market(bytes32 id) view returns ${MARKET}`,
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  `function accrueInterest(${MARKET_PARAMS} marketParams)`,
  "event Withdraw(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)",
]);

const irmI = new Interface([`function borrowRateView(${MARKET_PARAMS} marketParams, ${MARKET} market) view returns (uint256)`]);

// The errors a MetaMorpho withdrawal can revert with; Morpho Blue's own reverts are strings.
const errorsI = new Interface([
  "error NotEnoughLiquidity()",
  "error ERC4626ExceededMaxRedeem(address owner, uint256 shares, uint256 max)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error Error(string)",
]);

/** A revert in words: the error's name and arguments, or the raw data when it isn't one of the above. */
export function decodeRevert(data: string): string {
  try {
    const e = errorsI.parseError(data);
    if (e) return e.args.length ? `${e.name}(${e.args.map(String).join(", ")})` : e.name;
  } catch {
    // not one of ours
  }
  return data === "0x" ? "no revert data" : data.slice(0, 74);
}
const erc20I = new Interface(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);

export interface MarketParams {
  loanToken: string;
  collateralToken: string;
  oracle: string;
  irm: string;
  lltv: bigint;
}

export interface VaultMarket {
  id: string;
  params: MarketParams;
  /** "cbBTC/USDC 86%", or "USDC idle" for a market without collateral. */
  label: string;
}

export interface MarketState {
  /** The vault's supply in the market, in assets. */
  supply: bigint;
  /** The market's free liquidity: total supply minus total borrow. */
  liquidity: bigint;
  /** What the vault can take out of this market now: the smaller of the two. */
  withdrawable: bigint;
  totalSupply: bigint;
  totalBorrow: bigint;
}

export interface VaultState {
  totalAssets: bigint;
  markets: Record<string, MarketState>;
}

export interface Vault {
  address: string;
  morpho: string;
  name: string;
  symbol: string;
  asset: string;
  assetSymbol: string;
  assetDecimals: number;
  /** The withdraw queue, in order: where withdrawals take liquidity from. */
  markets: VaultMarket[];
  state: VaultState;
}

/** Read a MetaMorpho vault: its withdraw queue, the markets' params and labels, and its state. */
export async function readVault(p: JsonRpcProvider, vault: string): Promise<Vault> {
  const address = getAddress(vault);
  const mm = (fn: string, args: unknown[] = []): ContractCall => ({ target: address, iface: metaMorphoI, fn, args, allowFailure: true });
  const head = await multicall(p, ["MORPHO", "name", "symbol", "asset", "withdrawQueueLength"].map((fn) => mm(fn)));
  if (head.some((r) => !r)) throw new Error(`${address.slice(0, 6)}…${address.slice(-4)} isn't a Morpho Vault V1 (MetaMorpho)`);
  const [morpho, name, symbol, asset, wqLen] = head.map((r) => r![0]);
  const ids = (await multicall(p, Array.from({ length: Number(wqLen) }, (_, i) => mm("withdrawQueue", [i])))).map((r) => r![0] as string);
  const reads = await multicall(p, [
    ...ids.map((id): ContractCall => ({ target: morpho, iface: morphoBlueI, fn: "idToMarketParams", args: [id] })),
    { target: asset, iface: erc20I, fn: "symbol" },
    { target: asset, iface: erc20I, fn: "decimals" },
  ]);
  const params = ids.map((_, i): MarketParams => {
    const [loanToken, collateralToken, oracle, irm, lltv] = reads[i]!;
    return { loanToken: getAddress(loanToken), collateralToken: getAddress(collateralToken), oracle: getAddress(oracle), irm: getAddress(irm), lltv };
  });
  const assetSymbol = reads[ids.length]![0] as string;
  const assetDecimals = Number(reads[ids.length + 1]![0]);
  const collaterals = [...new Set(params.map((mp) => mp.collateralToken).filter((c) => c !== ZeroAddress))];
  const symbols = await multicall(p, collaterals.map((c): ContractCall => ({ target: c, iface: erc20I, fn: "symbol", allowFailure: true })));
  const symbolOf = new Map(collaterals.map((c, i) => [c, (symbols[i]?.[0] as string | undefined) ?? `${c.slice(0, 8)}…`]));
  const labels = params.map((mp) => (mp.collateralToken === ZeroAddress
    ? `${assetSymbol} idle`
    : `${symbolOf.get(mp.collateralToken)}/${assetSymbol} ${Number(mp.lltv) / 1e16}%`));
  // Two markets with the same collateral and LLTV (different oracles) get the id's start appended.
  const markets = ids.map((id, i): VaultMarket => ({
    id, params: params[i], label: labels.filter((l) => l === labels[i]).length > 1 ? `${labels[i]} ${id.slice(0, 6)}` : labels[i],
  }));
  const v = { address, morpho: getAddress(morpho), markets };
  return { ...v, name, symbol, asset: getAddress(asset), assetSymbol, assetDecimals, state: await readState(p, v) };
}

/**
 * The vault's state now. Interest is accrued on every market first (Morpho.accrueInterest is permissionless), so supply
 * and liquidity include what is owed up to this block.
 */
export async function readState(p: JsonRpcProvider, v: Pick<Vault, "address" | "morpho" | "markets">): Promise<VaultState> {
  const morpho = (fn: string, args: unknown[]): ContractCall => ({ target: v.morpho, iface: morphoBlueI, fn, args });
  const values = await multicall(p, [
    ...v.markets.map((m) => morpho("accrueInterest", [m.params])),
    { target: v.address, iface: metaMorphoI, fn: "totalAssets" },
    ...v.markets.flatMap((m) => [morpho("market", [m.id]), morpho("position", [m.id, v.address])]),
  ]);
  const k = v.markets.length;
  const state: VaultState = { totalAssets: values[k]![0] as bigint, markets: {} };
  v.markets.forEach((m, j) => {
    const [totalSupply, totalSupplyShares, totalBorrow] = values[k + 1 + 2 * j]! as unknown as bigint[];
    const supplyShares = values[k + 2 + 2 * j]![0] as bigint;
    // Morpho's SharesMathLib.toAssetsDown, with its virtual shares (1e6) and virtual assets (1).
    const supply = (supplyShares * (totalSupply + 1n)) / (totalSupplyShares + 1_000_000n);
    const liquidity = totalSupply - totalBorrow;
    state.markets[m.id] = { supply, liquidity, withdrawable: supply < liquidity ? supply : liquidity, totalSupply, totalBorrow };
  });
  return state;
}

/** What the vault's depositors could withdraw right now: every market's withdrawable amount, summed. */
export const exitCapacity = (s: VaultState): bigint => Object.values(s.markets).reduce((sum, m) => sum + m.withdrawable, 0n);

/**
 * Each market's borrow APR now (1e18 is 100%): the interest rate model's per-second rate times a year's seconds. A
 * market without a model (idle) pays nothing.
 */
export async function borrowAprs(p: JsonRpcProvider, morpho: string, markets: VaultMarket[]): Promise<Map<string, bigint>> {
  const priced = markets.filter((m) => m.params.irm !== ZeroAddress);
  const totals = await multicall(p, priced.map((m): ContractCall => ({ target: morpho, iface: morphoBlueI, fn: "market", args: [m.id] })));
  const rates = await multicall(p, priced.map((m, i): ContractCall => ({ target: m.params.irm, iface: irmI, fn: "borrowRateView", args: [m.params, [...totals[i]!]], allowFailure: true })));
  return new Map(markets.map((m) => {
    const i = priced.indexOf(m);
    const perSecond = i < 0 || !rates[i] ? 0n : (rates[i]![0] as bigint);
    return [m.id, perSecond * 31_536_000n];
  }));
}

/** The assets a vault took out of each market, from Morpho Blue's Withdraw events with the vault as onBehalf. */
export function pulledPerMarket(logs: ReadonlyArray<Pick<Log, "address" | "topics" | "data">>, morpho: string, vault: string): Map<string, bigint> {
  const event = morphoBlueI.getEvent("Withdraw")!;
  const pulled = new Map<string, bigint>();
  for (const l of logs) {
    if (getAddress(l.address) !== morpho || l.topics[0] !== event.topicHash) continue;
    const d = morphoBlueI.decodeEventLog(event, l.data, l.topics);
    if (getAddress(d.onBehalf) !== vault) continue;
    pulled.set(d.id, (pulled.get(d.id) ?? 0n) + (d.assets as bigint));
  }
  return pulled;
}

/** The MetaMorpho factories (v1.0, v1.1) on Ethereum. */
export const METAMORPHO_FACTORIES = ["0xA9c3D3a366466Fa809d1Ae982Fb2c46E5fC41101", "0x1897A8997241C1cD4bD0698647e4EB7213535c24"];
const CREATE_METAMORPHO = topicId("CreateMetaMorpho(address,address,address,uint256,address,string,string,bytes32)");

/** The block a vault was created in, from its factory's CreateMetaMorpho log; 0 if no factory has it. */
export async function vaultCreationBlock(p: JsonRpcProvider, vault: string, toBlock: number): Promise<number> {
  const found = await Promise.all(METAMORPHO_FACTORIES.map((f) =>
    getLogsChunked(p, { address: f, topics: [CREATE_METAMORPHO, zeroPadValue(getAddress(vault), 32)] }, 0, toBlock)));
  return found.flat()[0]?.blockNumber ?? 0;
}

/** Every MetaMorpho vault created for `asset`, from the factories' CreateMetaMorpho logs. */
export async function vaultsForAsset(p: JsonRpcProvider, asset: string, toBlock: number): Promise<string[]> {
  const found = await Promise.all(METAMORPHO_FACTORIES.map((f) =>
    getLogsChunked(p, { address: f, topics: [CREATE_METAMORPHO, null, null, zeroPadValue(getAddress(asset), 32)] }, 0, toBlock)));
  return [...new Set(found.flat().map((l) => getAddress(AbiCoder.defaultAbiCoder().decode(["address"], l.topics[1])[0] as string)))];
}

/**
 * Which of `vaults` supply at least `minSupply` (in assets, summed over the markets in `ids`), from one batch of
 * Morpho position reads. A vault with less there can't lose more than that when those markets are drained.
 */
export async function suppliersAmong(p: JsonRpcProvider, morpho: string, vaults: string[], ids: string[], minSupply: bigint): Promise<string[]> {
  const totals = await multicall(p, ids.map((id): ContractCall => ({ target: morpho, iface: morphoBlueI, fn: "market", args: [id] })));
  const pairs = vaults.flatMap((v) => ids.map((id, k) => ({ v, k })));
  const positions = await multicall(p, pairs.map(({ v, k }): ContractCall => ({ target: morpho, iface: morphoBlueI, fn: "position", args: [ids[k], v] })));
  const supply = new Map<string, bigint>();
  pairs.forEach(({ v, k }, i) => {
    const [totalSupply, totalSupplyShares] = totals[k]! as unknown as bigint[];
    const shares = (positions[i]?.[0] as bigint | undefined) ?? 0n;
    supply.set(v, (supply.get(v) ?? 0n) + (shares * (totalSupply + 1n)) / (totalSupplyShares + 1_000_000n));
  });
  return vaults.filter((v) => (supply.get(v) ?? 0n) >= minSupply);
}
