import { Script } from 'node:vm';

/**
 * `evaluate` için ana dünyada (main world) çalışacak sarmalayıcı kaynak.
 *
 * Kullanıcı kodu sayfanın CSP'sine takılmamak için `eval` ile değil, doğrudan enjekte edilen
 * betiğin içine yerleştirilir (executeJavaScript ile çalışan betik CSP'den muaftır, içindeki
 * eval değildir). Sözdizimi ana süreçte `vm.Script` ile derlenerek (çalıştırılmadan) denetlenir:
 * önce ifade biçimi, olmazsa açık `return` gerektiren fonksiyon gövdesi biçimi denenir. Sonuç
 * sayfada sınırlı uzunlukta JSON'a dönüştürülür; hatalar yapılandırılmış olarak döner.
 */

export const EVALUATE_RESULT_MAX_CHARS = 20_000;

export type EvaluateMode = 'expression' | 'body';

export type SerializedValue = { json: string; truncated: boolean; undefined: boolean };

/** Sayfaya `toString()` ile enjekte edilir; modül kapsamına başvurmamalıdır. */
export function serializeForAgent(value: unknown, maxChars: number): SerializedValue {
  let out = '';
  let truncated = false;
  const seen = new WeakSet<object>();
  const write = (text: string) => {
    if (truncated) return;
    const room = maxChars - out.length;
    if (text.length > room) {
      out += text.slice(0, Math.max(0, room));
      truncated = true;
    } else {
      out += text;
    }
  };
  const describeNode = (node: {
    nodeType: number;
    nodeName: string;
    id?: unknown;
    textContent?: unknown;
  }): string => {
    if (node.nodeType === 3)
      return `#text ${JSON.stringify(String(node.textContent ?? '').slice(0, 80))}`;
    if (node.nodeType === 9) return '#document';
    const id = typeof node.id === 'string' && node.id ? `#${node.id}` : '';
    return `<${node.nodeName.toLowerCase()}${id}>`;
  };
  const walk = (current: unknown, depth: number): void => {
    if (truncated) return;
    if (current === null || current === undefined) {
      write('null');
      return;
    }
    switch (typeof current) {
      case 'string':
        write(JSON.stringify(current));
        return;
      case 'number':
        write(Number.isFinite(current) ? String(current) : JSON.stringify(String(current)));
        return;
      case 'boolean':
        write(current ? 'true' : 'false');
        return;
      case 'bigint':
        write(JSON.stringify(`${current.toString()}n`));
        return;
      case 'symbol':
        write(JSON.stringify(current.toString()));
        return;
      case 'function':
        write(JSON.stringify(`[Function ${(current as { name?: string }).name || 'anonymous'}]`));
        return;
      default:
        break;
    }
    const obj = current as Record<string, unknown>;
    if (seen.has(obj)) {
      write('"[Circular]"');
      return;
    }
    if (depth > 20) {
      write('"[Max depth]"');
      return;
    }
    const maybeNode = obj as { nodeType?: unknown; nodeName?: unknown };
    if (typeof maybeNode.nodeType === 'number' && typeof maybeNode.nodeName === 'string') {
      write(JSON.stringify(describeNode(obj as { nodeType: number; nodeName: string })));
      return;
    }
    if (obj['window'] === obj) {
      write('"[Window]"');
      return;
    }
    seen.add(obj);
    try {
      if (obj instanceof Date) {
        write(JSON.stringify(Number.isNaN(obj.getTime()) ? 'Invalid Date' : obj.toISOString()));
      } else if (obj instanceof RegExp) {
        write(JSON.stringify(String(obj)));
      } else if (obj instanceof Error) {
        walk({ name: obj.name, message: obj.message }, depth + 1);
      } else if (obj instanceof Map) {
        walk(Array.from(obj.entries()), depth + 1);
      } else if (obj instanceof Set) {
        walk(Array.from(obj.values()), depth + 1);
      } else if (Array.isArray(obj) || ArrayBuffer.isView(obj)) {
        const items = Array.from(obj as ArrayLike<unknown>);
        write('[');
        items.forEach((item, index) => {
          if (truncated) return;
          if (index > 0) write(',');
          walk(item, depth + 1);
        });
        write(']');
      } else if (typeof obj['toJSON'] === 'function') {
        walk((obj['toJSON'] as () => unknown)(), depth + 1);
      } else {
        write('{');
        let first = true;
        for (const key of Object.keys(obj)) {
          if (truncated) break;
          let item: unknown;
          try {
            item = obj[key];
          } catch (error) {
            item = `[Error: ${error instanceof Error ? error.message : String(error)}]`;
          }
          if (item === undefined) continue;
          if (!first) write(',');
          first = false;
          write(JSON.stringify(key));
          write(':');
          walk(item, depth + 1);
        }
        write('}');
      }
    } finally {
      seen.delete(obj);
    }
  };
  walk(value, 0);
  return { json: out, truncated, undefined: value === undefined };
}

export function buildEvaluationSource(code: string, mode: EvaluateMode, maxChars: number): string {
  const invoke =
    mode === 'expression'
      ? `let __orkestraValue = await (async () => (\n${code}\n))();\n` +
        "    if (typeof __orkestraValue === 'function') __orkestraValue = await __orkestraValue();"
      : `const __orkestraValue = await (async () => {\n${code}\n})();`;
  return [
    '(async () => {',
    `  const __orkestraSerialize = ${serializeForAgent.toString()};`,
    '  try {',
    `    ${invoke}`,
    `    const __orkestraResult = __orkestraSerialize(__orkestraValue, ${Math.floor(maxChars)});`,
    '    return { ok: true, json: __orkestraResult.json, truncated: __orkestraResult.truncated, ' +
      'undefined: __orkestraResult.undefined };',
    '  } catch (__orkestraError) {',
    "    let __orkestraText = 'Error: unknown error';",
    '    try {',
    "      if (__orkestraError && typeof __orkestraError === 'object') {",
    "        __orkestraText = String(__orkestraError.name || 'Error') + ': ' + String(__orkestraError.message ?? '');",
    '      } else {',
    "        __orkestraText = 'Error: ' + String(__orkestraError);",
    '      }',
    '    } catch (_) {}',
    '    return { ok: false, error: __orkestraText };',
    '  }',
    '})()',
  ].join('\n');
}

function compileError(source: string): string | null {
  try {
    const script = new Script(source);
    return script ? null : 'could not compile';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Kodu ifade ya da gövde biçiminde sarar; ikisi de derlenmezse açıklayıcı hata fırlatır. */
export function prepareEvaluation(
  code: string,
  maxChars: number = EVALUATE_RESULT_MAX_CHARS
): { source: string; mode: EvaluateMode } {
  const trimmed = code.trim();
  const expressionSource = buildEvaluationSource(
    trimmed.replace(/[;\s]+$/, ''),
    'expression',
    maxChars
  );
  if (compileError(expressionSource) === null)
    return { source: expressionSource, mode: 'expression' };
  const bodySource = buildEvaluationSource(trimmed, 'body', maxChars);
  const bodyError = compileError(bodySource);
  if (bodyError === null) return { source: bodySource, mode: 'body' };
  throw new Error(
    `Evaluation failed: SyntaxError: ${bodyError}. Pass a JavaScript expression (e.g. document.title), ` +
      'a function (e.g. () => document.title), or statements with an explicit return.'
  );
}

export function decodeEvaluationResult(
  raw: unknown,
  maxChars: number = EVALUATE_RESULT_MAX_CHARS
): unknown {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Evaluation failed: the page returned an unexpected result.');
  }
  const result = raw as {
    ok?: unknown;
    json?: unknown;
    truncated?: unknown;
    undefined?: unknown;
    error?: unknown;
  };
  if (result.ok !== true) {
    throw new Error(
      `Evaluation failed: ${typeof result.error === 'string' ? result.error : 'unknown error'}`
    );
  }
  if (result.undefined === true) return undefined;
  const json = typeof result.json === 'string' ? result.json : 'null';
  if (result.truncated === true) {
    return `${json}… [truncated: the result exceeded ${maxChars} characters]`;
  }
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return json;
  }
}
