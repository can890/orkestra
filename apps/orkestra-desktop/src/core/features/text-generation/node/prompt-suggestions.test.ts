import { describe, expect, it } from 'vitest';
import {
  analyzeTurnFacts,
  buildHeuristicPromptSuggestions,
  filterIllogicalSuggestions,
} from './prompt-suggestions';

describe('prompt-suggestions mantık ve anti-tekrar motoru', () => {
  it('başarıyla biten turda ara araç hatası için düzeltme önermez', () => {
    const input = {
      lastAssistantText: 'Uygulamayı kurdum.',
      activity: {
        outcome: 'done' as const,
        failedToolsCount: 1,
        executedCommands: [{ command: 'rg eski-dosya', failed: true }],
      },
    };
    expect(buildHeuristicPromptSuggestions(input)).toEqual([]);
    expect(
      filterIllogicalSuggestions(['Hatanın nedenini bul ve düzelt'], analyzeTurnFacts(input))
    ).toEqual([]);
  });

  it('yeniden çalıştırılıp geçen test ve derleme için hata önermez', () => {
    expect(
      buildHeuristicPromptSuggestions({
        lastAssistantText: 'Tamamlandı.',
        activity: {
          outcome: 'done',
          executedCommands: [
            { command: 'pnpm test', failed: true },
            { command: 'pnpm build', failed: true },
            { command: 'pnpm test' },
            { command: 'pnpm build' },
          ],
        },
      })
    ).toEqual([]);
  });

  it('tur gerçekten hata ile sonlanırsa hata önerisini korur', () => {
    expect(
      buildHeuristicPromptSuggestions({
        lastAssistantText: '',
        activity: { outcome: 'error' },
      })
    ).toEqual(['Hatanın nedenini bul ve düzelt']);
  });

  it('salt soru-cevap / açıklama konuşmasında alakasız test veya edge case önerisi üretmez', () => {
    const result = buildHeuristicPromptSuggestions({
      lastUserText: 'nasıl çalışıyor bu ses algılaması',
      lastAssistantText:
        'Orkestra ses algılama akışı 4 aşamada çalışır: Mikrofon MediaRecorder kaydı, VoiceService motor seçimi, LocalSttRunner ile MLX Whisper dönüşümü ve metin temizliği.',
      activity: {
        outcome: 'done',
        readFilesCount: 3,
      },
    });
    expect(result).toEqual([]);
  });

  it('disk temizliği ve uygulama başlatma gibi kod dışı operasyonlarda boş öneri döner', () => {
    const result = buildHeuristicPromptSuggestions({
      lastUserText: 'diski ayarla yer aç sonrada uygulamayı aç deneyelim',
      lastAssistantText:
        'Diskte 9.1 GiB boş alan açıldı ve Orkestra v1.2.31 başlatıldı (PID 23651). Test etmek için sohbet kutusundaki mikrofon simgesine tıklayabilirsin.',
      activity: {
        outcome: 'done',
        executedCommands: [
          { command: 'npm cache clean --force' },
          { command: 'open /Applications/Orkestra.app' },
        ],
      },
    });
    expect(result).toEqual([]);
  });

  it('asistan numaralı seçenekler sunup tercih sorduğunda doğrudan o somut seçenekleri önerir', () => {
    const result = buildHeuristicPromptSuggestions({
      lastUserText: 'uygulamaya gömülü değil mi bu',
      lastAssistantText: [
        'Şu an harici mlx-whisper venv kullanıyor. Tamamen gömülü seçenekler:',
        '1. **En temizi — Gömülü whisper.cpp**: Apple Silicon Metal ikilisi ve ilk açılışta model indirme.',
        '2. **Modeli de .app içine paketlemek**: Sıfır internet ama daha büyük kurulum.',
        '3. **macOS yerleşik Speech Framework**: Sıfır ek boyut.',
        'Hangisini tercih edersin?',
      ].join('\n'),
      activity: { outcome: 'done' },
    });

    expect(result).toEqual([
      '1. seçeneği uygula: En temizi — Gömülü whisper.cpp',
      '2. seçeneği uygula: Modeli de .app içine paketlemek',
      '3. seçeneği uygula: macOS yerleşik Speech Framework',
    ]);
  });

  it('asistan sonda somut tekil bir teklif sunduğunda Türkçe grameriyle net onay önerisi çıkarır', () => {
    const result = buildHeuristicPromptSuggestions({
      lastUserText: 'uygulamaya gömülü değil mi bu',
      lastAssistantText:
        'Yönetici kod gömülü ama Python dışarıdan kullanılıyor.\nİstersen uygulamayı gömülü whisper.cpp yapısına geçirebilirim.',
      activity: { outcome: 'done' },
    });

    expect(result).toEqual(['Evet, uygulamayı gömülü whisper.cpp yapısına geçir']);
  });

  it('Türkçe istek/yeterlilik kiplerini ve doğrudan kapanış sorularını bozmadan çıkarır', () => {
    expect(
      buildHeuristicPromptSuggestions({
        lastAssistantText:
          'Değişiklik tamamlandı. İstersen hemen derleyip uygulamayı güncelleyeyim.',
        activity: { outcome: 'done' },
      })
    ).toEqual(['Evet, hemen derleyip uygulamayı güncelle']);

    expect(
      buildHeuristicPromptSuggestions({
        lastAssistantText:
          'Paket hazır. Şimdi /Applications/Sovra.app uygulamasını güncelleyip yeniden başlatayım mı?',
        activity: { outcome: 'done' },
      })
    ).toEqual(['Evet, Sovra.app uygulamasını güncelleyip yeniden başlat']);
  });

  it('asistan kurulum/kapanış mesajıyla işi bitirdiyse jenerik kod şablonu üretmez', () => {
    expect(
      buildHeuristicPromptSuggestions({
        lastAssistantText:
          '/Applications/Sovra.app güncellenip yeniden başlatılıyor — açılınca yeni görünümü doğrudan görebilirsin.',
        activity: {
          outcome: 'done',
          editedFiles: ['apps/orkestra-desktop/src/foo.tsx'],
        },
      })
    ).toEqual([]);
  });

  it('kod dosyası düzenlendi ama henüz test ve derleme yapılmadıysa test ve derleme önerir', () => {
    const result = buildHeuristicPromptSuggestions({
      lastUserText: 'dikte butonuna otomatik gönder ekle',
      lastAssistantText: 'Otomatik gönderme desteğini ekledim.',
      activity: {
        outcome: 'done',
        editedFiles: ['apps/orkestra-desktop/src/core/features/voice/browser/use-dictation.ts'],
      },
    });

    expect(result).toEqual([
      'Değişen dosyalar için test ekle ve çalıştır',
      'Tip kontrolü ve derlemeyi çalıştır',
    ]);
  });

  it('test ve derleme ZATEN geçtiyse onları tekrar önermez, yalnızca commit önerir', () => {
    const result = buildHeuristicPromptSuggestions({
      lastUserText: 'özelliği ekle ve test et',
      lastAssistantText: 'Değişiklikleri yaptım, vitest (56/56) ve tsgo sorunsuz geçti.',
      activity: {
        outcome: 'done',
        editedFiles: ['src/core/features/voice/node/voice-service.ts'],
        executedCommands: [
          {
            command:
              'pnpm --filter @orkestra/orkestra-desktop exec vitest run src/core/features/voice',
          },
          {
            command:
              'pnpm --filter @orkestra/orkestra-desktop exec tsgo -p tsconfig.node.json --noEmit',
          },
        ],
      },
    });

    expect(result).toEqual(['Değişiklikleri gözden geçir ve commit et']);
  });

  it('test, derleme ve git commit hepsi zaten yapıldıysa tekrar işi önermez ve boş döner', () => {
    const result = buildHeuristicPromptSuggestions({
      lastUserText: 'ekle, doğrula ve commit et',
      lastAssistantText: 'Testler geçti, derleme hatasız tamamlandı ve 14691bc ile commit edildi.',
      activity: {
        outcome: 'done',
        editedFiles: ['src/core/features/voice/node/voice-service.ts'],
        executedCommands: [
          { command: 'vitest run' },
          { command: 'tsgo -p tsconfig.node.json --noEmit' },
          { command: 'git commit -m "feat(voice): ..."' },
        ],
      },
    });

    expect(result).toEqual([]);
  });

  it('test başarısız olduğunda düzeltme ve yeniden çalıştırma önerir', () => {
    const result = buildHeuristicPromptSuggestions({
      lastAssistantText: '2 test başarısız oldu.',
      activity: {
        outcome: 'done',
        editedFiles: ['src/foo.ts'],
        executedCommands: [{ command: 'pnpm test', failed: true }],
      },
    });

    expect(result).toEqual(['Başarısız testleri düzelt ve tekrar çalıştır']);
  });

  it('plan çıkarılıp henüz dosya değiştirilmediyse birim testi değil planı uygulamayı önerir', () => {
    const result = buildHeuristicPromptSuggestions({
      lastUserText: 'bunun için plan çıkar',
      lastAssistantText: '### Uygulama Planı\n1. Sözleşmeyi güncelle\n2. Servisi yaz',
      activity: {
        outcome: 'done',
        createdPlan: true,
      },
    });

    expect(result).toEqual(['Bu planı uygulamaya başla', 'Planı daha sade bir yaklaşımla daralt']);
  });

  it('iptal edilen turda devam etme önerisi döndürür', () => {
    const result = buildHeuristicPromptSuggestions({
      lastAssistantText: '',
      activity: {
        outcome: 'cancelled',
        editedFiles: ['src/a.ts'],
      },
    });

    expect(result).toEqual(['Kaldığın yerden devam et', 'Yarım kalan değişiklikleri kontrol et']);
  });

  it('filterIllogicalSuggestions LLM çıktısındaki mantık dışı ve mükerrer önerileri eler', () => {
    const noEditFacts = analyzeTurnFacts({
      lastAssistantText: '## Özet\nSorunuzu aşağıda açıkladım.',
      activity: { outcome: 'done' },
    });
    expect(
      filterIllogicalSuggestions(
        [
          'Bu değişiklikler için birim testi ekle ve çalıştır',
          'Olası edge case ve tip güvenliği açıklarını gözden geçir',
          'Değişikliklerin kısa teknik özetini ve olası risklerini listele',
          'Değişiklikleri commit et',
        ],
        noEditFacts
      )
    ).toEqual([]);

    const doneCodeFacts = analyzeTurnFacts({
      lastAssistantText: 'Testler geçti ve commit atıldı.',
      activity: {
        outcome: 'done',
        editedFiles: ['src/app.ts'],
        executedCommands: [
          { command: 'vitest run' },
          { command: 'tsgo --noEmit' },
          { command: 'git commit -m "ok"' },
        ],
      },
    });
    expect(
      filterIllogicalSuggestions(
        [
          'Birim testi çalıştır',
          'Tip kontrolü yap',
          'Değişiklikleri commit et',
          'Uygulamayı başlatıp canlı dene',
        ],
        doneCodeFacts
      )
    ).toEqual(['Uygulamayı başlatıp canlı dene']);
  });
});
