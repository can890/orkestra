import { BoardStore } from '@core/features/board/browser/board-store';
import { boardLayoutMemento } from '@core/features/board/contributions/mementos';
import { getMementoClient } from '@core/primitives/mementos/browser';
import {
  contributeScopedStore,
  getAppStores,
  scopedStoreToken,
  type AppScopedStoreContribution,
} from '@core/primitives/scoped-stores/browser';
import { appSubject } from '@core/primitives/subjects/api';

const boardStoreToken = scopedStoreToken<BoardStore>('board.store');

export const boardAppStoreContributions: readonly AppScopedStoreContribution[] = [
  contributeScopedStore({
    token: boardStoreToken,
    create: () =>
      new BoardStore(() => getMementoClient().subject(appSubject({})).handle(boardLayoutMemento)),
  }),
];

/** Returns the app-scoped BoardStore. */
export function getBoardStore(): BoardStore {
  return getAppStores().get(boardStoreToken);
}
