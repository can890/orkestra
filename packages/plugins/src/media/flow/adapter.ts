import { defineAdapterAsset } from '../../agents/helpers/adapter-assets';

export const flowAdapter = defineAdapterAsset({
  name: 'flow-mcp',
  specifier: '@orkestra/plugins/media/flow-mcp',
  format: 'esm',
});
