import { resultSchema } from '@orkestra/shared';
import { defineContract, procedure } from '@orkestra/wire/rpc';
import { z } from 'zod';

export const simulatorDomain = 'simulator' as const;

/** simctl'nin kabul ettiği cihaz kimliği (UDID) veya Android cihaz/AVD kimliği. */
export const SIMULATOR_UDID_PATTERN =
  /^(?:[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}|android:[A-Za-z0-9._:-]{1,128}|android-avd:[A-Za-z0-9._-]{1,128})$/i;

export const simulatorUdidSchema = z.string().regex(SIMULATOR_UDID_PATTERN);

export const simulatorPlatformSchema = z.enum(['ios', 'android']);
export type SimulatorPlatform = z.infer<typeof simulatorPlatformSchema>;

export const simulatorKeyEventSchema = z.enum([
  'home',
  'back',
  'enter',
  'menu',
  'recents',
  'power',
  'volume_up',
  'volume_down',
]);
export type SimulatorKeyEvent = z.infer<typeof simulatorKeyEventSchema>;

export const simulatorDeviceStateSchema = z.enum([
  'booted',
  'shutdown',
  'booting',
  'shutting-down',
  'unknown',
]);
export type SimulatorDeviceState = z.infer<typeof simulatorDeviceStateSchema>;

export const simulatorDeviceSchema = z.object({
  udid: simulatorUdidSchema,
  name: z.string(),
  /** Okunabilir çalışma zamanı adı, ör. "iOS 18.2" veya "Android 15". */
  runtime: z.string(),
  state: simulatorDeviceStateSchema,
  platform: simulatorPlatformSchema.optional(),
});
export type SimulatorDevice = z.infer<typeof simulatorDeviceSchema>;

export const simulatorErrorSchema = z.object({
  type: z.enum(['unsupported', 'invalid_input', 'simctl_failed']),
  message: z.string(),
});
export type SimulatorError = z.infer<typeof simulatorErrorSchema>;

const okVoid = resultSchema(z.void(), simulatorErrorSchema);

export const simulatorContract = defineContract({
  /** Simülatör yalnızca macOS'ta çalışır; başka sistemlerde sekme hiç gösterilmez. */
  availability: procedure({
    input: z.void(),
    output: z.object({ supported: z.boolean() }),
  }),
  listDevices: procedure({
    input: z.void(),
    output: resultSchema(z.array(simulatorDeviceSchema), simulatorErrorSchema),
  }),
  bootDevice: procedure({ input: z.object({ udid: z.string() }), output: okVoid }),
  shutdownDevice: procedure({ input: z.object({ udid: z.string() }), output: okVoid }),
  /** Tek kare JPEG/PNG ekran görüntüsü (base64). */
  screenshot: procedure({
    input: z.object({ udid: z.string() }),
    output: resultSchema(
      z.object({ data: z.string(), mimeType: z.enum(['image/jpeg', 'image/png']) }),
      simulatorErrorSchema
    ),
  }),
  openUrl: procedure({ input: z.object({ udid: z.string(), url: z.string() }), output: okVoid }),
  installApp: procedure({
    input: z.object({ udid: z.string(), appPath: z.string() }),
    output: okVoid,
  }),
  launchApp: procedure({
    input: z.object({ udid: z.string(), bundleId: z.string() }),
    output: okVoid,
  }),
  setAppearance: procedure({
    input: z.object({ udid: z.string(), appearance: z.enum(['light', 'dark']) }),
    output: okVoid,
  }),
  tap: procedure({
    input: z.object({ udid: z.string(), x: z.number(), y: z.number() }),
    output: okVoid,
  }),
  swipe: procedure({
    input: z.object({
      udid: z.string(),
      x1: z.number(),
      y1: z.number(),
      x2: z.number(),
      y2: z.number(),
      durationMs: z.number().optional(),
    }),
    output: okVoid,
  }),
  inputText: procedure({
    input: z.object({ udid: z.string(), text: z.string() }),
    output: okVoid,
  }),
  keyEvent: procedure({
    input: z.object({ udid: z.string(), key: simulatorKeyEventSchema }),
    output: okVoid,
  }),
});
