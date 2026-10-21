# 01 · Shared dev, qa and uat environments

How can a full-stack team (UI, backend and smart-contract developers, plus PMs) use Virtual Environments for testing in dev, qa and uat?

Stand up one persistent Tenderly Virtual Environment per environment. It forks Ethereum mainnet, so every dependency the app touches (tokens, protocols, oracle prices) is already there, with nothing to redeploy and no faucet. The whole team shares it through two endpoints and the dashboard:

| Persona | Endpoint | Why |
|---------|----------|-----|
| UI / frontend, backend | Public RPC | Standard JSON-RPC that behaves like production. |
| QA / automation, smart-contract developers | Admin RPC | Cheat codes seed state; deploy and verify contracts. |
| Product / PM | Dashboard explorer | Read transactions, traces and state without a wallet. |

The environment is keyed by its name (`acme-treasury-<env>`), so running the command again reuses the same RPC URLs. It's a long-lived staging environment, not a throwaway.

## Run

```bash
# the repo-root .env needs TENDERLY_ACCESS_KEY / TENDERLY_ACCOUNT / TENDERLY_PROJECT
npm install
npm run provision -- --env qa        # create or reuse the QA Environment
npm run provision -- --env uat       # a separate UAT Environment
npm run provision -- --env dev --fresh   # force a brand-new one
```

It prints the Public RPC to wire the app to, the Admin RPC for test seeding, and a dashboard link. The dashboard is the team's shared explorer, with the environment's transactions, contracts and state diffs.

## Files

- `provision.ts` is the CLI.
- `lib/testnet.ts` creates or reuses environments over the Virtual Environments REST API. It also has the cheat-code helpers (`fundNative`, `setErc20Balance`) and `deleteTestNets` for cleanup.
