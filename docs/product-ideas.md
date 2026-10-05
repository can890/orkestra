# Ürün fikirleri

## Üretilen dosyaları konuşmada gösterme

Tarih: 2026-10-05

Durum: Kullanıcı ilk olarak bu özelliğin geliştirilmesini istedi. Görsel, video, ses
ve PDF önizlemeleri ile diğer dosyalar için açma/kaydetme kartları geliştirme
sürümüne eklendi. Masaüstü 1.2.14 ve workspace-server 0.1.9 yayınına dahil edildi. Çıktı galerisi, sürüm karşılaştırması ve diğer
ürün fikirleri bu talebin kapsamında değildir.

Kullanıcı, ajanların hazırladığı görsel, video, PDF ve diğer dosyaları yalnızca
dosya yolu olarak görmek yerine doğrudan konuşma içinde inceleyebilmek istiyor.

Beklenen deneyim:

- Görseller konuşmada görünür ve büyütülebilir.
- Videolar ve sesler yerleşik oynatıcıda açılır.
- PDF belgeleri sayfaları arasında gezinilerek incelenir.
- Diğer dosyalar desteklenen biçimlerde önizlenir; desteklenmeyen biçimlerde dosya
  kartı üzerinden açma veya kaydetme sunulur.

Uygulama tasarlanırken değerlendirilmesi önerilen noktalar:

- Yerel makinede ve SSH ile bağlı makinelerde üretilen dosyalara aynı deneyimle erişim.
- Çıktıların ilgili konuşmaya bağlanması ve sohbet/terminal geçişinde bulunabilir kalması.
- Büyük videoları bütünüyle indirmeyi beklemeden izleme olanağı.
- Dosya güncellendiğinde sürümünün anlaşılması ve eski sürüme erişimin korunması.
- Önizleme için dosyaların otomatik olarak dış bir servise yüklenmemesi.

Bu tasarım noktaları henüz kararlaştırılmış uygulama kapsamı değildir.
