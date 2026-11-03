# 02 · Automation tests

`settlement.test.ts` is a `node:test` suite that seeds balances with the `tenderly_setErc20Balance` and `tenderly_setBalance` [Admin RPC cheat codes](https://docs.tenderly.co/virtual-environments/admin-rpc), settles 250,000 USDC from an impersonated treasury, rolls a probe back with `evm_snapshot` and `evm_revert`, and moves the clock 30 days with `evm_increaseTime`. Each run creates its own Virtual Environment, a fork of Ethereum.

## Run

Needs the repo-root `.env` (see the root README).

```bash
npm install
npm test
```

## Options

| Variable | What it does |
|---|---|
| `TENDERLY_ADMIN_RPC_URL_1`, `TENDERLY_PUBLIC_RPC_URL_1` | Run on this environment instead of creating one. The suite overwrites balances, reverts and moves the clock, so use one nobody else shares. [Example 04](../04-ci-cd/) sets both. |
| `TENDERLY_ENVIRONMENT_ID`, `TENDERLY_INSTANCE_ID`, `TENDERLY_VNET_ID_1` | Ids for the dashboard links when the RPC URLs come from outside. |

## Example output

```
Tenderly  ·  Settlement tests
a 250,000 USDC treasury settlement, tested on an Ethereum fork

[1/5] Environment
  [ok]   environment acme-treasury-tests-20261029-070835, block 26,296,802, chain id 73571

[2/5] Seed balances
  [ok]   tenderly_setErc20Balance: treasury 0x1111…1111 holds 1,000,000 USDC
  [ok]   counterparty 0x2222…2222 holds 0 USDC
  [ok]   tenderly_setBalance: both hold 100 ETH

[3/5] Settle 250,000 USDC
  [ok]   sent without the treasury's key, block 26,296,806, gas used 62,260
  [ok]   treasury 750,000 USDC, counterparty 250,000 USDC

[4/5] Snapshot and revert
  [ok]   evm_snapshot: taken at block 26,296,806
  [ok]   50,000 USDC probe in block 26,296,807, treasury 700,000 USDC
  [ok]   evm_revert: back to block 26,296,806, the probe and its block are gone
  [ok]   treasury 750,000 USDC again

[5/5] Move the clock 30 days
  [ok]   evm_increaseTime: new block 26,296,807, clock 2026-10-29 → 2026-11-28 UTC

  [link] environment     https://dashboard.tenderly.co/<account>/<project>/testnets/<env>/instance/<instance>
  [link] transactions    https://dashboard.tenderly.co/<account>/<project>/testnets/<env>/instance/<instance>/activity/transactions
  [link] settlement tx   https://dashboard.tenderly.co/<account>/<project>/testnets/<env>/instance/<instance>/container/<vnet>/tx/0x5169bd245b38d7bea9ece34c7de512823ea8757897f3359a9527b971222110b4

RESULT  PASS   4 of 4 tests passed   5s
```

## Notes

- `evm_revert` takes the probe and its block off the chain and out of the default Activity list, so the 30-day jump gets the probe's block number. The settlement stays.
- `lib/reporter.ts` replaces node:test's own output. A failing test prints `[FAIL]` with the reason, and the exit code is 1.
