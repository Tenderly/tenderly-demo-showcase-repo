// Example 04: create an environment for a pull request, then run example 02's suite against it in a child process.
// npm run ci -- --pr 4217. Nothing deletes the environment. A suite that stops before its RESULT line fails the run.
// In GitHub Actions it masks both RPC URLs before any other output and appends the links to the job summary.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import chalk from "chalk";
import * as log from "./lib/log.js";
import { createEnvironment, credentials, environmentUrl, providerFor, runSlug, transactionsUrl } from "./lib/tenderly.js";

const SUITE = resolve(dirname(fileURLToPath(import.meta.url)), "../02-automation-tests");
const GITHUB = process.env.GITHUB_ACTIONS === "true";

/** How an npm command in ../02-automation-tests ended, the verdict of its RESULT line and its first error line. */
interface Ended {
  code: number | null;
  signal: NodeJS.Signals | null;
  verdict?: "PASS" | "FAIL";
  error?: string;
}

/** Pass a child's output on line by line, redacted, and give watch() each line without colors. */
function relay(from: Readable, to: Writable, watch: (line: string) => void): void {
  let rest = "";
  const pass = (line: string, end: string): void => {
    to.write(log.redact(line) + end);
    watch(line.replace(/\x1b\[[0-9;]*m|\r$/g, ""));
  };
  from.setEncoding("utf8");
  from.on("data", (chunk: string) => {
    const lines = (rest + chunk).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) pass(line, "\n");
  });
  from.on("end", () => rest && pass(rest, ""));
}

/** npm <args> in ../02-automation-tests, with its output streamed through this process. */
function npm(args: string, env: NodeJS.ProcessEnv): Promise<Ended> {
  return new Promise((done, failed) => {
    // A fixed command line through a shell, because Windows starts npm (npm.cmd) only through one.
    const child = spawn(`npm ${args}`, { cwd: SUITE, env, shell: true, stdio: ["inherit", "pipe", "pipe"] });
    const seen: Pick<Ended, "verdict" | "error"> = {};
    relay(child.stdout, process.stdout, (line) => {
      const result = /^RESULT\s+(PASS|FAIL)\b/.exec(line);
      if (result) seen.verdict = result[1] as "PASS" | "FAIL";
    });
    relay(child.stderr, process.stderr, (line) => {
      if (!seen.error && /^\w*Error\b/.test(line)) seen.error = line;
    });
    child.on("error", failed);
    child.on("close", (code, signal) => done({ code, signal, ...seen }));
  });
}

const ended = (e: Ended): string => (e.signal ? `stopped by ${e.signal}` : `exited with ${e.code}`);

/** Shorten a Node error line to its message, with paths relative to ../02-automation-tests, in 81 characters. */
function reason(line: string): string {
  const message = (line.replace(/^\w*Error(?: \[\w+\])?: /, "") || line)
    .split(`${pathToFileURL(SUITE).href}/`).join("")
    .split(`${SUITE}${sep}`).join("");
  const safe = log.redact(message);
  return safe.length <= 81 ? safe : `${safe.slice(0, 80)}…`;
}

async function main(): Promise<number> {
  const { pr } = parseArgs({ options: { pr: { type: "string" } } }).values;
  if (pr !== undefined && !/^\d+$/.test(pr)) throw new Error(`--pr takes a pull request number, not "${pr}"`);
  if (!existsSync(resolve(SUITE, "package.json"))) throw new Error("example 02 is missing: 04 runs ../02-automation-tests");
  const c = credentials();
  const e = await createEnvironment(c, {
    displayName: pr ? `Acme Treasury CI PR ${pr}` : "Acme Treasury CI local",
    slug: runSlug(`acme-ci-${pr ?? "local"}`),
    networks: [{ networkId: 1, chainId: 73571 }],
  });
  const n = e.networks[0];
  // GitHub workflow commands, not log lines. From here on the job log hides both URLs, also in the suite's output.
  if (GITHUB) process.stdout.write(`::add-mask::${n.adminRpc}\n::add-mask::${n.publicRpc}\n`);

  const links = [["environment", environmentUrl(c, e)], ["transactions", transactionsUrl(c, e)]] as const;
  const summary = (pass: boolean): void => {
    const file = process.env.GITHUB_STEP_SUMMARY;
    if (!GITHUB || !file) return;
    const lines = [
      `### ${e.displayName}: ${pass ? "PASS" : "FAIL"}`,
      "",
      `Example 02's settlement suite on \`${e.slug}\`, chain id ${n.chainId}. The links need a login to the Tenderly project.`,
      "",
      ...links.map(([label, url]) => `- [${label}](${url})`),
    ];
    appendFileSync(file, `${lines.join("\n")}\n`);
  };
  /** Print [FAIL] with where and why, the links and RESULT FAIL, for a suite that gave no verdict of its own. */
  const stop = (failure: string, detail: string | undefined, verdict: string): number => {
    log.fail(failure);
    if (detail) log.sub(detail);
    log.blank();
    for (const [label, url] of links) log.link(label, url);
    return log.result(false, verdict);
  };

  log.run("CI run", `${pr ? `PR ${pr}` : "Local run"}: a new environment, then example 02's suite against it`, 2);
  log.step("Create environment");
  let where = "Public RPC";
  let code: number;
  try {
    const block = await providerFor(n.publicRpc, n.chainId).getBlockNumber();
    log.ok(`environment ${e.slug}, block ${block.toLocaleString("en-US")}, chain id ${n.chainId}`);

    log.step("Run example 02's suite");
    const env = {
      ...process.env,
      // The suite writes to a pipe, where its chalk would drop the colors this terminal shows.
      ...(process.stdout.isTTY && chalk.level > 0 ? { FORCE_COLOR: String(chalk.level) } : {}),
      TENDERLY_ADMIN_RPC_URL_1: n.adminRpc,
      TENDERLY_PUBLIC_RPC_URL_1: n.publicRpc,
      TENDERLY_ENVIRONMENT_ID: e.id,
      TENDERLY_INSTANCE_ID: e.instanceId,
      TENDERLY_VNET_ID_1: n.vnetId,
    };
    if (!existsSync(resolve(SUITE, "node_modules"))) {
      where = "npm install in ../02-automation-tests";
      log.wait(where);
      const install = await npm("install --no-audit --no-fund", env);
      if (install.code !== 0) throw new Error(ended(install));
    }
    where = "npm test in ../02-automation-tests";
    log.note(`${where} against this environment`);
    log.blank();
    const suite = await npm("test --silent", env);
    if (suite.verdict === "FAIL") code = suite.code || 1; // the suite printed its [FAIL] lines, links and RESULT line
    else if (suite.verdict === "PASS" && suite.code === 0) code = 0;
    else {
      // No RESULT line (a crash on import, say), or a PASS that the exit code contradicts.
      log.blank();
      const what = suite.verdict ? `after RESULT ${suite.verdict}` : "before its RESULT line";
      const verdict = suite.verdict ? `example 02's suite ${ended(suite)}` : "example 02's suite did not finish";
      code = stop(`${where}: ${ended(suite)} ${what}`, suite.error && reason(suite.error), verdict);
    }
  } catch (err) {
    const failure = err as { error?: { message?: string }; shortMessage?: string; message?: string };
    const why = (failure.error?.message ?? failure.shortMessage ?? failure.message ?? String(err)).split("\n")[0];
    code = stop(`${where}: ${why}`, undefined, "example 02's suite did not run");
  }
  summary(code === 0);
  return code;
}

main().then(
  (code) => (process.exitCode = code),
  (err) => (process.exitCode = log.fatal(err)),
);
