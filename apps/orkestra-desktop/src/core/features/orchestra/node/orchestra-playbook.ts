import type { OrchestraSettings } from '@core/features/orchestra/api/orchestra';

/**
 * Şefin yönlendirme kararlarında kullandığı yerleşik ajan profilleri. Bunlar başlangıç
 * sezgileridir: kullanıcının yönlendirme notları ve oturumda gözlenen sonuçlar önceliklidir.
 * Metinler modele gittiği için İngilizce tutulur; şef kullanıcıya onun dilinde yanıt verir.
 */
export type AgentRoutingProfile = {
  family: string;
  strengths: string[];
  avoidFor: string[];
  bestRoles: string[];
  cost: 'low' | 'medium' | 'high';
  speed: 'fast' | 'medium' | 'slow';
};

const PROFILES: Record<string, AgentRoutingProfile> = {
  claude: {
    family: 'Anthropic Claude (Fable / Opus / Sonnet / Haiku) via Claude Code',
    strengths: [
      'architecture, planning and decomposing ambiguous problems',
      'large multi-file refactors in unfamiliar or complex codebases',
      'careful, convention-following edits and subtle debugging',
      'code review, security review and writing clear documentation',
    ],
    avoidFor: ['bulk mechanical edits where a cheaper agent is enough'],
    bestRoles: ['architect', 'complex implementer', 'reviewer', 'integrator'],
    cost: 'high',
    speed: 'medium',
  },
  codex: {
    family: 'OpenAI GPT (GPT-6 / GPT-5.x Codex) via Codex CLI',
    strengths: [
      'precise implementation from a clear spec',
      'algorithms, data structures and performance-sensitive code',
      'writing and fixing tests; reproduce-then-fix debugging',
      'terminal/CLI heavy workflows, build and tooling problems, backend logic',
    ],
    avoidFor: ['vague product/UX decisions without a spec'],
    bestRoles: ['implementer', 'debugger', 'test author', 'second-opinion reviewer'],
    cost: 'medium',
    speed: 'medium',
  },
  antigravity: {
    family: 'Google Antigravity (Gemini Pro / Flash, plus hosted Claude and GPT-OSS models)',
    strengths: [
      'very long context: reading and mapping large codebases quickly',
      'frontend, UI and visual work; multimodal input such as screenshots',
      'fast, cheap exploration and research passes with Flash models',
    ],
    avoidFor: ['delicate edits in critical code without a reviewer'],
    bestRoles: ['explorer', 'codebase researcher', 'frontend implementer'],
    cost: 'low',
    speed: 'fast',
  },
  kimi: {
    family: 'Moonshot Kimi (K2 / K3) via Kimi CLI',
    strengths: [
      'long-context agentic tool use over many files',
      'cost-efficient bulk coding and repetitive multi-file changes',
      'documentation, translation and content generation',
    ],
    avoidFor: ['the final call on risky architectural changes'],
    bestRoles: ['bulk implementer', 'docs writer', 'migration worker'],
    cost: 'low',
    speed: 'medium',
  },
  glm: {
    family: 'Zhipu GLM (5.3 / 5.3 Flash) via Z.ai on the Claude Code harness',
    strengths: [
      'low-cost general coding with Claude Code style tools',
      'boilerplate, scaffolding, mechanical edits and pattern migrations',
      'unit tests and small isolated fixes; cheap parallel fan-out',
    ],
    avoidFor: ['deep architectural reasoning'],
    bestRoles: ['cheap worker', 'parallel bulk editor', 'test author'],
    cost: 'low',
    speed: 'fast',
  },
  grok: {
    family: 'xAI Grok (4.x / Fast) via Grok CLI',
    strengths: [
      'fast iteration, quick scripts and prototypes',
      'brainstorming alternative approaches and contrarian reviews',
      'quick lookups and small fixes with the Fast model',
    ],
    avoidFor: ['long, convention-heavy refactors'],
    bestRoles: ['prototyper', 'quick fixer', 'alternative-opinion reviewer'],
    cost: 'medium',
    speed: 'fast',
  },
};

const GENERIC_PROFILE: AgentRoutingProfile = {
  family: 'General coding agent',
  strengths: ['general software engineering tasks'],
  avoidFor: [],
  bestRoles: ['general worker'],
  cost: 'medium',
  speed: 'medium',
};

export function routingProfileFor(providerId: string): AgentRoutingProfile {
  return PROFILES[providerId] ?? GENERIC_PROFILE;
}

export const ORCHESTRA_MCP_SERVER_NAME = 'orkestra';

const TOOL = (name: string) => `mcp__${ORCHESTRA_MCP_SERVER_NAME}__${name}`;

/** MCP `instructions` alanı ve şefin ilk istemindeki gizli bağlam için ortak kılavuz. */
export function buildConductorPlaybook(settings: OrchestraSettings): string {
  const roster = settings.workers
    .map((worker) => {
      const profile = routingProfileFor(worker.providerId);
      return `- ${worker.providerId} (${worker.name}): ${profile.bestRoles.join(', ')}; cost ${profile.cost}, speed ${profile.speed}`;
    })
    .join('\n');
  const parallel =
    settings.maxParallel === 0
      ? 'unlimited (spawn as many workers as the work genuinely benefits from)'
      : `at most ${settings.maxParallel} running at once`;
  const notes = settings.routingNotes.trim();
  return `You are the Orkestra conductor: the decision-maker of a multi-agent team of AI coding agents. You plan, delegate, supervise and integrate. Your workers are other AI agents (different providers and models) that run in their own conversations inside the same task worktree. The user can watch every worker in its own conversation.

Tools (MCP server "${ORCHESTRA_MCP_SERVER_NAME}", may appear as ${TOOL('spawn_agent')} etc.):
- list_agents: roster, routing profiles, models, live load and observed success stats. Call it before routing.
- spawn_agent: start a worker with a self-contained brief. Returns immediately with a worker_id.
- message_agent: send a follow-up instruction to an existing worker (keeps its context).
- wait_for_agents: block until workers finish (mode "all" or "any"); returns each worker's final report. It returns early on timeout; call again while work is still running.
- get_agent_result / list_workers / cancel_agent: inspect, list and stop workers.

Available workers:
${roster}
Parallelism: ${parallel}.
${notes ? `\nUser routing preferences (these override the built-in profiles):\n${notes}\n` : ''}
Method:
1. Understand: read just enough of the repository yourself to plan well. Ask the user only when the goal is genuinely ambiguous.
2. Decide whether to delegate. Do trivial single-file work yourself or give it to one cheap, fast worker. Delegate in parallel when the work splits into independent parts or benefits from a specialist. Tightly coupled sequential work goes to ONE strong agent; splitting it makes results worse.
3. Decompose into subtasks with explicit, non-overlapping file/directory ownership, acceptance criteria and the context the worker needs. All workers share one worktree: two running workers must never edit the same file. Read-only research tasks may overlap.
4. Route each subtask to the best agent and model: match the task to profiles, prefer cheaper/faster agents for mechanical or exploratory work and the strongest agent for architecture and risky changes, follow the user's preferences, and learn from results in this session (re-route away from agents that failed). Use a different provider to review than the one that implemented.
5. Dispatch every independent subtask first, then wait. Do not serialize work that can run in parallel.
6. Supervise: loop on wait_for_agents. If a worker is awaiting permission, tell the user which worker conversation needs approval. If a worker fails or returns weak work, send a corrective message_agent or re-route to another agent with the failure context.
7. Integrate and verify: inspect the combined diff (git diff), resolve conflicts, and run builds/tests yourself or through a worker before claiming success.
8. Report to the user in their language: what was done, a table of subtask -> agent/model -> outcome, verification results and any open issues.

Worker briefs must be self-contained: goal, relevant context and file paths, files the worker owns, files it must not touch, constraints (no commits or pushes unless asked), definition of done, and the report format (summary, files changed, verification run, open issues). Workers cannot see this conversation.`;
}

/** Her işçi isteminin önüne gizli bağlam olarak eklenir. */
export function buildWorkerBrief(input: { title: string; role: string | null }): string {
  return `You are a worker agent in an Orkestra multi-agent team. A conductor agent assigned you the task "${input.title}"${input.role ? ` as the ${input.role}` : ''}. Other agents work in the same worktree at the same time: stay strictly within the files and scope in your brief, and do not revert or reformat changes you did not make. Do not commit, push or open pull requests unless the brief explicitly says so. Work autonomously; if something blocks you, explain it in your report instead of waiting for input.

Finish with a concise final report:
## Summary
## Files changed
## Verification (commands run and results)
## Open issues / follow-ups`;
}
