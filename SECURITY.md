# Security

Report vulnerabilities through GitHub's private vulnerability reporting
("Report a vulnerability" on this repository's Security tab). Do not open a
public issue for a suspected vulnerability.

Include the affected component (worker, plugin, factory, library tooling), the
revision, reproduction steps, and the impact you observed. You will receive an
acknowledgement, and fixes are released as soon as they are verified.

The worker holds cloud credentials and executes bounded acquisition and
ingestion. Reports about credential exposure, sandbox or allowlist bypass,
path traversal in library handling, and authentication of the worker's HTTP
interface are especially welcome.
