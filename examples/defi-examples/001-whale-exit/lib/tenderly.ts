/**
 * Tenderly helpers for the whale exit: one Virtual Environment over the public REST API, cheat codes and
 * impersonated sends on its Admin RPC, bundle simulations, log scans, and links.
 *
 * Credentials come from the repo-root .env (TENDERLY_ACCESS_KEY / TENDERLY_ACCOUNT / TENDERLY_PROJECT).
 * Cheat codes only work on the Admin RPC, so keep that URL to yourself.
 */
import { config } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider, getAddress, toQuantity, type Log, type TransactionReceipt } from "ethers";

// Single shared config: the repo-root .env, found by walking up so the folder can move.
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

const API = "https://api.tenderly.co/api";
export const DASHBOARD = "https://dashboard.tenderly.co";

export interface TenderlyEnv {
  accessKey: string;
  account: string;
  project: string;
}

export function requireEnv(): TenderlyEnv {
  const { TENDERLY_ACCESS_KEY, TENDERLY_ACCOUNT, TENDERLY_PROJECT } = process.env;
  for (const [k, v] of Object.entries({ TENDERLY_ACCESS_KEY, TENDERLY_ACCOUNT, TENDERLY_PROJECT })) {
    if (!v) throw new Error(`Missing ${k}. Copy .env.example to .env at the repo root and fill it in.`);
  }
  return { accessKey: TENDERLY_ACCESS_KEY!, account: TENDERLY_ACCOUNT!, project: TENDERLY_PROJECT! };
}

const headers = (key: string): Record<string, string> => ({ "X-Access-Key": key, "Content-Type": "application/json" });

export interface Environment {
  id: string;
  vnetId: string;
  chainId: number;
  /** Cheat codes and impersonated sends. Don't print or share it. */
  adminRpc: string;
  /** The environment's dashboard page (needs a login to the project). */
  dashboardUrl: string;
  /** The public explorer, no login needed; "" if its id couldn't be read. */
  explorerUrl: string;
}

/**
 * Create a single-network Virtual Environment forked at `block` with the public explorer on,
 * via POST /api/public/v1/account/{account}/project/{project}/environments.
 */
export async function createEnvironment(
  env: TenderlyEnv, displayName: string, networkId: number, block: number | "latest", chainId: number,
): Promise<Environment> {
  const res = await fetch(`${API}/public/v1/account/${env.account}/project/${env.project}/environments`, {
    method: "POST",
    headers: headers(env.accessKey),
    body: JSON.stringify({
      display_name: displayName,
      network_configs: [{
        network_id: String(networkId),
        block_number: String(block),
        chain_config_overrides: { chain_id: String(chainId) },
        explorer_config: { enabled: true, contract_verification_visibility: "src" },
      }],
    }),
  });
  if (!res.ok) throw new Error(`create environment failed: HTTP ${res.status} ${await res.text()}`);
  const data = (await res.json()) as {
    id: string;
    active_instance?: { id?: string; vnets?: Array<{ id: string; rpcs?: Array<{ name: string; url: string }> }> };
  };
  const vnet = data.active_instance?.vnets?.[0];
  const adminRpc = vnet?.rpcs?.find((r) => r.name === "Admin RPC")?.url;
  if (!vnet || !adminRpc) {
    await deleteEnvironment(env, data.id);
    throw new Error("the new environment has no Admin RPC; deleted it again");
  }
  const explorerId = await publicEndpointId(env, vnet.id);
  return {
    id: data.id,
    vnetId: vnet.id,
    chainId,
    adminRpc,
    dashboardUrl: `${DASHBOARD}/${env.account}/${env.project}/testnets/${data.id}/instance/${data.active_instance?.id ?? ""}`,
    explorerUrl: explorerId ? `${DASHBOARD}/explorer/vnet/${explorerId}` : "",
  };
}

/**
 * The public explorer (dashboard.tenderly.co/explorer/vnet/<id>) is keyed by the id of the network's Public RPC
 * endpoint, which the container endpoint lists. Links are a convenience, so a failure returns "".
 */
async function publicEndpointId(env: TenderlyEnv, vnetId: string): Promise<string> {
  try {
    const res = await fetch(`${API}/v1/account/${env.account}/project/${env.project}/testnet/container/${vnetId}`, { headers: headers(env.accessKey) });
    if (!res.ok) return "";
    const data = (await res.json()) as { container?: { connectivityConfig?: { endpoints?: Array<{ id: string; private: boolean; transportProtocol: string }> } } };
    return data.container?.connectivityConfig?.endpoints?.find((e) => !e.private && e.transportProtocol === "HTTP")?.id ?? "";
  } catch {
    return "";
  }
}

/** Delete an environment. Best effort: false instead of throwing; a 404 means it's already gone. */
export async function deleteEnvironment(env: TenderlyEnv, id: string): Promise<boolean> {
  try {
    const res = await fetch(`${API}/public/v1/account/${env.account}/project/${env.project}/environments`, {
      method: "DELETE",
      headers: headers(env.accessKey),
      body: JSON.stringify({ environment_ids: [id] }),
    });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

/** A provider for the Admin RPC. The chain id is passed so ethers doesn't probe the network on startup. */
export const providerFor = (rpcUrl: string, chainId: number): JsonRpcProvider =>
  new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true, batchMaxCount: 1 });

/** Native balance for gas: tenderly_setBalance([addrs], wei). */
export async function setBalance(p: JsonRpcProvider, addrs: string[], wei: bigint): Promise<void> {
  await p.send("tenderly_setBalance", [addrs.map((a) => getAddress(a)), toQuantity(wei)]);
}

/** Impersonated send: an unsigned eth_sendTransaction from any address, no key. Sent once, then the receipt. */
export async function sendAs(p: JsonRpcProvider, from: string, to: string, data: string, gas = 8_000_000): Promise<{ hash: string; receipt: TransactionReceipt | null }> {
  const hash: string = await p.send("eth_sendTransaction", [{ from: getAddress(from), to: getAddress(to), data, gas: toQuantity(gas) }]);
  return { hash, receipt: await p.getTransactionReceipt(hash) };
}

export interface BundleResult {
  ok: boolean;
  /** Return data, or the revert data when ok is false. */
  output: string;
  logs: Array<{ address: string; topics: string[]; data: string }>;
}

/** Simulate transactions in order on the latest block with tenderly_simulateBundle. Nothing is committed. */
export async function simulateBundle(p: JsonRpcProvider, txs: Array<{ from: string; to: string; data: string; gas?: number }>): Promise<BundleResult[]> {
  const res: Array<{ status?: boolean; trace?: Array<{ output?: string }>; logs?: Array<{ raw?: { address: string; topics: string[]; data: string } }> }> = await p.send("tenderly_simulateBundle", [
    txs.map((t) => ({ from: getAddress(t.from), to: getAddress(t.to), data: t.data, gas: toQuantity(t.gas ?? 8_000_000) })),
    "latest",
  ]);
  return res.map((r) => ({
    ok: r.status === true,
    output: r.trace?.[0]?.output ?? "0x",
    logs: (r.logs ?? []).flatMap((l) => (l.raw ? [{ address: l.raw.address, topics: l.raw.topics, data: l.raw.data }] : [])),
  }));
}

/**
 * eth_getLogs over a block range. A Virtual Environment answers for its parent chain's history before the fork,
 * so no mainnet RPC is needed. If the node refuses the range, it's split in halves until it answers.
 */
export async function getLogsChunked(
  p: JsonRpcProvider, filter: { address: string; topics: Array<string | null> }, fromBlock: number, toBlock: number, depth = 0,
): Promise<Log[]> {
  try {
    return await p.getLogs({ ...filter, fromBlock, toBlock });
  } catch (err) {
    if (depth >= 10 || toBlock <= fromBlock) throw err;
    const mid = Math.floor((fromBlock + toBlock) / 2);
    const [a, b] = await Promise.all([
      getLogsChunked(p, filter, fromBlock, mid, depth + 1),
      getLogsChunked(p, filter, mid + 1, toBlock, depth + 1),
    ]);
    return [...a, ...b];
  }
}
