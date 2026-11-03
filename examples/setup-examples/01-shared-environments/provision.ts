// Create or reuse the Virtual Environment of one stage (dev, qa or uat), found by its slug acme-treasury-<stage>.
// tenderly_setBalance gives both team wallets 100 ETH in a new environment. RPC URLs go to out/<stage>.json only.
// --fresh creates another environment with a unique slug; the stage slug still finds the old one.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { formatEther, parseEther } from "ethers";
import * as log from "./lib/log.js";
import {
  ApiError, createEnvironment, credentials, environmentUrl, findEnvironment, providerFor, runSlug, setBalance,
  transactionsUrl, type Credentials, type Environment,
} from "./lib/tenderly.js";

const STAGES = ["dev", "qa", "uat"];
const TEAM = ["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222"];
const FUNDING = parseEther("100");
const ETHEREUM = { networkId: 1, chainId: 73571 }; // no block: the latest one
const USAGE = "Usage: npm run provision -- --env <dev|qa|uat> [--fresh]";
const WIDTH = 81; // text on a [FAIL] line or under it: 90 characters minus the 9 of "  [FAIL] "

const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
const eth = (wei: bigint): string =>
  `${Number(formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: 4 })} ETH`;

function parseFlags(argv: string[]): { stage: string; fresh: boolean } {
  let stage = "";
  let fresh = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--env") stage = argv[++i] ?? "";
    else if (arg.startsWith("--env=")) stage = arg.slice("--env=".length);
    else if (arg === "--fresh") fresh = true;
    else throw new Error(`unknown argument ${arg}\n${USAGE}`);
  }
  if (!STAGES.includes(stage)) throw new Error(`--env must be dev, qa or uat${stage ? `, not ${stage}` : ""}\n${USAGE}`);
  return { stage, fresh };
}

/** The JSON-RPC error message, ethers' short message, or the message. */
function why(err: unknown): string {
  const e = err as { error?: { message?: string }; shortMessage?: string; message?: string } | undefined;
  return e?.error?.message ?? e?.shortMessage ?? e?.message ?? String(err);
}

/** The [FAIL] line, wrapped onto lines under it. Redacted first, so splitting a long word can't break a mask. */
function fail(msg: string): void {
  const words = log.redact(msg).split(/\s+/).flatMap((w) => w.match(new RegExp(`.{1,${WIDTH}}`, "g")) ?? []);
  const lines = [""];
  for (const word of words) {
    const last = lines[lines.length - 1];
    if (last && last.length + 1 + word.length > WIDTH) lines.push(word);
    else lines[lines.length - 1] = last ? `${last} ${word}` : word;
  }
  log.fail(lines[0]);
  for (const rest of lines.slice(1)) log.sub(rest);
}

/**
 * Create the environment. HTTP 409 on a stage slug means someone created it after the lookup, so reuse theirs.
 * --fresh asked for a new environment, so there a taken slug is a failure.
 */
async function create(
  c: Credentials, slug: string, displayName: string, fresh: boolean,
): Promise<{ env: Environment; created: boolean }> {
  try {
    return { env: await createEnvironment(c, { displayName, slug, networks: [ETHEREUM] }), created: true };
  } catch (err) {
    const theirs = !fresh && err instanceof ApiError && err.status === 409 ? await findEnvironment(c, slug) : null;
    if (!theirs) throw err;
    return { env: theirs, created: false };
  }
}

/** out/<name>.json holds the RPC URLs (credentials, so not in the log), the ids and the links. */
function writeOut(c: Credentials, name: string, e: Environment): string {
  const n = e.networks[0];
  const dir = join(dirname(fileURLToPath(import.meta.url)), "out");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.json`);
  const out = {
    slug: e.slug,
    environmentId: e.id,
    instanceId: e.instanceId,
    vnetId: n.vnetId,
    chainId: n.chainId,
    forkBlock: n.forkBlock,
    publicRpc: n.publicRpc,
    adminRpc: n.adminRpc,
    links: { environment: environmentUrl(c, e), transactions: transactionsUrl(c, e) },
  };
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  return relative(process.cwd(), path);
}

function links(c: Credentials, e: Environment): void {
  log.link("environment", environmentUrl(c, e));
  log.link("transactions", transactionsUrl(c, e));
}

async function main(): Promise<number> {
  const { stage, fresh } = parseFlags(process.argv.slice(2));
  const c = credentials();
  const stageSlug = `acme-treasury-${stage}`;
  const slug = fresh ? runSlug(stageSlug) : stageSlug;
  const name = slug.slice("acme-treasury-".length); // qa, or qa-20261028-152839 with --fresh
  const displayName = `Acme Treasury ${stage.toUpperCase()}${fresh ? ` ${name.slice(stage.length + 1)}` : ""}`;

  const subtitle = fresh ? "a new environment (--fresh)" : "an Ethereum fork the team shares";
  log.run("Shared environments", `${stage} stage, ${subtitle}`, 2);
  let env: Environment | undefined;
  let doing = `look up ${stageSlug}`;
  try {
    log.step(fresh ? "Create the environment" : "Find or create the environment");
    const old = await findEnvironment(c, stageSlug);
    if (fresh || !old) doing = `create ${slug}`;
    const { env: e, created } = old && !fresh
      ? { env: old, created: false }
      : await create(c, slug, displayName, fresh);
    env = e;
    const n = e.networks[0];
    if (!n.forkBlock) throw new Error("the API returned no fork block");
    doing = "check the Public RPC";
    const pub = providerFor(n.publicRpc, n.chainId);
    const served = Number(await pub.send("eth_chainId", []));
    if (served !== n.chainId) throw new Error(`it serves chain id ${served}, the API says ${n.chainId}`);
    // --fresh always creates, and the time in its slug leaves no room for "created " within 90 characters.
    const what = fresh ? "" : created ? "created " : "reused ";
    log.ok(`${what}environment ${e.slug}, block ${n.forkBlock.toLocaleString("en-US")}, chain id ${n.chainId}`);
    if (fresh) {
      log.note(old ? `runs without --fresh still reuse ${stageSlug}`
        : `no ${stageSlug} yet, so a run without --fresh creates it`);
    }

    log.step("Team wallets");
    const both = TEAM.map(short).join(" and ");
    doing = created ? `set the team wallets to ${eth(FUNDING)}` : "read the team wallets";
    if (created) await setBalance(providerFor(n.adminRpc, n.chainId), TEAM, FUNDING);
    const balances = await Promise.all(TEAM.map((a) => pub.getBalance(a)));
    if (created) {
      // The amount printed is the amount on chain.
      const i = balances.findIndex((b) => b !== FUNDING);
      if (i >= 0) throw new Error(`${short(TEAM[i])} has ${eth(balances[i])}`);
      log.ok(`tenderly_setBalance: ${both} set to ${eth(FUNDING)} each`);
    } else if (balances.every((b) => b === FUNDING)) {
      log.ok(`${both} have ${eth(FUNDING)} each, set when it was created`);
    } else {
      // A reuse never resets them, so print what each one holds now.
      log.ok(TEAM.map((a, i) => `${short(a)} has ${eth(balances[i])}`).join(", "));
    }

    doing = `write out/${name}.json`;
    const file = writeOut(c, name, e);
    log.blank();
    log.file(file, "Public RPC for the app, Admin RPC for cheat codes");
    links(c, e);
    return log.result(true, `${e.slug} ${created ? "created" : "reused"}`);
  } catch (err) {
    fail(`${doing}: ${why(err)}`);
    if (env) {
      log.blank();
      links(c, env);
    }
    return log.result(false, "environment not ready");
  }
}

main().then((code) => process.exit(code), (err) => process.exit(log.fatal(err)));
