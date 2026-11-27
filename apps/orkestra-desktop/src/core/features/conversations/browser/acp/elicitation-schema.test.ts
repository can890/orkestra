import type { AcpElicitationRequest } from '@orkestra/core/runtimes/acp/api/client';
import { describe, expect, it } from 'vitest';
import {
  buildElicitationContent,
  initialElicitationDraft,
  parseElicitationFields,
} from './elicitation-schema';

describe('elicitation-schema', () => {
  it('parses Claude AskUserQuestion single-select and multi-select with custom answer companions', () => {
    const request: AcpElicitationRequest = {
      requestId: 'req-1',
      mode: 'form',
      message: 'Please answer these questions',
      requestedSchema: {
        type: 'object',
        properties: {
          question_0: {
            type: 'string',
            title: 'Approach',
            description: 'Which architecture should we use?',
            oneOf: [
              {
                const: 'Option A (Recommended)',
                title: 'Option A (Recommended) - Fast and clean',
              },
              {
                const: 'Option B',
                title: 'Option B - Fully custom',
              },
            ],
          },
          question_0_custom: {
            type: 'string',
            title: 'Other answer',
            _meta: {
              _askUserQuestionCustomAnswer: {
                questionId: 'question_0',
                isCustomAnswer: true,
              },
            },
          },
          question_1: {
            type: 'array',
            title: 'Targets',
            description: 'Select platforms',
            items: {
              anyOf: [
                { const: 'macOS', title: 'macOS' },
                { const: 'Linux', title: 'Linux - Remote SSH host' },
              ],
            },
          },
          question_1_custom: {
            type: 'string',
            title: 'Custom platform',
            _meta: {
              _askUserQuestionCustomAnswer: {
                questionId: 'question_1',
                isCustomAnswer: true,
              },
            },
          },
        },
        required: ['question_0', 'question_1'],
      },
    };

    const fields = parseElicitationFields(request);
    expect(fields).toHaveLength(2);

    const f0 = fields[0]!;
    expect(f0.kind).toBe('single-select');
    if (f0.kind === 'single-select') {
      expect(f0.key).toBe('question_0');
      expect(f0.header).toBe('Approach');
      expect(f0.prompt).toBe('Which architecture should we use?');
      expect(f0.customFieldKey).toBe('question_0_custom');
      expect(f0.options[0]).toEqual({
        value: 'Option A (Recommended)',
        label: 'Option A',
        description: 'Fast and clean',
        recommended: true,
      });
      expect(f0.options[1]).toEqual({
        value: 'Option B',
        label: 'Option B',
        description: 'Fully custom',
      });
    }

    const f1 = fields[1]!;
    expect(f1.kind).toBe('multi-select');
    if (f1.kind === 'multi-select') {
      expect(f1.key).toBe('question_1');
      expect(f1.customFieldKey).toBe('question_1_custom');
      expect(f1.options).toEqual([
        { value: 'macOS', label: 'macOS' },
        { value: 'Linux', label: 'Linux', description: 'Remote SSH host' },
      ]);
    }

    const draft = initialElicitationDraft(fields);
    draft.values['question_0'] = 'Option A (Recommended)';
    draft.values['question_1'] = ['macOS'];
    draft.customText['question_1_custom'] = 'FreeBSD';

    expect(buildElicitationContent(fields, draft)).toEqual({
      question_0: 'Option A (Recommended)',
      question_1: ['macOS'],
      question_1_custom: 'FreeBSD',
    });
  });

  it('prefers custom text over selected option on single-select when custom text is entered', () => {
    const request: AcpElicitationRequest = {
      requestId: 'req-2',
      mode: 'form',
      message: 'Choose one',
      requestedSchema: {
        type: 'object',
        properties: {
          question_0: {
            type: 'string',
            title: 'Style',
            oneOf: [{ const: 'Minimal', title: 'Minimal' }],
          },
          question_0_custom: {
            type: 'string',
            _meta: {
              _askUserQuestionCustomAnswer: { questionId: 'question_0', isCustomAnswer: true },
            },
          },
        },
      },
    };

    const fields = parseElicitationFields(request);
    const draft = initialElicitationDraft(fields);
    draft.values['question_0'] = 'Minimal';
    draft.customText['question_0_custom'] = 'Brutalist';

    expect(buildElicitationContent(fields, draft)).toEqual({
      question_0_custom: 'Brutalist',
    });
  });

  it('parses standard JSON Schema enum, boolean, and number fields', () => {
    const request: AcpElicitationRequest = {
      requestId: 'req-3',
      mode: 'form',
      message: 'Configure run',
      requestedSchema: {
        type: 'object',
        properties: {
          env: {
            type: 'string',
            title: 'Environment',
            enum: ['staging', 'prod'],
            enumNames: ['Staging (Önerilen)', 'Production'],
            default: 'staging',
          },
          dryRun: {
            type: 'boolean',
            title: 'Dry run',
            default: true,
          },
          retries: {
            type: 'integer',
            title: 'Retries',
            default: 3,
          },
        },
        required: ['env'],
      },
    };

    const fields = parseElicitationFields(request);
    expect(fields).toHaveLength(3);
    const draft = initialElicitationDraft(fields);
    expect(draft.values).toEqual({
      env: 'staging',
      dryRun: true,
      retries: '3',
    });

    expect(buildElicitationContent(fields, draft)).toEqual({
      env: 'staging',
      dryRun: true,
      retries: 3,
    });
  });
});
