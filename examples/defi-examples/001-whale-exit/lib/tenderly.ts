/**
 * Tenderly helpers: Virtual Environments through the public REST API (the API reference), cheat codes and
 * impersonated sends on the Admin RPC, and dashboard links. Credentials come from the repo-root .env.
 */
import { config } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider, getAddress, toQuantity, type TransactionReceipt } from "ethers";
import { redact, secret } from "./log.js";

// The repo-root .env, found by walking up so the folder can be copied anywhere below it.
const here = dirname(fileURLToPath(import.meta.url));
for (let d = here, i = 0; i < 8; i++) {
  const candidate = resolve(d, ".env");
  if (existsSync(candidate)) {
    config({ path: candidate, quiet: true });
    break;
  }
  if (dirname(d) === d) break;
  d = dirname(d);
}

const API = "https://api.tenderly.co/api/public/v1";
export const DASHBOARD = "https://dashboard.tenderly.co";

export interface Credentials {
  accessKey: string;
  account: string;
  project: string;
}

export function credentials(): Credentials {
  const { TENDERLY_ACCESS_KEY, TENDERLY_ACCOUNT, TENDERLY_PROJECT } = process.env;
  for (const [k, v] of Object.entries({ TENDERLY_ACCESS_KEY, TENDERLY_ACCOUNT, TENDERLY_PROJECT })) {
    if (!v) throw new Error(`missing ${k}: copy .env.example to .env at the repo root`);
  }
  secret(TENDERLY_ACCESS_KEY, "<access key>");
  return { accessKey: TENDERLY_ACCESS_KEY!, account: TENDERLY_ACCOUNT!, project: TENDERLY_PROJECT! };
}

const headers = (c: Credentials): Record<string, string> => ({
  "X-Access-Key": c.accessKey,
  "Content-Type": "application/json",
  Accept: "application/json",
});

/** A failed REST call. `status` is the HTTP status, e.g. 409 when a slug is taken. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function call<T>(c: Credentials, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}/account/${c.account}/project/${c.project}${path}`, {
    method,
    headers: headers(c),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
    } catch {
      // not JSON, keep the text
    }
    throw new ApiError(`${method} ${path.split("?")[0]} failed: HTTP ${res.status} ${redact(message)}`, res.status);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

// ---- environments ---------------------------------------------------------------------------------

export interface NetworkConfig {
  /** Parent network id, e.g. 1 for Ethereum, 8453 for Base. */
  networkId: number;
  /** Chain id of the fork. Use the 7357 prefix (73571 for Ethereum) so its transactions can't replay on the real chain. */
  chainId: number;
  /** Fork block; omit for the latest block. */
  block?: number;
}

export interface Network {
  networkId: number;
  chainId: number;
  /** The block the fork starts from. */
  forkBlock: number;
  /** The VNet id, used in transaction links. */
  vnetId: string;
  /** Cheat codes and impersonated sends. Never print it. */
  adminRpc: string;
  /** Standard JSON-RPC, what an app uses. Never print it either: it is a credential too. */
  publicRpc: string;
}

export interface Environment {
  id: string;
  slug: string;
  displayName: string;
  instanceId: string;
  networks: Network[];
}

interface RawEnvironment {
  id: string;
  slug?: string;
  display_name?: string;
  active_instance?: {
    id?: string;
    vnets?: Array<{
      id: string;
      fork_config?: { network_id?: number | string; block_number?: number | string };
      virtual_network_config?: { chain_config?: { chain_id?: number | string } };
      rpcs?: Array<{ name: string; url: string }>;
    }>;
  };
}

function toEnvironment(raw: RawEnvironment): Environment {
  const networks = (raw.active_instance?.vnets ?? []).map((v) => {
    const adminRpc = v.rpcs?.find((r) => r.name === "Admin RPC")?.url ?? "";
    const publicRpc = v.rpcs?.find((r) => r.name === "Public RPC")?.url ?? "";
    secret(adminRpc, "<admin rpc>");
    secret(publicRpc, "<public rpc>");
    return {
      networkId: Number(v.fork_config?.network_id ?? 0),
      chainId: Number(v.virtual_network_config?.chain_config?.chain_id ?? 0),
      forkBlock: Number(BigInt(v.fork_config?.block_number ?? 0)),
      vnetId: v.id,
      adminRpc,
      publicRpc,
    };
  });
  if (!raw.active_instance?.id || networks.length === 0 || networks.some((n) => !n.adminRpc)) {
    throw new Error(`environment ${raw.id} has no active instance with RPCs yet`);
  }
  return { id: raw.id, slug: raw.slug ?? "", displayName: raw.display_name ?? "", instanceId: raw.active_instance.id, networks };
}

/** A slug that is unique per run: the API answers a reused slug with HTTP 409. */
export function runSlug(base: string, at = new Date()): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15).toLowerCase();
  return `${base}-${stamp}`;
}

/**
 * Create an environment: POST /environments (API reference, "Create Environment"). Nothing deletes it, so its
 * dashboard links keep working. One entry in `networks` per chain; more than one with `bridge` relays CCTP V2.
 */
export async function createEnvironment(
  c: Credentials,
  opts: { displayName: string; slug: string; networks: NetworkConfig[]; bridge?: boolean },
): Promise<Environment> {
  const raw = await call<RawEnvironment>(c, "POST", "/environments", {
    display_name: opts.displayName,
    slug: opts.slug,
    network_configs: opts.networks.map((n) => ({
      network_id: String(n.networkId),
      ...(n.block === undefined ? {} : { block_number: toQuantity(n.block) }),
      chain_config_overrides: { chain_id: String(n.chainId) },
    })),
    ...(opts.bridge ? { bridge_config: { enabled: true, relay_mode: "autoRelay", delay_seconds: 0 } } : {}),
  });
  return toEnvironment(raw);
}

/** Read one environment: GET /environments/{id}. */
export async function getEnvironment(c: Credentials, id: string): Promise<Environment> {
  return toEnvironment(await call<RawEnvironment>(c, "GET", `/environments/${id}`));
}

/** Find an environment by slug: GET /environments, every page (100 per page; above 100 the API returns 50). */
export async function findEnvironment(c: Credentials, slug: string): Promise<Environment | null> {
  for (let page = 1; ; page++) {
    const batch = await call<RawEnvironment[]>(c, "GET", `/environments?page=${page}&per_page=100`);
    const hit = batch.find((e) => e.slug === slug);
    if (hit) return getEnvironment(c, hit.id);
    if (batch.length < 100) return null;
  }
}

// ---- dashboard links (they need a login to the project) ---------------------------------------------

/** Links from plain ids, for an environment someone else created (CI passes the ids in env vars). */
export function dashboardLinks(account: string, project: string, environmentId: string, instanceId: string) {
  const environment = `${DASHBOARD}/${account}/${project}/testnets/${environmentId}/instance/${instanceId}`;
  return {
    environment,
    transactions: `${environment}/activity/transactions`,
    bridges: `${environment}/bridges`,
    tx: (vnetId: string, hash: string): string => `${environment}/container/${vnetId}/tx/${hash}`,
  };
}

export const environmentUrl = (c: Credentials, e: Environment): string =>
  dashboardLinks(c.account, c.project, e.id, e.instanceId).environment;
export const transactionsUrl = (c: Credentials, e: Environment): string =>
  dashboardLinks(c.account, c.project, e.id, e.instanceId).transactions;
export const bridgesUrl = (c: Credentials, e: Environment): string =>
  dashboardLinks(c.account, c.project, e.id, e.instanceId).bridges;
export const txUrl = (c: Credentials, e: Environment, n: Network, hash: string): string =>
  dashboardLinks(c.account, c.project, e.id, e.instanceId).tx(n.vnetId, hash);

// ---- Admin RPC ------------------------------------------------------------------------------------

/**
 * A provider with a fixed chain id, so ethers doesn't probe the network on startup. cacheTimeout -1 turns off
 * ethers' 250 ms cache of identical requests, which would otherwise return a balance from before a send.
 */
export const providerFor = (rpcUrl: string, chainId: number): JsonRpcProvider =>
  new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });

/**
 * tenderly_setBalance: set the native balance of one or more addresses. Mines a block. Impersonated sends run at
 * gas price 0, so senders don't need ETH for gas.
 */
export async function setBalance(p: JsonRpcProvider, addresses: string[], wei: bigint): Promise<void> {
  await p.send("tenderly_setBalance", [addresses.map((a) => getAddress(a)), toQuantity(wei)]);
}

/** tenderly_setErc20Balance: an ERC-20 balance, set directly. Mines a block. */
export async function setErc20Balance(p: JsonRpcProvider, token: string, holder: string, amount: bigint): Promise<void> {
  await p.send("tenderly_setErc20Balance", [getAddress(token), getAddress(holder), toQuantity(amount)]);
}

/** Impersonated send: eth_sendTransaction from any address, no key, at gas price 0. Returns the hash and the receipt. */
export async function sendAs(
  p: JsonRpcProvider,
  tx: { from: string; to: string; data: string; value?: bigint; gas?: number },
): Promise<{ hash: string; receipt: TransactionReceipt }> {
  const hash: string = await p.send("eth_sendTransaction", [{
    from: getAddress(tx.from),
    to: getAddress(tx.to),
    data: tx.data,
    ...(tx.value ? { value: toQuantity(tx.value) } : {}),
    gas: toQuantity(tx.gas ?? 8_000_000),
  }]);
  const receipt = await p.getTransactionReceipt(hash);
  if (!receipt) throw new Error(`no receipt for ${hash}`);
  return { hash, receipt };
}

/** evm_snapshot: an id to return to with revert(). */
export const snapshot = (p: JsonRpcProvider): Promise<string> => p.send("evm_snapshot", []);
/** evm_revert: drop everything after the snapshot, including the clock. */
export const revert = async (p: JsonRpcProvider, id: string): Promise<boolean> => p.send("evm_revert", [id]);
/** evm_increaseTime: move the clock forward; mines a block that holds the cheat-code transaction. */
export const increaseTime = async (p: JsonRpcProvider, seconds: number): Promise<void> => {
  await p.send("evm_increaseTime", [toQuantity(seconds)]);
};
/**
 * tenderly_setNextBlockTimestamp: the time of the next block, without mining one. It must be later than the latest
 * block's time (an equal value fails with -32006), and it holds until the next block is mined.
 */
export const setNextBlockTimestamp = async (p: JsonRpcProvider, ts: number): Promise<void> => {
  await p.send("tenderly_setNextBlockTimestamp", [toQuantity(ts)]);
};

export interface SimResult {
  ok: boolean;
  /** Return data, or the revert data when ok is false. */
  output: string;
  gasUsed: number;
  logs: Array<{ address: string; topics: string[]; data: string }>;
}

/**
 * tenderly_simulateBundle: run transactions in order on top of a block ("latest" by default; "pending" runs at a
 * time pinned with setNextBlockTimestamp). Nothing is committed.
 */
export async function simulateBundle(
  p: JsonRpcProvider,
  txs: Array<{ from: string; to: string; data: string; value?: bigint; gas?: number }>,
  block: string = "latest",
): Promise<SimResult[]> {
  const res: Array<{
    status?: boolean;
    gasUsed?: string;
    trace?: Array<{ output?: string }>;
    logs?: Array<{ raw?: { address: string; topics: string[]; data: string } }>;
  }> = await p.send("tenderly_simulateBundle", [
    txs.map((t) => ({
      from: getAddress(t.from),
      to: getAddress(t.to),
      data: t.data,
      ...(t.value ? { value: toQuantity(t.value) } : {}),
      gas: toQuantity(t.gas ?? 8_000_000),
    })),
    block,
  ]);
  return res.map((r) => ({
    ok: r.status === true,
    output: r.trace?.[0]?.output ?? "0x",
    gasUsed: Number(r.gasUsed ?? 0),
    logs: (r.logs ?? []).flatMap((l) => (l.raw ? [l.raw] : [])),
  }));
}
