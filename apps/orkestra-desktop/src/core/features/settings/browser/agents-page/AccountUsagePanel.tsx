import type { HostRef } from '@orkestra/core/primitives/host/api';
import React from 'react';
import { ProviderUsageCard } from '@core/features/usage-limits/contributions/browser/provider-usage-card';

const providers = ['claude', 'codex', 'kimi', 'glm', 'antigravity', 'grok'] as const;

export function AccountUsagePanel({ host }: { host: HostRef }) {
  return (
    <section className="space-y-3" aria-label="Hesap kredileri ve kullanım limitleri">
      <div>
        <h3 className="font-semibold">Hesap kredileri ve kullanım limitleri</h3>
        <p className="text-muted-foreground text-xs">
          {host.type === 'remote' ? 'Seçili uzak makinenin' : 'Bu Mac’in'} ajan oturumlarından
          alınır. Yüzdeler abonelik penceresinin kullanılan kısmını, bakiyeler sağlayıcının
          bildirdiği birimi gösterir. Değerler 3 dakika önbellekte tutulur; bir penceresi %90’ın
          üzerinde dolu olan ajanı Orkestra şefi, başka seçenek varken işçi olarak seçmez.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {providers.map((id) => (
          <ProviderUsageCard key={`${host.type}-${host.id}-${id}`} host={host} providerId={id} />
        ))}
      </div>
    </section>
  );
}
