import {
  Button,
  Checkbox,
  Dialog,
  Field,
  Input,
  Select,
  Textarea,
} from '@orkestra/ui/react/primitives';
import { useEffect, useMemo, useState } from 'react';
import { useWorkflowAgents } from '@core/features/orchestra/api/browser/use-workflow-agents';
import { getWorkflowsClient } from '@core/features/orchestra/api/browser/workflow-client';
import {
  WORKFLOW_MAX_PROMPT_CHARS,
  WORKFLOW_MAX_STEPS,
  type WorkflowDefinition,
  type WorkflowStep,
} from '@core/features/orchestra/api/workflow';
import { validateWorkflowDefinition } from '@core/features/orchestra/api/workflow-logic';
import { useModalController } from '@core/manifests/browser/modal-api';
import { defineModal } from '@core/primitives/modals/react';
import { useCloseGuard } from '@core/primitives/modals/react/use-close-guard';

const DEFAULT_MODEL = '__default__';

function newWorkflow(): WorkflowDefinition {
  return {
    id: `wf-${crypto.randomUUID().slice(0, 8)}`,
    name: '',
    description: '',
    steps: [],
  };
}

function nextStepId(steps: readonly WorkflowStep[]): string {
  const used = new Set(steps.map((step) => step.id));
  let index = steps.length + 1;
  while (used.has(`adim-${index}`)) index += 1;
  return `adim-${index}`;
}

/** Bir adımın kimliği değişince diğer adımların bağımlılıkları ve şablon başvuruları da güncellenir. */
function renameStep(workflow: WorkflowDefinition, from: string, to: string): WorkflowDefinition {
  const pattern = new RegExp(
    `\\{\\{\\s*steps\\.${from.replace(/[^A-Za-z0-9_-]/g, '')}\\.report\\s*\\}\\}`,
    'g'
  );
  return {
    ...workflow,
    steps: workflow.steps.map((step) => ({
      ...step,
      id: step.id === from ? to : step.id,
      dependsOn: step.dependsOn.map((dep) => (dep === from ? to : dep)),
      prompt: step.prompt.replace(pattern, `{{steps.${to}.report}}`),
    })),
  };
}

export function WorkflowEditorModal({
  connectionId,
  workflowId,
}: {
  connectionId?: string;
  workflowId: string | null;
}) {
  const { complete, dismiss } = useModalController('workflowEditorModal');
  const agents = useWorkflowAgents(connectionId);
  const [workflows, setWorkflows] = useState<WorkflowDefinition[] | null>(null);
  const [draft, setDraft] = useState<WorkflowDefinition>(newWorkflow);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [jsonText, setJsonText] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  useCloseGuard(saving);

  useEffect(() => {
    void (async () => {
      const list = await (await getWorkflowsClient()).list();
      setWorkflows(list);
      const existing = workflowId ? list.find((workflow) => workflow.id === workflowId) : null;
      if (existing) setDraft(structuredClone(existing));
    })();
  }, [workflowId]);

  const validation = useMemo(() => validateWorkflowDefinition(draft), [draft]);
  const errors = validation.ok ? serverErrors : validation.errors;
  const isExisting = workflows?.some((workflow) => workflow.id === draft.id) ?? false;

  const updateStep = (id: string, patch: Partial<WorkflowStep>) =>
    setDraft((current) => ({
      ...current,
      steps: current.steps.map((step) => (step.id === id ? { ...step, ...patch } : step)),
    }));

  const addStep = () =>
    setDraft((current) => ({
      ...current,
      steps: [
        ...current.steps,
        {
          id: nextStepId(current.steps),
          agent: agents[0]?.providerId ?? '',
          prompt: '',
          dependsOn: [],
        },
      ],
    }));

  const removeStep = (id: string) =>
    setDraft((current) => ({
      ...current,
      steps: current.steps
        .filter((step) => step.id !== id)
        .map((step) => ({ ...step, dependsOn: step.dependsOn.filter((dep) => dep !== id) })),
    }));

  const save = async () => {
    setSaving(true);
    setServerErrors([]);
    try {
      const result = await (await getWorkflowsClient()).save({ workflow: draft });
      if (result.ok) complete({ workflowId: result.workflow.id });
      else setServerErrors(result.errors);
    } catch (error) {
      setServerErrors([error instanceof Error ? error.message : 'Kaydedilemedi']);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    try {
      await (await getWorkflowsClient()).delete({ id: draft.id });
      complete({ workflowId: null });
    } finally {
      setSaving(false);
    }
  };

  const importJson = () => {
    if (jsonText === null) return;
    try {
      const parsed: unknown = JSON.parse(jsonText);
      const record = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<
        string,
        unknown
      >;
      // İçe aktarılan tanım kimliğini korur (aynı kimlik varsa üzerine yazar); yoksa yeni kimlik verilir.
      const candidate = { ...record, id: typeof record.id === 'string' ? record.id : draft.id };
      const result = validateWorkflowDefinition(candidate);
      if (!result.ok) {
        setJsonError(result.errors.join('\n'));
        return;
      }
      setDraft(result.workflow);
      setJsonText(null);
      setJsonError(null);
    } catch {
      setJsonError('Geçerli bir JSON değil.');
    }
  };

  return (
    <>
      <Dialog.Header>
        <Dialog.Title>{isExisting ? 'İş akışını düzenle' : 'Yeni iş akışı'}</Dialog.Title>
      </Dialog.Header>
      <Dialog.Body>
        <Field.Group>
          <Field.Root>
            <Field.Label>Ad</Field.Label>
            <Input
              value={draft.name}
              onChange={(event) => setDraft((c) => ({ ...c, name: event.target.value }))}
            />
          </Field.Root>
          <Field.Root>
            <Field.Label>Açıklama (isteğe bağlı)</Field.Label>
            <Input
              value={draft.description ?? ''}
              onChange={(event) => setDraft((c) => ({ ...c, description: event.target.value }))}
            />
          </Field.Root>
          <p className="text-xs text-foreground-muted">
            İstemlerde {'{{input}}'} çalıştırırken verdiğiniz metni, {'{{steps.<adım>.report}}'} ise
            bağlı olduğunuz bir adımın raporunu ekler. Rapor "veri, talimat değil" çerçevesiyle
            eklenir ve içindeki {'{{...}}'} ifadeleri yorumlanmaz.
          </p>
          {draft.steps.map((step, index) => {
            const others = draft.steps.filter((other) => other.id !== step.id);
            const agent = agents.find((candidate) => candidate.providerId === step.agent);
            return (
              <div key={index} className="space-y-2 rounded-md border border-border p-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-foreground-muted">Adım {index + 1}</span>
                  <Input
                    aria-label="Adım kimliği"
                    className="w-40"
                    value={step.id}
                    onChange={(event) =>
                      setDraft((current) => renameStep(current, step.id, event.target.value))
                    }
                  />
                  <div className="ml-auto" />
                  <Button variant="ghost" size="sm" onClick={() => removeStep(step.id)}>
                    Sil
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Field.Root>
                    <Field.Label>Ajan</Field.Label>
                    <Select.Root
                      value={step.agent}
                      onValueChange={(value) =>
                        updateStep(step.id, { agent: value ?? '', model: null })
                      }
                    >
                      <Select.Trigger appearance="input" className="w-full">
                        <Select.Value placeholder="Ajan seçin">
                          {agent?.name ?? (step.agent || undefined)}
                        </Select.Value>
                      </Select.Trigger>
                      <Select.Content align="start" width="trigger">
                        {agents.map((candidate) => (
                          <Select.Item key={candidate.providerId} value={candidate.providerId}>
                            {candidate.name}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Root>
                  </Field.Root>
                  <Field.Root>
                    <Field.Label>Model</Field.Label>
                    <Select.Root
                      value={step.model ?? DEFAULT_MODEL}
                      onValueChange={(value) =>
                        updateStep(step.id, { model: value === DEFAULT_MODEL ? null : value })
                      }
                    >
                      <Select.Trigger appearance="input" className="w-full">
                        <Select.Value>
                          {step.model
                            ? (agent?.models.find((model) => model.id === step.model)?.name ??
                              step.model)
                            : 'Ajanın varsayılan modeli'}
                        </Select.Value>
                      </Select.Trigger>
                      <Select.Content align="start" width="trigger">
                        <Select.Item value={DEFAULT_MODEL}>Ajanın varsayılan modeli</Select.Item>
                        {(agent?.models ?? []).map((model) => (
                          <Select.Item key={model.id} value={model.id}>
                            {model.name}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Root>
                  </Field.Root>
                </div>
                <Field.Root>
                  <Field.Label>İstem</Field.Label>
                  <Textarea
                    rows={4}
                    maxLength={WORKFLOW_MAX_PROMPT_CHARS}
                    value={step.prompt}
                    onChange={(event) => updateStep(step.id, { prompt: event.target.value })}
                  />
                </Field.Root>
                {others.length > 0 ? (
                  <Field.Root>
                    <Field.Label>Şunlar bitince başlar</Field.Label>
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      {others.map((other) => (
                        <label key={other.id} className="flex items-center gap-1.5 text-sm">
                          <Checkbox
                            checked={step.dependsOn.includes(other.id)}
                            onCheckedChange={(checked) =>
                              updateStep(step.id, {
                                dependsOn: checked
                                  ? [...step.dependsOn, other.id]
                                  : step.dependsOn.filter((dep) => dep !== other.id),
                              })
                            }
                          />
                          {other.id}
                        </label>
                      ))}
                    </div>
                  </Field.Root>
                ) : null}
              </div>
            );
          })}
          <div>
            <Button
              variant="secondary"
              size="sm"
              onClick={addStep}
              disabled={draft.steps.length >= WORKFLOW_MAX_STEPS}
            >
              Adım ekle
            </Button>
          </div>
          {errors.length > 0 ? (
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-foreground-destructive">
              {errors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          ) : null}
          {jsonText !== null ? (
            <Field.Root>
              <Field.Label>JSON</Field.Label>
              <Textarea
                rows={10}
                className="font-mono text-xs"
                value={jsonText}
                onChange={(event) => setJsonText(event.target.value)}
              />
              {jsonError ? (
                <p className="text-xs whitespace-pre-line text-foreground-destructive">
                  {jsonError}
                </p>
              ) : null}
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" onClick={importJson}>
                  Taslağa uygula
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setJsonText(null);
                    setJsonError(null);
                  }}
                >
                  Kapat
                </Button>
              </div>
            </Field.Root>
          ) : null}
        </Field.Group>
      </Dialog.Body>
      <Dialog.Footer className="gap-2 sm:gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setJsonError(null);
            setJsonText(JSON.stringify(draft, null, 2));
          }}
        >
          JSON içe/dışa aktar
        </Button>
        {isExisting ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            disabled={saving}
            onClick={() => void remove()}
          >
            Sil
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={dismiss}>
          Vazgeç
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={saving || !validation.ok}
          onClick={() => void save()}
        >
          {saving ? 'Kaydediliyor...' : 'Kaydet'}
        </Button>
      </Dialog.Footer>
    </>
  );
}

export const workflowEditorModal = defineModal<{ workflowId: string | null }>()({
  id: 'workflowEditorModal',
  component: WorkflowEditorModal,
  size: 'lg',
});
