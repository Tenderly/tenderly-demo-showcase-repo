# 003 · Safe batch rehearsal

Rehearses a Safe multisig batch for steakUSDC on a [Virtual Environment](https://docs.tenderly.co/virtual-environments/overview) forked from Ethereum, before anyone signs it. Each Safe transaction is first simulated from the Safe's address with [`tenderly_simulateBundle`](https://docs.tenderly.co/virtual-environments/interact/simulate-transactions), then executed through Steakhouse's curator Safe by impersonated owners, with [Admin RPC](https://docs.tenderly.co/virtual-environments/admin-rpc) time travel past the vault's timelock.

## Run

Needs the repo-root `.env` (see the root README).

```bash
npm install
npm run demo        # raises the FLHYon/USDC cap and fills the market after the timelock, RESULT PASS
npm run demo:fail   # fills it without raising the cap, the simulation reverts, RESULT FAIL and exit 1
```

## Options

| Flag | Default | Meaning |
|------|---------|---------|
| `--batch <file>` | `batches/raise-cap.json` | a vault and its Safe transactions (`submitCap`, `acceptCap`, `reallocate`) |
| `--block <n>` | `26242540` | the fork block, or `latest` |

## Example output

```
Tenderly  ·  Safe batch rehearsal
Raise the FLHYon/USDC cap and fill it, block 26,242,540

[1/4] Fork Ethereum
  [ok]   environment safe-rehearsal-20261029-070803, block 26,242,540, chain id 73571
  [ok]   steakUSDC: 65,835,531 USDC in 12 markets, timelock 7 days
  [ok]   curator Safe 0x827e…eCdB: Safe 1.4.1, 3 of 9 owners, next free nonce 339
…
[2/4] Safe transaction 1 of 2
  submitCap(FLHYon/USDC 86%, 20,000,000 USDC)
…
[3/4] Safe transaction 2 of 2, after the timelock
  [ok]   evm_increaseTime: 7 days + 60 s, block 26,242,544 at 2026-10-28 17:42 UTC
  acceptCap(FLHYon/USDC 86%)
  reallocate(cbBTC/USDC 86% 0x64d6 to 22,098,737, 11,027,128 to FLHYon/USDC 86%)
  [ok]   tenderly_simulateBundle: 2 calls succeed when sent from the Safe
  USDC                           before       after        change
  cap    FLHYon/USDC 86%         10,000,000   20,000,000   +10,000,000
  supply cbBTC/USDC 86% 0x64d6   33,125,865   22,098,737   -11,027,128
  supply FLHYon/USDC 86%         50           11,027,178   +11,027,128
  [ok]   2 owners approve, the 3rd executes: success
…
[4/4] Hashes for the signers
  [ok]   for Ethereum (chain id 1), after 1 transaction queued in Safe{Wallet}
  nonce 339    0xd419ed05b117b50b162d94017fd430e34f6906a31b97410f4ba79c9e08f182a6
  nonce 340    0x893d034947d26424bea3be27e2c974f922c57cc0413a3a33f1252b31f5f03e58

  [link] environment     https://dashboard.tenderly.co/<account>/<project>/testnets/<env>/instance/<instance>
  [link] transactions    https://dashboard.tenderly.co/<account>/<project>/testnets/<env>/instance/<instance>/activity/transactions
  [link] Safe tx 1       https://dashboard.tenderly.co/<account>/<project>/testnets/<env>/instance/<instance>/container/<vnet>/tx/0x9d0cc7e1c9749a250d0401331692b60aa62866452bf82938b830cf4c70c62a4a
  [link] Safe tx 2       https://dashboard.tenderly.co/<account>/<project>/testnets/<env>/instance/<instance>/container/<vnet>/tx/0x745c012c065379b07997c905e9fca559a4135a92620fee5dd889756f16256061

RESULT  PASS   2 Safe transactions simulated, then executed by 3 of 9 owners   15s
```

## Notes

- The simulation sends each call from the Safe's address, so a revert names the vault's own error, where the Safe's `execTransaction` returns only `GS013`. `npm run demo:fail` stops at `SupplyCapExceeded` because FLHYon/USDC holds 50 USDC with a 10,000,000 cap and the batch adds 11,000,000.
- The run needs no owner keys. It sends from the owners' addresses on the Admin RPC. The 2 lowest addresses call `approveHash`, then the 3rd calls `execTransaction`.
- Every block the run mines is pinned with [`tenderly_setNextBlockTimestamp`](https://docs.tenderly.co/virtual-environments/admin-rpc#tenderly_setnextblocktimestamp) to 1 s after the block before, from the fork block's time on (7 days + 60 s for the `evm_increaseTime` block), so every run prints the same amounts. `reallocate` takes target supplies computed at the fork block, and cbBTC/USDC earns interest during the timelock, so Safe transaction 2 moves 11,027,128 USDC instead of the batch file's 11,000,000.
- The hashes for the signers are each Safe transaction's EIP-712 hash (safeTxHash) for chain id 1 at the next free nonce, which comes after the Safe's nonce and any transactions queued in the Safe Transaction Service (a third-party API that Safe{Wallet} uses). If the service doesn't answer, the run uses the Safe's nonce at the fork block.
