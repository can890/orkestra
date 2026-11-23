import { SettingsRow, SettingsSection } from '@orkestra/ui/react/patterns';
import { Badge, Button, Input, Switch, toast } from '@orkestra/ui/react/primitives';
import { KeyRound, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { getSecretsClient } from '@core/features/secrets/api/browser/client';
import type { OnePasswordStatus } from '@core/features/secrets/api/contract';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';
import type { SecretsSettings } from '@core/primitives/app-settings/api';

const DEFAULT_SECRETS: SecretsSettings = {
  onePasswordEnabled: false,
  onePasswordAccount: '',
  redactTranscriptSecrets: true,
};

export function SecretsSettingsCard() {
  const { value, update, isLoading, isSaving } = useAppSettingsKey('secrets');
  const current = value ?? DEFAULT_SECRETS;

  const [cliStatus, setCliStatus] = useState<OnePasswordStatus | null>(null);
  const [checkingCli, setCheckingCli] = useState(false);
  const [testRef, setTestRef] = useState('');
  const [testingRef, setTestingRef] = useState(false);

  const checkCli = useCallback(async () => {
    setCheckingCli(true);
    try {
      const client = await getSecretsClient();
      const status = await client.checkOnePasswordCli({
        account: current.onePasswordAccount || undefined,
      });
      setCliStatus(status);
    } catch {
      // Başlangıçta yoksay
    } finally {
      setCheckingCli(false);
    }
  }, [current.onePasswordAccount]);

  useEffect(() => {
    void checkCli();
  }, [checkCli]);

  const handleTestReference = async () => {
    if (!testRef.trim()) return;
    setTestingRef(true);
    try {
      const client = await getSecretsClient();
      const res = await client.resolvePreview({
        reference: testRef.trim(),
        account: current.onePasswordAccount || undefined,
      });
      if (!res.ok) {
        toast.error('1Password referansı çözümlenemedi', { description: res.error });
        return;
      }
      toast.success('Referans başarıyla doğrulandı', {
        description: `Önizleme (maskeli): ${res.maskedPreview}`,
      });
    } finally {
      setTestingRef(false);
    }
  };

  return (
    <SettingsSection title="Gizli Anahtarlar & 1Password">
      <SettingsRow
        label="1Password op:// referans çözücü"
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            <span>
              Ajan ortam değişkenlerindeki <code className="text-[11px]">op://vault/item/field</code>{' '}
              referanslarını oturum başlatılırken bellek içinde otomatik çözümler.
            </span>
            {cliStatus && (
              <Badge
                variant="soft"
                tone={cliStatus.installed && cliStatus.signedIn ? 'success' : 'warning'}
              >
                {cliStatus.installed
                  ? cliStatus.signedIn
                    ? `op ${cliStatus.version ?? ''} · Oturum açık${cliStatus.accountEmail ? ` (${cliStatus.accountEmail})` : ''}`
                    : `op ${cliStatus.version ?? ''} · Oturum kapalı`
                  : 'op CLI bulunamadı'}
              </Badge>
            )}
          </span>
        }
        control={
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={checkingCli}
              onClick={() => void checkCli()}
              title="1Password CLI durumunu denetle"
            >
              {checkingCli ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
            </Button>
            <Switch
              aria-label="1Password op:// referans çözücü"
              checked={current.onePasswordEnabled}
              disabled={isLoading || isSaving}
              onCheckedChange={(checked) => update({ onePasswordEnabled: checked })}
            />
          </div>
        }
      />

      <SettingsRow
        label="1Password hesap adı (opsiyonel)"
        description="Birden fazla 1Password hesabınız varsa `--account` parametresi olarak geçirilir."
        control={
          <Input
            value={current.onePasswordAccount}
            onChange={(e) => update({ onePasswordAccount: e.target.value })}
            placeholder="my.1password.com"
            className="w-[220px]"
            disabled={isLoading}
          />
        }
      />

      <SettingsRow
        label="op:// referansını test et"
        description="Çözümlemeyi doğrulamak için bir op:// adresi girin; yalnızca maskelenmiş önizleme gösterilir."
        control={
          <div className="flex items-center gap-1.5">
            <Input
              value={testRef}
              onChange={(e) => setTestRef(e.target.value)}
              placeholder="op://Private/API/credential"
              className="w-[220px]"
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={testingRef || !testRef.trim()}
              onClick={() => void handleTestReference()}
            >
              {testingRef ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <KeyRound className="h-3.5 w-3.5" />
              )}
              Doğrula
            </Button>
          </div>
        }
      />

      <SettingsRow
        label="Sohbet kopyalamada gizli anahtarları maskele"
        description={
          <span className="inline-flex items-center gap-1">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
            Sağ tık Kopyala / Alıntıla işlemlerinde API anahtarları, tokenlar ve PEM bloklarını{' '}
            <code className="text-[11px]">[GİZLENDİ]</code> olarak değiştirir.
          </span>
        }
        control={
          <Switch
            aria-label="Sohbet kopyalamada gizli anahtarları maskele"
            checked={current.redactTranscriptSecrets}
            disabled={isLoading || isSaving}
            onCheckedChange={(checked) => update({ redactTranscriptSecrets: checked })}
          />
        }
      />
    </SettingsSection>
  );
}
