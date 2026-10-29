# 04 · CI/CD integration

How do you add Virtual Environments to a CI/CD pipeline?

Tenderly's GitHub Action, `Tenderly/vnet-github-action`, creates a fresh Virtual Environment for each pull request and exports its RPC URLs as environment variables. In `CI` mode it cleans the environment up after the run, so every pull request tests against its own private fork of mainnet and there's no shared chain to corrupt. `CD` mode keeps the environment as a persistent staging environment and can push deployment artifacts.

For each network, the action exports:

- `TENDERLY_ADMIN_RPC_URL_{id}`, the cheat-code RPC for test setup
- `TENDERLY_PUBLIC_RPC_URL_{id}`, the standard RPC for the app under test
- `TENDERLY_FOUNDRY_VERIFICATION_URL_{id}`, for deploying and verifying contracts

## Run it locally

The GitHub Action only runs on GitHub. `ci-run.ts` runs the same pipeline on your machine, so you can demo it and open the result in the dashboard:

```bash
npm install
npm run ci -- --pr 4217      # provision a fresh per-PR Environment, run the test, keep it
npm run ci -- --cleanup      # same, then tear the Environment down (true CI behavior)
```

```
CI pipeline (emulated) — PR #4217
Provisioning a fresh, ephemeral Virtual Environment for this PR ...
  created: Acme Treasury — CI-PR-4217  (chain 73571)
  dashboard: https://dashboard.tenderly.co/<account>/<project>/testnets/…

Seeded treasury with 1,000,000 USDC (cheat codes).
Settled 250,000 USDC -> payroll   (0x…)
Settled 100,000 USDC -> vendor    (0x…)
✔ settlement checks PASSED
Showcase in the UI — open the Environment and inspect this PR's run:
  • Transactions — two decoded USDC settlements
  • Call trace / State diff / Gas Profiler
```

Each run creates a fresh environment and runs the settlement checks. Unless you pass `--cleanup`, it leaves the environment up so you can open the dashboard link and walk through the decoded transactions, call traces, state diffs and gas profile.

## The workflow

The workflow is [`.github/workflows/vnet-ci.yml`](../../.github/workflows/vnet-ci.yml). It creates an environment with the action and runs the `02-automation-tests` suite against the exported RPC URLs:

```yaml
- uses: Tenderly/vnet-github-action@v1.0.17
  with:
    mode: CI                       # a fresh environment, cleaned up after the run
    access_key: ${{ secrets.TENDERLY_ACCESS_KEY }}
    account_name: ${{ vars.TENDERLY_ACCOUNT_NAME }}
    project_name: ${{ vars.TENDERLY_PROJECT_NAME }}
    network_id: 1
    chain_id_prefix: 7357
    public_explorer: true
- run: cd examples/02-automation-tests && npm install && npm test
```

The suite reads the action's exported RPC URLs, so the same test that runs locally runs in CI against a per-PR environment. The workflow skips itself until the repo has the variables below, and it skips pull requests from forks, which don't get the repository's secrets.

## Setup (once, in the GitHub repo settings)

- Secret `TENDERLY_ACCESS_KEY`
- Variables `TENDERLY_ACCOUNT_NAME` and `TENDERLY_PROJECT_NAME`

Smart-contract teams usually add a deploy and verify step (Foundry or Hardhat) against the same environment, with the verification URL the action exports. This example leaves Solidity out.
