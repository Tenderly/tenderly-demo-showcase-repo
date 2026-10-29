/**
 * MetaMorpho (Morpho Vault V1) helpers: the vault and its markets, the state of the markets a batch touches (read through
 * Multicall3, as an eth_call or as a bundle step), reallocate arguments, and reverts decoded by name.
 */
import { Interface, MaxUint256, ZeroAddress, getAddress, parseUnits, type JsonRpcProvider, type Result } from "ethers";
import { multicall, type ContractCall } from "./multicall.js";

const MARKET_PARAMS = "(address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)";

export const metaMorphoI = new Interface([
  "function MORPHO() view returns (address)",
  "function symbol() view returns (string)",
  "function asset() view returns (address)",
  "function curator() view returns (address)",
  "function timelock() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function withdrawQueueLength() view returns (uint256)",
  "function withdrawQueue(uint256) view returns (bytes32)",
  "function supplyQueueLength() view returns (uint256)",
  "function supplyQueue(uint256) view returns (bytes32)",
  "function config(bytes32 id) view returns (uint184 cap, bool enabled, uint64 removableAt)",
  "function pendingCap(bytes32 id) view returns (uint192 value, uint64 validAt)",
  `function submitCap(${MARKET_PARAMS} marketParams, uint256 newSupplyCap)`,
  `function acceptCap(${MARKET_PARAMS} marketParams)`,
  `function reallocate((${MARKET_PARAMS} marketParams, uint256 assets)[] allocations)`,
  "event ReallocateSupply(address indexed caller, bytes32 indexed id, uint256 suppliedAssets, uint256 suppliedShares)",
  "event ReallocateWithdraw(address indexed caller, bytes32 indexed id, uint256 withdrawnAssets, uint256 withdrawnShares)",
  // ErrorsLib, so reverts decode by name. Morpho Blue's own reverts are strings, e.g. "insufficient liquidity".
  "error AboveMaxTimelock()", "error AllCapsReached()", "error AlreadyPending()", "error AlreadySet()",
  "error BelowMinTimelock()", "error DuplicateMarket(bytes32 id)", "error InconsistentAsset(bytes32 id)",
  "error InconsistentReallocation()", "error InvalidMarketRemovalNonZeroCap(bytes32 id)",
  "error InvalidMarketRemovalNonZeroSupply(bytes32 id)", "error InvalidMarketRemovalTimelockNotElapsed(bytes32 id)",
  "error MarketNotCreated()", "error MarketNotEnabled(bytes32 id)", "error MaxFeeExceeded()", "error MaxQueueLengthExceeded()",
  "error NoPendingValue()", "error NonZeroCap()", "error NotAllocatorRole()", "error NotCuratorNorGuardianRole()",
  "error NotCuratorRole()", "error NotEnoughLiquidity()", "error NotGuardianRole()", "error PendingCap(bytes32 id)",
  "error PendingRemoval()", "error SupplyCapExceeded(bytes32 id)", "error TimelockNotElapsed()",
  "error UnauthorizedMarket(bytes32 id)", "error ZeroAddress()", "error ZeroFeeRecipient()",
]);

export const morphoBlueI = new Interface([
  `function idToMarketParams(bytes32 id) view returns ${MARKET_PARAMS}`,
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, "
    + "uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  `function accrueInterest(${MARKET_PARAMS} marketParams)`,
]);

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
  /** "cbBTC/USDC 86%", plus the id's start ("0x64d6") when two markets share a label. */
  label: string;
}

export interface Vault {
  address: string;
  morpho: string;
  symbol: string;
  assetSymbol: string;
  decimals: number;
  curator: string;
  /** Seconds. */
  timelock: number;
  totalAssets: bigint;
  /** Withdraw queue order, then markets that are only in the supply queue. */
  markets: VaultMarket[];
}

/** One market of the vault: the vault's supply in it (in assets), its cap, and a pending cap (0 if none). */
export interface MarketState {
  supply: bigint;
  cap: bigint;
  pendingCap: bigint;
}

/** Read a MetaMorpho vault and label its markets, in four Multicall3 calls. */
export async function readVault(p: JsonRpcProvider, address: string): Promise<Vault> {
  const vault = getAddress(address);
  const mm = (fn: string, args: unknown[] = []): ContractCall => ({ target: vault, iface: metaMorphoI, fn, args });
  const fns = ["MORPHO", "symbol", "asset", "curator", "timelock", "totalAssets", "withdrawQueueLength", "supplyQueueLength"];
  const head = await multicall(p, fns.map((fn) => mm(fn))).catch(() => []);
  if (head.length === 0 || head.some((r) => !r)) throw new Error(`${vault} doesn't answer as a MetaMorpho vault`);
  const [morpho, symbol, asset, curator, timelock, totalAssets, wqLen, sqLen] = head.map((r) => r![0]);
  const range = (n: bigint): number[] => Array.from({ length: Number(n) }, (_, i) => i);
  const queues = await multicall(p, [
    ...range(wqLen).map((i) => mm("withdrawQueue", [i])), ...range(sqLen).map((i) => mm("supplyQueue", [i])),
  ]);
  const ids = [...new Set(queues.map((r) => r![0] as string))];
  const reads = await multicall(p, [
    ...ids.map((id): ContractCall => ({ target: morpho, iface: morphoBlueI, fn: "idToMarketParams", args: [id] })),
    { target: asset, iface: erc20I, fn: "symbol" },
    { target: asset, iface: erc20I, fn: "decimals" },
  ]);
  const params = ids.map((_, i): MarketParams => {
    const [loanToken, collateralToken, oracle, irm, lltv] = reads[i]!;
    return {
      loanToken: getAddress(loanToken), collateralToken: getAddress(collateralToken),
      oracle: getAddress(oracle), irm: getAddress(irm), lltv,
    };
  });
  const assetSymbol = reads[ids.length]![0] as string;
  const collaterals = [...new Set(params.map((m) => m.collateralToken).filter((c) => c !== ZeroAddress))];
  const symbols = await multicall(p, collaterals.map((c): ContractCall => ({
    target: c, iface: erc20I, fn: "symbol", allowFailure: true,
  })));
  const symbolOf = new Map(collaterals.map((c, i) => [c, (symbols[i]?.[0] as string | undefined) ?? `${c.slice(0, 6)}…`]));
  const base = params.map((m) => (m.collateralToken === ZeroAddress
    ? `${assetSymbol} idle`
    : `${symbolOf.get(m.collateralToken)}/${assetSymbol} ${parseFloat((Number(m.lltv) / 1e16).toFixed(2))}%`));
  return {
    address: vault, morpho: getAddress(morpho), symbol, assetSymbol, decimals: Number(reads[ids.length + 1]![0]),
    curator: getAddress(curator), timelock: Number(timelock), totalAssets,
    markets: ids.map((id, i) => ({
      id, params: params[i], label: base.filter((l) => l === base[i]).length > 1 ? `${base[i]} ${id.slice(0, 6)}` : base[i],
    })),
  };
}

/** The vault's market for an id or its first hex digits (at least 8, e.g. 0x64d65c9a). */
export function marketOf(v: Vault, ref: string): VaultMarket {
  const r = String(ref).toLowerCase();
  if (!/^0x[0-9a-f]{8,64}$/.test(r)) {
    throw new Error(`market "${ref}": use the market id or its first 8 hex digits, e.g. 0x64d65c9a`);
  }
  const hits = v.markets.filter((m) => m.id.toLowerCase().startsWith(r));
  if (hits.length === 1) return hits[0];
  throw new Error(hits.length
    ? `market "${ref}" matches ${hits.length} markets of ${v.symbol}; add digits`
    : `market "${ref}" is not in ${v.symbol}'s queues`);
}

/**
 * Multicall3 calls that read every market of the vault. Interest is accrued first (Morpho's accrueInterest is
 * permissionless), so supply includes what borrowers owe up to this block. They run as an eth_call or a bundle step.
 */
export function marketStateCalls(v: Vault): ContractCall[] {
  const morpho = (fn: string, args: unknown[]): ContractCall => ({ target: v.morpho, iface: morphoBlueI, fn, args });
  const vault = (fn: string, args: unknown[]): ContractCall => ({ target: v.address, iface: metaMorphoI, fn, args });
  return [
    ...v.markets.map((m) => morpho("accrueInterest", [m.params])),
    ...v.markets.flatMap((m) => [
      morpho("market", [m.id]), morpho("position", [m.id, v.address]), vault("config", [m.id]), vault("pendingCap", [m.id]),
    ]),
  ];
}

/** Decode what marketStateCalls returned, by market id. */
export function decodeMarketState(v: Vault, values: Array<Result | undefined>): Record<string, MarketState> {
  const out: Record<string, MarketState> = {};
  v.markets.forEach(({ id }, j) => {
    const at = (i: number): Result => {
      const r = values[v.markets.length + 4 * j + i];
      if (!r) throw new Error(`the read of market ${id.slice(0, 10)} returned nothing`);
      return r;
    };
    const [totalSupplyAssets, totalSupplyShares] = at(0) as unknown as bigint[];
    const supplyShares = at(1)[0] as bigint;
    const pendingCap = at(3)[0] as bigint;
    // SharesMathLib.toAssetsDown with Morpho's virtual shares (1e6) and virtual assets (1).
    const supply = (supplyShares * (totalSupplyAssets + 1n)) / (totalSupplyShares + 1_000_000n);
    out[id] = { supply, cap: at(2)[0] as bigint, pendingCap };
  });
  return out;
}

/** Assets moved from one market of the vault to another. */
export interface Move {
  from: string;
  to: string;
  amount: bigint;
}

/** A market's supply when the batch was decoded and the target the reallocate sets (`rest`: the max leg). */
export interface Target {
  id: string;
  before: bigint;
  after: bigint;
  rest: boolean;
}

/**
 * reallocate arguments for moves between the vault's markets. Each allocation is a target supply, not an amount:
 * withdrawals come first, and the last supply is type(uint256).max, so it takes whatever the withdrawals returned.
 */
export function reallocation(v: Vault, state: Record<string, MarketState>, moves: Move[]): {
  allocations: Array<{ marketParams: MarketParams; assets: bigint }>;
  targets: Target[];
} {
  const byId = new Map(v.markets.map((m) => [m.id, m]));
  const delta = new Map<string, bigint>();
  for (const mv of moves) {
    if (mv.amount <= 0n) throw new Error("a reallocate move needs a positive amount");
    if (mv.from === mv.to) throw new Error(`a reallocate move from ${byId.get(mv.from)!.label} to itself`);
    delta.set(mv.from, (delta.get(mv.from) ?? 0n) - mv.amount);
    delta.set(mv.to, (delta.get(mv.to) ?? 0n) + mv.amount);
  }
  const targets: Target[] = [];
  for (const [id, d] of delta) {
    const before = state[id].supply;
    if (before + d < 0n) throw new Error(`the batch takes more out of ${byId.get(id)!.label} than ${v.symbol} supplies there`);
    if (d !== 0n) targets.push({ id, before, after: before + d, rest: false });
  }
  const supplies = targets.filter((t) => t.after > t.before);
  if (supplies.length) supplies[supplies.length - 1].rest = true;
  const ordered = [...targets.filter((t) => t.after < t.before), ...supplies];
  return {
    allocations: ordered.map((t) => ({ marketParams: byId.get(t.id)!.params, assets: t.rest ? MaxUint256 : t.after })),
    targets: ordered,
  };
}

/** "11M", "250k", "1.5M", "20000000" in units of an asset with `decimals` decimals. */
export function parseAmount(s: string | number, decimals: number): bigint {
  const m = /^(\d+(?:\.\d+)?)([kmb]?)$/i.exec(String(s).replace(/[,_\s]/g, ""));
  if (!m) throw new Error(`amount "${s}": use e.g. 11M, 250k or 1500000`);
  const exponent = { "": 0, k: 3, m: 6, b: 9 }[m[2].toLowerCase() as "" | "k" | "m" | "b"];
  try {
    return parseUnits(m[1], decimals + exponent);
  } catch {
    throw new Error(`amount "${s}" has more decimals than the asset (${decimals})`);
  }
}

/** A revert by name: MetaMorpho's custom errors, revert strings (Morpho Blue, Safe's GS0xx codes), panics. */
export function decodeRevert(data: string): { name: string; args: string[]; text: string } {
  try {
    const e = metaMorphoI.parseError(data);
    if (e) {
      const args = e.args.map((a: unknown) => String(a));
      if (e.name === "Error") return { name: args[0], args: [], text: args[0] };
      if (e.name === "Panic") return { name: "Panic", args, text: `panic 0x${BigInt(args[0]).toString(16)}` };
      const shown = args.map((a) => (/^0x[0-9a-fA-F]{64}$/.test(a) ? `${a.slice(0, 10)}…` : a));
      return { name: e.name, args, text: `${e.name}(${shown.join(", ")})` };
    }
  } catch {
    // not an error this interface knows
  }
  return { name: "unknown", args: [], text: data === "0x" ? "a revert without data" : `revert data ${data.slice(0, 10)}…` };
}
