import { PageLayout } from '@emdash/ui/react/patterns';
import IntegrationsCard from '../components/IntegrationsCard';

export function IntegrationsSettingsPage() {
  return (
    <div className="space-y-8">
      <PageLayout.Header
        sticky
        title="Entegrasyonlar"
        description="GitHub ve uygulama bağlantılarınızı yönetin; ajanlarınıza yeni servisler ekleyin."
      />
      <IntegrationsCard />
    </div>
  );
}
