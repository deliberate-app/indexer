# ArborVote Indexer

An [Envio HyperIndex](https://docs.envio.dev) indexer for the ArborVote contract. It folds the
contract's event stream into queryable domain entities - `Debate`, `Argument` (the tree, with
market reserves and tally impact), `Participant` (token balances), `Position` (share holdings),
and the append-only `Stake`/`Redemption` histories - so clients can read a whole debate
in one GraphQL query instead of RPC-traversing the tree leaf by leaf.

Every contract event carries the resulting state (reserves move additively, payouts arrive
pre-rounded), so the handlers mirror the debate without redoing any market math. The event set
is documented in `contracts/src/interfaces/IArborVote.sol`.

## Develop

```sh
just install   # npm install
just codegen   # regenerate types from config.yaml + schema.graphql
just test      # type-check + handler tests (in-memory, no database needed)
just dev       # run against the local anvil chain (docker: postgres + hasura)
```

`just dev` expects the frontend dev stack (`just dev-anvil` in `frontend/`) to be running: it
indexes chain 31337 at `http://127.0.0.1:8545` from block 0. Every `dev-anvil` run writes its
deployment's address into this repo's `.env` (`ENVIO_ARBORVOTE_ADDRESS`), which `config.yaml`
interpolates - so the index follows the newest deployment even when a reused anvil moves the
contract to a fresh nonce. Because the chain is ephemeral, so is the index: `just dev` wipes
and re-indexes from block 0 on every start (local chains are small; this takes seconds).
Hasura's GraphQL console comes up on http://localhost:8090 (moved off 8080, which the dev kubo
gateway occupies - the recipe pins both the container port and envio's metadata endpoint there;
local password `testing`).

The handler tests simulate event streams against an in-memory indexer - the lifecycle test
replays the same numbers as the contract unit tests (seed at 80%, rate down, redeem at a
profit), asserting that the folded entities match the chain exactly.

## Hosted service (Base Sepolia)

`config.base-sepolia.yaml` indexes the Base Sepolia deployment (chain 84532) via HyperSync -
no RPC endpoint needed. On [envio.dev](https://envio.dev)'s hosted service, with this repo
connected:

1. In the deployment's settings, set the **config file** to `config.base-sepolia.yaml`
   (branch `main`, root directory `.`).
2. After deploying the contracts (contracts README, "Deployment"), fill in the ArborVote
   address and its deployment block in the config and push - or keep the interpolation and
   set `ENVIO_ARBORVOTE_ADDRESS` in the **environment variables** tab instead.
3. Optionally set `ENVIO_PIN_IPFS_API` once a pinning node exists (see below).

Every push to `main` redeploys the indexer. The deployment's GraphQL endpoint (shown in the
hosted app) becomes the frontend's `VITE_INDEXER_URL`.

## Production pinning backstop

Argument texts are IPFS raw-leaves blocks whose sha-256 digests are public on-chain. When
`ENVIO_PIN_IPFS_API` is set (e.g. `http://127.0.0.1:5001`), the indexer re-pins every content
digest it sees - debate theses, added and altered arguments - on that kubo-compatible node, so
content availability never depends on the authoring client alone (see the frontend README,
"Production pinning strategy"). Pinning is idempotent and best-effort: a failure never stalls
indexing, and the next resync retries.

## Prerequisites

- [Node.js v22+](https://nodejs.org/en/download/current)
- [Docker](https://www.docker.com/products/docker-desktop/) (only for `just dev`, not for tests)
