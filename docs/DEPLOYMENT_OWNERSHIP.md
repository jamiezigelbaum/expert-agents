# Deployment ownership

Expert Agents owns the worker, plugin, library ingestion and retrieval,
provisioning machinery, packaging, and their issue tracker. Each expert's
workspace and source holdings live outside this machinery repository. Consumers
use the packaged plugin or the worker's public HTTP contract.

The standalone installation contract is [deploy/README.md](../deploy/README.md).
The installation owner supplies configuration through the documented
`EXPERT_AGENTS_*` environment fields and a task-scoped credential adapter. No
other product's environment, source checkout, credential registry, or refresh
script is a prerequisite.

Shared OpenClaw Gateway configuration and lifecycle belong to platform
operations. Use that installation's approved native configuration, validation,
credential-readiness, restart, and rollback procedure. Keep this host procedure
in the deployment repository, independently of any plugin's source checkout.
Worker updates use this repository's packaged artifacts and service runbook.

Before retiring an older worker, verify the configured plugin endpoint and
the authenticated tool response contract, preserve the existing release and
configuration for rollback, and check that every enabled expert route still
answers from its existing corpus. Do not recreate corpora or copy holdings as
part of a code migration. Retire a service only after its consumers have moved;
a successful source build is not installed-routing evidence.
