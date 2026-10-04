---
name: elevenlabs-media
description: ElevenLabs ile ses veya seslendirme üretir; video görevlerinde görüntüyü kodla oluşturup üretilen sesi videoya ekler. ElevenLabs kullanılması istendiğinde devreye girer; ElevenLabs üzerinden video veya görsel üretmez.
---

# Kodla video, ElevenLabs ile ses

Kullanıcı “ElevenLabs kullanarak video hazırla” dediğinde videoyu kodlama araçlarıyla hazırla; ElevenLabs yalnızca ses üretimi için kullanılacak. Bağlı `elevenlabs` MCP sunucusu Huawei’deki onaylanmış hesabı kullanır. API anahtarı isteme; erişim belirteçlerini okuma.

- Seslendirme metnini istenen dil, süre ve tona göre hazırla. `creative_list_voices` ile gerçek ses seçeneklerini belirle; `creative_generate_speech` şemasını okuyup metni sese dönüştür. Model ve ses kimliklerini tahmin etme.
- ElevenLabs üzerinden video veya görsel üretme. `creative_generate_video`, `creative_generate_image` ve görsel düzenleme araçlarını kullanma. Genel akış araçlarını video/görsel üretimini dolaylı başlatmak için kullanma.
- Videonun sahnelerini, yazılarını, geçişlerini ve animasyonlarını projenin mevcut araçlarıyla kodla. Uygun olduğunda Remotion, HTML/Canvas veya FFmpeg kullan; mevcut teknolojiyi ve kullanıcının istediği tasarımı esas al.
- ElevenLabs ses üretimi başlatınca dönen flow_id ve session_ids ile `creative_get_flow_run_status` üzerinden tamamlanmasını kontrol et. Belirsiz yanıt veya zaman aşımında aynı üretimi yeniden başlatıp ikinci kez kredi harcama.
- Tamamlanan ses çıktısını ilgili projeye kaydet; kodla oluşturduğun videoya ekle. Ses süresini ölç, sahne zamanlarını ve toplam süreyi sesle uyumlu hale getir. Kullanıcı yalnızca ses istediyse video oluşturma.
- Videoyu render et ve gerçek çıktıyı doğrula: dosya açılabilmeli, ses kanalı bulunmalı, görüntü ve ses süreleri uyuşmalı. Başarılı render olmadan videonun hazır olduğunu söyleme. Çıktıyı kullanıcıya erişilebilir dosya veya önizleme olarak sun.
- Üretim görevi kapsamında yalnızca gerekli sesi üret. Ek varyasyonlar, kredi satın alma veya bakiye yükleme için görevin kapsamını genişletme. Kullanıcıyla Türkçe iletişim kur.

Resmi araç kaynağı: https://elevenlabs.io/docs/eleven-agents/operate/hosted-mcp
