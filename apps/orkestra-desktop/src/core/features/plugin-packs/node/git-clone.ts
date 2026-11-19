import { execFile } from 'node:child_process';

export type CloneFn = (url: string, destination: string) => Promise<void>;

const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'SystemRoot',
  'TMPDIR',
  'TEMP',
  'TMP',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
];

/** Clone için argv dizisi. `--` URL'den önce gelir; `url` önceden doğrulanmış olmalıdır. */
export function buildCloneArgs(url: string, destination: string): string[] {
  return [
    '-c',
    'protocol.allow=never',
    '-c',
    'protocol.https.allow=always',
    '-c',
    'credential.helper=',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'filter.lfs.process=',
    '-c',
    'filter.lfs.smudge=',
    '-c',
    'filter.lfs.clean=',
    '-c',
    'filter.lfs.required=false',
    'clone',
    '--depth',
    '1',
    '--single-branch',
    '--no-tags',
    '--no-recurse-submodules',
    '--template=',
    '--',
    url,
    destination,
  ];
}

/**
 * Sığ, `https`-yalnız git clone. Klonlanan depodan hiçbir script/hook/ikili çalıştırılmaz:
 * şablon hook'ları kapalı, LFS filtreleri boş, alt modüller çekilmez.
 */
export const gitClone: CloneFn = (url, destination) =>
  new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      GIT_TERMINAL_PROMPT: '0',
      GIT_ALLOW_PROTOCOL: 'https',
      GIT_CONFIG_NOSYSTEM: '1',
    };
    for (const key of ENV_ALLOWLIST) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    execFile(
      'git',
      buildCloneArgs(url, destination),
      { env, timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, _stdout, stderr) => {
        if (error) {
          const detail = stderr.trim().split('\n').slice(-2).join(' ');
          reject(new Error(`git clone başarısız: ${detail || error.message}`));
        } else resolve();
      }
    );
  });
