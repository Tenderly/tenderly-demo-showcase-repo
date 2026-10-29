// Aave V3 on Ethereum at a pinned block: drop the WETH oracle price 10, 20 and 30% on a Virtual Environment, count the
// WETH-collateral positions that fall below health factor 1, and liquidate the worst one as an impersonated liquidator.
// npm run demo -- [--block <number|latest>] [--drop <10|20|30>]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, MaxUint256, formatUnits, getAddress, type JsonRpcProvider } from "ethers";
import * as log from "./lib/log.js";
import {
  createEnvironment, credentials, environmentUrl, providerFor, runSlug, sendAs, setErc20Balance, setNextBlockTimestamp,
  transactionsUrl, txUrl, type Environment,
} from "./lib/tenderly.js";
import {
  MOCK_FEED, POOL, WETH, aaveAt, accounts, borrowersBetween, configurations, describe, erc20, installMockFeed,
  percentDiv, percentMul, pointAtMock, pool, positionOf, priceOf, readLiquidation, reserveOf, revertReason,
  setMockPrice, sourceOf, treasuryOf, usesAsCollateral, variableDebtOf, type Aave, type Account, type Reserve,
} from "./lib/aave.js";
import { amount, apart, fit, hf, int, placesFor, priceFor, scaled, short, text, times, usd } from "./lib/format.js";

const DEFAULT_BLOCK = 26_290_000; // 2026-10-28 08:22 UTC
const WINDOW = 50_000; // blocks of Borrow logs before the fork block, about a week
const DROPS = [10, 20, 30];
const HF_ONE = 10n ** 18n;
const HF_TOP = 16n * 10n ** 17n; // 1.60: when only WETH falls 30%, a position above 1 / 0.7 stays above 1
const MIN_DEBT = 10_000n * 10n ** 8n; // $10,000 in Aave's base currency (USD, 8 decimals)
const LIQUIDATOR = getAddress("0x5555555555555555555555555555555555555555");
const WETH_PLACES = 4;
const WIDTH = 81; // text on a tagged line or under it: 90 characters minus the 9 of "  [FAIL] "
const KV_WIDTH = 75; // the value of a kv line: 90 characters minus the 15 of its label column

/** A failure: where and why for the [FAIL] line, lines under it, and a summary for the RESULT line. */
class Failure extends Error {
  constructor(where: string, why: string, readonly summary: string, readonly details: string[] = []) {
    super(`${where}: ${why}`);
  }
}

/** Words in lines of at most `width` characters; a longer word gets a line of its own. */
function wrap(s: string, width = WIDTH): string[] {
  const lines = [""];
  for (const word of s.split(" ")) {
    const last = lines[lines.length - 1];
    if (last && last.length + 1 + word.length > width) lines.push(word);
    else lines[lines.length - 1] = last ? `${last} ${word}` : word;
  }
  return lines;
}

/** The [FAIL] line and the details under it, wrapped. */
function fail(what: string, details: string[] = []): void {
  const [first, ...rest] = wrap(what);
  log.fail(first);
  for (const l of [...rest, ...details.flatMap((d) => wrap(d))]) log.sub(l);
}

/** An [ok] line, a kv line and a note, wrapped so no line passes 90 characters however large the numbers get. */
function ok(msg: string): void {
  const [first, ...rest] = wrap(msg);
  log.ok(first);
  for (const l of rest) log.sub(l);
}
function kv(label: string, value: string): void {
  const [first, ...rest] = wrap(value, KV_WIDTH);
  log.kv(label, first);
  for (const l of rest) log.kv("", l);
}
function note(msg: string): void {
  for (const l of wrap(msg, WIDTH + 7)) log.note(l); // a note is indented 2, so its text can take 88
}

interface Level {
  drop: number;
  price: bigint;
  /** Positions below health factor 1 at this price, lowest first. */
  below: Account[];
  debt: bigint;
}

let current = "";
const step = (title: string): void => {
  current = title;
  log.step(title);
};
const report: Record<string, unknown> = {};
/** An error's message; the RPC's own when there is one, else ethers' short form, without the request it wraps. */
const message = (err: unknown): string => {
  const e = err as { error?: { message?: string }; shortMessage?: string };
  return e.error?.message ?? e.shortMessage ?? (err instanceof Error ? err.message : String(err));
};
const sum = (xs: bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);
const abs = (x: bigint): bigint => (x < 0n ? -x : x);
const byHealth = (a: Account, b: Account): number => (a.hf < b.hf ? -1 : a.hf > b.hf ? 1 : 0);
const dec = (x: bigint, decimals: number): string => formatUnits(x, decimals);

function parseArgs(argv: string[]): { block: number | "latest"; drop: number } {
  const opts: { block: number | "latest"; drop: number } = { block: DEFAULT_BLOCK, drop: DROPS[DROPS.length - 1] };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split("=", 2);
    const value = inline ?? argv[++i];
    if (flag !== "--block" && flag !== "--drop") {
      throw new Error(`unknown flag ${flag}; use --block <number|latest> and --drop <10|20|30>`);
    }
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--block") {
      const n = Number(value.replace(/[_,]/g, ""));
      if (value !== "latest" && !(Number.isInteger(n) && n > WINDOW)) {
        throw new Error(`--block takes a block number or latest, not ${value}`);
      }
      opts.block = value === "latest" ? "latest" : n;
    } else {
      const n = Number(value.replace(/[-%]/g, ""));
      if (!DROPS.includes(n)) throw new Error(`--drop takes 10, 20 or 30, not ${value}`);
      opts.drop = n;
    }
  }
  return opts;
}

/** Step 2: accounts in the Pool's Borrow logs that use WETH as collateral, at health factor 1.00 to 1.60. */
async function findBorrowers(p: JsonRpcProvider, block: number, weth: Reserve): Promise<Account[]> {
  step("Find WETH-collateral borrowers");
  const from = block - WINDOW + 1;
  const users = await borrowersBetween(p, from, block);
  ok(`${int(users.length)} accounts in the Pool's Borrow logs, blocks ${int(from)} to ${int(block)}`);
  const configs = await configurations(p, users);
  const wethUsers = users.filter((_, i) => usesAsCollateral(configs[i], weth.id));
  const all = await accounts(p, wethUsers);
  if (all.length < wethUsers.length) log.warn(`${int(wethUsers.length - all.length)} getUserAccountData calls failed`);
  const inBand = all.filter((a) => a.debt > 0n && a.hf >= HF_ONE && a.hf <= HF_TOP);
  const population = inBand.filter((a) => a.debt >= MIN_DEBT);
  const already = all.filter((a) => a.debt > 0n && a.hf < HF_ONE).length;
  ok(`${int(wethUsers.length)} use WETH as collateral, ${int(inBand.length)} of them at health factor 1.00 to 1.60`);
  ok(`${int(population.length)} of those owe $10,000 or more, ${usd(sum(population.map((a) => a.debt)))} in total`);
  if (already > 0) note(`${int(already)} already have a health factor below 1 and are left out`);
  if (population.length === 0) {
    const why = "no position at health factor 1.00 to 1.60 owes $10,000 or more";
    throw new Failure(`block ${int(block)}`, why, "no positions to stress");
  }
  return population;
}

/** Step 3: a mock feed takes the place of AaveOracle's WETH source. Returns WETH's price before the drops. */
async function mockWethPrice(p: JsonRpcProvider, aave: Aave): Promise<bigint> {
  step("Point Aave's WETH price at a mock");
  const [source, live] = await Promise.all([sourceOf(p, aave.oracle, WETH), priceOf(p, aave.oracle, WETH)]);
  const label = await describe(p, source);
  ok(`AaveOracle ${short(aave.oracle)} prices WETH from ${short(source)}${label ? ` (${label})` : ""}: ${usd(live, 2)}`);
  await installMockFeed(p);
  ok(`tenderly_setCode: mock feed at ${short(MOCK_FEED)}`);
  await setMockPrice(p, live);
  await pointAtMock(p, aave.oracle, WETH, source);
  const [mocked, price] = await Promise.all([sourceOf(p, aave.oracle, WETH), priceOf(p, aave.oracle, WETH)]);
  if (mocked !== MOCK_FEED || price !== live) {
    const why = `the WETH source is ${short(mocked)} at ${usd(price, 2)}`;
    throw new Failure(`AaveOracle ${short(aave.oracle)}`, why, "the mock did not take");
  }
  ok(`tenderly_setStorageAt: AaveOracle prices WETH from the mock, at ${usd(price, 2)}`);
  report.oracle = { address: aave.oracle, wethSource: source, mockFeed: MOCK_FEED, wethPrice: dec(live, 8) };
  return live;
}

/** Step 4: for each drop, set the mock's price and read every position's health factor again. */
async function sweep(p: JsonRpcProvider, aave: Aave, live: bigint, population: Account[]): Promise<Level[]> {
  step("Drop the WETH price");
  const levels: Level[] = [];
  const hfAt = new Map<string, Record<string, string>>();
  // Each drop's price is the printed price times (100 - drop)%, rounded to the cent, so the price Aave uses is the
  // one the table prints.
  const printed = scaled(live, 8, 2);
  for (const drop of DROPS) {
    const price = scaled(printed * BigInt(100 - drop), 4, 2) * 10n ** 6n;
    await setMockPrice(p, price);
    const [seen, now] = await Promise.all([priceOf(p, aave.oracle, WETH), accounts(p, population.map((a) => a.user))]);
    if (seen !== price) {
      const why = `AaveOracle prices WETH at ${usd(seen, 2)}, not ${usd(price, 2)}`;
      throw new Failure(`-${drop}%`, why, "the mock price did not take");
    }
    if (now.length < population.length) {
      const why = `${population.length - now.length} getUserAccountData calls failed`;
      throw new Failure(`-${drop}%`, why, "health factors missing");
    }
    const below = now.filter((a) => a.debt > 0n && a.hf < HF_ONE).sort(byHealth);
    levels.push({ drop, price, below, debt: sum(below.map((a) => a.debt)) });
    for (const a of now) hfAt.set(a.user, { ...hfAt.get(a.user), [`-${drop}%`]: dec(a.hf, 18) });
  }
  ok(`tenderly_setStorageAt: mock price for each drop, then ${int(population.length)} health factors read`);
  note("HF is the health factor. Below 1, anyone can liquidate the position.");
  const headers = ["drop", "WETH price", "HF < 1", "their debt"];
  const rows = levels.map((l) => [`-${l.drop}%`, usd(l.price, 2), int(l.below.length), usd(l.debt)]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const right = (row: string[]): string[] => row.map((cell, i) => (i === 0 ? cell : cell.padStart(widths[i])));
  log.table(right(headers), rows.map(right));
  report.positions = population.map((a) => ({
    user: a.user, healthFactor: dec(a.hf, 18), debtUsd: dec(a.debt, 8), collateralUsd: dec(a.collateral, 8),
    healthFactorAt: hfAt.get(a.user),
  }));
  report.levels = levels.map((l) => ({
    drop: l.drop, wethPrice: dec(l.price, 8), belowOne: l.below.map((a) => a.user), debtUsd: dec(l.debt, 8),
  }));
  return levels;
}

/**
 * Step 5: liquidate the position with the lowest health factor as an impersonated liquidator, then check the
 * liquidator's balance changes against the LiquidationCall event, Aave's bonus and fee, and the borrower's position.
 */
async function liquidateWorst(
  p: JsonRpcProvider, aave: Aave, weth: Reserve, level: Level, onSent: (hash: string) => void,
): Promise<void> {
  const worst = level.below[0];
  const where = `liquidating ${short(worst.user)}`;
  const [position, treasury] = await Promise.all([positionOf(p, aave, worst.user, weth), treasuryOf(p, weth.aToken)]);
  // The largest debt that isn't WETH: repaying WETH for WETH would merge the liquidator's two balance changes into one.
  const debt = position.debts.find((d) => d.asset !== WETH && d.amount > 0n);
  if (!debt) throw new Failure(where, "it has no variable debt other than WETH", "no debt to repay");
  const sym = debt.symbol;
  const dp = placesFor(debt.price);
  const show = (x: bigint): string => (x === 0n ? "0" : text(x, dp));
  const w = (x: bigint): string => (x === 0n ? "0" : text(x, WETH_PLACES));
  // The debt and the WETH as printed here are the totals the debt and collateral lines split up after the liquidation.
  const owes = scaled(debt.amount, debt.decimals, dp);
  const holds = scaled(position.collateral, 18, WETH_PLACES);
  ok(`lowest health factor ${hf(worst.hf)}: ${short(worst.user)} owes ${show(owes)} ${sym}, holds ${w(holds)} WETH`);
  const others = position.debts.filter((d) => d !== debt && d.amount > 0n);
  if (others.length > 0) {
    const list = others.slice(0, 2).map((d) => `${amount(d.amount, d.decimals, placesFor(d.price))} ${d.symbol}`);
    const more = others.length > 2 ? ` and ${others.length - 2} more` : "";
    note(`it also owes ${list.join(", ")}${more}; the liquidator repays ${sym}`);
  }
  // The debt as printed plus 1%, for the interest of the next blocks.
  const funded = (owes * 101n + 50n) / 100n;
  const fund = scaled(funded, dp, debt.decimals);
  await setErc20Balance(p, debt.asset, LIQUIDATOR, fund);
  ok(`tenderly_setErc20Balance: liquidator ${short(LIQUIDATOR)} has ${show(funded)} ${sym}, debt + 1%`);
  const approve = erc20.encodeFunctionData("approve", [POOL, fund]);
  if ((await sendAs(p, { from: LIQUIDATOR, to: debt.asset, data: approve })).receipt.status !== 1) {
    throw new Failure(`${sym} approve`, "reverted", "the liquidator could not approve the Pool");
  }

  // The liquidation block gets the latest block's time + 1 s, and the reads before it use the pending block, which
  // has that time. Before and after share one clock, so no interest accrues between them.
  const head = await p.getBlock("latest");
  if (!head) throw new Error("the environment returned no block");
  await setNextBlockTimestamp(p, head.timestamp + 1);
  const pending = { blockTag: "pending" };

  // Repay as much as Aave allows (debtToCover = max) and take WETH itself, not aWETH (receiveAToken = false).
  const call = pool.encodeFunctionData("liquidationCall", [WETH, debt.asset, worst.user, MaxUint256, false]);
  try {
    await p.call({ from: LIQUIDATOR, to: POOL, data: call, ...pending });
  } catch (err) {
    throw new Failure(where, `dry run reverts with ${revertReason(err)}`, "the liquidation would revert");
  }
  const tokens = [new Contract(debt.asset, erc20, p), new Contract(WETH, erc20, p)];
  const balances = (): Promise<bigint[]> => Promise.all(tokens.map((t) => t.balanceOf(LIQUIDATOR) as Promise<bigint>));
  const aWeth = new Contract(weth.aToken, erc20, p);
  const [[debt0, weth0], owedBefore, heldBefore] = await Promise.all([
    balances(),
    variableDebtOf(p, aave, debt.asset, worst.user, "pending"),
    aWeth.balanceOf(worst.user, pending) as Promise<bigint>,
  ]);
  const sent = await sendAs(p, { from: LIQUIDATOR, to: POOL, data: call });
  onSent(sent.hash);
  const tx = `liquidation ${short(sent.hash)}`;
  if (sent.receipt.status !== 1) throw new Failure(tx, "reverted", "the liquidation reverted");
  ok("eth_sendTransaction: liquidator sends approve and liquidationCall, no key");
  const [[debt1, weth1], after, debtLeft, collLeft, debtPrice, wethPrice] = await Promise.all([
    balances(),
    accounts(p, [worst.user]),
    variableDebtOf(p, aave, debt.asset, worst.user),
    aWeth.balanceOf(worst.user) as Promise<bigint>,
    priceOf(p, aave.oracle, debt.asset),
    priceOf(p, aave.oracle, WETH),
  ]);
  const ev = readLiquidation(sent.receipt.logs, worst.user, weth.aToken, treasury);
  if (!ev) throw new Failure(tx, "no LiquidationCall event", "the liquidation left no event");

  const repaid = debt0 - debt1;
  const received = weth1 - weth0;
  const badDebt = ev.deficits.get(debt.asset) ?? 0n;
  const seized = received + ev.fee; // WETH that left the borrower
  const owed = repaid + badDebt + debtLeft; // the borrower's debt, in its parts after the liquidation
  const held = seized + collLeft; // and its WETH
  const paid8 = (repaid * debtPrice) / 10n ** BigInt(debt.decimals); // USD, 8 decimals
  const got8 = (received * wethPrice) / 10n ** 18n;

  // The numbers to print. The parts add up to the totals printed above. Dollar values are whole dollars of the
  // printed amounts at Aave's prices: WETH at the price in the table, the repaid token at a price shown with the
  // fewest decimals that give the same dollars. The bonus is the difference of the two printed values.
  const debtParts = fit(owes, [repaid, badDebt, debtLeft], debt.decimals, dp);
  const wethParts = fit(holds, [received, ev.fee, collLeft], 18, WETH_PLACES);
  const [r, written, l] = debtParts.parts; // repaid, bad debt (written off), left
  const [s, f, k] = wethParts.parts; // to the liquidator, fee to Aave, left
  const got = times(s, WETH_PLACES, wethPrice, 8, 0);
  const repaidAt = priceFor(r, dp, debtPrice, 0);
  const paid = repaidAt.value;
  const bonus = got - paid;
  const pct = paid > 0n ? (bonus * 1_000n + paid / 2n) / paid : 0n; // tenths of a percent, rounded to nearest

  report.liquidation = {
    borrower: worst.user, healthFactor: dec(worst.hf, 18), debtAsset: debt.asset, debtSymbol: sym, tx: sent.hash,
    debtBefore: dec(owedBefore, debt.decimals), repaid: dec(repaid, debt.decimals),
    badDebt: dec(badDebt, debt.decimals), debtLeft: dec(debtLeft, debt.decimals),
    wethBefore: dec(heldBefore, 18), wethToLiquidator: dec(received, 18), wethFeeToTreasury: dec(ev.fee, 18),
    wethLeft: dec(collLeft, 18), debtPriceUsd: dec(debtPrice, 8), wethPriceUsd: dec(wethPrice, 8),
    repaidUsd: dec(paid8, 8), receivedUsd: dec(got8, 8), bonusUsd: dec(got8 - paid8, 8),
    bonusBps: Number(position.bonusBps), feeBps: Number(position.feeBps),
  };

  // Aave seizes the repaid debt's value in WETH plus the bonus, and sends part of the bonus to its treasury.
  const base = (repaid * debtPrice * 10n ** 18n) / (wethPrice * 10n ** BigInt(debt.decimals));
  const expectSeized = percentMul(base, position.bonusBps);
  const expectFee = percentMul(seized - percentDiv(seized, position.bonusBps), position.feeBps);
  // A millionth, plus 10 base units for Aave's rounding. Before and after share one clock, so interest adds nothing.
  const near = (a: bigint, b: bigint): boolean => abs(a - b) <= b / 1_000_000n + 10n;
  // A printed dollar value is within $1 of Aave's own (USD, 8 decimals).
  const dollar = 10n ** 8n;
  const nearDollar = (x: bigint, x8: bigint): boolean => abs(x * dollar - x8) <= dollar;
  // A failed check prints both amounts in token units, with the places it takes to tell them apart.
  type Say = (a: string, b: string) => string;
  const inDebt = (x: bigint, y: bigint, say: Say) => (): string => say(...apart(x, y, debt.decimals, dp));
  const inWeth = (x: bigint, y: bigint, say: Say) => (): string => say(...apart(x, y, 18, WETH_PLACES));
  const checks: Array<[boolean, () => string]> = [
    [ev.liquidator === LIQUIDATOR, () => `the event names ${short(ev.liquidator)} as the liquidator`],
    [
      repaid === ev.debtToCover,
      inDebt(repaid, ev.debtToCover, (a, b) => `liquidator paid ${a} ${sym}, the event says ${b}`),
    ],
    [
      received === ev.liquidated,
      inWeth(received, ev.liquidated, (a, b) => `liquidator got ${a} WETH, the event says ${b}`),
    ],
    [near(seized, expectSeized), inWeth(seized, expectSeized, (a, b) => `${a} WETH seized, Aave's bonus gives ${b}`)],
    [near(ev.fee, expectFee), inWeth(ev.fee, expectFee, (a, b) => `${a} WETH fee to Aave, its fee rate gives ${b}`)],
    [
      near(owed, owedBefore),
      inDebt(owed, owedBefore, (a, b) => `repaid + bad debt + left = ${a} ${sym}, debt before ${b}`),
    ],
    [near(held, heldBefore), inWeth(held, heldBefore, (a, b) => `seized + left = ${a} WETH, collateral before ${b}`)],
    // The printed numbers: parts within 2 units of their own rounding, dollar values within $1 of Aave's.
    [
      abs(debtParts.off) <= 2n,
      () => `${sym} parts round to ${text(owes - debtParts.off, dp)}, the debt printed is ${text(owes, dp)}`,
    ],
    [
      abs(wethParts.off) <= 2n,
      () => `WETH parts round to ${text(holds - wethParts.off, WETH_PLACES)}, the WETH printed is ${w(holds)}`,
    ],
    [nearDollar(got, got8), () => `WETH received printed as $${int(got)}, Aave values it at ${usd(got8, 2)}`],
    [nearDollar(paid, paid8), () => `${sym} repaid printed as $${int(paid)}, Aave values it at ${usd(paid8, 2)}`],
  ];
  const broken = checks.filter(([okay]) => !okay).map(([, line]) => line());
  if (broken.length > 0) {
    const why = `${broken.length} of ${checks.length} checks fail`;
    throw new Failure(tx, why, "the numbers don't reconcile", broken);
  }

  const bad = written > 0n ? `, ${show(written)} bad debt` : "";
  kv("debt", `${show(owes)} ${sym}: ${show(r)} repaid${bad}, ${show(l)} left`);
  kv("collateral", `${w(holds)} WETH: ${w(s)} to the liquidator, ${w(f)} fee to Aave, ${w(k)} left`);
  kv("bonus", `$${int(bonus)} (${text(pct, 1)}%): $${int(got)} of WETH for $${int(paid)} of ${sym}`);
  const price = `$${text(repaidAt.price, repaidAt.places)}`;
  kv("", `Aave prices ${sym} at ${price}, so ${show(r)} ${sym} is $${int(paid)}`);
  kv("health", `${hf(worst.hf)} before, ${after[0] && after[0].debt > 0n ? hf(after[0].hf) : "no debt"} after`);
  for (const [asset, owedToo] of ev.deficits) {
    const other = position.debts.find((d) => d.asset === asset);
    if (asset === debt.asset || !other) continue;
    note(`bad debt in ${other.symbol} too: ${amount(owedToo, other.decimals, placesFor(other.price))}`);
  }
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const c = credentials();
  const at = opts.block === "latest" ? "the latest block" : `block ${int(opts.block)}`;
  log.run("Aave crash liquidation", `Aave V3 on Ethereum at ${at}: WETH price -10%, -20%, -30%`, 5);

  step("Fork Ethereum");
  let env: Environment;
  try {
    env = await createEnvironment(c, {
      displayName: "Aave crash liquidation",
      slug: runSlug("aave-crash"),
      networks: [{ networkId: 1, chainId: 73571, ...(opts.block === "latest" ? {} : { block: opts.block }) }],
    });
  } catch (err) {
    fail(`create environment: ${message(err)}`);
    return log.result(false, "no environment");
  }
  const net = env.networks[0];
  const p = providerFor(net.adminRpc, net.chainId);
  const links: Array<[string, string]> = [
    ["environment", environmentUrl(c, env)],
    ["transactions", transactionsUrl(c, env)],
  ];
  report.environment = { id: env.id, slug: env.slug };
  const save = (): void => {
    const out = resolve(dirname(fileURLToPath(import.meta.url)), "out");
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  };

  try {
    const fork = await p.getBlock("latest");
    if (!fork) throw new Error("the environment returned no block");
    // New blocks start one second after the fork block, so interest accrues over the run's seconds, not since then.
    await setNextBlockTimestamp(p, fork.timestamp + 1);
    ok(`environment ${env.slug}, block ${int(fork.number)}, chain id ${net.chainId}`);
    report.block = fork.number;

    const [aave, weth] = await Promise.all([aaveAt(p), reserveOf(p, WETH)]);
    const population = await findBorrowers(p, fork.number, weth);
    const live = await mockWethPrice(p, aave);
    const levels = await sweep(p, aave, live, population);

    const level = levels.find((l) => l.drop === opts.drop)!;
    step(`Liquidate the worst position at -${level.drop}%`);
    if (level.below.length === 0) {
      const summary = `nothing to liquidate at -${level.drop}%`;
      throw new Failure(`-${level.drop}%`, "no position has a health factor below 1", summary);
    }
    if (level !== levels[levels.length - 1]) {
      await setMockPrice(p, level.price);
      ok(`tenderly_setStorageAt: mock price back to ${usd(level.price, 2)}`);
    }
    const onSent = (hash: string): void => void links.push(["liquidation tx", txUrl(c, env, net, hash)]);
    await liquidateWorst(p, aave, weth, level, onSent);

    save();
    log.blank();
    log.file("out/report.json", "positions, health factors per drop, the liquidation");
    for (const [name, url] of links) log.link(name, url);
    const count = `${int(level.below.length)} of ${int(population.length)}`;
    return log.result(true, `WETH -${level.drop}%: health factor below 1 for ${count}, worst liquidated`);
  } catch (err) {
    const failure = err instanceof Failure ? err : null;
    fail(failure ? failure.message : `${current}: ${message(err)}`, failure?.details);
    log.blank();
    if (report.block !== undefined) {
      save();
      log.file("out/report.json");
    }
    for (const [name, url] of links) log.link(name, url);
    return log.result(false, failure ? failure.summary : `stopped at ${current}`);
  }
}

main().then(
  (code) => process.exit(code),
  (err) => process.exit(log.fatal(err)),
);
