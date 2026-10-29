---
name: tenderly-virtual-environments
description: Use when the user wants to test smart contracts or a dapp on a fork of a live network with Tenderly Virtual Environments. Covers shared dev, qa and uat environments for a team, test suites that seed state with cheat codes (set balances, impersonate any address, snapshot and revert, time travel), a fresh environment per pull request in CI with the Tenderly GitHub Action, cross-chain transfers relayed by the bridge module (CCTP V2), keeping a fork producing blocks or following live mainnet state for indexers and subgraphs (auto-mine, State Sync), and checking what a large withdrawal from a Morpho vault does to its depositors and to other vaults (whale exit). Works from the runnable TypeScript examples in Tenderly/tenderly-demo-showcase-repo.
---

# Tenderly Virtual Environments

A Tenderly Virtual Environment is a private fork of a live network. It comes with a Public RPC (standard JSON-RPC, safe to give an app) and an Admin RPC that also accepts cheat codes. The runnable examples in [Tenderly/tenderly-demo-showcase-repo](https://github.com/Tenderly/tenderly-demo-showcase-repo) use TypeScript, ethers v6 and `tsx`. They need no Solidity toolchain, no private keys and no faucet.

Run or copy an example rather than writing the integration from scratch. Each one is a self-contained folder under `examples/` with its own README, `package.json` and Tenderly helper.

## Pick an example

| The user wants to | Example | Command |
|---|---|---|
| give a team persistent dev, qa and uat environments on a fork | `01-shared-environments` | `npm run provision -- --env qa` |
| write tests that seed state with cheat codes | `02-automation-tests` | `npm test` |
| run those tests on a fresh environment for every pull request | `04-ci-cd` (runs 02 in CI) | `npm run ci -- --cleanup` |
| test a cross-chain transfer between two forked chains | `03-multichain-bridge` | `npm run bridge` |
| keep blocks coming for an indexer, or follow live mainnet state | `05-auto-mine-indexing` | `npm run create`, then `npm run mine` |
| see what happens when a vault's largest depositor withdraws everything | `06-whale-exit` | `npm run demo` (any MetaMorpho vault with `--vault`) |

## Setup

1. Node 20 or later.
2. A Tenderly account with a project and an access key (Dashboard > Account Settings > Authorization).
3. A `.env` with `TENDERLY_ACCESS_KEY`, `TENDERLY_ACCOUNT` and `TENDERLY_PROJECT`. Account and project are the slugs in `dashboard.tenderly.co/{account}/{project}`. The examples find the file by walking up from their folder, so the repo root works.

Never print the access key or an Admin RPC URL, and never commit `.env`. Anyone holding the Admin RPC can change the environment's state.

## Run an example

```bash
git clone https://github.com/Tenderly/tenderly-demo-showcase-repo
cd tenderly-demo-showcase-repo
cp .env.example .env                       # fill in the three values
cd examples/02-automation-tests && npm install && npm test
```

To use one in another project, copy its folder there and put the `.env` in the folder or any parent:

```bash
npx degit Tenderly/tenderly-demo-showcase-repo/examples/02-automation-tests tenderly-tests
```

Read the example's README for its options and what its output means.

## How the examples talk to Tenderly

- Environments are created, listed, read and deleted over REST at `https://api.tenderly.co/api/public/v1/account/{account}/project/{project}/environments`, with an `X-Access-Key` header. `lib/testnet.ts` in examples 01 to 04 has all four calls.
- The response lists each network under `active_instance.vnets[]`, with its RPC URLs in `rpcs` ("Admin RPC" and "Public RPC").
- Cheat codes on the Admin RPC: `tenderly_setBalance`, `tenderly_setErc20Balance`, `eth_sendTransaction` from any address without a key, `evm_snapshot` and `evm_revert`, `evm_increaseTime`, `evm_increaseBlocks`.
- The environment's dashboard page is `https://dashboard.tenderly.co/{account}/{project}/testnets/{environment id}/instance/{instance id}`.

## Things that go wrong

- **CCTP V1 isn't relayed.** The bridge module relays CCTP V2: TokenMessengerV2 is `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` on both Ethereum and Base. A burn through the V1 TokenMessenger succeeds on the source chain, but nothing is ever minted on the destination.
- **State Sync is set at creation.** It's a paid-plan feature and can't be switched on later. The public environments endpoint ignores `sync_state_config`, so example 05 sends `syncStateConfig` to the camelCase endpoint `POST https://api.tenderly.co/api/v1/account/{account}/project/{project}/environments`. Synced state refreshes when the environment mines a block, so keep `npm run mine` running while you read it.
- **Cheat codes mine a block.** Each call moves the chain forward, so balances that earn interest and timestamps move too. Read a value after the last cheat code, right before you use it.
- **A pinned fork still moves in time.** New blocks carry today's timestamp, so interest since the fork block accrues as soon as the first one is mined. Amounts from an old block grow a little with the date you run it.
- **`evm_revert` deletes transactions.** Everything after the snapshot disappears from the environment and its dashboard, including transactions a teammate sent. Run tests that revert on an environment of their own.
- **The environment list is paged.** It returns at most 100 environments per page. Read every page before deciding an environment doesn't exist, or reusing one by name creates a duplicate.
- **CI needs the repo's settings.** The workflow needs the `TENDERLY_ACCESS_KEY` secret and the `TENDERLY_ACCOUNT_NAME` and `TENDERLY_PROJECT_NAME` variables. Pull requests from forks don't get secrets.
- **Connections drop on long runs.** Retry a read on the next tick instead of exiting, as example 05's scripts do.

## Clean up

The environments from 01 to 03 stay up and are reused by name. Example 04 with `--cleanup` deletes its own environment. Delete the others in the dashboard, or with `deleteTestNets` in the folder's `lib/testnet.ts`. Ask the user before deleting an environment you didn't create.
