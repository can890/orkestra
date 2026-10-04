export interface FeedbackAttachment {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

export async function submitFeedbackToRelay(_args: {
  content: string;
  files: FeedbackAttachment[];
}): Promise<void> {
  throw new Error('Bu Orkestra sürümünde geri bildirim gönderimi kaldırılmıştır.');
}
