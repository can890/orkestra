import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readReplayedUserText,
  wrapAttachmentContext,
} from '#runtimes/acp/api/models/replayed-user-attachments';
import { restoreAntigravityReplayAttachments } from '#runtimes/acp/api/replay-node';

const SESSION = '14ba23e2-b3db-4308-8d4b-55c72e66baf0';
const ANOTHER_SESSION = 'ce5350b4-9daa-4181-a5c2-35c3ddf7224b';
const IMAGE = '20cd6333-a693-485d-aaec-1aebc9328db6.png';
const LINK = '6e56bf0d-9269-4c77-b914-4d851a24de66.png';
const CONTENT =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS3sAAAAASUVORK5CYII=';
const notice = (path: string) =>
  `[Kullanıcı görsel ekledi: ${path} (MIME: image/png). Görseli incelemek için read_file aracını bu tam dosya yoluyla kullan.]`;

describe('Antigravity attachment replay', () => {
  let directory: string;
  let image: string;
  let otherImage: string;
  let link: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'agy-replay-attachments-'));
    image = join(directory, 'attachments', SESSION, IMAGE);
    otherImage = join(directory, 'attachments', ANOTHER_SESSION, IMAGE);
    link = join(directory, 'attachments', SESSION, LINK);
    for (const id of [SESSION, ANOTHER_SESSION]) {
      await mkdir(join(directory, 'attachments', id), { recursive: true });
    }
    await writeFile(image, CONTENT, 'base64');
    await writeFile(otherImage, CONTENT, 'base64');
  });

  afterEach(async () => rm(directory, { recursive: true, force: true }));

  it('restores a legacy screenshot and keeps the original prompt text', async () => {
    const recovered = await restoreAntigravityReplayAttachments(
      `${notice(image)}\n\nBu görsele bak`,
      directory,
      SESSION
    );
    expect(recovered).toEqual({
      text: 'Bu görsele bak',
      attachments: [
        expect.objectContaining({
          name: IMAGE,
          mimeType: 'image/png',
          dataUrl: `data:image/png;base64,${CONTENT}`,
        }),
      ],
    });
  });

  it('keeps the canonical upload reference instead of duplicating the bridge image', async () => {
    const ref = {
      id: '11d0e61b-0962-4ebb-8802-7a71327750b7',
      name: 'Screen.png',
      mimeType: 'image/png',
    };
    const recovered = await restoreAntigravityReplayAttachments(
      `${notice(image)}\n${wrapAttachmentContext([ref])}`,
      directory,
      SESSION
    );
    expect(recovered).toEqual({ text: '', attachments: [ref] });
  });

  it('never reads a different session or a symlink in the current session', async () => {
    if (process.platform !== 'win32') await symlink(otherImage, link);
    const recovered = await restoreAntigravityReplayAttachments(
      `${notice(otherImage)}\n${notice(link)}\nOriginal prompt`,
      directory,
      SESSION
    );
    expect(recovered).toEqual({ text: 'Original prompt', attachments: [] });
  });

  it('restores the old shared file reference without showing its host path', () => {
    const id = '11d0e61b-0962-4ebb-8802-7a71327750b7';
    const file = {
      name: 'Runbook.pdf',
      mimeType: 'application/pdf',
      path: `/host/acp-attachments/conversations/conversation-id/${id}/content.pdf`,
    };
    const prompt = `Kullanıcının eklediği dosya bu çalışma sunucusuna yüklendi. Dosya bilgileri: ${JSON.stringify(file)}. Dosyayı uygun araçlarla inceleyin; desteklemediğiniz bir içeriği görmüş gibi yanıtlamayın.\nBelgeyi özetle`;
    expect(readReplayedUserText(prompt)).toEqual({
      text: 'Belgeyi özetle',
      attachments: [{ id, name: file.name, mimeType: file.mimeType }],
    });
  });
});
