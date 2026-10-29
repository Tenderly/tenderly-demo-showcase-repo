/**
 * Aave V3 on Ethereum: borrowers from the Pool's Borrow logs, health factors through Multicall3, a mock WETH price
 * feed put in place with cheat codes, and the events of a liquidation.
 */
import {
  Contract, Interface, dataSlice, getAddress, solidityPackedKeccak256, toBeHex, toQuantity, zeroPadValue,
  type JsonRpcProvider, type Log,
} from "ethers";
import { multicall } from "./multicall.js";

const ADDRESSES_PROVIDER = getAddress("0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e");
export const POOL = getAddress("0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2");
export const WETH = getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");

/** Where the mock feed goes. Its code returns storage slot 0 for any call, so latestAnswer() is the price in slot 0. */
export const MOCK_FEED = getAddress("0x000000000000000000000000000000000000feed");
const MOCK_CODE = "0x5f5460005260206000f3"; // PUSH0 SLOAD PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN

export const pool = new Interface([
  "event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)",
  "event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)",
  "event DeficitCreated(address indexed user, address indexed debtAsset, uint256 amountCreated)",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function getUserConfiguration(address user) view returns (uint256)",
  "function getUserEMode(address user) view returns (uint256)",
  "function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
  "function getReserveAddressById(uint16 id) view returns (address)",
  "function getEModeCategoryCollateralBitmap(uint8 id) view returns (uint128)",
  "function getEModeCategoryCollateralConfig(uint8 id) view returns ((uint16 ltv, uint16 liquidationThreshold, uint16 liquidationBonus))",
  "function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken)",
  // Revert reasons a liquidation can hit, for a readable failure line.
  "error HealthFactorNotBelowThreshold()",
  "error CollateralCannotBeLiquidated()",
  "error SpecifiedCurrencyNotBorrowedByUser()",
  "error MustNotLeaveDust()",
  "error ReserveInactive()",
  "error ReservePaused()",
  "error PriceOracleSentinelCheckFailed()",
]);

const addressesProvider = new Interface([
  "function getPool() view returns (address)",
  "function getPriceOracle() view returns (address)",
  "function getPoolDataProvider() view returns (address)",
]);

const oracle = new Interface([
  "function getAssetPrice(address asset) view returns (uint256)",
  "function getSourceOfAsset(address asset) view returns (address)",
]);

const dataProvider = new Interface([
  "function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)",
  "function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)",
  "function getLiquidationProtocolFee(address asset) view returns (uint256)",
]);

export const erc20 = new Interface([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function RESERVE_TREASURY_ADDRESS() view returns (address)",
  "function description() view returns (string)",
]);

// ---- addresses ------------------------------------------------------------------------------------

export interface Aave {
  oracle: string;
  dataProvider: string;
}

/** The price oracle and data provider the PoolAddressesProvider points at, after checking it still points at POOL. */
export async function aaveAt(p: JsonRpcProvider): Promise<Aave> {
  const ap = new Contract(ADDRESSES_PROVIDER, addressesProvider, p);
  const [poolAddr, oracleAddr, dpAddr] = await Promise.all([ap.getPool(), ap.getPriceOracle(), ap.getPoolDataProvider()]);
  if (getAddress(poolAddr) !== POOL) throw new Error(`the PoolAddressesProvider points at Pool ${poolAddr}, not ${POOL}`);
  return { oracle: getAddress(oracleAddr), dataProvider: getAddress(dpAddr) };
}

export interface Reserve {
  asset: string;
  /** The reserve's index in each account's configuration bitmap. */
  id: number;
  aToken: string;
}

export async function reserveOf(p: JsonRpcProvider, asset: string): Promise<Reserve> {
  const r = await new Contract(POOL, pool, p).getReserveData(asset);
  return { asset: getAddress(asset), id: Number(r.id), aToken: getAddress(r.aTokenAddress) };
}

// ---- borrowers and health factors -----------------------------------------------------------------

/** Accounts that borrowed (the onBehalfOf of each Borrow event) between two blocks, read in 10,000-block chunks. */
export async function borrowersBetween(p: JsonRpcProvider, from: number, to: number): Promise<string[]> {
  const topic = pool.getEvent("Borrow")!.topicHash;
  const ranges: Array<[number, number]> = [];
  for (let a = from; a <= to; a += 10_000) ranges.push([a, Math.min(a + 9_999, to)]);
  const chunks: Array<Array<{ topics: string[] }>> = await Promise.all(
    ranges.map(([a, b]) =>
      p.send("eth_getLogs", [{ address: POOL, topics: [topic], fromBlock: toQuantity(a), toBlock: toQuantity(b) }]),
    ),
  );
  const seen = new Set<string>();
  for (const logs of chunks) for (const l of logs) seen.add(getAddress(dataSlice(l.topics[2], 12)));
  return [...seen];
}

/** Each account's configuration bitmap: bit 2*id is "borrows reserve id", bit 2*id+1 is "uses it as collateral". */
export async function configurations(p: JsonRpcProvider, users: string[]): Promise<bigint[]> {
  const calls = users.map((u) => ({ target: POOL, data: pool.encodeFunctionData("getUserConfiguration", [u]) }));
  const res = await multicall(p, calls, { chunk: 500 });
  return res.map((r) => (r ? (pool.decodeFunctionResult("getUserConfiguration", r)[0] as bigint) : 0n));
}

export const usesAsCollateral = (config: bigint, id: number): boolean => ((config >> BigInt(2 * id + 1)) & 1n) === 1n;
export const borrows = (config: bigint, id: number): boolean => ((config >> BigInt(2 * id)) & 1n) === 1n;

export interface Account {
  user: string;
  /** USD, 8 decimals (Aave's base currency). */
  collateral: bigint;
  debt: bigint;
  /** 18 decimals; the maximum uint256 when there is no debt. */
  hf: bigint;
}

/** getUserAccountData for each account, through Multicall3. Accounts whose call fails are left out. */
export async function accounts(p: JsonRpcProvider, users: string[]): Promise<Account[]> {
  const calls = users.map((u) => ({ target: POOL, data: pool.encodeFunctionData("getUserAccountData", [u]) }));
  const res = await multicall(p, calls, { chunk: 50, parallel: 12 });
  return users.flatMap((user, i) => {
    const r = res[i];
    if (!r) return [];
    const d = pool.decodeFunctionResult("getUserAccountData", r);
    return [{ user, collateral: d[0] as bigint, debt: d[1] as bigint, hf: d[5] as bigint }];
  });
}

// ---- prices and the mock feed ---------------------------------------------------------------------

export const priceOf = async (p: JsonRpcProvider, oracleAddr: string, asset: string): Promise<bigint> =>
  (await new Contract(oracleAddr, oracle, p).getAssetPrice(asset)) as bigint;

export const sourceOf = async (p: JsonRpcProvider, oracleAddr: string, asset: string): Promise<string> =>
  getAddress(await new Contract(oracleAddr, oracle, p).getSourceOfAsset(asset));

/** A Chainlink feed's description ("ETH / USD"), or "" when the source has none. */
export async function describe(p: JsonRpcProvider, feed: string): Promise<string> {
  try {
    return (await new Contract(feed, erc20, p).description()) as string;
  } catch {
    return "";
  }
}

const word = (v: bigint): string => zeroPadValue(toBeHex(v), 32);

/** AaveOracle keeps the sources in `mapping(address => address) assetsSources`, its first storage variable (slot 0). */
const sourceSlot = (asset: string): string => solidityPackedKeccak256(["uint256", "uint256"], [BigInt(asset), 0n]);

/** Put the mock feed's code at MOCK_FEED with tenderly_setCode. Its price comes from setMockPrice. */
export async function installMockFeed(p: JsonRpcProvider): Promise<void> {
  await p.send("tenderly_setCode", [MOCK_FEED, MOCK_CODE]);
}

/** The mock feed's price (8 decimals), set with tenderly_setStorageAt. */
export async function setMockPrice(p: JsonRpcProvider, price8: bigint): Promise<void> {
  await p.send("tenderly_setStorageAt", [MOCK_FEED, word(0n), word(price8)]);
}

/** Point AaveOracle's source for `asset` at the mock (tenderly_setStorageAt), after checking the slot holds `current`. */
export async function pointAtMock(p: JsonRpcProvider, oracleAddr: string, asset: string, current: string): Promise<void> {
  const slot = sourceSlot(asset);
  const held = await p.getStorage(oracleAddr, slot);
  if (getAddress(dataSlice(held, 12)) !== getAddress(current)) {
    throw new Error(`AaveOracle's source slot for ${asset} holds ${held}, not ${current}: its storage layout changed`);
  }
  await p.send("tenderly_setStorageAt", [oracleAddr, slot, zeroPadValue(MOCK_FEED, 32)]);
}

// ---- one position in detail -----------------------------------------------------------------------

export interface Debt {
  asset: string;
  symbol: string;
  decimals: number;
  amount: bigint;
  /** USD, 8 decimals. */
  price: bigint;
  value: bigint;
}

export interface Position {
  debts: Debt[];
  /** aToken balance in the collateral reserve. */
  collateral: bigint;
  /** Liquidation bonus and the protocol's share of it, in basis points (10500 is a 5% bonus, 2000 is 20%). */
  bonusBps: bigint;
  feeBps: bigint;
}

/** The account's debts (largest value first), its balance in the collateral reserve, and the bonus a liquidator gets. */
export async function positionOf(p: JsonRpcProvider, aave: Aave, user: string, collateral: Reserve): Promise<Position> {
  const poolC = new Contract(POOL, pool, p);
  const dp = new Contract(aave.dataProvider, dataProvider, p);
  const config = (await poolC.getUserConfiguration(user)) as bigint;
  const ids = Array.from({ length: config.toString(2).length }, (_, i) => i).filter((id) => borrows(config, id));
  const assets = (await Promise.all(ids.map((id) => poolC.getReserveAddressById(id)))).map((a: string) => getAddress(a));
  const debts = await Promise.all(
    assets.map(async (asset): Promise<Debt> => {
      const token = new Contract(asset, erc20, p);
      const [data, price, symbol, decimals] = await Promise.all([
        dp.getUserReserveData(asset, user),
        priceOf(p, aave.oracle, asset),
        token.symbol().catch(() => asset.slice(0, 6)),
        token.decimals(),
      ]);
      const amount = data.currentVariableDebt as bigint;
      return { asset, symbol, decimals: Number(decimals), amount, price, value: (amount * price) / 10n ** BigInt(decimals) };
    }),
  );
  debts.sort((a, b) => (a.value > b.value ? -1 : a.value < b.value ? 1 : 0));
  const [held, bonusBps, feeBps] = await Promise.all([
    new Contract(collateral.aToken, erc20, p).balanceOf(user) as Promise<bigint>,
    liquidationBonus(p, aave, user, collateral),
    dp.getLiquidationProtocolFee(collateral.asset) as Promise<bigint>,
  ]);
  return { debts, collateral: held, bonusBps, feeBps };
}

/** The reserve's bonus, or the E-Mode category's when the account is in one that covers this collateral. */
async function liquidationBonus(p: JsonRpcProvider, aave: Aave, user: string, collateral: Reserve): Promise<bigint> {
  const poolC = new Contract(POOL, pool, p);
  const category = Number(await poolC.getUserEMode(user));
  if (category !== 0) {
    const bitmap = (await poolC.getEModeCategoryCollateralBitmap(category)) as bigint;
    if (((bitmap >> BigInt(collateral.id)) & 1n) === 1n) {
      return BigInt((await poolC.getEModeCategoryCollateralConfig(category)).liquidationBonus);
    }
  }
  const config = await new Contract(aave.dataProvider, dataProvider, p).getReserveConfigurationData(collateral.asset);
  return config.liquidationBonus as bigint;
}

/** The account's variable debt in `asset`, at `blockTag` ("pending" reads at the next block's time). */
export const variableDebtOf = async (
  p: JsonRpcProvider, aave: Aave, asset: string, user: string, blockTag = "latest",
): Promise<bigint> =>
  (await new Contract(aave.dataProvider, dataProvider, p).getUserReserveData(asset, user, { blockTag }))
    .currentVariableDebt as bigint;

export const treasuryOf = async (p: JsonRpcProvider, aToken: string): Promise<string> =>
  getAddress(await new Contract(aToken, erc20, p).RESERVE_TREASURY_ADDRESS());

// ---- the liquidation's events ---------------------------------------------------------------------

export interface Liquidation {
  debtToCover: bigint;
  /** Collateral the liquidator received. */
  liquidated: bigint;
  liquidator: string;
  /** aToken moved from the borrower to the treasury: the protocol's share of the bonus. */
  fee: bigint;
  /** Debt written off because the borrower has no collateral left (Aave 3.3 and later), per asset. */
  deficits: Map<string, bigint>;
}

/** Read a liquidationCall receipt: the LiquidationCall and DeficitCreated events and the fee transfer to the treasury. */
export function readLiquidation(logs: readonly Log[], user: string, aToken: string, treasury: string): Liquidation | null {
  let out: Liquidation | null = null;
  let fee = 0n;
  const deficits = new Map<string, bigint>();
  const transfer = erc20.getEvent("Transfer")!.topicHash;
  for (const l of logs) {
    const at = getAddress(l.address);
    if (at === POOL) {
      const ev = pool.parseLog(l);
      if (ev?.name === "LiquidationCall" && getAddress(ev.args.user) === user) {
        out = {
          debtToCover: ev.args.debtToCover,
          liquidated: ev.args.liquidatedCollateralAmount,
          liquidator: getAddress(ev.args.liquidator),
          fee: 0n,
          deficits,
        };
      } else if (ev?.name === "DeficitCreated" && getAddress(ev.args.user) === user) {
        const asset = getAddress(ev.args.debtAsset);
        deficits.set(asset, (deficits.get(asset) ?? 0n) + (ev.args.amountCreated as bigint));
      }
    } else if (at === aToken && l.topics[0] === transfer) {
      const ev = erc20.parseLog(l)!;
      if (getAddress(ev.args.from) === user && getAddress(ev.args.to) === treasury) fee += ev.args.value as bigint;
    }
  }
  if (out) out.fee = fee;
  return out;
}

/** Aave's PercentageMath: basis points, rounded half up. */
export const percentMul = (v: bigint, bps: bigint): bigint => (v * bps + 5_000n) / 10_000n;
export const percentDiv = (v: bigint, bps: bigint): bigint => (v * 10_000n + bps / 2n) / bps;

/** A revert's reason string, or the name of one of Aave's custom errors above, else the error selector. */
export function revertReason(err: unknown): string {
  const e = err as { data?: unknown; reason?: string | null; shortMessage?: string; message?: string };
  if (e.reason) return e.reason;
  if (typeof e.data === "string" && e.data.length >= 10) {
    try {
      const parsed = pool.parseError(e.data);
      if (parsed) return parsed.name === "Error" ? String(parsed.args[0]) : parsed.name;
    } catch {
      // not one of the errors above
    }
    return `error ${e.data.slice(0, 10)}`;
  }
  return e.shortMessage ?? e.message ?? String(err);
}
