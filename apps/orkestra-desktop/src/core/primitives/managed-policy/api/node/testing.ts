import { summarizeManagedPolicy, validateManagedPolicy } from '@orkestra/shared/managed-policy';
import { setActiveManagedPolicy } from './active-policy';

/** Testler için: belgeden etkin politikayı kurar (dosya okumadan). */
export function activateManagedPolicyForTest(document: Record<string, unknown>): void {
  const result = validateManagedPolicy(
    { schemaVersion: 1, organization: 'Example Corp', ...document },
    { source: '/test/policy.json' }
  );
  if (!result.success) throw new Error(result.error.reason);
  const meta = { source: '/test/policy.json', fingerprint: 'abc123abc123' };
  setActiveManagedPolicy({
    ...meta,
    policy: result.data,
    summary: summarizeManagedPolicy(result.data, meta),
  });
}
