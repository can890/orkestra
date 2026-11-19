import { defineUnit } from '@core/units';
import { Widget } from './Widget';
import { widgetHeight } from './widget-height-store';
import type { ChatWidget } from './widget-node';

/** Card border (2) + header (28). The iframe height comes on top of it. */
const WIDGET_CHROME_H = 30;

function widgetRowHeight(data: ChatWidget): number {
  return WIDGET_CHROME_H + widgetHeight(data.id)();
}

export const widgetUnitDef = defineUnit<ChatWidget, Record<string, never>>({
  kind: 'widget',
  margin: { top: 8, bottom: 8 },
  vars: {},
  estimate: (data) => widgetRowHeight(data),
  measure: (data) => widgetRowHeight(data),
  Render: (props) => <Widget data={props.data} />,
});
