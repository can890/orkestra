import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { extractArtifacts } from '#runtimes/acp/api/reducer/artifact-content';
import { findRolloutFile, resolveCodexHome } from '../session/codex-subagent-watcher';

// Tool summaries keep both ends of large strings, including the number of omitted characters.
const clippedMedia =
  /^(data:(?:image\/[\w.+-]+|video\/[\w.+-]+|audio\/[\w.+-]+|application\/pdf);base64,)([A-Za-z0-9+/=]{32,})…(\d+) chars truncated…([A-Za-z0-9+/=]{32,})$/;

export async function recoverCodexMedia(line: string, codexHome?: string): Promise<string> {
  try {
    const message = JSON.parse(line);
    const params = message?.params;
    const update = params?.update;
    if (
      message.method !== 'session/update' ||
      typeof params?.sessionId !== 'string' ||
      !['tool_call', 'tool_call_update', 'agent_message_chunk'].includes(update?.sessionUpdate)
    )
      return line;

    const missing = extractArtifacts([update.content, update.rawOutput])
      .map(({ uri }) => clippedMedia.exec(uri))
      .filter((match) => match !== null);
    if (!missing.length) return line;
    const path = await findRolloutFile(resolveCodexHome(codexHome), params.sessionId);
    if (!path) return line;

    const stream = createReadStream(path, { encoding: 'utf8' });
    const rows = createInterface({ input: stream, crlfDelay: Infinity });
    const replacements = new Map<string, string>();
    try {
      for await (const row of rows) {
        if (!missing.some((match) => row.includes(match[2]!))) continue;
        let entry;
        try {
          entry = JSON.parse(row);
        } catch {
          continue;
        }
        const payload = entry?.payload;
        if (
          entry?.type !== 'response_item' ||
          !['custom_tool_call_output', 'function_call_output'].includes(payload?.type)
        )
          continue;
        // Match only media in a tool result from this thread. Prompts may contain the same prefix.
        const originals = extractArtifacts(payload.output);
        for (const match of missing) {
          const [, header, head, count, tail] = match;
          const uri = originals.find(
            ({ uri }) =>
              uri.length === header!.length + head!.length + Number(count) + tail!.length &&
              uri.startsWith(header! + head!) &&
              uri.endsWith(tail!) &&
              /^[A-Za-z0-9+/]*={0,2}$/.test(uri.slice(header!.length))
          )?.uri;
          if (uri) replacements.set(match[0].slice(header!.length), uri.slice(header!.length));
        }
        if (missing.every((match) => replacements.has(match[0].slice(match[1]!.length)))) break;
      }
    } finally {
      rows.close();
      stream.destroy();
    }
    if (!replacements.size) return line;
    for (const key of ['content', 'rawOutput']) {
      if (update[key] === undefined) continue;
      let json = JSON.stringify(update[key]);
      for (const [clipped, original] of replacements) json = json.replaceAll(clipped, original);
      update[key] = JSON.parse(json);
    }
    return JSON.stringify(message);
  } catch {
    // Missing or rotated rollout files must never interrupt ACP delivery.
    return line;
  }
}
