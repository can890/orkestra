import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, readdir, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { err, ok, type Result } from '@orkestra/shared';
import {
  VOICE_AUTO_LANGUAGE,
  type LocalSttEngine,
  type LocalSttStatus,
  type Transcription,
  type VoiceError,
} from '@core/features/voice/api/contract';

const execFileAsync = promisify(execFile);

const DETECT_CACHE_TTL_MS = 30_000;
const IDLE_UNLOAD_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 120_000;

const MLX_MODEL_PRIORITY = [
  'mlx-community/whisper-large-v3-turbo',
  'mlx-community/whisper-small-mlx',
] as const;

const FASTER_WHISPER_PRIORITY = [
  'mobiuslabsgmbh/faster-whisper-large-v3-turbo',
  'Systran/faster-whisper-medium',
  'Systran/faster-whisper-small',
  'Systran/faster-whisper-tiny',
] as const;

export type LocalSttPort = {
  detect(options?: { customPythonPath?: string; forceRefresh?: boolean }): Promise<LocalSttStatus>;
  transcribe(input: {
    audio: Blob;
    fileName: string;
    language?: string;
    model?: string;
    customPythonPath?: string;
    signal?: AbortSignal;
  }): Promise<Result<Transcription, VoiceError>>;
  test(options?: {
    model?: string;
    customPythonPath?: string;
  }): Promise<Result<{ engine: LocalSttEngine; model: string; latencyMs: number }, VoiceError>>;
  dispose(): void;
};

type WorkerResponse =
  | { id: string; ok: true; text: string; language?: string }
  | { id: string; ok: false; error: string };

const PYTHON_WORKER_SCRIPT = [
  'import json, os, sys',
  'real_stdout = sys.stdout',
  'sys.stdout = sys.stderr',
  '_cached_faster = {"key": None, "model": None}',
  '_cached_openai = {"key": None, "model": None}',
  'def run_req(req):',
  '  engine = req.get("engine")',
  '  audio_path = req["audioPath"]',
  '  model = req["model"]',
  '  lang = req.get("language") or None',
  '  if engine == "mlx-whisper":',
  '    import mlx_whisper',
  '    res = mlx_whisper.transcribe(audio_path, path_or_hf_repo=model, language=lang, fp16=True)',
  '    return (res.get("text") or "").strip(), res.get("language")',
  '  if engine == "faster-whisper":',
  '    from faster_whisper import WhisperModel',
  '    if _cached_faster["key"] != model:',
  '      _cached_faster["model"] = WhisperModel(model, device="cpu", compute_type="int8")',
  '      _cached_faster["key"] = model',
  '    segments, info = _cached_faster["model"].transcribe(audio_path, language=lang, vad_filter=True)',
  '    return " ".join(s.text.strip() for s in segments if s.text).strip(), getattr(info, "language", None)',
  '  if engine == "whisper":',
  '    import whisper',
  '    if _cached_openai["key"] != model:',
  '      _cached_openai["model"] = whisper.load_model(model)',
  '      _cached_openai["key"] = model',
  '    res = _cached_openai["model"].transcribe(audio_path, language=lang)',
  '    return (res.get("text") or "").strip(), res.get("language")',
  '  raise RuntimeError(f"Unsupported engine: {engine}")',
  'for raw in sys.stdin:',
  '  line = raw.strip()',
  '  if not line:',
  '    continue',
  '  req_id = "unknown"',
  '  try:',
  '    req = json.loads(line)',
  '    req_id = req.get("id", "unknown")',
  '    text, detected_lang = run_req(req)',
  '    out = {"id": req_id, "ok": True, "text": text}',
  '    if detected_lang:',
  '      out["language"] = detected_lang',
  '    real_stdout.write(json.dumps(out, ensure_ascii=False) + "\\n")',
  '  except Exception as exc:',
  '    real_stdout.write(json.dumps({"id": req_id, "ok": False, "error": str(exc)}, ensure_ascii=False) + "\\n")',
  '  real_stdout.flush()',
].join('\n');

export function buildEnrichedPath(extraDir?: string): string {
  const home = homedir();
  const candidates = [
    extraDir,
    join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    ...(process.env.PATH ? process.env.PATH.split(delimiter) : []),
  ];
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const item of candidates) {
    const clean = item?.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    ordered.push(clean);
  }
  return ordered.join(delimiter);
}

export function defaultHfHubDir(): string {
  return join(homedir(), '.cache', 'huggingface', 'hub');
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findBinaryInPath(name: string, pathEnv: string): Promise<string | null> {
  for (const dir of pathEnv.split(delimiter)) {
    const candidate = join(dir, name);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

export async function scanCachedWhisperModels(hubDir: string = defaultHfHubDir()): Promise<string[]> {
  try {
    const entries = await readdir(hubDir, { withFileTypes: true });
    const models: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('models--')) continue;
      if (!entry.name.toLowerCase().includes('whisper')) continue;
      const rest = entry.name.slice('models--'.length);
      const sepIdx = rest.indexOf('--');
      if (sepIdx <= 0) continue;
      const repoId = `${rest.slice(0, sepIdx)}/${rest.slice(sepIdx + 2)}`;
      const snapshotsDir = join(hubDir, entry.name, 'snapshots');
      try {
        const revs = await readdir(snapshotsDir, { withFileTypes: true });
        for (const rev of revs) {
          if (!rev.isDirectory()) continue;
          if (await fileExists(join(snapshotsDir, rev.name, 'config.json'))) {
            models.push(repoId);
            break;
          }
        }
      } catch {
        // snapshots yoksa atla
      }
    }
    return models.sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export async function resolveLocalSnapshotPath(
  repoId: string,
  hubDir: string = defaultHfHubDir()
): Promise<string | null> {
  const parts = repoId.split('/');
  if (parts.length !== 2) return null;
  const snapshotsDir = join(hubDir, `models--${parts[0]}--${parts[1]}`, 'snapshots');
  try {
    const revs = await readdir(snapshotsDir, { withFileTypes: true });
    for (const rev of revs) {
      if (!rev.isDirectory()) continue;
      const dir = join(snapshotsDir, rev.name);
      if (await fileExists(join(dir, 'config.json'))) {
        return dir;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function pickRecommendedModel(
  engine: LocalSttEngine,
  cachedModels: readonly string[]
): string {
  const cachedSet = new Set(cachedModels);
  if (engine === 'mlx-whisper') {
    for (const preferred of MLX_MODEL_PRIORITY) {
      if (cachedSet.has(preferred)) return preferred;
    }
    const anyMlx = cachedModels.find((m) => m.toLowerCase().includes('mlx'));
    return anyMlx ?? MLX_MODEL_PRIORITY[0];
  }
  if (engine === 'faster-whisper') {
    for (const preferred of FASTER_WHISPER_PRIORITY) {
      if (cachedSet.has(preferred)) return preferred;
    }
    return 'small';
  }
  return 'small';
}

export function createSilentWavBytes(durationMs = 400, sampleRate = 16_000): Uint8Array {
  const sampleCount = Math.max(160, Math.floor((sampleRate * durationMs) / 1000));
  const dataBytes = sampleCount * 2;
  const buf = new Uint8Array(44 + dataBytes);
  const view = new DataView(buf.buffer);
  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i += 1) {
      buf[offset + i] = str.charCodeAt(i);
    }
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);
  return buf;
}

async function listCandidatePythons(customPythonPath?: string): Promise<string[]> {
  const home = homedir();
  const candidates: string[] = [];
  if (customPythonPath?.trim()) {
    candidates.push(customPythonPath.trim());
  }

  for (const venvRoot of [join(home, '.venvs'), join(home, '.local', 'share')]) {
    try {
      const dirs = await readdir(venvRoot, { withFileTypes: true });
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        candidates.push(join(venvRoot, dir.name, 'bin', 'python3'));
        candidates.push(join(venvRoot, dir.name, 'bin', 'python'));
      }
    } catch {
      // Dizin yoksa geç
    }
  }

  candidates.push('/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3');

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    if (await isExecutable(c)) unique.push(c);
  }
  return unique;
}

async function probePythonEngines(pythonPath: string): Promise<LocalSttEngine[]> {
  const script =
    "import importlib.util as u; print(','.join(m for m in ('mlx_whisper','faster_whisper','whisper') if u.find_spec(m)))";
  try {
    const { stdout } = await execFileAsync(pythonPath, ['-c', script], {
      timeout: 3_000,
      env: { ...process.env, PATH: buildEnrichedPath(dirname(pythonPath)) },
    });
    const found: LocalSttEngine[] = [];
    for (const token of stdout.trim().split(',')) {
      if (token === 'mlx_whisper') found.push('mlx-whisper');
      else if (token === 'faster_whisper') found.push('faster-whisper');
      else if (token === 'whisper') found.push('whisper');
    }
    return found;
  } catch {
    return [];
  }
}

export class LocalSttRunner implements LocalSttPort {
  private cachedDetect: { key: string; expiresAt: number; status: LocalSttStatus } | null = null;
  private worker: {
    proc: ChildProcessWithoutNullStreams;
    pythonPath: string;
    rejectAll: (error: Error) => void;
  } | null = null;
  private pending = new Map<
    string,
    { resolve: (res: WorkerResponse) => void; reject: (err: Error) => void }
  >();
  private queue: Promise<void> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly options: {
      hubDir?: string;
      logger?: { warn(message: string, context?: Record<string, unknown>): void };
    } = {}
  ) {}

  async detect(opts?: {
    customPythonPath?: string;
    forceRefresh?: boolean;
  }): Promise<LocalSttStatus> {
    const customKey = opts?.customPythonPath?.trim() ?? '';
    const now = Date.now();
    if (!opts?.forceRefresh && this.cachedDetect && this.cachedDetect.key === customKey && this.cachedDetect.expiresAt > now) {
      return this.cachedDetect.status;
    }

    const enrichedPath = buildEnrichedPath(customKey ? dirname(customKey) : undefined);
    const [ffmpegBin, cachedModels, pythonCandidates] = await Promise.all([
      findBinaryInPath('ffmpeg', enrichedPath),
      scanCachedWhisperModels(this.options.hubDir ?? defaultHfHubDir()),
      listCandidatePythons(customKey || undefined),
    ]);
    const ffmpegAvailable = ffmpegBin !== null;

    for (const py of pythonCandidates) {
      const engines = await probePythonEngines(py);
      if (engines.length > 0) {
        const engine = engines[0]!;
        const recommendedModel = pickRecommendedModel(engine, cachedModels);
        const available = ffmpegAvailable;
        const status: LocalSttStatus = {
          available,
          engine,
          pythonPath: py,
          ffmpegAvailable,
          cachedModels,
          recommendedModel,
          ...(ffmpegAvailable
            ? {}
            : {
                reason:
                  'Python STT motoru bulundu ancak ffmpeg eksik. `ffmpeg` kurun veya PATH içinde bulundurun.',
              }),
        };
        this.cachedDetect = { key: customKey, expiresAt: now + DETECT_CACHE_TTL_MS, status };
        return status;
      }
    }

    const whisperCli =
      (await findBinaryInPath('whisper-cli', enrichedPath)) ??
      (await findBinaryInPath('whisper-cpp', enrichedPath));
    if (whisperCli) {
      const status: LocalSttStatus = {
        available: false,
        engine: 'whisper-cli',
        ffmpegAvailable,
        cachedModels,
        reason:
          'whisper-cli ikilisi bulundu; şimdilik mlx_whisper veya faster_whisper önerilir (~/.venvs içine kurulabilir).',
      };
      this.cachedDetect = { key: customKey, expiresAt: now + DETECT_CACHE_TTL_MS, status };
      return status;
    }

    const status: LocalSttStatus = {
      available: false,
      ffmpegAvailable,
      cachedModels,
      reason:
        'Yerel Whisper motoru bulunamadı (~/.venvs içinde mlx_whisper ya da faster_whisper tespit edilmedi).',
    };
    this.cachedDetect = { key: customKey, expiresAt: now + DETECT_CACHE_TTL_MS, status };
    return status;
  }

  private scheduleIdleUnload(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.dispose();
    }, IDLE_UNLOAD_MS);
  }

  private clearIdleUnload(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private ensureWorker(pythonPath: string): ChildProcessWithoutNullStreams {
    if (this.worker && this.worker.pythonPath === pythonPath && !this.worker.proc.killed) {
      return this.worker.proc;
    }
    this.dispose();

    const proc = spawn(pythonPath, ['-u', '-c', PYTHON_WORKER_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: buildEnrichedPath(dirname(pythonPath)),
        HF_HUB_DISABLE_PROGRESS_BARS: '1',
        TOKENIZERS_PARALLELISM: 'false',
      },
    });

    let stderrTail = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-1000);
    });

    const rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const parsed = JSON.parse(trimmed) as WorkerResponse;
        const entry = this.pending.get(parsed.id);
        if (entry) {
          this.pending.delete(parsed.id);
          entry.resolve(parsed);
        }
      } catch {
        // Beklenmeyen çıktı yoksayılır
      }
    });

    const rejectAll = (error: Error) => {
      rl.close();
      for (const [id, entry] of this.pending.entries()) {
        this.pending.delete(id);
        entry.reject(error);
      }
      if (this.worker?.proc === proc) {
        this.worker = null;
      }
    };

    proc.on('exit', (code, signal) => {
      rejectAll(
        new Error(
          `Yerel STT işçisi kapandı (kod=${String(code)}, sinyal=${String(signal)})${
            stderrTail.trim() ? `: ${stderrTail.trim()}` : ''
          }`
        )
      );
    });
    proc.on('error', (error) => rejectAll(error));

    this.worker = { proc, pythonPath, rejectAll };
    return proc;
  }

  dispose(): void {
    this.clearIdleUnload();
    if (!this.worker) return;
    const current = this.worker;
    this.worker = null;
    try {
      current.proc.kill('SIGTERM');
    } catch {
      // Süreç zaten kapalı olabilir
    }
    current.rejectAll(new Error('Yerel STT işçisi durduruldu.'));
  }

  private async runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async transcribe(input: {
    audio: Blob;
    fileName: string;
    language?: string;
    model?: string;
    customPythonPath?: string;
    signal?: AbortSignal;
  }): Promise<Result<Transcription, VoiceError>> {
    const status = await this.detect({ customPythonPath: input.customPythonPath });
    if (!status.available || !status.engine || !status.pythonPath) {
      return err({
        type: 'local_stt_unavailable',
        message:
          status.reason ??
          'Yerel Whisper motoru kullanılabilir değil. Ayarlar > Ses bölümünden kontrol edin.',
      });
    }

    const requestedModel =
      input.model && input.model.trim() && input.model.trim() !== 'auto'
        ? input.model.trim()
        : status.recommendedModel ?? 'mlx-community/whisper-large-v3-turbo';

    const snapshotPath =
      (await resolveLocalSnapshotPath(requestedModel, this.options.hubDir ?? defaultHfHubDir())) ??
      requestedModel;

    const extMatch = /\.([A-Za-z0-9]{2,5})$/.exec(input.fileName);
    const ext = extMatch ? extMatch[1]!.toLowerCase() : 'webm';
    const tmpAudioPath = join(tmpdir(), `orkestra-stt-${randomUUID()}.${ext}`);

    const cleanLanguage =
      input.language && input.language !== VOICE_AUTO_LANGUAGE
        ? input.language.trim().toLowerCase().slice(0, 3)
        : undefined;

    return this.runSerialized(async () => {
      this.clearIdleUnload();
      try {
        const audioBytes = new Uint8Array(await input.audio.arrayBuffer());
        await writeFile(tmpAudioPath, audioBytes);

        const proc = this.ensureWorker(status.pythonPath!);
        const reqId = randomUUID();
        const payload = JSON.stringify({
          id: reqId,
          engine: status.engine,
          audioPath: tmpAudioPath,
          model: snapshotPath,
          ...(cleanLanguage ? { language: cleanLanguage } : {}),
        });

        const response = await new Promise<WorkerResponse>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pending.delete(reqId);
            reject(new Error('Yerel STT işlemi zaman aşımına uğradı.'));
          }, REQUEST_TIMEOUT_MS);

          const onAbort = () => {
            clearTimeout(timer);
            this.pending.delete(reqId);
            reject(new Error('Dikte iptal edildi.'));
          };

          if (input.signal?.aborted) {
            onAbort();
            return;
          }
          input.signal?.addEventListener('abort', onAbort, { once: true });

          this.pending.set(reqId, {
            resolve: (res) => {
              clearTimeout(timer);
              input.signal?.removeEventListener('abort', onAbort);
              resolve(res);
            },
            reject: (e) => {
              clearTimeout(timer);
              input.signal?.removeEventListener('abort', onAbort);
              reject(e);
            },
          });

          proc.stdin.write(`${payload}\n`, (writeErr) => {
            if (writeErr) {
              clearTimeout(timer);
              input.signal?.removeEventListener('abort', onAbort);
              this.pending.delete(reqId);
              reject(writeErr);
            }
          });
        });

        if (!response.ok) {
          this.options.logger?.warn('Yerel STT başarısız oldu', { error: response.error });
          return err({ type: 'local_stt_failed', message: response.error });
        }

        return ok({
          text: response.text,
          ...(response.language ? { languageCode: response.language } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.options.logger?.warn('Yerel STT çalıştırma hatası', { message });
        return err({ type: 'local_stt_failed', message });
      } finally {
        await unlink(tmpAudioPath).catch(() => undefined);
        this.scheduleIdleUnload();
      }
    });
  }

  async test(opts?: {
    model?: string;
    customPythonPath?: string;
  }): Promise<Result<{ engine: LocalSttEngine; model: string; latencyMs: number }, VoiceError>> {
    const status = await this.detect({
      customPythonPath: opts?.customPythonPath,
      forceRefresh: true,
    });
    if (!status.available || !status.engine || !status.pythonPath) {
      return err({
        type: 'local_stt_unavailable',
        message: status.reason ?? 'Yerel Whisper motoru bulunamadı.',
      });
    }

    const chosenModel =
      opts?.model && opts.model.trim() && opts.model.trim() !== 'auto'
        ? opts.model.trim()
        : status.recommendedModel ?? 'mlx-community/whisper-large-v3-turbo';

    const wavBytes = createSilentWavBytes(400, 16_000);
    const wavCopy = new Uint8Array(wavBytes.byteLength);
    wavCopy.set(wavBytes);
    const audio = new Blob([wavCopy], { type: 'audio/wav' });

    const started = Date.now();
    const res = await this.transcribe({
      audio,
      fileName: 'self-test.wav',
      language: 'tr',
      model: chosenModel,
      customPythonPath: opts?.customPythonPath,
    });
    if (!res.success) return res;
    return ok({
      engine: status.engine,
      model: chosenModel,
      latencyMs: Date.now() - started,
    });
  }
}
