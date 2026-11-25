import type { ToolNode } from './tool-calls';

/**
 * Daraltılmış araç grubunun arayüzde gösterilen özet satırı ("3 komut çalıştırıldı, bir dosya
 * okundu").
 *
 * İndirgeyici (`reducer/tool-runs.ts` → `toolRunLabel`) aynı özeti İngilizce parçalardan kurup
 * `tool-group.label` alanında veri olarak gönderir. Bu veri ana süreçte ya da uzak
 * workspace-server'da üretilir ve saklanır; derleme zamanı Türkçe yaması (`patch-tr.cjs`)
 * ona ulaşamaz, chat-ui paketi de küçültülmüş adlarla paketlendiği için yamanın ad kalıpları
 * orada çalışmaz. Bu yüzden görünen metin, grubun çocuklarından burada Türkçe olarak yeniden
 * hesaplanır (chat-ui satırı, alt ajan akışı ve Markdown dışa aktarımı aynı işlevi kullanır).
 * Saklanan `label` değişmez. Sayım kuralları `toolRunLabel` ile aynıdır.
 */
const TOOL_GROUP_PHRASES = {
  commands: (count: number) =>
    count === 1 ? 'bir komut çalıştırıldı' : `${count} komut çalıştırıldı`,
  files: (count: number) => (count === 1 ? 'bir dosya okundu' : `${count} dosya okundu`),
  searches: (count: number) => (count === 1 ? 'bir arama yapıldı' : `${count} arama yapıldı`),
  tools: (count: number) => (count === 1 ? 'bir araç kullanıldı' : `${count} araç kullanıldı`),
} as const;

export function toolGroupDisplayLabel(children: readonly Pick<ToolNode, 'kind'>[]): string {
  const counts = { commands: 0, files: 0, searches: 0, tools: 0 };
  for (const child of children) {
    switch (child.kind) {
      case 'execute-tool-call':
        counts.commands += 1;
        break;
      case 'read-tool-call':
        counts.files += 1;
        break;
      case 'search-tool-call':
        counts.searches += 1;
        break;
      default:
        counts.tools += 1;
    }
  }
  const parts = (Object.keys(TOOL_GROUP_PHRASES) as Array<keyof typeof counts>)
    .filter((key) => counts[key] > 0)
    .map((key) => TOOL_GROUP_PHRASES[key](counts[key]));
  const text = parts.join(', ');
  return text.charAt(0).toLocaleUpperCase('tr-TR') + text.slice(1);
}
