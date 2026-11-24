import { promptStashMemento } from '@core/features/conversations/contributions/mementos';
import { getMementoClient } from '@core/primitives/mementos/browser';
import { appSubject } from '@core/primitives/subjects/api';
import { PromptStashStore } from './prompt-stash-store';

let singleton: PromptStashStore | null = null;

/** Uygulama geneli zula; ilk çağrıda uygulama konusundaki memento tutamacını açar. */
export function getPromptStashStore(): PromptStashStore {
  if (singleton) return singleton;
  const handle = getMementoClient().subject(appSubject({})).handle(promptStashMemento);
  singleton = new PromptStashStore(handle);
  return singleton;
}
