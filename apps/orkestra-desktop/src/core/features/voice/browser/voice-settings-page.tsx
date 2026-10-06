import { PageLayout, SettingsRow, SettingsSection } from '@orkestra/ui/react/patterns';
import { Alert, Button, Input, Select, toast } from '@orkestra/ui/react/primitives';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, LoaderCircle, RefreshCw, Volume2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { getVoiceClient } from '@core/features/voice/api/browser/client';
import {
  DEFAULT_VOICE_PREFERENCES,
  type TtsModelId,
  type VoicePreferences,
  type VoiceStatus,
  type VoiceSummary,
} from '@core/features/voice/api/contract';
import { voiceErrorMessage } from '@core/features/voice/api/voice-errors';
import { getSpokenRepliesStore } from '@core/features/voice/contributions/app-stores';
import { openExternal } from '@core/primitives/desktop-host/browser/host-client';
import { detectPlatformContext } from '@core/primitives/keybindings/api';

// Ayarlar > Ses: ElevenLabs API anahtarı (şifreli saklanır, renderer'a geri dönmez),
// dikte dili ve sesli yanıt sesi.

const STATUS_QUERY_KEY = ['voice', 'status'] as const;
const VOICES_QUERY_KEY = ['voice', 'voices'] as const;
const API_KEYS_URL = 'https://elevenlabs.io/app/settings/api-keys';
const PREVIEW_ID = '__voice-settings-preview__';
const PREVIEW_TEXT = 'Merhaba, ben Orkestra. Sesli yanıtlar bu sesle okunacak.';

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

  const shortcut = detectPlatformContext().os === 'mac' ? '⌘⇧Space' : 'Ctrl+Shift+Space';

  return (
    <div className="space-y-8 pb-10">
      <PageLayout.Header
        sticky
        draggable
        title="Ses"
        description="Sohbette sesle yazma (dikte) ve asistan yanıtlarını sesli okuma. ElevenLabs kullanılır."
      />

      {status.data && !status.data.secureStorageAvailable && (
        <Alert.Root status="warning">
          <Alert.Title>Güvenli depolama kullanılamıyor</Alert.Title>
          <Alert.Description>
            Bu sistemde şifreli anahtar deposu yok; API anahtarı kaydedilemez.
          </Alert.Description>
        </Alert.Root>
      )}

      <SettingsSection title="ElevenLabs">
        <ApiKeyRow
          hasApiKey={hasApiKey}
          loading={status.isLoading}
          onChanged={() => {
            void queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
            void queryClient.invalidateQueries({ queryKey: VOICES_QUERY_KEY });
          }}
        />
        <TestConnectionRow hasApiKey={hasApiKey} />
      </SettingsSection>

      <SettingsSection title="Sesle yazma">
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

function ApiKeyRow({
  hasApiKey,
  loading,
  onChanged,
}: {
  hasApiKey: boolean;
  loading: boolean;
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
      const result = await (await getVoiceClient()).setApiKey({ apiKey: draft });
      if (!result.success) {
        toast.error('API anahtarı kaydedilemedi', { description: voiceErrorMessage(result.error) });
        return;
      }
      setDraft('');
      setEditing(false);
      toast.success('ElevenLabs API anahtarı şifreli olarak kaydedildi');
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      const result = await (await getVoiceClient()).clearApiKey();
      if (!result.success) {
        toast.error('API anahtarı silinemedi', { description: voiceErrorMessage(result.error) });
        return;
      }
      toast('ElevenLabs API anahtarı kaldırıldı');
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsRow
      label="API anahtarı"
      description={
        <span>
          Anahtar işletim sisteminin güvenli deposuyla şifrelenir ve yalnızca ana süreçte
          kullanılır.{' '}
          <button
            type="button"
            className="inline-flex items-center gap-0.5 underline underline-offset-2"
            onClick={() => void openExternal(API_KEYS_URL)}
          >
            Anahtar al <ExternalLink className="size-3" aria-hidden />
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
              aria-label="ElevenLabs API anahtarı"
              placeholder="sk_…"
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
