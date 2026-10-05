import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { transcriptTurnSchema } from '../models/turns/turn';
import { extractArtifacts } from './artifact-content';
import { AcpTranscriptParser } from './parser';

describe('generated output continuity', () => {
  it('keeps native images in assistant messages through commit, schema validation and replay', () => {
    const update: SessionUpdate = {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'image', data: 'Y2F0', mimeType: 'image/png' },
    };
    const parser = new AcpTranscriptParser({ conversationId: 'cat' });
    parser.push(update);
    parser.endTurn();
    const turn = transcriptTurnSchema.parse(parser.history[0]);
    expect(turn.items[0]).toMatchObject({
      kind: 'message',
      artifacts: [{ uri: 'data:image/png;base64,Y2F0', mimeType: 'image/png' }],
    });
    const replay = AcpTranscriptParser.replay([update], { conversationId: 'cat' });
    expect(replay.committed[0].items[0]).toMatchObject({
      artifacts: [{ uri: 'data:image/png;base64,Y2F0' }],
    });
  });

  it('preserves tool output when later status updates reclassify the tool', () => {
    const parser = new AcpTranscriptParser({ conversationId: 'cat' });
    parser.push({
      sessionUpdate: 'tool_call',
      toolCallId: 'generate',
      title: 'imagegen',
      kind: 'other',
      status: 'in_progress',
    });
    parser.push({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'generate',
      content: [
        { type: 'content', content: { type: 'image', data: 'Y2F0', mimeType: 'image/png' } },
      ],
    });
    parser.push({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'generate',
      kind: 'execute',
      status: 'completed',
    });
    parser.endTurn();
    const turn = transcriptTurnSchema.parse(parser.history[0]);
    expect(turn.items[0]).toMatchObject({ artifacts: [{ uri: 'data:image/png;base64,Y2F0' }] });
  });

  it('collects resource links and generatedImage outputs without duplicating them', () => {
    expect(
      extractArtifacts({
        content: [
          {
            type: 'resource_link',
            uri: '/tmp/report.pdf',
            name: 'Report',
            mimeType: 'application/pdf',
          },
          { image_url: 'data:image/png;base64,Y2F0' },
          { image_url: 'data:image/png;base64,Y2F0' },
        ],
      })
    ).toEqual([
      { uri: '/tmp/report.pdf', name: 'Report', mimeType: 'application/pdf' },
      { uri: 'data:image/png;base64,Y2F0', name: 'Generated media' },
    ]);
  });
});
