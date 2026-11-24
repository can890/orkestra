import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  chunkText,
  COMPUTER_INPUT_JXA,
  COMPUTER_KEY_NAMES,
  ComputerToolError,
  parseCoordinate,
  parseKey,
  parseTypeText,
} from './computer-input';

const display = { width: 1470, height: 956, scale: 2 };

describe('parseKey', () => {
  it('maps allowed names to key codes and modifier flags', () => {
    expect(parseKey('Return', undefined)).toMatchObject({ keyCode: 36, flags: 0 });
    expect(parseKey('c', ['cmd'])).toMatchObject({ keyCode: 8, flags: 0x100000 });
    expect(parseKey('tab', ['shift', 'option'])).toMatchObject({
      keyCode: 48,
      flags: 0x20000 | 0x80000,
    });
  });

  it('rejects names outside the allow list', () => {
    for (const bad of [
      'rm -rf',
      'a"; do shell script',
      '$(id)',
      'cmd',
      '',
      '__proto__',
      'constructor',
    ]) {
      expect(() => parseKey(bad, ['cmd'])).toThrow(ComputerToolError);
    }
    expect(() => parseKey(42, [])).toThrow(ComputerToolError);
  });

  it('rejects unknown modifiers and bare letters', () => {
    expect(() => parseKey('c', ['meta'])).toThrow(ComputerToolError);
    expect(() => parseKey('c', ['__proto__'])).toThrow(ComputerToolError);
    expect(() => parseKey('c', 'cmd')).toThrow(ComputerToolError);
    expect(() => parseKey('c', [])).toThrow(/modifier/);
  });

  it('lists only names that map to integer codes in range', () => {
    for (const name of COMPUTER_KEY_NAMES) {
      const code = parseKey(name, ['cmd']).keyCode;
      expect(Number.isInteger(code) && code >= 0 && code <= 127).toBe(true);
    }
  });
});

describe('parseCoordinate', () => {
  it('accepts finite numbers inside the screen and rounds them', () => {
    expect(parseCoordinate(10.4, 'x', display)).toBe(10);
    expect(parseCoordinate(955, 'y', display)).toBe(955);
  });

  it('rejects non-finite, non-number and out-of-bounds values', () => {
    for (const bad of [Number.NaN, Infinity, -1, '10', null, undefined, {}, [1]]) {
      expect(() => parseCoordinate(bad, 'x', display)).toThrow(ComputerToolError);
    }
    expect(() => parseCoordinate(1470, 'x', display)).toThrow(/outside/);
    expect(() => parseCoordinate(956, 'y', display)).toThrow(/outside/);
  });
});

describe('parseTypeText', () => {
  it('accepts hostile-looking text unchanged (it is data, never source)', () => {
    const text = 'a"b\'c\\d $(id) `x` ;\n\ttab';
    expect(parseTypeText(text)).toBe(text);
  });

  it('rejects empty, oversized and control-character text', () => {
    expect(() => parseTypeText('')).toThrow(ComputerToolError);
    expect(() => parseTypeText('x'.repeat(2001))).toThrow(/longer/);
    expect(() => parseTypeText('a\u0000b')).toThrow(/control/);
    expect(() => parseTypeText('a\u001bb')).toThrow(/control/);
    expect(() => parseTypeText(5)).toThrow(ComputerToolError);
  });
});

describe('chunkText', () => {
  it('splits on code point boundaries without breaking surrogate pairs', () => {
    const chunks = chunkText('😀😀😀😀😀', 2);
    expect(chunks).toEqual(['😀😀', '😀😀', '😀']);
    expect(chunks.join('')).toBe('😀😀😀😀😀');
  });
});

describe('COMPUTER_INPUT_JXA', () => {
  it('is a fixed script that reads its input from stdin', () => {
    expect(COMPUTER_INPUT_JXA).toContain('fileHandleWithStandardInput');
    expect(COMPUTER_INPUT_JXA).not.toContain('${');
    // "run" JXA'da örtük giriş noktasıdır; tanımlanırsa osascript onu bir kez daha çalıştırır.
    expect(COMPUTER_INPUT_JXA).not.toMatch(/function\s+run\s*\(/);
    // Betik hiçbir kabuk/komut çalıştırma yüzeyi içermez.
    expect(COMPUTER_INPUT_JXA).not.toMatch(/doShellScript|NSTask|system\(|eval\(|Function\(/);
  });
});

describe('COMPUTER_INPUT_JXA sleep helper', () => {
  it('does not rely on usleep, which Cocoa no longer exposes to JXA', () => {
    expect(COMPUTER_INPUT_JXA).not.toMatch(/\$\.usleep\(/);
  });

  it.runIf(process.platform === 'darwin')('runs under osascript with the script imports', () => {
    // Betikteki `sleep` tanımını, betiğin kendi içe aktarmalarıyla tek başına çalıştır: bekleme
    // çağrısı tanımsızsa tuş/tıklama bırakma olayı hiç gönderilmiyordu.
    const sleepLine = COMPUTER_INPUT_JXA.split('\n').find((line) =>
      line.startsWith('function sleep(')
    );
    expect(sleepLine).toBeDefined();
    const script = [
      "ObjC.import('Cocoa');",
      "ObjC.import('CoreGraphics');",
      sleepLine,
      'const started = Date.now(); sleep(30); String(Date.now() - started >= 25);',
    ].join('\n');
    const output = execFileSync('osascript', ['-l', 'JavaScript', '-e', script], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(output.trim()).toBe('true');
  });
});
