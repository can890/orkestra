type ImportMetaWithEnv = ImportMeta & { env?: { DEV?: boolean; VITE_BUILD?: string } };

const env = (import.meta as ImportMetaWithEnv).env;
const isDev = env?.DEV === true;
const isCanary = env?.VITE_BUILD === 'canary';

export const APP_ID = isCanary ? 'com.orkestra.canary' : 'com.orkestra.stable';
export const PRODUCT_NAME = isCanary ? 'Orkestra Canary' : 'Orkestra';
export const APP_NAME_LOWER = isCanary ? 'orkestra-canary' : 'orkestra';
export const LINUX_DESKTOP_ID = isCanary ? 'orkestra-canary' : 'Orkestra';
export const USER_DATA_DIR_NAME = isDev
  ? 'orkestra-dev'
  : isCanary
    ? 'orkestra-canary'
    : 'orkestra';
export const UPDATE_CHANNEL = isCanary ? 'v1-canary' : 'v1-stable';
export const ARTIFACT_PREFIX = isCanary ? 'orkestra-canary' : 'orkestra';
export const R2_BASE_URL = 'https://releases.invalid.local';
export const IS_CANARY = isCanary;
/** Derin bağlantı şeması; canary kurulumu ayrı şema kullanır ki iki kurulum birbirinin bağlantısını çalmasın. */
export const DEEP_LINK_SCHEME = APP_NAME_LOWER;
