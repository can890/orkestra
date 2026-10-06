import { describe, expect, it } from 'vitest';
import {
  describeRecordedStep,
  MAX_RECORDED_STEPS,
  parseRecordedStep,
  parseRecordedSteps,
} from './recorded-steps';

describe('parseRecordedSteps', () => {
  it('accepts arrays, JSON text and { steps } objects and strips unknown fields', () => {
    const steps = [
      { action: 'navigate', url: 'http://localhost:3000/' },
      {
        action: 'click',
        target: { selector: ' #save ', text: ' Save ', extra: 1 },
        button: 'left',
        clickCount: 1,
        modifiers: ['shift', 'shift'],
        note: 'ignored',
      },
      { action: 'type', target: { selector: '#q' }, text: '', clear: true },
      { action: 'wait', text: 'Done', ms: 250.4 },
    ];
    const expected = [
      { action: 'navigate', url: 'http://localhost:3000/' },
      { action: 'click', target: { selector: '#save', text: 'Save' }, modifiers: ['shift'] },
      { action: 'type', target: { selector: '#q' }, text: '', clear: true },
      { action: 'wait', text: 'Done', ms: 250 },
    ];
    expect(parseRecordedSteps(steps)).toEqual(expected);
    expect(parseRecordedSteps(JSON.stringify(steps))).toEqual(expected);
    expect(parseRecordedSteps({ steps })).toEqual(expected);
  });

  it('reports the failing step number', () => {
    expect(() => parseRecordedSteps([{ action: 'back' }, { action: 'click' }])).toThrow(
      'Step 2: "target" with a CSS selector is required.'
    );
    expect(() => parseRecordedSteps([{ action: 'fly' }])).toThrow(/Step 1: unknown action "fly"/);
    expect(() => parseRecordedSteps([{ action: 'wait' }])).toThrow(/needs text, textGone or ms/);
    expect(() => parseRecordedSteps('not json')).toThrow(/array of step objects/);
    expect(() => parseRecordedSteps([])).toThrow(/non-empty/);
    expect(() =>
      parseRecordedSteps(Array.from({ length: MAX_RECORDED_STEPS + 1 }, () => ({ action: 'back' })))
    ).toThrow(/at most/);
  });

  it('keeps password steps without a value as secret', () => {
    expect(parseRecordedStep({ action: 'type', text: '', secret: true })).toEqual({
      ok: true,
      step: { action: 'type', text: '', secret: true },
    });
    expect(parseRecordedStep({ action: 'type' })).toEqual({
      ok: false,
      error: '"text" is required.',
    });
  });
});

describe('describeRecordedStep', () => {
  it('summarizes steps on one line', () => {
    expect(
      describeRecordedStep({
        action: 'click',
        target: { selector: '#save', text: 'Save' },
        clickCount: 2,
      })
    ).toBe('double-click #save "Save"');
    expect(
      describeRecordedStep({ action: 'type', target: { selector: '#pw' }, text: '', secret: true })
    ).toBe('type (secret) into #pw');
    expect(describeRecordedStep({ action: 'scroll', direction: 'down', amount: 200 })).toBe(
      'scroll down 200 px'
    );
    expect(describeRecordedStep({ action: 'wait', textGone: 'Loading' })).toBe(
      'wait until "Loading" is gone'
    );
  });
});
