// npm run create: fork Ethereum for an indexer and write the RPC URLs and links to out/environment.json.
// Default: Create Environment from the API reference, at FORK_BLOCK or the latest block.
// STATE_SYNC=true: a VNet with State Sync on, through POST /api/v1/.../vnets (docs guide, not the API reference).
import * as log from "./lib/log.js";
import {
  createEnvironment, credentials, environmentUrl, providerFor, runSlug, transactionsUrl, type Environment,
} from "./lib/tenderly.js";
import { envBlock, envFlag, num, reason, wrapped } from "./lib/run.js";
import { createStateSyncEnvironment, environmentFilePath, printLinks, writeEnvironmentFile } from "./lib/vnet.js";

const NETWORK_ID = 1; // Ethereum
const CHAIN_ID = 1; // 05 keeps Ethereum's chain id (see the root README); the other examples use 73571

async function main(): Promise<number> {
  const stateSync = envFlag("STATE_SYNC");
  const forkBlock = envBlock("FORK_BLOCK");
  if (stateSync && forkBlock !== undefined) {
    throw new Error("FORK_BLOCK doesn't apply with STATE_SYNC=true, which forks at the latest block");
  }
  const c = credentials();
  const at = forkBlock === undefined ? "the latest block" : `block ${num(forkBlock)}`;
  log.run("Auto-mine for indexing", `Ethereum fork at ${at}, State Sync ${stateSync ? "on" : "off"}`, 1);
  log.step("Create the environment");

  const links: Record<string, string> = {};
  try {
    const slug = runSlug(stateSync ? "auto-mine-indexing-sync" : "auto-mine-indexing");
    const displayName = `Auto-mine for indexing${stateSync ? ", State Sync" : ""}`;
    let e: Environment;
    let syncOn = false;
    if (stateSync) {
      const created = await createStateSyncEnvironment(c, { slug, displayName, networkId: NETWORK_ID, chainId: CHAIN_ID });
      e = created.env;
      syncOn = created.stateSync;
    } else {
      const networks = [{ networkId: NETWORK_ID, chainId: CHAIN_ID, block: forkBlock }];
      e = await createEnvironment(c, { displayName, slug, networks });
    }
    links.environment = environmentUrl(c, e);
    links.transactions = transactionsUrl(c, e);
    if (stateSync && !syncOn) throw new Error(`${e.slug} came back with State Sync off`);
    const n = e.networks[0];
    const p = providerFor(n.adminRpc, CHAIN_ID);
    const [head, chainHex] = await Promise.all([p.getBlockNumber(), p.send("eth_chainId", []) as Promise<string>]);
    const chainId = Number(chainHex);
    if (chainId !== CHAIN_ID) throw new Error(`the RPC reports chain id ${chainId}, not ${CHAIN_ID}`);
    if (forkBlock !== undefined && head !== forkBlock) {
      throw new Error(`the head is block ${num(head)}, not FORK_BLOCK ${num(forkBlock)}`);
    }
    writeEnvironmentFile({
      name: e.slug, stateSync, networkId: NETWORK_ID, chainId, forkBlock: head, environmentId: e.id,
      instanceId: e.instanceId, vnetId: n.vnetId, adminRpc: n.adminRpc, publicRpc: n.publicRpc, links,
      createdAt: new Date().toISOString(),
    });
    log.ok(`environment ${e.slug}, block ${num(head)}, chain id ${chainId}`);
    if (stateSync) log.ok("State Sync on: contracts you haven't changed read Ethereum's latest state");
  } catch (err) {
    wrapped(log.fail, `create: ${reason(err)}`);
    if (links.environment) {
      log.blank();
      printLinks(links);
    }
    return log.result(false, links.environment ? `${environmentFilePath()} not written` : "no environment");
  }

  log.blank();
  log.file(environmentFilePath(), "Admin RPC for npm run mine, Public RPC for the indexer");
  printLinks(links);
  return log.result(true, "environment ready, next: npm run mine");
}

main().then((code) => process.exit(code), (err) => process.exit(log.fatal(err)));
