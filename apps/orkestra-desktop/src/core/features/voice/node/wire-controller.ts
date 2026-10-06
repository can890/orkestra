import { ok } from '@orkestra/shared';
import { createController, type Controller } from '@orkestra/wire/rpc';
import { voiceContract } from '@core/features/voice/api/contract';
import type { VoiceService } from './voice-service';

// Ses alanının Wire denetleyicisi; tüm işi VoiceService'e devreder.

export type VoiceOperations = Pick<
  VoiceService,
  | 'getStatus'
  | 'setApiKey'
  | 'clearApiKey'
  | 'setPreferences'
  | 'listVoices'
  | 'testConnection'
  | 'transcribe'
  | 'synthesize'
  | 'getMicrophoneAccess'
  | 'requestMicrophoneAccess'
  | 'openMicrophoneSettings'
>;

export function createVoiceWireController(voice: VoiceOperations): Controller {
  return createController(voiceContract, {
    getStatus: () => voice.getStatus(),
    setApiKey: ({ apiKey }) => voice.setApiKey(apiKey),
    clearApiKey: () => voice.clearApiKey(),
    setPreferences: (patch) => voice.setPreferences(patch),
    listVoices: (_input, meta) => voice.listVoices(meta.signal),
    testConnection: (_input, meta) => voice.testConnection(meta.signal),
    transcribe: async ({ language }, file, meta) => {
      const audio = new Blob([new Uint8Array(await file.bytes())], { type: file.mimeType });
      return voice.transcribe(
        { audio, fileName: file.name || 'dikte.webm', mimeType: file.mimeType, language },
        meta.signal
      );
    },
    synthesize: async ({ text, voiceId }, meta) => {
      const result = await voice.synthesize({ text, voiceId }, meta.signal);
      if (!result.success) return result;
      const { bytes, mimeType } = result.data;
      return ok({
        meta: { name: 'yanit.mp3', mimeType, size: bytes.byteLength },
        source: singleChunk(bytes),
      });
    },
    getMicrophoneAccess: () => voice.getMicrophoneAccess(),
    requestMicrophoneAccess: () => voice.requestMicrophoneAccess(),
    openMicrophoneSettings: () => voice.openMicrophoneSettings(),
  });
}

async function* singleChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}
