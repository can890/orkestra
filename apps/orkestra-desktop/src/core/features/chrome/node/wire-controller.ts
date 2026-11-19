import { createController, type Controller } from '@orkestra/wire/rpc';
import { chromeContract } from '@core/features/chrome/api/contract';
import type { ChromeBridgeService } from './chrome-bridge-service';
import type { ChromeExtensionOperations } from './chrome-extension-locator';

export type ChromeOperations = Pick<
  ChromeBridgeService,
  'getStatus' | 'configure' | 'revealToken' | 'rotateToken' | 'disconnect'
> &
  ChromeExtensionOperations;

export function createChromeWireController(chrome: ChromeOperations): Controller {
  return createController(chromeContract, {
    getStatus: () => chrome.getStatus(),
    configure: (patch) => chrome.configure(patch),
    revealToken: () => chrome.revealToken(),
    rotateToken: () => chrome.rotateToken(),
    disconnect: () => chrome.disconnect(),
    getExtensionInfo: () => chrome.getExtensionInfo(),
    revealExtensionFolder: () => chrome.revealExtensionFolder(),
    openChromeExtensionsPage: () => chrome.openChromeExtensionsPage(),
  });
}
