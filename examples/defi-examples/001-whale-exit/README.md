# 001 · Whale exit

Forks Ethereum at block 26,242,540 into a [Virtual Environment](https://docs.tenderly.co/virtual-environments/overview) and has the largest depositor of the Morpho vault steakUSDC withdraw everything. The exit is rehearsed with [`tenderly_simulateBundle`](https://docs.tenderly.co/virtual-environments/interact/simulate-transactions), sent with [`eth_sendTransaction`](https://docs.tenderly.co/virtual-environments/admin-rpc#eth_sendtransaction) from the depositor's address without its key, and the vault, its markets and the other vaults lending there are compared before and after.

## Run

Needs the repo-root `.env` (see the root README).

```bash
npm install
npm run demo        # RESULT PASS
npm run demo:fail   # the same exit with a 60% rule: RESULT FAIL, exit code 1
```

## Options

| Flag | Default | Meaning |
|------|---------|---------|
| `--vault` | steakUSDC | a MetaMorpho (Morpho Vault V1) vault on Ethereum |
| `--block` | `26242540` | the fork block, or `latest` |
| `--holder` | the largest depositor | the depositor who exits |
| `--min-exit-pct` | `25` | the share of deposits the other depositors must still be able to withdraw |

## Example output

```
Tenderly  ·  Whale exit
steakUSDC at block 26,242,540

[1/5] Fork Ethereum
  [ok]   environment whale-exit-20261029-070833, block 26,242,540, chain id 73571
  [ok]   tenderly_setNextBlockTimestamp: new blocks keep the fork's date, 2026-10-21
         so amounts are the same every run

[2/5] Read the vault
  [ok]   Steakhouse USDC (steakUSDC), 12 markets in the withdraw queue
  [ok]   65,835,531 USDC deposited, 48,716,863 withdrawable now (74.0%)

[3/5] Find the largest depositor
  [ok]   1,183 holders from 48,109 Transfer logs, balances add up to the total supply
  [ok]   0x334F…2A7b holds 29,333,972.881943 USDC, 44.6% of shares
…
[4/5] Withdraw everything
  [ok]   tenderly_simulateBundle: the redeem succeeds and draws on 1 market
  [ok]   eth_sendTransaction: the redeem, sent as 0x334F…2A7b without its key
  [ok]   paid 29,333,972 USDC; 0.881943 USDC stays in the vault

[5/5] After the exit
  market (USDC)           pulled       free liquidity           utilization    borrow APR
  cbBTC/USDC 86% 0x64d6   29,333,972   34,384,427 → 5,050,455   90.0 → 98.4%   4.7 → 16.7%
…
  vault (USDC)                 deposits after   withdrawable              % of deposits
  steakUSDC                    36,501,559       48,716,863 → 19,382,891   74.0 → 53.1%
  Hakutora USDC                14,881,715       14,881,715 → 5,050,455    100.0 → 33.9%
…
  [file] out/report.json  exact amounts, the 5 largest holders and 22 other vaults
  [link] environment     https://dashboard.tenderly.co/<account>/<project>/testnets/<env>/instance/<instance>
  [link] transactions    https://dashboard.tenderly.co/<account>/<project>/testnets/<env>/instance/<instance>/activity/transactions
  [link] exit tx         https://dashboard.tenderly.co/<account>/<project>/testnets/<env>/instance/<instance>/container/<vnet>/tx/0x0c022fbc3cdd880db7b7904c233d813a38a9ccb3180c809e4e175c89233ff902

RESULT  PASS   exit paid, others can withdraw 53.1% (rule 25%)   25s
```

## Notes

- [`tenderly_setNextBlockTimestamp`](https://docs.tenderly.co/virtual-environments/admin-rpc#tenderly_setnextblocktimestamp) gives the exit block the fork block's time plus 1 s, and later blocks stay on that date. Reads before the exit use the pending block, so every run prints the same numbers.
- The exit asks for a whole number of USDC so the tables add up, and the 0.881943 USDC left over stays in the vault. The run fails if the printed amounts don't add up.
- Withdrawable is the vault's supply in each market, capped by the market's free liquidity, summed over the withdraw queue. Vaults lending in the same market share its free liquidity, so their amounts don't add up.
- The vaults are MetaMorpho (Morpho Vault V1) vaults, found in the factories' logs. Vault V2 lends through adapters, so its supply counts under other lenders.
