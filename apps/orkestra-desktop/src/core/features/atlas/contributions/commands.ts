import { defineCommand } from '@core/primitives/commands/api';

// Varsayılan kısayol yok: mevcut kısayollarla çakışmasın.
export const writeAtlasCardCommand = defineCommand({
  id: 'atlas.writeCard',
  title: 'Write Atlas card for this conversation',
  description: 'Summarize the active conversation and write it to Atlas with atlas kart',
  category: 'Conversations',
  icon: 'library',
});

export const toggleAtlasCardSkipCommand = defineCommand({
  id: 'atlas.toggleSkipCard',
  title: 'Toggle Atlas card for this conversation',
  description: 'Mark or unmark the active conversation as "no automatic Atlas card"',
  category: 'Conversations',
  icon: 'library',
});

export const ATLAS_COMMAND_DEFS = [writeAtlasCardCommand, toggleAtlasCardSkipCommand] as const;
