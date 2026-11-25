/**
 * One calm line saying why a message waits in the queue instead of joining the running turn
 * (`QueuedPrompt.queueReason` from the ACP runtime). Unknown or missing reasons return null, so
 * the band keeps its usual text. English here; Turkish via tooling/localization/ui-tr.json.
 */
export function queueReasonText(reason: string | undefined, agentName?: string): string | null {
  const name = agentName?.trim() || 'The agent';
  switch (reason) {
    case 'antigravity-orchestrator':
      return 'In Orchestrator mode Antigravity takes the message when the work is done.';
    case 'antigravity-stream-json':
      return 'In this mode Antigravity takes new messages only when the work is done.';
    case 'no-steering':
      return `${name} cannot take messages while it works; it is sent when the work is done.`;
    case 'background-task':
      return 'A background task is still running; the message is sent when it ends.';
    case 'awaiting-permission':
      return 'A permission request is open; the message is sent when the turn ends.';
    case 'connecting':
      return 'The agent is still connecting; the message is sent when the turn ends.';
    default:
      return null;
  }
}

/** Reason lines for a queue, one per distinct reason, in queue order. */
export function queueReasonLines(
  prompts: ReadonlyArray<{ queueReason?: string }>,
  agentName?: string
): string[] {
  const lines: string[] = [];
  for (const prompt of prompts) {
    const line = queueReasonText(prompt.queueReason, agentName);
    if (line && !lines.includes(line)) lines.push(line);
  }
  return lines;
}
