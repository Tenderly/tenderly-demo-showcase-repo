/**
 * Tenderly Virtual Environment helpers for the auto-mine scripts: creating an
 * environment over REST, an Admin-RPC provider, and console styling.
 */
import { JsonRpcProvider } from "ethers";

const API = "https://api.tenderly.co/api";

export interface TenderlyEnv {
  accessKey: string;
  account: string;
  project: string;
}

export interface Vnet {
  containerId: string;
  vnetId: string;
  adminRpc: string;
  publicRpc?: string;
}

export function requireEnv(): TenderlyEnv {
  const { TENDERLY_ACCESS_KEY, TENDERLY_ACCOUNT, TENDERLY_PROJECT } = process.env;
  for (const [k, v] of Object.entries({ TENDERLY_ACCESS_KEY, TENDERLY_ACCOUNT, TENDERLY_PROJECT })) {
    if (!v) throw new Error(`Missing env ${k}. Copy .env.example -> .env at the repo root.`);
  }
  return { accessKey: TENDERLY_ACCESS_KEY!, account: TENDERLY_ACCOUNT!, project: TENDERLY_PROJECT! };
}

/** An environment as the public environments endpoint returns it (create and get). */
interface RawEnvironment {
  id: string;
  active_instance?: { vnets?: Array<{ id: string; rpcs?: Array<{ name: string; url: string }> }> };
}

/** The environment's first network with its Admin and Public RPC. */
function vnetFrom(data: RawEnvironment): Vnet {
  const vnet = data.active_instance?.vnets?.[0];
  const rpcs = vnet?.rpcs ?? [];
  const admin = rpcs.find((r) => /^admin rpc$/i.test(r.name)) ?? rpcs.find((r) => /admin/i.test(r.name)) ?? rpcs[0];
  const pub = rpcs.find((r) => /^public rpc$/i.test(r.name));
  if (!admin?.url) throw new Error(`no RPC in vnet response: ${JSON.stringify(data).slice(0, 400)}`);
  return { containerId: data.id, vnetId: vnet!.id, adminRpc: admin.url, publicRpc: pub?.url };
}

/** Create a Virtual Environment forking Ethereum mainnet at `blockNumber` ("latest" allowed). */
export async function createVnet(env: TenderlyEnv, displayName: string, blockNumber: string | number): Promise<Vnet> {
  const res = await fetch(`${API}/public/v1/account/${env.account}/project/${env.project}/environments`, {
    method: "POST",
    headers: { "X-Access-Key": env.accessKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      display_name: displayName,
      network_configs: [{
        network_id: "1",
        block_number: String(blockNumber),
        chain_config_overrides: { chain_id: "1" },
      }],
    }),
  });
  if (!res.ok) throw new Error(`create vnet failed: ${res.status} ${await res.text()}`);
  return vnetFrom((await res.json()) as RawEnvironment);
}

/**
 * Create a Virtual Environment forking Ethereum mainnet at latest with State Sync on,
 * so unmodified state keeps following the live network. State Sync is set per network
 * with `syncStateConfig`, which the camelCase environments endpoint (/api/v1/...)
 * accepts; the snake_case public one used by createVnet ignores it. The RPC URLs are
 * then read back through the public endpoint, in the same shape createVnet gets.
 */
export async function createVnetWithStateSync(env: TenderlyEnv, displayName: string): Promise<Vnet> {
  const res = await fetch(`${API}/v1/account/${env.account}/project/${env.project}/environments`, {
    method: "POST",
    headers: { "X-Access-Key": env.accessKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      displayName,
      networkConfigs: [{
        networkId: "1",
        blockNumber: "latest",
        chainConfigOverrides: { chainId: "1" },
        syncStateConfig: { enabled: true, commitmentLevel: "latest" },
      }],
    }),
  });
  if (!res.ok) throw new Error(`create environment (state sync) failed: ${res.status} ${await res.text()}`);
  const { id } = (await res.json()) as { id: string };
  const detail = await fetch(`${API}/public/v1/account/${env.account}/project/${env.project}/environments/${id}`, {
    headers: { "X-Access-Key": env.accessKey },
  });
  if (!detail.ok) throw new Error(`read environment ${id} failed: ${detail.status} ${await detail.text()}`);
  return vnetFrom((await detail.json()) as RawEnvironment);
}

export const providerFor = (rpcUrl: string): JsonRpcProvider =>
  new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });

/** Dashboard page for a Virtual Environment — takes the vnet id (`Vnet.vnetId`),
 *  NOT the environment/container id: the `/testnet/…` route 404s on the latter. */
export const vnetDashboardUrl = (env: TenderlyEnv, vnetId: string): string =>
  `https://dashboard.tenderly.co/${env.account}/${env.project}/testnet/${vnetId}`;

// ---- console styling ---------------------------------------------------------
export const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
export const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
export const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
export const yellow = (s: string): string => `\x1b[33m${s}\x1b[0m`;
export const section = (t: string): void => console.log(`\n${bold(`▸ ${t}`)}`);
