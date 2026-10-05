/** Ajanların ACP oturumunda gördüğü MCP sunucu adı. */
export const BROWSER_MCP_SERVER_NAME = 'orkestra-browser';

/** Paylaşılan RPC sunucusunda tarayıcı araçlarının kimliği (`ORKESTRA_TOOLS_SERVER`). */
export const BROWSER_TOOLS_SERVER_ID = 'browser';

/** Sunucunun MCP `instructions` metni; ajanın sistem bağlamına eklenir. */
export const BROWSER_TOOLS_INSTRUCTIONS = [
  'Orkestra in-app browser. Tabs you open appear in the browser panel next to this conversation, where the user can watch them; they stay open while the user switches between tasks, until they are closed.',
  '- Tools act on your current tab: the tab you last opened, selected or used. Pass tab (an id from tabs) to target another tab of this task.',
  '- Read pages with snapshot and act on its element refs (click, type, select_option). Refs expire when the page changes, so take a new snapshot after navigating or after the page updates. Use screenshot for visual checks.',
  '- Keep the panel tidy: reuse your tab with navigate and close tabs you no longer need.',
  '- Never enter passwords, tokens or other secrets or credentials unless the user explicitly provides them to you for this purpose.',
  '- Dev servers running on the workspace host are reachable at http://localhost:PORT. On remote workspaces Orkestra forwards the port over SSH automatically and reports the local address it opened.',
].join('\n');

const tab = {
  type: 'string',
  description: 'Tab id from tabs. Defaults to your current tab.',
} as const;

const ref = {
  type: 'string',
  description: 'Element ref from the latest snapshot, e.g. "e12".',
} as const;

const coordinate = (axis: 'x' | 'y') =>
  ({
    type: 'number',
    minimum: 0,
    description: `Viewport ${axis} coordinate in CSS pixels; use only when no ref fits.`,
  }) as const;

/** Tarayıcı araçlarının JSON Schema tanımları ve MCP açıklama ipuçları. */
export const BROWSER_TOOLS = [
  {
    name: 'tabs',
    description:
      "List the browser tabs open in this task with their ids, titles and URLs, marking your current tab (the default target of the other tools) and the tab shown in the task's browser panel.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'List browser tabs', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'open_tab',
    description:
      "Open a new tab in Orkestra's in-app browser (the panel next to this conversation, visible to the user) and make it your current tab. With url, waits for the page to load and returns its title and a snapshot excerpt with element refs. Dev servers on the workspace host are reachable at http://localhost:PORT; on remote workspaces Orkestra forwards the port automatically. Reuse your current tab with navigate instead of opening a tab for every page.",
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'Page to load, e.g. http://localhost:3000 or https://example.com. Omit to open a blank tab.',
        },
        activate: {
          type: 'boolean',
          description: "Show the new tab in the task's browser panel (default true).",
        },
      },
      additionalProperties: false,
    },
    annotations: {
      title: 'Open browser tab',
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'select_tab',
    description: 'Make an open tab of this task your current tab and show it in the browser panel.',
    inputSchema: {
      type: 'object',
      properties: { tab: { type: 'string', description: 'Tab id from tabs.' } },
      required: ['tab'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Select browser tab',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'close_tab',
    description:
      "Close a tab of this task. Close tabs you no longer need so the user's browser panel stays tidy.",
    inputSchema: {
      type: 'object',
      properties: { tab: { type: 'string', description: 'Tab id from tabs.' } },
      required: ['tab'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Close browser tab',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'navigate',
    description:
      'Load a URL in a tab, or go back, forward or reload with action. Waits for the page to load and returns the new URL, title and a snapshot excerpt with element refs. Loopback URLs (http://localhost:PORT) reach the workspace host; on remote workspaces Orkestra forwards the port automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Page to load, e.g. http://localhost:5173/settings. Omit when using action.',
        },
        action: {
          type: 'string',
          enum: ['back', 'forward', 'reload'],
          description: 'History navigation instead of a URL.',
        },
        tab,
      },
      additionalProperties: false,
    },
    annotations: {
      title: 'Navigate browser tab',
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'snapshot',
    description:
      'Capture an outline of the page (accessibility tree with visible text) in which interactive elements carry refs such as [ref=e12]. Pass the refs to click, type, hover, select_option and scroll. Refs belong to the latest snapshot only, so take a new one after the page changes. Prefer this over screenshot for reading pages and finding elements.',
    inputSchema: {
      type: 'object',
      properties: {
        maxChars: {
          type: 'integer',
          minimum: 500,
          maximum: 200000,
          description: 'Maximum outline length in characters (default 40000).',
        },
        tab,
      },
      additionalProperties: false,
    },
    annotations: { title: 'Snapshot page', readOnlyHint: true },
  },
  {
    name: 'click',
    description:
      'Click an element by ref from the latest snapshot, or at x/y viewport coordinates when no ref fits (for example on a canvas). Uses real (trusted) mouse events and returns the page URL and title afterwards; take a new snapshot to see the result.',
    inputSchema: {
      type: 'object',
      properties: {
        ref,
        x: coordinate('x'),
        y: coordinate('y'),
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: 'Mouse button (default left).',
        },
        double: { type: 'boolean', description: 'Double-click instead of a single click.' },
        modifiers: {
          type: 'array',
          items: { type: 'string', enum: ['shift', 'control', 'alt', 'meta'] },
          description: 'Modifier keys held during the click.',
        },
        tab,
      },
      additionalProperties: false,
    },
    annotations: { title: 'Click', readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'hover',
    description:
      'Move the mouse over an element by ref, or to x/y viewport coordinates, for example to open a menu or show a tooltip.',
    inputSchema: {
      type: 'object',
      properties: { ref, x: coordinate('x'), y: coordinate('y'), tab },
      additionalProperties: false,
    },
    annotations: { title: 'Hover', readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'type',
    description:
      'Type text into an element by ref, or into the focused element when ref is omitted, using real key events. clear replaces the current value first; submit presses Enter afterwards. Never type passwords, tokens or other secrets unless the user explicitly provided them for this purpose.',
    inputSchema: {
      type: 'object',
      properties: {
        ref,
        text: { type: 'string', description: 'Text to type.' },
        clear: { type: 'boolean', description: 'Clear the current value before typing.' },
        submit: { type: 'boolean', description: 'Press Enter after typing.' },
        tab,
      },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: { title: 'Type text', readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'press_key',
    description:
      'Press a key or key combination in the page, e.g. Enter, Tab, Escape, ArrowDown, Backspace, Control+A or Meta+L.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name or combination joined with +.' },
        tab,
      },
      required: ['key'],
      additionalProperties: false,
    },
    annotations: { title: 'Press key', readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'scroll',
    description:
      'Scroll the page, or the scrollable element given by ref, in a direction (default down) by amount pixels (default about one screen).',
    inputSchema: {
      type: 'object',
      properties: {
        ref,
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'number', minimum: 1, description: 'Distance in CSS pixels.' },
        tab,
      },
      additionalProperties: false,
    },
    annotations: { title: 'Scroll', readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'select_option',
    description:
      'Select one or more options of a <select> element given by ref, by option value or visible label. Returns the selected values.',
    inputSchema: {
      type: 'object',
      properties: {
        ref,
        values: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Option values or labels to select.',
        },
        tab,
      },
      required: ['ref', 'values'],
      additionalProperties: false,
    },
    annotations: { title: 'Select option', readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'wait_for',
    description:
      'Wait until text appears on the page, until text disappears, or for a fixed number of seconds. Reports whether the condition was met before timeoutSeconds (default 30, maximum 120).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Wait until this text is visible.' },
        textGone: { type: 'string', description: 'Wait until this text is no longer visible.' },
        seconds: {
          type: 'number',
          minimum: 0,
          maximum: 60,
          description: 'Fixed time to wait.',
        },
        timeoutSeconds: { type: 'number', minimum: 1, maximum: 120 },
        tab,
      },
      additionalProperties: false,
    },
    annotations: { title: 'Wait for page', readOnlyHint: true },
  },
  {
    name: 'screenshot',
    description:
      "Take a PNG screenshot of the tab's visible area, or of the whole page with fullPage. Use it for visual checks such as layout, styling, images or charts; use snapshot to read content and find refs.",
    inputSchema: {
      type: 'object',
      properties: {
        fullPage: { type: 'boolean', description: 'Capture the whole scrollable page.' },
        tab,
      },
      additionalProperties: false,
    },
    annotations: { title: 'Screenshot', readOnlyHint: true },
  },
  {
    name: 'get_text',
    description:
      'Return the visible text of the page without markup or refs (default up to 20000 characters).',
    inputSchema: {
      type: 'object',
      properties: {
        maxChars: { type: 'integer', minimum: 500, maximum: 200000 },
        tab,
      },
      additionalProperties: false,
    },
    annotations: { title: 'Get page text', readOnlyHint: true },
  },
  {
    name: 'console',
    description:
      "Return the page's recent console messages (errors, warnings and logs, oldest first). clear empties the buffer afterwards so the next call shows only new messages.",
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          description: 'Maximum number of messages (default 50, newest kept).',
        },
        clear: { type: 'boolean', description: 'Empty the buffer after reading.' },
        tab,
      },
      additionalProperties: false,
    },
    annotations: { title: 'Read console', readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'evaluate',
    description:
      'Evaluate a JavaScript expression in the page and return its JSON-serializable result; a returned promise is awaited. Use it to read state that snapshot does not show; prefer the dedicated tools for interacting with the page.',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JavaScript expression to evaluate.' },
        tab,
      },
      required: ['expression'],
      additionalProperties: false,
    },
    annotations: { title: 'Evaluate JavaScript', readOnlyHint: false, destructiveHint: true },
  },
] as const;

export type BrowserToolName = (typeof BROWSER_TOOLS)[number]['name'];
