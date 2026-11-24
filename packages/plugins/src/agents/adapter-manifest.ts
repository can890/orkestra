import { elevenlabsAdapter } from '../media/elevenlabs/adapter';
import { flowAdapter } from '../media/flow/adapter';
import { higgsfieldAdapter } from '../media/higgsfield/adapter';
import { antigravityAdapter } from './impl/antigravity/adapter';
import { claudeAdapter } from './impl/claude/adapter';
import { codexAdapter } from './impl/codex/adapter';

export const adapterAssets = [
  claudeAdapter,
  codexAdapter,
  antigravityAdapter,
  elevenlabsAdapter,
  higgsfieldAdapter,
  flowAdapter,
] as const;
