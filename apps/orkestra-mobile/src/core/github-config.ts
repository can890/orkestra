/**
 * GitHub OAuth uygulamasının istemci kimliği; derleme zamanında `VITE_ORKESTRA_GITHUB_CLIENT_ID`
 * ile verilir. Kaynak kodda sabit bir kimlik yoktur. Boşsa GitHub ile giriş kapalıdır.
 * Tek okuma noktası burasıdır; testler `githubClientId` yerine kimliği doğrudan enjekte eder.
 */
export function githubClientId(): string {
  const value: unknown = import.meta.env.VITE_ORKESTRA_GITHUB_CLIENT_ID;
  return typeof value === 'string' ? value.trim() : '';
}
