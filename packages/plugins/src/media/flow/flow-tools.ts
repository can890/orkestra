import {
  isError,
  validate,
  type MediaProviderSpec,
  type ToolPlan,
} from '../cli-media/cli-media-tools';

/**
 * Google Flow için `gflow` CLI araç tanımları (oturum CLI'ındır). Kaynak: `gflow --help`,
 * `image generate --help`, `video generate --help`, `models --help`, `credits user --help`,
 * `data download --help`.
 */

const COST_NOTE =
  "SPENDS the user's Google Flow credits. Never call it in a loop or retry it automatically; get the user's approval first (check flow_credits).";

const IMAGE_MODELS = ['nano2', 'nano2.1', 'nano-pro', 'nano2-lite', 'imagen4'];
const IMAGE_ASPECTS = ['9:16', '16:9', '1:1', '4:3', '3:4'];
const VIDEO_MODELS = [
  'omni-flash',
  'omni-1.2-flash',
  'omni-1.2',
  'veo-lite',
  'veo-fast',
  'veo-quality',
  'veo-lite-lp',
];

function enumValue(value: unknown, allowed: readonly string[], field: string) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    return { error: `${field} must be one of: ${allowed.join(', ')}.` };
  }
  return value;
}

function refs(value: unknown, flag: string, max: number): string[] | { error: string } {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) {
    return { error: `reference_images must be a list of at most ${max} paths.` };
  }
  const out: string[] = [];
  for (const item of value) {
    const ref = validate.mediaRef(item, 'reference_images');
    if (isError(ref)) return ref;
    out.push(flag, ref);
  }
  return out;
}

function imagePlan(args: Record<string, unknown>, outputDir: string): ToolPlan {
  const prompt = validate.text(args.prompt, 'prompt');
  if (isError(prompt)) return prompt;
  const model = enumValue(args.model, IMAGE_MODELS, 'model');
  if (isError(model)) return model;
  const aspect = enumValue(args.aspect, IMAGE_ASPECTS, 'aspect');
  if (isError(aspect)) return aspect;
  const count = args.count === undefined ? 1 : Number(args.count);
  if (!Number.isInteger(count) || count < 1 || count > 4) return { error: 'count must be 1–4.' };
  const references = refs(args.reference_images, '--ref', 10);
  if (isError(references)) return references;
  const argv = ['image', 'generate', '--count', String(count)];
  if (model) argv.push('--model', model);
  if (aspect) argv.push('--aspect', aspect);
  argv.push(...references, '--out', outputDir, '--json', '--', prompt);
  return { argv, summary: `${count} image(s): "${prompt.slice(0, 120)}"`, timeoutMs: 10 * 60_000 };
}

function videoPlan(args: Record<string, unknown>, outputDir: string): ToolPlan {
  const prompt = validate.text(args.prompt, 'prompt');
  if (isError(prompt)) return prompt;
  const model = enumValue(args.model, VIDEO_MODELS, 'model');
  if (isError(model)) return model;
  const aspect = enumValue(args.aspect, ['9:16', '16:9'], 'aspect');
  if (isError(aspect)) return aspect;
  const argv = ['video', 'generate', '--count', '1'];
  if (model) argv.push('--model', model);
  if (aspect) argv.push('--aspect', aspect);
  if (args.duration !== undefined) {
    const duration = Number(args.duration);
    if (!Number.isInteger(duration) || duration < 3 || duration > 15) {
      return { error: 'duration must be 3–15 seconds.' };
    }
    argv.push('--duration', String(duration));
  }
  const resolution = enumValue(args.resolution, ['360p', '720p'], 'resolution');
  if (isError(resolution)) return resolution;
  if (resolution) argv.push('--resolution', resolution);
  if (args.max_credits !== undefined) {
    const cap = Number(args.max_credits);
    if (!Number.isInteger(cap) || cap < 0) return { error: 'max_credits must be >= 0.' };
    argv.push('--max-credits', String(cap));
  }
  for (const [field, flag] of [
    ['initial_frame', '--initial-frame'],
    ['end_frame', '--end-frame'],
  ] as const) {
    if (args[field] === undefined) continue;
    const ref = validate.mediaRef(args[field], field);
    if (isError(ref)) return ref;
    argv.push(flag, ref);
  }
  const references = refs(args.reference_images, '--ref', 7);
  if (isError(references)) return references;
  argv.push(...references, '--out-dir', outputDir, '--json', '--', prompt);
  return { argv, summary: `video: "${prompt.slice(0, 120)}"`, timeoutMs: 25 * 60_000 };
}

export const FLOW_SPEC: MediaProviderSpec = {
  id: 'flow',
  title: 'Google Flow',
  serverName: 'orkestra-flow',
  instructions: [
    'Orkestra Flow tools run the signed-in gflow CLI on this machine.',
    '- Check flow_credits and the model list before generating.',
    "- Generation spends the user's Flow credits: get explicit approval, never retry automatically, never loop.",
    '- Files are written to the conversation output directory; mention the absolute paths so the chat shows them.',
  ].join('\n'),
  tools: [
    {
      name: 'flow_list_models',
      title: 'List Flow models',
      description: 'List Flow image and video models, aliases and limits. Read-only.',
      kind: 'read',
      inputSchema: { type: 'object', properties: {} },
      plan: () => ({ argv: ['models', '--json'], summary: 'list models' }),
    },
    {
      name: 'flow_credits',
      title: 'Flow credits',
      description:
        'Show the current Google Flow credit balance. Read-only, spends nothing (if the saved session is rejected, gflow may open Flow in its own browser profile to read it).',
      kind: 'read',
      inputSchema: { type: 'object', properties: {} },
      plan: () => ({
        argv: ['credits', 'user', '--json'],
        summary: 'credits',
        timeoutMs: 3 * 60_000,
      }),
    },
    {
      name: 'flow_generate_image',
      title: 'Generate image (Flow)',
      description: `Generate 1–4 images with Google Flow (Imagen / Nano Banana) into the conversation output directory. ${COST_NOTE}`,
      kind: 'spend',
      producesMedia: true,
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          model: { type: 'string', enum: IMAGE_MODELS },
          aspect: { type: 'string', enum: IMAGE_ASPECTS },
          count: { type: 'integer', minimum: 1, maximum: 4 },
          reference_images: {
            type: 'array',
            items: { type: 'string' },
            description: 'Absolute paths of reference images (image-to-image).',
          },
        },
        required: ['prompt'],
      },
      plan: (args, context) => imagePlan(args, context.outputDir),
    },
    {
      name: 'flow_generate_video',
      title: 'Generate video (Flow)',
      description: `Generate one video with Google Flow (Veo / Omni) into the conversation output directory. Use max_credits to cap the quote. ${COST_NOTE}`,
      kind: 'spend',
      producesMedia: true,
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          model: { type: 'string', enum: VIDEO_MODELS },
          aspect: { type: 'string', enum: ['9:16', '16:9'] },
          duration: { type: 'integer', minimum: 3, maximum: 15 },
          resolution: { type: 'string', enum: ['360p', '720p'] },
          initial_frame: { type: 'string', description: 'Absolute path or in-project media id.' },
          end_frame: { type: 'string', description: 'Absolute path or in-project media id.' },
          reference_images: { type: 'array', items: { type: 'string' } },
          max_credits: {
            type: 'integer',
            minimum: 0,
            description: 'Refuse before submitting if Flow quotes more than this.',
          },
        },
        required: ['prompt'],
      },
      plan: (args, context) => videoPlan(args, context.outputDir),
    },
    {
      name: 'flow_fetch_result',
      title: 'Fetch Flow video',
      description:
        'Download an already generated (and already paid) Flow video by media id into the conversation output directory. Spends nothing.',
      kind: 'read',
      producesMedia: true,
      inputSchema: {
        type: 'object',
        properties: { media_id: { type: 'string' } },
        required: ['media_id'],
      },
      plan: (args, context) => {
        const id = validate.slug(args.media_id, 'media_id');
        if (isError(id)) return id;
        return {
          argv: ['data', 'download', '--out', context.outputDir, '--json', '--', id],
          summary: `download ${id}`,
          timeoutMs: 5 * 60_000,
        };
      },
    },
  ],
};
