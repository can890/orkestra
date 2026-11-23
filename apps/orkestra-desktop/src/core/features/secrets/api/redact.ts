const REDACTED_TAG = '[GİZLENDİ]';

const PEM_BLOCK_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

const TOKEN_PATTERNS: readonly RegExp[] = [
  // Anthropic / OpenAI anahtarları
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-proj-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  // GitHub belirteçleri
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  // AWS erişim anahtarları
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Slack belirteçleri
  /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g,
  // Google API anahtarları
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  // 1Password secret referansları
  /\bop:\/\/[A-Za-z0-9._-]+\/[A-Za-z0-9 ._%/-]+\b/g,
  // JWT tokenlar (3 bölümlü Base64URL)
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

const BEARER_HEADER_RE = /(\bAuthorization\s*:\s*Bearer\s+)([A-Za-z0-9._~+/-]{12,}=*)/gi;

const ENV_ASSIGNMENT_RE =
  /(\b[A-Z][A-Z0-9_]*(?:API_KEY|SECRET_KEY|ACCESS_TOKEN|AUTH_TOKEN|PRIVATE_KEY|SECRET|PASSWORD|TOKEN)\s*[=:]\s*)(["']?)([^\s"'`\n]{8,})\2/gi;

export function redactSensitiveText(input: string): string {
  if (!input) return input;
  let output = input.replace(PEM_BLOCK_RE, REDACTED_TAG);
  for (const pattern of TOKEN_PATTERNS) {
    output = output.replace(pattern, REDACTED_TAG);
  }
  output = output.replace(BEARER_HEADER_RE, `$1${REDACTED_TAG}`);
  output = output.replace(ENV_ASSIGNMENT_RE, (_full, prefix: string, quote: string, val: string) => {
    if (val === REDACTED_TAG) return `${prefix}${quote}${val}${quote}`;
    return `${prefix}${quote}${REDACTED_TAG}${quote}`;
  });
  return output;
}

export function containsSensitiveSecret(input: string): boolean {
  if (!input) return false;
  return redactSensitiveText(input) !== input;
}
