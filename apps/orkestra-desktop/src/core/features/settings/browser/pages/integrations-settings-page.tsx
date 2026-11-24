import { PageLayout } from '@orkestra/ui/react/patterns';
import { MediaProvidersCard } from '@core/features/media-providers/contributions/browser/media-providers-card';
import { SecretsSettingsCard } from '@core/features/secrets/contributions/browser/secrets-settings-card';
import IntegrationsCard from '../components/IntegrationsCard';

export function IntegrationsSettingsPage() {
  return (
    <div className="space-y-8 pb-10">
      <PageLayout.Header
        sticky
        title="Entegrasyonlar"
        description="GitHub, uygulama bağlantıları ve gizli anahtar çözücülerinizi yönetin."
      />
      <IntegrationsCard />
      <MediaProvidersCard />
      <SecretsSettingsCard />
    </div>
  );
}
