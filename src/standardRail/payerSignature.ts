import {
  BaseError,
  ContractFunctionRevertedError,
  ExecutionRevertedError,
  RpcRequestError,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  isErc6492Signature,
  parseAbi,
  parseSignature,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type TypedData,
  type TypedDataDomain,
} from "viem";
import { withRpcFailover, type RpcEndpoint } from "../rpc/failover.js";
import { logger } from "../util/logger.js";
import { standardRailError, type StandardRailPhase } from "./errors.js";

/**
 * One payer-signature verifier for every site that authenticates a payer:
 * the payment pre-check, wallet actions and queries, and order actions.
 *
 * The EOA path is exactly the behaviour every site had before contract
 * accounts existed: a 65-byte low-s ECDSA signature that recovers to the
 * payer, evaluated offline. Anything else is a contract-account signature,
 * verified by the deployed contract's own `isValidSignature` through one
 * bounded, read-only `eth_call`. Signature bytes and typed data are never
 * logged; the one log line per outcome carries the outcome only.
 */

/** `0x` plus an even number of hex characters, at most this many bytes. */
export const PAYER_SIGNATURE_MAX_BYTES = 4_096;
export const PAYER_SIGNATURE_PATTERN = /^0x(?:[0-9a-fA-F]{2}){1,4096}$/;
export const ERC1271_MAGIC_VALUE = "0x1626ba7e";
export const CONTRACT_VERIFICATION_GAS = 1_000_000n;
/** Bound on the JSON-RPC response body of the verification call. */
export const CONTRACT_VERIFICATION_RESPONSE_MAX_BYTES = 16_384;
/** Process-wide concurrent contract verifications. */
export const CONTRACT_VERIFICATION_CONCURRENCY = 8;
/** At most this many endpoints are tried: the primary and one failover. */
const CONTRACT_VERIFICATION_ENDPOINTS = 2;

export const PAYER_ACCOUNT_TYPES = ["eoa", "contract"] as const;
export type PayerAccountType = typeof PAYER_ACCOUNT_TYPES[number];

const HALF_CURVE_ORDER = BigInt(
  "0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0",
);

const erc1271Abi = parseAbi([
  "function isValidSignature(bytes32 hash,bytes signature) view returns (bytes4)",
]);

export interface PayerTypedData {
  domain: TypedDataDomain;
  types: TypedData;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface PayerVerification {
  accountType: PayerAccountType;
  verifiedVia: "recovery" | "erc1271";
}

/** The subset of a viem public client the contract path uses. */
export interface ContractVerificationClient {
  getCode(args: { address: Address; blockTag: "latest" }): Promise<Hex | undefined>;
  call(args: { to: Address; data: Hex; gas: bigint; blockTag: "latest" }): Promise<{ data?: Hex | undefined }>;
}

export type ContractVerificationEndpoint = RpcEndpoint<ContractVerificationClient>;

export interface PayerSignatureVerifierOptions {
  accountTypes: readonly PayerAccountType[];
  /** One deadline covering the code lookup, the call, and one failover. */
  timeoutMs: number;
  endpoints: readonly ContractVerificationEndpoint[];
  semaphore?: ContractVerificationSemaphore;
  /**
   * Site-owned admission, charged before any RPC on the contract path and
   * counted whether or not the verification then succeeds. The EOA path never
   * calls it.
   */
  admit?: (payer: Address) => Promise<void>;
}

export interface VerifyPayerTypedDataArgs {
  payer: Address;
  typedData: PayerTypedData;
  signature: Hex;
  /** Error envelope for the site: the field named and the phase reported. */
  context?: { field?: string; phase?: StandardRailPhase };
}

export interface PayerSignatureVerifier {
  readonly accountTypes: readonly PayerAccountType[];
  verifyPayerTypedData(args: VerifyPayerTypedDataArgs): Promise<PayerVerification>;
}

export class ContractVerificationSemaphore {
  private active = 0;

  constructor(readonly limit: number) {}

  get inFlight(): number {
    return this.active;
  }

  tryAcquire(): (() => void) | null {
    if (this.active >= this.limit) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }
}

export const sharedContractVerificationSemaphore =
  new ContractVerificationSemaphore(CONTRACT_VERIFICATION_CONCURRENCY);

/** Explicit chain answers: never retried, never failed over. */
class ExplicitVerificationFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ExplicitVerificationFailure";
  }
}

class VerificationDeadlineExceeded extends Error {
  constructor() {
    super("deadline");
    this.name = "VerificationDeadlineExceeded";
  }
}

export function isPayerSignatureShape(value: unknown): value is Hex {
  return typeof value === "string" && PAYER_SIGNATURE_PATTERN.test(value);
}

function byteLength(value: Hex): number {
  return (value.length - 2) / 2;
}

function outcome(label: string, details: Record<string, unknown> = {}): void {
  // One metric per outcome; never the signature or the typed data.
  logger.info("payer signature verification", { outcome: label, ...details });
}

/**
 * A revert or other definitive node answer to the verification call, as
 * opposed to an endpoint that could not be reached or answered.
 */
export function isExplicitCallFailure(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  const explicit = error.walk((cause) =>
    cause instanceof ExecutionRevertedError ||
    cause instanceof ContractFunctionRevertedError ||
    (cause instanceof RpcRequestError && (
      cause.code === ExecutionRevertedError.code ||
      /revert|out of gas|invalid opcode|invalid jump|stack (?:under|over)flow/i.test(cause.details ?? "")
    )),
  );
  return explicit !== null;
}

async function withinDeadline<T>(deadline: number, work: Promise<T>): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new VerificationDeadlineExceeded();
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new VerificationDeadlineExceeded()), remaining);
    timer.unref();
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
    work.catch(() => undefined);
  }
}

export function createPayerSignatureVerifier(
  options: PayerSignatureVerifierOptions,
): PayerSignatureVerifier {
  const accountTypes = [...new Set(options.accountTypes)];
  const contractAllowed = accountTypes.includes("contract");
  const semaphore = options.semaphore ?? sharedContractVerificationSemaphore;
  const endpoints = options.endpoints.slice(0, CONTRACT_VERIFICATION_ENDPOINTS);

  const invalid = (context: VerifyPayerTypedDataArgs["context"], reason: string) =>
    standardRailError("SIGNATURE_INVALID", {
      field: context?.field,
      phase: context?.phase,
      message: "The payer signature is invalid",
      internalMessage: `payer signature invalid: ${reason}`,
    });

  async function eoaPath(args: VerifyPayerTypedDataArgs): Promise<PayerVerification | null> {
    if (byteLength(args.signature) !== 65) return null;
    try {
      const parsed = parseSignature(args.signature);
      if (BigInt(parsed.s) > HALF_CURVE_ORDER) return null;
      const recovered = await recoverTypedDataAddress({
        domain: args.typedData.domain,
        types: args.typedData.types,
        primaryType: args.typedData.primaryType,
        message: args.typedData.message,
        signature: args.signature,
      } as never);
      if (getAddress(recovered) !== getAddress(args.payer)) return null;
      return { accountType: "eoa", verifiedVia: "recovery" };
    } catch {
      // Not a recoverable ECDSA signature for this payer: the contract path decides.
      return null;
    }
  }

  async function contractPath(args: VerifyPayerTypedDataArgs): Promise<PayerVerification> {
    const context = args.context;
    if (!contractAllowed) {
      outcome("invalid", { reason: "eoa-only" });
      throw invalid(context, "signature does not recover to the payer and contract accounts are not enabled");
    }
    if (isErc6492Signature(args.signature)) {
      outcome("counterfactual");
      throw standardRailError("SIGNATURE_COUNTERFACTUAL_REJECTED", {
        field: context?.field,
        phase: context?.phase,
      });
    }
    const hash = hashTypedData({
      domain: args.typedData.domain,
      types: args.typedData.types,
      primaryType: args.typedData.primaryType,
      message: args.typedData.message,
    } as never);
    const payer = getAddress(args.payer);
    if (options.admit) await options.admit(payer);
    const release = semaphore.tryAcquire();
    if (!release) {
      outcome("busy");
      throw standardRailError("SIGNATURE_VERIFICATION_BUSY", {
        field: context?.field,
        phase: context?.phase,
      });
    }
    try {
      await verifyOnChain(payer, hash, args.signature);
    } catch (error) {
      if (error instanceof ExplicitVerificationFailure) {
        outcome("invalid", { reason: error.reason });
        throw invalid(context, error.reason);
      }
      outcome("unavailable", {
        reason: error instanceof VerificationDeadlineExceeded ? "deadline" : "transport",
      });
      throw standardRailError("SIGNATURE_VERIFICATION_UNAVAILABLE", {
        field: context?.field,
        phase: context?.phase,
        internalMessage: error instanceof VerificationDeadlineExceeded
          ? "payer signature verification exceeded its deadline"
          : "payer signature verification failed on every endpoint",
      });
    } finally {
      release();
    }
    outcome("verified", { accountType: "contract" });
    return { accountType: "contract", verifiedVia: "erc1271" };
  }

  async function verifyOnChain(payer: Address, hash: Hex, signature: Hex): Promise<void> {
    if (endpoints.length === 0) throw new Error("no verification endpoint");
    const deadline = Date.now() + options.timeoutMs;
    const data = encodeFunctionData({
      abi: erc1271Abi,
      functionName: "isValidSignature",
      args: [hash, signature],
    });
    await withRpcFailover(endpoints, async ({ client }) => {
      const code = await withinDeadline(deadline, client.getCode({ address: payer, blockTag: "latest" }));
      if (!code || code === "0x") throw new ExplicitVerificationFailure("payer has no deployed code");
      let returned: Hex;
      try {
        const result = await withinDeadline(deadline, client.call({
          to: payer,
          data,
          gas: CONTRACT_VERIFICATION_GAS,
          blockTag: "latest",
        }));
        returned = result.data ?? "0x";
      } catch (error) {
        if (error instanceof VerificationDeadlineExceeded) throw error;
        if (isExplicitCallFailure(error)) throw new ExplicitVerificationFailure("isValidSignature reverted");
        throw error;
      }
      if (byteLength(returned) !== 32 || !returned.toLowerCase().startsWith(ERC1271_MAGIC_VALUE)) {
        throw new ExplicitVerificationFailure("isValidSignature did not return the magic value");
      }
    }, {
      attempts: 1,
      baseDelayMs: 0,
      terminal: (error) =>
        error instanceof ExplicitVerificationFailure || error instanceof VerificationDeadlineExceeded,
      onFallback: ({ primaryHost, selectedHost }) => {
        logger.warn("payer signature verification RPC fallback selected", { primaryHost, selectedHost });
      },
    });
  }

  return {
    accountTypes,
    async verifyPayerTypedData(args) {
      if (!isPayerSignatureShape(args.signature)) {
        outcome("invalid", { reason: "shape" });
        throw invalid(args.context, "signature shape or size");
      }
      const eoa = await eoaPath(args);
      if (eoa) {
        outcome("verified", { accountType: "eoa" });
        return eoa;
      }
      return contractPath(args);
    },
  };
}

/** Reads a whole HTTP body into memory, refusing bodies past `maxBytes`. */
async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await response.body.cancel().catch(() => undefined);
    throw new Error("RPC response exceeds the verification response bound");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("RPC response exceeds the verification response bound");
    }
    chunks.push(next.value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * A fetch for viem's http transport that bounds every response body, so a
 * verification endpoint can never hand the gateway more than the cap.
 */
export function boundedRpcFetch(maxBytes: number, fetchFn: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const response = await fetchFn(input, init);
    const body = await readBoundedBody(response, maxBytes);
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
