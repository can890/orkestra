import { isDeepEqual } from '@orkestra/shared';
import { type LeasedLiveModelProvider } from '@orkestra/wire/rpc';
import { cell, expose, peek, produce, type Cell } from '@orkestra/wire/state';
import {
  hostMaintenanceContract,
  type HostMaintenanceRuntime,
  type HostMaintenanceState,
} from '../api/maintenance-contract';

/** Tüm uzak makinelerin bakım durumunu tek bir canlı modelde yayınlar. */
export class HostMaintenanceModel {
  readonly runtime: Cell<HostMaintenanceRuntime>;
  readonly host: LeasedLiveModelProvider<typeof hostMaintenanceContract.states>;

  constructor() {
    this.runtime = cell<HostMaintenanceRuntime>({});
    this.host = expose(hostMaintenanceContract.states, { runtime: this.runtime });
  }

  get(connectionId: string): HostMaintenanceState | undefined {
    return peek(this.runtime)[connectionId];
  }

  update(
    connectionId: string,
    next: (previous: HostMaintenanceState | undefined) => HostMaintenanceState
  ): void {
    const current = peek(this.runtime);
    const value = next(current[connectionId]);
    // Eşit bir değer yazmak yine de yama üretir; abonelere boş güncelleme gitmesin.
    if (isDeepEqual(current[connectionId], value)) return;
    this.runtime.set(
      produce(current, (runtime) => {
        runtime[connectionId] = value;
      })
    );
  }

  remove(connectionId: string): void {
    this.runtime.set(
      produce(peek(this.runtime), (runtime) => {
        delete runtime[connectionId];
      })
    );
  }

  dispose(): void {
    void this.host.dispose();
  }
}
