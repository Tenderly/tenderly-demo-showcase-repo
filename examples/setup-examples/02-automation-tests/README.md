# 02 · Automation test suite on RPC and cheat codes

How can RPC endpoints and cheat codes drive a Virtual Environment from an automation test suite?

Each environment exposes standard JSON-RPC, so any tool (`ethers`, `viem`, `cast`, your test framework) works unchanged. The Admin RPC adds cheat codes that make tests deterministic without keys or funding. This is an ordinary arrange, act, assert suite, run against a fork of mainnet.

| Cheat code | Purpose |
|------------|---------|
| `tenderly_setErc20Balance(token, holder, amount)` | Mint any ERC-20 balance. |
| `tenderly_setBalance([addrs], wei)` | Fund gas. |
| impersonated `eth_sendTransaction({from, …})` | Transact as any address, no key. |
| `evm_snapshot()` / `evm_revert(id)` | Snapshot state, then roll it back, to isolate test cases without a new environment. |
| `evm_increaseTime(hexSeconds)` | Move the chain clock forward to test time-dependent logic. |

## Run

```bash
npm install
npm test                  # provisions/reuses the qa Environment, then arrange/act/assert
TEST_ENV=uat npm test     # target a different environment
```

```
▶ treasury USDC settlement on a Virtual Environment
  ✔ arrange: cheat codes seed deterministic balances and gas
  ✔ act + assert: settle 250,000 USDC and verify the deltas
  ✔ profile: gas used is sane (Gas Profiler breaks it down in the dashboard)
  ✔ cheat code: evm_snapshot / evm_revert resets state between cases
  ✔ cheat code: evm_increaseTime advances the chain clock
```

`settlement.test.ts` uses the built-in Node test runner (`node:test`). Its steps:

- Arrange. `tenderly_setErc20Balance` mints USDC and `tenderly_setBalance` funds gas.
- Act. Impersonate the treasury wallet and `transfer` USDC with an unsigned `eth_sendTransaction` (no key). It mines one block.
- Assert. Read the balances back over JSON-RPC and check the deltas.
- Profile. Read the settlement's `gasUsed`. The dashboard's Gas Profiler breaks it down per internal call.
- Reset. Take an `evm_snapshot` before a change and `evm_revert` to roll it back, which is how a suite isolates cases on a shared environment. The revert also removes the reverted transactions from the environment.
- Time. `evm_increaseTime` moves the chain clock about 30 days forward to exercise time-dependent logic (settlement windows, accrual).

Run locally, the suite uses the shared `qa` environment, so its revert and its 30-day time jump happen there too. Set `TEST_ENV` to run it on an environment of its own.

The same file runs locally and in CI. It picks its RPC in this order:

1. In CI, `TENDERLY_ADMIN_RPC_URL_1` and `TENDERLY_PUBLIC_RPC_URL_1` from the Tenderly GitHub Action (see `04-ci-cd`).
2. Locally, `TENDERLY_ADMIN_RPC` and `RPC_URL` if they're set. Otherwise it creates or reuses the `qa` environment.

Open the settlement transaction in the dashboard for the decoded call trace, state diff and Gas Profiler.
