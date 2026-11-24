import { createController, type Controller } from '@orkestra/wire/rpc';
import { mcpAppsContract } from '../api/contract';
import type { McpAppsService } from './mcp-apps-service';

export function createMcpAppsWireController(service: McpAppsService): Controller {
  return createController(mcpAppsContract, {
    resolve: (input) => service.resolve(input),
    toolInfo: (input) => service.toolInfo(input),
    callTool: (input) => service.callTool(input),
    readResource: (input) => service.readResource(input),
  });
}
