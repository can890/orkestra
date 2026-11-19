/**
 * "Kaldığı yerden devam et": devirle açılan boş sohbette tek tıkla standart bir mesaj gönderir.
 * Mesaj yalnızca kullanıcının tıklamasıyla gider; devir özeti her zamanki gibi (ilk istemde)
 * gizli bağlam olarak eklenir, görünür mesaja karışmaz.
 */

export const CONTINUE_PROMPT =
  'Önceki sohbette yarım kalan işe kaldığın yerden devam et; önce durumu kısaca özetle.';

/**
 * Devir özetini, varsa mevcut gizli bağlamın (sorun bağlamı, proje belleği …) önüne koyar.
 * Özet yoksa mevcut bağlam olduğu gibi döner.
 */
export function composeHandoffHiddenContext(
  handoffContext: string | undefined,
  existing: string | undefined
): string | undefined {
  const joined = [handoffContext, existing].filter(Boolean).join('\n\n');
  return joined || undefined;
}

/**
 * Düğmenin tıklama işleyicisi. Oluşturulması hiçbir şey göndermez; her tıklama tam bir kez
 * `submit(CONTINUE_PROMPT)` çağırır. Gönderim sonrası sohbet boş olmaktan çıktığı için düğme
 * kaybolur; reddedilen gönderimde sohbet boş kalır ve kullanıcı yeniden tıklayabilir.
 */
export function createContinueHandler(submit: (text: string) => void): () => void {
  return () => submit(CONTINUE_PROMPT);
}
