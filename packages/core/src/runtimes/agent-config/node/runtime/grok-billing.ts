// Field numbers and proto3 defaults verified against Grok's public billing descriptor:
// https://cdn.grok.com/_next/static/chunks/32g78bk5hhe1q.js
// Only a complete, successful response with an active period can supply an omitted zero.
type Field = { id: number; wire: number; value: number | Buffer };
function fields(data: Buffer): Field[] {
  let offset = 0;
  const varint = () => {
    let value = 0n;
    for (let n = 0; n < 10; n++) {
      if (offset >= data.length) throw new Error('Truncated protobuf');
      const byte = data[offset++]!;
      if (n === 9 && byte > 1) throw new Error('Overflow');
      value |= BigInt(byte & 127) << BigInt(n * 7);
      if (!(byte & 128)) {
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unsafe integer');
        return Number(value);
      }
    }
    throw new Error('Invalid varint');
  };
  const take = (size: number) => {
    if (size > data.length - offset) throw new Error('Truncated field');
    const value = data.subarray(offset, offset + size); offset += size; return value;
  };
  const result: Field[] = [];
  while (offset < data.length) {
    const tag = varint(), id = Math.floor(tag / 8), wire = tag % 8;
    if (!id || id > 536870911) throw new Error('Invalid field');
    const value = wire === 0 ? varint() : wire === 2 ? take(varint()) : wire === 5 ? take(4) : wire === 1 ? take(8) : undefined;
    if (value === undefined) throw new Error('Unsupported wire type');
    result.push({ id, wire, value });
  }
  return result;
}
function field(items: Field[], id: number, wire: number) {
  const matches = items.filter(f => f.id === id);
  if (matches.length > 1 || (matches[0] && matches[0].wire !== wire)) throw new Error('Invalid known field');
  return matches[0]?.value;
}
export function parseGrokBillingFrames(data: Buffer, now = Date.now()): { usedPercent: number; resetsAt: string; weekly: boolean } | undefined {
  try {
    if (data.length > 1024 * 1024) return;
    let offset = 0, message: Buffer | undefined, success = false;
    while (offset < data.length) {
      if (offset + 5 > data.length) return;
      const kind = data[offset]!, size = data.readUInt32BE(offset + 1); offset += 5;
      if (size > data.length - offset) return;
      const frame = data.subarray(offset, offset + size); offset += size;
      if (kind === 0 && !message && !success) message = frame;
      else if (kind === 128 && offset === data.length) success = /^grpc-status:\s*0\r?$/m.test(frame.toString('utf8'));
      else return;
    }
    if (!success || !message) return;
    const config = field(fields(message), 1, 2); if (!Buffer.isBuffer(config)) return;
    const c = fields(config), period = field(c, 8, 2); if (!Buffer.isBuffer(period)) return;
    const p = fields(period), type = field(p, 1, 0);
    const timestamp = (id: number) => {
      const b = field(p, id, 2); if (!Buffer.isBuffer(b)) throw new Error('Missing timestamp');
      const t = fields(b), seconds = field(t, 1, 0), nanos = field(t, 2, 0) ?? 0;
      if (typeof seconds !== 'number' || typeof nanos !== 'number' || nanos >= 1e9) throw new Error('Invalid timestamp');
      return seconds * 1000 + nanos / 1e6;
    };
    const start = timestamp(2), end = timestamp(3);
    if ((type !== 1 && type !== 2) || !(start <= now && now < end)) return;
    const raw = field(c, 1, 5);
    // An absent scalar is zero in this proto3 schema, not a missing JSON measurement.
    const usedPercent = Buffer.isBuffer(raw) ? raw.readFloatLE() : 0;
    if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return;
    return { usedPercent, resetsAt: new Date(end).toISOString(), weekly: type === 2 };
  } catch { return; }
}
export async function readGrokBillingWindow(token: string) {
  try {
    const response = await fetch('https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig', {
      method: 'POST', body: Buffer.from('00000000020800', 'hex'), redirect: 'error', signal: AbortSignal.timeout(6000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/grpc-web+proto', 'x-grpc-web': '1',
        'x-xai-token-auth': 'xai-grok-cli', 'User-Agent': 'grok-cli/1.0.46' },
    });
    if (!response.ok) return;
    return parseGrokBillingFrames(Buffer.from(await response.arrayBuffer()));
  } catch { return; }
}
