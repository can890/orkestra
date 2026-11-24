import { startMediaStdioServer } from '../cli-media/stdio-server';
import { HIGGSFIELD_SPEC } from './higgsfield-tools';

// Orkestra'nın konuşmalara eklediği stdio MCP sunucusu; `higgsfield` CLI'ını sarar.
if (process.env.ORKESTRA_MEDIA_BRIDGE_TEST !== '1')
  startMediaStdioServer(HIGGSFIELD_SPEC, 'higgsfield');
