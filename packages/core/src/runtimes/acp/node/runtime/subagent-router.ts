import { runInThisContext } from 'node:vm';
import {
  SUBAGENT_ROUTER_EXPRESSION,
  type SubagentRouter,
} from '#runtimes/acp/api/subagent-routing';

/**
 * Köprüye gömülen aynı yönlendirme kaynağını değerlendirip saf fonksiyonları döndürür.
 * Değerlendirilen yalnızca pakette sabit olan güvenilir kaynaktır.
 */
export function createSubagentRouter(): SubagentRouter {
  return runInThisContext(SUBAGENT_ROUTER_EXPRESSION, {
    filename: 'orkestra-subagent-routing.js',
  }) as SubagentRouter;
}
