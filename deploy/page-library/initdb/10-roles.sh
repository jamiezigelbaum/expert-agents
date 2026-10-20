#!/bin/sh
# Runs once, on a fresh data volume (the postgres image's initdb hook): the
# worker's serving and ingest logins. Tables and grants come from `migrate`
# (scripts/page-index.ts), which runs on every start. A role whose password is
# unset is not created, so a database-only deployment needs neither.
set -eu
for pair in "page_reader:${PAGE_READER_PASSWORD:-}" "page_writer:${PAGE_WRITER_PASSWORD:-}"; do
  role="${pair%%:*}"
  password="${pair#*:}"
  [ -n "$password" ] || continue
  psql -v ON_ERROR_STOP=1 -v role="$role" -v password="$password" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE ROLE :"role" LOGIN PASSWORD :'password';
SQL
done
