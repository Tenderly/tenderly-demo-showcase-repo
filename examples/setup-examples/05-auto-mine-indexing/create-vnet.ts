#!/usr/bin/env tsx
/**
 * Auto-mine indexing (1/2) — create the Virtual Environment.
 *
 * Creates a fresh mainnet-fork Virtual Environment via the REST API and writes its
 * coordinates to out/vnet.json, which auto-mine.ts (script 2/2) picks up.
 * Virtual Environments only mine when a transaction arrives — an indexer pointed
 * at one sees no new blocks. The companion script fixes that by minting empty
 * blocks on an interval.
 */
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { requireEnv, createVnet, createVnetWithStateSync, providerFor, vnetDashboardUrl, bold, dim, section } from "./lib/tenderly.js";

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

const FORK_BLOCK = process.env.FORK_BLOCK ?? "latest";
const STATE_SYNC = /^(1|true|yes)$/i.test(process.env.STATE_SYNC ?? "");

async function main(): Promise<void> {
  const env = requireEnv();
  section(`Create — Virtual Environment (mainnet fork @ ${STATE_SYNC ? "latest, STATE SYNC on" : FORK_BLOCK})`);
  // a State Sync environment always forks at latest, so FORK_BLOCK doesn't apply to it
  const vnet = STATE_SYNC
    ? await createVnetWithStateSync(env, "auto-mine-indexing-sync")
    : await createVnet(env, "auto-mine-indexing", FORK_BLOCK);
  const dashboard = vnetDashboardUrl(env, vnet.vnetId);
  const head = await providerFor(vnet.adminRpc).getBlockNumber();
  console.log(`  admin RPC : ${vnet.adminRpc}`);
  if (vnet.publicRpc) console.log(`  public RPC: ${vnet.publicRpc} ${dim("(point the indexer here)")}`);
  console.log(`  dashboard : ${dashboard}`);
  console.log(`  fork head : ${bold(String(head))}`);

  const outDir = resolve(__dirname, "out");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "vnet.json"), JSON.stringify({
    adminRpc: vnet.adminRpc, publicRpc: vnet.publicRpc ?? null,
    vnetId: vnet.vnetId, containerId: vnet.containerId,
    stateSync: STATE_SYNC, dashboard, forkHead: head, createdAt: new Date().toISOString(),
  }, null, 2));
  console.log(dim(`\n  wrote out/vnet.json — now run: npm run mine${STATE_SYNC ? " (and npm run watch-state to see live state drift in)" : ""}`));
}

main().catch((e) => { console.error(`\n✘ ${e instanceof Error ? e.message : e}`); process.exit(1); });
