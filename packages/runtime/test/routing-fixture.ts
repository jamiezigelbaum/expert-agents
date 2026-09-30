import { validateAgentRoutingConfig } from '../src/core/agent-routing.ts';

export const TEST_AGENT_ROUTING = validateAgentRoutingConfig({
  research: {
    library: { bucket: 'fixture-shared-library', prefix: 'v1' },
    targetCorpusDisplayName: 'research-library',
  },
  history: {
    displayName: 'History Expert',
    library: { bucket: 'fixture-shared-library', prefix: 'v1' },
    targetCorpusDisplayName: 'history-library',
    retrieval: { topK: 18, contextLimit: 7, reranker: 'off', multiQuery: false },
  },
});
