import { getAddress } from "viem";

export function assertListingRoleSeparation(
  providerAuthorityKey: string,
  providerPayee: string,
  daskiCommissionReceiver: string,
): void {
  const commission = getAddress(daskiCommissionReceiver).toLowerCase();
  const providerRoles = [providerAuthorityKey, providerPayee]
    .map((value) => getAddress(value).toLowerCase());
  if (providerRoles.includes(commission)) {
    throw new Error("Daski commission receiver must be distinct from provider authority and payee");
  }
}
