import { readFile } from 'node:fs/promises';
import ssh2 from 'ssh2';
import { resolveSshConfig } from '../config/resolve-ssh-config';
import { findSshConfigHostByHostName, parseSshConfigFile } from '../config/sshConfigParser';
import type { SshCredentialService } from '../credentials/ssh-credential-service';
import { spawnProxyCommand, spawnProxyJump } from '../transport/transports';
import type { HostKeyVerificationDeps } from './host-key-verifier';
import {
  createSshConnectConfigResolver,
  type SshConnectInput,
  type SshConnectResult,
} from './resolve-ssh-connect-config';

const { createAgent } = ssh2;

type ConnectCredentials = Pick<SshCredentialService, 'getPassword' | 'getPassphrase'>;

async function findSshConfigByHostName(hostname: string) {
  const hosts = await parseSshConfigFile();
  const match = findSshConfigHostByHostName(hosts, hostname);
  return match ? await resolveSshConfig(match.host).catch(() => undefined) : undefined;
}

/** Host key verification is required: production connections never accept unknown keys silently. */
export function createProductionSshConnectConfigResolver(
  credentials: ConnectCredentials,
  hostKeys: HostKeyVerificationDeps
) {
  return createSshConnectConfigResolver({
    readFile,
    getPassword: (connectionId, identity) => credentials.getPassword(connectionId, identity),
    getPassphrase: (connectionId, identity) => credentials.getPassphrase(connectionId, identity),
    resolveSshConfig,
    findSshConfigByHostName,
    spawnProxyCommand,
    spawnProxyJump,
    createAgent,
    env: process.env,
    hostKeys,
  });
}

export async function resolveProductionSshConnectConfig(
  input: SshConnectInput,
  credentials: ConnectCredentials,
  hostKeys: HostKeyVerificationDeps
): Promise<SshConnectResult> {
  return await createProductionSshConnectConfigResolver(credentials, hostKeys)(input);
}

export type { SshConnectInput, SshConnectResult };
