import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import { encodeAbiParameters, parseAbiParameters } from "viem";
import type { Config } from "../config.js";
import type { ChainReader } from "../chain/reader.js";
import type { Eip712TypedData, Hex } from "../types.js";
import { logErrorWithId } from "../util/errorWrap.js";

// Wallet-agnostic helpers that pre-bake the EIP-712 typed-data the agent's
// wallet needs to sign. The agent passes the returned block straight to its
// wallet's generic signTypedData tool — no schema knowledge required on the
// client side. Both endpoints are stateless reads (or cheap chain reads).

export interface PrepDeps {
  config: Config;
  reader: ChainReader;
}

// ── EAS buyer-confirmation Attest typed-data ──────────────────────────────

const ATTEST_TYPES = {
  Attest: [
    { name: "schema", type: "bytes32" },
    { name: "recipient", type: "address" },
    { name: "expirationTime", type: "uint64" },
    { name: "revocable", type: "bool" },
    { name: "refUID", type: "bytes32" },
    { name: "data", type: "bytes" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

const EAS_DOMAIN_NAME = "EAS";
const EAS_DOMAIN_VERSION = "1.2.0";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Hex;
const BYTES32_ZERO: Hex = ("0x" + "00".repeat(32)) as Hex;

const CONFIRMATION_PAYLOAD_TYPES = parseAbiParameters(
  "uint256 paymentId, uint8 confirmation",
);

const CONFIRMATION_CODE = {
  Confirmed: 1,
  NotConfirmed: 2,
} as const;
type ConfirmationLabel = keyof typeof CONFIRMATION_CODE;

function isHexAddress(x: unknown): x is Hex {
  return typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x);
}

function isHex32(x: unknown): x is Hex {
  return typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x);
}

// ── Router ────────────────────────────────────────────────────────────────

export function createPrepRouter(deps: PrepDeps): Router {
  const router = Router();

  /**
   * GET /confirm-prep/:paymentId?confirmation=Confirmed&attester=0x..&deadlineSeconds=3600&refUid=0x..
   * Returns the EAS Attest typed-data the buyer's wallet should sign.
   * After signing, the agent calls POST /confirm/:paymentId with the
   * { v, r, s } extracted from the signature.
   */
  router.get("/confirm-prep/:paymentId", async (req: Request, res: Response) => {
    let paymentId: bigint;
    try {
      paymentId = BigInt(String(req.params.paymentId));
    } catch {
      res.status(400).json({
        error: { code: "BAD_PAYMENT_ID", message: "paymentId must be numeric" },
      });
      return;
    }

    const confirmation = String(req.query.confirmation ?? "");
    if (confirmation !== "Confirmed" && confirmation !== "NotConfirmed") {
      res.status(400).json({
        error: {
          code: "BAD_CONFIRMATION",
          message: 'confirmation must be "Confirmed" or "NotConfirmed"',
        },
      });
      return;
    }

    const attesterRaw = String(req.query.attester ?? "");
    if (!isHexAddress(attesterRaw)) {
      res.status(400).json({
        error: {
          code: "BAD_ATTESTER",
          message: "attester must be a 20-byte hex address",
        },
      });
      return;
    }
    const attester = attesterRaw.toLowerCase() as Hex;

    const refUidRaw = req.query.refUid ? String(req.query.refUid) : undefined;
    if (refUidRaw && !isHex32(refUidRaw)) {
      res.status(400).json({
        error: {
          code: "BAD_REFUID",
          message: "refUid must be a 32-byte hex string",
        },
      });
      return;
    }
    const refUID = (refUidRaw ?? BYTES32_ZERO) as Hex;

    const deadlineSecondsRaw = req.query.deadlineSeconds
      ? Number(req.query.deadlineSeconds)
      : 3600;
    if (!Number.isFinite(deadlineSecondsRaw) || deadlineSecondsRaw <= 0) {
      res.status(400).json({
        error: {
          code: "BAD_DEADLINE",
          message: "deadlineSeconds must be a positive number",
        },
      });
      return;
    }

    let nonce: bigint;
    try {
      nonce = await deps.reader.getEasAttesterNonce(attester);
    } catch (err) {
      const correlationId = logErrorWithId("easGetNonce", err);
      res.status(502).json({
        error: {
          code: "CHAIN_READ_FAILED",
          message: "chain read failed",
          correlationId,
        },
      });
      return;
    }

    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const deadline = nowSec + BigInt(Math.floor(deadlineSecondsRaw));

    const data = encodeAbiParameters(CONFIRMATION_PAYLOAD_TYPES, [
      paymentId,
      CONFIRMATION_CODE[confirmation as ConfirmationLabel],
    ]);

    const typedData: Eip712TypedData = {
      domain: {
        name: EAS_DOMAIN_NAME,
        version: EAS_DOMAIN_VERSION,
        chainId: deps.config.chainId,
        verifyingContract: deps.config.easAddress,
      },
      types: {
        Attest: ATTEST_TYPES.Attest.map((f) => ({ name: f.name, type: f.type })),
      },
      primaryType: "Attest",
      message: {
        schema: deps.config.easConfirmationSchemaUid,
        recipient: ZERO_ADDRESS,
        expirationTime: "0",
        // viem's signTypedData strictly validates `bool`-typed fields and
        // rejects the string "true" / "false" forms — must be a real JSON
        // boolean. Other numeric fields stay strings because they're
        // uint256/uint64 and JS numbers can't safely hold those ranges.
        revocable: true,
        refUID,
        data,
        value: "0",
        nonce: nonce.toString(),
        deadline: deadline.toString(),
      },
    };

    res.json({
      paymentId: paymentId.toString(),
      confirmation,
      attester,
      deadline: deadline.toString(),
      refUid: refUidRaw ?? null,
      eip712TypedData: typedData,
      // What the agent sends to /confirm/:paymentId after signing. Contains
      // every field except the signature; agent fills that in from its
      // wallet's signTypedData result.
      submitTemplate: {
        confirmation,
        attester,
        deadline: deadline.toString(),
        refUid: refUidRaw ?? undefined,
        // signature: { v, r, s }  ← agent fills from wallet
      },
    });
  });

  // POST /capability-prep/dns moved to the provider in v4 — see
  // adapters/domainManagement/skills/prepareDnsCapability.ts. Reach it
  // via daski_submit_task with skillId="prepare-dns-capability".

  return router;
}
