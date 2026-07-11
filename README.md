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
