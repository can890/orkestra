export const ACCOUNT_CONFIG = {
  authServer: {
    baseUrl: process.env.ORKESTRA_AUTH_SERVER_URL ?? '',
    authTimeoutMs: Number(process.env.ORKESTRA_AUTH_TIMEOUT_MS || 300000),
  },
};
