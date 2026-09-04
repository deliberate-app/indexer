# Deliberate Indexer

An [Envio HyperIndex](https://docs.envio.dev) indexer for the Deliberate contract. It folds the
contract's event stream into queryable domain entities - `Debate`, `Argument` (the tree, with
market reserves, earned fees, and its tallied rating), `Participant` (token balances), `Position`
(share holdings), and the append-only `Stake`/`Redemption`/`BountyFunding` histories - so clients
can read a whole debate in one GraphQL query instead of RPC-traversing the tree leaf by leaf.

Every contract event carries the resulting state (reserves move additively, payouts arrive
pre-rounded), so the handlers mirror the debate without redoing any market math. The event set
is documented in `contracts/src/interfaces/IDeliberate.sol`.

The text of a thesis or argument (1 to 256 bytes of UTF-8) arrives in the `DebateCreated`,
`ArgumentCreated` and `ArgumentAltered` events and is stored verbatim on the entity's `content`
field - an alteration replaces it. Nothing is fetched from anywhere else: the index is complete
from the event stream alone.

## Develop

```sh
just install   # npm install
just codegen   # regenerate types from config.local.yaml + schema.graphql
just test      # type-check + handler tests (in-memory, no database needed)
just dev       # run against the local anvil chain (docker: postgres + hasura)
```

One indexer covers every chain Deliberate is deployed to, from a single GraphQL endpoint. Entity
IDs open with the chain they happened on (`{chainId}_{debateId}`), because debate IDs restart at
zero on each chain, and `Debate.chainId` / `Argument.chainId` are what a client filters on. Adding
a chain is an entry under `chains` in the config: the contract, its ABI and its events are declared
once in the shared `contracts` block.

Two configs all the same: `config.yaml` (the default) lists the chains the Envio hosted service
indexes; `config.local.yaml` is the same indexer against the local anvil chain, separate for one
reason only - a chain served over a localhost RPC cannot be reached from the hosted service. The
`just` dev recipes point envio at the local config (`--config config.local.yaml` / `ENVIO_CONFIG`),
so plain `envio` commands still default to the hosted config.

`just dev` expects the frontend dev stack (`just dev-anvil` in `frontend/`) to be running: it
indexes chain 31337 at `http://127.0.0.1:8545` from block 0. Every `dev-anvil` run writes its
deployment's address into this repo's `.env` (`ENVIO_DELIBERATE_ADDRESS`), which `config.local.yaml`
interpolates - so the index follows the newest deployment even when a reused anvil moves the
contract to a fresh nonce. Because the chain is ephemeral, so is the index: `just dev` wipes
and re-indexes from block 0 on every start (local chains are small; this takes seconds).
Hasura's GraphQL console comes up on http://localhost:8090 rather than envio's default 8080: the
frontend dev tool reads the index there, so the recipe pins both the container port and envio's
metadata endpoint to it (local password `testing`).

The handler tests simulate event streams against an in-memory indexer - the lifecycle test
replays the same numbers as the contract unit tests (seed at 80%, rate down, redeem at a
profit), asserting that the folded entities match the chain exactly. `config.test.ts` guards
that the loaded config declares the chain the tests run against.

## Hosted service

The default `config.yaml` indexes every chain it lists - today Gnosis Chain (100) - via
HyperSync, no RPC endpoint needed. On [envio.dev](https://envio.dev)'s hosted service, with this repo
connected:

1. Leave the deployment's **config file** at the default `config.yaml` (branch `main`, root
   directory `.`); the hosted service picks it up automatically.
2. Each chain's Deliberate address and deployment block are in the config, copied from the
   contracts repo's broadcast record; a redeploy edits both and pushes.

Every push to `main` redeploys the indexer, and each deployment gets its own GraphQL endpoint -
whose id is envio-internal rather than the commit's sha, so it can only be read, not derived: from
the deployment page, or with `npx envio-cloud deployment endpoint <indexer> <commit> <organisation>`.

On the **hosted** frontend that endpoint goes into the server-side `INDEXER_UPSTREAM_URL`, which its
same-origin query proxy forwards to; the client calls the proxy (`/api/graphql`), which does not
change between deployments. A frontend running **locally** against this deployment has no proxy in
front of it, and points `VITE_INDEXER_URL` straight at the endpoint.

## Prerequisites

- [Node.js v22+](https://nodejs.org/en/download/current)
- [Docker](https://www.docker.com/products/docker-desktop/) (only for `just dev`, not for tests)

## Identity registries

`IdentityRegistryFactory` clones registries at runtime, so the indexer registers each allowlist from the
factory's `AllowlistRegistryCreated` event and folds its `MembershipSet` and `OwnershipTransferred` events
from then on. An `IdentityRegistry` row holds what a debate creator picks from (an allowlist by owner, a
Circles registry by anchor); a `Membership` row is one account's standing on one allowlist. The factory
address on Gnosis is a placeholder until `just deploy-registry-factory gnosis` runs in the contracts repo.
