# 01 · Invariant alerts

`npm run setup` creates a Tenderly [Alert](https://docs.tenderly.co/monitoring/alerts/introduction) that fires when a Morpho Blue liquidation on Ethereum books at least 1,000 USDC of bad debt, and the [Web3 Action](https://docs.tenderly.co/monitoring/web3-actions/introduction) that the alert runs, through the REST API only. The action checks two invariants of steakUSDC (`0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB`): its share price never falls (`BROKEN` when it does), and the Morpho markets it lends to book no bad debt (`WARN` when one does but the share price holds).

## Run

Needs the repo-root `.env` (see the root README) with `TENDERLY_DELIVERY_CHANNEL_ID` set, and a Tenderly plan with Alerts and Web3 Actions.

```bash
npm install
npm run setup
```

Run it again after you change `actions/vault-invariants.js`. It publishes a new version of the same action and never creates a second action or alert.

## Options

| Variable | Meaning |
|----------|---------|
| `TENDERLY_DELIVERY_CHANNEL_ID` | Required. A confirmed channel that gets each alert next to the action. Add one in Dashboard > Alerts > Destinations (an email channel is confirmed once you click the link in its email). Call 1 below lists the ids. |

## API calls

All on `https://api.tenderly.co/api/v1` with the `X-Access-Key` header, in the order `setup.ts` makes them. `{a}` is the account slug, `{p}` the project slug.

1. `GET /account/{a}/delivery-channels` and `GET /account/{a}/project/{p}/delivery-channels`: the channel must be `enabled` and not of type `action`.
2. `GET /account/{a}/project/{p}/actions` to find `vault-invariants` by name, then `GET /account/{a}/project/{p}/actions/action/{actionId}` for its `version.source`, which the list leaves out.
3. `POST /account/{a}/project/{p}/actions/publishFile`, only when the action is missing, not deployed or has other source: `{"action": {"name": "vault-invariants", "description": "…", "source": "<the file>", "triggerType": "ALERT", "trigger": {"type": "alert", "alert": {}}, "runtime": "V2", "function": "actionFn", "invocationType": "ASYNC"}, "deploy": true}`. The action id is at `actions["vault-invariants"].actionId`.
4. `GET /account/{a}/project/{p}/actions/action/{actionId}` every 3 s until the new version is `DEPLOYED`. A `version.deployError` stops the run.
5. `POST /account/{a}/project/{p}/actions/action/{actionId}/resume`, only when the action is stopped.
6. `GET /account/{a}/project/{p}/delivery-channels` until it lists `{"id": "<actionId>", "type": "action"}`, the channel the alert delivers to.
7. `GET /account/{a}/project/{p}/alerts` to find `Morpho bad debt` by name.
8. `POST /account/{a}/project/{p}/alert`, or `PATCH /account/{a}/project/{p}/alert/{alertId}` when the stored alert differs. The body, built by `alertSpec()` in `setup.ts`, has `"simple_type": "emitted_log_parameter"`, a `network` expression for network `1`, an `emitted_log` expression for Morpho Blue's `Liquidate` with `"match_non_project_contracts": true` and the condition `badDebtAssets > 999999999` (at least 1,000 USDC), and the ids of the action and the channel in `delivery_channels`.
9. `GET /account/{a}/project/{p}/actions` and `GET /account/{a}/project/{p}/alerts` again: one of each by name, the alert enabled with exactly those two channels, the action `DEPLOYED`.

## Example output

```
Tenderly  ·  Invariant alerts
Morpho Blue bad debt on Ethereum, checked against steakUSDC by a Web3 Action

[1/4] Delivery channel
  [ok]   channel <channel>…, email, enabled

[2/4] Web3 Action
  [ok]   action <action>… version 3 is deployed with this source
  [ok]   alerts can send to it: it is a delivery channel of type action

[3/4] Alert
  [ok]   created "Morpho bad debt", alert <alert>…
  [ok]   Liquidate on Morpho Blue 0xBBBB…FFCb with badDebtAssets >= 1000000000, network 1
  [ok]   delivers to vault-invariants and the email channel

[4/4] Check
  [ok]   1 alert, enabled, delivering to 1 deployed action and 1 email channel

  [link] alert rule      https://dashboard.tenderly.co/<account>/<project>/alerts/rules/<alert>
  [link] action          https://dashboard.tenderly.co/<account>/<project>/action/<action>
  [link] alert history   https://dashboard.tenderly.co/<account>/<project>/alerts/history

RESULT  PASS   monitor set up: 1 alert, 1 action   1s
```

## Notes

- The alert is live, and each time it fires it emails the channel and runs the action. It can't filter by market, so it fires for any Morpho Blue market, not only steakUSDC's. `badDebtAssets` is in the market's loan token: the threshold is 1,000 USDC in USDC markets, which are all steakUSDC lends to, but almost nothing in a market with an 18-decimal loan token. Raise `MIN_BAD_DEBT` in `setup.ts` and run it again to change it.
- The action reads Ethereum at blocks N-1 and N through `context.gateways`, so it needs no secret or RPC URL. It logs one verdict line, such as `steakUSDC invariants WARN (bad debt in a market steakUSDC lends to, share price held). Tx 0x46d998759cb0c29740e4eb90158248a5b89c43c97e4c99e5f9da614670260e49 at block 24,361,853: bad debt 0.002121 USDC in cbBTC/USDC (0x64d65c…, in steakUSDC's withdraw queue). Share price 1.116413 → 1.116413 USDC.` That liquidation is below the threshold, so this alert would no longer fire for it. The share price is one share in USDC to 6 decimals, so bad debt this small doesn't move it; a liquidation in another market logs `HOLD`.
- To remove the monitor, call `DELETE /account/{a}/project/{p}/alert/{alertId}`, then `DELETE /account/{a}/project/{p}/actions/action/{actionId}`.
