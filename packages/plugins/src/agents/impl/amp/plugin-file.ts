// Verbatim source of the Amp orkestra hook plugin, embedded as a string constant.
// This file is intentionally kept as plain TypeScript so it can be inlined at runtime
// without a bundler asset pipeline.
export const AMP_PLUGIN_CONTENT = `\
import type { PluginAPI } from '@ampcode/plugin';

async function notifyOrkestra(eventType: 'start' | 'stop' | 'session', body: Record<string, unknown> = {}) {
  const port = process.env.ORKESTRA_HOOK_PORT;
  const token = process.env.ORKESTRA_HOOK_NONCE ?? process.env.ORKESTRA_HOOK_TOKEN;
  const ptyId = process.env.ORKESTRA_PTY_ID;

  if (!port || !token || !ptyId) return;

  try {
    await fetch(\`http://127.0.0.1:\${port}/hook\`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orkestra-Token': token,
        'X-Orkestra-Pty-Id': ptyId,
        'X-Orkestra-Event-Type': eventType,
      },
      body: JSON.stringify(body),
    });
  } catch {
    // Orkestra may not be running when Amp is launched directly; ignore hook failures.
  }
}

export default function (amp: PluginAPI) {
  amp.on('session.start', async (event) => {
    await notifyOrkestra('session', { session_id: event.thread.id });
  });

  amp.on('agent.start', async (event) => {
    await notifyOrkestra('start', { session_id: event.thread.id });
  });

  amp.on('agent.end', async (event) => {
    await notifyOrkestra('stop', { message: 'Task completed', session_id: event.thread.id });
  });
}
`;
