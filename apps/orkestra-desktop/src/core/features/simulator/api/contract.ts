import { resultSchema } from '@orkestra/shared';
import { defineContract, procedure } from '@orkestra/wire/rpc';
import { z } from 'zod';

export const simulatorDomain = 'simulator' as const;

/** simctl'nin kabul ettiği cihaz kimliği (UDID); başka hiçbir değer komuta verilmez. */
export const SIMULATOR_UDID_PATTERN =
  /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

export const simulatorUdidSchema = z.string().regex(SIMULATOR_UDID_PATTERN);

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
  /** Okunabilir çalışma zamanı adı, ör. "iOS 18.2". */
  runtime: z.string(),
  state: simulatorDeviceStateSchema,
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
  /** Tek kare JPEG ekran görüntüsü (base64). */
  screenshot: procedure({
    input: z.object({ udid: z.string() }),
    output: resultSchema(
      z.object({ data: z.string(), mimeType: z.literal('image/jpeg') }),
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
});
