import { describe, expect, it, vi } from 'vitest';
import type { HookDefinition, LifecycleHooksConfig } from '../api/hook-config';
import type { LifecycleHookEvent } from '../api/node/hook-events';
import { LifecycleHookDispatcher, serializeStdin } from './hook-dispatcher';
import type {
  HookProcessRequest,
  HookProcessResult,
  HookProcessRunner,
} from './hook-process-runner';

const MALICIOUS =
  'x"; rm -rf ~ #`$(touch /tmp/pwn)`\n$HOME ${SECRET} sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA';

const hook = (overrides: Partial<HookDefinition> = {}): HookDefinition => ({
  id: 'h1',
  name: '',
  event: 'conversation.prompt-submitted',
  command: 'cat > /dev/null',
  enabled: true,
  timeoutSec: 30,
  projectIds: [],
  ...overrides,
});

const event = (overrides: Partial<LifecycleHookEvent> = {}): LifecycleHookEvent => ({
  name: 'conversation.prompt-submitted',
  projectId: 'proj-1',
  taskId: 'task-1',
  conversationId: 'conv-1',
  occurredAt: 1_700_000_000_000,
  data: { prompt: 'merhaba' },
  ...overrides,
});

const OK: HookProcessResult = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  stdout: '',
  stderr: '',
};

function setup(
  hooks: HookDefinition[],
  runner: HookProcessRunner = async () => OK,
  extra: {
    paused?: boolean;
    isLocal?: boolean;
    limits?: { maxConcurrentTotal: number; maxStartsPerMinute: number };
    now?: () => number;
    baseEnv?: NodeJS.ProcessEnv;
  } = {}
) {
  const config: LifecycleHooksConfig = { version: '1', paused: extra.paused ?? false, hooks };
  const logger = { info: vi.fn(), warn: vi.fn() };
  const dispatcher = new LifecycleHookDispatcher({
    getConfig: () => config,
    runner,
    isLocalProject: async () => extra.isLocal ?? true,
    resolveShellSetup: async () => 'source ~/.setup',
    baseEnv: () => extra.baseEnv ?? { PATH: '/usr/bin', HOME: '/home/u' },
    logger,
    ...(extra.limits ? { limits: extra.limits } : {}),
    ...(extra.now ? { now: extra.now } : {}),
  });
  return { dispatcher, logger, config };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('LifecycleHookDispatcher', () => {
  it('yayın kancayı beklemez: emit hemen döner, çalıştırıcı sonradan bitse de', async () => {
    const gate = deferred<HookProcessResult>();
    const runner = vi.fn<HookProcessRunner>(() => gate.promise);
    const { dispatcher } = setup([hook()], runner);

    const before = Date.now();
    const returned = dispatcher.emit(event());
    expect(returned).toBeUndefined();
    expect(Date.now() - before).toBeLessThan(50);
    // Henüz mikro görev bile çalışmadı: çalıştırıcı çağrılmadı.
    expect(runner).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
    expect(dispatcher.getRuns()).toEqual([]);
    gate.resolve(OK);
    await dispatcher.idle();
    expect(dispatcher.getRuns()).toHaveLength(1);
  });

  it('çalıştırıcı reddederse/fırlatırsa hata yalnızca günlüğe düşer', async () => {
    const { dispatcher, logger } = setup([hook()], async () => {
      throw new Error('boom');
    });
    dispatcher.emit(event());
    await dispatcher.idle();
    expect(dispatcher.getRuns()[0]?.status).toBe('error');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('olay verisi komuta, argv/env değerlerine sızmaz; yalnızca stdin JSON’unda yer alır', async () => {
    const requests: HookProcessRequest[] = [];
    const { dispatcher } = setup([hook({ command: 'cat > /dev/null' })], async (request) => {
      requests.push(request);
      return OK;
    });
    dispatcher.emit(event({ data: { prompt: MALICIOUS, lastAssistantMessage: MALICIOUS } }));
    await dispatcher.idle();

    const request = requests[0]!;
    // Komut metni kullanıcının yazdığı haliyle kalır.
    expect(request.command).toBe('cat > /dev/null');
    expect(request.shellSetup).toBe('source ~/.setup');
    // Kötü niyetli metin hiçbir env değerinde ya da anahtarında bulunmaz.
    for (const [key, value] of Object.entries(request.env)) {
      expect(value).not.toContain('rm -rf');
      expect(value).not.toContain('sk-ant');
      expect(key).not.toContain('PROMPT');
    }
    expect(JSON.stringify(request.env)).not.toContain('merhaba');
    // stdin JSON olarak içeriği taşır.
    const stdin = JSON.parse(request.stdin) as { data: { prompt: string }; event: string };
    expect(stdin.event).toBe('conversation.prompt-submitted');
    expect(stdin.data.prompt).toBe(MALICIOUS);
  });

  it('süreç ortamına yalnızca sabit adlı denetimli kimlikler eklenir', async () => {
    const requests: HookProcessRequest[] = [];
    const base = { PATH: '/usr/bin', HOME: '/home/u', ORKESTRA_CONVERSATION_ID: 'eski' };
    const { dispatcher } = setup(
      [hook({ event: 'task.created' })],
      async (r) => (requests.push(r), OK),
      { baseEnv: base }
    );
    dispatcher.emit(event({ name: 'task.created', conversationId: undefined, data: {} }));
    await dispatcher.idle();
    const env = requests[0]!.env;
    expect(env.ORKESTRA_HOOK_EVENT).toBe('task.created');
    expect(env.ORKESTRA_TASK_ID).toBe('task-1');
    expect(env.ORKESTRA_PROJECT_ID).toBe('proj-1');
    // Konuşma kimliği yoksa devralınmış eski değer silinir.
    expect(env).not.toHaveProperty('ORKESTRA_CONVERSATION_ID');
    const hookKeys = Object.keys(env).filter((key) => key.startsWith('ORKESTRA_'));
    expect(hookKeys.sort()).toEqual([
      'ORKESTRA_HOOK_EVENT',
      'ORKESTRA_PROJECT_ID',
      'ORKESTRA_TASK_ID',
    ]);
  });

  it('beklenmedik biçimli kimlik env’e konmaz; kanca çalıştırılmaz', async () => {
    const runner = vi.fn<HookProcessRunner>(async () => OK);
    const { dispatcher } = setup([hook()], runner);
    dispatcher.emit(event({ taskId: 'a; rm -rf /' }));
    await dispatcher.idle();
    expect(runner).not.toHaveBeenCalled();
    expect(dispatcher.getRuns()[0]).toMatchObject({ status: 'skipped' });
  });

  it('stdin içindeki uzun metinler kırpılır', () => {
    const stdin = JSON.parse(serializeStdin(event({ data: { prompt: 'a'.repeat(50_000) } }))) as {
      data: { prompt: string };
    };
    expect(stdin.data.prompt.length).toBeLessThan(20_100);
  });

  it('kancaya yapılandırılan zaman aşımını (sn → ms) iletir; zaman aşımı kaydı düşer', async () => {
    const requests: HookProcessRequest[] = [];
    const { dispatcher } = setup([hook({ timeoutSec: 7 })], async (request) => {
      requests.push(request);
      return { ...OK, exitCode: null, signal: 'SIGTERM', timedOut: true };
    });
    dispatcher.emit(event());
    await dispatcher.idle();
    expect(requests[0]?.timeoutMs).toBe(7000);
    const run = dispatcher.getRuns()[0]!;
    expect(run.status).toBe('timeout');
    expect(run.note).toContain('7 sn');
  });

  it('aynı kanca için eşzamanlı çalıştırmayı 1 ile sınırlar; fazlası atlanıp kaydedilir', async () => {
    const gate = deferred<HookProcessResult>();
    const runner = vi.fn<HookProcessRunner>(() => gate.promise);
    const { dispatcher, logger } = setup([hook()], runner);

    dispatcher.emit(event());
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
    dispatcher.emit(event());
    dispatcher.emit(event());
    await vi.waitFor(() =>
      expect(dispatcher.getRuns().filter((r) => r.status === 'skipped')).toHaveLength(2)
    );
    expect(runner).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Kanca atlandı',
      expect.objectContaining({ hookId: 'h1' })
    );

    gate.resolve(OK);
    await dispatcher.idle();
    // Bittikten sonra yeniden çalışabilir.
    dispatcher.emit(event());
    await dispatcher.idle();
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('dakika başına başlatma sınırı: aşan olaylar atlanır, pencere kayınca yeniden çalışır', async () => {
    let now = 1_000_000;
    const runner = vi.fn<HookProcessRunner>(async () => OK);
    const { dispatcher } = setup([hook()], runner, {
      limits: { maxConcurrentTotal: 4, maxStartsPerMinute: 3 },
      now: () => now,
    });
    for (let i = 0; i < 5; i += 1) {
      dispatcher.emit(event());
      await dispatcher.idle();
    }
    expect(runner).toHaveBeenCalledTimes(3);
    const skipped = dispatcher.getRuns().filter((r) => r.status === 'skipped');
    expect(skipped).toHaveLength(2);
    expect(skipped[0]?.note).toContain('Dakika başına');

    now += 61_000;
    dispatcher.emit(event());
    await dispatcher.idle();
    expect(runner).toHaveBeenCalledTimes(4);
  });

  it('genel eşzamanlılık sınırı farklı kancaların toplam süreç sayısını sınırlar', async () => {
    const gate = deferred<HookProcessResult>();
    const runner = vi.fn<HookProcessRunner>(() => gate.promise);
    const hooks = [hook({ id: 'a' }), hook({ id: 'b' }), hook({ id: 'c' })];
    const { dispatcher } = setup(hooks, runner, {
      limits: { maxConcurrentTotal: 2, maxStartsPerMinute: 100 },
    });
    dispatcher.emit(event());
    await vi.waitFor(() =>
      expect(dispatcher.getRuns().some((r) => r.status === 'skipped')).toBe(true)
    );
    expect(runner).toHaveBeenCalledTimes(2);
    gate.resolve(OK);
    await dispatcher.idle();
  });

  it('duraklatılmış, devre dışı, olay/proje süzgeci uymayan kancalar çalışmaz', async () => {
    const runner = vi.fn<HookProcessRunner>(async () => OK);
    const hooks = [
      hook({ id: 'off', enabled: false }),
      hook({ id: 'wrong-event', event: 'task.archived' }),
      hook({ id: 'wrong-project', projectIds: ['baska'] }),
    ];
    const { dispatcher } = setup(hooks, runner);
    dispatcher.emit(event());
    await dispatcher.idle();
    expect(runner).not.toHaveBeenCalled();

    const paused = setup([hook()], runner, { paused: true });
    paused.dispatcher.emit(event());
    await paused.dispatcher.idle();
    expect(runner).not.toHaveBeenCalled();
  });

  it('SSH/uzak projelerde çalıştırmaz', async () => {
    const runner = vi.fn<HookProcessRunner>(async () => OK);
    const { dispatcher, logger } = setup([hook()], runner, { isLocal: false });
    dispatcher.emit(event());
    await dispatcher.idle();
    expect(runner).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });

  it('günlük: kanca başına son 20 kayıt tutulur', async () => {
    let now = 0;
    const { dispatcher } = setup([hook()], async () => OK, {
      now: () => (now += 1),
      limits: { maxConcurrentTotal: 4, maxStartsPerMinute: 1000 },
    });
    for (let i = 0; i < 25; i += 1) {
      dispatcher.emit(event());
      await dispatcher.idle();
    }
    expect(dispatcher.getRuns()).toHaveLength(20);
  });

  it('günlük çıktısı kırpılır, denetim karakterlerinden arındırılır ve maskelenir', async () => {
    const secret = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const { dispatcher } = setup([hook()], async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: `${'z'.repeat(10_000)}\x1b[31mkırmızı\x1b[0m`,
      stderr: `token=${secret} Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789`,
    }));
    dispatcher.emit(event());
    await dispatcher.idle();
    const run = dispatcher.getRuns()[0]!;
    expect(run.status).toBe('failed');
    expect(run.exitCode).toBe(1);
    expect(run.stdoutTail.length).toBeLessThanOrEqual(2000);
    expect(run.stdoutTail).not.toContain('\x1b');
    expect(run.stdoutTail.endsWith('kırmızı')).toBe(true);
    expect(run.stderrTail).not.toContain(secret);
    expect(run.stderrTail).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('pruneRuns ve clearRuns günlüğü temizler', async () => {
    const { dispatcher } = setup([hook({ id: 'a' }), hook({ id: 'b' })]);
    dispatcher.emit(event());
    await dispatcher.idle();
    expect(dispatcher.getRuns()).toHaveLength(2);
    dispatcher.pruneRuns(new Set(['a']));
    expect(dispatcher.getRuns().map((r) => r.hookId)).toEqual(['a']);
    dispatcher.clearRuns();
    expect(dispatcher.getRuns()).toEqual([]);
  });
});
