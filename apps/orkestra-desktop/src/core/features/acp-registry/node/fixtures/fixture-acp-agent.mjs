#!/usr/bin/env node
// Testler için küçük, deterministik bir ACP ajanı (stdio). Ağ kullanmaz; yerel ACP komutu
// entegrasyon testinde "kullanıcının eklediği ajan" olarak çalıştırılır.
import { Readable, Writable } from 'node:stream';
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
let counter = 0;

function modelOptions(currentValue) {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue,
      options: [
        { value: 'fixture-small', name: 'Fixture Small' },
        { value: 'fixture-large', name: 'Fixture Large' },
      ],
    },
  ];
}

new AgentSideConnection(
  (connection) => ({
    async initialize() {
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'fixture-agent', title: 'Fixture Agent', version: '0.0.1' },
        agentCapabilities: { loadSession: false, mcpCapabilities: { http: false, sse: false } },
        authMethods: [
          { id: 'fixture-login', name: 'Fixture login', type: 'terminal', args: ['login'] },
          {
            id: 'fixture-key',
            name: 'Fixture API key',
            type: 'env_var',
            vars: [{ name: 'FIXTURE_API_KEY', label: 'Fixture key' }],
          },
        ],
      };
    },
    async newSession() {
      counter += 1;
      return {
        sessionId: `fixture-session-${counter}`,
        modes: {
          currentModeId: 'default',
          availableModes: [
            { id: 'default', name: 'Default' },
            { id: 'plan', name: 'Plan' },
          ],
        },
        configOptions: modelOptions('fixture-small'),
      };
    },
    async authenticate() {
      return {};
    },
    async setSessionMode() {
      return {};
    },
    async setSessionConfigOption(params) {
      return { configOptions: modelOptions(String(params.value)) };
    },
    async prompt(params) {
      const text = params.prompt
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join(' ');
      const key = process.env.FIXTURE_API_KEY ? 'key-set' : 'key-missing';
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `fixture-agent echo: ${text} (${key}, cwd=${process.cwd()})`,
          },
        },
      });
      return { stopReason: 'end_turn' };
    },
    async cancel() {},
  }),
  stream
);
