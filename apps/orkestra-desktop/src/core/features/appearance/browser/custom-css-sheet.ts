// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/web/src/themeCss.ts
//
// Kullanıcı CSS'i, belgenin kendi stillerinden SONRA sıralanan ayrı bir "adopted" stil
// sayfasına yazılır (bu sayfalar @import tutamaz). Tarayıcı metni ayrıştırdıktan sonra CSSOM
// üzerinden ikinci bir temizlik yapılır: kaçışlarla gizlenmiş url() de burada yakalanır.

import { cssValueFetches, sanitizeCustomCss, scopeCustomCss } from '../api/custom-css';

let sheet: CSSStyleSheet | null = null;
let applied = '';

type RuleParent = Pick<CSSStyleSheet, 'cssRules' | 'deleteRule'>;

const isRuleParent = (rule: CSSRule): rule is CSSRule & RuleParent =>
  'cssRules' in rule && 'deleteRule' in rule && !(rule instanceof CSSKeyframesRule);

function stripDeclarations(rule: CSSRule): boolean {
  if (!('style' in rule) || !(rule.style instanceof CSSStyleDeclaration)) return false;
  for (let item = rule.style.length - 1; item >= 0; item--) {
    const property = rule.style.item(item);
    if (cssValueFetches(rule.style.getPropertyValue(property))) {
      rule.style.removeProperty(property);
    }
  }
  return true;
}

/** Yalnızca denetleyebildiği kural biçimlerini tutar; yükleme yapabilen yeni bir at-kural düşer. */
function stripFetches(parent: RuleParent): void {
  for (let index = parent.cssRules.length - 1; index >= 0; index--) {
    const rule = parent.cssRules[index];
    if (!rule) continue;
    const hasStyle = stripDeclarations(rule);
    if (rule instanceof CSSKeyframesRule) {
      for (const frame of rule.cssRules) stripDeclarations(frame);
    } else if (isRuleParent(rule)) {
      stripFetches(rule);
    } else if (typeof CSSPropertyRule !== 'undefined' && rule instanceof CSSPropertyRule) {
      if (cssValueFetches(rule.initialValue ?? '')) parent.deleteRule(index);
    } else if (
      !hasStyle &&
      !(typeof CSSLayerStatementRule !== 'undefined' && rule instanceof CSSLayerStatementRule) &&
      !(rule instanceof CSSNamespaceRule)
    ) {
      parent.deleteRule(index);
    }
  }
}

/** Kullanıcı CSS'ini uygular (boş dize kaldırır). */
export function applyCustomCss(css: string): void {
  if (typeof document === 'undefined' || typeof CSSStyleSheet === 'undefined') return;
  const next = css.trim().length > 0 ? scopeCustomCss(sanitizeCustomCss(css).css) : '';
  if (next === applied) return;
  applied = next;
  if (!sheet) {
    sheet = new CSSStyleSheet();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }
  try {
    sheet.replaceSync(next);
    stripFetches(sheet);
  } catch {
    sheet.replaceSync('');
  }
}
