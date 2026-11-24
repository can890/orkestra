import type { ManagedPolicySummary } from '@orkestra/shared/managed-policy';
import { defineContract, procedure } from '@orkestra/wire/rpc';
import { z } from 'zod';

// Yönetilen politika (yöneticinin dağıttığı ayar/kısıt dosyası) için salt-okur sözleşme.
// Politika yalnızca açılışta okunur; renderer neyin yönetildiğini göstermek için sorar.

export const managedPolicyDomain = 'managedPolicy' as const;

export const managedPolicyContract = defineContract({
  /** Bu sürecin yüklediği politikanın özeti; politika yoksa `null`. */
  getSummary: procedure({
    input: z.void(),
    output: z.custom<ManagedPolicySummary | null>(),
  }),
});
