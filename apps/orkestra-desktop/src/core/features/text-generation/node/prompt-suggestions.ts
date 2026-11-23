import type { PromptSuggestionTurnActivity } from '@core/features/text-generation/api/contract';

export type PromptSuggestionInput = {
  lastUserText?: string;
  lastAssistantText: string;
  projectName?: string;
  taskName?: string;
  activity?: PromptSuggestionTurnActivity;
};

export type TurnSuggestionFacts = {
  language: 'tr' | 'en';
  outcome: 'done' | 'cancelled' | 'error' | 'interrupted';
  editedFiles: string[];
  hasCodeEdits: boolean;
  editedTestFiles: boolean;
  editedOnlyDocs: boolean;
  ranTestCommand: boolean;
  testsFailed: boolean;
  testsAlreadyPassed: boolean;
  ranBuildOrTypecheck: boolean;
  buildFailed: boolean;
  buildAlreadyPassed: boolean;
  alreadyCommitted: boolean;
  alreadySummarized: boolean;
  createdPlan: boolean;
  hasFailedCommandOrTool: boolean;
};

const CODE_FILE_RE =
  /\.(?:[cm]?[jt]sx?|py|rs|go|swift|java|kt|kts|c|cc|cpp|h|hpp|cs|rb|php|css|scss|less|html|svelte|vue|sh|bash|zsh|sql|json|ya?ml|toml|xml|prisma|graphql|gql)$/i;
const TEST_FILE_RE = /(?:\.|_)(?:test|spec)\.[^./]+$|\/__tests__\//i;
const DOC_FILE_RE = /\.(?:md|mdx|txt|rst)$/i;

const TEST_CMD_RE =
  /\b(?:vitest|jest|pytest|mocha|unittest|ava)\b|\b(?:bun|npm|pnpm|yarn|cargo|go|swift|ctest)\s+(?:(?:--filter\s+\S+\s+)?(?:exec|run)\s+)?test\b|xcodebuild\s+.*\btest\b/i;
const BUILD_LINT_CMD_RE =
  /\b(?:tsgo|tsc|oxlint|eslint|biome|ruff|mypy|pyright|flake8|clippy|typecheck)\b|\b(?:pnpm|npm|yarn|bun|cargo|vite|next)\s+(?:--filter\s+\S+\s+)?(?:run\s+)?(?:build|check|lint|typecheck)\b/i;
const COMMIT_CMD_RE = /\bgit\b(?:\s+-C\s+\S+)?\s+commit\b/i;

const TEST_SUGGESTION_RE =
  /(?:\bbirim\s*test|\btest(?:i|leri|ler|ini)?\b|\bvitest\b|\bjest\b|\bpytest\b|\bunit\s*tests?\b)/i;
const EDGE_DIFF_SUGGESTION_RE =
  /(?:edge\s*case|tip\s*güvenli|type\s*safety|değişikliklerin.*özet|kısa\s*teknik\s*özet|\bdiff\b)/i;
const SUMMARY_SUGGESTION_RE = /(?:özet|summary|riskler)/i;
const BUILD_SUGGESTION_RE =
  /(?:derleme|derlemeyi|tip\s*kontrol|typecheck|\btsgo\b|\btsc\b|\boxlint\b|\beslint\b|\blint\b|\bbuild\b)/i;
const COMMIT_SUGGESTION_RE = /\bcommit\b/i;

function detectLanguage(userText: string, assistantText: string): 'tr' | 'en' {
  const sample = `${userText}\n${assistantText.slice(-1600)}`;
  if (/[çğıöşüÇĞİÖŞÜ]/.test(sample)) return 'tr';
  if (/\b(?:ve|için|ile|bir|bu|nasıl|nedir|evet|hayır|olsun|yapalım|çalışıyor)\b/i.test(sample)) {
    return 'tr';
  }
  if (
    /\b(?:the|and|for|with|this|how|what|should|would|please|created|updated|fixed|running)\b/i.test(
      sample
    )
  ) {
    return 'en';
  }
  return 'tr';
}

export function normalizePromptSuggestionInput(
  raw: string | PromptSuggestionInput
): PromptSuggestionInput {
  if (typeof raw === 'string') {
    return { lastAssistantText: raw };
  }
  return raw;
}

export function analyzeTurnFacts(raw: string | PromptSuggestionInput): TurnSuggestionFacts {
  const input = normalizePromptSuggestionInput(raw);
  const assistantText = input.lastAssistantText ?? '';
  const userText = input.lastUserText ?? '';
  const activity = input.activity;

  const editedFiles = [...new Set((activity?.editedFiles ?? []).map((f) => f.trim()).filter(Boolean))];
  const hasCodeEdits = editedFiles.some((f) => CODE_FILE_RE.test(f));
  const editedTestFiles = editedFiles.some((f) => TEST_FILE_RE.test(f));
  const editedOnlyDocs =
    editedFiles.length > 0 && !hasCodeEdits && editedFiles.every((f) => DOC_FILE_RE.test(f));

  const commands = activity?.executedCommands ?? [];
  const ranTestCommand = commands.some((c) => TEST_CMD_RE.test(c.command));
  const testCommandFailed = commands.some((c) => TEST_CMD_RE.test(c.command) && Boolean(c.failed));
  const testCommandPassed = commands.some((c) => TEST_CMD_RE.test(c.command) && !c.failed);

  const ranBuildOrTypecheck = commands.some((c) => BUILD_LINT_CMD_RE.test(c.command));
  const buildCommandFailed = commands.some(
    (c) => BUILD_LINT_CMD_RE.test(c.command) && Boolean(c.failed)
  );
  const buildCommandPassed = commands.some((c) => BUILD_LINT_CMD_RE.test(c.command) && !c.failed);

  const committedByCommand = commands.some((c) => COMMIT_CMD_RE.test(c.command) && !c.failed);
  const failedCommands = commands.filter((c) => Boolean(c.failed));
  const failedToolsCount = activity?.failedToolsCount ?? 0;

  const textMentionsTestsFailed =
    /(?:test(?:ler|leri|i)?|vitest|jest|pytest).{0,35}(?:başarısız|hata verdi|geçmedi|failed|kaldı)|\b\d+\s+failed\b/i.test(
      assistantText
    );
  const textMentionsTestsPassed =
    /(?:tüm\s+testler|birim\s+test(?:ler|leri)|test(?:ler)?|vitest|jest|pytest).{0,35}(?:geçti|başarılı|başarıyla|passed)|\bpassed\s*\(\d+\)|\b\d+\/\d+\s+(?:test\s+)?geçti/i.test(
      assistantText
    );
  const testsFailed =
    testCommandFailed || (!ranTestCommand && textMentionsTestsFailed && !textMentionsTestsPassed);
  const testsAlreadyPassed =
    (testCommandPassed && !testCommandFailed) ||
    (!ranTestCommand && !testsFailed && textMentionsTestsPassed);

  const textMentionsBuildFailed =
    /(?:tsgo|typecheck|oxlint|eslint|derleme|build).{0,35}(?:başarısız|hata verdi|failed|hatası)/i.test(
      assistantText
    );
  const textMentionsBuildPassed =
    /(?:tsgo|typecheck|oxlint|eslint|derleme|build).{0,35}(?:0\s+hata|hatasız|başarılı|geçti|passed|tamamlandı|0\s+errors?|succeeded)/i.test(
      assistantText
    );
  const buildFailed =
    buildCommandFailed || (!ranBuildOrTypecheck && textMentionsBuildFailed && !textMentionsBuildPassed);
  const buildAlreadyPassed =
    (buildCommandPassed && !buildCommandFailed) ||
    (!ranBuildOrTypecheck && !buildFailed && textMentionsBuildPassed);

  const textMentionsCommitted =
    /\bcommit\s+(?:atıldı|edildi|oluşturuldu|yapıldı|tamamlandı)\b|`?[0-9a-f]{7,40}`?\s+ile\s+commit\b/i.test(
      assistantText
    );
  const alreadyCommitted = committedByCommand || textMentionsCommitted;

  const alreadySummarized =
    /(?:^|\n)#{1,3}\s*(?:özet|değişiklikler|sonuç|yapılanlar|summary|changes)\b/i.test(assistantText) ||
    (assistantText.length > 260 && /(?:özet:|değişen dosyalar|summary:)/i.test(assistantText));

  const createdPlan =
    Boolean(activity?.createdPlan) ||
    (editedFiles.length === 0 &&
      /(?:uygulama planı|yol haritası|implementation plan|adım adım plan)/i.test(assistantText) &&
      /(?:^|\n)\s*(?:1\.|###?\s*Adım\s*1)/m.test(assistantText));

  return {
    language: detectLanguage(userText, assistantText),
    outcome: activity?.outcome ?? 'done',
    editedFiles,
    hasCodeEdits,
    editedTestFiles,
    editedOnlyDocs,
    ranTestCommand,
    testsFailed,
    testsAlreadyPassed,
    ranBuildOrTypecheck,
    buildFailed,
    buildAlreadyPassed,
    alreadyCommitted,
    alreadySummarized,
    createdPlan,
    hasFailedCommandOrTool: failedCommands.length > 0 || failedToolsCount > 0,
  };
}

function cleanOptionTitle(rawTitle: string): string {
  const withoutMd = rawTitle
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();
  const colonSplit = withoutMd.split(/:\s+/);
  const head = colonSplit[0]?.trim() || withoutMd;
  const trimmed = head.replace(/[.:;!?]+$/, '').trim();
  return trimmed.length <= 48 ? trimmed : `${trimmed.slice(0, 45).trimEnd()}…`;
}

function extractTailOptions(tail: string, language: 'tr' | 'en'): string[] {
  const asksChoice =
    /(?:hangisini\s+(?:tercih|seç|yap|uygula|istersin)|hangisi\s+olsun|tercih\s+edersin|seçenek(?:ler)?\s*:|which\s+(?:one|option)\s+(?:do you|would you)|choose\s+(?:one|an option))/i.test(
      tail
    );
  if (!asksChoice) return [];

  const lines = tail.split(/\r?\n/);
  const listItems: Array<{ marker: string; label: string }> = [];
  let inList = false;

  // Sondaki veya seçenek başlığından hemen sonraki numaralı/harfli listeyi topla.
  for (const line of lines) {
    const match = /^\s*(?:([1-9])[.)]|([A-Ca-c])[.)])\s+(.+)$/.exec(line);
    if (match) {
      const marker = (match[1] ?? match[2] ?? '').toUpperCase();
      const label = cleanOptionTitle(match[3] ?? '');
      if (label.length >= 3) {
        if (!inList && listItems.length > 0) {
          listItems.length = 0;
        }
        inList = true;
        listItems.push({ marker, label });
      }
      continue;
    }
    if (line.trim() === '' || /^\s+/.test(line)) {
      continue;
    }
    inList = false;
  }

  if (listItems.length < 2) return [];
  return listItems.slice(0, 3).map(({ marker, label }) =>
    language === 'tr' ? `${marker}. seçeneği uygula: ${label}` : `Use option ${marker}: ${label}`
  );
}

function normalizeTurkishOfferAction(rawAction: string): string {
  let clean = rawAction
    .replace(/[`*"]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[?.!,;:]+$/, '')
    .trim();

  // "İstersen X yapabilirim" -> "X yap", "İstersen X'e geçirebilirim" -> "X'e geçir",
  // "İstersen devam edebilirim" -> "devam et", "İstersen ekleyebilirim" -> "ekle".
  if (/\bed(?:ebilir(?:im|iz)|eyim\s*m[ıi])$/i.test(clean)) {
    clean = clean.replace(/\bed(?:ebilir(?:im|iz)|eyim\s*m[ıi])$/i, 'et');
  } else if (/y[ae](?:bilir(?:im|iz)|y[ıi]m\s*m[ıi])$/i.test(clean)) {
    clean = clean.replace(/y[ae](?:bilir(?:im|iz)|y[ıi]m\s*m[ıi])$/i, '');
  } else {
    clean = clean.replace(/[ae](?:bilir(?:im|iz)|y[ıi]m\s*m[ıi])$/i, '');
  }

  return clean.trim();
}

function extractTailOffer(tail: string, language: 'tr' | 'en'): string | null {
  const bottom = tail.split(/\r?\n/).slice(-8).join('\n');

  if (language === 'tr') {
    const trOfferMatch =
      /(?:[iİ]stersen(?:[iİ]z)?|dilersen(?:[iİ]z)?|hazırsan(?:ız)?)\s+((?:[^.!?\n]|\.(?=\S)){8,95}?(?:bilir(?:[iİ]m|[iİ]z)|y[ıi]m\s*m[ıi]))/i.exec(
        bottom
      );
    if (trOfferMatch?.[1]) {
      const normalized = normalizeTurkishOfferAction(trOfferMatch[1]);
      if (normalized.length >= 6 && normalized.length <= 68) {
        return `Evet, ${normalized}`;
      }
      return 'Evet, önerdiğin adımı uygula';
    }
    if (/(?:devam\s+edeyim\s*mi|uygulayayım\s*mı|başlayayım\s*mı)\??/i.test(bottom)) {
      return 'Evet, uygula';
    }
    if (/(?:onaylıyor\s+musun|yapayım\s*mı|ekleyeyim\s*mi|düzelteyim\s*mi)\??/i.test(bottom)) {
      return 'Evet, devam et';
    }
    return null;
  }

  const enOfferMatch =
    /(?:would you like me to|want me to|shall i)\s+((?:[^.!?\n]|\.(?=\S)){6,72}?)\?/i.exec(bottom);
  if (enOfferMatch?.[1]) {
    const action = enOfferMatch[1].replace(/[`*"]/g, '').trim();
    return action.length <= 65 ? `Yes, ${action}` : 'Yes, go ahead';
  }
  return null;
}

export function extractExplicitAssistantFollowUps(
  lastAssistantText: string,
  language: 'tr' | 'en'
): string[] {
  const tail = lastAssistantText.slice(-2200).trim();
  if (!tail) return [];

  const options = extractTailOptions(tail, language);
  if (options.length > 0) return options;

  const offer = extractTailOffer(tail, language);
  return offer ? [offer] : [];
}

export function filterIllogicalSuggestions(
  candidates: readonly string[],
  facts: TurnSuggestionFacts
): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];

  for (const raw of candidates) {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (text.length < 4 || text.length > 95) continue;

    // Mantık ve anti-tekrar kapıları:
    if (TEST_SUGGESTION_RE.test(text)) {
      if (facts.testsAlreadyPassed) continue;
      if (!facts.hasCodeEdits && !facts.testsFailed && !facts.createdPlan) continue;
    }

    if (EDGE_DIFF_SUGGESTION_RE.test(text) && facts.editedFiles.length === 0) {
      continue;
    }

    if (
      facts.alreadySummarized &&
      facts.editedFiles.length === 0 &&
      SUMMARY_SUGGESTION_RE.test(text)
    ) {
      continue;
    }
    if (facts.alreadySummarized && /(?:kısa teknik özet|değişikliklerin.*özet)/i.test(text)) {
      continue;
    }

    if (BUILD_SUGGESTION_RE.test(text)) {
      if (facts.buildAlreadyPassed || !facts.hasCodeEdits) continue;
    }

    if (COMMIT_SUGGESTION_RE.test(text)) {
      if (facts.alreadyCommitted || facts.editedFiles.length === 0) continue;
    }

    const dedupeKey = text.toLocaleLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    kept.push(text);
    if (kept.length >= 3) break;
  }

  return kept;
}

export function buildHeuristicPromptSuggestions(raw: string | PromptSuggestionInput): string[] {
  const input = normalizePromptSuggestionInput(raw);
  const facts = analyzeTurnFacts(input);
  const isTr = facts.language === 'tr';

  // 1. İptal veya yarım kalma:
  if (facts.outcome === 'cancelled' || facts.outcome === 'interrupted') {
    const cancelledSuggestions = [
      isTr ? 'Kaldığın yerden devam et' : 'Continue where you left off',
    ];
    if (facts.editedFiles.length > 0) {
      cancelledSuggestions.push(
        isTr ? 'Yarım kalan değişiklikleri kontrol et' : 'Check the partial changes'
      );
    }
    return filterIllogicalSuggestions(cancelledSuggestions, facts);
  }

  // 2. Hata veya başarısız test/derleme/komut:
  if (
    facts.outcome === 'error' ||
    facts.testsFailed ||
    facts.buildFailed ||
    facts.hasFailedCommandOrTool
  ) {
    const errorSuggestions: string[] = [];
    if (facts.testsFailed) {
      errorSuggestions.push(
        isTr ? 'Başarısız testleri düzelt ve tekrar çalıştır' : 'Fix failing tests and re-run them'
      );
    }
    if (facts.buildFailed) {
      errorSuggestions.push(
        isTr ? 'Derleme ve tip hatalarını düzelt' : 'Fix build and type errors'
      );
    }
    if (errorSuggestions.length === 0) {
      errorSuggestions.push(
        isTr ? 'Hatanın nedenini bul ve düzelt' : 'Find and fix the root cause of the error'
      );
    }
    return filterIllogicalSuggestions(errorSuggestions, facts);
  }

  // 3. Asistan açık seçenekler veya onaylı teklif sunduysa:
  const explicitFollowUps = extractExplicitAssistantFollowUps(
    input.lastAssistantText,
    facts.language
  );
  if (explicitFollowUps.length > 0) {
    const filteredExplicit = filterIllogicalSuggestions(explicitFollowUps, facts);
    if (filteredExplicit.length > 0) return filteredExplicit;
  }

  // 4. Plan sunulduysa ancak henüz dosya düzenlenmediyse:
  if (facts.createdPlan && facts.editedFiles.length === 0) {
    return filterIllogicalSuggestions(
      isTr
        ? ['Bu planı uygulamaya başla', 'Planı daha sade bir yaklaşımla daralt']
        : ['Start implementing this plan', 'Simplify the plan first'],
      facts
    );
  }

  // 5. Gerçek dosya değişikliği varsa yalnızca henüz yapılmamış adımları öner:
  if (facts.editedFiles.length > 0) {
    const codeSuggestions: string[] = [];

    if (facts.hasCodeEdits && !facts.testsAlreadyPassed && !facts.ranTestCommand) {
      codeSuggestions.push(
        facts.editedTestFiles
          ? isTr
            ? 'Yazılan testleri çalıştır ve doğrula'
            : 'Run and verify the updated tests'
          : isTr
            ? 'Değişen dosyalar için test ekle ve çalıştır'
            : 'Add and run tests for the changed files'
      );
    }

    if (facts.hasCodeEdits && !facts.buildAlreadyPassed && !facts.ranBuildOrTypecheck) {
      codeSuggestions.push(
        isTr ? 'Tip kontrolü ve derlemeyi çalıştır' : 'Run typecheck and build'
      );
    }

    if (
      !facts.alreadyCommitted &&
      (facts.testsAlreadyPassed || facts.buildAlreadyPassed || facts.editedOnlyDocs || !facts.hasCodeEdits)
    ) {
      codeSuggestions.push(
        isTr ? 'Değişiklikleri gözden geçir ve commit et' : 'Review changes and create a commit'
      );
    }

    return filterIllogicalSuggestions(codeSuggestions, facts);
  }

  // 6. Salt soru-cevap / açıklama / inceleme / kod dışı işlem: alakasız öneri üretme.
  return [];
}

export function parseLlmSuggestionArray(rawText: string): string[] | null {
  const trimmed = rawText.trim();
  const fenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try {
    const parsed: unknown = JSON.parse(fenced);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length >= 4 && item.length <= 120)
        .slice(0, 3);
    }
  } catch {
    // Satır bazlı ayrıştırmaya düş.
  }

  const lines = fenced
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*•\d.)\s]+/, '').replace(/^["']|["']$/g, '').trim())
    .filter((line) => line.length >= 6 && line.length <= 120)
    .slice(0, 3);
  return lines.length > 0 ? lines : null;
}

export function buildLlmSuggestionPrompt(
  input: PromptSuggestionInput,
  facts: TurnSuggestionFacts
): { systemPrompt: string; prompt: string } {
  const activityLines: string[] = [];
  activityLines.push(`Sonuç durumu: ${facts.outcome}`);
  activityLines.push(
    facts.editedFiles.length > 0
      ? `Düzenlenen dosyalar (${facts.editedFiles.length}): ${facts.editedFiles.slice(0, 8).join(', ')}`
      : 'Düzenlenen dosya: Yok (0 dosya)'
  );
  if (facts.testsAlreadyPassed) activityLines.push('Test durumu: Bu turda testler ZATEN geçti.');
  else if (facts.testsFailed) activityLines.push('Test durumu: Bu turda başarısız test var.');
  if (facts.buildAlreadyPassed) activityLines.push('Derleme/tip kontrolü: Bu turda ZATEN geçti.');
  else if (facts.buildFailed) activityLines.push('Derleme/tip kontrolü: Hata var.');
  if (facts.alreadyCommitted) activityLines.push('Git commit: Bu turda ZATEN commit atıldı.');
  if (facts.createdPlan) activityLines.push('Plan: Bu turda uygulama planı oluşturuldu.');

  const langRule =
    facts.language === 'tr'
      ? 'Tüm önerileri doğal ve kısa Türkçe yaz.'
      : 'Write all suggestions in concise English.';

  const systemPrompt = [
    'Sen Orkestra masaüstü uygulamasının sohbet sonrası akıllı takip istemi önericisisin.',
    langRule,
    'Sadece bu turda GERÇEKTEN yapılan işe ve asistanın son yanıtına dayanarak kullanıcının bir sonraki mesajda doğrudan gönderebileceği 0 ila 3 kısa öneri (en fazla 60 karakter) üret.',
    'KESİN KURALLAR:',
    '- Bu turda ZATEN yapılmış hiçbir işi (testler geçtiyse "test çalıştır", derleme geçtiyse "derle/tip kontrolü yap", commit atıldıysa "commit et") ASLA tekrar önerme.',
    '- Hiç dosya düzenlenmediyse (`Düzenlenen dosya: Yok`) birim testi, edge case, tip güvenliği, diff veya commit önerisi KESİNLİKLE üretme.',
    '- Asistan son mesajda numaralı seçenekler sunduysa ("1..., 2...") veya evet/hayır teklifi yaptıysa önerileri doğrudan o seçimlere göre oluştur.',
    '- Konuşma doğal olarak tamamlandıysa (ör. bilgi sorusu cevaplandıysa veya test+derleme+commit bittiyse) boş JSON dizisi [] döndür.',
    'Yanıtı YALNIZCA geçerli bir JSON string dizisi olarak ver (ör. [] veya ["..."]). Ek metin veya markdown açıklama yazma.',
  ].join('\n');

  const prompt = [
    input.projectName ? `Proje: ${input.projectName}` : '',
    input.taskName ? `Görev: ${input.taskName}` : '',
    input.lastUserText ? `Kullanıcının son isteği: ${input.lastUserText.slice(0, 800)}` : '',
    `Bu turdaki gerçek etkinlikler:\n${activityLines.join('\n')}`,
    `Asistanın son yanıtı:\n${input.lastAssistantText.slice(0, 4200)}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  return { systemPrompt, prompt };
}
