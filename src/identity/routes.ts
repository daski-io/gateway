import { Router, type Request, type Response } from "express";
import type { ChainReader } from "../chain/reader.js";
import type { Config } from "../config.js";
import type { Eip712TypedData, Hex } from "../types.js";
import { defaultBuyerAgentURI } from "../mcp/util.js";
import { logErrorWithId } from "../util/errorWrap.js";

export interface IdentityDeps {
  config: Config;
  reader: ChainReader;
}

function isHexAddress(x: unknown): x is Hex {
  return typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x);
}

function isHexBytes(x: unknown): x is Hex {
  // Accepts 65-byte (typical ECDSA), 64-byte (compact-sig), or any non-empty
  // hex blob — ERC-1271 contract signatures can be arbitrary length, and the
  // contract is the canonical validator anyway. Just guard against empty
  // / missing / non-hex input here.
  return typeof x === "string" && /^0x([0-9a-fA-F]{2})+$/.test(x) && x.length >= 4;
}

const REGISTER_AGENT_TYPES = {
  RegisterAgent: [
    { name: "agentURI", type: "string" },
    { name: "agentWallet", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const IDENTITY_DOMAIN_NAME = "Daski IdentityRegistry";
const IDENTITY_DOMAIN_VERSION = "1";

export function createIdentityRouter(deps: IdentityDeps): Router {
  const router = Router();

  // Reverse lookup: wallet → ERC-8004 agentId. Used to resolve buyerTokenId
  // from the address the CDP SDK issued. Returns `null` for wallets without
  // a minted identity; callers surface that to the user as "mint an
  // identity first".
  router.get("/identity/by-wallet/:address", async (req: Request, res: Response) => {
    const raw = String(req.params.address ?? "");
    if (!isHexAddress(raw)) {
      res.status(400).json({
        error: {
          code: "BAD_ADDRESS",
          message: "address must be a 20-byte hex string",
        },
      });
      return;
    }
    const address = raw.toLowerCase() as Hex;

    let agentId: bigint;
    try {
      agentId = await deps.reader.agentOfWallet(address);
    } catch (err) {
      const correlationId = logErrorWithId("agentOfWallet", err);
      res.status(502).json({
        error: {
          code: "CHAIN_READ_FAILED",
          message: "chain read failed",
          correlationId,
        },
      });
      return;
    }

    res.json({
      address,
      agentId: agentId === 0n ? null : agentId.toString(),
    });
  });

  // Convenience endpoint for callers that need the attester's EAS nonce
  // without holding an RPC URL of their own — the gateway already has a
  // public client aimed at the right chain.
  router.get("/eas/nonce/:address", async (req: Request, res: Response) => {
    const raw = String(req.params.address ?? "");
    if (!isHexAddress(raw)) {
      res.status(400).json({
        error: {
          code: "BAD_ADDRESS",
          message: "address must be a 20-byte hex string",
        },
      });
      return;
    }
    const address = raw.toLowerCase() as Hex;

    let nonce: bigint;
    try {
      nonce = await deps.reader.getEasAttesterNonce(address);
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

    res.json({ address, nonce: nonce.toString() });
  });

  // ── Gasless registration ───────────────────────────────────────────────
  //
  // GET /register-prep returns the EIP-712 RegisterAgent typed-data the
  // wallet should sign. After signing, the agent calls POST /register with
  // the resulting bytes — the gateway facilitator submits registerBySig
  // and returns the new agentId.
  //
  // If the wallet is already registered, /register-prep returns 409 with
  // the existing agentId so the caller can short-circuit.
  router.get("/register-prep", async (req: Request, res: Response) => {
    const walletAddressRaw = String(req.query.walletAddress ?? "");
    if (!isHexAddress(walletAddressRaw)) {
      res.status(400).json({
        error: {
          code: "BAD_WALLET",
          message: "walletAddress must be a 20-byte hex string",
        },
      });
      return;
    }
    const walletAddress = walletAddressRaw.toLowerCase() as Hex;

    // ERC-8004 §2.2: every tokenURI MUST resolve. When the caller doesn't
    // supply one, default to a `data:application/json;base64,...` stub so
    // reputation queries / Bazaar / agentic.market indexers can fetch a
    // minimal agent card. Callers can opt back into empty by passing an
    // explicit empty string.
    const agentURIRaw = req.query.agentURI;
    const agentURI =
      typeof agentURIRaw === "string"
        ? agentURIRaw
        : defaultBuyerAgentURI(walletAddress);

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

    let existingAgentId: bigint;
    try {
      existingAgentId = await deps.reader.agentOfWallet(walletAddress);
    } catch (err) {
      const correlationId = logErrorWithId("agentOfWallet", err);
      res.status(502).json({
        error: {
          code: "CHAIN_READ_FAILED",
          message: "chain read failed",
          correlationId,
        },
      });
      return;
    }
    if (existingAgentId !== 0n) {
      res.status(409).json({
        error: {
          code: "ALREADY_REGISTERED",
          message: "wallet is already registered",
          agentId: existingAgentId.toString(),
        },
      });
      return;
    }

    let nonce: bigint;
    try {
      nonce = await deps.reader.getRegistrationNonce(walletAddress);
    } catch (err) {
      const correlationId = logErrorWithId("registrationNonce", err);
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

    const typedData: Eip712TypedData = {
      domain: {
        name: IDENTITY_DOMAIN_NAME,
        version: IDENTITY_DOMAIN_VERSION,
        chainId: deps.config.chainId,
        verifyingContract: deps.config.identityRegistryAddress,
      },
      types: {
        RegisterAgent: REGISTER_AGENT_TYPES.RegisterAgent.map((f) => ({
          name: f.name,
          type: f.type,
        })),
      },
      primaryType: "RegisterAgent",
      message: {
        agentURI,
        agentWallet: walletAddress,
        nonce: nonce.toString(),
        deadline: deadline.toString(),
      },
    };

    res.json({
      walletAddress,
      agentURI,
      nonce: nonce.toString(),
      deadline: deadline.toString(),
      eip712TypedData: typedData,
      submitTemplate: {
        walletAddress,
        agentURI,
        deadline: deadline.toString(),
        // signature: 0x...    ← agent fills from wallet
      },
    });
  });

  // POST /register — submits the signed RegisterAgent payload via the
  // facilitator. Returns the new agentId once the tx confirms.
  router.post("/register", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    const walletAddressRaw = body.walletAddress;
    if (!isHexAddress(walletAddressRaw)) {
      res.status(400).json({
        error: { code: "BAD_WALLET", message: "walletAddress is required" },
      });
      return;
    }
    const walletAddress = (walletAddressRaw as string).toLowerCase() as Hex;

    if (typeof body.agentURI !== "string") {
      res.status(400).json({
        error: { code: "BAD_AGENT_URI", message: "agentURI must be a string" },
      });
      return;
    }
    const agentURI = body.agentURI;

    const deadlineRaw = body.deadline;
    if (typeof deadlineRaw !== "string" || !/^[1-9][0-9]*$/.test(deadlineRaw)) {
      res.status(400).json({
        error: {
          code: "BAD_DEADLINE",
          message: "deadline must be a positive decimal string (unix seconds)",
        },
      });
      return;
    }
    const deadline = BigInt(deadlineRaw);

    if (!isHexBytes(body.signature)) {
      res.status(400).json({
        error: { code: "BAD_SIGNATURE", message: "signature must be a non-empty hex string" },
      });
      return;
    }
    const signature = (body.signature as string) as Hex;

    // Short-circuit if the wallet is already registered. Saves the round
    // trip and avoids spending gas on a guaranteed revert.
    let existingAgentId: bigint;
    try {
      existingAgentId = await deps.reader.agentOfWallet(walletAddress);
    } catch (err) {
      const correlationId = logErrorWithId("agentOfWallet", err);
      res.status(502).json({
        error: {
          code: "CHAIN_READ_FAILED",
          message: "chain read failed",
          correlationId,
        },
      });
      return;
    }
    if (existingAgentId !== 0n) {
      res.status(409).json({
        error: {
          code: "ALREADY_REGISTERED",
          message: "wallet is already registered",
          agentId: existingAgentId.toString(),
        },
      });
      return;
    }

    try {
      const result = await deps.reader.registerBuyer({
        agentURI,
        agentWallet: walletAddress,
        deadline,
        signature,
      });
      res.json({
        walletAddress,
        agentId: result.agentId.toString(),
        agentURI,
        transactionHash: result.transactionHash,
      });
    } catch (err) {
      const correlationId = logErrorWithId("registerBySig", err);
      res.status(502).json({
        error: {
          code: "REGISTER_FAILED",
          message: "registration submission failed",
          correlationId,
        },
      });
    }
  });

  return router;
}
