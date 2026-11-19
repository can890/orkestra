// `@orkestra/wire/remote`: tarayıcıda ve Node'da çalışan istemci tarafı + ortak protokol.
// Sunucu tarafı için `@orkestra/wire/remote/node`.
export { base64UrlDecode, base64UrlEncode, randomBytes } from './bytes';
export {
  connectRemoteTransport,
  RemoteHandshakeError,
  webSocketAdapter,
  type RemoteClientOptions,
  type RemoteClientTransport,
  type RemoteHandshakeErrorCode,
} from './client';
export { createMemorySocketPair, type MemorySocketPair } from './memory-socket';
export {
  createFrameOpener,
  createFrameSealer,
  deriveChannelKeys,
  RemoteFrameError,
  RemoteFrameTooLargeError,
  type FrameOpener,
  type FrameSealer,
  type RemoteChannelKeys,
  type RemoteRole,
} from './crypto';
export {
  createSecureTransport,
  type SecureTransport,
  type SecureTransportOptions,
} from './channel';
export {
  isRemoteDeviceId,
  REMOTE_CLOSE,
  REMOTE_MAX_FRAME_BYTES,
  REMOTE_NONCE_BYTES,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_SECRET_BYTES,
  REMOTE_WS_PATH,
  remoteWebSocketUrl,
  type RemoteAuthPayload,
  type RemoteChallenge,
  type RemoteCloseCode,
  type RemoteEnvelope,
  type RemoteErrorCode,
  type RemoteErrorFrame,
  type RemoteHello,
  type RemoteSocket,
  type RemoteSocketData,
  type RemoteWelcomePayload,
} from './protocol';
