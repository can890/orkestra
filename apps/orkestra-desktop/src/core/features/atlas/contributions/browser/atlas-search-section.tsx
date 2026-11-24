import { Button, Input, toast } from '@orkestra/ui/react/primitives';
import { useState } from 'react';
import { getAtlasClient } from '@core/features/atlas/api/browser/client';
import { useAppSettingsKey } from '@core/features/settings/api/browser/use-app-settings-key';

/**
 * Proje hafızası panelindeki salt okunur Atlas araması (insan için). "Atlas'ı bilgi kaynağı
 * olarak kullan" ayarı kapalıyken hiç görünmez.
 */
export function AtlasSearchSection({ projectId }: { projectId: string }) {
  const { value } = useAppSettingsKey('atlas');
  const [query, setQuery] = useState('');
  const [output, setOutput] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!value?.searchEnabled) return null;

  const run = async (kind: 'search' | 'history') => {
    setBusy(true);
    try {
      const client = await getAtlasClient();
      const result =
        kind === 'search'
          ? await client.search({ query, limit: 5 })
          : await client.projectHistory({ projectId });
      if (result.success) setOutput(result.data || 'No matches.');
      else toast.error('Atlas request failed', { description: result.error.message });
    } catch (error) {
      toast.error('Atlas request failed', { description: String(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Atlas" className="mt-6 flex flex-col gap-2 border-t border-border pt-6">
      <div>
        <h3 className="text-sm font-medium">Atlas</h3>
        <p className="text-xs leading-relaxed text-foreground-muted">
          Search your Atlas notes (read-only). Agents in this project can use the same search
          through the orkestra-atlas tools.
        </p>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (query.trim()) void run('search');
        }}
      >
        <Input
          aria-label="Search Atlas"
          placeholder="Search Atlas notes"
          value={query}
          maxLength={200}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button type="submit" variant="secondary" size="sm" disabled={busy || !query.trim()}>
          Search
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => void run('history')}
        >
          Project history
        </Button>
      </form>
      {output !== null ? (
        <pre className="max-h-[40dvh] overflow-auto rounded-md border border-border bg-background-1 p-2.5 text-xs whitespace-pre-wrap">
          {output}
        </pre>
      ) : null}
    </section>
  );
}
