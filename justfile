# Show commands before running (helps debug failures)
set shell := ["bash", "-euo", "pipefail", "-c"]
# .env carries the deployment handoff (ENVIO_ARBORVOTE_ADDRESS, ENVIO_PIN_IPFS_API),
# written by the frontend dev tool; loading it here makes every recipe see it.
set dotenv-load := true

# Hasura lives on :8090 - the default (:8080) collides with the dev kubo gateway,
# and envio's metadata client must be pointed there explicitly.
hasura := "HASURA_EXTERNAL_PORT=8090 HASURA_GRAPHQL_ENDPOINT=http://localhost:8090/v1/metadata"

# Default recipe
default:
    @just --list

# Install dependencies
install:
    npm install

# Generate types from config.yaml and schema.graphql
codegen:
    npx envio codegen

# Type-check and run the handler tests (in-memory, no database needed)
test:
    npx tsc --noEmit
    npm test

# Run the indexer against the local anvil chain: containers up, index wiped
# (the chain is ephemeral - so is the index), then indexing from block 0.
dev:
    {{ hasura }} npx envio local docker up
    {{ hasura }} npx envio local db-migrate setup
    {{ hasura }} ENVIO_TUI_OFF=true npx envio start

# Stop the indexer's docker stack
dev-down:
    npx envio local docker down
