// npm run mine: one block per tick on the chain in out/environment.json, so an indexer pointed at it sees new blocks.
// Each tick sends evm_increaseBlocks(1) to the Admin RPC, on a fixed clock: every 10 s, or 12 s with State Sync.
// Ctrl-C prints a summary and the links. A JSON-RPC -32004 rejection (such as the write limit) stops it with exit code 1.
import type { JsonRpcProvider } from "ethers";
import * as log from "./lib/log.js";
import { providerFor } from "./lib/tenderly.js";
import { dateTime, envSeconds, gap, hms, isRejected, num, reason, ticks, wrapped } from "./lib/run.js";
import { printLinks, readEnvironmentFile } from "./lib/vnet.js";

const FAILS_IN_A_ROW = 6; // other errors, such as a dropped connection, retry on the next tick up to this many times

interface Block {
  number: number;
  timestamp: number;
}

/** Mine one block. evm_increaseBlocks returns the hash of the cheat-code transaction it puts in that block. */
async function mineOne(p: JsonRpcProvider): Promise<Block> {
  const hash: string = await p.send("evm_increaseBlocks", ["0x1"]);
  const receipt = await p.getTransactionReceipt(hash);
  const block = await p.getBlock(receipt?.blockNumber ?? "latest");
  if (!block) throw new Error("no block after evm_increaseBlocks");
  return { number: block.number, timestamp: block.timestamp };
}

const blocks = (n: number): string => `${num(n)} block${n === 1 ? "" : "s"}`;

async function main(): Promise<number> {
  const f = readEnvironmentFile();
  const interval = envSeconds("MINE_INTERVAL_SECONDS", f.stateSync ? 12 : 10);
  const p = providerFor(f.adminRpc, f.chainId);
  log.run("Auto-mine", `${f.name}, State Sync ${f.stateSync ? "on" : "off"}`, 1);
  log.step(`Mine one block every ${interval} s until Ctrl-C`);

  let failure = "";
  let details: string[] = []; // printed under the [FAIL] line
  let mined = 0;
  let others = 0; // blocks that other writes (a send from the dashboard, a test) mined between two ticks
  let prev: Block | undefined;
  try {
    const head = await p.getBlock("latest");
    if (!head) throw new Error("no latest block");
    prev = { number: head.number, timestamp: head.timestamp };
    log.ok(`head ${num(head.number)} at ${dateTime(head.timestamp)}`);
    if (f.stateSync) log.sub("with State Sync each new block takes the time of Ethereum's latest block");
    log.note(`${"block".padEnd(12)} ${"time (UTC)".padEnd(12)} gap to the previous block`);

    let failsInARow = 0;
    for await (const _ of ticks(interval * 1000)) {
      let b: Block;
      try {
        b = await mineOne(p);
      } catch (err) {
        if (isRejected(err)) {
          failure = `evm_increaseBlocks rejected after block ${num(prev.number)} (JSON-RPC -32004)`;
          details = [reason(err)];
          // The write limit and the monthly usage limit share this message; only the write limit is per environment.
          if (/quota limit/i.test(details[0])) {
            details.push("write limit (npm run create makes a new environment) or monthly usage limit");
          }
          break;
        }
        failsInARow += 1;
        if (failsInARow >= FAILS_IN_A_ROW) {
          failure = `${failsInARow} ticks in a row failed after block ${num(prev.number)}: ${reason(err)}`;
          break;
        }
        wrapped(log.warn, `tick failed: ${reason(err)}; next tick in ${interval} s`);
        continue;
      }
      failsInARow = 0;
      // Each row must be a new block after the one above it; anything else (a revert elsewhere) stops the count.
      if (b.number <= prev.number) {
        failure = `block ${num(b.number)} is not after block ${num(prev.number)}, so something reverted the chain`;
        break;
      }
      const skipped = b.number - prev.number - 1;
      const seconds = b.timestamp - prev.timestamp;
      // The first block's gap would count from the head block, which can be minutes old, so that row says "first".
      const first = mined === 0;
      const note = skipped > 0
        ? `${num(skipped)} more from other writes`
        : f.stateSync && !first && seconds === 0 ? "same Ethereum block" : "";
      const gapCell = first ? "first" : gap(seconds);
      log.line(`${num(b.number).padEnd(12)} ${hms(b.timestamp).padEnd(12)} ${gapCell.padEnd(10)} ${note}`.trimEnd());
      others += skipped;
      mined += 1;
      prev = b;
    }
  } catch (err) {
    failure = `read the head block: ${reason(err)}`;
  }

  if (failure) {
    wrapped(log.fail, failure);
    for (const d of details) wrapped(log.sub, d);
  }
  log.blank();
  printLinks(f.links);
  if (failure) return log.result(false, mined === 0 ? "no block mined" : `stopped after ${blocks(mined)}`);
  if (mined === 0) return log.result(true, "no block mined before Ctrl-C");
  const extra = others > 0 ? `, ${num(others)} more from other writes` : "";
  // With State Sync each block takes Ethereum's latest block time, so the gaps follow Ethereum, not the tick.
  return log.result(true, f.stateSync
    ? `${blocks(mined)} mined${extra}; block times follow Ethereum`
    : `${blocks(mined)} mined, one every ${interval} s${extra}`);
}

main().then((code) => process.exit(code), (err) => process.exit(log.fatal(err)));
