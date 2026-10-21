#!/usr/bin/env tsx
/**
 * Watch-state — is the Environment's state following live mainnet (state sync)?
 *
 * Polls two values that move on mainnet nearly every block, straight off the
 * Environment's RPC:
 *   - Uniswap V3 USDC/WETH 0.05% pool `slot0` → the ETH/USDC price
 *   - the pool's WETH balance
 *
 * On a plain fork these are FROZEN at the fork point. With STATE SYNC enabled
 * (`STATE_SYNC=true npm run create`) unmodified state keeps following the
 * live network, so the values drift tick to tick.
 *
 * Target: WATCH_RPC_URL env var, else out/vnet.json. Ctrl-C to stop.
 * Knob: WATCH_INTERVAL_SECONDS (default 10).
 */
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { ethers } from "ethers";
import { providerFor, bold, dim, green, yellow, section } from "./lib/tenderly.js";

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

const INTERVAL_S = Number(process.env.WATCH_INTERVAL_SECONDS ?? 10);
const POOL = "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640"; // Uniswap V3 USDC/WETH 0.05%
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const poolIface = new ethers.Interface(["function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)"]);
const erc20Iface = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);

function resolveTarget(): { rpc: string; stateSync: boolean | null } {
  if (process.env.WATCH_RPC_URL) return { rpc: process.env.WATCH_RPC_URL, stateSync: null };
  const path = resolve(__dirname, "out/vnet.json");
  if (!existsSync(path)) {
    throw new Error("no target: set WATCH_RPC_URL or run `npm run create` first (writes out/vnet.json)");
  }
  const j = JSON.parse(readFileSync(path, "utf8")) as { adminRpc: string; stateSync?: boolean };
  return { rpc: j.adminRpc, stateSync: j.stateSync ?? null };
}

async function main(): Promise<void> {
  const { rpc, stateSync } = resolveTarget();
  const p = providerFor(rpc);
  section(`Watch-state — pool price + balance every ${INTERVAL_S}s`);
  console.log(`  target: ${rpc}`);
  if (stateSync !== null) console.log(`  created with state sync: ${bold(String(stateSync))}`);
  console.log(dim(`  reading Uniswap V3 USDC/WETH slot0 + pool WETH balance — Ctrl-C to stop\n`));

  const read = async (): Promise<{ price: number; wethBal: bigint }> => {
    const [slot0Raw, balRaw] = await Promise.all([
      p.call({ to: POOL, data: poolIface.encodeFunctionData("slot0") }),
      p.call({ to: WETH, data: erc20Iface.encodeFunctionData("balanceOf", [POOL]) }),
    ]);
    const sqrtPriceX96 = poolIface.decodeFunctionResult("slot0", slot0Raw)[0] as bigint;
    // token0 = USDC (6d), token1 = WETH (18d): ETH/USDC = 1e12 / (sqrtP/2^96)^2
    const ratio = Number(sqrtPriceX96) / 2 ** 96;
    const price = 1e12 / (ratio * ratio);
    return { price, wethBal: erc20Iface.decodeFunctionResult("balanceOf", balRaw)[0] as bigint };
  };

  let prev = await read();
  let changes = 0;
  let ticks = 0;
  console.log(`  start · ETH ${bold("$" + prev.price.toFixed(2))} · pool ${Number(ethers.formatEther(prev.wethBal)).toFixed(4)} WETH`);
  let stopping = false;
  process.on("SIGINT", () => { stopping = true; });

  while (!stopping) {
    await new Promise((r) => setTimeout(r, INTERVAL_S * 1000));
    if (stopping) break;
    const cur = await read();
    ticks++;
    const priceMoved = cur.price !== prev.price;
    const balMoved = cur.wethBal !== prev.wethBal;
    if (priceMoved || balMoved) changes++;
    const mark = priceMoved || balMoved ? green("→ CHANGED") : yellow("· frozen");
    console.log(`  tick ${String(ticks).padStart(4)} · ETH ${bold("$" + cur.price.toFixed(2))}${priceMoved ? green(` (${(cur.price - prev.price >= 0 ? "+" : "")}${(cur.price - prev.price).toFixed(2)})`) : ""} · pool ${Number(ethers.formatEther(cur.wethBal)).toFixed(4)} WETH ${mark}`);
    prev = cur;
  }
  console.log(`\n  ${changes}/${ticks} ticks saw state change — ${changes > 0
    ? green("live mainnet state is drifting in: state sync is doing its job")
    : yellow("state is frozen at the fork point (state sync off, or mainnet was quiet)")}`);
}

main().catch((e) => { console.error(`\n✘ ${e instanceof Error ? e.message : e}`); process.exit(1); });
