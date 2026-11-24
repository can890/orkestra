---
name: flow-media
description: Orkestra'nın orkestra-flow araçlarıyla (yerel gflow CLI) Google Flow üzerinde görsel ve video üretir, modelleri ve krediyi gösterir, üretilmiş videoları sohbetin çıkış dizinine indirir. Flow/Veo/Nano Banana ile üretim istendiğinde devreye girer.
---

# Google Flow ile görsel ve video

Araçlar bu makinedeki oturum açılmış `gflow` CLI'ını çalıştırır. Google hesabına giriş yapma, oturum dosyalarını veya çerezleri okuma; `gflow auth login/logout` çalıştırma.

- Önce `flow_list_models` ile model takma adlarını, `flow_credits` ile kalan krediyi öğren.
- `flow_generate_image` / `flow_generate_video` kullanıcının Flow kredisini harcar. Varsayılan ayarda araç önce yalnızca planı gösterir; kullanıcı onayladıktan sonra aynı argümanlarla `confirm_spend: true` vererek çağır. Videoda gerekirse `max_credits` ile üst sınır koy.
- Hata, zaman aşımı veya belirsiz yanıtta üretimi asla otomatik yineleme. Üretilmiş ama indirilememiş bir video için `flow_fetch_result` (media id) kullan; bu kredi harcamaz.
- Çoklu adet (`count`) kredi maliyetini katlar; kullanıcı istemedikçe 1 kullan.
- Araç sonucu kaydedilen dosyaların mutlak yollarını verir. Yanıtında bu yolları yaz ki sohbet görseli/videoyu satır içinde göstersin.
- Kullanıcıyla Türkçe iletişim kur.
