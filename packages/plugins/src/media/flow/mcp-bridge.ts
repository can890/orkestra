import { startMediaStdioServer } from '../cli-media/stdio-server';
import { FLOW_SPEC } from './flow-tools';

// Orkestra'nın konuşmalara eklediği stdio MCP sunucusu; `gflow` CLI'ını sarar.
if (process.env.ORKESTRA_MEDIA_BRIDGE_TEST !== '1') startMediaStdioServer(FLOW_SPEC, 'gflow');
