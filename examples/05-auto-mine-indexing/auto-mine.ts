#!/usr/bin/env tsx
/**
 * Auto-mine indexing (2/2) — mint a block every N seconds.
 *
 * Long-running: every MINE_INTERVAL_SECONDS (default 10) it sends
 * `evm_increaseBlocks` to the Virtual Environment's Admin RPC, so the chain keeps
 * producing blocks even with zero transactions — indexers, subgraphs, and
 * block-polling apps pointed at the (public) RPC see a live chain.
 *
 * Target resolution: MINE_RPC_URL env var, else out/vnet.json written by
 * create-vnet.ts. Stop with Ctrl-C. Knobs:
 *   MINE_INTERVAL_SECONDS  default 10
 *   MINE_BLOCKS            blocks per tick, default 1
 */
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { ethers } from "ethers";
import { providerFor, bold, dim, green, section } from "./lib/tenderly.js";

// shared repo-root .env — found by walking upward, so the folder can move
const __dirname = dirname(fileURLToPath(import.meta.url));
const findEnv = (start: string): string | null => {
  for (let d = start, i = 0; i < 8; i++) {
    const candidate = resolve(d, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return null;
};
const envPath = findEnv(__dirname);
config(envPath ? { path: envPath } : {});

const INTERVAL_S = Number(process.env.MINE_INTERVAL_SECONDS ?? 10);
const BLOCKS_PER_TICK = Number(process.env.MINE_BLOCKS ?? 1);

function resolveRpc(): string {
  if (process.env.MINE_RPC_URL) return process.env.MINE_RPC_URL;
  const path = resolve(__dirname, "out/vnet.json");
  if (!existsSync(path)) {
    throw new Error("no target: set MINE_RPC_URL or run `npm run create` first (writes out/vnet.json)");
  }
  return (JSON.parse(readFileSync(path, "utf8")) as { adminRpc: string }).adminRpc;
}

async function main(): Promise<void> {
  const rpc = resolveRpc();
  const p = providerFor(rpc);
  const start = await p.getBlockNumber();
  section(`Auto-mine — +${BLOCKS_PER_TICK} block${BLOCKS_PER_TICK > 1 ? "s" : ""} every ${INTERVAL_S}s`);
  console.log(`  target: ${rpc}`);
  console.log(`  block now: ${bold(String(start))} — Ctrl-C to stop\n`);

  let ticks = 0;
  let stopping = false;
  process.on("SIGINT", () => { stopping = true; });

  while (!stopping) {
    await new Promise((r) => setTimeout(r, INTERVAL_S * 1000));
    if (stopping) break;
    try {
      await p.send("evm_increaseBlocks", [ethers.toQuantity(BLOCKS_PER_TICK)]);
      const block = await p.getBlock("latest");
      ticks++;
      console.log(`  ${green("⛏")} tick ${String(ticks).padStart(4)} · block ${bold(String(block!.number))} · ts ${new Date(Number(block!.timestamp) * 1000).toISOString()} ${dim(`(+${start === block!.number ? 0 : block!.number - start} since start)`)}`);
    } catch (e) {
      console.log(`  ✘ tick failed: ${(e as Error).message.slice(0, 120)} ${dim("— retrying next interval")}`);
    }
  }
  console.log(dim(`\n  stopped after ${ticks} ticks (${ticks * BLOCKS_PER_TICK} blocks mined)`));
}

main().catch((e) => { console.error(`\n✘ ${e instanceof Error ? e.message : e}`); process.exit(1); });
