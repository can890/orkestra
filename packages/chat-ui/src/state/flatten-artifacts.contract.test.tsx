import { SEGMENTERS, UNIT_REGISTRY } from '@components/engine/unit-registry';
import type { RenderUnit, SegmentCtx } from '@core/units';
import { describe, expect, it } from 'vitest';
import type { ChatItem, ChatMessage, ToolNode, TranscriptTurn } from '@/model';
import { flattenTier, type ItemNode } from './flatten';

// Aynı turda hem araç çıktısında hem asistan yanıtında geçen dosya tek kart olarak görünmeli.

const segCtx: SegmentCtx = {
  caches: {} as SegmentCtx['caches'],
  expanded: () => false,
  active: false,
  plan: () => null,
  pendingToolCallIds: () => new Set<string>(),
  artifactVisible: () => true,
  terminalOutput: () => null,
};

function execute(id: string, outputText: string): ToolNode {
  return {
    kind: 'execute-tool-call',
    id,
    seq: 0,
    toolCallId: `call-${id}`,
    title: 'render',
    command: 'render',
    status: 'done',
    outputText,
  } satisfies Extract<ToolNode, { kind: 'execute-tool-call' }>;
}

function assistant(id: string, text: string): ChatMessage {
  return { kind: 'message', id, seq: 0, role: 'assistant', text };
}

function user(id: string, text = 'make it'): ChatMessage {
  return { kind: 'message', id, seq: 0, role: 'user', text };
}

function turn(id: string, ...items: ChatItem[]): TranscriptTurn {
  return { id, seq: 0, initiator: 'user', items: items as TranscriptTurn['items'] };
}

type ArtifactPayload = { itemId: string; items: { uri: string }[] };

function artifactCards(units: RenderUnit[]) {
  return units
    .filter((u) => u.kind === 'artifact')
    .map((u) => ({
      itemId: u.itemId,
      uris: (u.data as ArtifactPayload).items.map((a) => a.uri),
    }));
}

function flatten(turns: TranscriptTurn[], active = false) {
  return flattenTier(turns, { ...segCtx, active }, SEGMENTERS, UNIT_REGISTRY);
}

describe('flatten — output files are shown once per turn', () => {
  it('keeps only the assistant-message card when a tool printed the same file', () => {
    const units = flatten([
      turn(
        't1',
        user('u1'),
        execute('x1', 'wrote /work/out/clip.mp4\n'),
        assistant('a1', 'Done: `/work/out/clip.mp4`')
      ),
    ]);

    expect(artifactCards(units)).toEqual([{ itemId: 'a1', uris: ['/work/out/clip.mp4'] }]);
  });

  it('applies the same rule to the streaming (active) turn', () => {
    const units = flatten(
      [
        turn(
          't1',
          user('u1'),
          execute('x1', 'saved /work/a.png'),
          assistant('a1', 'Here it is: /work/a.png')
        ),
      ],
      true
    );

    expect(artifactCards(units)).toEqual([{ itemId: 'a1', uris: ['/work/a.png'] }]);
  });

  it('keeps the other files of a tool card and drops only the duplicate', () => {
    const units = flatten([
      turn(
        't1',
        user('u1'),
        execute('x1', 'saved /work/a.png\nsaved /work/b.png'),
        assistant('a1', 'The main one is /work/a.png')
      ),
    ]);

    expect(artifactCards(units)).toEqual([
      { itemId: 'x1', uris: ['/work/b.png'] },
      { itemId: 'a1', uris: ['/work/a.png'] },
    ]);
  });

  it('treats a file:// link and the plain path as the same file', () => {
    const units = flatten([
      turn(
        't1',
        user('u1'),
        execute('x1', 'saved /work/a_b.png'),
        assistant('a1', '![preview](file:///work/a_b.png)')
      ),
    ]);

    expect(artifactCards(units)).toEqual([{ itemId: 'a1', uris: ['file:///work/a_b.png'] }]);
  });

  it('shows a file once when two tool calls of the turn print it and no reply mentions it', () => {
    const units = flatten([
      turn(
        't1',
        user('u1'),
        execute('x1', 'saved /work/a.png'),
        execute('x2', 'checked /work/a.png'),
        assistant('a1', 'All done.')
      ),
    ]);

    expect(artifactCards(units)).toEqual([{ itemId: 'x1', uris: ['/work/a.png'] }]);
  });

  it('lets a later turn show the same file again', () => {
    const units = flatten([
      turn('t1', user('u1'), assistant('a1', 'Made /work/a.png')),
      turn('t2', user('u2', 'again?'), assistant('a2', 'Still at /work/a.png')),
    ]);

    expect(artifactCards(units)).toEqual([
      { itemId: 'a1', uris: ['/work/a.png'] },
      { itemId: 'a2', uris: ['/work/a.png'] },
    ]);
  });

  it('resolves seams against the remaining units when a duplicate card is dropped', () => {
    const units = flatten([
      turn(
        't1',
        user('u1'),
        execute('x1', 'saved /work/a.png'),
        assistant('a1', 'Done: /work/a.png')
      ),
    ]);

    expect(units.map((u) => u.kind)).toEqual(['message', 'execute', 'message', 'artifact']);
    const reply = units[2];
    const withoutDuplicate = flatten([
      turn('t1', user('u1'), execute('x1', 'no files'), assistant('a1', 'Done: /work/a.png')),
    ])[2];
    expect(reply.gapBefore).toBe(withoutDuplicate.gapBefore);
  });
});

it('keeps Codex messages and artifacts visible around compact activity, including failed tools', () => {
  const failed = { ...execute('x1', 'wrote /work/log.png'), status: 'error' as const };
  const active = { ...execute('x2', ''), status: 'running' as const };
  const codexTurn = turn(
    't1',
    assistant('progress', 'Checking the logs.'),
    { kind: 'thinking', id: 'thought', status: 'done', text: 'Inspect the error', startedAt: 1 },
    failed,
    active,
    assistant('answer', 'The run is still active.')
  );
  const units = flattenTier(
    [codexTurn],
    {
      ...segCtx,
      active: true,
      compactActivity: true,
      pendingToolCallIds: () => new Set(['call-x2']),
    },
    SEGMENTERS,
    UNIT_REGISTRY
  );

  expect(units.map((u) => u.kind)).toEqual(['message', 'tool-group', 'artifact', 'message']);
  const activity = units[1]!.data as ItemNode;
  expect(activity.children.map(({ item }) => item.id)).toEqual(['thought', 'x1', 'x2']);
  expect(activity.headerState).toMatchObject({ error: false, awaitingPermission: true });
  expect(activity.children[1]?.headerState.error).toBe(true);
  expect(artifactCards(units)).toEqual([{ itemId: 'x1', uris: ['/work/log.png'] }]);
  expect(flatten([codexTurn]).map((u) => u.kind)).toEqual([
    'message',
    'thinking',
    'execute',
    'artifact',
    'execute',
    'message',
  ]);
});

it('groups Antigravity thinking and tools into compact activity while keeping live progress messages visible', () => {
  const antigravityTurn = {
    ...turn(
      't-agy',
      assistant('intro', 'Tamam kanka, hemen dosyaları kontrol ediyorum.'),
      { kind: 'thinking', id: 'th1', status: 'done', text: 'Plan inspection', startedAt: 1 },
      execute('x1', 'ok'),
      assistant('mid', 'Sebebini buldum, şimdi düzenliyorum.'),
      execute('x2', 'updated'),
      assistant('done', 'Hepsini tamamladım.')
    ),
    providerId: 'antigravity',
  };

  const units = flatten([antigravityTurn]);
  expect(units.map((u) => u.kind)).toEqual([
    'message',
    'tool-group',
    'message',
    'tool-group',
    'message',
  ]);
  const firstActivity = units[1]!.data as ItemNode;
  expect(firstActivity.children.map(({ item }) => item.id)).toEqual(['th1', 'x1']);
});
