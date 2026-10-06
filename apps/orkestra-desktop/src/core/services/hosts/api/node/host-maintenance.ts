import type { PruneResult, ServerActivity } from '../maintenance-contract';

/** Bir uzak makinenin workspace-server bakım işlemleri; durum `hostMaintenance.states` ile yayınlanır. */
export interface HostMaintenance {
  check(): Promise<void>;
  inspectActivity(): Promise<ServerActivity>;
  updateNow(): Promise<void>;
  inspectHealth(): Promise<void>;
  prune(): Promise<PruneResult>;
}
