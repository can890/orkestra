import type { Result } from '@orkestra/shared';
import { defineContract, procedure } from '@orkestra/wire/rpc';
import { z } from 'zod';
import type { MemoryEntry, MemoryEntrySummary, MemoryError } from './memory-model';

export const projectMemoryDomain = 'projectMemory' as const;

export type ProjectMemoryStateDto = { enabled: boolean; entries: MemoryEntrySummary[] };

const projectInput = z.object({ projectId: z.string().min(1) });
const entryInput = projectInput.extend({ name: z.string() });

/**
 * Ortak proje hafızası arayüz sözleşmesi. Ajan araçları bu sözleşmeyi kullanmaz; onlar köprü
 * üzerinden konuşmanın projesine bağlanır. Buradaki işlemler kullanıcının proje ayarları
 * sayfasındandır.
 */
export const projectMemoryContract = defineContract({
  getState: procedure({
    input: projectInput,
    output: z.custom<Result<ProjectMemoryStateDto, MemoryError>>(),
  }),
  setEnabled: procedure({
    input: projectInput.extend({ enabled: z.boolean() }),
    output: z.void(),
  }),
  read: procedure({ input: entryInput, output: z.custom<Result<MemoryEntry, MemoryError>>() }),
  write: procedure({
    input: entryInput.extend({ description: z.string(), content: z.string() }),
    output: z.custom<Result<MemoryEntrySummary, MemoryError>>(),
  }),
  remove: procedure({ input: entryInput, output: z.custom<Result<void, MemoryError>>() }),
  /** Yeni bir sohbetin ilk prompt'una eklenecek dizin bloğu; ayar kapalıysa null. */
  promptContext: procedure({ input: projectInput, output: z.string().nullable() }),
});
