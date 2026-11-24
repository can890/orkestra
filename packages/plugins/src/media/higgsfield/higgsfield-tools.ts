import {
  isError,
  validate,
  type MediaProviderSpec,
  type ToolPlan,
} from '../cli-media/cli-media-tools';

/**
 * `higgsfield` CLI (oturum ve kimlik bilgileri CLI'ındır) için araç tanımları. Kaynak:
 * `higgsfield --help`, `generate {create,cost,get,wait} --help`, `model {list,get} --help`,
 * `account status --help`.
 */

const COST_NOTE =
  "SPENDS the user's Higgsfield credits. Never call it in a loop or retry it automatically; estimate the cost first with higgsfield_estimate_cost and get the user's approval.";

const PARAM_KEY = /^[a-z][a-z0-9_-]{0,40}$/;
const RESERVED_PARAMS = new Set([
  'prompt',
  'json',
  'wait',
  'wait-timeout',
  'wait-interval',
  'help',
]);

const paramsSchema = {
  type: 'object',
  description:
    'Extra model parameters passed as --name value (see higgsfield_model_params), e.g. {"aspect_ratio": "16:9", "duration": 5}.',
  additionalProperties: { type: ['string', 'number', 'boolean'] },
} as const;

function paramArgs(raw: unknown): string[] | { error: string } {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'params must be an object.' };
  const args: string[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!PARAM_KEY.test(key) || RESERVED_PARAMS.has(key)) {
      return { error: `Unsupported parameter name: ${key}` };
    }
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      return { error: `Parameter ${key} must be a string, number or boolean.` };
    }
    args.push(`--${key}`, String(value));
  }
  return args;
}

function generatePlan(
  args: Record<string, unknown>,
  kind: 'image' | 'video',
  wait: string
): ToolPlan {
  const model = validate.slug(args.model, 'model');
  if (isError(model)) return model;
  const prompt = validate.text(args.prompt, 'prompt');
  if (isError(prompt)) return prompt;
  const params = paramArgs(args.params);
  if (isError(params)) return params;
  const argv = ['generate', 'create', model, '--prompt', prompt, ...params];
  const media = [
    ['image', '--image'],
    ['start_image', '--start-image'],
    ['end_image', '--end-image'],
  ] as const;
  for (const [field, flag] of media) {
    if (args[field] === undefined) continue;
    const ref = validate.mediaRef(args[field], field);
    if (isError(ref)) return ref;
    argv.push(flag, ref);
  }
  argv.push('--wait', '--wait-timeout', wait, '--json');
  return {
    argv,
    summary: `${kind} with ${model}: "${prompt.slice(0, 120)}"`,
    timeoutMs: kind === 'video' ? 25 * 60_000 : 12 * 60_000,
  };
}

/** `account status --json` çıktısından e-postayı atar; yalnızca plan ve kredi kalır. */
export function redactAccountStatus(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const kept = Object.fromEntries(
      Object.entries(parsed).filter(([key]) => !/mail|token|id$/i.test(key))
    );
    return JSON.stringify(kept, null, 2);
  } catch {
    return stdout.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email hidden>');
  }
}

const generateProperties = {
  model: {
    type: 'string',
    description: 'Model job_type from higgsfield_list_models, e.g. gpt_image_2 or seedance_2_0.',
  },
  prompt: { type: 'string', description: 'Generation prompt.' },
  params: paramsSchema,
  image: {
    type: 'string',
    description:
      'Optional reference image: an absolute local file path (uploaded by the CLI) or an upload/job id.',
  },
};

export const HIGGSFIELD_SPEC: MediaProviderSpec = {
  id: 'higgsfield',
  title: 'Higgsfield',
  serverName: 'orkestra-higgsfield',
  instructions: [
    'Orkestra Higgsfield tools run the signed-in higgsfield CLI on this machine.',
    '- List models and their parameters first; estimate the cost before any generation.',
    "- Generation spends the user's credits: get explicit approval, never retry automatically, never loop.",
    '- Generated files are saved in the conversation output directory; mention the absolute paths so the chat shows them.',
  ].join('\n'),
  tools: [
    {
      name: 'higgsfield_list_models',
      title: 'List Higgsfield models',
      description: 'List Higgsfield models (job types). Read-only, spends nothing.',
      kind: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['image', 'video', 'audio', 'text'] },
        },
      },
      plan: (args) => {
        const type = args.type;
        if (type !== undefined && !['image', 'video', 'audio', 'text'].includes(String(type))) {
          return { error: 'type must be image, video, audio or text.' };
        }
        return {
          argv: ['model', 'list', ...(type ? [`--${String(type)}`] : []), '--json'],
          summary: 'list models',
        };
      },
    },
    {
      name: 'higgsfield_model_params',
      title: 'Higgsfield model parameters',
      description: 'Show the accepted parameters and defaults of one model. Read-only.',
      kind: 'read',
      inputSchema: {
        type: 'object',
        properties: { model: { type: 'string' } },
        required: ['model'],
      },
      plan: (args) => {
        const model = validate.slug(args.model, 'model');
        if (isError(model)) return model;
        return { argv: ['model', 'get', model, '--json'], summary: `model ${model}` };
      },
    },
    {
      name: 'higgsfield_balance',
      title: 'Higgsfield credits',
      description: 'Show the plan and available credits of the signed-in account. Read-only.',
      kind: 'read',
      inputSchema: { type: 'object', properties: {} },
      plan: () => ({ argv: ['account', 'status', '--json'], summary: 'account status' }),
      transform: redactAccountStatus,
    },
    {
      name: 'higgsfield_estimate_cost',
      title: 'Estimate Higgsfield cost',
      description:
        'Estimate the credit cost of a generation without creating a job (text prompt and parameters only; spends nothing).',
      kind: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          model: generateProperties.model,
          prompt: generateProperties.prompt,
          params: paramsSchema,
        },
        required: ['model', 'prompt'],
      },
      plan: (args) => {
        const model = validate.slug(args.model, 'model');
        if (isError(model)) return model;
        const prompt = validate.text(args.prompt, 'prompt');
        if (isError(prompt)) return prompt;
        const params = paramArgs(args.params);
        if (isError(params)) return params;
        return {
          argv: ['generate', 'cost', model, '--prompt', prompt, ...params, '--json'],
          summary: `cost of ${model}`,
        };
      },
    },
    {
      name: 'higgsfield_generate_image',
      title: 'Generate image (Higgsfield)',
      description: `Create an image with a Higgsfield model, wait for it and save the result in the conversation output directory. ${COST_NOTE}`,
      kind: 'spend',
      producesMedia: true,
      inputSchema: {
        type: 'object',
        properties: generateProperties,
        required: ['model', 'prompt'],
      },
      plan: (args) => generatePlan(args, 'image', '10m'),
    },
    {
      name: 'higgsfield_generate_video',
      title: 'Generate video (Higgsfield)',
      description: `Create a video with a Higgsfield model, wait for it and save the result in the conversation output directory. ${COST_NOTE}`,
      kind: 'spend',
      producesMedia: true,
      inputSchema: {
        type: 'object',
        properties: {
          ...generateProperties,
          start_image: { type: 'string', description: 'Optional start frame (path or id).' },
          end_image: { type: 'string', description: 'Optional end frame (path or id).' },
        },
        required: ['model', 'prompt'],
      },
      plan: (args) => generatePlan(args, 'video', '20m'),
    },
    {
      name: 'higgsfield_fetch_result',
      title: 'Fetch Higgsfield result',
      description:
        'Download the result files of an existing job into the conversation output directory. Spends nothing.',
      kind: 'read',
      producesMedia: true,
      inputSchema: {
        type: 'object',
        properties: { job_id: { type: 'string' } },
        required: ['job_id'],
      },
      plan: (args) => {
        const id = validate.slug(args.job_id, 'job_id');
        if (isError(id)) return id;
        return { argv: ['generate', 'get', id, '--json'], summary: `job ${id}` };
      },
    },
  ],
};
