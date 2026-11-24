import { createController, type Controller } from '@orkestra/wire/rpc';
import { agentActivityContract } from '../api/contract';
import type { AgentActivityFeed } from './agent-activity-feed';

/**
 * Yalnızca uzak (mobil) yüzeye eklenir; masaüstü renderer manifestinde yer almaz.
 * Bkz. `remote-access/node/remote-surface.ts` (izin listesi) ve `remote-access.md` §7.
 */
export function createAgentActivityWireController(
  feed: Pick<AgentActivityFeed, 'snapshot' | 'eventsHost'>
): Controller {
  return createController(agentActivityContract, {
    getSnapshot: () => feed.snapshot(),
    events: feed.eventsHost(),
  });
}
