# Expert Agents domain expert worker, as a container.
#
# The image ships the same artifact the systemd runbook installs: the
# self-contained worker bundle and deploy/ tree that `bun run package:deploy`
# produces (dist/deploy-package). There is no second build path; the runtime
# stage never runs bun install or bun run build and contains no repository
# source or dependency directories.
#
# The worker binds loopback by default (EXPERT_AGENTS_DOMAIN_EXPERT_HOST is
# 127.0.0.1) so it is reachable only from the network namespace the container
# shares with its consumer (a host network, or a pod/sidecar namespace); it is
# never published. All configuration is environment: see
# deploy/docker/domain-expert.container.env.example.

FROM oven/bun:1.3.14 AS package
WORKDIR /src
COPY package.json bun.lock tsconfig.json ./
COPY packages ./packages
COPY scripts/package-deploy.ts ./scripts/package-deploy.ts
COPY deploy ./deploy
RUN bun install --frozen-lockfile
RUN bun run package:deploy

FROM oven/bun:1.3.14-slim
# Fixed ids so a deployment can size tmpfs and bind mounts without inspecting
# the image (deploy/README.md, "Container image").
RUN groupadd --system --gid 10001 expert-agents \
  && useradd --system --uid 10001 --gid 10001 --home-dir /var/lib/expert-agents \
     --shell /usr/sbin/nologin expert-agents \
  && install -d -m 0755 -o root -g root /opt/expert-agents \
  && install -d -m 0750 -o expert-agents -g expert-agents /var/lib/expert-agents/domain-expert
COPY --from=package --chown=root:root /src/dist/deploy-package /opt/expert-agents/current
ENV EXPERT_AGENTS_DOMAIN_EXPERT_HOST=127.0.0.1 \
    EXPERT_AGENTS_DOMAIN_EXPERT_PORT=8040 \
    EXPERT_AGENTS_DOMAIN_EXPERT_DATA_DIR=/var/lib/expert-agents/domain-expert \
    EXPERT_AGENTS_DATA_DIR=/var/lib/expert-agents/domain-expert
WORKDIR /opt/expert-agents/current
USER expert-agents
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "/opt/expert-agents/current/deploy/docker/healthcheck.js"]
CMD ["bun", "/opt/expert-agents/current/packages/runtime/dist/server.js"]
