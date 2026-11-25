/**
 * Ajan sürecinin stdout akışı ile ACP SDK'sı arasında duran koruma.
 *
 * SDK (`ClientSideConnection`) her `session/update` bildirimini katı bir şemayla
 * doğrular; tek bir alan (ör. `tool_call.kind: 'subagent'`) sözleşme dışıysa
 * bildirimin tamamı "Invalid params" ile atılır ve yalnızca stderr'e yazılır. Geçmiş
 * yeniden oynatılırken bu, alt ajan satırlarının sessizce kaybolmasına yol açıyordu.
 *
 * Bu koruma, SDK'nın katı davrandığı bilinen alanları onarır ve satırı geçirir:
 * - Sözleşme dışı `kind` → `kind: 'other'`; asıl değer `_meta.orkestra.toolKind`
 *   alanına taşınır (çözücü buradan okur, böylece alt ajan satırı yine alt ajan olur).
 * - `tool_call` üzerindeki sözleşme dışı `status` ve nesne olmayan `_meta` atılır.
 * - Zorunlu alanı (`toolCallId`, `title`) eksik satır onarılmaz; SDK yalnızca onu atar.
 * Her onarım türü bağlantı başına bir kez, satırı tanıtacak bağlamla uyarı olarak
 * günlüğe yazılır. Diğer satırlara (ve onarılamayan satırların komşularına)
 * dokunulmaz.
 */

import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { Logger } from '@orkestra/shared/logger';
import {
  ACP_TOOL_CALL_STATUSES,
  ACP_TOOL_KINDS,
  ORKESTRA_META_KEY,
} from '#runtimes/acp/api/reducer/tool-kind';

export type SessionUpdateRepair = {
  field: 'kind' | 'status' | '_meta' | 'title' | 'toolCallId';
  /** Reddedilecek olan özgün değer (günlük için kısaltılmış metin). */
  value: string;
  /** `rejected`: onarılamaz; SDK yalnızca bu satırı atacak, komşularına dokunulmaz. */
  action: 'moved-to-meta' | 'dropped' | 'rejected';
};

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return (text ?? String(value)).slice(0, 80);
}

/**
 * `session/update` bildirimindeki `tool_call` / `tool_call_update` güncellemesini
 * yerinde onarır ve yapılan onarımları döndürür. Başka mesajlara dokunmaz.
 */
export function repairSessionUpdateMessage(message: unknown): SessionUpdateRepair[] {
  if (!isPlainObject(message) || message.method !== 'session/update') return [];
  const params = message.params;
  if (!isPlainObject(params) || !isPlainObject(params.update)) return [];
  const update = params.update;
  const variant = update.sessionUpdate;
  if (variant !== 'tool_call' && variant !== 'tool_call_update') return [];

  const repairs: SessionUpdateRepair[] = [];
  if (update._meta !== undefined && update._meta !== null && !isPlainObject(update._meta)) {
    repairs.push({ field: '_meta', value: describeValue(update._meta), action: 'dropped' });
    delete update._meta;
  }

  const kind = update.kind;
  // `tool_call_update.kind` null kabul eder; `tool_call.kind` etmez.
  const allowedNull = kind === null && variant === 'tool_call_update';
  if (kind !== undefined && !allowedNull && !ACP_TOOL_KINDS.has(kind as string)) {
    if (typeof kind === 'string' && kind.trim()) {
      const meta: JsonObject = isPlainObject(update._meta) ? update._meta : {};
      const orkestra: JsonObject = isPlainObject(meta[ORKESTRA_META_KEY])
        ? (meta[ORKESTRA_META_KEY] as JsonObject)
        : {};
      // Yazar türü zaten `_meta` içinde taşıyorsa o önceliklidir.
      if (typeof orkestra.toolKind !== 'string') orkestra.toolKind = kind;
      meta[ORKESTRA_META_KEY] = orkestra;
      update._meta = meta;
      update.kind = 'other';
      repairs.push({ field: 'kind', value: kind, action: 'moved-to-meta' });
    } else {
      delete update.kind;
      repairs.push({ field: 'kind', value: describeValue(kind), action: 'dropped' });
    }
  }

  // `tool_call_update.status` SDK'da hoşgörülüdür; yalnızca `tool_call` reddedilir.
  const status = update.status;
  if (
    variant === 'tool_call' &&
    status !== undefined &&
    !ACP_TOOL_CALL_STATUSES.has(status as string)
  ) {
    delete update.status;
    repairs.push({ field: 'status', value: describeValue(status), action: 'dropped' });
  }

  // Zorunlu alanlar uydurulmaz; satırın neden kaybolduğu yalnızca günlüğe yazılır.
  if (typeof update.toolCallId !== 'string') {
    repairs.push({
      field: 'toolCallId',
      value: describeValue(update.toolCallId),
      action: 'rejected',
    });
  }
  if (variant === 'tool_call' && typeof update.title !== 'string') {
    repairs.push({ field: 'title', value: describeValue(update.title), action: 'rejected' });
  }
  return repairs;
}

/**
 * NDJSON stdout akışını satır satır geçiren ve `session/update` satırlarını
 * onaran bir akış döndürür. Onarılmayan satırlar bayt bayt aynı kalır.
 */
export function guardAcpStdout(
  source: Readable,
  logger: Logger,
  recoverMedia?: (line: string) => Promise<string>
): Readable {
  const decoder = new StringDecoder('utf8');
  const reported = new Set<string>();
  let pending: string[] = [];

  const processLine = (line: string): string => {
    // Hızlı yol: araç satırı olmayan her şey ayrıştırılmadan geçer.
    if (!line.includes('session/update') || !line.includes('tool_call')) return line;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return line;
    }
    const repairs = repairSessionUpdateMessage(message);
    if (!repairs.length) return line;
    const params = (message as { params: { sessionId?: unknown; update: JsonObject } }).params;
    for (const repair of repairs) {
      const key = `${repair.field}:${repair.value}`;
      if (reported.has(key)) continue;
      reported.add(key);
      logger.warn(
        repair.action === 'rejected'
          ? 'ACP session update rejected: required field missing, only this update is dropped'
          : 'ACP session update repaired: field outside the ACP contract',
        {
          sessionId: params.sessionId,
          sessionUpdate: params.update.sessionUpdate,
          toolCallId: params.update.toolCallId,
          field: repair.field,
          value: repair.value,
          action: repair.action,
        }
      );
    }
    return repairs.every((repair) => repair.action === 'rejected') ? line : JSON.stringify(message);
  };

  async function* lines() {
    for await (const chunk of source) {
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      let start = 0;
      let newline = text.indexOf('\n', start);
      while (newline >= 0) {
        pending.push(text.slice(start, newline));
        const line = processLine(pending.join(''));
        pending = [];
        yield (
          (recoverMedia && line.includes(' chars truncated…') ? await recoverMedia(line) : line) +
            '\n'
        );
        start = newline + 1;
        newline = text.indexOf('\n', start);
      }
      if (start < text.length) pending.push(text.slice(start));
    }
    const rest = pending.join('') + decoder.end();
    if (rest) {
      const line = processLine(rest);
      yield recoverMedia && line.includes(' chars truncated…') ? await recoverMedia(line) : line;
    }
  }
  return Readable.from(lines(), { objectMode: false });
}
