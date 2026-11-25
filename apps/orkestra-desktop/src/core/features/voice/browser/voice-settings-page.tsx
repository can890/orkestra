import type { Result } from '@orkestra/shared';
import { PageLayout, SettingsRow, SettingsSection } from '@orkestra/ui/react/patterns';
import { Alert, Badge, Button, Input, Select, Switch, toast } from '@orkestra/ui/react/primitives';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  ExternalLink,
  LoaderCircle,
  Mic,
  RefreshCw,
  Volume2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { getVoiceClient } from '@core/features/voice/api/browser/client';
import {
  DEFAULT_OPENAI_STT_BASE_URL,
  DEFAULT_OPENAI_STT_MODEL,
  DEFAULT_VOICE_PREFERENCES,
  type EffectiveSttProvider,
  type LocalSttEngine,
  type LocalSttStatus,
  type SttProvider,
  type TtsModelId,
  type VoiceError,
  type VoicePreferences,
  type VoiceStatus,
  type VoiceSummary,
} from '@core/features/voice/api/contract';
import { voiceErrorMessage } from '@core/features/voice/api/voice-errors';
import { getSpokenRepliesStore } from '@core/features/voice/contributions/app-stores';
import { openExternal } from '@core/primitives/desktop-host/browser/host-client';
import { detectPlatformContext } from '@core/primitives/keybindings/api';

// Ayarlar > Ses: çevrimdışı yerel Whisper (MLX / faster-whisper), OpenAI uyumlu HTTP
// (Groq / OpenAI / yerel sunucu) ve ElevenLabs API anahtarı + sesli yanıt tercihleri.

const STATUS_QUERY_KEY = ['voice', 'status'] as const;
const VOICES_QUERY_KEY = ['voice', 'voices'] as const;
const API_KEYS_URL = 'https://elevenlabs.io/app/settings/api-keys';
const GROQ_API_KEYS_URL = 'https://console.groq.com/keys';
const PREVIEW_ID = '__voice-settings-preview__';
const PREVIEW_TEXT = 'Merhaba, ben Sovra. Sesli yanıtlar bu sesle okunacak.';

const STT_PROVIDER_OPTIONS: ReadonlyArray<{ value: SttProvider; label: string }> = [
  { value: 'auto', label: 'Otomatik (Yerel → Groq/OpenAI → ElevenLabs)' },
  { value: 'local', label: 'Yerel (Çevrimdışı & Ücretsiz Whisper)' },
  { value: 'openai-compatible', label: 'OpenAI Uyumlu (Groq / OpenAI / Yerel HTTP)' },
  { value: 'elevenlabs', label: 'ElevenLabs Scribe (Bulut)' },
];

const LOCAL_ENGINE_LABELS: Record<LocalSttEngine, string> = {
  'mlx-whisper': 'MLX Whisper (Apple Silicon)',
  'faster-whisper': 'Faster Whisper',
  whisper: 'OpenAI Whisper (Python)',
  'whisper-cli': 'whisper.cpp CLI',
};

const KNOWN_LOCAL_MODELS = [
  'mlx-community/whisper-large-v3-turbo',
  'mlx-community/whisper-small-mlx',
  'mobiuslabsgmbh/faster-whisper-large-v3-turbo',
  'Systran/faster-whisper-small',
] as const;

function resolveProviderBadge(
  effectiveProvider: EffectiveSttProvider,
  localStt: LocalSttStatus | undefined
): { tone: 'success' | 'info' | 'warning'; label: string } {
  if (effectiveProvider === 'local') {
    const engineLabel = localStt?.engine ? LOCAL_ENGINE_LABELS[localStt.engine] : 'Yerel Whisper';
    return { tone: 'success', label: `Yerel hazır · ${engineLabel}` };
  }
  if (effectiveProvider === 'openai-compatible') {
    return { tone: 'info', label: 'OpenAI Uyumlu / Groq HTTP hazır' };
  }
  if (effectiveProvider === 'elevenlabs') {
    return { tone: 'info', label: 'ElevenLabs Scribe hazır' };
  }
  return { tone: 'warning', label: 'Dikte yapılandırılmadı' };
}

const STT_LANGUAGE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'tr', label: 'Türkçe' },
  { value: 'auto', label: 'Otomatik algıla' },
  { value: 'en', label: 'İngilizce' },
  { value: 'de', label: 'Almanca' },
  { value: 'fr', label: 'Fransızca' },
  { value: 'es', label: 'İspanyolca' },
  { value: 'it', label: 'İtalyanca' },
  { value: 'ru', label: 'Rusça' },
  { value: 'ar', label: 'Arapça' },
];

const TTS_MODEL_OPTIONS: ReadonlyArray<{ value: TtsModelId; label: string }> = [
  { value: 'eleven_multilingual_v2', label: 'Multilingual v2 (yüksek kalite)' },
  { value: 'eleven_flash_v2_5', label: 'Flash v2.5 (hızlı, düşük maliyet)' },
];

async function fetchStatus(): Promise<VoiceStatus> {
  return (await getVoiceClient()).getStatus();
}

export function VoiceSettingsPage() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: STATUS_QUERY_KEY, queryFn: fetchStatus });
  const hasApiKey = status.data?.hasApiKey ?? false;
  const hasOpenAiSttApiKey = status.data?.hasOpenAiSttApiKey ?? false;
  const localStt = status.data?.localStt;
  const effectiveSttProvider = status.data?.effectiveSttProvider ?? 'none';
  const preferences = status.data?.preferences ?? DEFAULT_VOICE_PREFERENCES;

  const voices = useQuery({
    queryKey: VOICES_QUERY_KEY,
    enabled: hasApiKey,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async (): Promise<VoiceSummary[]> => {
      const result = await (await getVoiceClient()).listVoices();
      if (!result.success) throw new Error(voiceErrorMessage(result.error));
      return result.data;
    },
  });

  const savePreferences = useMutation({
    mutationFn: async (patch: Partial<VoicePreferences>) => {
      const result = await (await getVoiceClient()).setPreferences(patch);
      if (!result.success) throw new Error(voiceErrorMessage(result.error));
      return result.data;
    },
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: STATUS_QUERY_KEY });
      const previous = queryClient.getQueryData<VoiceStatus>(STATUS_QUERY_KEY);
      if (previous) {
        queryClient.setQueryData<VoiceStatus>(STATUS_QUERY_KEY, {
          ...previous,
          preferences: { ...previous.preferences, ...patch },
        });
      }
      return { previous };
    },
    onError: (error, _patch, context) => {
      if (context?.previous) queryClient.setQueryData(STATUS_QUERY_KEY, context.previous);
      toast.error('Ses tercihi kaydedilemedi', { description: error.message });
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY }),
  });

  const voiceOptions = useMemo<VoiceSummary[]>(() => {
    const list = voices.data ?? [];
    if (list.some((voice) => voice.voiceId === preferences.ttsVoiceId)) return list;
    // Seçili ses listede yoksa (liste yüklenmedi ya da hesapta yok) yine de göster.
    return [
      { voiceId: preferences.ttsVoiceId, name: preferences.ttsVoiceName ?? preferences.ttsVoiceId },
      ...list,
    ];
  }, [voices.data, preferences.ttsVoiceId, preferences.ttsVoiceName]);

  const localModelOptions = useMemo<string[]>(() => {
    const combined = [...(localStt?.cachedModels ?? []), ...KNOWN_LOCAL_MODELS];
    if (preferences.localSttModel && preferences.localSttModel !== 'auto') {
      combined.push(preferences.localSttModel);
    }
    return [...new Set(combined)];
  }, [localStt?.cachedModels, preferences.localSttModel]);

  const providerBadge = resolveProviderBadge(effectiveSttProvider, localStt);
  const showLocalModelControls =
    preferences.sttProvider === 'auto' || preferences.sttProvider === 'local';

  const shortcut = detectPlatformContext().os === 'mac' ? '⌘⇧Space' : 'Ctrl+Shift+Space';

  return (
    <div className="space-y-8 pb-10">
      <PageLayout.Header
        sticky
        draggable
        title="Ses"
        description="Sohbette çevrimdışı yerel Whisper (MLX), Groq/OpenAI veya ElevenLabs ile sesle yazma ve sesli yanıt okuma."
      />

      {status.data && !status.data.secureStorageAvailable && (
        <Alert.Root status="warning">
          <Alert.Title>Güvenli depolama kullanılamıyor</Alert.Title>
          <Alert.Description>
            Bu sistemde şifreli anahtar deposu yok; API anahtarı kaydedilemez.
          </Alert.Description>
        </Alert.Root>
      )}

      <SettingsSection title="Sesle yazma (Dikte)">
        <LocalEngineStatusRow
          badge={providerBadge}
          localStt={localStt}
          loading={status.isLoading}
          onRefresh={() => void queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY })}
        />
        <SettingsRow
          label="Dikte motoru"
          description="Otomatik kipte varsa yerel çevrimdışı Whisper, yoksa Groq/OpenAI ya da ElevenLabs seçilir."
          control={
            <Select.Root
              value={preferences.sttProvider}
              onValueChange={(value) =>
                savePreferences.mutate({ sttProvider: String(value) as SttProvider })
              }
              disabled={status.isLoading}
            >
              <Select.Trigger className="w-[260px] shrink-0">
                <Select.Value>
                  {STT_PROVIDER_OPTIONS.find((option) => option.value === preferences.sttProvider)
                    ?.label ?? preferences.sttProvider}
                </Select.Value>
              </Select.Trigger>
              <Select.Content align="end">
                {STT_PROVIDER_OPTIONS.map((option) => (
                  <Select.Item key={option.value} value={option.value}>
                    {option.label}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          }
        />
        {showLocalModelControls && (
          <>
            <SettingsRow
              label="Yerel model"
              description={
                localStt?.cachedModels.length
                  ? `Önbellekte ${localStt.cachedModels.length} model hazır. Otomatik, önbellekteki en iyi modeli seçer.`
                  : 'Önerilen yerel Whisper modeli (ör. MLX Whisper large-v3-turbo).'
              }
              control={
                <Select.Root
                  value={preferences.localSttModel}
                  onValueChange={(value) =>
                    savePreferences.mutate({ localSttModel: String(value) })
                  }
                  disabled={status.isLoading}
                >
                  <Select.Trigger className="w-[260px] shrink-0">
                    <Select.Value>
                      {preferences.localSttModel === 'auto'
                        ? `Önerilen (${localStt?.recommendedModel ?? 'otomatik'})`
                        : preferences.localSttModel}
                    </Select.Value>
                  </Select.Trigger>
                  <Select.Content align="end">
                    <Select.Item value="auto">
                      Önerilen ({localStt?.recommendedModel ?? 'otomatik'})
                    </Select.Item>
                    {localModelOptions.map((modelId) => (
                      <Select.Item key={modelId} value={modelId}>
                        {modelId}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
              }
            />
            <CustomPythonPathRow
              savedPath={preferences.localSttPythonPath ?? ''}
              disabled={status.isLoading || savePreferences.isPending}
              onSave={(nextPath) => savePreferences.mutate({ localSttPythonPath: nextPath })}
            />
          </>
        )}
        <SettingsRow
          label="Konuşma dili"
          description="Dikte edilen konuşmanın dili. Otomatik algılama karışık dilli konuşmalarda işe yarar."
          control={
            <Select.Root
              value={preferences.sttLanguage}
              onValueChange={(value) => savePreferences.mutate({ sttLanguage: String(value) })}
              disabled={status.isLoading}
            >
              <Select.Trigger className="w-[183px] shrink-0">
                <Select.Value>
                  {STT_LANGUAGE_OPTIONS.find((option) => option.value === preferences.sttLanguage)
                    ?.label ?? preferences.sttLanguage}
                </Select.Value>
              </Select.Trigger>
              <Select.Content align="end">
                {STT_LANGUAGE_OPTIONS.map((option) => (
                  <Select.Item key={option.value} value={option.value}>
                    {option.label}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          }
        />
        <SettingsRow
          label="Kısayol"
          description="Sohbet kutusundayken kaydı başlatır ya da durdurur. Esc kaydı iptal eder."
          control={<span className="text-sm text-foreground-muted">{shortcut}</span>}
        />
        <SettingsRow
          label="Dikte bitince otomatik gönder"
          description="Açıkken kayıt yazıya çevrildiği anda sohbet mesajını bekletmeden doğrudan gönderir."
          control={
            <Switch
              aria-label="Dikte bitince otomatik gönder"
              checked={preferences.autoSendAfterDictation ?? false}
              disabled={status.isLoading}
              onCheckedChange={(checked) =>
                savePreferences.mutate({ autoSendAfterDictation: checked })
              }
            />
          }
        />
        <SettingsRow
          label="Dolgu kelimelerini temizle"
          description="Yazıya dökülen metinden 'ııı', 'eee', 'um', 'yani,' gibi konuşma tereddütlerini otomatik temizler."
          control={
            <Switch
              aria-label="Dolgu kelimelerini temizle"
              checked={preferences.removeFillerWords ?? true}
              disabled={status.isLoading}
              onCheckedChange={(checked) => savePreferences.mutate({ removeFillerWords: checked })}
            />
          }
        />
        <MicrophonePriorityRow
          preferredIds={preferences.preferredMicrophoneIds ?? []}
          disabled={status.isLoading}
          onChange={(ids) => savePreferences.mutate({ preferredMicrophoneIds: ids })}
        />
      </SettingsSection>

      <SettingsSection title="OpenAI Uyumlu / Groq Whisper (Ekonomik Bulut veya Yerel HTTP)">
        <OpenAiSttEndpointRow
          baseUrl={preferences.openAiSttBaseUrl ?? DEFAULT_OPENAI_STT_BASE_URL}
          model={preferences.openAiSttModel ?? DEFAULT_OPENAI_STT_MODEL}
          disabled={status.isLoading || savePreferences.isPending}
          onSave={(patch) => savePreferences.mutate(patch)}
        />
        <EncryptedApiKeyRow
          label="API anahtarı"
          ariaLabel="OpenAI Uyumlu / Groq STT API anahtarı"
          placeholder="gsk_… veya sk-…"
          descriptionPrefix="Groq veya OpenAI anahtarı işletim sisteminin güvenli deposunda şifrelenir (localhost sunucularda anahtar gerekmez)."
          externalUrl={GROQ_API_KEYS_URL}
          externalLinkLabel="Groq anahtarı al"
          savedToast="OpenAI uyumlu STT API anahtarı şifreli olarak kaydedildi"
          removedToast="OpenAI uyumlu STT API anahtarı kaldırıldı"
          hasApiKey={hasOpenAiSttApiKey}
          loading={status.isLoading}
          onSaveKey={async (apiKey) => (await getVoiceClient()).setOpenAiSttApiKey({ apiKey })}
          onClearKey={async () => (await getVoiceClient()).clearOpenAiSttApiKey()}
          onChanged={() => void queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY })}
        />
      </SettingsSection>

      <SettingsSection title="ElevenLabs (Sesli Yanıtlar & Bulut Dikte)">
        <EncryptedApiKeyRow
          label="API anahtarı"
          ariaLabel="ElevenLabs API anahtarı"
          placeholder="sk_…"
          descriptionPrefix="Anahtar işletim sisteminin güvenli deposuyla şifrelenir ve yalnızca ana süreçte kullanılır."
          externalUrl={API_KEYS_URL}
          externalLinkLabel="Anahtar al"
          savedToast="ElevenLabs API anahtarı şifreli olarak kaydedildi"
          removedToast="ElevenLabs API anahtarı kaldırıldı"
          hasApiKey={hasApiKey}
          loading={status.isLoading}
          onSaveKey={async (apiKey) => (await getVoiceClient()).setApiKey({ apiKey })}
          onClearKey={async () => (await getVoiceClient()).clearApiKey()}
          onChanged={() => {
            void queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
            void queryClient.invalidateQueries({ queryKey: VOICES_QUERY_KEY });
          }}
        />
        <TestConnectionRow hasApiKey={hasApiKey} />
      </SettingsSection>

      <SettingsSection title="Sesli yanıtlar">
        <SettingsRow
          label="Ses"
          description={
            voices.error
              ? voices.error.message
              : 'Sohbetteki hoparlör düğmesi açıkken yanıtlar bu sesle okunur.'
          }
          control={
            <div className="flex items-center gap-1">
              <Select.Root
                value={preferences.ttsVoiceId}
                onValueChange={(value) => {
                  const voice = voiceOptions.find((option) => option.voiceId === value);
                  savePreferences.mutate({ ttsVoiceId: String(value), ttsVoiceName: voice?.name });
                }}
                disabled={status.isLoading}
              >
                <Select.Trigger className="w-[183px] shrink-0">
                  <Select.Value>
                    {voiceOptions.find((voice) => voice.voiceId === preferences.ttsVoiceId)?.name ??
                      preferences.ttsVoiceId}
                  </Select.Value>
                </Select.Trigger>
                <Select.Content align="end" className="max-h-80">
                  {voiceOptions.map((voice) => (
                    <Select.Item
                      key={voice.voiceId}
                      value={voice.voiceId}
                      title={voice.description}
                    >
                      <span className="truncate">{voice.name}</span>
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
              <Button
                variant="ghost"
                size="xs"
                icon
                aria-label="Ses listesini yenile"
                disabled={!hasApiKey || voices.isFetching}
                onClick={() => void voices.refetch()}
              >
                {voices.isFetching ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
              </Button>
            </div>
          }
        />
        <SettingsRow
          label="Model"
          description="Flash daha hızlı ve ucuzdur; Multilingual daha doğal okur."
          control={
            <Select.Root
              value={preferences.ttsModelId}
              onValueChange={(value) => savePreferences.mutate({ ttsModelId: value as TtsModelId })}
              disabled={status.isLoading}
            >
              <Select.Trigger className="w-[183px] shrink-0">
                <Select.Value>
                  {TTS_MODEL_OPTIONS.find((option) => option.value === preferences.ttsModelId)
                    ?.label ?? preferences.ttsModelId}
                </Select.Value>
              </Select.Trigger>
              <Select.Content align="end">
                {TTS_MODEL_OPTIONS.map((option) => (
                  <Select.Item key={option.value} value={option.value}>
                    {option.label}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          }
        />
        <SettingsRow
          label="Sesi dinle"
          description="Seçili sesle kısa bir örnek cümle okur."
          control={
            <Button
              variant="secondary"
              size="sm"
              disabled={!hasApiKey}
              onClick={() => void getSpokenRepliesStore().speak(PREVIEW_ID, PREVIEW_TEXT)}
            >
              <Volume2 />
              Dinle
            </Button>
          }
        />
      </SettingsSection>
    </div>
  );
}

function LocalEngineStatusRow({
  badge,
  localStt,
  loading,
  onRefresh,
}: {
  badge: { tone: 'success' | 'info' | 'warning'; label: string };
  localStt: LocalSttStatus | undefined;
  loading: boolean;
  onRefresh: () => void;
}) {
  const [testing, setTesting] = useState(false);

  const testLocal = async () => {
    setTesting(true);
    try {
      const result = await (await getVoiceClient()).testLocalStt();
      if (result.success) {
        const engineName = LOCAL_ENGINE_LABELS[result.data.engine] ?? result.data.engine;
        toast.success('Yerel Whisper motoru hazır', {
          description: `${engineName} · ${result.data.model} (${result.data.latencyMs} ms)`,
        });
      } else {
        toast.error('Yerel motor testi başarısız', {
          description: voiceErrorMessage(result.error),
        });
      }
      onRefresh();
    } finally {
      setTesting(false);
    }
  };

  const detail = localStt
    ? localStt.available
      ? `Python: ${localStt.pythonPath ?? 'sistem'} · ffmpeg ${localStt.ffmpegAvailable ? 'hazır' : 'eksik'}`
      : (localStt.reason ?? 'Sistemde mlx-whisper veya faster-whisper algılanmadı.')
    : 'Yerel dikte motoru taranıyor…';

  return (
    <SettingsRow
      label="Etkin dikte motoru"
      description={
        <span className="flex flex-col gap-1">
          <span>
            <Badge variant="soft" tone={badge.tone}>
              {badge.label}
            </Badge>
          </span>
          <span>{detail}</span>
        </span>
      }
      control={
        <div className="flex items-center gap-1">
          <Button
            variant="secondary"
            size="sm"
            disabled={loading || testing || !localStt?.available}
            onClick={() => void testLocal()}
          >
            {testing && <LoaderCircle className="animate-spin" />}
            Yerel Motoru Test Et
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon
            aria-label="Yerel motoru yeniden tara"
            title="Yerel motoru yeniden tara"
            disabled={loading}
            onClick={onRefresh}
          >
            <RefreshCw className={loading ? 'animate-spin' : undefined} />
          </Button>
        </div>
      }
    />
  );
}

function CustomPythonPathRow({
  savedPath,
  disabled,
  onSave,
}: {
  savedPath: string;
  disabled: boolean;
  onSave: (nextPath: string) => void;
}) {
  const [draft, setDraft] = useState(savedPath);

  useEffect(() => {
    setDraft(savedPath);
  }, [savedPath]);

  const dirty = draft.trim() !== savedPath.trim();

  return (
    <SettingsRow
      label="Özel Python yolu (isteğe bağlı)"
      description="Boş bırakıldığında mlx-whisper veya faster-whisper yüklü virtualenv otomatik bulunur."
      control={
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            onSave(draft.trim());
          }}
        >
          <Input
            type="text"
            autoComplete="off"
            spellCheck={false}
            aria-label="Özel Python yolu"
            placeholder="Otomatik (~/.venvs/…)"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={disabled}
            className="w-[210px]"
          />
          <Button type="submit" variant="secondary" size="sm" disabled={disabled || !dirty}>
            Kaydet
          </Button>
          {savedPath && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => {
                setDraft('');
                onSave('');
              }}
            >
              Sıfırla
            </Button>
          )}
        </form>
      }
    />
  );
}

function OpenAiSttEndpointRow({
  baseUrl,
  model,
  disabled,
  onSave,
}: {
  baseUrl: string;
  model: string;
  disabled: boolean;
  onSave: (patch: Partial<VoicePreferences>) => void;
}) {
  const [draftUrl, setDraftUrl] = useState(baseUrl);
  const [draftModel, setDraftModel] = useState(model);

  useEffect(() => {
    setDraftUrl(baseUrl);
  }, [baseUrl]);

  useEffect(() => {
    setDraftModel(model);
  }, [model]);

  const dirty = draftUrl.trim() !== baseUrl.trim() || draftModel.trim() !== model.trim();

  const applyPreset = (presetUrl: string, presetModel: string) => {
    setDraftUrl(presetUrl);
    setDraftModel(presetModel);
    onSave({ openAiSttBaseUrl: presetUrl, openAiSttModel: presetModel });
  };

  return (
    <SettingsRow
      label="Sunucu adresi ve model"
      description={
        <span className="flex flex-col gap-1.5">
          <span>Groq Whisper, OpenAI veya yerel HTTP (/audio/transcriptions) uç noktası.</span>
          <span className="flex flex-wrap gap-1">
            <Button
              type="button"
              variant="secondary"
              size="xs"
              disabled={disabled}
              onClick={() => applyPreset(DEFAULT_OPENAI_STT_BASE_URL, DEFAULT_OPENAI_STT_MODEL)}
            >
              Groq Whisper
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="xs"
              disabled={disabled}
              onClick={() => applyPreset('https://api.openai.com/v1', 'gpt-4o-mini-transcribe')}
            >
              OpenAI
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="xs"
              disabled={disabled}
              onClick={() => applyPreset('http://127.0.0.1:8080/v1', 'whisper-1')}
            >
              Yerel HTTP
            </Button>
          </span>
        </span>
      }
      control={
        <form
          className="flex flex-wrap items-center justify-end gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            onSave({
              openAiSttBaseUrl: draftUrl.trim() || DEFAULT_OPENAI_STT_BASE_URL,
              openAiSttModel: draftModel.trim() || DEFAULT_OPENAI_STT_MODEL,
            });
          }}
        >
          <Input
            type="url"
            autoComplete="off"
            spellCheck={false}
            aria-label="OpenAI Uyumlu STT Base URL"
            placeholder={DEFAULT_OPENAI_STT_BASE_URL}
            value={draftUrl}
            onChange={(event) => setDraftUrl(event.target.value)}
            disabled={disabled}
            className="w-[190px]"
          />
          <Input
            type="text"
            autoComplete="off"
            spellCheck={false}
            aria-label="OpenAI Uyumlu STT Modeli"
            placeholder={DEFAULT_OPENAI_STT_MODEL}
            value={draftModel}
            onChange={(event) => setDraftModel(event.target.value)}
            disabled={disabled}
            className="w-[140px]"
          />
          <Button type="submit" variant="secondary" size="sm" disabled={disabled || !dirty}>
            Kaydet
          </Button>
        </form>
      }
    />
  );
}

function EncryptedApiKeyRow({
  label,
  ariaLabel,
  placeholder,
  descriptionPrefix,
  externalUrl,
  externalLinkLabel,
  savedToast,
  removedToast,
  hasApiKey,
  loading,
  onSaveKey,
  onClearKey,
  onChanged,
}: {
  label: string;
  ariaLabel: string;
  placeholder: string;
  descriptionPrefix: string;
  externalUrl: string;
  externalLinkLabel: string;
  savedToast: string;
  removedToast: string;
  hasApiKey: boolean;
  loading: boolean;
  onSaveKey: (apiKey: string) => Promise<Result<void, VoiceError>>;
  onClearKey: () => Promise<Result<void, VoiceError>>;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const showInput = !hasApiKey || editing;

  const save = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    try {
      const result = await onSaveKey(draft);
      if (!result.success) {
        toast.error('API anahtarı kaydedilemedi', { description: voiceErrorMessage(result.error) });
        return;
      }
      setDraft('');
      setEditing(false);
      toast.success(savedToast);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      const result = await onClearKey();
      if (!result.success) {
        toast.error('API anahtarı silinemedi', { description: voiceErrorMessage(result.error) });
        return;
      }
      toast(removedToast);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsRow
      label={label}
      description={
        <span>
          {descriptionPrefix}{' '}
          <button
            type="button"
            className="inline-flex items-center gap-0.5 underline underline-offset-2"
            onClick={() => void openExternal(externalUrl)}
          >
            {externalLinkLabel} <ExternalLink className="size-3" aria-hidden />
          </button>
        </span>
      }
      control={
        showInput ? (
          <form
            className="flex items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label={ariaLabel}
              placeholder={placeholder}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              disabled={busy || loading}
              className="w-[183px]"
            />
            <Button type="submit" variant="primary" size="sm" disabled={busy || !draft.trim()}>
              Kaydet
            </Button>
            {editing && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditing(false);
                  setDraft('');
                }}
              >
                Vazgeç
              </Button>
            )}
          </form>
        ) : (
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-foreground-muted" aria-label="Anahtar kayıtlı">
              ••••••••••••
            </span>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => setEditing(true)}>
              Değiştir
            </Button>
            <Button
              variant="ghost"
              tone="destructive"
              size="sm"
              disabled={busy}
              onClick={() => void remove()}
            >
              Kaldır
            </Button>
          </div>
        )
      }
    />
  );
}

function TestConnectionRow({ hasApiKey }: { hasApiKey: boolean }) {
  const [testing, setTesting] = useState(false);
  const test = async () => {
    setTesting(true);
    try {
      const result = await (await getVoiceClient()).testConnection();
      if (result.success) {
        toast.success('ElevenLabs bağlantısı çalışıyor', {
          description: `${result.data.voiceCount} ses bulundu.`,
        });
      } else {
        toast.error('ElevenLabs bağlantısı başarısız', {
          description: voiceErrorMessage(result.error),
        });
      }
    } finally {
      setTesting(false);
    }
  };
  return (
    <SettingsRow
      label="Bağlantıyı test et"
      description="Kayıtlı anahtarla ElevenLabs'a bağlanıp ses listesini çeker."
      control={
        <Button
          variant="secondary"
          size="sm"
          disabled={!hasApiKey || testing}
          onClick={() => void test()}
        >
          {testing && <LoaderCircle className="animate-spin" />}
          Test et
        </Button>
      }
    />
  );
}

function MicrophonePriorityRow({
  preferredIds,
  disabled,
  onChange,
}: {
  preferredIds: string[];
  disabled?: boolean;
  onChange: (ids: string[]) => void;
}) {
  const [devices, setDevices] = useState<Array<{ deviceId: string; label: string }>>([]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return;
    let cancelled = false;
    const load = () => {
      void navigator.mediaDevices
        .enumerateDevices()
        .then((all) => {
          if (cancelled) return;
          const inputs = all
            .filter((d) => d.kind === 'audioinput' && d.deviceId)
            .map((d, idx) => ({
              deviceId: d.deviceId,
              label: d.label?.trim() || `Mikrofon ${idx + 1}`,
            }));
          setDevices(inputs);
        })
        .catch(() => undefined);
    };
    load();
    navigator.mediaDevices.addEventListener?.('devicechange', load);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener?.('devicechange', load);
    };
  }, []);

  const ordered = useMemo(() => {
    const byId = new Map(devices.map((d) => [d.deviceId, d]));
    const result: Array<{ deviceId: string; label: string }> = [];
    for (const id of preferredIds) {
      const found = byId.get(id);
      if (found) {
        result.push(found);
        byId.delete(id);
      }
    }
    for (const item of byId.values()) result.push(item);
    return result;
  }, [devices, preferredIds]);

  const move = (index: number, delta: -1 | 1) => {
    const ids = ordered.map((d) => d.deviceId);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    const [item] = ids.splice(index, 1);
    if (!item) return;
    ids.splice(target, 0, item);
    onChange(ids);
  };

  return (
    <SettingsRow
      label="Tercih edilen mikrofon sırası"
      description="Bağlı mikrofonlar arasında dikte başlatılırken üst sıradaki kullanılabilir cihaz seçilir."
      control={
        <div className="w-[260px] space-y-1">
          {ordered.length === 0 ? (
            <span className="text-xs text-foreground-muted">
              Mikrofon listesi için tarayıcı mikrofon izni gerekir.
            </span>
          ) : (
            ordered.map((mic, index) => (
              <div
                key={mic.deviceId}
                className="flex items-center justify-between gap-1.5 rounded border border-border bg-(--em-surface) px-2 py-1 text-xs"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <Mic className="text-muted-foreground h-3 w-3 shrink-0" />
                  <span className="truncate">{mic.label}</span>
                </span>
                <div className="flex shrink-0 items-center">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    icon
                    disabled={disabled || index === 0}
                    onClick={() => move(index, -1)}
                    aria-label="Yukarı taşı"
                  >
                    <ArrowUp className="h-3 w-3" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    icon
                    disabled={disabled || index === ordered.length - 1}
                    onClick={() => move(index, 1)}
                    aria-label="Aşağı taşı"
                  >
                    <ArrowDown className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      }
    />
  );
}
