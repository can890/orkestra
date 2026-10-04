/** Şefe MCP üzerinden sunulan araçların JSON Schema tanımları. */
export const ORCHESTRA_TOOLS = [
  {
    name: 'list_agents',
    description:
      'List the worker agents this orchestra may use, with routing profiles (strengths, best roles, cost, speed), selectable models, current load and success stats observed in earlier runs. Call this before deciding who does what.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'spawn_agent',
    description:
      'Start a new worker agent in its own conversation (same task worktree) and give it a task. Returns immediately with a worker_id; the worker runs in the background. Before the first spawn, tell the user your dispatch plan (subtask, agent, model, reason, and why this many workers). Spawn all independent subtasks before waiting. The brief must be self-contained: the worker cannot see this conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent id from list_agents, e.g. "codex".' },
        task: {
          type: 'string',
          description:
            'Self-contained brief: goal, context and file paths, files it owns, files it must not touch, constraints and definition of done.',
        },
        title: { type: 'string', description: 'Short label shown on the worker conversation.' },
        model: {
          type: 'string',
          description:
            'Model id from list_agents. Required when the agent lists models: choose deliberately (strongest for hard work, fast/cheap for mechanical work).',
        },
        role: {
          type: 'string',
          description: 'Role such as implementer, reviewer, explorer or test author.',
        },
        reason: {
          type: 'string',
          description:
            'Why this agent and model fit this subtask better than the alternatives (one sentence, in the user language).',
        },
        description: {
          type: 'string',
          description:
            'One line shown to the user in the tool row, in the user language, e.g. "Codex · GPT-6 Astra — API testlerini yaz".',
        },
      },
      required: ['agent', 'task', 'title', 'reason', 'description'],
      additionalProperties: false,
    },
  },
  {
    name: 'message_agent',
    description:
      'Send a follow-up instruction to an existing worker. It keeps its previous context. Use it for corrections, next steps or review feedback; then wait_for_agents again.',
    inputSchema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string' },
        message: { type: 'string' },
        description: {
          type: 'string',
          description: 'One line shown to the user, e.g. "Codex işçisine düzeltme gönder".',
        },
      },
      required: ['worker_id', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'wait_for_agents',
    description:
      'Wait until workers finish their current task and return their final reports. mode "all" waits for every listed worker, "any" returns as soon as one finishes. Returns early when timeout_seconds elapses; call again if complete is false. Omit worker_ids to wait for every worker that has a task.',
    inputSchema: {
      type: 'object',
      properties: {
        worker_ids: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string', enum: ['all', 'any'] },
        timeout_seconds: {
          type: 'number',
          description: 'Default 50, maximum 600. Keep it under your MCP tool timeout.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_agent_result',
    description:
      "Get a worker's status and the final report of its latest task. Set full=true for an untruncated report.",
    inputSchema: {
      type: 'object',
      properties: {
        worker_id: { type: 'string' },
        full: { type: 'boolean' },
      },
      required: ['worker_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_workers',
    description: 'List every worker spawned by this orchestra with its agent, model and status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'cancel_agent',
    description: "Cancel a worker's running turn. The worker can be reused with message_agent.",
    inputSchema: {
      type: 'object',
      properties: { worker_id: { type: 'string' } },
      required: ['worker_id'],
      additionalProperties: false,
    },
  },
] as const;

export type OrchestraToolName = (typeof ORCHESTRA_TOOLS)[number]['name'];
