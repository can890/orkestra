import { Button, Input, Switch, Textarea, toast } from '@orkestra/ui/react/primitives';
import { Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { getProjectMemoryClient } from '@core/features/project-memory/api/browser/client';
import {
  MEMORY_LIMITS,
  type MemoryEntrySummary,
} from '@core/features/project-memory/api/memory-model';

type Draft = { name: string; description: string; content: string; isNew: boolean };

/**
 * Proje ayarlarındaki "Ortak hafıza" bölümü: projedeki ajanların birlikte kullandığı notları
 * gösterir, düzenler ve siler. Ayar varsayılan olarak kapalıdır; kapalıyken ajanlara araç
 * verilmez ve ilk prompt'a hiçbir şey eklenmez (mevcut notlar yine de burada görülür).
 */
export function ProjectMemoryPanel({ projectId }: { projectId: string }) {
  const [enabled, setEnabled] = useState(false);
  const [entries, setEntries] = useState<MemoryEntrySummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const client = await getProjectMemoryClient();
    const result = await client.getState({ projectId });
    if (result.success) {
      setEnabled(result.data.enabled);
      setEntries(result.data.entries);
    } else {
      toast.error(result.error.message);
    }
    setLoaded(true);
  }, [projectId]);

  useEffect(() => {
    setLoaded(false);
    setDraft(null);
    void refresh().catch((error: unknown) => toast.error(String(error)));
  }, [refresh]);

  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      await (await getProjectMemoryClient()).setEnabled({ projectId, enabled: next });
      setEnabled(next);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  const edit = async (name: string) => {
    const result = await (await getProjectMemoryClient()).read({ projectId, name });
    if (!result.success) {
      toast.error(result.error.message);
      return;
    }
    setDraft({
      name,
      description: result.data.description,
      content: result.data.content,
      isNew: false,
    });
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const result = await (
        await getProjectMemoryClient()
      ).write({
        projectId,
        name: draft.name.trim(),
        description: draft.description,
        content: draft.content,
      });
      if (!result.success) {
        toast.error(result.error.message);
        return;
      }
      setDraft(null);
      await refresh();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    setBusy(true);
    try {
      const result = await (await getProjectMemoryClient()).remove({ projectId, name });
      if (!result.success) toast.error(result.error.message);
      if (draft?.name === name) setDraft(null);
      await refresh();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-label="Ortak hafıza"
      className="mt-8 flex flex-col gap-3 border-t border-border pt-6"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">Ortak hafıza</h3>
          <p className="text-xs leading-relaxed text-foreground-muted">
            Bu projede çalışan ajanların okuyup yazabildiği kalıcı notlar. Açıkken ajanlara hafıza
            araçları verilir ve yeni sohbetin ilk mesajına not dizini eklenir. Notlar başka ajanlar
            tarafından yazılır; parola ve anahtar saklanmamalıdır. Değişiklik yeni veya yeniden
            başlatılan sohbetlerde geçerli olur.
          </p>
        </div>
        <Switch
          size="sm"
          aria-label="Ortak hafızayı aç"
          checked={enabled}
          disabled={!loaded || busy}
          onCheckedChange={(next) => void toggle(next)}
        />
      </div>

      {loaded && entries.length === 0 && !draft ? (
        <p className="text-xs text-foreground-muted">Henüz kayıtlı not yok.</p>
      ) : null}

      <ul className="flex flex-col gap-1">
        {entries.map((entry) => (
          <li
            key={entry.name}
            className="flex items-center gap-2 rounded-md border border-border bg-background-1 px-2.5 py-2"
          >
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={() => void edit(entry.name)}
            >
              <div className="truncate text-sm text-foreground">{entry.name}</div>
              <div className="truncate text-xs text-foreground-muted">{entry.description}</div>
            </button>
            <Button
              variant="ghost"
              size="xs"
              icon
              disabled={busy}
              aria-label={`${entry.name} notunu sil`}
              onClick={() => void remove(entry.name)}
            >
              <Trash2 />
            </Button>
          </li>
        ))}
      </ul>

      {draft ? (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3">
          <Input
            value={draft.name}
            disabled={!draft.isNew}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="not-adi (küçük harf, rakam, tire)"
            aria-label="Not adı"
          />
          <Input
            value={draft.description}
            maxLength={MEMORY_LIMITS.maxDescriptionChars}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            placeholder="Tek satırlık açıklama"
            aria-label="Açıklama"
          />
          <Textarea
            value={draft.content}
            onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            placeholder="Not içeriği (markdown)"
            aria-label="İçerik"
            className="max-h-[40dvh] min-h-32 resize-y overflow-y-auto px-3 py-2.5 text-sm"
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setDraft(null)} disabled={busy}>
              Vazgeç
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void save()}
              disabled={busy || !draft.name.trim() || !draft.description.trim()}
            >
              Kaydet
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button
            variant="secondary"
            size="sm"
            disabled={!loaded || busy}
            onClick={() => setDraft({ name: '', description: '', content: '', isNew: true })}
          >
            Not ekle
          </Button>
        </div>
      )}
    </section>
  );
}
