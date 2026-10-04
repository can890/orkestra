import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { ResolvedPromptAttachment } from './cell-deps';

export function attachmentContent(
  attachment: ResolvedPromptAttachment,
  supportsImages: boolean
): ContentBlock {
  if (
    supportsImages &&
    ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(attachment.mimeType)
  ) {
    return { type: 'image', data: attachment.data, mimeType: attachment.mimeType };
  }
  if (!attachment.targetPath)
    throw new Error('Ek dosyanın sunucudaki yolu bulunamadı. Dosyayı yeniden ekleyin.');
  return {
    type: 'text',
    text: `Kullanıcının eklediği dosya bu çalışma sunucusuna yüklendi. Dosya bilgileri: ${JSON.stringify({ name: attachment.name, mimeType: attachment.mimeType, path: attachment.targetPath })}. Dosyayı uygun araçlarla inceleyin; desteklemediğiniz bir içeriği görmüş gibi yanıtlamayın.`,
  };
}
