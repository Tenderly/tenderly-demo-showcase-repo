# 05 · Auto-mine for indexing

A [Virtual Environment](https://docs.tenderly.co/virtual-environments/overview) mines a block only when a transaction arrives, so an indexer pointed at a quiet one sees no new blocks. `npm run mine` mines one block per tick with the [Admin RPC](https://docs.tenderly.co/virtual-environments/admin-rpc) cheat code `evm_increaseBlocks`, and `npm run watch-state` shows that state stays at the fork block unless [State Sync](https://docs.tenderly.co/virtual-environments/state-sync) is on.

## Run

Needs the repo-root `.env` (see the root README).

```bash
npm install
npm run create        # fork Ethereum; out/environment.json gets publicRpc for the indexer
npm run mine          # one block every 10 s until Ctrl-C
npm run watch-state   # in a second terminal, read the state until Ctrl-C
```

## Options

| Variable | Default | Meaning |
|---|---|---|
| `FORK_BLOCK` | latest | The block `npm run create` forks at. It can't be combined with `STATE_SYNC=true`. |
| `STATE_SYNC` | `false` | `true` makes `npm run create` fork the latest block with State Sync on. Needs a paid plan. |
| `MINE_INTERVAL_SECONDS`, `WATCH_INTERVAL_SECONDS` | 10, or 12 with State Sync | Seconds between mined blocks, and between reads. |

## Example output

```
$ npm run watch-state   # plain fork, after npm run mine added 3 blocks
Tenderly  ·  Watch state
auto-mine-indexing-20261029-070638, State Sync off

[1/1] Read the ETH price and WETH supply at the fork block, then every 10 s until Ctrl-C
  time (UTC)   head block   ETH (USDC)   WETH supply    changed
  fork         26,296,793   2,310.48     2,218,769.35   baseline
  …
  07:07:45     26,296,796   2,310.48     2,218,769.35   none

  [link] environment     https://dashboard.tenderly.co/<account>/<project>/testnets/<env>/instance/<instance>
  [link] transactions    https://dashboard.tenderly.co/<account>/<project>/testnets/<env>/instance/<instance>/activity/transactions

RESULT  PASS   no change in 3 reads, state stays at the fork block   35s

$ npm run watch-state   # STATE_SYNC=true fork, npm run mine stopped at block 26,296,802
…
[1/1] Read the ETH price and WETH supply every 12 s until Ctrl-C
  time (UTC)   head block   ETH (USDC)   WETH supply    changed
  07:08:28     26,296,802   2,310.35     2,218,783.21   baseline
  07:08:41     26,296,802   2,310.35     2,218,784.39   supply
  07:08:53     26,296,802   2,310.35     2,218,784.50   supply
  07:09:05     26,296,802   2,310.35     2,218,784.50   none
  07:09:17     26,296,802   2,310.35     2,218,785.10   supply
  07:09:29     26,296,802   2,310.36     2,218,789.99   price, supply
…
RESULT  PASS   WETH supply changed in 4 of 5 reads, price in 1, no new block   1m 1s
```

## Notes

- Each tick mines a block that holds one cheat-code transaction, and each counts toward the environment's [write limit](https://docs.tenderly.co/platform/account/billing/limits#virtual-environment-write-limits). At the limit the miner stops with JSON-RPC error `-32004` and exit code 1.
- State Sync can't be switched on or off after creation, and it syncs state only, so an indexer gets no Ethereum blocks or events from after the fork. [Network Mirror Mode](https://docs.tenderly.co/virtual-environments/develop/thegraph#which-virtual-environment-modes-index-parent-network-events) brings them.
- `npm run watch-state` reads the ETH price in the Uniswap V3 USDC/WETH 0.05% pool and the WETH supply through the Public RPC. The State Sync verdict rests on the supply, which moves in nearly every Ethereum block. The price moves less often.
- `STATE_SYNC=true` creates the VNet with `POST /api/v1/account/{account}/project/{project}/vnets`, which the [Create Virtual Environments via API](https://docs.tenderly.co/virtual-environments/develop/create-virtual-environment-via-api) guide covers but the [API reference](https://docs.tenderly.co/api-reference) doesn't. The reference's environments list shows that VNet as an environment, so its links are the same.
