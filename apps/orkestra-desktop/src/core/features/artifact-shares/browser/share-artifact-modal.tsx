import { createTranscriptArtifactResolver } from '@core/features/conversations/browser/acp/transcript-artifact-commands';
import { getHostClient } from '@core/primitives/desktop-host/browser/host-client';
import { defineModal } from '@core/primitives/modals/react';
import { Button, Dialog, toast } from '@orkestra/ui/react/primitives';
import { useCallback, useEffect, useState } from 'react';
import type { ArtifactShareInfo } from '../api';
import { getArtifactSharesClient } from '../api/browser/client';
import { buildSingleFileHtml, bytesToBase64, shareFileName } from './artifact-share-payload';

export type ShareArtifactArgs = {
  projectId: string;
  taskId: string;
  artifact: { uri: string; name: string; mimeType?: string };
};

async function readArtifactBytes(args: ShareArtifactArgs): Promise<Uint8Array> {
  const resolved = await createTranscriptArtifactResolver(args)(args.artifact);
  try {
    const response = await fetch(resolved.url);
    return new Uint8Array(await response.arrayBuffer());
  } finally {
    resolved.dispose?.();
  }
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function ShareArtifactModal(args: ShareArtifactArgs) {
  const [shares, setShares] = useState<ArtifactShareInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileName = shareFileName(args.artifact.name);

  const refresh = useCallback(async () => {
    setShares(await (await getArtifactSharesClient()).list());
  }, []);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  const exportHtml = async () => {
    setBusy(true);
    setError(null);
    try {
      const bytes = await readArtifactBytes(args);
      const html = buildSingleFileHtml({ ...args.artifact, bytes });
      if (html === null) {
        setError(
          'Bu dosya türü tek dosya HTML olarak dışa aktarılamıyor. Yerel ağ bağlantısını kullan.'
        );
        return;
      }
      const saved = await (
        await getHostClient()
      ).saveTextFile({
        title: 'Artifact’i HTML olarak dışa aktar',
        defaultPath: fileName.replace(/\.[^.]*$/, '') + '.html',
        content: html,
      });
      if (!saved.success) setError('Dosya kaydedilemedi.');
      else if (saved.path) toast('Artifact dışa aktarıldı');
    } catch {
      setError('Artifact okunamadı. Dosyanın varlığını ve makine bağlantısını kontrol et.');
    } finally {
      setBusy(false);
    }
  };

  const createLink = async () => {
    setBusy(true);
    setError(null);
    try {
      const bytes = await readArtifactBytes(args);
      const result = await (
        await getArtifactSharesClient()
      ).create({
        name: fileName,
        entry: fileName,
        files: [{ path: fileName, base64: bytesToBase64(bytes) }],
      });
      if (!result.success) setError(result.error.message);
      await refresh();
    } catch {
      setError('Paylaşım oluşturulamadı.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    await (await getArtifactSharesClient()).revoke({ id });
    await refresh();
  };

  const copy = (url: string) => {
    void navigator.clipboard.writeText(url).then(() => toast('Bağlantı kopyalandı'));
  };

  return (
    <>
      <Dialog.Header>
        <Dialog.Title>Artifact’i paylaş</Dialog.Title>
        <Dialog.Description>{fileName}</Dialog.Description>
      </Dialog.Header>
      <div className="flex flex-col gap-4 px-6 pb-2 text-sm">
        <section className="flex flex-col gap-2">
          <h3 className="font-medium">Tek dosya HTML olarak dışa aktar</h3>
          <p className="text-muted-foreground">
            Dosyayı diske kaydeder; dilediğin gibi gönderebilirsin. Sunucu gerekmez.
          </p>
          <div>
            <Button variant="secondary" disabled={busy} onClick={() => void exportHtml()}>
              HTML olarak kaydet
            </Button>
          </div>
        </section>
        <section className="flex flex-col gap-2">
          <h3 className="font-medium">Yerel ağ bağlantısı</h3>
          <p className="text-muted-foreground">
            Bağlantıyı yalnızca aynı ağdaki (Wi-Fi/LAN) cihazlar açabilir. Adres şifresizdir (http):
            ağdaki herkes bağlantıyı bilirse içeriği görebilir. Uygulamayı kapattığında tüm
            bağlantılar ölür. Sunucu, yalnızca ilk paylaşımda başlar ve son paylaşım iptal edilince
            durur.
          </p>
          <div>
            <Button variant="secondary" disabled={busy} onClick={() => void createLink()}>
              Yerel ağ bağlantısı oluştur
            </Button>
          </div>
        </section>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <section className="flex flex-col gap-2">
          <h3 className="font-medium">Etkin paylaşımlar</h3>
          {shares.length === 0 && <p className="text-muted-foreground">Etkin paylaşım yok.</p>}
          {shares.map((share) => (
            <div key={share.id} className="flex flex-col gap-1 rounded border border-border p-2">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">
                  {share.name} · {formatSize(share.sizeBytes)}
                </span>
                <Button variant="secondary" onClick={() => void revoke(share.id)}>
                  İptal et
                </Button>
              </div>
              {share.urls.map((url) => (
                <button
                  key={url}
                  type="button"
                  className="text-muted-foreground truncate text-left font-mono text-xs hover:underline"
                  title="Kopyalamak için tıkla"
                  onClick={() => copy(url)}
                >
                  {url}
                </button>
              ))}
            </div>
          ))}
        </section>
      </div>
    </>
  );
}

export const shareArtifactModal = defineModal<void>()({
  id: 'shareArtifactModal',
  component: ShareArtifactModal,
  size: 'lg',
});
