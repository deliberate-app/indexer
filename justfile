# Show commands before running (helps debug failures)
set shell := ["bash", "-euo", "pipefail", "-c"]

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

# Run the indexer with its local docker stack. Hasura lives on :8090 - both
# variables must agree on that, and the metadata endpoint must be set explicitly
# because its default (:8080) collides with the dev kubo gateway.
dev:
    HASURA_EXTERNAL_PORT=8090 HASURA_GRAPHQL_ENDPOINT=http://localhost:8090/v1/metadata npx envio dev

# Stop the indexer's docker stack
dev-down:
    npx envio local docker down
