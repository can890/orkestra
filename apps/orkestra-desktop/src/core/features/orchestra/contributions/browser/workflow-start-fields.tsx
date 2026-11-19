import { Button, Field, Select, Switch, Textarea } from '@orkestra/ui/react/primitives';
import { useCallback, useEffect, useState } from 'react';
import { getWorkflowsClient } from '@core/features/orchestra/api/browser/workflow-client';
import {
  WORKFLOW_DEFAULT_CONCURRENCY,
  WORKFLOW_MAX_CONCURRENCY,
  WORKFLOW_MAX_INPUT_CHARS,
  type WorkflowDefinition,
} from '@core/features/orchestra/api/workflow';
import { openModal } from '@core/manifests/browser/modal-api';
import { useLocalStorage } from '@core/primitives/react-hooks/browser/useLocalStorage';

export type WorkflowStartDraft = ReturnType<typeof useWorkflowStartDraft>;

/** "İş akışı" modunun durumu: kayıtlı iş akışları, seçim, giriş metni ve çalıştırma ayarları. */
export function useWorkflowStartDraft() {
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useLocalStorage<string | null>(
    'orchestra:workflow-selected',
    null
  );
  const [input, setInput] = useState('');
  // Varsayılan kapalı: iş akışı işçi izinlerini kendiliğinden onaylamaz.
  const [autoApprove, setAutoApprove] = useState(false);
  const [maxConcurrency, setMaxConcurrency] = useState(WORKFLOW_DEFAULT_CONCURRENCY);

  const refresh = useCallback(async () => {
    try {
      setWorkflows(await (await getWorkflowsClient()).list());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = workflows.find((workflow) => workflow.id === selectedId) ?? workflows[0] ?? null;

  return {
    workflows,
    loading,
    selected,
    select: setSelectedId,
    input,
    setInput,
    autoApprove,
    setAutoApprove,
    maxConcurrency,
    setMaxConcurrency,
    refresh,
  };
}

export function WorkflowStartFields({
  draft,
  connectionId,
}: {
  draft: WorkflowStartDraft;
  connectionId: string | undefined;
}) {
  const { selected } = draft;
  const edit = async (workflowId: string | null) => {
    await openModal('workflowEditorModal', { connectionId, workflowId });
    await draft.refresh();
  };
  return (
    <>
      <p className="text-xs text-foreground-muted">
        Şef (LLM) olmadan, önceden tanımladığınız adımları sırayla ya da paralel çalıştırır. Her
        adım kendi sohbetinde görünür; hangi ajanın neyi yapacağını siz belirlersiniz.
      </p>
      <Field.Root>
        <Field.Label>İş akışı</Field.Label>
        <div className="flex items-center gap-2">
          <Select.Root
            value={selected?.id ?? ''}
            onValueChange={(value) => draft.select(value || null)}
          >
            <Select.Trigger appearance="input" className="w-full">
              <Select.Value placeholder="Kayıtlı iş akışı yok">{selected?.name}</Select.Value>
            </Select.Trigger>
            <Select.Content align="start" width="trigger">
              {draft.workflows.map((workflow) => (
                <Select.Item key={workflow.id} value={workflow.id}>
                  {workflow.name} ({workflow.steps.length} adım)
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
          <Button variant="secondary" size="sm" onClick={() => void edit(null)}>
            Yeni
          </Button>
          {selected ? (
            <Button variant="secondary" size="sm" onClick={() => void edit(selected.id)}>
              Düzenle
            </Button>
          ) : null}
        </div>
        {!draft.loading && draft.workflows.length === 0 ? (
          <p className="text-xs text-foreground-muted">
            Henüz iş akışı yok. "Yeni" ile bir tane oluşturun ya da JSON içe aktarın.
          </p>
        ) : null}
        {selected?.description ? (
          <p className="text-xs text-foreground-muted">{selected.description}</p>
        ) : null}
      </Field.Root>
      <Field.Root>
        <Field.Label>Giriş metni ({'{{input}}'})</Field.Label>
        <Textarea
          rows={4}
          maxLength={WORKFLOW_MAX_INPUT_CHARS}
          value={draft.input}
          placeholder="İş akışındaki istemlerde {{input}} olarak kullanılır."
          onChange={(event) => draft.setInput(event.target.value)}
        />
      </Field.Root>
      <Field.Root>
        <Field.Label>Aynı anda çalışacak adım sayısı</Field.Label>
        <Select.Root
          value={String(draft.maxConcurrency)}
          onValueChange={(value) => draft.setMaxConcurrency(Number(value))}
        >
          <Select.Trigger appearance="input" className="w-full">
            <Select.Value>
              {draft.maxConcurrency === 1 ? '1 (sırayla, önerilen)' : String(draft.maxConcurrency)}
            </Select.Value>
          </Select.Trigger>
          <Select.Content align="start" width="trigger">
            {Array.from({ length: WORKFLOW_MAX_CONCURRENCY }, (_, index) => index + 1).map(
              (count) => (
                <Select.Item key={count} value={String(count)}>
                  {count === 1 ? '1 (sırayla, önerilen)' : String(count)}
                </Select.Item>
              )
            )}
          </Select.Content>
        </Select.Root>
        {draft.maxConcurrency > 1 ? (
          <p className="text-xs text-foreground-warning">
            Paralel adımlar aynı worktree'de çalışır; ajanlar birbirinin dosyalarını ezebilir.
            Yalnızca farklı dosyalara dokunan adımlar için kullanın.
          </p>
        ) : null}
      </Field.Root>
      <Field.Root>
        <div className="flex items-center gap-2">
          <Switch checked={draft.autoApprove} onCheckedChange={draft.setAutoApprove} />
          <Field.Label>Ajan izinlerini otomatik onayla</Field.Label>
        </div>
        <p className="text-xs text-foreground-muted">
          Kapalıyken izin isteyen adım "İzin bekliyor" görünür; işçinin sohbetinde onaylarsınız.
        </p>
      </Field.Root>
    </>
  );
}
