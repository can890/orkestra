import { SettingsRow, SettingsSection } from '@orkestra/ui/react/patterns';
import { Button, Input, Select, Switch, toast } from '@orkestra/ui/react/primitives';
import { Check, LoaderCircle, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import { getTextGenerationClient } from '@core/features/text-generation/api/browser/client';
import type {
  TextGenerationModelSummary,
  TextGenerationStatus,
} from '@core/features/text-generation/api/contract';
import type {
  TextGenerationProvider,
  TextGenerationSettings,
} from '@core/primitives/app-settings/api';

const DEFAULT_SETTINGS: TextGenerationSettings = {
  enabled: false,
  provider: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  autoTitleTasks: true,
  promptSuggestionsEnabled: true,
};

const PROVIDER_LABELS: Record<TextGenerationProvider, string> = {
  'openai-compatible': 'OpenAI Uyumlu (OpenAI / OpenRouter / Groq)',
  anthropic: 'Anthropic (Claude)',
};

export function TextGenerationSettingsCard() {
  const { value, update, isLoading, isSaving } = useAppSettingsKey('textGeneration');
  const current = value ?? DEFAULT_SETTINGS;

  const [status, setStatus] = useState<TextGenerationStatus | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [editingKey, setEditingKey] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [models, setModels] = useState<TextGenerationModelSummary[]>([]);

  const refreshStatus = async () => {
    try {
      const client = await getTextGenerationClient();
      setStatus(await client.getStatus());
    } catch {
      // Başlangıçta yoksay
    }
  };

  useEffect(() => {
    void refreshStatus();
  }, [current.enabled, current.provider, current.baseUrl, current.model]);

  const handleSaveApiKey = async () => {
    if (!apiKeyDraft.trim()) return;
    setKeyBusy(true);
    try {
      const client = await getTextGenerationClient();
      const res = await client.setApiKey({ apiKey: apiKeyDraft.trim() });
      if (!res.success) {
        toast.error('API anahtarı kaydedilemedi', { description: res.error.message });
        return;
      }
      setApiKeyDraft('');
      setEditingKey(false);
      toast.success('Text Generator API anahtarı şifreli olarak kaydedildi');
      await refreshStatus();
    } finally {
      setKeyBusy(false);
    }
  };

  const handleClearApiKey = async () => {
    setKeyBusy(true);
    try {
      const client = await getTextGenerationClient();
      const res = await client.clearApiKey();
      if (!res.success) {
        toast.error('API anahtarı silinemedi', { description: res.error.message });
        return;
      }
      toast('Text Generator API anahtarı kaldırıldı');
      await refreshStatus();
    } finally {
      setKeyBusy(false);
    }
  };

  const handleFetchModels = async () => {
    setLoadingModels(true);
    try {
      const client = await getTextGenerationClient();
      const res = await client.listModels();
      if (!res.success) {
        toast.error('Modeller alınamadı', { description: res.error.message });
        return;
      }
      setModels(res.data);
      toast.success(`${res.data.length} model yüklendi`);
    } finally {
      setLoadingModels(false);
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    try {
      const client = await getTextGenerationClient();
      const res = await client.testConnection();
      if (!res.success) {
        toast.error('Bağlantı testi başarısız', { description: res.error.message });
        return;
      }
      toast.success('Text Generator bağlantısı başarılı', {
        description: `Gecikme: ${res.data.latencyMs} ms${res.data.modelCount ? ` · ${res.data.modelCount} model` : ''}`,
      });
    } finally {
      setTesting(false);
    }
  };

  const hasApiKey = status?.hasApiKey ?? false;
  const showKeyInput = !hasApiKey || editingKey;

  return (
    <SettingsSection title="Text Generator API">
      <SettingsRow
        label="Hafif yardımcı model API"
        description="Başlık üretimi, akıllı devam önerileri, inceleme turu ve yan sohbet için hızlı/ucuz bir yardımcı model kullanın. Anahtar şifreli saklanır."
        control={
          <Switch
            aria-label="Hafif yardımcı model API"
            checked={current.enabled}
            disabled={isLoading || isSaving}
            onCheckedChange={(checked) => update({ enabled: checked })}
          />
        }
      />

      <SettingsRow
        label="Sağlayıcı"
        description="OpenAI uyumlu uç noktalar (OpenAI, OpenRouter, Ollama, Groq) veya Anthropic Messages API."
        control={
          <Select.Root
            value={current.provider}
            onValueChange={(next) => {
              const provider = next as TextGenerationProvider;
              const defaultBase =
                provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1';
              const defaultModel =
                provider === 'anthropic' ? 'claude-3-5-haiku-latest' : 'gpt-4o-mini';
              update({
                provider,
                baseUrl:
                  current.baseUrl === 'https://api.openai.com/v1' ||
                  current.baseUrl === 'https://api.anthropic.com'
                    ? defaultBase
                    : current.baseUrl,
                model:
                  current.model === 'gpt-4o-mini' || current.model === 'claude-3-5-haiku-latest'
                    ? defaultModel
                    : current.model,
              });
            }}
            disabled={isLoading || isSaving}
          >
            <Select.Trigger className="w-[240px] shrink-0">
              <Select.Value>{PROVIDER_LABELS[current.provider]}</Select.Value>
            </Select.Trigger>
            <Select.Content align="end">
              <Select.Item value="openai-compatible">
                {PROVIDER_LABELS['openai-compatible']}
              </Select.Item>
              <Select.Item value="anthropic">{PROVIDER_LABELS.anthropic}</Select.Item>
            </Select.Content>
          </Select.Root>
        }
      />

      <SettingsRow
        label="Base URL"
        description="API uç noktasının temel adresi (ör. https://api.openai.com/v1)."
        control={
          <Input
            type="url"
            value={current.baseUrl}
            onChange={(e) => update({ baseUrl: e.target.value })}
            placeholder="https://api.openai.com/v1"
            className="w-[240px]"
            disabled={isLoading}
          />
        }
      />

      <SettingsRow
        label="API anahtarı"
        description="Anahtar yalnızca ana süreçte, işletim sistemi güvenli deposunda şifreli tutulur."
        control={
          showKeyInput ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                void handleSaveApiKey();
              }}
            >
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-..."
                value={apiKeyDraft}
                onChange={(e) => setApiKeyDraft(e.target.value)}
                disabled={keyBusy}
                className="w-[180px]"
              />
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={keyBusy || !apiKeyDraft.trim()}
              >
                Kaydet
              </Button>
              {editingKey && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setEditingKey(false);
                    setApiKeyDraft('');
                  }}
                >
                  Vazgeç
                </Button>
              )}
            </form>
          ) : (
            <div className="flex items-center gap-1.5">
              <span className="inline-flex items-center gap-1 text-xs text-emerald-500">
                <Check className="h-3.5 w-3.5" />
                Kayıtlı
              </span>
              <Button variant="secondary" size="sm" onClick={() => setEditingKey(true)}>
                Değiştir
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon
                aria-label="API anahtarını sil"
                disabled={keyBusy}
                onClick={() => void handleClearApiKey()}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          )
        }
      />

      <SettingsRow
        label="Model ve bağlantı testi"
        description="Kullanılacak model kimliğini yazın veya sağlayıcıdan listeyi çekip bağlantıyı doğrulayın."
        control={
          <div className="flex items-center gap-1.5">
            <Input
              list="orkestra-text-gen-models"
              value={current.model}
              onChange={(e) => update({ model: e.target.value })}
              placeholder="gpt-4o-mini"
              className="w-[180px]"
              disabled={isLoading}
            />
            {models.length > 0 && (
              <datalist id="orkestra-text-gen-models">
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </datalist>
            )}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!hasApiKey || loadingModels}
              onClick={() => void handleFetchModels()}
              title="Modelleri Getir"
            >
              {loadingModels ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Modelleri Getir
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!hasApiKey || testing}
              onClick={() => void handleTestConnection()}
            >
              {testing ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              Bağlantıyı Test Et
            </Button>
          </div>
        }
      />

      <SettingsRow
        label="Otomatik görev başlığı"
        description="Yeni sohbetlerin görev başlığını yapılandırılmış yardımcı API ile otomatik adlandır."
        control={
          <Switch
            aria-label="Otomatik görev başlığı"
            checked={current.autoTitleTasks}
            disabled={isLoading || isSaving}
            onCheckedChange={(checked) => update({ autoTitleTasks: checked })}
          />
        }
      />

      <SettingsRow
        label="Sohbet prompt önerileri"
        description="Ajan turunu tamamladığında sohbet kutusunun üstünde hızlı takip önerileri göster."
        control={
          <Switch
            aria-label="Sohbet prompt önerileri"
            checked={current.promptSuggestionsEnabled}
            disabled={isLoading || isSaving}
            onCheckedChange={(checked) => update({ promptSuggestionsEnabled: checked })}
          />
        }
      />
    </SettingsSection>
  );
}
