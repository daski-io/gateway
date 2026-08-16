import { BlockList, isIP } from "node:net";

const nonPublicV4 = new BlockList();
const nonPublicV6 = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) nonPublicV4.addSubnet(network, prefix, "ipv4");

for (const [network, prefix] of [
  ["::", 96], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
  ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16],
  ["3fff::", 20], ["5f00::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) nonPublicV6.addSubnet(network, prefix, "ipv6");

/** Reject addresses that signed external profiles must never reach. */
export function isNonPublicAddress(input: string): boolean {
  const address = input.replace(/^\[|\]$/g, "");
  const family = isIP(address);
  if (family === 0) return true;
  return family === 4
    ? nonPublicV4.check(address, "ipv4")
    : nonPublicV6.check(address, "ipv6");
}
