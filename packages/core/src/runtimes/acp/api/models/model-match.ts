/**
 * Katalog modellerini (sağlayıcı eklentilerinin listelediği sürümlü kimlikler, ör.
 * "claude-opus-5-5") ACP oturumunun gerçekten sunduğu model seçenekleriyle eşler. Sağlayıcılar
 * aynı modeli farklı kimliklerle sunabilir: Claude Code "opus", "sonnet", "fable" gibi aile
 * takma adları ve "[1m]" bağlam ipuçları kullanır. Hem ACP çalışma zamanı (kayıtlı model
 * seçimini oturuma uygularken) hem Orkestra (işçi modelini doğrularken) bu tek eşleyiciyi
 * kullanır; sağlayıcıdan bağımsızdır.
 */

/** Oturumun sunduğu bir model seçeneği (ACP yapılandırma seçeneği). */
export type LiveModelOption = { id: string; name: string; description?: string };

/** Eşlenecek model: katalog kimliği ve biliniyorsa görünen adı. */
export type ModelMatchTarget = { id: string; name?: string };

const CONTEXT_HINT = /\[[^\]]*\]$/;

function normalizedId(id: string): string {
  return id.trim().toLowerCase();
}

function bareModelId(id: string): string {
  return normalizedId(id).replace(CONTEXT_HINT, '');
}

function contextHint(id: string): string | null {
  return CONTEXT_HINT.exec(normalizedId(id))?.[0] ?? null;
}

/** "<aile> <sürüm>" kalıbındaki sürüm: "Opus 5.5", "claude-opus-5-5" → "5.5". */
function familyVersion(text: string, family: string): string | null {
  const match = new RegExp(`(?:^|[^a-z])${family}[\\s-]+(\\d+)(?:[.-](\\d+))?`, 'i').exec(text);
  if (!match?.[1]) return null;
  return match[2] ? `${match[1]}.${match[2]}` : match[1];
}

/**
 * Adaylardan istenen kimlikle aynı bağlam ipucunu taşıyanı seçer. "opus" ile "opus[1m]" birlikte
 * sunulduğunda ipucu taşımayan istek, bazı planlarda ek kullanım kredisi düşen 1M bağlamlı
 * seçeneğe değil düz seçeneğe gider.
 */
function preferContextHint<T extends LiveModelOption>(
  candidates: readonly T[],
  hint: string | null
): T | null {
  return candidates.find((option) => contextHint(option.id) === hint) ?? candidates[0] ?? null;
}

/**
 * Katalog modelinin oturumda hangi seçenekle sunulduğunu bulur. Sıra: tam kimlik (büyük/küçük
 * harf duyarsız), bağlam ipucu atılmış kimlik, aile takma adı. Takma adın sürümü seçeneğin
 * adında ya da açıklamasında yazıyorsa istenen modelinkiyle aynı olmalıdır; sürüm yazmayan takma
 * ad aileyle eşleşir. "default" seçeneği hiçbir modelle eşlenmez: hangi modele çözüldüğü zamanla
 * değişebilir.
 */
export function findLiveModelOption<T extends LiveModelOption>(
  model: ModelMatchTarget,
  options: readonly T[]
): T | null {
  const wanted = normalizedId(model.id);
  if (!wanted) return null;
  const exact = options.find((option) => normalizedId(option.id) === wanted);
  if (exact) return exact;
  const hint = contextHint(model.id);
  const bare = bareModelId(model.id);
  const hinted = preferContextHint(
    options.filter((option) => bareModelId(option.id) === bare),
    hint
  );
  if (hinted) return hinted;
  const tokens = new Set(bare.split(/[^a-z0-9]+/));
  const versioned: T[] = [];
  const unversioned: T[] = [];
  for (const option of options) {
    const alias = bareModelId(option.id);
    if (!/^[a-z]+$/.test(alias) || alias === 'default' || !tokens.has(alias)) continue;
    const required = familyVersion(model.id, alias) ?? familyVersion(model.name ?? '', alias);
    const offered =
      familyVersion(option.name, alias) ?? familyVersion(option.description ?? '', alias);
    if (required && offered) {
      if (required === offered) versioned.push(option);
      continue;
    }
    unversioned.push(option);
  }
  return preferContextHint(versioned, hint) ?? preferContextHint(unversioned, hint);
}

/** Oturum seçeneğine karşılık gelen katalog modeli; bilinmiyorsa null. */
export function findCatalogModel<T extends ModelMatchTarget>(
  models: readonly T[],
  option: LiveModelOption
): T | null {
  return models.find((model) => findLiveModelOption(model, [option]) !== null) ?? null;
}
