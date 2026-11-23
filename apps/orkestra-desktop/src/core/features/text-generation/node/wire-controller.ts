import { createController, type Controller } from '@orkestra/wire/rpc';
import { textGenerationContract } from '../api/contract';
import type { TextGenerationService } from './text-generation-service';

export function createTextGenerationWireController(service: TextGenerationService): Controller {
  return createController(textGenerationContract, {
    getStatus: () => service.getStatus(),
    setApiKey: ({ apiKey }) => service.setApiKey(apiKey),
    clearApiKey: () => service.clearApiKey(),
    testConnection: () => service.testConnection(),
    listModels: () => service.listModels(),
    generateText: (input) => service.generateText(input),
    generatePromptSuggestions: (input) => service.generatePromptSuggestions(input),
  });
}
