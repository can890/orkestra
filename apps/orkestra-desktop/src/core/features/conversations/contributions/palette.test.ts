import { describe, expect, it } from 'vitest';
import { COMMAND_PALETTE_CATALOG } from '@core/manifests/shared/command-palette-catalog';
import { moveToNewContextCommand } from './commands';
import { CONVERSATION_COMMAND_PALETTE_ITEMS } from './palette';

describe('conversation command palette items', () => {
  it('lists the context handoff in the palette catalog', () => {
    // Regresyon: komut tanımlıydı ama palet kataloğuna eklenmediği için palette hiç çıkmıyordu.
    const item = COMMAND_PALETTE_CATALOG.byCommandId(moveToNewContextCommand.id);
    expect(item).toBeDefined();
    expect(item?.command.id).toBe('conversations.moveToNewContext');
    expect(COMMAND_PALETTE_CATALOG.items).toContain(CONVERSATION_COMMAND_PALETTE_ITEMS[0]);
  });

  it('can be found by the Turkish words a user would type', () => {
    const aliases = CONVERSATION_COMMAND_PALETTE_ITEMS[0].aliases ?? [];
    expect(aliases).toEqual(expect.arrayContaining(['bağlam devri', 'yeni sohbete taşı']));
  });
});
