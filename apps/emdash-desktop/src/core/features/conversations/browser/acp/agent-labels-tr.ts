const AGENT_LABELS_TR: Record<string, string> = {
  "Default": "Varsayılan",
  "Default (recommended)": "Varsayılan (önerilen)",
  "Low": "Düşük",
  "Medium": "Orta",
  "High": "Yüksek",
  "Xhigh": "Çok yüksek",
  "Extra high": "Çok yüksek",
  "Max": "En yüksek",
  "Ultra": "Ultra",
  "Auto": "Otomatik",
  "Plan": "Plan",
  "Accept edits": "Düzenlemeleri onayla",
  "Auto-approve": "Otomatik onay",
  "Bypass permissions": "İzinleri atla",
  "Read-only": "Salt okunur",
  "Full access": "Tam erişim",
  "Allow once": "Bir kez izin ver",
  "Allow always": "Her zaman izin ver",
  "Always allow": "Her zaman izin ver",
  "Reject": "Reddet",
  "Deny": "Reddet",
  "Permission mode": "İzin kipi",
  "Reasoning effort": "Düşünme düzeyi"
};

export function localizeAgentLabel(value: string): string;
export function localizeAgentLabel(value: string | undefined): string | undefined;
export function localizeAgentLabel(value: string | undefined): string | undefined {
  return value === undefined ? undefined : (AGENT_LABELS_TR[value] ?? value);
}
