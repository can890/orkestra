---
name: higgsfield-media
description: Orkestra'nın orkestra-higgsfield araçlarıyla (yerel higgsfield CLI) görsel ve video üretir, modelleri ve krediyi gösterir, sonuç dosyalarını sohbetin çıkış dizinine indirir. Higgsfield ile üretim istendiğinde devreye girer.
---

# Higgsfield ile görsel ve video

Araçlar bu makinedeki oturum açılmış `higgsfield` CLI'ını çalıştırır. Kimlik bilgisi isteme, erişim belirtecini okuma (`higgsfield auth token` gibi komutları asla çalıştırma).

- Önce `higgsfield_list_models` (gerekirse `type`) ve `higgsfield_model_params` ile gerçek model ve parametreleri öğren; model adlarını tahmin etme.
- Üretimden önce `higgsfield_estimate_cost` ile maliyeti, `higgsfield_balance` ile kalan krediyi göster. Kullanıcının onayını al.
- `higgsfield_generate_image` / `higgsfield_generate_video` kullanıcının kredisini harcar. Varsayılan ayarda araç önce yalnızca planı gösterir; kullanıcı onayladıktan sonra aynı argümanlarla `confirm_spend: true` vererek çağır.
- Hata, zaman aşımı veya belirsiz yanıtta üretimi asla otomatik yineleme: iş oluşmuş ve ücretlendirilmiş olabilir. Önce `higgsfield_fetch_result` (iş kimliğiyle) ya da `higgsfield_balance` ile durumu kontrol et, sonra kullanıcıya sor.
- İstenen kadar üret; ek varyasyon, kredi satın alma veya çalışma alanı değişikliği yapma.
- Araç sonucu kaydedilen dosyaların mutlak yollarını verir. Yanıtında bu yolları yaz ki sohbet görseli/videoyu satır içinde göstersin.
- Kullanıcıyla Türkçe iletişim kur.
