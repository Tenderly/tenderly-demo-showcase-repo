# 04 · CI/CD

`ci-run.ts` creates a Virtual Environment for a pull request with the [Create Environment](https://docs.tenderly.co/api-reference/virtual-environments/create-environment) API, then runs [example 02](../02-automation-tests/)'s settlement suite against it. The workflow [`vnet-ci.yml`](../../../.github/workflows/vnet-ci.yml) runs it for every pull request.

## Run

Needs the repo-root `.env` (see the root README). The script runs `npm install` in `../02-automation-tests` if it hasn't been run there.

```bash
npm install
npm run ci -- --pr 4217
```

## Options

| Flag | What it does |
|---|---|
| `--pr <n>` | Puts the pull request number in the slug (`acme-ci-<n>-<date>-<time>`) and the name (`Acme Treasury CI PR <n>`). Without it the slug says `local`. |

## Example output

```
Tenderly  ·  CI run
PR 4217: a new environment, then example 02's suite against it

[1/2] Create environment
  [ok]   environment acme-treasury-ci-4217-…, block 26,296,803, chain id 73571

[2/2] Run example 02's suite
  npm test in ../02-automation-tests against this environment

Tenderly  ·  Settlement tests
a 250,000 USDC treasury settlement, tested on an Ethereum fork

[1/5] Environment
  [ok]   environment from TENDERLY_ADMIN_RPC_URL_1, block 26,296,803, chain id 73571
…

  [link] environment     https://dashboard.tenderly.co/<account>/<project>/testnets/<env>/instance/<instance>
  [link] transactions    https://dashboard.tenderly.co/<account>/<project>/testnets/<env>/instance/<instance>/activity/transactions
  [link] settlement tx   https://dashboard.tenderly.co/<account>/<project>/testnets/<env>/instance/<instance>/container/<vnet>/tx/0x5169bd245b38d7bea9ece34c7de512823ea8757897f3359a9527b971222110b4

RESULT  PASS   4 of 4 tests passed   5s
```

The settlement tx hash can be the same as in 02's own run, because the same sender, nonce and calldata at gas price 0 give the same hash on another environment.

## Notes

- The workflow runs `npm run ci -- --pr <number>` with the pull request number, or the run number on pushes to `main` and manual runs. It needs the secret `TENDERLY_ACCESS_KEY` and the variables `TENDERLY_ACCOUNT_NAME` and `TENDERLY_PROJECT_NAME`, and it skips pull requests from forks, which get no secrets.
- In GitHub Actions the script masks both RPC URLs in the job log and adds the links to the job summary. Each run keeps its environment, so those links keep working.
- The exit code is the suite's. If the suite stops before its RESULT line, for example when an import fails, the script prints `[FAIL]` with the reason, the links and `RESULT FAIL`, and exits 1.
- Tenderly also has a GitHub Action, [`Tenderly/vnet-github-action`](https://github.com/Tenderly/vnet-github-action), which creates environments through an endpoint outside the API reference.
