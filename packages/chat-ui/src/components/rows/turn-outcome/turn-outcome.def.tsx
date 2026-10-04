import { ROW_H } from '@components/engine/row-metrics';
import { defineUnit } from '@core/units';
import type { TurnOutcomeItem } from '@/model';
import { vars } from '@styles/theme.css';

function outcomeLabel(item: TurnOutcomeItem): string {
  const reasons: Record<string, string> = {
    prompt_failed: 'İstek işlenemedi', process_closed: 'Ajan bağlantısı kapandı',
    spawn_failed: 'Ajan başlatılamadı', initialize_failed: 'Ajan bağlantısı kurulamadı',
    new_session_failed: 'Yeni sohbet açılamadı', load_session_failed: 'Sohbet geri yüklenemedi',
    cancel_failed: 'İstek durdurulamadı', set_config_failed: 'Ajan ayarı değiştirilemedi',
    set_mode_failed: 'İzin kipi değiştirilemedi', replaced: 'Başka bir oturuma geçildi',
    max_tokens: 'Yanıt uzunluğu sınırına ulaşıldı', max_turn_requests: 'İstek sınırına ulaşıldı',
    refusal: 'Ajan bu isteği yanıtlayamadı',
  };
  const reason = item.outcome.reason ? reasons[item.outcome.reason] : undefined;
  switch (item.outcome.kind) {
    case 'cancelled': return 'İstek iptal edildi';
    case 'error': return item.outcome.message || reason || 'Yanıt hazırlanırken hata oluştu';
    case 'interrupted': return reason || 'Yanıt yarıda kesildi';
    case 'done': return reason || 'Yanıt tamamlandı';
    default: return 'İstek tamamlandı';
  }
}

export const turnOutcomeUnitDef = defineUnit<TurnOutcomeItem, { rowH: number }>({
  kind: 'turn-outcome',
  margin: { top: 4, bottom: 4 },
  vars: { rowH: ROW_H },

  measure(_data, _ctx, vars_) {
    return vars_.rowH;
  },

  Render(props) {
    return (
      <div
        title={outcomeLabel(props.data)}
        style={{
          height: `${props.vars.rowH}px`,
          overflow: 'hidden',
          'white-space': 'nowrap',
          'text-overflow': 'ellipsis',
          display: 'flex',
          'align-items': 'center',
          color: props.data.outcome.kind === 'error' ? vars.fgError : vars.fgMuted,
          'font-size': '13px',
        }}
      >
        {outcomeLabel(props.data)}
      </div>
    );
  },
});
