# 01 · Shared environments

Creates one Ethereum fork per stage (dev, qa, uat) as a [Virtual Environment](https://docs.tenderly.co/virtual-environments/overview) and finds it again by its slug `acme-treasury-<stage>`, so the team keeps using the same chain and RPC URLs.

## Run

Needs the repo-root `.env` (see the root README).

```bash
npm install
npm run provision -- --env uat
```

## Options

| Flag | Default | Meaning |
|------|---------|---------|
| `--env` | required | `dev`, `qa` or `uat` |
| `--fresh` | off | create another environment with a unique slug, written to `out/<stage>-<time>.json`. `acme-treasury-<stage>` still finds the old one. |

## Example output

```
Tenderly  ·  Shared environments
uat stage, an Ethereum fork the team shares

[1/2] Find or create the environment
  [ok]   created environment acme-treasury-uat, block 26,292,491, chain id 73571

[2/2] Team wallets
  [ok]   tenderly_setBalance: 0x1111…1111 and 0x2222…2222 set to 100 ETH each

  [file] out/uat.json  Public RPC for the app, Admin RPC for cheat codes
  [link] environment     https://dashboard.tenderly.co/<account>/<project>/testnets/<env>/instance/<instance>
  [link] transactions    https://dashboard.tenderly.co/<account>/<project>/testnets/<env>/instance/<instance>/activity/transactions

RESULT  PASS   acme-treasury-uat created   2s
```

`--env qa` reuses the existing `acme-treasury-qa` and leaves its wallets as they are. The lines that differ from a create:

```
  [ok]   reused environment acme-treasury-qa, block 26,292,175, chain id 73571
…
  [ok]   0x1111…1111 and 0x2222…2222 have 100 ETH each, set when it was created
…
RESULT  PASS   acme-treasury-qa reused   1s
```

## Notes

- The app and backend use `publicRpc` from `out/<stage>.json`. `adminRpc` adds [cheat codes](https://docs.tenderly.co/virtual-environments/admin-rpc), so keep it in seeding scripts and out of anything shared outside the team.
- The team wallets get 100 ETH each from `tenderly_setBalance` only when the environment is created, so a rerun doesn't reset them.
- Suites that revert or move the clock need an environment of their own, as [02](../02-automation-tests/) does.
- Deleting the environment frees its slug, and the next run creates a new one.
