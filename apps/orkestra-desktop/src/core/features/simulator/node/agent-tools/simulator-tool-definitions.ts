/** Ajanların ACP oturumunda gördüğü MCP sunucu adı. */
export const SIMULATOR_MCP_SERVER_NAME = 'orkestra-simulator';

/** Paylaşılan RPC sunucusunda simülatör araçlarının kimliği (`ORKESTRA_TOOLS_SERVER`). */
export const SIMULATOR_TOOLS_SERVER_ID = 'simulator';

export const SIMULATOR_TOOLS_INSTRUCTIONS = [
  "Orkestra iOS Simulator tools. They drive the user's local Xcode simulators through simctl.",
  '- Call list_devices first to see device UDIDs and states. Tools that take udid default to the only booted device when you omit it.',
  '- A device must be booted (the user boots it in the simulator panel) before screenshot, open_url, launch_app and install_app work.',
  '- screenshot returns the current screen as an image. There is no tap, swipe or keyboard input: simctl cannot send touches. Navigate by opening URLs or deep links with open_url and by launching apps.',
  '- install_app takes the absolute path of a built .app bundle (for example from Xcode DerivedData); launch_app takes the bundle identifier.',
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
    description: 'Launch an installed app on a booted simulator by its bundle identifier.',
    inputSchema: {
      type: 'object',
      properties: {
        udid,
        bundle_id: { type: 'string', description: 'Bundle identifier, e.g. com.example.MyApp.' },
      },
      required: ['bundle_id'],
      additionalProperties: false,
    },
    annotations: { title: 'Launch app', readOnlyHint: false, openWorldHint: false },
  },
] as const;
