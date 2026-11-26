/**
 * Table — Solid component rendering a TableLaidOut block.
 *
 * Uses BlockFrame (not MeasuredBlockFrame) because the height is fully
 * determined by the formula in layoutTable — no DOM write-back needed.
 *
 * Pretext-measured column widths are projected through <colgroup> and fixed
 * table layout. Wide tables scroll horizontally inside the wrapper without
 * making the DOM a second source of geometry.
 *
 * Each cell receives a native `title` attribute so the full content is
 * accessible on hover via the browser tooltip.
 *
 * Geometry-coupled rules (cell padding, font-size, line-height) stay alongside
 * the layout constants so the virtualizer's reserved height matches the DOM.
 */

import { BlockFrame } from '@components/engine/block-frame';
import type { TableLaidOut } from '@core/layout/layout-types';
import { Index } from 'solid-js';
import { tableScroll, tdCell, tdCellLastRow, thCell } from './table-visual.css';
import { pchatTable } from './table.css';

export type TableProps = {
  block: TableLaidOut;
};

export function Table(props: TableProps) {
  return (
    <BlockFrame layout={props.block}>
      <div class={tableScroll}>
        <table
          class={pchatTable}
          style={{ width: `${props.block.tableWidth}px`, 'table-layout': 'fixed' }}
        >
          <colgroup>
            <Index each={props.block.colWidths}>
              {(w) => <col style={{ width: `${w()}px` }} />}
            </Index>
          </colgroup>
          <thead>
            <tr>
              <Index each={props.block.header}>
                {(cell) => (
                  <th class={thCell} title={cell()}>
                    {cell()}
                  </th>
                )}
              </Index>
            </tr>
          </thead>
          <tbody>
            <Index each={props.block.rows}>
              {(row, i) => (
                <tr>
                  <Index each={row()}>
                    {(cell) => (
                      <td
                        class={`${tdCell}${i === props.block.rows.length - 1 ? ` ${tdCellLastRow}` : ''}`}
                        title={cell()}
                      >
                        {cell()}
                      </td>
                    )}
                  </Index>
                </tr>
              )}
            </Index>
          </tbody>
        </table>
      </div>
    </BlockFrame>
  );
}
