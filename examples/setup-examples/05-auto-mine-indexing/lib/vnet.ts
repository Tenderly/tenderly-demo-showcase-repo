/**
 * The State Sync environment and out/environment.json. create-vnet.ts writes the file; the miner and the watcher read
 * it, so they work the same on a plain environment and on a State Sync one.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as log from "./log.js";
import { findEnvironment, type Credentials, type Environment } from "./tenderly.js";

// ---- State Sync -----------------------------------------------------------------------------------

interface RawVnet {
  id: string;
  slug?: string;
  sync_state_config?: { enabled?: boolean };
}

const FIND_TRIES = 10; // one a second

/**
 * Create a VNet with State Sync on: POST /api/v1/account/{a}/project/{p}/vnets, the call in the docs guide "Create
 * Virtual Environments via API". It is not in the API reference, whose Create Environment has no State Sync field.
 * State Sync is fixed at creation: a later PATCH that changes it gets HTTP 400. The account needs a paid plan.
 * The API reference's environments list shows the VNet as an environment with the same slug, so it gets the same
 * ids, RPC URLs and dashboard links as one from createEnvironment().
 */
export async function createStateSyncEnvironment(
  c: Credentials,
  opts: { slug: string; displayName: string; networkId: number; chainId: number },
): Promise<{ env: Environment; stateSync: boolean }> {
  const path = `/account/${c.account}/project/${c.project}/vnets`;
  const res = await fetch(`https://api.tenderly.co/api/v1${path}`, {
    method: "POST",
    headers: { "X-Access-Key": c.accessKey, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      slug: opts.slug,
      display_name: opts.displayName,
      fork_config: { network_id: opts.networkId, block_number: "latest" },
      virtual_network_config: { chain_config: { chain_id: opts.chainId } },
      sync_state_config: { enabled: true },
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      // not JSON, keep the text
    }
    throw new Error(`POST /api/v1/.../vnets failed: HTTP ${res.status} ${log.redact(message)}`);
  }
  const vnet = JSON.parse(text) as RawVnet;
  const slug = vnet.slug ?? opts.slug;
  const env = await findWithRetry(c, slug);
  if (env.networks[0]?.vnetId !== vnet.id) throw new Error(`environment ${slug} holds a VNet other than ${vnet.id}`);
  return { env, stateSync: vnet.sync_state_config?.enabled === true };
}

/** findEnvironment until the slug shows up with an active instance, one try a second. */
async function findWithRetry(c: Credentials, slug: string): Promise<Environment> {
  let lastError = "";
  for (let i = 1; i <= FIND_TRIES; i++) {
    try {
      const env = await findEnvironment(c, slug);
      if (env) return env;
      lastError = "";
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err); // e.g. no active instance with RPCs yet
    }
    if (i < FIND_TRIES) await new Promise((done) => setTimeout(done, 1_000));
  }
  throw new Error(`VNet ${slug} not in the environments list after ${FIND_TRIES} tries${lastError ? `: ${lastError}` : ""}`);
}

// ---- out/environment.json -------------------------------------------------------------------------

export interface EnvironmentFile {
  /** The slug, used as the name in every log line. */
  name: string;
  stateSync: boolean;
  networkId: number;
  chainId: number;
  /** The head block right after creation. */
  forkBlock: number;
  environmentId: string;
  instanceId: string;
  vnetId: string;
  /** Cheat codes, for npm run mine. Never print it. */
  adminRpc: string;
  /** What an indexer and npm run watch-state use. Never print it either. */
  publicRpc: string;
  /** Dashboard links, label to URL, printed at the end of every script. */
  links: Record<string, string>;
  createdAt: string;
}

const FILE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "out", "environment.json");

/** The path to print: relative when the script runs from the example folder (npm run does). */
export function environmentFilePath(): string {
  const rel = relative(process.cwd(), FILE);
  return rel.startsWith("..") ? FILE : rel;
}

export function writeEnvironmentFile(f: EnvironmentFile): void {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, `${JSON.stringify(f, null, 2)}\n`, { mode: 0o600 });
}

/** Read out/environment.json and register its RPC URLs as secrets, so no log line can print them. */
export function readEnvironmentFile(): EnvironmentFile {
  if (!existsSync(FILE)) throw new Error(`no ${environmentFilePath()}: run npm run create first`);
  const f = JSON.parse(readFileSync(FILE, "utf8")) as Partial<EnvironmentFile>;
  log.secret(f.adminRpc, "<admin rpc>");
  log.secret(f.publicRpc, "<public rpc>");
  if (!f.adminRpc || !f.publicRpc || !f.name || !f.chainId || !f.forkBlock || !f.links) {
    throw new Error(`${environmentFilePath()} is incomplete: run npm run create again`);
  }
  return f as EnvironmentFile;
}

export function printLinks(links: Record<string, string>): void {
  for (const [label, url] of Object.entries(links)) log.link(label, url);
}
