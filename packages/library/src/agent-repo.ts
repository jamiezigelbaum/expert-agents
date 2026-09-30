/**
 * Required ignore rules for every expert repository and legacy workspace seed.
 *
 * This constant lives in the shared deterministic library so provisioning and
 * the runtime bootstrap cannot drift on which runtime-only path classes must
 * never be committed.
 */
export const AGENT_REPO_GITIGNORE = `# Never commit runtime secret material or local caches.
openclaw-workspace-state.json
*.token
.env
.env.*
*.sqlite
sessions/
transcripts/
memory/archive/
.secrets/
.openclaw/
.openclaw-cli-images/
media/
.cache/
node_modules/
`;
