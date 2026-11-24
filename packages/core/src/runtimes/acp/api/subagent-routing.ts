/**
 * Limit farkındalıklı alt ajan yönlendirmesi. Karar mantığı tek bir saf JS kaynağıdır
 * (`SUBAGENT_ROUTING_SOURCE`): yerleşik `orkestra-subagents` MCP köprüsü bu kaynağı kendi
 * betiğine gömer, masaüstü ana süreci ve testler ise aynı kaynağı `createSubagentRouter()` ile
 * değerlendirir. Böylece önizleme, testler ve gerçek yönlendirme aynı kodu çalıştırır.
 *
 * Ayar kapalıyken masaüstü anlık görüntü dosyasını siler; köprü dosyayı bulamayınca bugünkü
 * davranışı birebir korur.
 */

export type HeadroomState = 'ok' | 'low' | 'exhausted' | 'unknown';

/** Masaüstünün bir sağlayıcı için yazdığı ham ölçüm (bağlayıcı, en dolu pencere). */
export type ProviderHeadroomSample = {
  /** Kalan yüzde (0–100); ölçüm yoksa null. */
  remainingPercent: number | null;
  windowLabel: string | null;
  /** Pencerenin yenileneceği an (ISO). */
  resetsAt: string | null;
  /** Ölçüm anı (ISO). */
  measuredAt: string | null;
};

export type ProviderHeadroom = {
  state: HeadroomState;
  remainingPercent: number | null;
  windowLabel: string | null;
  resetsAt: string | null;
};

export type RoutingCandidate = {
  provider: string;
  model: string;
  effort?: string;
  enabled: boolean;
};

export type RoutingTier = {
  /** Kararlı kimlik; sıra = ucuzdan pahalıya (ilk katman en ucuz). */
  id: string;
  label: string;
  enabled: boolean;
  candidates: RoutingCandidate[];
};

export type SubagentRoutingPolicy = {
  /** Kalan yüzde bu eşiğin altındaysa havuz "low" sayılır ve yönlendirilir. */
  thresholdPercent: number;
  /** "Ebeveynin kendi kıt modelini, açıkça istenmedikçe alt ajan olarak başlatma." */
  avoidParentScarceModels: boolean;
  /** Kıt sayılan model kalıpları (`*` joker). */
  scarceModels: string[];
  tiers: RoutingTier[];
};

export type SubagentRoutingSnapshot = {
  version: 1;
  enabled: boolean;
  writtenAt: number;
  policy: SubagentRoutingPolicy;
  headroom: Record<string, ProviderHeadroomSample>;
};

export type RouteRequest = {
  /** Çağıranın açıkça verdiği ya da modelden çıkarılan sağlayıcı. */
  provider?: string;
  model?: string;
  effort?: string;
  /** Çağıranın istediği katman kimliği (isteğe bağlı). */
  tier?: string;
  /** Çağıran bir model adı verdi mi. */
  explicitModel: boolean;
};

export type RouteInput = {
  request: RouteRequest;
  parent: { provider?: string; model?: string };
  policy: SubagentRoutingPolicy;
  headroom: Record<string, ProviderHeadroomSample>;
  now: number;
  /** Bundan eski ölçüm boşluk kanıtı sayılmaz (varsayılan 45 dk). */
  staleAfterMs?: number;
  /** Kurulu olmayan sağlayıcılar (false) aday olamaz; bilinmeyen kurulu sayılır. */
  installed?: Record<string, boolean>;
};

export type RouteAction = 'keep' | 'reroute' | 'pick' | 'no-alternative';

export type RouteDecision = {
  action: RouteAction;
  provider: string | null;
  model: string | null;
  effort: string | null;
  tier: string | null;
  requested: { provider: string | null; model: string | null };
  /** Çağıran ajana dönen tek cümlelik açıklama; değişiklik yoksa null. */
  note: string | null;
  headroom: ProviderHeadroom | null;
};

export type SubagentModelsAnnotation = {
  providers: Record<string, ProviderHeadroom>;
  recommended: Record<
    string,
    { provider: string; model: string; effort: string | null; headroom: ProviderHeadroom } | null
  >;
  thresholdPercent: number;
};

export type SubagentRouter = {
  classifyHeadroom(
    sample: ProviderHeadroomSample | undefined,
    thresholdPercent: number,
    now: number,
    staleAfterMs?: number
  ): ProviderHeadroom;
  decideSubagentRoute(input: RouteInput): RouteDecision;
  annotateSubagentModels(input: Omit<RouteInput, 'request'>): SubagentModelsAnnotation;
  isScarceModel(model: string, patterns: readonly string[]): boolean;
};

/** Gömülebilir, bağımlılıksız JS (köprü betiğinin içine aynen yazılır). */
export const SUBAGENT_ROUTING_SOURCE = String.raw`
const SUBAGENT_ROUTING_STALE_MS = 45 * 60 * 1000;

function routingTimeOf(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function classifyHeadroom(sample, thresholdPercent, now, staleAfterMs) {
  const empty = { state: 'unknown', remainingPercent: null, windowLabel: null, resetsAt: null };
  if (!sample || typeof sample.remainingPercent !== 'number' || !Number.isFinite(sample.remainingPercent)) {
    return empty;
  }
  const reset = routingTimeOf(sample.resetsAt);
  // Yenilenmiş pencere artık geçerli değildir.
  if (reset !== null && reset <= now) return empty;
  const remaining = Math.max(0, Math.min(100, sample.remainingPercent));
  const base = {
    remainingPercent: Math.round(remaining * 10) / 10,
    windowLabel: sample.windowLabel || null,
    resetsAt: sample.resetsAt || null,
  };
  const measured = routingTimeOf(sample.measuredAt);
  const staleMs = typeof staleAfterMs === 'number' ? staleAfterMs : SUBAGENT_ROUTING_STALE_MS;
  const stale = measured === null || measured > now + 60000 || now - measured > staleMs;
  // Pencere içinde kullanım yalnızca artar: eski bir ölçüm bile doluluğu kanıtlar, boşluğu değil.
  if (remaining <= 1) return Object.assign({ state: 'exhausted' }, base);
  if (remaining < thresholdPercent) return Object.assign({ state: 'low' }, base);
  if (stale) return Object.assign({ state: 'unknown' }, base);
  return Object.assign({ state: 'ok' }, base);
}

function routingGlob(pattern) {
  const escaped = String(pattern)
    .trim()
    .toLowerCase()
    .replace(/[.+?^$()|[\]{}\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$');
}

function isScarceModel(model, patterns) {
  const value = String(model || '').trim().toLowerCase();
  if (!value) return false;
  return (patterns || []).some((pattern) => String(pattern || '').trim() && routingGlob(pattern).test(value));
}

function routingBaseModel(model) {
  return String(model || '')
    .trim()
    .toLowerCase()
    .replace(/-(low|medium|high|xhigh|max)$/, '');
}

function routingSameModel(a, b) {
  if (!a || !b) return false;
  return routingBaseModel(a) === routingBaseModel(b);
}

function routingEnabledTiers(policy) {
  return (policy && Array.isArray(policy.tiers) ? policy.tiers : []).filter((tier) => tier && tier.enabled);
}

function routingTierIndexOf(tiers, provider, model, tierId) {
  if (tierId) {
    const byId = tiers.findIndex((tier) => tier.id === tierId);
    if (byId >= 0) return byId;
  }
  if (!model) return -1;
  return tiers.findIndex((tier) =>
    tier.candidates.some(
      (candidate) =>
        candidate.enabled &&
        (!provider || candidate.provider === provider) &&
        routingSameModel(candidate.model, model)
    )
  );
}

function routingFormatTime(iso) {
  const time = routingTimeOf(iso);
  if (time === null) return null;
  const date = new Date(time);
  const pad = (n) => (n < 10 ? '0' : '') + n;
  return pad(date.getHours()) + ':' + pad(date.getMinutes());
}

function routingDescribe(label, headroom) {
  if (!headroom || headroom.remainingPercent === null) return label + ' has no usage data';
  const used = Math.round((100 - headroom.remainingPercent) * 10) / 10;
  const windowPart = headroom.windowLabel ? ' of its ' + headroom.windowLabel + ' window' : '';
  const reset = routingFormatTime(headroom.resetsAt);
  return label + ' is at ' + used + '%' + windowPart + (reset ? ', resets ' + reset : '');
}

function routingLabel(provider, model) {
  return model ? provider + '/' + model : provider;
}

function decideSubagentRoute(input) {
  const policy = input.policy || { thresholdPercent: 10, tiers: [], scarceModels: [] };
  const threshold = typeof policy.thresholdPercent === 'number' ? policy.thresholdPercent : 10;
  const tiers = routingEnabledTiers(policy);
  const request = input.request || {};
  const parent = input.parent || {};
  const installed = input.installed || {};
  const headroomCache = {};
  const headroomOf = (provider) => {
    if (!(provider in headroomCache)) {
      headroomCache[provider] = classifyHeadroom(
        (input.headroom || {})[provider],
        threshold,
        input.now,
        input.staleAfterMs
      );
    }
    return headroomCache[provider];
  };
  const requested = { provider: request.provider || null, model: request.model || null };
  const blockedByParent = (candidate) => {
    if (!policy.avoidParentScarceModels || !parent.provider) return false;
    if (!isScarceModel(candidate.model, policy.scarceModels)) return false;
    if (parent.model) return routingSameModel(candidate.model, parent.model);
    return candidate.provider === parent.provider;
  };
  const usable = (candidate) =>
    candidate &&
    candidate.enabled &&
    installed[candidate.provider] !== false &&
    !blockedByParent(candidate);
  // Katman sırası: önce aynı katman, sonra daha ucuz katmanlar (yakından uzağa). Asla yukarı çıkılmaz.
  const searchOrder = (tierIndex) => {
    const order = [];
    for (let i = tierIndex; i >= 0; i -= 1) order.push(i);
    return order;
  };
  const pickFrom = (tierIndex, filter) => {
    for (const wanted of ['ok', 'unknown']) {
      for (const index of searchOrder(tierIndex)) {
        for (const candidate of tiers[index].candidates) {
          if (!usable(candidate) || (filter && !filter(candidate))) continue;
          const headroom = headroomOf(candidate.provider);
          if (headroom.state === wanted) return { candidate, headroom, tier: tiers[index].id };
        }
      }
    }
    return null;
  };
  const result = (action, chosen, note) => ({
    action,
    provider: chosen ? chosen.candidate.provider : requested.provider,
    model: chosen ? chosen.candidate.model : requested.model,
    effort: chosen ? chosen.candidate.effort || null : request.effort || null,
    tier: chosen ? chosen.tier : null,
    requested,
    note,
    headroom: chosen ? chosen.headroom : requested.provider ? headroomOf(requested.provider) : null,
  });

  if (request.explicitModel && request.model) {
    const provider = request.provider || null;
    const headroom = provider ? headroomOf(provider) : null;
    if (!headroom || headroom.state === 'ok' || headroom.state === 'unknown') {
      return result('keep', null, null);
    }
    const tierIndex = routingTierIndexOf(tiers, provider, request.model, request.tier);
    const label = routingLabel(provider, request.model);
    const why = routingDescribe(label, headroom);
    if (tierIndex < 0) {
      return result(
        'no-alternative',
        null,
        'requested ' + label + ' kept: ' + why + ', and the model is not in the routing policy, so no equivalent is known'
      );
    }
    const chosen = pickFrom(
      tierIndex,
      // Kapasite sağlayıcı (hesap) düzeyindedir: aynı sağlayıcının başka modeli aynı havuzu kullanır.
      (candidate) => candidate.provider !== provider
    );
    if (!chosen) {
      return result(
        'no-alternative',
        null,
        'requested ' + label + ' kept: ' + why + ', and no equivalent or cheaper candidate has headroom'
      );
    }
    return result(
      'reroute',
      chosen,
      'requested ' + label + ', routed to ' + routingLabel(chosen.candidate.provider, chosen.candidate.model) + ' because ' + why
    );
  }

  // Model verilmedi: politika + kalan kapasiteyle seç.
  let tierIndex = -1;
  if (request.tier) tierIndex = tiers.findIndex((tier) => tier.id === request.tier);
  if (tierIndex < 0) tierIndex = tiers.findIndex((tier) => tier.id === 'execution');
  if (tierIndex < 0) tierIndex = tiers.length - 1;
  if (tierIndex < 0) return result('keep', null, null);
  const providerFilter = request.provider ? (candidate) => candidate.provider === request.provider : null;
  let chosen = pickFrom(tierIndex, providerFilter);
  let crossedProvider = false;
  if (!chosen && request.provider) {
    const own = headroomOf(request.provider);
    if (own.state === 'low' || own.state === 'exhausted') {
      chosen = pickFrom(tierIndex, null);
      crossedProvider = Boolean(chosen);
    }
  }
  if (!chosen) return result('keep', null, null);
  const target = routingLabel(chosen.candidate.provider, chosen.candidate.model);
  const tierLabel = (tiers.find((tier) => tier.id === chosen.tier) || {}).label || chosen.tier;
  const note = crossedProvider
    ? 'no model requested; ' + routingDescribe(request.provider, headroomOf(request.provider)) + ', so picked ' + target + ' from the ' + tierLabel + ' tier'
    : 'no model requested; picked ' + target + ' from the ' + tierLabel + ' tier (' + chosen.headroom.state + (chosen.headroom.remainingPercent !== null ? ', ' + chosen.headroom.remainingPercent + '% left' : '') + ')';
  return result('pick', chosen, note);
}

function annotateSubagentModels(input) {
  const policy = input.policy || { thresholdPercent: 10, tiers: [] };
  const threshold = typeof policy.thresholdPercent === 'number' ? policy.thresholdPercent : 10;
  const providers = {};
  for (const tier of policy.tiers || []) {
    for (const candidate of tier.candidates || []) {
      if (!(candidate.provider in providers)) {
        providers[candidate.provider] = classifyHeadroom(
          (input.headroom || {})[candidate.provider],
          threshold,
          input.now,
          input.staleAfterMs
        );
      }
    }
  }
  for (const provider of Object.keys(input.headroom || {})) {
    if (!(provider in providers)) {
      providers[provider] = classifyHeadroom(input.headroom[provider], threshold, input.now, input.staleAfterMs);
    }
  }
  const recommended = {};
  for (const tier of routingEnabledTiers(policy)) {
    const decision = decideSubagentRoute({
      request: { tier: tier.id, explicitModel: false },
      parent: input.parent,
      policy,
      headroom: input.headroom,
      now: input.now,
      staleAfterMs: input.staleAfterMs,
      installed: input.installed,
    });
    recommended[tier.id] =
      decision.action === 'pick' && decision.tier === tier.id
        ? { provider: decision.provider, model: decision.model, effort: decision.effort, headroom: decision.headroom }
        : null;
  }
  return { providers, recommended, thresholdPercent: threshold };
}
`;

/**
 * Değerlendirildiğinde saf fonksiyonları içeren nesneyi veren ifade. Yalnızca Node tarafında
 * `vm` ile değerlendirilir (bkz. `createSubagentRouter`); tarayıcıda kullanılmaz.
 */
export const SUBAGENT_ROUTER_EXPRESSION = `(function () {\n${SUBAGENT_ROUTING_SOURCE}\nreturn { classifyHeadroom, decideSubagentRoute, annotateSubagentModels, isScarceModel };\n})()`;
