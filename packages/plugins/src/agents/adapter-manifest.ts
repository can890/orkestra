import { elevenlabsAdapter } from '../media/elevenlabs/adapter';
import { antigravityAdapter } from './impl/antigravity/adapter';
import { claudeAdapter } from './impl/claude/adapter';
import { codexAdapter } from './impl/codex/adapter';

export const adapterAssets = [claudeAdapter, codexAdapter, antigravityAdapter, elevenlabsAdapter] as const;
