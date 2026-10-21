#!/usr/bin/env tsx
/**
 * Provision (or reuse) the shared Virtual Environment for one higher environment.
 *
 *   npm run provision -- --env qa        # create or reuse the QA Environment
 *   npm run provision -- --env uat --fresh   # always create a new one
 *
 * This is the command a platform/QA engineer runs to stand up a dev/qa/uat
 * environment that the whole full-stack team then shares:
 *   - UI + backend point at the PUBLIC RPC (standard JSON-RPC, no privileges).
 *   - QA / automated tests use the ADMIN RPC (cheat codes seed deterministic state).
 *   - Smart-contract devs deploy + verify against the same fork.
 *   - PMs open the dashboard explorer link to watch flows without a wallet.
 *
 * The Environment is keyed by env name, so re-running reuses the same RPC URLs — a
 * long-lived staging environment, not a throwaway.
 */
import { provisionTestNet, fundNative, type TestNet } from "./lib/testnet.js";

// Fixed team test wallets that live in every environment (impersonated, no keys).
const TEAM = {
  treasuryOps: "0x1111111111111111111111111111111111111111", // initiates settlements
  counterparty: "0x2222222222222222222222222222222222222222", // receives settlements
} as const;

function parseArgs(argv: string[]): { env: string; fresh: boolean } {
  let env = "dev";
  let fresh = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env") env = argv[++i] ?? env;
    else if (argv[i] === "--fresh") fresh = true;
  }
  return { env, fresh };
}

function report(tn: TestNet): void {
  console.log(`\n${tn.reused ? "Reusing" : "Created"} Virtual Environment: ${tn.displayName}`);
  console.log(`  slug          : ${tn.slug}`);
  console.log(`  virtual chain : ${tn.chainId}  (forked from network ${tn.networkId})`);
  console.log(`  dashboard     : ${tn.dashboardUrl}\n`);
  console.log("  Public RPC  (UI / backend, standard JSON-RPC):");
  console.log(`    ${tn.publicRpc}`);
  console.log("  Admin RPC   (QA / tests, cheat codes enabled):");
  console.log(`    ${tn.adminRpc}\n`);
  console.log("  Wire your app to the public RPC:");
  console.log(`    export RPC_URL=${tn.publicRpc}`);
  console.log("  Point the automated suite at the admin RPC:");
  console.log(`    export TENDERLY_ADMIN_RPC=${tn.adminRpc}`);
}

async function main(): Promise<void> {
  const { env, fresh } = parseArgs(process.argv.slice(2));
  console.log(`Provisioning the "${env}" environment as a Tenderly Virtual Environment ...`);

  const tn = await provisionTestNet({ env, explorer: true, reuse: !fresh });

  // Seed gas for the shared team wallets so any developer can transact immediately.
  await fundNative(tn.adminRpc, Object.values(TEAM));
  console.log(`Funded ${Object.keys(TEAM).length} shared team wallets with gas (tenderly_setBalance).`);

  report(tn);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
