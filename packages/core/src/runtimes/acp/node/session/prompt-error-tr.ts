export function promptErrorMessageTr(message: string): string {
  if (
    /quota reached|quota exceeded|resource_exhausted|usage limit|rate limit|too many requests|\b429\b/i.test(
      message
    )
  ) {
    const reset = /resets? in\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i.exec(message);
    const duration = reset
      ?.slice(1)
      .flatMap((value, index) =>
        value && Number(value) > 0
          ? [`${Number(value)} ${['saat', 'dakika', 'saniye'][index]}`]
          : []
      )
      .join(' ');
    return (
      'Bu modelin kullanım limiti doldu. ' +
      (duration ? `Hata anında bildirilen yenilenme süresi: ${duration}. ` : '') +
      'Limit yenilendiğinde tekrar deneyin veya kotası bulunan başka bir model seçin.'
    );
  }
  if (/not logged in|unauthenticated|unauthorized|authentication|\b401\b/i.test(message))
    return 'Ajan hesabına erişilemiyor. Hesap oturumunu yenileyip tekrar deneyin.';
  if (/model unavailable|model not found|unsupported model/i.test(message))
    return 'Seçili model şu anda kullanılamıyor. Kullanılabilir başka bir model seçin.';
  if (
    /connection closed|connection refused|ECONNRESET|ENOTFOUND|network|fetch failed/i.test(message)
  )
    return 'Ajan bağlantısı kesildi. Bağlantıyı kontrol edip yeniden deneyin.';
  if (/timeout|timed out/i.test(message))
    return 'Ajan zamanında yanıt vermedi. Biraz sonra yeniden deneyin.';
  if (/attachment.*(missing|removed|not found)|ENOENT/i.test(message))
    return 'Eklenen dosyaya erişilemiyor. Dosyayı yeniden ekleyip gönderin.';
  return 'İstek işlenirken bir hata oluştu. Ajanın hesap ve bağlantı durumunu kontrol edip yeniden deneyin.';
}
