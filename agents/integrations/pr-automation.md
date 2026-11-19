# PR Otomasyonu

Açık PR'ı olan görevlerde CI kırılınca / inceleme yorumu gelince ajanı devreye sokan "Otomatik düzelt"
ve GitHub'ın yerel auto-merge özelliğini açan "Kontroller geçince birleştir". **İkisi de her yerde
varsayılan kapalıdır** ve yalnızca kullanıcının PR satırındaki anahtara tıklamasıyla açılır.

## Parçalar

| Parça | Dosya |
| --- | --- |
| Saf karar mantığı, defter, istem üretimi | `apps/orkestra-desktop/src/core/features/source-control/api/pr-automation.ts` |
| Görev başına store (reaksiyon + kalıcı durum) | `.../source-control/api/browser/stores/pr-automation-store.ts` |
| Kalıcı durum (memento `source-control.pr-automation`, özne: görev) | `.../source-control/contributions/mementos.ts` (katalog: `src/core/manifests/shared/memento-catalog.ts`) |
| Bağlama (canlı PR/yorum okuma, ajan durumu, prompt gönderme) | `.../source-control/api/browser/pr-automation-wiring.ts` |
| Sahiplik ve yaşam döngüsü | `TaskComposition.prAutomation` (`features/workbench/api/browser/task-composition.ts`) |
| Arayüz | `.../changes-panel/components/pr-entry/pr-automation-controls.tsx` |
| Auto-merge (motor → servis → Wire → store) | `setPullRequestAutoMerge` (`services/pull-requests/`) |

## Otomatik düzelt

- Yeni GitHub yoklaması yoktur. Store, `PrStore.details` canlı modelini (motorun yenileme akışı) izler;
  anahtar açıkken `bindDetails` ilgisi panel kapalı olsa da kontrolleri ve yorumları ister.
- Karar `decideAutoFix` ile verilir; store yalnızca karara uyar. Korkuluklar (hepsi testli):
  - aynı head SHA için en fazla 3 deneme, PR başına toplam en fazla 10 deneme;
  - ajan meşgulken (herhangi bir konuşma `working` / `awaiting-input`) ya da uygun ACP ana
    konuşması yokken tetikleme yok;
  - aynı hata iki kez işlenmez: parmak izi = başarısız kontrol adı+sonuç kümesi (SHA'dan bağımsız)
    ya da yorum kimliği;
  - yalnızca mevcut head SHA'sına ait ve tamamen yerleşmiş (bekleyen yok) kontroller sayılır;
  - taslak / kapalı / birleşmiş PR'da çalışmaz;
  - anahtar açılırken var olan yorumlar "görüldü" sayılır (baz çizgisi); yalnızca sonradan gelen,
    çözülmemiş, eskimemiş ve PR yazarına ait olmayan inceleme yorumları tetikler.
- Tetikleme deftere **önce** yazılır, sonra prompt gönderilir: gönderim başarısız olsa da deneme harcanır.
- Her tetikleme görev etkinliğine (PR panelindeki "Otomasyon geçmişi", mementoda son 20 olay),
  uygulama günlüğüne, bir toast'a ve görevin ana sohbetindeki `[Orkestra PR otomasyonu]` mesajına yazılır.
- Anahtarı kapatıp açmak defteri sıfırlar (yeniden silahlanma). Sınıra ulaşılınca "Durduruldu" olayı
  bir kez yazılır.
- Kalıcı durum 60 gün dokunulmazsa memento süpürmesiyle silinir; varsayılan "kapalı" olduğundan güvenlidir.
- Yalnızca görev uygulamada yüklüyken (TaskComposition ayakta) çalışır; uygulama kapalıyken tetikleme yoktur.

## Otomatik birleştir

`PrStore.setAutoMerge` → `setPullRequestAutoMerge` Wire çağrısı → motor: REST `pulls.get` (node_id) +
GraphQL `enablePullRequestAutoMerge` / `disablePullRequestAutoMerge`. Ajanlar bu yolu kullanamaz:
çağrı yalnızca arayüz anahtarından gelir. Depoda "Allow auto-merge" kapalıysa GitHub hata döner ve
mesaj toast ile gösterilir. Anahtarın durumu "bu uygulamadan açılan istek" olarak mementoda tutulur;
GitHub tarafındaki gerçek durum (örn. yeni push ile iptal) PR şemasında olmadığından okunmaz.

## Olay tetikleyicili otomasyonlar (yapılmadı)

`packages/core/src/runtimes/automations/` yalnızca cron zamanlamalı dağıtımları bilir
(`automationScheduleSchema`, `automationRunTriggerKindSchema = cron | manual`). PR olay tetikleyicisi
için dağıtım şeması, zamanlayıcı, çalıştırma payload'ı, masaüstü otomasyon tanımı/arayüzü ve PR
işçisinden otomasyon işçisine bir olay köprüsü gerekir; ayrı bir tasarım işidir.
