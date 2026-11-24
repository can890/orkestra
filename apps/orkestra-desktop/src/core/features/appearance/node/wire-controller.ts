import { createController, type Controller } from '@orkestra/wire/rpc';
import { appearanceContract } from '../api/contract';
import type { BackgroundImageStore } from './background-image-store';

export function createAppearanceWireController(store: BackgroundImageStore): Controller {
  return createController(appearanceContract, {
    saveBackgroundImage: (input) => store.save(input),
    readBackgroundImage: ({ fileName }) => store.read(fileName),
    pruneBackgroundImages: ({ keep }) => store.prune(keep),
  });
}
