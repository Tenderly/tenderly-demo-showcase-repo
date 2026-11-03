// Sets up a monitor through the REST API: the Web3 Action in actions/vault-invariants.js and the "Morpho bad debt"
// alert that runs it. The alert fires on a Morpho Blue Liquidate on Ethereum that books at least 1,000 USDC of bad
// debt; the action checks steakUSDC's invariants. Reruns find both by name and update them in place.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { id } from "ethers";
import * as log from "./lib/log.js";
import { credentials, type Credentials } from "./lib/tenderly.js";
import {
  CallError, accountChannels, actionUrl, alertHistoryUrl, alertUrl, createAlert, getAction, listActions, listAlerts,
  projectChannels, publishAction, resumeAction, updateAlert,
  type Action, type ActionSpec, type Alert, type AlertSpec, type Expression,
} from "./lib/monitoring.js";

const MORPHO = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb"; // Morpho Blue on Ethereum
const LIQUIDATE = "Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)";
const LIQUIDATE_TOPIC = id(LIQUIDATE); // topic0, 0xa4946ede…7e41
// badDebtAssets is in the market's loan token. steakUSDC lends only USDC (6 decimals), so this is 1,000 USDC there,
// and it keeps dust liquidations out of the channel. The alert can't filter by market: a market with an 18-decimal
// loan token still passes it with almost any amount, and the action logs HOLD for those.
const MIN_BAD_DEBT = 1_000n * 10n ** 6n;
const ACTION_NAME = "vault-invariants";
const ALERT_NAME = "Morpho bad debt";
const ACTION_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "actions/vault-invariants.js");
const WIDTH = 81; // after the "  [FAIL] " prefix, so a failure line stays within 90 characters
const QUOTA_FIX = "delete an unused alert or raise the plan's alert quota, then run npm run setup again";

const actionSpec = (source: string): ActionSpec => ({
  name: ACTION_NAME,
  description: "Checks steakUSDC's invariants when the Morpho bad debt alert fires.",
  source,
  triggerType: "ALERT",
  trigger: { type: "alert", alert: {} },
  runtime: "V2",
  function: "actionFn",
  invocationType: "ASYNC",
});

const alertSpec = (actionId: string, channelId: string): AlertSpec => ({
  name: ALERT_NAME,
  description: `A Morpho Blue Liquidate on Ethereum that booked bad debt (badDebtAssets >= ${MIN_BAD_DEBT}). Runs the vault-invariants Web3 Action.`,
  color: "#ff5252",
  simple_type: "emitted_log_parameter",
  enabled: true,
  expressions: [
    { type: "network", expression: { network_id: "1" } },
    {
      type: "emitted_log",
      expression: {
        address: MORPHO.toLowerCase(),
        event_name: "Liquidate",
        event_id: LIQUIDATE_TOPIC,
        match_any: false,
        match_non_project_contracts: true,
        decode_events: true,
        parameter_conditions: [{
          parameter_name: "badDebtAssets", parameter_type: "uint", operator: ">", comparison_value: String(MIN_BAD_DEBT - 1n),
        }],
      },
    },
  ],
  delivery_channels: [{ id: actionId, enabled: true }, { id: channelId, enabled: true }],
});

/** One string per expression, so a stored alert and the spec compare equal when they match the same logs. */
function canonical(expressions: Expression[]): string {
  return expressions
    .map(({ type, expression: e }) => {
      if (type === "network") return `network ${e.network_id}`;
      if (type !== "emitted_log") return `${type} ${JSON.stringify(e)}`;
      const conds = ((e.parameter_conditions as Array<Record<string, unknown>> | undefined) ?? [])
        .map((p) => `${p.parameter_name} ${p.parameter_type} ${p.operator} ${p.comparison_value}`);
      return [type, String(e.address).toLowerCase(), String(e.event_id).toLowerCase(), e.match_any === true,
        e.match_non_project_contracts === true, ...conds].join(" ");
    })
    .sort()
    .join(" | ");
}

/** True when the alert delivers to exactly the channels in the spec, each one switched on. */
const sameChannels = (a: Alert, want: AlertSpec): boolean =>
  (a.delivery_channels ?? []).map((d) => `${d.delivery_channel_id} ${d.enabled}`).sort().join() ===
  want.delivery_channels.map((d) => `${d.id} ${d.enabled}`).sort().join();

/** What differs between the stored alert and the spec: empty when it needs no update. */
function differences(a: Alert, want: AlertSpec): string[] {
  const out: string[] = [];
  if (!a.enabled) out.push("enabled");
  if (!sameChannels(a, want)) out.push("delivery channels");
  if ((a.description ?? "") !== want.description) out.push("description");
  if (a.color !== want.color) out.push("color");
  if (canonical(a.expressions ?? []) !== canonical(want.expressions)) out.push("expressions");
  return out;
}

/** Call fn every 3 s until it returns a value. */
async function poll<T>(what: string, timeoutSec: number, fn: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`no ${what} after ${timeoutSec}s`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/** Break text at spaces into lines of at most `width` characters. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const last = lines.length - 1;
    if (last >= 0 && lines[last].length + 1 + word.length <= width) lines[last] += ` ${word}`;
    else lines.push(word);
  }
  return lines;
}

const seconds = (since: number): string => `${Math.round((Date.now() - since) / 1000)}s`;

async function main(): Promise<number> {
  const c: Credentials = credentials();
  const channelId = process.env.TENDERLY_DELIVERY_CHANNEL_ID?.trim();
  if (!channelId) {
    throw new Error("missing TENDERLY_DELIVERY_CHANNEL_ID: a confirmed channel's id, see the README");
  }

  log.run("Invariant alerts", "Morpho Blue bad debt on Ethereum, checked against steakUSDC by a Web3 Action", 4);
  const links: Array<[string, string]> = [];
  let where = "";
  let undone = "nothing set up"; // what a failure from here on leaves undone, for the RESULT line
  const step = (title: string): void => {
    where = title;
    log.step(title);
  };
  // After the last step: a blank line, then the links.
  const showLinks = (): void => {
    if (links.length > 0) log.blank();
    for (const [label, url] of links) log.link(label, url);
  };
  // A failure prints what failed and why, the API's first sentence and what to do when known, then the links and
  // a RESULT line that says what was not set up.
  const stop = (why: string, verdict = undone, detail = "", fix = ""): number => {
    const [first, ...rest] = wrap(why, WIDTH);
    log.fail(first);
    for (const l of [...rest, ...wrap(detail, WIDTH)]) log.sub(l);
    if (fix) log.note(fix);
    showLinks();
    return log.result(false, verdict);
  };

  try {
    // 1. The channel that gets the notification next to the action. Account channels hold email, Slack and the
    // like; project channels hold webhooks and actions. Only a confirmed (enabled) channel receives anything.
    step("Delivery channel");
    const [account, project] = await Promise.all([accountChannels(c), projectChannels(c)]);
    const channel = [...account, ...project].find((ch) => ch.id === channelId);
    const name = `channel ${log.short(channelId)}`;
    if (!channel) {
      return stop(`${name} is not one of the account's or project's channels`, "nothing set up: channel not found");
    }
    if (channel.type === "action") {
      const why = `${name} is a Web3 Action, use an email, Slack or similar channel`;
      return stop(why, "nothing set up: wrong channel type");
    }
    if (!channel.enabled) {
      const why = `${channel.type} ${name} is disabled, confirm it in Alerts > Destinations`;
      return stop(why, "nothing set up: the channel is disabled");
    }
    log.ok(`${name}, ${channel.type}, enabled`);

    // 2. The Web3 Action. publishFile takes one CommonJS file and deploys it; a deployed ALERT action becomes a
    // project delivery channel with the action's id, which is how the alert reaches it.
    step("Web3 Action");
    const check = spawnSync(process.execPath, ["--check", ACTION_FILE], { encoding: "utf8" });
    if (check.status !== 0) {
      // stderr is "<path>:<line>", the source line, a caret, then "SyntaxError: ...".
      const err = (check.stderr ?? "").split("\n");
      const at = /:(\d+)$/.exec(err[0])?.[1];
      const why = err.find((l) => /^\w*Error\b/.test(l)) ?? "does not parse";
      const file = `actions/vault-invariants.js${at ? ` line ${at}` : ""}`;
      return stop(`${file}: ${why}`, "nothing set up: the action file does not parse");
    }
    const source = readFileSync(ACTION_FILE, "utf8");

    // The list has no source code, so read the action itself to compare it with the file.
    const found = (await listActions(c)).find((a) => a.name === ACTION_NAME);
    if (found) links.push(["action", actionUrl(c, found.id)]);
    let action: Action | undefined = found && (await getAction(c, found.id));
    let newDeploy = false;
    if (action && action.status === "DEPLOYED" && !action.version.deployError && action.version.source === source) {
      log.ok(`action ${log.short(action.id)} version ${action.version.index} is deployed with this source`);
    } else {
      undone = "action not deployed";
      const published = await publishAction(c, actionSpec(source));
      if (!found) links.push(["action", actionUrl(c, published.actionId)]);
      log.ok(`published ${ACTION_NAME} version ${published.index}, run by alerts`);
      log.wait("deploying");
      const started = Date.now();
      action = await poll("deploy", 300, async () => {
        const a = await getAction(c, published.actionId);
        if (a.version.deployError) throw new Error(`deploy failed: ${a.version.deployError.split("\n")[0]}`);
        return a.status === "DEPLOYED" && a.version.id === published.versionId ? a : undefined;
      });
      log.ok(`deployed in ${seconds(started)}, action ${log.short(action.id)}`);
      newDeploy = true;
    }
    const actionId = action.id;
    if (action.stopped) {
      undone = "action still stopped";
      await resumeAction(c, actionId);
      log.ok(`resumed ${ACTION_NAME}, it was stopped`);
      newDeploy = true;
    }
    undone = "alert not set up";
    await poll("project delivery channel for the action", 120, async () => {
      const ch = (await projectChannels(c)).find((x) => x.id === actionId);
      return ch?.type === "action" ? ch : undefined;
    });
    log.ok("alerts can send to it: it is a delivery channel of type action");
    if (newDeploy) log.note("a new deploy can take up to 5 minutes before it receives alerts");

    // 3. The alert, found by name: created once, then updated in place when it differs from the spec.
    step("Alert");
    const spec = alertSpec(actionId, channel.id);
    const named = (await listAlerts(c)).filter((a) => a.name === ALERT_NAME);
    let alert: Alert;
    if (named.length === 0) {
      undone = "alert not created";
      alert = await createAlert(c, spec);
      links.unshift(["alert rule", alertUrl(c, alert.id)]);
      log.ok(`created "${ALERT_NAME}", alert ${log.short(alert.id)}`);
    } else {
      links.unshift(["alert rule", alertUrl(c, named[0].id)]);
      const changes = differences(named[0], spec);
      undone = "alert not updated";
      alert = changes.length ? await updateAlert(c, named[0].id, spec) : named[0];
      const what = changes.length ? `updated "${ALERT_NAME}"` : `"${ALERT_NAME}" matches the spec`;
      log.ok(`${what}, alert ${log.short(alert.id)}`);
      if (changes.length) log.sub(`changed: ${changes.join(", ")}`);
    }
    links.push(["alert history", alertHistoryUrl(c)]);
    log.ok(`Liquidate on Morpho Blue ${MORPHO.slice(0, 6)}…${MORPHO.slice(-4)} with badDebtAssets >= ${MIN_BAD_DEBT}, network 1`);
    log.ok(`delivers to ${ACTION_NAME} and the ${channel.type} channel`);

    // 4. Read both back: exactly one of each, enabled and wired together.
    step("Check");
    undone = "alert and action set up, but the check failed";
    const [actions, alerts] = await Promise.all([listActions(c), listAlerts(c)]);
    const ours = actions.filter((a) => a.name === ACTION_NAME);
    const rules = alerts.filter((a) => a.name === ALERT_NAME);
    if (ours.length !== 1 || rules.length !== 1) {
      return stop(`expected 1 alert "${ALERT_NAME}" and 1 action ${ACTION_NAME}, found ${rules.length} and ${ours.length}`);
    }
    if (!rules[0].enabled) return stop(`"${ALERT_NAME}" is disabled`);
    if (!sameChannels(rules[0], spec)) {
      return stop(`"${ALERT_NAME}" does not deliver to exactly ${ACTION_NAME} and the channel`);
    }
    if (ours[0].stopped || ours[0].status !== "DEPLOYED") {
      return stop(`${ACTION_NAME} is ${ours[0].stopped ? "stopped" : ours[0].status}`);
    }
    log.ok(`1 alert, enabled, delivering to 1 deployed action and 1 ${channel.type} channel`);
    showLinks();
    return log.result(true, "monitor set up: 1 alert, 1 action");
  } catch (err) {
    if (!(err instanceof CallError)) return stop(err instanceof Error ? err.message : String(err));
    if (where === "Alert" && err.slug === "quota_limit_reached") {
      return stop(err.message, `${undone}: the plan's alert quota is used up`, err.detail, QUOTA_FIX);
    }
    return stop(err.message, undone, err.detail);
  }
}

main().then((code) => process.exit(code), (err) => process.exit(log.fatal(err)));
