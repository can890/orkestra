import { describe, expect, it } from 'vitest';
import {
  buildElicitationContent,
  initialElicitationDraft,
  parseElicitationFields,
  type ElicitationRequestView,
} from './elicitation-schema';

describe('elicitation-schema', () => {
  it('Claude AskUserQuestion _meta._askUserQuestionCustomAnswer ve (Recommended) rozetini ayrıştırır', () => {
    const request: ElicitationRequestView = {
      requestId: 'req-claude',
      mode: 'form',
      message: 'Mimari yaklaşımı seçin',
      requestedSchema: {
        type: 'object',
        required: ['q1'],
        properties: {
          q1: {
            type: 'string',
            title: 'Önbellek',
            description: 'Hangi önbellek katmanını kullanalım?',
            oneOf: [
              { const: 'redis', title: '(Recommended) Redis — Düşük gecikme ve paylaşım' },
              { const: 'memory', title: 'Bellek içi (Önerilen)' },
            ],
          },
          q1_custom_note: {
            type: 'string',
            description: 'Özel cevap',
            _meta: {
              _askUserQuestionCustomAnswer: {
                isCustomAnswer: true,
                questionId: 'q1',
              },
            },
          },
        },
      },
    };

    const fields = parseElicitationFields(request);
    expect(fields).toHaveLength(1);
    const field = fields[0]!;
    expect(field.kind).toBe('single-select');
    if (field.kind !== 'single-select') throw new Error('expected single-select');
    expect(field.header).toBe('Önbellek');
    expect(field.prompt).toBe('Hangi önbellek katmanını kullanalım?');
    expect(field.customFieldKey).toBe('q1_custom_note');
    expect(field.options).toEqual([
      {
        value: 'redis',
        label: 'Redis',
        description: 'Düşük gecikme ve paylaşım',
        recommended: true,
      },
      {
        value: 'memory',
        label: 'Bellek içi',
        recommended: true,
      },
    ]);

    const draft = initialElicitationDraft(fields);
    draft.values['q1'] = 'redis';
    expect(buildElicitationContent(fields, draft)).toEqual({ q1: 'redis' });

    // Özel metin girilirse companion alanı gönderilir.
    draft.customText['q1_custom_note'] = 'SQLite WAL kullanalım';
    expect(buildElicitationContent(fields, draft)).toEqual({
      q1_custom_note: 'SQLite WAL kullanalım',
    });
  });

  it('Antigravity q0_other ve Codex _write_in / _custom companion alanlarını ebeveyn soruya bağlar', () => {
    const request: ElicitationRequestView = {
      requestId: 'req-multi',
      mode: 'form',
      message: 'Ayarları seç',
      requestedSchema: {
        type: 'object',
        properties: {
          q0: {
            type: 'array',
            description: 'Hangi testler koşsun?',
            items: {
              enum: ['unit', 'e2e'],
              enumNames: ['Birim testleri', 'Uçtan uca (Recommended)'],
            },
          },
          q0_other: { type: 'string', description: 'Ek not' },
          strategy: {
            type: 'string',
            description: 'Strateji',
            enum: ['fast', 'safe'],
          },
          strategy_write_in: { type: 'string' },
        },
      },
    };

    const fields = parseElicitationFields(request);
    expect(fields.map((f) => [f.key, f.kind])).toEqual([
      ['q0', 'multi-select'],
      ['strategy', 'single-select'],
    ]);
    const q0 = fields[0]!;
    const strategy = fields[1]!;
    if (q0.kind !== 'multi-select' || strategy.kind !== 'single-select') {
      throw new Error('unexpected kinds');
    }
    expect(q0.customFieldKey).toBe('q0_other');
    expect(q0.options[1]).toEqual({ value: 'e2e', label: 'Uçtan uca', recommended: true });
    expect(strategy.customFieldKey).toBe('strategy_write_in');

    const draft = initialElicitationDraft(fields);
    draft.values['q0'] = ['unit'];
    draft.customText['q0_other'] = 'smoke test de ekle';
    draft.values['strategy'] = 'safe';
    expect(buildElicitationContent(fields, draft)).toEqual({
      q0: ['unit'],
      q0_other: 'smoke test de ekle',
      strategy: 'safe',
    });
  });

  it('boolean, integer, number ve text alanlarını varsayılan değerleriyle dönüştürür', () => {
    const request: ElicitationRequestView = {
      requestId: 'req-types',
      mode: 'form',
      message: 'Parametreler',
      requestedSchema: {
        type: 'object',
        required: ['dryRun'],
        properties: {
          dryRun: { type: 'boolean', title: 'Kuru çalışma', default: true },
          retries: { type: 'integer', description: 'Deneme sayısı', default: 3 },
          ratio: { type: 'number', description: 'Oran' },
          tag: { type: 'string', description: 'Etiket', default: 'v1' },
        },
      },
    };

    const fields = parseElicitationFields(request);
    const draft = initialElicitationDraft(fields);
    draft.values['ratio'] = '0.75';
    draft.values['tag'] = '  beta  ';

    expect(buildElicitationContent(fields, draft)).toEqual({
      dryRun: true,
      retries: 3,
      ratio: 0.75,
      tag: 'beta',
    });
  });
});
