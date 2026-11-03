# Tenderly demo showcase

Runnable examples of Tenderly Virtual Environments and monitoring, in TypeScript with ethers v6. They need no Solidity
toolchain, no private keys and no faucet.

## Configuration

Node 22 or later, and a Tenderly account with a project and an access key. Copy `.env.example` to `.env` at the repo
root and fill it in:

```bash
TENDERLY_ACCESS_KEY=...   # Dashboard > Account Settings > Authorization
TENDERLY_ACCOUNT=...      # the slugs in dashboard.tenderly.co/{account}/{project}
TENDERLY_PROJECT=...
```

Each example is a folder of its own: `cd` into it, run `npm install`, then its command. Each run creates its own
Virtual Environment and keeps it, so the dashboard links it prints keep working. Delete old ones in the dashboard.
The one exception is example 04 with `--cleanup`, which CI uses: it deletes the environment when the suite passes.

## Setup examples

How a team sets up Virtual Environments. Examples 01 to 04 share one scenario, a USDC treasury app on an Ethereum fork.

### 01. Shared environments
Persistent dev, qa and uat environments the whole team shares, reused by name.
[`examples/setup-examples/01-shared-environments`](examples/setup-examples/01-shared-environments/): `npm run provision -- --env qa`

### 02. Automation tests
A test suite that seeds balances with cheat codes and settles 250,000 USDC, on an environment of its own.
[`examples/setup-examples/02-automation-tests`](examples/setup-examples/02-automation-tests/): `npm test`

### 03. Multichain bridge
One environment over Ethereum and Base. A CCTP V2 burn on Ethereum is minted on Base by the bridge module.
[`examples/setup-examples/03-multichain-bridge`](examples/setup-examples/03-multichain-bridge/): `npm run bridge`

### 04. CI/CD
A new environment for every pull request, running example 02's suite in GitHub Actions.
[`examples/setup-examples/04-ci-cd`](examples/setup-examples/04-ci-cd/): `npm run ci -- --pr 1`

### 05. Auto-mine for indexers
A fork that keeps producing blocks, so indexers and frontends see a moving chain. Optional State Sync.
[`examples/setup-examples/05-auto-mine-indexing`](examples/setup-examples/05-auto-mine-indexing/): `npm run create`, then `npm run mine`

## DeFi examples

### 001. Whale exit
A Morpho vault's largest depositor withdraws everything. The run shows what they get, which markets the exit drains,
and which other vaults lose exit liquidity.
[`examples/defi-examples/001-whale-exit`](examples/defi-examples/001-whale-exit/): `npm run demo`

### 002. Aave crash liquidation
ETH drops 10, 20 and 30%: which Aave V3 positions become liquidatable, and what a liquidator gets from the worst one.
[`examples/defi-examples/002-aave-crash-liquidation`](examples/defi-examples/002-aave-crash-liquidation/): `npm run demo`

### 003. Safe batch rehearsal
A curator's Safe batch simulated before anyone signs, then executed with impersonated owners past a 7-day timelock.
[`examples/defi-examples/003-safe-batch-rehearsal`](examples/defi-examples/003-safe-batch-rehearsal/): `npm run demo`

### 004. Policy gate
An agent checks each planned transaction against rules and a simulation, and sends only what passes.
[`examples/defi-examples/004-policy-gate`](examples/defi-examples/004-policy-gate/): `npm run demo`

## Monitoring

### 01. Invariant alerts
An alert on Morpho bad debt and a Web3 Action it triggers, both set up through the API.
[`examples/monitoring/01-invariant-alerts`](examples/monitoring/01-invariant-alerts/): `npm run setup`

## Notes

- Cheat codes work only on an environment's Admin RPC. Give apps the Public RPC.
- Chain ids use the `7357` prefix (`73571` for an Ethereum fork), so transactions can't be replayed on the real chain.
  Example 05 keeps chain id `1`.
- REST calls use only the [API reference](https://docs.tenderly.co/api-reference), except example 05's State Sync
  create, which uses a call from the docs guide.
- Virtual Environments used to be called Virtual TestNets, and some API fields still use the old name.

## Shared code

`lib/tenderly.ts`, `lib/log.ts` and `lib/multicall.ts` are copies of the files in [`shared/lib`](shared/lib/), so each
example folder works on its own when copied out of the repo. Edit `shared/lib`, then run `node scripts/sync-shared.mjs`.
CI fails when a copy differs (`node scripts/sync-shared.mjs --check`).

## Using it with an AI agent

The skill in [`.claude/skills/tenderly-examples`](.claude/skills/tenderly-examples/SKILL.md) maps a task to an example
and lists the problems we hit. Claude Code loads it in this repo. To add it to another project, run:

```bash
npx skills add Tenderly/tenderly-demo-showcase-repo
```

## License

[MIT](LICENSE)
