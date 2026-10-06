import { describe, expect, it } from 'vitest';
import {
  isClipboardPasteChord,
  isSelectAllChord,
  keyEventSequence,
  parseKeyCombo,
  selectAllChord,
} from './keyboard';

describe('parseKeyCombo', () => {
  it('parses modifiers and maps DOM key names to Electron accelerator names', () => {
    expect(parseKeyCombo('Control+Shift+K', 'linux')).toEqual({
      keyCode: 'k',
      text: 'k',
      modifiers: ['control', 'shift'],
    });
    expect(parseKeyCombo('ArrowDown', 'linux')).toEqual({
      keyCode: 'Down',
      text: null,
      modifiers: [],
    });
    expect(parseKeyCombo('PageDown', 'linux').keyCode).toBe('PageDown');
    expect(parseKeyCombo('Escape', 'linux').keyCode).toBe('Escape');
    expect(parseKeyCombo('F5', 'linux').keyCode).toBe('F5');
    expect(parseKeyCombo('KeyA', 'linux')).toMatchObject({ keyCode: 'a', text: 'a' });
    expect(parseKeyCombo('Digit7', 'linux')).toMatchObject({ keyCode: '7', text: '7' });
  });

  it('gives Enter a carriage-return char and Space a space char', () => {
    expect(parseKeyCombo('Enter', 'darwin')).toEqual({
      keyCode: 'Enter',
      text: '\r',
      modifiers: [],
    });
    expect(parseKeyCombo('Space', 'darwin')).toEqual({
      keyCode: 'Space',
      text: ' ',
      modifiers: [],
    });
    expect(parseKeyCombo(' ', 'darwin').keyCode).toBe('Space');
  });

  it('adds shift for a bare uppercase letter but not when a command modifier is held', () => {
    expect(parseKeyCombo('A', 'linux')).toEqual({ keyCode: 'A', text: 'A', modifiers: ['shift'] });
    expect(parseKeyCombo('Meta+A', 'darwin')).toEqual({
      keyCode: 'a',
      text: 'a',
      modifiers: ['meta'],
    });
    expect(parseKeyCombo('Shift+h', 'linux')).toMatchObject({ text: 'H', modifiers: ['shift'] });
  });

  it('resolves ControlOrMeta per platform and handles the plus key', () => {
    expect(parseKeyCombo('ControlOrMeta+L', 'darwin').modifiers).toEqual(['meta']);
    expect(parseKeyCombo('ControlOrMeta+L', 'win32').modifiers).toEqual(['control']);
    expect(parseKeyCombo('Control++', 'linux')).toMatchObject({
      keyCode: '+',
      modifiers: ['control'],
    });
    expect(parseKeyCombo('+', 'linux').keyCode).toBe('+');
  });

  it('supports modifier-only presses', () => {
    expect(parseKeyCombo('Shift', 'linux')).toEqual({
      keyCode: null,
      text: null,
      modifiers: ['shift'],
    });
  });

  it('rejects unknown keys and modifiers with a helpful message', () => {
    expect(() => parseKeyCombo('Hyper+Q', 'linux')).toThrow(/Unknown modifier "Hyper"/);
    expect(() => parseKeyCombo('Foo', 'linux')).toThrow(/Unknown key "Foo".*Enter, Tab/);
    expect(() => parseKeyCombo('', 'linux')).toThrow(/Missing key/);
  });
});

describe('keyEventSequence', () => {
  it('presses modifiers, the key and releases in reverse order without char for command chords', () => {
    expect(keyEventSequence(parseKeyCombo('Control+A', 'linux'))).toEqual([
      { type: 'keyDown', keyCode: 'Control', modifiers: ['control'] },
      { type: 'keyDown', keyCode: 'a', modifiers: ['control'] },
      { type: 'keyUp', keyCode: 'a', modifiers: ['control'] },
      { type: 'keyUp', keyCode: 'Control', modifiers: [] },
    ]);
  });

  it('sends a char event for printable keys and Enter', () => {
    expect(keyEventSequence(parseKeyCombo('a', 'linux'))).toEqual([
      { type: 'keyDown', keyCode: 'a', modifiers: [] },
      { type: 'char', keyCode: 'a', modifiers: [] },
      { type: 'keyUp', keyCode: 'a', modifiers: [] },
    ]);
    const enter = keyEventSequence(parseKeyCombo('Enter', 'linux'));
    expect(enter.map((event) => event.type)).toEqual(['keyDown', 'char', 'keyUp']);
    expect(enter[1]?.keyCode).toBe('\r');
    expect(keyEventSequence(parseKeyCombo('Tab', 'linux')).map((event) => event.type)).toEqual([
      'keyDown',
      'keyUp',
    ]);
  });
});

describe('chord helpers', () => {
  it('detects platform select-all and paste chords', () => {
    expect(selectAllChord('darwin').modifiers).toEqual(['meta']);
    expect(selectAllChord('linux').modifiers).toEqual(['control']);
    expect(isSelectAllChord(parseKeyCombo('Meta+A', 'darwin'), 'darwin')).toBe(true);
    expect(isSelectAllChord(parseKeyCombo('Control+A', 'darwin'), 'darwin')).toBe(false);
    expect(isClipboardPasteChord(parseKeyCombo('Control+V', 'linux'))).toBe(true);
    expect(isClipboardPasteChord(parseKeyCombo('Meta+v', 'darwin'))).toBe(true);
    expect(isClipboardPasteChord(parseKeyCombo('Shift+Insert', 'win32'))).toBe(true);
    expect(isClipboardPasteChord(parseKeyCombo('v', 'linux'))).toBe(false);
  });
});
