export interface MachineLoadCandidate {
  id: string;
  connected: boolean;
  cpuPercent?: number | null;
  memoryPercent?: number | null;
}

export function computeMachineLoadScore(candidate: MachineLoadCandidate): number {
  const cpu = typeof candidate.cpuPercent === 'number' && Number.isFinite(candidate.cpuPercent)
    ? Math.max(0, candidate.cpuPercent)
    : 50;
  const mem =
    typeof candidate.memoryPercent === 'number' && Number.isFinite(candidate.memoryPercent)
      ? Math.max(0, candidate.memoryPercent)
      : 50;
  return cpu * 0.6 + mem * 0.4;
}

/**
 * Bağlı uzak makineler arasında en düşük bileşik CPU/RAM yüküne sahip makine kimliğini seçer.
 */
export function pickLeastLoadedMachine(
  candidates: readonly MachineLoadCandidate[]
): string | null {
  const measuredConnected = candidates.filter(
    (c) =>
      c.connected &&
      typeof c.cpuPercent === 'number' &&
      Number.isFinite(c.cpuPercent) &&
      typeof c.memoryPercent === 'number' &&
      Number.isFinite(c.memoryPercent)
  );
  if (measuredConnected.length === 0) return null;

  let best = measuredConnected[0]!;
  let bestScore = computeMachineLoadScore(best);
  for (let i = 1; i < measuredConnected.length; i += 1) {
    const candidate = measuredConnected[i]!;
    const score = computeMachineLoadScore(candidate);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best.id;
}
