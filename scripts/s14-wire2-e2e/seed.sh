#!/usr/bin/env bash
# All SQL is executed inside this named local container, never via PGHOST/PGSERVICE.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
: "${OWNER_ID:?}" "${REAL_TOKEN_SHA256:?}" "${FIXTURE_TOKEN_SHA256:?}"
[[ "$OWNER_ID" =~ ^[0-9a-fA-F-]{36}$ && "$REAL_TOKEN_SHA256" =~ ^[0-9a-f]{64}$ && "$FIXTURE_TOKEN_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo 'invalid seed values' >&2; exit 2; }
[[ $(podman --remote=false inspect --format '{{.State.Running}}' supabase_db_w1c8e) == true ]] || { echo 'dedicated database is not running' >&2; exit 2; }
podman --remote=false exec -i supabase_db_w1c8e psql -h /var/run/postgresql -p 5432 -U postgres -d postgres -X -v ON_ERROR_STOP=1 -v w1c8e_local_only=1 -v owner_id="$OWNER_ID" -v real_token_sha256="$REAL_TOKEN_SHA256" -v fixture_token_sha256="$FIXTURE_TOKEN_SHA256" < "$here/seed.sql"
