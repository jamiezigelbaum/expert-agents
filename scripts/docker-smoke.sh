#!/usr/bin/env bash
# Build the domain expert worker image and prove it boots with networking
# disabled: the boot line appears, health answers over loopback with the
# bearer, an unauthenticated request is refused, the process is unprivileged,
# and the documented public-expert routing shape loads as one agent route.
# No Google call is possible (--network none); health must say so honestly.
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
image="${1:-expert-agents-domain-expert:smoke}"
name="expert-agents-smoke-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
token="smoke-$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
routing='{"public-expert":{"displayName":"Public Expert","library":{"bucket":"example-shared-library","prefix":"library/v1"},"targetCorpusDisplayName":"example-shared-corpus","retrieval":{"multiQuery":true,"reranker":"rank-service"},"disclosure":{"excludedSources":[]}}}'

docker build --tag "$image" "$root"

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$name" \
  --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,mode=1777 \
  --tmpfs /var/lib/expert-agents/domain-expert:rw,noexec,nosuid,nodev,uid=10001,gid=10001,mode=0700 \
  -e EXPERT_AGENTS_DOMAIN_EXPERT_AUTH_TOKEN="$token" \
  -e EXPERT_AGENTS_GCP_PROJECT=smoke-project \
  -e EXPERT_AGENTS_DOMAIN_EXPERT_GOOGLE_METADATA_TOKEN=1 \
  -e EXPERT_AGENTS_DOMAIN_EXPERT_AGENTS_JSON="$routing" \
  "$image" >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$name" bun /opt/expert-agents/current/deploy/docker/healthcheck.js >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done
if [[ "${ready:-0}" != "1" ]]; then
  echo "SMOKE FAILED: the worker did not become healthy" >&2
  docker logs "$name" >&2 || true
  exit 1
fi

uid="$(docker exec "$name" id -u)"
[[ "$uid" == "10001" ]] || { echo "SMOKE FAILED: worker runs as uid $uid, expected 10001" >&2; exit 1; }

for _ in $(seq 1 20); do
  logs="$(docker logs "$name" 2>&1)"
  if grep -Fq 'Expert Agents domain expert worker listening on http://127.0.0.1:8040/v1' <<<"$logs"; then
    boot_logged=1
    break
  fi
  sleep 0.1
done
if [[ "${boot_logged:-0}" != "1" ]]; then
  echo "SMOKE FAILED: boot line missing" >&2
  printf '%s\n' "$logs" >&2
  exit 1
fi

# Assertions run inside the container so the token stays in its environment.
docker exec "$name" bun -e '
const token = process.env.EXPERT_AGENTS_DOMAIN_EXPERT_AUTH_TOKEN;
const base = "http://127.0.0.1:8040/v1";
const health = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${token}` } });
const body = await health.json();
const failures = [];
if (health.status !== 200) failures.push(`health status ${health.status}`);
if (body.kind !== "domain_expert_health" || body.reachable !== true) failures.push("health document shape");
if (body.configured.agent_routes !== 1) failures.push(`agent_routes ${body.configured.agent_routes}`);
if (body.configured.google !== false) failures.push("google must not read as configured with networking disabled");
if (body.configuration_status.google_credentials !== "unreadable") failures.push(`google_credentials ${body.configuration_status.google_credentials}`);
const anonymous = await fetch(`${base}/health`);
if (anonymous.status !== 401) failures.push(`unauthenticated health status ${anonymous.status}`);
const wrong = await fetch(`${base}/health`, { headers: { authorization: "Bearer not-the-token" } });
if (wrong.status !== 401) failures.push(`wrong-token health status ${wrong.status}`);
if (failures.length) { console.error("SMOKE FAILED: " + failures.join("; ")); process.exit(1); }
console.log(JSON.stringify({ ok: true, image: process.env.HOSTNAME ? "container" : "unknown", agentRoutes: body.configured.agent_routes, network: "none", unauthenticatedRefused: true, uid: 10001 }));
'
