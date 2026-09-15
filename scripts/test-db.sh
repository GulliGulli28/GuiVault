#!/usr/bin/env bash
# Démarre (ou arrête avec `stop`) le Postgres jetable des tests d'intégration.
#   scripts/test-db.sh && cargo test
set -euo pipefail
NAME=guivault-test-pg
if [[ "${1:-}" == "stop" ]]; then
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    exit 0
fi
if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
    docker run -d --rm --name "$NAME" -p 55432:5432 \
        -e POSTGRES_PASSWORD=test -e POSTGRES_USER=guivault -e POSTGRES_DB=guivault_test \
        postgres:16-alpine >/dev/null
    for _ in $(seq 1 30); do
        docker exec "$NAME" pg_isready -U guivault -d guivault_test >/dev/null 2>&1 && break
        sleep 1
    done
fi
echo "GUIVAULT_TEST_DATABASE_URL=postgres://guivault:test@localhost:55432/guivault_test"
