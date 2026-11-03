// An agent plans seven intents on a fork of Ethereum. It checks each one against four rules and a dry run with
// tenderly_simulateBundle, and sends it only when both pass. RESULT PASS when every intent gets its expected outcome.
// The rules and the reads behind them are in lib/gate.ts.
import { dataSlice, getAddress, id, type JsonRpcProvider } from "ethers";
import * as log from "./lib/log.js";
import {
  createEnvironment, credentials, environmentUrl, providerFor, runSlug, sendAs, setErc20Balance, simulateBundle,
  transactionsUrl, txUrl, type Credentials, type Environment,
} from "./lib/tenderly.js";
import {
  BTC_USD, MARKET, MORPHO, STEAKUSDC, TORNADO_ROUTER, USDC, WBTC, WBTC_BTC, balanceOf, calls, checkRules, feedAnswer, fmtPct,
  fmtPpm, fmtUsdc, fmtWbtc, ltvOf, marketState, oracleGap, oraclePrice, position, restoreFeed, revertReason, setFeedAnswer,
  shortAddr, usdc, usdcPerWbtc, wbtc, wbtcBtcSlot, type Call, type Decision, type FeedSlot, type Intent, type RuleName,
  type Rules,
} from "./lib/gate.js";

const BLOCK = 26_242_540;
/**
 * The agent's wallet: an address with no history on Ethereum. Cheat codes fund it, sends impersonate it (no key) at
 * gas price 0, so it needs no ETH.
 */
const AGENT = getAddress(dataSlice(id("policy-gate agent"), 12));
const START = { usdc: usdc(1_500_000), wbtc: wbtc(300) };
const RULES: Rules = { screened: [TORNADO_ROUTER], supplyCap: usdc(1_000_000), maxLtv: 774_000n, maxOracleGap: 20_000n };
/** The WBTC/BTC answer intent 7 runs with: 0.85 (8 decimals), a WBTC depeg. */
const DEPEG = 85_000_000n;

interface Planned {
  intent: Intent;
  expect: { rules: RuleName | "pass"; simulation: "ok" | "reverts" };
  /** Run this intent with the WBTC/BTC feed at DEPEG, then put the feed back. */
  depeg?: boolean;
}

const PLAN: Planned[] = [
  { intent: { kind: "deposit", amount: usdc(250_000), receiver: AGENT }, expect: { rules: "pass", simulation: "ok" } },
  { intent: { kind: "deposit", amount: usdc(100_000), receiver: TORNADO_ROUTER }, expect: { rules: "screening", simulation: "ok" } },
  { intent: { kind: "deposit", amount: usdc(900_000), receiver: AGENT }, expect: { rules: "supply cap", simulation: "ok" } },
  { intent: { kind: "borrow", collateral: wbtc(100), amount: usdc(3_600_000) }, expect: { rules: "pass", simulation: "ok" } },
  { intent: { kind: "borrow", collateral: 0n, amount: usdc(3_200_000) }, expect: { rules: "LTV buffer", simulation: "ok" } },
  { intent: { kind: "borrow", collateral: wbtc(200), amount: usdc(12_000_000) }, expect: { rules: "pass", simulation: "reverts" } },
  { intent: { kind: "borrow", collateral: 0n, amount: usdc(500_000) }, expect: { rules: "oracle", simulation: "ok" }, depeg: true },
];

interface Outcome {
  n: number;
  planned: Planned;
  decision: Decision;
  simulation: "ok" | "reverts";
  /** The revert reason when the simulation reverts. */
  reason: string;
  /** Hashes of the transactions sent, empty when the intent was blocked. */
  sent: string[];
}

interface Sent {
  n: number;
  name: string;
  hash: string;
}

const label = (i: Intent): string =>
  i.kind === "deposit"
    ? `deposit ${fmtUsdc(i.amount)} USDC${i.receiver === AGENT ? "" : ` for ${shortAddr(i.receiver)}`}`
    : `${i.collateral > 0n ? `supply ${fmtWbtc(i.collateral)} WBTC, ` : ""}borrow ${fmtUsdc(i.amount)} USDC`;

/** The transactions an intent sends, each named for its link. */
function transactions(i: Intent): Array<Call & { name: string }> {
  if (i.kind === "deposit") return [{ ...calls.deposit(i.amount, i.receiver), name: "deposit" }];
  return [
    ...(i.collateral > 0n ? [{ ...calls.supplyCollateral(i.collateral, AGENT), name: "supply" }] : []),
    { ...calls.borrow(i.amount, AGENT, AGENT), name: "borrow" },
  ];
}

/** Check the rules, simulate the intent's transactions on the latest block, and send them only when both pass. */
async function gate(p: JsonRpcProvider, n: number, planned: Planned, deposited: bigint, sent: Sent[]): Promise<Outcome> {
  const decision = await checkRules(p, RULES, AGENT, planned.intent, deposited);
  const txs = transactions(planned.intent);
  const sims = await simulateBundle(p, txs.map((t) => ({ from: AGENT, to: t.to, data: t.data })));
  if (sims.length !== txs.length) throw new Error(`intent ${n}: ${sims.length} dry-run results for ${txs.length} transactions`);
  const failed = sims.find((s) => !s.ok);
  const outcome: Outcome = {
    n, planned, decision, simulation: failed ? "reverts" : "ok", reason: failed ? revertReason(failed.output) : "", sent: [],
  };
  if (decision.rule || failed) return outcome;
  for (const t of txs) {
    const { hash, receipt } = await sendAs(p, { from: AGENT, to: t.to, data: t.data });
    outcome.sent.push(hash);
    sent.push({ n, name: t.name, hash });
    if (receipt.status !== 1) throw new Error(`intent ${n}: ${t.name} ${log.short(hash)} reverted, its dry run was ok`);
  }
  return outcome;
}

/** One table row. Colors go on after padding, so the columns stay aligned. */
function row(cells: Array<[string, ((s: string) => string)?]>, widths: number[]): string {
  return cells
    .map(([text, color], i) => {
      const padded = i < widths.length ? text.padEnd(widths[i]) : text;
      return color ? color(text) + padded.slice(text.length) : padded;
    })
    .join("  ");
}

/** The outcome cell: "sent" (the hashes are in the links), or the number or revert reason that blocked the intent. */
function rowOf(o: Outcome, widths: number[]): string {
  const outcome = o.sent.length ? "sent" : o.decision.rule ? o.decision.detail : o.reason;
  return row(
    [
      [String(o.n)],
      [label(o.planned.intent)],
      [o.decision.rule ?? "pass", o.decision.rule ? log.bad : log.pass],
      [o.simulation, o.simulation === "ok" ? log.pass : log.bad],
      [outcome, o.sent.length ? log.pass : undefined],
    ],
    widths,
  );
}

const fmtFeed = (answer: bigint): string => (Number(answer) / 1e8).toLocaleString("en-US", { maximumFractionDigits: 5 });

/** After the last step: a blank line, then the links, each sent transaction named for what it does. */
function links(c: Credentials, env: Environment, sent: Sent[]): void {
  log.blank();
  log.link("environment", environmentUrl(c, env));
  log.link("transactions", transactionsUrl(c, env));
  for (const s of sent) log.link(`${s.name} tx`, txUrl(c, env, env.networks[0], s.hash));
}

/**
 * A [FAIL] line of at most 90 characters: the step, then the error's first line, redacted before it is cut so no part
 * of a secret is left. ethers keeps a node's own message in error.message and a short summary in shortMessage.
 */
function failLine(at: string, err: unknown): string {
  const e = err as { error?: { message?: unknown }; shortMessage?: unknown; message?: unknown } | undefined;
  const text = String(e?.error?.message ?? e?.shortMessage ?? e?.message ?? err).split("\n")[0];
  const msg = log.redact(`${at}: ${text}`);
  const room = 90 - "  [FAIL] ".length;
  return msg.length > room ? `${msg.slice(0, room - 1)}…` : msg;
}

async function main(): Promise<number> {
  const c = credentials();
  log.run("Policy gate", `steakUSDC and Morpho's WBTC/USDC market at block ${BLOCK.toLocaleString("en-US")}`, 3);
  let env: Environment | undefined;
  const sent: Sent[] = [];
  const outcomes: Outcome[] = [];
  let at = "";
  try {
    at = "Fork Ethereum";
    log.step(at);
    env = await createEnvironment(c, {
      displayName: "Policy gate",
      slug: runSlug("policy-gate"),
      networks: [{ networkId: 1, chainId: 73571, block: BLOCK }],
    });
    const net = env.networks[0];
    const p = providerFor(net.adminRpc, net.chainId);
    const head = await p.getBlockNumber();
    if (head !== BLOCK) throw new Error(`the environment starts at block ${head.toLocaleString("en-US")}`);
    log.ok(`environment ${env.slug}, block ${head.toLocaleString("en-US")}, chain id ${net.chainId}`);
    await setErc20Balance(p, USDC, AGENT, START.usdc);
    await setErc20Balance(p, WBTC, AGENT, START.wbtc);
    log.ok(`tenderly_setErc20Balance: agent ${shortAddr(AGENT)} holds ${fmtUsdc(START.usdc)} USDC and ${fmtWbtc(START.wbtc)} WBTC`);
    for (const call of [calls.approve(USDC, STEAKUSDC, START.usdc), calls.approve(WBTC, MORPHO, START.wbtc)]) {
      const { hash, receipt } = await sendAs(p, { from: AGENT, ...call, gas: 100_000 });
      if (receipt.status !== 1) throw new Error(`approve on ${shortAddr(call.to)} reverted in ${log.short(hash)}`);
    }
    log.ok(`approved steakUSDC for ${fmtUsdc(START.usdc)} USDC and Morpho for ${fmtWbtc(START.wbtc)} WBTC`);
    const [m, refPrice, btcUsd] = await Promise.all([marketState(p), oraclePrice(p), feedAnswer(p, BTC_USD)]);
    log.ok(`WBTC/USDC market: ${fmtUsdc(m.supply - m.borrow)} USDC free to borrow, oracle ${fmtUsdc(usdcPerWbtc(refPrice))} USDC per WBTC`);

    at = "Check, dry-run, send";
    log.step(at);
    const lltv = MARKET.lltv / 10n ** 12n; // parts per million
    log.rule("screening", `no sender or receiver on the list: ${shortAddr(TORNADO_ROUTER)} (Tornado Cash router)`);
    log.rule("supply cap", `deposits into steakUSDC: at most ${fmtUsdc(RULES.supplyCap)} USDC in total`);
    log.rule("LTV buffer", `borrows: position LTV at most ${fmtPpm(RULES.maxLtv)}, ` +
      `${fmtPct({ num: RULES.maxLtv, den: lltv })} of the ${fmtPpm(lltv)} liquidation LTV`);
    log.rule("oracle", `borrows: market oracle within ${fmtPpm(RULES.maxOracleGap)} of Chainlink BTC/USD ` +
      `(${fmtPct(oracleGap(refPrice, btcUsd))} apart now)`);
    log.rule("dry run", "tenderly_simulateBundle: none of the intent's transactions reverts");

    // Padded columns: #, intent, rules ("supply cap" is the longest), dry run ("reverts"). The outcome is last, unpadded.
    const widths = [1, Math.max(...PLAN.map((x) => label(x.intent).length)), 10, 7];
    log.note(row([["#"], ["intent"], ["rules"], ["dry run"], ["outcome"]], widths));
    let deposited = 0n;
    for (const [k, planned] of PLAN.entries()) {
      let feed: FeedSlot | undefined;
      try {
        if (planned.depeg) {
          feed = await wbtcBtcSlot(p);
          await setFeedAnswer(p, feed, DEPEG);
          const low = usdcPerWbtc(await oraclePrice(p));
          log.note(`   tenderly_setStorageAt: WBTC/BTC feed set to ${fmtFeed(DEPEG)}, oracle ${fmtUsdc(low)} USDC per WBTC`);
        }
        const o = await gate(p, k + 1, planned, deposited, sent);
        if (o.sent.length && planned.intent.kind === "deposit") deposited += planned.intent.amount;
        outcomes.push(o);
        log.line(rowOf(o, widths));
      } finally {
        if (feed) {
          await restoreFeed(p, feed);
          const back = await oraclePrice(p);
          if (back !== refPrice) {
            throw new Error(`feed put back, oracle at ${fmtUsdc(usdcPerWbtc(back))} USDC per WBTC, not ${fmtUsdc(usdcPerWbtc(refPrice))}`);
          }
          log.note(`   WBTC/BTC feed back to ${fmtFeed(await feedAnswer(p, WBTC_BTC))}, oracle ${fmtUsdc(usdcPerWbtc(back))} USDC per WBTC`);
        }
      }
    }
    const misses = outcomes.filter((o) => (o.decision.rule ?? "pass") !== o.planned.expect.rules || o.simulation !== o.planned.expect.simulation);
    for (const o of misses) {
      const { rules, simulation } = o.planned.expect;
      log.fail(`intent ${o.n}: expected rules ${rules}, dry run ${simulation}; got ${o.decision.rule ?? "pass"}, ${o.simulation}`);
    }

    at = "Wallet and position";
    log.step(at);
    // Only the sent intents may have moved the agent's funds: the wallet and the position must add up from them.
    const done = outcomes.filter((o) => o.sent.length);
    const moves = done.map(({ n, planned: { intent: i } }) =>
      i.kind === "deposit" ? { n, usdc: -i.amount, wbtc: 0n } : { n, usdc: i.amount, wbtc: -i.collateral });
    const sum = (vs: bigint[]): bigint => vs.reduce((a, b) => a + b, 0n);
    const terms = (vs: Array<{ n: number; v: bigint }>, fmt: (x: bigint) => string): string =>
      vs.filter((x) => x.v !== 0n).map((x) => `${x.v < 0n ? "-" : "+"} ${fmt(x.v < 0n ? -x.v : x.v)} (intent ${x.n})`).join(" ");
    const wantUsdc = START.usdc + sum(moves.map((x) => x.usdc));
    const wantWbtc = START.wbtc + sum(moves.map((x) => x.wbtc));
    const borrowed = sum(moves.map((x) => (x.usdc > 0n ? x.usdc : 0n)));
    const [walletUsdc, walletWbtc, pos, price] = await Promise.all([
      balanceOf(p, USDC, AGENT), balanceOf(p, WBTC, AGENT), position(p, AGENT), oraclePrice(p),
    ]);
    let books = true;
    if (walletUsdc === wantUsdc) {
      log.ok(`wallet ${fmtUsdc(walletUsdc)} USDC = ${fmtUsdc(START.usdc)} ${terms(moves.map((x) => ({ n: x.n, v: x.usdc })), fmtUsdc)}`);
    } else {
      books = false;
      log.fail(`wallet holds ${fmtUsdc(walletUsdc)} USDC, the sent intents add up to ${fmtUsdc(wantUsdc)} USDC`);
    }
    if (walletWbtc === wantWbtc) {
      log.ok(`wallet ${fmtWbtc(walletWbtc)} WBTC = ${fmtWbtc(START.wbtc)} ${terms(moves.map((x) => ({ n: x.n, v: x.wbtc })), fmtWbtc)}`);
    } else {
      books = false;
      log.fail(`wallet holds ${fmtWbtc(walletWbtc)} WBTC, the sent intents add up to ${fmtWbtc(wantWbtc)} WBTC`);
    }
    // Debt rounds up from borrow shares, so it may be a fraction of a cent above what was borrowed.
    const ltv = pos.collateral > 0n ? fmtPct(ltvOf(pos.collateral, pos.debt, price)) : "0%";
    if (pos.collateral === START.wbtc - wantWbtc && fmtUsdc(pos.debt) === fmtUsdc(borrowed)) {
      log.ok(`position ${fmtWbtc(pos.collateral)} WBTC collateral, ${fmtUsdc(pos.debt)} USDC debt, LTV ${ltv}`);
    } else {
      books = false;
      log.fail(`position ${fmtWbtc(pos.collateral)} WBTC, ${fmtUsdc(pos.debt)} USDC debt, ` +
        `expected ${fmtWbtc(START.wbtc - wantWbtc)} WBTC, ${fmtUsdc(borrowed)} USDC`);
    }
    links(c, env, sent);
    const blockedByRule = outcomes.filter((o) => !o.sent.length && o.decision.rule).length;
    const blockedByDryRun = outcomes.length - done.length - blockedByRule;
    const counts = `${outcomes.length - misses.length} of ${PLAN.length} as expected: ${done.length} sent, ` +
      `${blockedByRule} blocked by a rule, ${blockedByDryRun} by its dry run`;
    const summary = misses.length || books ? counts : "wallet or position doesn't match the sent intents";
    return log.result(misses.length === 0 && books, summary);
  } catch (err) {
    log.fail(failLine(at, err));
    if (env) links(c, env, sent);
    return log.result(false, `stopped after ${outcomes.length} of ${PLAN.length} intents`);
  }
}

main().then((code) => process.exit(code), (err) => process.exit(log.fatal(err)));
