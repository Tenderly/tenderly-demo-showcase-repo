# 004 · Policy gate

An agent plans seven intents, each a deposit into steakUSDC or a borrow from Morpho's WBTC/USDC market, on a [Virtual Environment](https://docs.tenderly.co/virtual-environments/overview) forked from Ethereum at block 26,242,540. It checks each one against four rules and dry-runs it with [`tenderly_simulateBundle`](https://docs.tenderly.co/virtual-environments/interact/simulate-transactions), and sends it only when both pass.

## Run

Needs the repo-root `.env` (see the root README).

```bash
npm install
npm run demo
```

## Example output

```
Tenderly  ·  Policy gate
steakUSDC and Morpho's WBTC/USDC market at block 26,242,540

[1/3] Fork Ethereum
  [ok]   environment policy-gate-20261029-070655, block 26,242,540, chain id 73571
  [ok]   tenderly_setErc20Balance: agent 0xC017…0A80 holds 1,500,000 USDC and 300 WBTC
…

[2/3] Check, dry-run, send
  screening    no sender or receiver on the list: 0xd90e…F31b (Tornado Cash router)
  supply cap   deposits into steakUSDC: at most 1,000,000 USDC in total
  LTV buffer   borrows: position LTV at most 77.4%, 90% of the 86% liquidation LTV
  oracle       borrows: market oracle within 2% of Chainlink BTC/USD (0.2% apart now)
  dry run      tenderly_simulateBundle: none of the intent's transactions reverts
  #  intent                                   rules       dry run  outcome
  1  deposit 250,000 USDC                     pass        ok       sent
  2  deposit 100,000 USDC for 0xd90e…F31b     screening   ok       receiver on the list
  3  deposit 900,000 USDC                     supply cap  ok       total 1,150,000 USDC
  4  supply 100 WBTC, borrow 3,600,000 USDC   pass        ok       sent
  5  borrow 3,200,000 USDC                    LTV buffer  ok       LTV 80.7%
  6  supply 200 WBTC, borrow 12,000,000 USDC  pass        reverts  insufficient liquidity
     tenderly_setStorageAt: WBTC/BTC feed set to 0.85, oracle 71,749 USDC per WBTC
  7  borrow 500,000 USDC                      oracle      ok       15.0% off BTC/USD
     WBTC/BTC feed back to 0.99816, oracle 84,255 USDC per WBTC

[3/3] Wallet and position
  [ok]   wallet 4,850,000 USDC = 1,500,000 - 250,000 (intent 1) + 3,600,000 (intent 4)
  [ok]   wallet 200 WBTC = 300 - 100 (intent 4)
  [ok]   position 100 WBTC collateral, 3,600,000 USDC debt, LTV 42.7%

  [link] environment     https://dashboard.tenderly.co/<account>/<project>/testnets/<env>/instance/<instance>
  [link] transactions    https://dashboard.tenderly.co/<account>/<project>/testnets/<env>/instance/<instance>/activity/transactions
  [link] deposit tx      https://dashboard.tenderly.co/<account>/<project>/testnets/<env>/instance/<instance>/container/<vnet>/tx/0x30eed9630fc23c013d84b3d8933ffb00b4c272cb643317b428c3adcd2e8239be
  [link] supply tx       https://dashboard.tenderly.co/<account>/<project>/testnets/<env>/instance/<instance>/container/<vnet>/tx/0x196c96e38a897f1b09fabb416c5ff7e4d8c04b1c76212f372f2b95fc7e646edb
  [link] borrow tx       https://dashboard.tenderly.co/<account>/<project>/testnets/<env>/instance/<instance>/container/<vnet>/tx/0xb86fc9f612447b18ab9f82f1fef8b8f4c85f0102e8652047b4ed70379b96a16c

RESULT  PASS   7 of 7 as expected: 2 sent, 4 blocked by a rule, 1 by its dry run   12s
```

## Notes

- The intents, their expected outcomes and the rule limits are at the top of `policy-gate.ts`. The rule checks and the WBTC/BTC feed write for intent 7 ([`tenderly_setStorageAt`](https://docs.tenderly.co/virtual-environments/admin-rpc)) are in `lib/gate.ts`.
- Every intent is dry-run, including the ones a rule blocks. Morpho would accept intent 5, whose 80.7% LTV is under its 86% liquidation LTV, and the LTV buffer stops it. Intent 6 passes every rule, but after intent 4 the market has 9,339,680 USDC free (12,939,680 - 3,600,000), less than the 12,000,000 it asks for.
