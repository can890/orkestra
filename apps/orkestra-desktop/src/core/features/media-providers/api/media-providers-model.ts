import { z } from 'zod';

/** CLI tabanlı medya sağlayıcıları (ElevenLabs'in yanında). Hepsi varsayılan kapalı. */
export const MEDIA_PROVIDER_IDS = ['higgsfield', 'flow'] as const;
export type MediaProviderId = (typeof MEDIA_PROVIDER_IDS)[number];

export const MEDIA_PROVIDER_INFO: Record<
  MediaProviderId,
  { title: string; cli: string; serverName: string; adapter: string; description: string }
> = {
  higgsfield: {
    title: 'Higgsfield',
    cli: 'higgsfield',
    serverName: 'orkestra-higgsfield',
    adapter: 'higgsfield-mcp.mjs',
    description: 'Image and video generation, model list and credits through the higgsfield CLI.',
  },
  flow: {
    title: 'Google Flow',
    cli: 'gflow',
    serverName: 'orkestra-flow',
    adapter: 'flow-mcp.mjs',
    description:
      'Imagen / Veo image and video generation, model list and credits through the gflow CLI.',
  },
};

const providerSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  /** Kredi harcayan çağrılar önce önizleme döndürür; ajan `confirm_spend: true` ile yineler. */
  requireConfirmation: z.boolean().default(true),
});

export const mediaProvidersSettingsSchema = z.object({
  higgsfield: providerSettingsSchema,
  flow: providerSettingsSchema,
});

export type MediaProvidersSettings = z.infer<typeof mediaProvidersSettingsSchema>;

export const DEFAULT_MEDIA_PROVIDERS_SETTINGS: MediaProvidersSettings = {
  higgsfield: { enabled: false, requireConfirmation: true },
  flow: { enabled: false, requireConfirmation: true },
};

export type MediaProviderStatus = {
  id: MediaProviderId;
  enabled: boolean;
  requireConfirmation: boolean;
  cli: { available: boolean; path: string | null; version: string | null };
  /** Oturum durumu (zararsız durum komutuyla); denetlenemediyse null. */
  signedIn: boolean | null;
  message: string | null;
  checkedAt: number | null;
};
