import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, stringToHex, type Hex } from "viem";
import { decryptCursor } from "../src/standardRail/cursor.js";
import { providerIdentitySnapshotHash } from "../src/standardRail/canonical.js";
import {
  deriveActionExecutionId,
  utf8Hash,
  walletAuthorizationHash,
} from "../src/standardRail/walletAuthorization.js";
import type { ProviderIdentitySnapshotV1, WalletActionAuthorizationV1 } from "../src/standardRail/types.js";

const vector = JSON.parse(readFileSync(
  new URL("./vectors/managed-marketplace-v1.json", import.meta.url),
  "utf8",
));

describe("managed marketplace golden vectors", () => {
  it("pins every shared type string and hash", () => {
    for (const [name, value] of Object.entries(vector.typeStrings)) {
      expect(utf8Hash(value as string), name).toBe(vector.typeHashes[name]);
    }
  });

  it("pins wallet, execution, identity, and payment identities", () => {
    const message = vector.walletAuthorization.message as WalletActionAuthorizationV1;
    const walletHash = walletAuthorizationHash(message, vector.domains.wallet.chainId);
    expect(walletHash).toBe(vector.walletAuthorization.digest);
    expect(deriveActionExecutionId({
      walletAuthorizationHash: walletHash,
      providerAgentId: BigInt(message.providerAgentId),
      serviceId: message.serviceId,
      providerControlProfileHash: message.providerControlProfileHash,
      servicingAdmissionHash: message.servicingAdmissionHash,
      actionCatalogHash: message.actionCatalogHash,
      actionCatalogSchemaHash: message.actionCatalogSchemaHash,
      actionCatalogEpoch: BigInt(message.actionCatalogEpoch),
      actionDefinitionHash: message.actionDefinitionHash,
      requestHash: message.requestHash,
    })).toBe(vector.walletAuthorization.actionExecutionId);
    expect(providerIdentitySnapshotHash(
      vector.identitySnapshot.value as ProviderIdentitySnapshotV1,
      vector.domains.wallet.chainId,
    )).toBe(vector.identitySnapshot.hash);
    expect(keccak256(stringToHex(vector.orderKeys.orderId))).toBe(vector.orderKeys.orderKey);
    expect(keccak256(encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" }],
      [BigInt(vector.domains.wallet.chainId), vector.orderKeys.canonicalToken,
        message.payer, vector.orderKeys.paymentNonce],
    ))).toBe(vector.orderKeys.authorizationKey);
  });

  it("decrypts the opaque cursor and rejects associated-data drift", () => {
    const keyRing = {
      activeKeyId: vector.cursor.keyId,
      keys: new Map([[vector.cursor.keyId, Buffer.from(vector.cursor.keyHex, "hex")]]),
    };
    expect(decryptCursor({
      token: vector.cursor.token,
      binding: vector.cursor.binding,
      keyRing,
      now: vector.cursor.plaintext.issuedAt,
    })).toEqual(vector.cursor.plaintext.last);
    expect(() => decryptCursor({
      token: vector.cursor.token,
      binding: { ...vector.cursor.binding, payer: `0x${"12".repeat(20)}` as Hex },
      keyRing,
      now: vector.cursor.plaintext.issuedAt,
    })).toThrow("invalid cursor");
  });
});
