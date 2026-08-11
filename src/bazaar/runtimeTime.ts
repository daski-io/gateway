export function bazaarNowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1_000));
}
