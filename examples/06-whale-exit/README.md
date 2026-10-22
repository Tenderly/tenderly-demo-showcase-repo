# 06 · Whale exit

What happens when a vault's largest depositor takes everything out? How much do they get, how much stays stuck, which markets does the exit drain, and who else is left with less to withdraw?

This example answers that on a Virtual Environment forked from Ethereum, for a MetaMorpho (Morpho Vault V1) vault. It finds the vault's depositors from its Transfer logs and rehearses the largest depositor's full withdrawal with `tenderly_simulateBundle`. Then it sends the withdrawal for real as that depositor (impersonated, no key) and compares the vault and its markets before and after. By default it uses Steakhouse USDC (steakUSDC) at block 26,242,540, so every run sees the same depositors and markets. Amounts grow a little with the date you run it: the environment's new blocks carry today's timestamp, so the interest since the fork block accrues as soon as the first one is mined.

## Run

```bash
npm install
npm run demo        # steakUSDC's largest depositor exits: RESULT PASS
npm run demo:fail   # the same exit against a stricter rule (60%): RESULT FAIL, exit code 1
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--vault` | steakUSDC | any MetaMorpho vault on Ethereum |
| `--block` | `26242540` | the fork block, or `latest` |
| `--holder` | the largest depositor | the depositor who exits |
| `--min-exit-pct` | `25` | the share of their deposits the vault's other depositors must still be able to withdraw |
| `--cleanup` | off | delete the environment at the end |

A run takes 10 to 25 seconds.

## What it does

1. Creates a Virtual Environment forking Ethereum at the block, with the public explorer on.
2. Reads the vault's withdraw queue and works out what its depositors could withdraw right now. That's the vault's supply in each market, capped by the market's free liquidity, summed over the queue.
3. Lists the depositors from the vault's Transfer logs and checks that their balances add up to totalSupply. The largest ones are labeled as an EOA, a Safe, or a vault that wraps this one.
4. Rehearses the whale's `redeem` with `tenderly_simulateBundle`, then sends it for real. When the markets can't pay all of it, the whale redeems what they can pay and the rest stays stuck.
5. Shows each market the exit took liquidity from: how much it took, and the free liquidity, utilization and borrow APR before and after.
6. Shows what everyone else can withdraw afterwards: the vault's other depositors, every other MetaMorpho vault lending in those markets, and the lenders that aren't MetaMorpho vaults.

Everything is read from the environment, which holds Ethereum's state at the fork block, so no mainnet RPC or indexer is needed.

## Output

```
4. The whale withdraws everything
  0x334F…2A7b holds 29.33M USDC, 44.5% of the vault, and asks for all of it
  the markets in the withdraw queue can pay 29.33M USDC of it right now
  rehearsed with tenderly_simulateBundle: the redeem goes through and takes liquidity from 1 market
  sent for real as the holder (impersonated, no key): paid 29.33M USDC, nothing left behind

5. Markets the exit drained
  market                          pulled   free liquidity            utilization       borrow APR
  cbBTC/USDC 86% 0x64d6      29.33M USDC   34.38M USDC → 5.05M USDC  90.0% → 98.4%     4.75% → 16.70%

6. Everyone else
  steakUSDC's other depositors: 36.50M USDC deposited, can withdraw 19.38M USDC now, 53.1% of deposits (before: 74.0%)
  other MetaMorpho vaults lending in the same markets, by what their depositors can withdraw:
    Hakutora USDC                    14.88M USDC → 5.05M USDC       100.0% → 33.9%   of 14.88M USDC deposits
    Spark Blue Chip USDC Vault       11.96M USDC → 5.55M USDC       100.0% → 46.4%   of 11.96M USDC deposits
    Gauntlet USDC Prime              21.71M USDC → 19.39M USDC      90.9% → 81.2%    of 23.87M USDC deposits
  19 more MetaMorpho vaults lend there, but the exit didn't change what their depositors can withdraw
  cbBTC/USDC 86% 0x64d6: other lenders (not MetaMorpho vaults) supply 265.35M USDC of 342.68M USDC, and share the same free liquidity

RESULT PASS  the whale left in full with 29.33M USDC, and steakUSDC's other depositors can still withdraw 53.1% of their deposits (rule: at least 25%)
```

steakUSDC's largest depositor is itself a USDC vault, Yield Bearing Steakhouse Morpho USDC, with 44.5% of steakUSDC's shares. It gets everything out, but it takes 29.33M of the 34.38M USDC free in the cbBTC/USDC market. Hakutora USDC and Spark Blue Chip, which lend almost all their deposits in that market, go from 100% withdrawable to 34% and 46%.

`RESULT PASS` means the whale left in full and the vault's other depositors can still withdraw at least `--min-exit-pct` of their deposits. Otherwise the run prints `RESULT FAIL` with where and why, and exits 1. The links at the end open the environment, the public explorer and the exit transaction, and `out/report.json` holds every number.

## Reading the numbers

- Each vault's withdrawable amount assumes it goes first. Vaults that lend in the same market draw on the same free liquidity, so their amounts don't add up.
- The other lenders in a market are the part of its supply the MetaMorpho vaults don't account for, such as Morpho Vault V2 adapters or direct lenders. They draw on the same free liquidity too.
- The borrow APR is each market's rate right after the exit. Morpho's adaptive rate model keeps raising it while utilization stays above its 90% target. This example doesn't move time forward to show that.
- The vault must be a MetaMorpho (Morpho Vault V1) vault on Ethereum. Morpho Vault V2 isn't supported.
- The environment stays up after a run so the links keep working. Delete it in the dashboard, or run with `--cleanup`.
