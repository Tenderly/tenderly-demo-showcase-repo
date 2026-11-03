// npm run watch-state: read the ETH price in Uniswap V3 USDC/WETH 0.05% and the WETH supply through the Public RPC
// in out/environment.json until Ctrl-C. State Sync off: both keep their fork-block values. State Sync on: both follow
// Ethereum, and the verdict rests on the supply, which moves in nearly every Ethereum block (the pool trades less).
import { Interface, type BlockTag, type JsonRpcProvider } from "ethers";
import * as log from "./lib/log.js";
import { providerFor } from "./lib/tenderly.js";
import { envSeconds, hms, num, reason, ticks, wrapped } from "./lib/run.js";
import { printLinks, readEnvironmentFile } from "./lib/vnet.js";

const POOL = "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640"; // Uniswap V3 USDC/WETH 0.05%: token0 USDC, token1 WETH
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"; // WETH9: totalSupply is its ETH balance
const pool = new Interface(["function slot0() view returns (uint160 sqrtPriceX96, int24, uint16, uint16, uint16, uint8, bool)"]);
const weth = new Interface(["function totalSupply() view returns (uint256)"]);

/** One read, as printed. Changes are counted on these strings, so every mark matches the digits in its row. */
interface State {
  /** ETH in USDC from the pool's price, 2 decimals. */
  price: string;
  /** WETH's total supply, 2 decimals. */
  supply: string;
}

/** A WETH amount (18 decimals) rounded half up to 2 decimals: 2,218,045.85. */
function weth2(wei: bigint): string {
  const hundredths = (wei + 5n * 10n ** 15n) / 10n ** 16n;
  return `${(hundredths / 100n).toLocaleString("en-US")}.${(hundredths % 100n).toString().padStart(2, "0")}`;
}

async function readState(p: JsonRpcProvider, blockTag: BlockTag): Promise<State> {
  const [slot0, supply] = await Promise.all([
    p.call({ to: POOL, data: pool.encodeFunctionData("slot0"), blockTag }),
    p.call({ to: WETH, data: weth.encodeFunctionData("totalSupply"), blockTag }),
  ]);
  const sqrtPriceX96 = pool.decodeFunctionResult("slot0", slot0)[0] as bigint;
  const ratio = Number(sqrtPriceX96) / 2 ** 96; // sqrt(WETH per USDC) in raw units: USDC has 6 decimals, WETH 18
  return {
    price: (1e12 / (ratio * ratio)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    supply: weth2(weth.decodeFunctionResult("totalSupply", supply)[0] as bigint),
  };
}

const cells = (time: string, block: string, price: string, supply: string, changed: string): string =>
  `${time.padEnd(12)} ${block.padEnd(12)} ${price.padEnd(12)} ${supply.padEnd(14)} ${changed}`;

async function main(): Promise<number> {
  const f = readEnvironmentFile();
  const interval = envSeconds("WATCH_INTERVAL_SECONDS", f.stateSync ? 12 : 10);
  const p = providerFor(f.publicRpc, f.chainId);
  log.run("Watch state", `${f.name}, State Sync ${f.stateSync ? "on" : "off"}`, 1);
  // State Sync off: the baseline is the fork block, which every read must still match. State Sync on: state at the
  // fork block is no fixed point, so the baseline is the first read of the latest block.
  const from = f.stateSync ? "" : " at the fork block, then";
  log.step(`Read the ETH price and WETH supply${from} every ${interval} s until Ctrl-C`);

  let reads = 0; // the rows after the baseline, each compared with the row above it
  let changedReads = 0;
  let priceChanges = 0;
  let supplyChanges = 0;
  let failure = "";
  let firstAt = 0; // read times of the baseline and the last row, for the State Sync verdict
  let lastAt = 0;
  let baseHead = 0; // the baseline's head block, and the highest head block read since
  let topHead = 0;
  const latest = async (): Promise<{ head: number; at: number; state: State }> => {
    const at = Math.floor(Date.now() / 1000);
    const [head, state] = await Promise.all([p.getBlockNumber(), readState(p, "latest")]);
    return { head, at, state };
  };
  try {
    let prev: State;
    let baseline: string;
    if (f.stateSync) {
      const first = await latest();
      prev = first.state;
      firstAt = lastAt = first.at;
      baseHead = topHead = first.head;
      baseline = cells(hms(first.at), num(first.head), prev.price, prev.supply, "baseline");
    } else {
      prev = await readState(p, f.forkBlock);
      baseHead = topHead = f.forkBlock;
      baseline = cells("fork", num(f.forkBlock), prev.price, prev.supply, "baseline");
    }
    log.note(cells("time (UTC)", "head block", "ETH (USDC)", "WETH supply", "changed"));
    log.line(baseline);

    for await (const _ of ticks(interval * 1000)) {
      try {
        const { head, at, state } = await latest();
        const price = state.price !== prev.price;
        const supply = state.supply !== prev.supply;
        reads += 1;
        if (price || supply) changedReads += 1;
        if (price) priceChanges += 1;
        if (supply) supplyChanges += 1;
        const changed = price && supply ? "price, supply" : price ? "price" : supply ? "supply" : "none";
        log.line(cells(hms(at), num(head), state.price, state.supply, changed));
        prev = state;
        lastAt = at;
        topHead = Math.max(topHead, head);
      } catch (err) {
        wrapped(log.warn, `read failed: ${reason(err)}; next read in ${interval} s`);
      }
    }
  } catch (err) {
    failure = `${f.stateSync ? "first read" : "read at the fork block"}: ${reason(err)}`;
  }

  let pass = false;
  let summary: string;
  if (failure) {
    wrapped(log.fail, failure);
    summary = "no baseline to compare with";
  } else if (reads === 0) {
    log.fail("stopped before a read to compare with the baseline");
    summary = "no read to compare";
  } else if (!f.stateSync) {
    pass = changedReads === 0;
    if (!pass) {
      const what = [priceChanges > 0 && "the price", supplyChanges > 0 && "WETH supply"].filter(Boolean).join(" and ");
      log.fail(`${what} changed in ${num(changedReads)} of ${num(reads)} reads`);
      log.sub("with State Sync off only transactions sent to this fork change them");
    }
    summary = pass
      ? `no change in ${num(reads)} reads, state stays at the fork block`
      : `state changed in ${num(changedReads)} of ${num(reads)} reads`;
  } else {
    pass = supplyChanges > 0;
    if (!pass) {
      // Under 24 s the reads may all fall inside one Ethereum block, so no change proves nothing.
      const span = lastAt - firstAt;
      log.fail(`WETH supply didn't change in ${num(reads)} reads over ${num(span)} s`);
      log.sub(span < 24
        ? "Ethereum adds a block every 12 s, so read for 24 s or more"
        : "it changes in nearly every Ethereum block, so State Sync isn't following");
    }
    // State Sync changes state without a new block on the fork; say whether the head block moved during the reads.
    const added = topHead - baseHead;
    const heads = added === 0 ? "no new block" : `${num(added)} new block${added === 1 ? "" : "s"}`;
    summary = pass
      ? `WETH supply changed in ${num(supplyChanges)} of ${num(reads)} reads, price in ${num(priceChanges)}, ${heads}`
      : `no WETH supply change in ${num(reads)} reads`;
  }
  log.blank();
  printLinks(f.links);
  return log.result(pass, summary);
}

main().then((code) => process.exit(code), (err) => process.exit(log.fatal(err)));
