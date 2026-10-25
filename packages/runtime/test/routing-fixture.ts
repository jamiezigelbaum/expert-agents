import { validateAgentRoutingConfig } from '../src/core/agent-routing.ts';

export const TEST_AGENT_ROUTING = validateAgentRoutingConfig({
  research: {
    library: { bucket: 'fixture-shared-library', prefix: 'v1' },
    pageLibrary: { sourceId: 'research' },
  },
  history: {
    displayName: 'History Expert',
    library: { bucket: 'fixture-shared-library', prefix: 'v1' },
    pageLibrary: { sourceId: 'history' },
  },
});
