# 03 · Multichain environments and bridges

What are multichain Virtual Environments, and how do they work with bridges?

One Virtual Environment can span several networks (Ethereum, Base, Arbitrum and others), each forked at its own block. With the bridge module on, Tenderly relays cross-chain messages between those networks. It watches for the source event and completes the destination side, so you can test a cross-chain flow end to end without running relayers.

| Protocol | Source event | Destination delivery |
|----------|--------------|----------------------|
| Chainlink CCIP | `CCIPMessageSent` | `manuallyExecute` |
| LayerZero | `PacketSent` | `lzReceive` |
| Across | `V3FundsDeposited` | destination fill |
| CCTP V2 (native USDC) | `MessageSent` / `DepositForBurn` | relayed mint |

The relay mode is `autoRelay`, which relays right away, or `delayedRelay`, which adds a configurable delay to test latency.

## Run

```bash
npm install
npm run bridge
```

```
Initiated cross-chain transfer on Ethereum: 0x…
  bridge event: MessageTransmitterV2 MessageSent (the message Tenderly relays)
  bridge event: CCTP V2 DepositForBurn
    amount             : 100,000 USDC
    destinationDomain  : 6 (Base)
    mintRecipient      : 0x0000…3333
    finality threshold : 2000 (standard)

Waiting for Tenderly auto-relay to deliver on Base ...

✔ Auto-relay delivered 100,000 USDC on Base in about 2.1 s (balance now 100,035 USDC).
```

`multichain-bridge.ts` creates (or reuses) one environment over Ethereum and Base with the bridge module on. It seeds USDC and gas on Ethereum with cheat codes, sends a CCTP V2 transfer (`approve`, then `depositForBurn`), decodes the bridge events the relay listens for, and waits for the USDC to be minted on Base. It exits 1 if the mint doesn't land within 90 seconds.

The bridge module doesn't relay the older CCTP V1 contracts. A burn through V1 goes through on Ethereum, but nothing is minted on Base, so this example uses V2.

The dashboard's Bridge view shows each relayed message.
