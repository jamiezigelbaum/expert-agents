#!/usr/bin/env bash
# Prove deploy/page-library/compose.yaml stands up a working library from
# nothing on any Docker host: the image builds, the roles are made, migrate
# grants them, a tree assembled elsewhere is imported with the bundled CLI,
# and the worker serves its catalog and pages from the database alone (its
# route names no tree). Everything runs under a throwaway project name and is
# removed on exit. No Google, Voyage or OCR call is made.
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
compose_dir="$root/deploy/page-library"
# The tree is bind-mounted, so the work directory must be visible to the Docker
# daemon (on a VM-backed Docker, a shared path such as one under $HOME).
work="$(mktemp -d "${PAGE_LIBRARY_SMOKE_TMPDIR:-${TMPDIR:-/tmp}}/page-library-smoke.XXXXXX")"
project="plsmoke$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
hex() { od -An -N24 -tx1 /dev/urandom | tr -d ' \n'; }
token="smoke-$(hex)"
pg_port="$((20000 + RANDOM % 20000))"
worker_port="$((pg_port + 1))"

cat > "$work/page-library.env" <<EOF
PAGE_LIBRARY_PROJECT=$project
PAGE_LIBRARY_PG_PASSWORD=$(hex)
PAGE_READER_PASSWORD=$(hex)
PAGE_WRITER_PASSWORD=$(hex)
PAGE_LIBRARY_PG_BIND=127.0.0.1:$pg_port
PAGE_LIBRARY_WORKER_BIND=127.0.0.1:$worker_port
PAGE_LIBRARY_WORKER_ENV=$work/worker.env
PAGE_LIBRARY_PG_SHARED_BUFFERS=128MB
EXPERT_AGENTS_IMAGE=expert-agents-domain-expert:page-library-smoke
EOF
cat > "$work/worker.env" <<EOF
EXPERT_AGENTS_DOMAIN_EXPERT_AUTH_TOKEN=$token
EXPERT_AGENTS_DOMAIN_EXPERT_VOYAGE_API_KEY=smoke-unused
EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_ACCESS_TOKEN=smoke-unused
EXPERT_AGENTS_DOMAIN_EXPERT_AGENTS_JSON={"smoke-expert":{"library":{"bucket":"example-library","prefix":"v2/books"},"pageLibrary":{"sourceId":"smoke-books"}},"smoke-public":{"library":{"bucket":"example-library","prefix":"v2/books"},"pageLibrary":{"sourceId":"smoke-books"},"disclosure":{"bounds":{"maxQuoteChars":20,"maxSourceCoveragePerSession":0.5}}}}
EOF

# A one-book tree, as scripts/library-pages.ts assemble writes it.
mkdir -p "$work/tree/books/smoke-book-aaaaaa"
cat > "$work/tree/catalog.json" <<'EOF'
{"schemaVersion":1,"books":[{"book":"smoke-book-aaaaaa","title":"Smoke Book","creator":"A. Writer","kind":"pages","units":1,"first_unit":"p0001","last_unit":"p0001","figures":0,"objects":["aaaa"],"sources":["gs://example-library/v2/books/smoke.pdf"]}]}
EOF
cat > "$work/tree/books/smoke-book-aaaaaa/p0001.md" <<'EOF'
---
title: "A. Writer, Smoke Book — p.1"
book: "smoke-book-aaaaaa"
unit: "p0001"
source: "gs://example-library/v2/books/smoke.pdf"
source_page: 1
---
The first page of the smoke book, served from the database.
EOF
chmod -R a+rX "$work/tree"

dc() { docker compose --project-directory "$compose_dir" -f "$compose_dir/compose.yaml" --env-file "$work/page-library.env" --profile worker "$@"; }
cleanup() {
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

dc build worker
dc up -d --wait

# Ingest on "another host": the bundled CLI, a tree mounted read-only, the database over the network.
dc run --rm --no-deps -v "$work/tree:/tree:ro" migrate \
  bun /opt/expert-agents/current/packages/runtime/dist/page-index.js import --source smoke-books --tree /tree

call() {
  curl -sS -H "authorization: Bearer $token" -H 'content-type: application/json' \
    -d "{\"tool\":\"domain_library\",\"params\":$1}" "http://127.0.0.1:$worker_port/v1/domain"
}
fail() { echo "SMOKE FAILED: $1" >&2; dc logs worker >&2 || true; exit 1; }

# check <json> <python expression over d>: the expression must be true.
check() { python3 -c 'import json,sys; d=json.loads(sys.argv[1]); sys.exit(0 if eval(sys.argv[2]) else 1)' "$1" "$2"; }

health="$(curl -fsS -H "authorization: Bearer $token" "http://127.0.0.1:$worker_port/v1/health")"
check "$health" '[(x["domain_id"], x["store"], x["catalog"], x["books"], x["index"]["units"]) for x in d["page_library"]["domains"]] == [("smoke-expert","database","ready",1,1), ("smoke-public","database","ready",1,1)]' \
  || fail "health does not report two ready database routes on one library: $health"
catalog="$(call '{"domain_id":"smoke-expert","action":"catalog"}')"
check "$catalog" '[b["book"] for b in d["books"]] == ["smoke-book-aaaaaa"]' || fail "catalog: $catalog"
page="$(call '{"domain_id":"smoke-expert","action":"read","slug":"books/smoke-book-aaaaaa/p0001"}')"
check "$page" 'd["text"] == "The first page of the smoke book, served from the database." and d["cite"] == "A. Writer, Smoke Book, p.1"' || fail "read: $page"
bounded="$(call '{"domain_id":"smoke-public","action":"read","slug":"books/smoke-book-aaaaaa/p0001","session_id":"smoke"}')"
check "$bounded" 'len(d["text"]) <= 20 and d["text"].startswith("The first")' || fail "the bounded route did not bound the page: $bounded"
# The serving login reads, never writes.
dc exec -T postgres psql -U pages -d pages -tAc "SELECT has_table_privilege('page_reader','page_units','INSERT'), has_table_privilege('page_reader','page_books','SELECT'), has_table_privilege('page_writer','page_books','DELETE')" \
  | grep -qx 'f|t|t' || fail "role grants are not reader-only / writer-rows"
echo "page library compose smoke passed"
