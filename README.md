# Tenderly demo showcase

Runnable examples of Tenderly Virtual Environments, in TypeScript with ethers v6, run with `tsx`. They need no Solidity toolchain, no private keys and no faucet.

The examples share one scenario, a stablecoin treasury and settlement app built by a full-stack team (UI, backend, smart contracts and product). Each environment the team uses (dev, qa, uat) is a private fork of Ethereum mainnet that the whole team shares.

Each example is a self-contained folder. `cd` into it, run `npm install`, then its command. Run them in order or pick one.

| Example | What it shows | Command |
|---------|---------------|---------|
| [`01-shared-environments`](examples/01-shared-environments/) | Persistent dev, qa and uat environments the whole team shares | `npm run provision -- --env qa` |
| [`02-automation-tests`](examples/02-automation-tests/) | An automation test suite on RPC and cheat codes | `npm test` |
| [`03-multichain-bridge`](examples/03-multichain-bridge/) | One environment over Ethereum and Base, with a CCTP transfer relayed by the bridge module | `npm run bridge` |
| [`04-ci-cd`](examples/04-ci-cd/) | A fresh environment for every pull request with the Tenderly GitHub Action | `npm run ci -- --cleanup` |
| [`05-auto-mine-indexing`](examples/05-auto-mine-indexing/) | A block every 10 seconds so indexers see a live chain, plus a State Sync check | `npm run create`, then `npm run mine` |

Virtual Environments used to be called Virtual TestNets. The GitHub Action (`Tenderly/vnet-github-action`) and some API fields still use the old name.

## Setup

You need Node 20 or later and a Tenderly account with a project and an access key. All examples read one `.env` at the repo root. Copy `.env.example` to `.env` and fill it in:

```bash
TENDERLY_ACCESS_KEY=...     # Dashboard > Account Settings > Authorization
TENDERLY_ACCOUNT=...        # account slug
TENDERLY_PROJECT=...        # project slug
```

## Quick start

```bash
cp .env.example .env    # then fill it in
cd examples/01-shared-environments && npm install && npm run provision -- --env qa
cd ../02-automation-tests          && npm install && npm test
cd ../03-multichain-bridge         && npm install && npm run bridge
cd ../04-ci-cd                     && npm install && npm run ci -- --cleanup
cd ../05-auto-mine-indexing        && npm install && npm run create && npm run mine
```

## Notes

- Cheat codes work only on the Admin RPC. Give the Public RPC to anything that should behave like production, and keep the Admin RPC for the people and tests that seed state.
- Examples 01 to 04 give each environment a virtual chain id with the `7357` prefix (`73571` for an Ethereum fork), so its transactions can't be replayed on the real chain. They send transactions with cheat-code impersonation (`eth_sendTransaction` with a `from`), without signing keys. Example 05 keeps chain id 1.
- The environments from 01, 02 and 03 are meant to stay up and are reused by name. Delete them in the dashboard, or with `deleteTestNets` in the folder's `lib/testnet.ts`. Example 04 with `--cleanup` deletes its own environment.
- Each folder ships its own copy of its Tenderly helper (`lib/testnet.ts`, or `lib/tenderly.ts` in 05), so it runs on its own.

## Using it with an AI agent

The repo has one agent skill, [`.claude/skills/tenderly-virtual-environments`](.claude/skills/tenderly-virtual-environments/SKILL.md). It tells an agent which example fits the task, how to run or copy it, and the problems we hit while running them. Claude Code loads it when you work in this repo. To add it to another project, for Claude Code, Codex, Cursor and other agents, run:

```bash
npx skills add Tenderly/tenderly-demo-showcase-repo
```
