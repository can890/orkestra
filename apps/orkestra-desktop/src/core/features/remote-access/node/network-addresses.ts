/** `os.networkInterfaces()` çıktısının kullandığımız kısmı. */
export type NetworkInterfaceMap = Record<
  string,
  ReadonlyArray<{ address: string; family: string | number; internal: boolean }> | undefined
>;

// Konteyner/sanal makine köprüleri telefondan erişilemez; aday listesini kirletir.
const VIRTUAL_INTERFACE = /^(docker|br-|veth|vmnet|vboxnet|vethernet|virbr|lxc|cni|flannel)/i;

function parseIpv4(address: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!match) return null;
  const parts = match.slice(1).map(Number) as [number, number, number, number];
  return parts.every((part) => part <= 255) ? parts : null;
}

/** Tailscale CGNAT aralığı: 100.64.0.0/10. */
export function isTailscaleAddress(address: string): boolean {
  const ip = parseIpv4(address);
  return ip !== null && ip[0] === 100 && ip[1] >= 64 && ip[1] <= 127;
}

function isPrivateLan(address: string): boolean {
  const ip = parseIpv4(address);
  if (!ip) return false;
  return (
    ip[0] === 10 ||
    (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) ||
    (ip[0] === 192 && ip[1] === 168)
  );
}

/**
 * QR'a girecek aday IPv4 adresleri: önce özel LAN adresleri, sonra Tailscale, sonra diğerleri.
 * Loopback ve link-local (169.254/16) adresler ve sanal köprüler dışarıda kalır.
 */
export function candidateAddresses(interfaces: NetworkInterfaceMap, limit = 6): string[] {
  const lan: string[] = [];
  const tailscale: string[] = [];
  const other: string[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    if (VIRTUAL_INTERFACE.test(name)) continue;
    for (const entry of entries ?? []) {
      const isV4 = entry.family === 'IPv4' || entry.family === 4;
      if (!isV4 || entry.internal) continue;
      const ip = parseIpv4(entry.address);
      if (!ip || (ip[0] === 169 && ip[1] === 254) || ip[0] === 127) continue;
      if (isTailscaleAddress(entry.address)) tailscale.push(entry.address);
      else if (isPrivateLan(entry.address)) lan.push(entry.address);
      else other.push(entry.address);
    }
  }
  return [...new Set([...lan, ...tailscale, ...other])].slice(0, limit);
}
