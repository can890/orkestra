import { Icon } from '@orkestra/ui/react/primitives';
import { observer } from 'mobx-react-lite';
import { getLogHealthStore } from '../contributions/app-stores';

/**
 * Ayarlar gezinmesindeki Günlük sağlığı simgesi. Yeni tekrarlayan bir sorun
 * varken simgenin köşesinde küçük, sessiz bir nokta gösterir.
 */
export const LogHealthNavIcon = observer(function LogHealthNavIcon() {
  const attentionCount = getLogHealthStore().attentionCount;
  return (
    <span className="relative inline-flex">
      <Icon name="activity" size="sm" />
      {attentionCount > 0 ? (
        <span
          aria-label={`${attentionCount} yeni tekrarlayan sorun`}
          className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-foreground-warning"
        />
      ) : null}
    </span>
  );
});
