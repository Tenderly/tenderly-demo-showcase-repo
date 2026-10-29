---
name: tenderly-examples
description: Use when the user wants to test contracts or a dapp on a fork of a live network with Tenderly Virtual Environments, or to set up Tenderly monitoring through the API. Covers shared dev/qa/uat environments, test suites that seed state with cheat codes, an environment per pull request in CI, CCTP V2 transfers through the bridge module, auto-mine and State Sync for indexers, DeFi scenarios (a Morpho vault whale exit, an Aave price crash with liquidations, a Safe batch rehearsal, a policy gate that simulates before it sends), and an alert with an alert-triggered Web3 Action created through the API. Works from the runnable TypeScript examples in Tenderly/tenderly-demo-showcase.
---

# Tenderly examples

A Virtual Environment is a private fork of a live network. Its Public RPC is for apps, and its Admin RPC adds cheat
codes. The examples in [Tenderly/tenderly-demo-showcase](https://github.com/Tenderly/tenderly-demo-showcase) use
TypeScript, ethers v6 and `tsx`, with no keys and no faucet. Run or copy an example instead of writing the integration
from scratch. Each folder has its own README, `package.json` and `lib/`.

## Pick an example

| The user wants to | Example (under `examples/`) | Command |
|---|---|---|
| give a team persistent dev, qa and uat environments | `setup-examples/01-shared-environments` | `npm run provision -- --env qa` |
| test with cheat codes: balances, impersonation, snapshot and revert, time travel | `setup-examples/02-automation-tests` | `npm test` |
| bridge USDC between two forked chains with CCTP V2 | `setup-examples/03-multichain-bridge` | `npm run bridge` |
| create an environment per pull request in GitHub Actions | `setup-examples/04-ci-cd` | `npm run ci -- --pr 1` |
| keep blocks coming for an indexer, or follow mainnet state | `setup-examples/05-auto-mine-indexing` | `npm run create`, `npm run mine` |
| see what a vault's largest depositor exiting does to everyone else | `defi-examples/001-whale-exit` | `npm run demo` |
| crash a price and find the positions that become liquidatable | `defi-examples/002-aave-crash-liquidation` | `npm run demo` |
| rehearse a Safe multisig batch before anyone signs | `defi-examples/003-safe-batch-rehearsal` | `npm run demo` |
| check transactions against rules and a simulation before sending them | `defi-examples/004-policy-gate` | `npm run demo` |
| set up an alert and a Web3 Action through the API | `monitoring/01-invariant-alerts` | `npm run setup` |

## Setup

1. Node 22 or later.
2. A Tenderly account with a project and an access key (Dashboard > Account Settings > Authorization).
3. A `.env` at the repo root, or in any folder above the example, with `TENDERLY_ACCESS_KEY`, `TENDERLY_ACCOUNT` and
   `TENDERLY_PROJECT` (the slugs in `dashboard.tenderly.co/{account}/{project}`).

```bash
git clone https://github.com/Tenderly/tenderly-demo-showcase
cd tenderly-demo-showcase && cp .env.example .env    # fill in the three values
cd examples/setup-examples/02-automation-tests && npm install && npm test
```

To copy one example into another project: `npx degit Tenderly/tenderly-demo-showcase/examples/setup-examples/02-automation-tests tenderly-tests`.

## How the examples call Tenderly

- Environments: `POST https://api.tenderly.co/api/public/v1/account/{account}/project/{project}/environments` with an
  `X-Access-Key` header ("Create Environment" in the API reference). Each example's `lib/tenderly.ts` has create, get,
  find by slug and the dashboard links.
- RPC URLs come back under `active_instance.vnets[].rpcs` ("Admin RPC" and "Public RPC").
- Cheat codes on the Admin RPC: `tenderly_setBalance`, `tenderly_setErc20Balance`, `tenderly_setStorageAt`,
  `tenderly_setCode`, `eth_sendTransaction` from any address, `evm_snapshot`, `evm_revert`, `evm_increaseTime`,
  `tenderly_setNextBlockTimestamp`, `tenderly_simulateBundle`.
- Dashboard pages (they need a login to the project): `https://dashboard.tenderly.co/{account}/{project}/testnets/{environment id}/instance/{instance id}`,
  plus `/activity/transactions` and `/container/{vnet id}/tx/{hash}`.
- Monitoring: `POST /api/v1/account/{account}/project/{project}/actions/publishFile` and `POST .../alert`. The README of
  `monitoring/01-invariant-alerts` lists every call in order.

## Things that go wrong

- **A reused slug fails.** Creating an environment with a slug that exists returns HTTP 409, so the examples put a
  timestamp in each run's slug.
- **The environment list is paged.** 50 per page by default and 100 at most (asking for more returns 50). Read every
  page before deciding a slug is free.
- **The documented explorer field is rejected.** The API reference names `explorer_config.verification_visibility`, but
  the API only accepts `contract_verification_visibility`. The examples don't turn the explorer on.
- **CCTP V1 isn't relayed.** The bridge module relays CCTP V2: TokenMessengerV2 is
  `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` on Ethereum and Base.
- **State Sync is set at creation and needs a paid plan.** The API reference's create has no sync field, so example 05
  creates it through `POST /api/v1/.../vnets` with `sync_state_config {enabled: true}`, from the docs guide. It syncs
  state only, so no Ethereum events from after the fork arrive.
- **Cheat codes mine a block.** Each block holds the cheat-code transaction, and balances that earn interest move with
  it. Read a value after the last cheat code.
- **A pinned fork still moves in time.** New blocks carry today's time unless you call
  `tenderly_setNextBlockTimestamp` with a time after the fork block's. Later blocks then run on from that time.
- **`evm_revert` removes transactions.** Everything after the snapshot leaves the chain and the default Activity list,
  including a teammate's transactions. Run suites that revert on an environment of their own.
- **ethers caches identical reads for 250 ms.** A balance read right after a send can return the old value. The
  examples' `providerFor` turns the cache off.
- **Alerts and Web3 Actions don't watch Virtual Environments.** They see public chains only. A new Web3 Action can take
  up to 5 minutes before it receives alerts, and creating an alert fails with 403 `quota_limit_reached` when the
  account has used its plan's alerts.

## Environments stay

The examples never delete environments, so their dashboard links keep working. Ask the user before deleting an
environment you didn't create.
