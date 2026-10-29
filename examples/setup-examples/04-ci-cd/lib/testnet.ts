/**
 * Virtual Environment provisioning library.
 *
 * One place to create-or-reuse a named, persistent Tenderly Virtual Environment per
 * higher environment (dev / qa / uat) and to drive the Admin-RPC cheat codes a
 * full-stack team needs to seed deterministic test state.
 *
 * Each example folder ships its own copy of this library so it runs on its own
 * (`cd` in, `npm install`, run). All copies read the one shared config, the repo
 * root `.env` (TENDERLY_ACCESS_KEY / TENDERLY_ACCOUNT / TENDERLY_PROJECT).
 *
 * REST surface (Virtual Environments public API, X-Access-Key auth):
 *   POST   /account/{acct}/project/{proj}/environments         create
 *   GET    /account/{acct}/project/{proj}/environments         list (reuse lookup)
 *   GET    /account/{acct}/project/{proj}/environments/{id}     detail (RPC URLs)
 *   DELETE /account/{acct}/project/{proj}/environments         batch delete
 */
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { JsonRpcProvider } from "ethers";

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

const API = "https://api.tenderly.co/api/public/v1";
const DASHBOARD = "https://dashboard.tenderly.co";

/** A network to include in a (single- or multi-chain) Virtual Environment. */
export interface NetworkSpec {
  /** Public network id to fork, e.g. 1 (Ethereum), 8453 (Base). */
  networkId: number;
  /** Fork point: "latest" (default) or a hex block number. */
  blockNumber?: string;
  /** Virtual chain id. Defaults to `${chainIdPrefix}${networkId}` (anti-replay). */
  chainId?: number;
}

/** Resolved RPC endpoints for one network inside a Virtual Environment. */
export interface RpcEndpoints {
  networkId: number;
  chainId: number;
  /** Standard JSON-RPC — what the UI and backend point at. No cheat codes. */
  publicRpc: string;
  /** Privileged JSON-RPC — cheat codes (set balances, impersonate, override). */
  adminRpc: string;
}

/** A provisioned Virtual Environment. Convenience fields mirror the first network. */
export interface TestNet {
  id: string;
  slug: string;
  displayName: string;
  /** Dashboard page for this TestNet (Transactions / Contracts / explorer view). */
  dashboardUrl: string;
  /** Per-network RPC endpoints (one entry per forked chain). */
  networks: RpcEndpoints[];
  /** True if an existing TestNet with this slug was reused, false if freshly created. */
  reused: boolean;
  // --- convenience accessors for the primary (first) network ---
  networkId: number;
  chainId: number;
  publicRpc: string;
  adminRpc: string;
}

export interface ProvisionOpts {
  /** Environment name: dev | qa | uat | <anything>. Drives the TestNet slug. */
  env: string;
  /** Networks to fork. Defaults to a single Ethereum-mainnet fork. */
  networks?: NetworkSpec[];
  /** Prefix used to derive each virtual chain id (Tenderly convention). Default 7357. */
  chainIdPrefix?: number;
  /** Enable the public block explorer for the TestNet. Default true. */
  explorer?: boolean;
  /** Enable the cross-chain bridge module (multichain only). Default false. */
  bridge?: boolean;
  /** Reuse an existing TestNet with the same slug instead of creating a new one. Default true. */
  reuse?: boolean;
}

function creds(): { key: string; account: string; project: string } {
  const { TENDERLY_ACCESS_KEY, TENDERLY_ACCOUNT, TENDERLY_PROJECT } = process.env;
  if (!TENDERLY_ACCESS_KEY || !TENDERLY_ACCOUNT || !TENDERLY_PROJECT) {
    throw new Error(
      "Missing Tenderly credentials. Copy .env.example -> .env at the repo root and set " +
        "TENDERLY_ACCESS_KEY / TENDERLY_ACCOUNT / TENDERLY_PROJECT.",
    );
  }
  return { key: TENDERLY_ACCESS_KEY, account: TENDERLY_ACCOUNT, project: TENDERLY_PROJECT };
}

function headers(key: string): Record<string, string> {
  return { "X-Access-Key": key, "Content-Type": "application/json" };
}

const slugFor = (env: string): string => `acme-treasury-${env.toLowerCase()}`;
const virtualChainId = (prefix: number, networkId: number): number => Number(`${prefix}${networkId}`);

/** Shape of one network entry inside an environment detail response. */
interface RawVnet {
  fork_config?: { network_id?: number };
  virtual_network_config?: { chain_config?: { chain_id?: number } };
  rpcs?: Array<{ name: string; url: string }>;
}
interface RawEnv {
  id: string;
  slug: string;
  display_name: string;
  active_instance?: { id?: string; vnets?: RawVnet[] };
}

function endpointsFromEnv(env: RawEnv): RpcEndpoints[] {
  const vnets = env.active_instance?.vnets ?? [];
  return vnets.map((v) => {
    const rpcs = v.rpcs ?? [];
    const pick = (n: string): string =>
      rpcs.find((r) => r.name === n)?.url ??
      rpcs.find((r) => new RegExp(n.split(" ")[0], "i").test(r.name) && !/websocket/i.test(r.name))?.url ??
      "";
    return {
      networkId: Number(v.fork_config?.network_id ?? 0),
      chainId: Number(v.virtual_network_config?.chain_config?.chain_id ?? 0),
      publicRpc: pick("Public RPC"),
      adminRpc: pick("Admin RPC"),
    };
  });
}

function toTestNet(env: RawEnv, account: string, project: string, reused: boolean): TestNet {
  const networks = endpointsFromEnv(env);
  if (networks.length === 0 || !networks[0].adminRpc) {
    throw new Error(`No RPC endpoints in environment ${env.id}: ${JSON.stringify(env).slice(0, 400)}`);
  }
  const first = networks[0];
  // The environment's dashboard page is /testnets/{environment id}/instance/{instance id}.
  return {
    id: env.id,
    slug: env.slug,
    displayName: env.display_name,
    dashboardUrl: `${DASHBOARD}/${account}/${project}/testnets/${env.id}/instance/${env.active_instance?.id ?? ""}`,
    networks,
    reused,
    networkId: first.networkId,
    chainId: first.chainId,
    publicRpc: first.publicRpc,
    adminRpc: first.adminRpc,
  };
}

/** Every environment in the project, newest first. The list is paged, 100 per page. */
async function listEnvironments(): Promise<RawEnv[]> {
  const { key, account, project } = creds();
  const all: RawEnv[] = [];
  for (let page = 1; ; page++) {
    const res = await fetch(
      `${API}/account/${account}/project/${project}/environments?page=${page}&per_page=100`,
      { headers: headers(key) },
    );
    if (!res.ok) throw new Error(`list environments failed: ${res.status} ${await res.text()}`);
    const batch = (await res.json()) as RawEnv[];
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

async function getEnvironment(id: string): Promise<RawEnv> {
  const { key, account, project } = creds();
  const res = await fetch(`${API}/account/${account}/project/${project}/environments/${id}`, {
    headers: headers(key),
  });
  if (!res.ok) throw new Error(`get environment failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as RawEnv;
}

/**
 * Create-or-reuse the persistent Virtual Environment for an environment (dev/qa/uat).
 * Idempotent on the slug `acme-treasury-<env>`: the whole team keeps the same
 * RPC URLs across runs, exactly like a long-lived staging environment.
 */
export async function provisionTestNet(opts: ProvisionOpts): Promise<TestNet> {
  const { key, account, project } = creds();
  const prefix = opts.chainIdPrefix ?? 7357;
  const explorer = opts.explorer ?? true;
  const reuse = opts.reuse ?? true;
  const networks = opts.networks ?? [{ networkId: 1 }];
  const slug = slugFor(opts.env);

  if (reuse) {
    const existing = (await listEnvironments()).find((e) => e.slug === slug);
    if (existing) return toTestNet(await getEnvironment(existing.id), account, project, true);
  }

  const body: Record<string, unknown> = {
    display_name: `Acme Treasury — ${opts.env.toUpperCase()}`,
    slug,
    description: `Shared ${opts.env} environment for the Acme treasury/settlement app — a Tenderly Virtual Environment.`,
    network_configs: networks.map((n) => ({
      network_id: String(n.networkId),
      block_number: n.blockNumber ?? "latest",
      chain_config_overrides: { chain_id: String(n.chainId ?? virtualChainId(prefix, n.networkId)) },
      explorer_config: { enabled: explorer, contract_verification_visibility: "src" },
    })),
  };
  if (opts.bridge) body.bridge_config = { enabled: true, relay_mode: "autoRelay", delay_seconds: 0 };

  const res = await fetch(`${API}/account/${account}/project/${project}/environments`, {
    method: "POST",
    headers: headers(key),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`create environment failed: ${res.status} ${await res.text()}`);
  return toTestNet((await res.json()) as RawEnv, account, project, false);
}

/** Delete one or more Virtual Environments by id (batch). Used for CI cleanup. */
export async function deleteTestNets(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { key, account, project } = creds();
  const res = await fetch(`${API}/account/${account}/project/${project}/environments`, {
    method: "DELETE",
    headers: headers(key),
    body: JSON.stringify({ environment_ids: ids }),
  });
  if (!res.ok) throw new Error(`delete environments failed: ${res.status} ${await res.text()}`);
}

// ---- Admin-RPC cheat codes (QA seeding) ------------------------------------

/** Set a native-token (ETH) balance for gas. `wei` is hex. Default 100 ETH. */
export async function fundNative(
  adminRpc: string,
  addresses: string[],
  wei = "0x56BC75E2D63100000",
): Promise<void> {
  if (addresses.length === 0) return;
  const provider = new JsonRpcProvider(adminRpc);
  await provider.send("tenderly_setBalance", [addresses, wei]);
}

/** Mint an ERC-20 balance to a holder with no transfer or approval. `amount` is hex. */
export async function setErc20Balance(
  adminRpc: string,
  token: string,
  holder: string,
  amount: string,
): Promise<void> {
  const provider = new JsonRpcProvider(adminRpc);
  await provider.send("tenderly_setErc20Balance", [token, holder, amount]);
}
