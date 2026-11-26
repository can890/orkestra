import { defineUnit } from '@core/units';
import { vars } from '@styles/theme.css';
import type { VisitWatermarkItem } from '@/model';

export const visitWatermarkUnitDef = defineUnit<VisitWatermarkItem, { rowH: number }>({
  kind: 'visit-watermark',
  margin: { top: 10, bottom: 10 },
  vars: { rowH: 24 },

  measure(_data, _ctx, vars_) {
    return vars_.rowH;
  },

  Render(props) {
    return (
      <div
        data-visit-watermark="true"
        style={{
          height: `${props.vars.rowH}px`,
          display: 'flex',
          'align-items': 'center',
          gap: '10px',
          'user-select': 'none',
          width: '100%',
        }}
      >
        <div
          style={{
            flex: '1 1 0%',
            height: '1px',
            background: vars.link,
            opacity: 0.45,
          }}
        />
        <span
          style={{
            'font-size': '11px',
            'font-weight': 500,
            'letter-spacing': '0.02em',
            color: vars.link,
            'white-space': 'nowrap',
          }}
        >
          {props.data.label ?? 'Yeni mesajlar'}
        </span>
        <div
          style={{
            flex: '1 1 0%',
            height: '1px',
            background: vars.link,
            opacity: 0.45,
          }}
        />
      </div>
    );
  },
});
