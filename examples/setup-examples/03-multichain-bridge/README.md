# 03 · Multichain bridge

One [multichain Virtual Environment](https://docs.tenderly.co/virtual-environments/multichain/overview) forks Ethereum and Base with the [bridge module](https://docs.tenderly.co/virtual-environments/multichain/bridges) on. The script burns 100,000 USDC through Circle's CCTP V2 on Ethereum, and the bridge delivers the message to Base, where CCTP mints the USDC.

## Run

Needs the repo-root `.env` (see the root README).

```bash
npm install
npm run bridge
```

## Example output

```
Tenderly  ·  Multichain bridge
100,000 USDC from Ethereum to Base over CCTP V2

[1/4] Fork Ethereum and Base with the bridge module on
  [ok]   environment multichain-bridge-20261029-065909
  [ok]   Ethereum block 26,296,755, chain id 73571
  [ok]   Base block 53,233,901, chain id 73578453

[2/4] Set USDC balances
  [ok]   tenderly_setErc20Balance: 0x3333…3333 holds 100,000 USDC on Ethereum
  [ok]   0x3333…3333 holds 0 USDC on Base

[3/4] Burn on Ethereum
  [ok]   approve 100,000 USDC for TokenMessengerV2 0x28b5…cf5d
  [ok]   depositForBurn 100,000 USDC to 0x3333…3333 on domain 6 (Base), block 26,296,758
  [ok]   Ethereum balance 100,000 → 0 USDC

[4/4] Mint on Base
  [wait] up to 90 s for the bridge to relay the burn
  [ok]   100,000 USDC minted to 0x3333…3333 in Base block 53,233,903

  [link] environment     https://dashboard.tenderly.co/<account>/<project>/testnets/<env>/instance/<instance>
  [link] transactions    https://dashboard.tenderly.co/<account>/<project>/testnets/<env>/instance/<instance>/activity/transactions
  [link] bridges         https://dashboard.tenderly.co/<account>/<project>/testnets/<env>/instance/<instance>/bridges
  [link] burn tx         https://dashboard.tenderly.co/<account>/<project>/testnets/<env>/instance/<instance>/container/<vnet>/tx/0x970db809e515a969ee34b1c2e666cae56ff1c1ad0df961a2e72f6323de2397f3
  [link] mint tx         https://dashboard.tenderly.co/<account>/<project>/testnets/<env>/instance/<instance>/container/<vnet>/tx/0xc079fe8aef4450bf65b54578769ce2fab85ed17f1a89a156ae16f5db344f9e82

RESULT  PASS   Base balance 0 → 100,000 USDC   4s
```

## Notes

- The bridge relays CCTP V2. A burn through the CCTP V1 TokenMessenger goes through on Ethereum, but nothing is minted on Base.
- The burn is a standard CCTP transfer (finality threshold 2000) with a max fee of 0 USDC, so Base mints the full 100,000 USDC.
- The run sets the USDC of 0x3333…3333 on Base to 0 before the burn, so the result doesn't depend on what the address already holds there.
- The run exits 1 if the mint doesn't reach Base within 90 s.
