# 002 · Aave crash liquidation

Forks Ethereum into a [Virtual Environment](https://docs.tenderly.co/virtual-environments/overview) at a pinned block, points Aave V3's WETH price at a mock feed with [Admin RPC cheat codes](https://docs.tenderly.co/virtual-environments/admin-rpc), and counts the WETH-collateral positions that fall below health factor 1 when WETH drops 10, 20 and 30%. Then it liquidates the position with the lowest health factor as an impersonated liquidator and checks the repaid debt, the seized collateral and the bonus against the token balance changes.

## Run

Needs the repo-root `.env` (see the root README).

```bash
npm install
npm run demo
```

## Options

| Flag | Default | Meaning |
|------|---------|---------|
| `--block` | `26290000` | fork block, or `latest` |
| `--drop` | `30` | the drop to liquidate the worst position at: `10`, `20` or `30` |

## Example output

```
Tenderly  ·  Aave crash liquidation
Aave V3 on Ethereum at block 26,290,000: WETH price -10%, -20%, -30%

[1/5] Fork Ethereum
  [ok]   environment aave-crash-20261029-071913, block 26,290,000, chain id 73571

[2/5] Find WETH-collateral borrowers
  …
  [ok]   322 of those owe $10,000 or more, $233,171,531 in total

[3/5] Point Aave's WETH price at a mock
  …
  [ok]   tenderly_setStorageAt: AaveOracle prices WETH from the mock, at $2,362.67

[4/5] Drop the WETH price
  [ok]   tenderly_setStorageAt: mock price for each drop, then 322 health factors read
  HF is the health factor. Below 1, anyone can liquidate the position.
  drop   WETH price   HF < 1    their debt
  -10%    $2,126.40       11    $1,635,407
  -20%    $1,890.14       53    $5,480,693
  -30%    $1,653.87      105   $72,884,328

[5/5] Liquidate the worst position at -30%
  …
  debt         11,313.01 USDC: 9,406.50 repaid, 1,906.51 bad debt, 0 left
  collateral   5.9703 WETH: 5.9134 to the liquidator, 0.0569 fee to Aave, 0 left
  bonus        $376 (4.0%): $9,780 of WETH for $9,404 of USDC
               Aave prices USDC at $0.9997, so 9,406.50 USDC is $9,404
  health       0.72 before, no debt after

  [file] out/report.json  positions, health factors per drop, the liquidation
  [link] environment     https://dashboard.tenderly.co/<account>/<project>/testnets/<env>/instance/<instance>
  [link] transactions    https://dashboard.tenderly.co/<account>/<project>/testnets/<env>/instance/<instance>/activity/transactions
  [link] liquidation tx  https://dashboard.tenderly.co/<account>/<project>/testnets/<env>/instance/<instance>/container/<vnet>/tx/0x872a472042d7dbf31bd7e83e8027e498dc75da1edc8420eb8a80f62694139b3b

RESULT  PASS   WETH -30%: health factor below 1 for 105 of 322, worst liquidated   28s
```

## Notes

- Only WETH's oracle price moves. wstETH, weETH and other ETH-based collateral keep their prices, so positions that hold them lose less health than they would if ETH itself fell.
- Borrowers come from the Pool's Borrow logs of the 50,000 blocks (about a week) up to the fork block. Positions with less than $10,000 of debt are left out, and `out/report.json` has each one's health factor at each drop.
- The liquidator repays the largest debt that isn't WETH and receives WETH plus a 5% bonus, minus the 20% of the bonus that goes to Aave's treasury. Debt left with no collateral is written off as bad debt (the `DeficitCreated` event). Dollar values use Aave's oracle prices, so USDC counts at a little under $1.
- Interest accrues over the seconds a run takes, so cents can differ between runs. The liquidation block's time is pinned and the reads before it use the pending block, so the run can require the debt and the WETH to add up to within a millionth.
