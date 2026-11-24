// T3 Code'dan uyarlandı (MIT, © 2026 T3 Tools Inc.) — kaynak: apps/server/src/cli/policy.ts
//
// `orkestra-workspace-server policy check <file> | show | settings`.
import { MANAGEABLE_SETTINGS } from '@orkestra/shared/managed-policy';
import {
  describeLoadedManagedPolicy,
  describeRunningHostPolicy,
  loadManagedPolicyFile,
  readLoadedManagedPolicyState,
  readManagedPolicy,
  type ManagedPolicyFs,
  type ReadManagedPolicyOptions,
  type LoadedManagedPolicyState,
} from '@orkestra/shared/managed-policy/node';

export type PolicyCliDeps = {
  homeDirectory: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Kaynaktan çalışırken `ORKESTRA_MANAGED_POLICY_PATH` dikkate alınır. */
  allowPathOverride: boolean;
  knownProviderIds: readonly string[];
  fs?: ManagedPolicyFs;
  convertPlistToJson?: ReadManagedPolicyOptions['convertPlistToJson'];
  readLoadedState?: (home: string) => Promise<LoadedManagedPolicyState | null>;
  isProcessAlive?: (pid: number) => boolean;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

const USAGE = `Usage: orkestra-workspace-server policy <command>

Commands:
  check <file>   Validate a policy file and print what it will do
  show           Show the policy installed on this machine and whether the running host loaded it
  settings       List the settings a policy can manage
`;

export async function runPolicyCli(argv: readonly string[], deps: PolicyCliDeps): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'check':
      return check(rest, deps);
    case 'show':
      return show(deps);
    case 'settings':
      return settings(deps);
    case 'help':
    case '--help':
    case '-h':
      deps.stdout(USAGE);
      return 0;
    default:
      deps.stderr(command ? `Unknown policy command '${command}'.\n\n${USAGE}` : USAGE);
      return 2;
  }
}

async function check(args: readonly string[], deps: PolicyCliDeps): Promise<number> {
  const [file] = args;
  if (!file || args.length > 1) {
    deps.stderr(`policy check takes exactly one file.\n\n${USAGE}`);
    return 2;
  }
  const result = await loadManagedPolicyFile(file, {
    knownProviderIds: deps.knownProviderIds,
    ...(deps.fs ? { fs: deps.fs } : {}),
  });
  if (result.kind === 'none') {
    // Açılışta eksik dosya "politika yok" demektir; burada olmayan bir taslak hiçbir şey denetlemez.
    deps.stderr(`No policy file at ${file}.\n`);
    return 1;
  }
  if (result.kind === 'error') {
    deps.stderr(`${result.message}\n`);
    return 1;
  }
  deps.stdout(describeLoadedManagedPolicy(result.loaded));
  deps.stdout('\nThe policy is valid. Deploy it, then restart Orkestra on the machine.\n');
  return 0;
}

async function show(deps: PolicyCliDeps): Promise<number> {
  const result = await readManagedPolicy({
    platform: deps.platform,
    env: deps.env,
    allowPathOverride: deps.allowPathOverride,
    knownProviderIds: deps.knownProviderIds,
    ...(deps.fs ? { fs: deps.fs } : {}),
    ...(deps.convertPlistToJson ? { convertPlistToJson: deps.convertPlistToJson } : {}),
  });
  const state = await (deps.readLoadedState ?? readLoadedManagedPolicyState)(deps.homeDirectory);
  if (result.kind === 'error') {
    deps.stderr(`${result.message}\n`);
    return 1;
  }
  if (result.kind === 'none') {
    deps.stdout(
      `No managed policy on this machine (looked in ${result.searched.join(', ')}). Every setting belongs to the user.\n`
    );
  } else {
    deps.stdout(describeLoadedManagedPolicy(result.loaded));
  }
  deps.stdout(
    `\n${describeRunningHostPolicy(
      state,
      result.kind === 'loaded' ? result.loaded.fingerprint : null,
      deps.isProcessAlive
    )}\n`
  );
  return 0;
}

function settings(deps: PolicyCliDeps): number {
  const rows = Object.entries(MANAGEABLE_SETTINGS).map(
    ([path, entry]) => `  ${path.padEnd(36)} ${entry.description}`
  );
  deps.stdout(`Settings a policy can manage:\n${rows.join('\n')}\n`);
  return 0;
}
