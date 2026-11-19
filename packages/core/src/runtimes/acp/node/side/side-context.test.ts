import { describe, expect, it } from 'vitest';
import type { TranscriptTurn } from '#runtimes/acp/api';
import { buildSideContext, buildSidePrompt } from './side-context';

const message = (id: string, role: 'user' | 'assistant', text: string, side = false) => ({
  kind: 'message' as const,
  id,
  seq: Number(id.replace(/\D/g, '')) || 0,
  role,
  text,
  ...(side ? { side: { question: 'q', status: 'done' as const } } : {}),
});

const tool = (id: string, title: string, status: 'running' | 'done' | 'error', seq: number) =>
  ({
    kind: 'unknown-tool-call',
    id,
    seq,
    toolCallId: id,
    title,
    status,
    toolKind: null,
    name: title,
  }) as unknown as TranscriptTurn['items'][number];

const turn = (id: string, items: TranscriptTurn['items']): TranscriptTurn => ({
  id,
  seq: Number(id.replace(/\D/g, '')),
  initiator: 'user',
  items,
});

describe('buildSideContext', () => {
  it('keeps the last committed turns as text only and the active turn with tool statuses', () => {
    const context = buildSideContext({
      committed: [
        turn('t1', [message('m1', 'user', 'eski'), message('m2', 'assistant', 'eski cevap')]),
        turn('t2', [message('m3', 'user', 'orta'), tool('x', 'gizli araç', 'done', 4)]),
      ],
      active: turn('t3', [
        message('m5', 'user', 'şimdiki iş'),
        message('m6', 'assistant', 'başladım'),
        tool('a', 'npm test', 'running', 7),
        tool('b', 'git diff', 'done', 8),
        tool('c', 'lint', 'error', 9),
        message('m7', 'user', 'yan soru', true),
      ]),
    });
    expect(context).toContain('Kullanıcı: eski');
    expect(context).toContain('Ajan: eski cevap');
    expect(context).not.toContain('gizli araç');
    expect(context).toContain('[araç] npm test — çalışıyor');
    expect(context).toContain('[araç] git diff — bitti');
    expect(context).toContain('[araç] lint — hata');
    expect(context).not.toContain('yan soru');
  });

  it('only includes the requested number of committed turns', () => {
    const committed = [1, 2, 3, 4, 5].map((n) =>
      turn(`t${n}`, [message(`m${n}`, 'user', `soru ${n}`)])
    );
    const context = buildSideContext({ committed, active: null }, { recentTurns: 2 });
    expect(context).toBe('Kullanıcı: soru 4\nKullanıcı: soru 5');
  });

  it('drops the oldest lines first and says so when over budget', () => {
    const committed = [1, 2, 3].map((n) =>
      turn(`t${n}`, [message(`m${n}`, 'user', `${'x'.repeat(40)}${n}`)])
    );
    const context = buildSideContext({ committed, active: null }, { maxChars: 110 });
    expect(context.startsWith('(önceki kısım kısaltıldı)\n')).toBe(true);
    expect(context).toContain('3');
    expect(context).not.toContain(`${'x'.repeat(40)}1`);
    expect(context.length).toBeLessThanOrEqual(110 + '(önceki kısım kısaltıldı)\n'.length);
  });

  it('keeps the tail of a single oversized line', () => {
    const context = buildSideContext(
      { committed: [], active: turn('t1', [message('m1', 'assistant', `${'a'.repeat(200)}SON`)]) },
      { maxChars: 50 }
    );
    expect(context).toContain('SON');
    expect(context.length).toBeLessThan(90);
  });

  it('builds a Turkish prompt with the instruction, context and question', () => {
    const prompt = buildSidePrompt('Ajan: merhaba', 'son durum ne?');
    expect(prompt).toContain('Hiçbir araç kullanma');
    expect(prompt).toContain('Ajan: merhaba');
    expect(prompt.endsWith('Kullanıcının sorusu: son durum ne?')).toBe(true);
    expect(buildSidePrompt('', 'x')).toContain('(henüz bağlam yok)');
  });
});
