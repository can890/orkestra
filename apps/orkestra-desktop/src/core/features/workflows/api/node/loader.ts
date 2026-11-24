// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/server/src/workflows/WorkflowRuntime.ts
//
// Yürütme ortamı (bilinçli karar): T3 gibi iş akışı dosyaları ana süreçte, kullanıcının
// yetkileriyle ve yalıtımsız çalışır. Dosyalar kullanıcının kendi yazdığı (ya da ajanına
// yazdırdığı) koddur; Node yerleşiklerini (`node:fs`, `node:child_process`) içe aktarabilir.
// `vm` bağlamı gerçek bir güvenlik sınırı olmadığından yanıltıcı bir yalıtım sunulmaz; bunun
// yerine özellik varsayılan kapalıdır ve yalnızca kullanıcının klasöründeki dosyalar yüklenir.
// TypeScript, Node'un tür silme işleviyle (`stripTypeScriptTypes`, yalnızca silinebilir sözdizimi)
// JavaScript'e çevrilir; satır numaraları korunur.
import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as nodeModule from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createAuthoringApi,
  defineWorkflow,
  isWorkflowDefinition,
  type WorkflowDefinition,
} from './authoring';
import type { LoadedDefinition } from './engine';

/** Harf, rakam, `-`, `_` ve `.`; nokta ile başlayan dosyalar ve alt klasörler yok sayılır. */
export const DEFINITION_FILE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(ts|mts|js|mjs)$/;
const LOAD_DEADLINE_MS = 20_000;
const RELOAD_DEBOUNCE_MS = 250;

export type DefinitionProblem = { file: string; message: string; line: number | null };

type Collector = { registered: WorkflowDefinition[]; open: boolean };

// API global olarak verildiği için dosyalar tek tek yüklenir.
let loadingChain: Promise<unknown> = Promise.resolve();
let collector: Collector | null = null;
let loads = 0;

const boundWorkflow: typeof defineWorkflow = (name, options, body) => {
  const active = collector;
  if (!active || !active.open) {
    throw new Error(
      'Orkestra.workflow was called after its file finished loading. Call it at the top of the file.'
    );
  }
  const definition = defineWorkflow(name, options, body);
  active.registered.push(definition);
  return definition;
};

const api = createAuthoringApi(boundWorkflow);

type StripTypes = (code: string, options?: { mode?: 'strip' | 'transform' }) => string;

function stripTypes(source: string, file: string): string {
  if (!/\.m?ts$/.test(file)) return source;
  const strip = (nodeModule as { stripTypeScriptTypes?: StripTypes }).stripTypeScriptTypes;
  if (typeof strip !== 'function') {
    throw new Error(
      'This runtime cannot read TypeScript workflow files. Write the workflow as a .mjs file instead.'
    );
  }
  // Deneysel uyarı her yüklemede günlüğe düşmesin.
  const emit = process.emitWarning;
  process.emitWarning = (() => undefined) as typeof process.emitWarning;
  try {
    return strip(source, { mode: 'strip' });
  } finally {
    process.emitWarning = emit;
  }
}

function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((done) => {
    timer = setTimeout(done, ms, undefined);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * Bir dosyanın tanımladığı iş akışları: çağırdığı her `Orkestra.workflow(…)` ve dışa aktardığı
 * tanım ya da tanım listesi.
 */
export function loadDefinitionFile(
  file: string,
  deadlineMs = LOAD_DEADLINE_MS
): Promise<WorkflowDefinition[]> {
  const next = loadingChain.then(() => loadOnce(file, deadlineMs));
  loadingChain = next.catch(() => undefined);
  return next;
}

async function loadOnce(file: string, deadlineMs: number): Promise<WorkflowDefinition[]> {
  const source = await readFile(file, 'utf8');
  const code = stripTypes(source, file);
  loads += 1;
  const digest = createHash('sha256').update(code).digest('hex').slice(0, 12);
  // Göreli içe aktarmalar çözülebilsin diye geçici dosya aynı klasörde (nokta ile başlar, yok
  // sayılır) yazılır ve yüklemeden hemen sonra silinir.
  const temp = join(dirname(file), `.${basename(file)}.${digest}.${loads}.orkestra-load.mjs`);
  await writeFile(temp, code, { encoding: 'utf8', mode: 0o600 });
  const evaluation: Collector = { registered: [], open: true };
  collector = evaluation;
  (globalThis as { Orkestra?: unknown }).Orkestra = api;
  try {
    const loaded = (await within(
      // Kullanıcının iş akışı dosyası çalışma anında yüklenir; statik içe aktarma mümkün değil.
      // oxlint-disable-next-line orkestra/no-dynamic-imports
      import(/* @vite-ignore */ pathToFileURL(temp).href) as Promise<{ default?: unknown }>,
      deadlineMs
    )) as { default?: unknown } | undefined;
    if (loaded === undefined) {
      throw new Error(
        `It did not finish loading within ${deadlineMs / 1000} seconds. Something at the top of the file waits for good.`
      );
    }
    const exported = loaded.default;
    const listed =
      exported === undefined
        ? []
        : Array.isArray(exported)
          ? exported
          : isWorkflowDefinition(exported)
            ? [exported]
            : null;
    if (listed === null || !listed.every(isWorkflowDefinition)) {
      throw new Error(
        'The default export is not a workflow or a list of them. Call Orkestra.workflow(…), or export what it returned.'
      );
    }
    return [...new Set([...evaluation.registered, ...listed])];
  } catch (error) {
    throw rewriteLocation(error, temp, file);
  } finally {
    evaluation.open = false;
    if (collector === evaluation) collector = null;
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

/** Hata yığınındaki geçici dosya adını gerçek dosyaya çevirir; satır numarası korunur. */
function rewriteLocation(error: unknown, temp: string, file: string): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  const tempUrl = pathToFileURL(temp).href;
  if (normalized.stack) {
    normalized.stack = normalized.stack.split(tempUrl).join(file).split(temp).join(file);
  }
  normalized.message = normalized.message.split(tempUrl).join(file).split(temp).join(file);
  return normalized;
}

export function problemLine(error: unknown, file: string): number | null {
  const stack = error instanceof Error ? (error.stack ?? '') : '';
  const name = basename(file);
  const at = stack.split(name).find((rest) => /^:\d+/.test(rest));
  const line = at === undefined ? undefined : Number(/^:(\d+)/.exec(at)?.[1]);
  return line === undefined || !Number.isFinite(line) ? null : line;
}

function tag(definition: WorkflowDefinition): string {
  return `${definition.name}@${definition.version}`;
}

/**
 * İş akışı klasörünü izler ve değişen dosyaları yeniden yükler. Yüklenemeyen ya da başka bir
 * dosyayla aynı ad+sürümü tanımlayan bir dosya, son çalışan sürümünü korur; sorun listelenir.
 */
export class WorkflowFolder {
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly seen = new Map<string, string>();
  private readonly good = new Map<string, WorkflowDefinition[]>();
  private readonly broken = new Map<string, DefinitionProblem>();
  private reloading: Promise<void> = Promise.resolve();
  private stopped = false;
  readonly directory: string;
  private readonly singleFile: string | null;

  constructor(
    where: string,
    private readonly options: {
      onChange(definitions: LoadedDefinition[], problems: DefinitionProblem[]): void;
      logger: { warn(message: string, context?: Record<string, unknown>): void };
      ensureDirectory?: (directory: string) => Promise<void>;
    }
  ) {
    const target = resolve(where);
    this.singleFile = DEFINITION_FILE.test(basename(target)) ? target : null;
    this.directory = this.singleFile ? dirname(target) : target;
  }

  get folder(): string {
    return this.singleFile ?? this.directory;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.options.ensureDirectory?.(this.directory);
    await this.reload();
    try {
      this.watcher = watch(this.directory, { persistent: false }, (_event, name) => {
        if (typeof name === 'string' && name.startsWith('.')) return;
        this.scheduleReload();
      });
      this.watcher.on('error', (error) => {
        this.options.logger.warn('Workflows: folder watcher failed', { error: String(error) });
      });
    } catch (error) {
      this.options.logger.warn('Workflows: the folder is not watched for changes', {
        error: String(error),
      });
    }
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleReload(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.reload();
    }, RELOAD_DEBOUNCE_MS);
  }

  reload(): Promise<void> {
    this.reloading = this.reloading
      .then(() => this.reloadOnce())
      .catch((error: unknown) => {
        this.options.logger.warn('Workflows: reload failed', { error: String(error) });
      });
    return this.reloading;
  }

  private async listFiles(): Promise<string[]> {
    if (this.singleFile) return [this.singleFile];
    const names = await readdir(this.directory).catch(() => [] as string[]);
    const files: string[] = [];
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue;
      const file = join(this.directory, name);
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) continue;
      if (!DEFINITION_FILE.test(name)) {
        if (/\.(m?ts|m?js)$/.test(name)) {
          this.options.logger.warn(
            'Workflows: file name skipped (use letters, digits, -, _ and .)',
            {
              file: name,
            }
          );
        }
        continue;
      }
      files.push(file);
    }
    return files;
  }

  private async reloadOnce(): Promise<void> {
    if (this.stopped) return;
    const files = await this.listFiles();
    const present = new Set(files);
    for (const file of [...this.seen.keys()]) {
      if (!present.has(file)) {
        this.seen.delete(file);
        this.good.delete(file);
        this.broken.delete(file);
      }
    }
    for (const file of files) {
      const content = await readFile(file, 'utf8').catch(() => null);
      if (content === null) continue;
      const digest = createHash('sha256').update(content).digest('hex');
      if (this.seen.get(file) === digest) continue;
      this.seen.set(file, digest);
      try {
        const definitions = await loadDefinitionFile(file);
        const clash = this.clash(file, definitions);
        if (clash) {
          this.broken.set(file, { file, message: clash, line: null });
          continue;
        }
        this.good.set(file, definitions);
        this.broken.delete(file);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.broken.set(file, { file, message, line: problemLine(error, file) });
        this.options.logger.warn('Workflows: a definitions file was not loaded', { file, message });
      }
    }
    if (this.stopped) return;
    this.options.onChange(this.definitions(), [...this.broken.values()]);
  }

  private clash(file: string, definitions: WorkflowDefinition[]): string | null {
    const own = new Set<string>();
    for (const definition of definitions) {
      if (own.has(tag(definition))) return `${tag(definition)} is defined twice in this file.`;
      own.add(tag(definition));
    }
    for (const [other, existing] of this.good) {
      if (other === file) continue;
      const duplicate = existing.find((definition) => own.has(tag(definition)));
      if (duplicate) {
        return `${tag(duplicate)} is already defined in ${basename(other)}. A workflow's name and version name one body.`;
      }
    }
    return null;
  }

  definitions(): LoadedDefinition[] {
    return [...this.good].flatMap(([file, definitions]) =>
      definitions.map((definition) => ({ definition, file }))
    );
  }

  problems(): DefinitionProblem[] {
    return [...this.broken.values()];
  }
}
