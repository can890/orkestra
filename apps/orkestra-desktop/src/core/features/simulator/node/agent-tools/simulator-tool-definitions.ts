/** Ajanların ACP oturumunda gördüğü MCP sunucu adı. */
export const SIMULATOR_MCP_SERVER_NAME = 'orkestra-simulator';

/** Paylaşılan RPC sunucusunda simülatör araçlarının kimliği (`ORKESTRA_TOOLS_SERVER`). */
export const SIMULATOR_TOOLS_SERVER_ID = 'simulator';

export const SIMULATOR_TOOLS_INSTRUCTIONS = [
  "Orkestra Mobile Device & Simulator tools. They drive the user's local iOS Simulators (simctl) and Android Emulators/devices (adb).",
  '- Call list_devices first to see device IDs (iOS UDIDs or android:<serial> / android-avd:<name>) and states. Tools that take udid default to the only booted device when you omit it.',
  '- A device must be booted before screenshot, open_url, launch_app, install_app, tap, swipe, input_text and key_event work.',
  '- screenshot returns the current screen as an image. For Android devices, you can send tap(x, y), swipe(x1, y1, x2, y2), input_text(text) and key_event(home|back|enter|recents|menu|power|volume_up|volume_down). For iOS simctl devices, navigate via open_url and launch_app.',
  '- install_app takes an absolute .app bundle path (iOS) or .apk file path (Android); launch_app takes the bundle/package identifier.',
  '- Never open URLs or install apps the user did not ask for.',
].join('\n');

const udid = {
  type: 'string',
  description:
    'Device UDID from list_devices. Defaults to the only booted device; required when none or several are booted.',
} as const;

/** Simülatör araçlarının JSON Schema tanımları ve MCP açıklama ipuçları. */
export const SIMULATOR_TOOLS = [
  {
    name: 'list_devices',
    description:
      'List the available iOS simulators with their UDID, name, runtime and state (booted or shutdown).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'List iOS simulators', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'screenshot',
    description: 'Capture the current screen of a booted simulator as a JPEG image.',
    inputSchema: {
      type: 'object',
      properties: { udid },
      additionalProperties: false,
    },
    annotations: { title: 'Simulator screenshot', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'open_url',
    description:
      'Open a URL or deep link in the simulator (https:// pages open in Safari; custom schemes open the matching app). javascript:, data: and file: URLs are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        udid,
        url: {
          type: 'string',
          description: 'URL with a scheme, e.g. https://example.com or myapp://home.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    annotations: { title: 'Open URL in simulator', readOnlyHint: false, openWorldHint: true },
  },
  {
    name: 'install_app',
    description:
      'Install a built .app bundle on a booted simulator. The path must be absolute and point to a directory ending in .app that contains an Info.plist.',
    inputSchema: {
      type: 'object',
      properties: {
        udid,
        app_path: { type: 'string', description: 'Absolute path of the .app bundle.' },
      },
      required: ['app_path'],
      additionalProperties: false,
    },
    annotations: { title: 'Install app', readOnlyHint: false, openWorldHint: false },
  },
  {
    name: 'launch_app',
    description: 'Launch an installed app on a booted simulator/emulator by its bundle or package identifier.',
    inputSchema: {
      type: 'object',
      properties: {
        udid,
        bundle_id: { type: 'string', description: 'Bundle or package identifier, e.g. com.example.MyApp.' },
      },
      required: ['bundle_id'],
      additionalProperties: false,
    },
    annotations: { title: 'Launch app', readOnlyHint: false, openWorldHint: false },
  },
  {
    name: 'tap',
    description: 'Tap a point (x, y) in device pixel coordinates on a booted Android emulator/device.',
    inputSchema: {
      type: 'object',
      properties: {
        udid,
        x: { type: 'number', description: 'Horizontal coordinate in pixels.' },
        y: { type: 'number', description: 'Vertical coordinate in pixels.' },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    annotations: { title: 'Tap device screen', readOnlyHint: false, openWorldHint: false },
  },
  {
    name: 'swipe',
    description: 'Swipe from (x1, y1) to (x2, y2) on a booted Android emulator/device.',
    inputSchema: {
      type: 'object',
      properties: {
        udid,
        x1: { type: 'number' },
        y1: { type: 'number' },
        x2: { type: 'number' },
        y2: { type: 'number' },
        duration_ms: { type: 'number', description: 'Optional swipe duration in ms (default 260).' },
      },
      required: ['x1', 'y1', 'x2', 'y2'],
      additionalProperties: false,
    },
    annotations: { title: 'Swipe device screen', readOnlyHint: false, openWorldHint: false },
  },
  {
    name: 'input_text',
    description: 'Type text into the focused input field on a booted Android emulator/device.',
    inputSchema: {
      type: 'object',
      properties: {
        udid,
        text: { type: 'string', description: 'Literal text to type.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: { title: 'Type text on device', readOnlyHint: false, openWorldHint: false },
  },
  {
    name: 'key_event',
    description: 'Send a hardware/navigation key event to a booted Android emulator/device.',
    inputSchema: {
      type: 'object',
      properties: {
        udid,
        key: {
          type: 'string',
          enum: ['home', 'back', 'enter', 'menu', 'recents', 'power', 'volume_up', 'volume_down'],
        },
      },
      required: ['key'],
      additionalProperties: false,
    },
    annotations: { title: 'Send key event', readOnlyHint: false, openWorldHint: false },
  },
] as const;
