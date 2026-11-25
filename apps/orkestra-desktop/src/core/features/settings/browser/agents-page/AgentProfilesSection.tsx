import {
  Badge,
  Button,
  Input,
  Label,
  Select,
  Textarea,
  toast,
} from '@orkestra/ui/react/primitives';
import { Layers, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type {
  ProviderCustomConfig,
  ProviderProfileConfig,
} from '@core/primitives/app-settings/api';

interface AgentProfilesSectionProps {
  storedConfig: ProviderCustomConfig | undefined;
  isLoading: boolean;
  update: (
    cfg: ProviderCustomConfig,
    opts?: { onSuccess?: () => void; onError?: (e: unknown) => void }
  ) => void;
}

function parseEnvLines(raw: string): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (/^[A-Za-z_]\w*$/.test(key)) {
      result[key] = val;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function AgentProfilesSection({
  storedConfig,
  isLoading,
  update,
}: AgentProfilesSectionProps) {
  const profiles = storedConfig?.profiles ?? [];
  const activeId = storedConfig?.activeProfileId ?? '__default__';

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [extraArgs, setExtraArgs] = useState('');
  const [envText, setEnvText] = useState('');

  const handleSelectActive = (nextId: string) => {
    update({
      ...(storedConfig ?? {}),
      activeProfileId: nextId === '__default__' ? undefined : nextId,
    });
  };

  const handleAddProfile = () => {
    const cleanName = name.trim();
    if (!cleanName) return;
    const profile: ProviderProfileConfig = {
      id: `prof-${Date.now().toString(36)}`,
      name: cleanName,
      ...(extraArgs.trim() ? { extraArgs: extraArgs.trim() } : {}),
      ...(parseEnvLines(envText) ? { env: parseEnvLines(envText) } : {}),
    };
    const nextProfiles = [...profiles, profile];
    update(
      {
        ...(storedConfig ?? {}),
        activeProfileId: profile.id,
        profiles: nextProfiles,
      },
      {
        onSuccess: () => {
          setName('');
          setExtraArgs('');
          setEnvText('');
          setAdding(false);
          toast.success(`"${profile.name}" profili oluşturuldu ve etkinleştirildi`);
        },
      }
    );
  };

  const handleDeleteProfile = (id: string) => {
    const nextProfiles = profiles.filter((p) => p.id !== id);
    update({
      ...(storedConfig ?? {}),
      activeProfileId:
        storedConfig?.activeProfileId === id ? undefined : storedConfig?.activeProfileId,
      profiles: nextProfiles.length > 0 ? nextProfiles : undefined,
    });
  };

  return (
    <div className="space-y-3 rounded-lg border border-border bg-(--em-surface) p-3.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-medium text-foreground">
          <Layers className="h-3.5 w-3.5 text-blue-400" />
          <span>Yapılandırma Profilleri</span>
          <Badge variant="soft" tone="neutral">
            {profiles.length}
          </Badge>
        </div>
        {!adding && (
          <Button type="button" variant="secondary" size="xs" onClick={() => setAdding(true)}>
            <Plus className="h-3 w-3" />
            Profil Ekle
          </Button>
        )}
      </div>
      <p className="text-muted-foreground text-[11px]">
        İş, kişisel veya farklı API anahtarları/argümanlar için profiller tanımlayıp tek tıkla geçiş
        yapın. (<code className="text-[10px]">op://</code> 1Password referansları desteklenir.)
      </p>

      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs text-foreground">Aktif profil</Label>
        <Select.Root
          value={activeId}
          onValueChange={(next) => handleSelectActive(String(next))}
          disabled={isLoading}
        >
          <Select.Trigger className="w-[210px] shrink-0">
            <Select.Value>
              {activeId === '__default__'
                ? 'Varsayılan (Profil Yok)'
                : (profiles.find((p) => p.id === activeId)?.name ?? 'Varsayılan (Profil Yok)')}
            </Select.Value>
          </Select.Trigger>
          <Select.Content align="end">
            <Select.Item value="__default__">Varsayılan (Profil Yok)</Select.Item>
            {profiles.map((p) => (
              <Select.Item key={p.id} value={p.id}>
                {p.name}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      </div>

      {profiles.length > 0 && (
        <div className="space-y-1.5 pt-1">
          {profiles.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between gap-2 rounded border border-border/70 bg-background px-2.5 py-1.5"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 font-medium text-foreground">
                  <span className="truncate">{p.name}</span>
                  {activeId === p.id && (
                    <Badge variant="soft" tone="success">
                      Aktif
                    </Badge>
                  )}
                </div>
                <div className="text-muted-foreground truncate text-[11px]">
                  {p.extraArgs ? `Args: ${p.extraArgs}` : 'Ek argüman yok'}
                  {p.env ? ` · ${Object.keys(p.env).length} env değişkeni` : ''}
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                icon
                aria-label={`${p.name} profilini sil`}
                onClick={() => handleDeleteProfile(p.id)}
              >
                <Trash2 className="text-muted-foreground hover:text-destructive h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {adding && (
        <div className="space-y-2 rounded-md border border-border bg-background p-2.5">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Profil adı (ör. İş / Ollama / Yüksek Limit)"
            className="h-8 text-xs"
          />
          <Input
            value={extraArgs}
            onChange={(e) => setExtraArgs(e.target.value)}
            placeholder="Ek CLI argümanları (opsiyonel)"
            className="h-8 font-mono text-xs"
          />
          <Textarea
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
            placeholder={
              'Ortam değişkenleri (satır başına bir ANAHTAR=DEĞER)\nOPENAI_API_KEY=op://Work/OpenAI/key'
            }
            rows={3}
            className="font-mono text-[11px]"
          />
          <div className="flex justify-end gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                setAdding(false);
                setName('');
                setExtraArgs('');
                setEnvText('');
              }}
            >
              Vazgeç
            </Button>
            <Button
              type="button"
              variant="primary"
              size="xs"
              disabled={!name.trim()}
              onClick={handleAddProfile}
            >
              Profili Kaydet
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
