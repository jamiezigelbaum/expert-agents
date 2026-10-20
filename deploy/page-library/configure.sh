#!/bin/sh
# Configure a freshly initialised GBrain as a read-only library index: Voyage
# rerank-3 on, and everything that writes back, extracts with an LLM, boosts
# by personal-brain signals or upgrades itself off. Idempotent.
# usage (on the host, in this directory): ./configure.sh <source-id>
set -eu
SOURCE="${1:?usage: configure.sh <source-id>}"
gb() { docker compose --env-file page-library.env run --rm -T gbrain "$@"; }
gb apply-migrations --yes --no-autopilot-install
for kv in \
  search.reranker.enabled=true \
  search.reranker.model=voyage:rerank-3 \
  search.mode=balanced \
  search.expansion=false \
  search.cache.enabled=false \
  search.title_boost=1.0 \
  search.graph_signals=false \
  search.intentWeighting=false \
  search.relational_retrieval=false \
  search.relational_planner=false \
  search.contextual_retrieval=none \
  memory.auto_writeback=off \
  sync.write_through=false \
  facts.extraction_enabled=false \
  auto_chronicle=false \
  autopilot.auto_drain.enabled=false \
  self_upgrade.mode=off \
  mcp.result_rows=full
do
  gb config set "${kv%%=*}" "${kv#*=}"
done
gb sources add "$SOURCE" --path /library --name "$SOURCE" --no-federated --force
gb sources list
