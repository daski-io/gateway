import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  parseAbiItem,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import {
  easAbi,
  identityRegistryAbi,
  knownErrorAbis,
  paymentRouterAbi,
  providerRegistryAbi,
  reputationStorageAbi,
  usdcAbi,
  x402AdapterAbi,
} from "./abis.js";
import type {
  BuyerConfirmationLabel,
  BuyerReputation,
  ChainReader,
  ConfirmationDelegationInput,
  ConfirmationResult,
  PaymentSettledEvent,
  PaymentSettledEventLog,
  ProviderReputation,
  RegisterBySigInput,
  RegisterBySigResult,
  ReputationRecord,
  ServiceReputation,
  SettleWithRegistrationInput,
  SettleWithRegistrationResult,
  SettlementInput,
  SettlementResult,
  TransactionOutcome,
} from "./reader.js";
import type { ChainId, Hex } from "../types.js";

export interface ViemReaderOptions {
  rpcUrl: string;
  chainId: ChainId;
  identityRegistryAddress: Hex;
  providerRegistryAddress: Hex;
  paymentRouterAddress: Hex;
  // X402 adapter that the facilitator submits the EIP-3009 settle call to.
  // The router PaymentSettled event is still emitted by the router itself.
  x402AdapterAddress: Hex;
  usdcAddress: Hex;
  facilitatorPrivateKey: Hex;
  // EAS contract. On Base / Base Sepolia this is the canonical
  // 0x4200000000000000000000000000000000000021.
  easAddress: Hex;
  // Optional — when unset, the reputation getters return null. The marketing
  // site treats null as "no reputation data" and renders the empty state
  // rather than 5xxing.
  reputationStorageAddress?: Hex;
}

function chainForId(chainId: ChainId) {
  return chainId === 8453 ? base : baseSepolia;
}

/**
 * Pull the Solidity revert reason out of a viem error.
 *
 * Without this, every on-chain failure surfaces as the generic message
 * the caller threw (e.g. "adapter settle reverted") with no hint at the
 * underlying cause. ContractFunctionRevertedError carries:
 *   - `reason`        — Solidity require/revert STRING
 *   - `data`          — decoded custom error { errorName, args } when the
 *                       error fragment is in the simulate-time ABI
 *                       (see knownErrorAbis)
 *   - `signature`/`raw` — the 4-byte selector / raw bytes when the ABI
 *                       didn't include a matching error fragment
 *   - `shortMessage`  — viem's prose summary, sometimes already names a
 *                       decoded custom error
 *
 * We prefer the most specific available form. Walking the BaseError cause
 * chain finds the revert even when nested inside
 * ContractFunctionExecutionError or EstimateGasExecutionError.
 *
 * ZeroData reverts (out-of-gas, bare `revert()`, missing returndata) used
 * to fall through here as the bare cause-chain message. We surface them
 * explicitly so the caller can distinguish "the contract told us no" from
 * "the EVM ran out of gas mid-call".
 *
 * Falls back to shortMessage / message for non-revert chain errors
 * (RPC outage, signer issues) so callers always get *something* useful.
 */
export function decodeRevertReason(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk(
      (e) =>
        e instanceof ContractFunctionRevertedError ||
        e instanceof ContractFunctionZeroDataError,
    );
    if (revert instanceof ContractFunctionRevertedError) {
      // Solidity require / revert("reason") — clearest form.
      if (revert.reason) return revert.reason;
      // Custom error decoded against the simulate-time ABI. Format as
      // `ErrorName(arg1, arg2)` so the caller sees a typed name instead
      // of "execution reverted".
      const data = revert.data;
      if (data?.errorName) {
        const args = data.args
          ? Array.from(data.args).map(formatErrorArg).join(", ")
          : "";
        return args ? `${data.errorName}(${args})` : `${data.errorName}()`;
      }
      // No matching error fragment in the ABI but we do have raw bytes:
      // surface the 4-byte selector at least, so the caller can grep.
      if (revert.signature) return `unknown error ${revert.signature}`;
      if (revert.raw && revert.raw !== "0x")
        return `unknown error ${revert.raw.slice(0, 10)}`;
      // ContractFunctionRevertedError with no reason / data / signature /
      // raw is the shape viem produces when simulation hits the supplied
      // gas budget mid-call (the EVM returns empty returndata). Every
      // entrypoint in this file passes an explicit `gas` arg, so this
      // case is almost always "the budget was too low for this code
      // path", not "the contract genuinely reverted with no message".
      // Naming OOG explicitly saves the next debugger from chasing
      // signature mismatches that aren't there.
      return "execution reverted with no data (likely out-of-gas — the simulation gas budget was too low for this call)";
    }
    if (revert instanceof ContractFunctionZeroDataError) {
      // Bare revert() or out-of-gas — the call returned no data so there
      // is no string to decode. Common with OOG on tight gas budgets.
      return "execution reverted with no data (out-of-gas or bare revert)";
    }
    // No typed revert in the cause chain. This is what happens when an
    // RPC returns an error response that viem wraps as a generic
    // ContractFunctionExecutionError or CallExecutionError without a
    // decodable revert payload — common on Base Sepolia's public RPC
    // when the upstream node truncates returndata. shortMessage alone
    // here is usually the bare phrase "Execution reverted." with no
    // hint. Append err.details (the raw RPC error string) and the
    // cause's message when present so the caller still has something
    // to grep / paste into a tracer.
    const short = err.shortMessage ?? err.message;
    const details = (err as { details?: unknown }).details;
    const cause = (err as { cause?: { message?: string } }).cause;
    const extras: string[] = [];
    if (typeof details === "string" && details && details !== short) {
      extras.push(details);
    }
    if (cause?.message && cause.message !== short && cause.message !== details) {
      extras.push(cause.message);
    }
    return extras.length > 0 ? `${short} (${extras.join("; ")})` : short;
  }
  return err instanceof Error ? err.message : String(err);
}

function formatErrorArg(arg: unknown): string {
  if (typeof arg === "bigint") return arg.toString();
  if (typeof arg === "string") return arg;
  if (arg === null || arg === undefined) return String(arg);
  try {
    return JSON.stringify(arg, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
  } catch {
    return String(arg);
  }
}

export function createViemChainReader(opts: ViemReaderOptions): ChainReader {
  const chain = chainForId(opts.chainId);
  const transport = http(opts.rpcUrl);
  const publicClient = createPublicClient({ chain, transport });

  const account = privateKeyToAccount(opts.facilitatorPrivateKey);
  const walletClient = createWalletClient({ account, chain, transport });

  const routerAddress = opts.paymentRouterAddress;
  const adapterAddress = opts.x402AdapterAddress;
  const usdcAddress = opts.usdcAddress;
  const easAddress = opts.easAddress;
  const reputationStorageAddress = opts.reputationStorageAddress;

  // EAS's Attested event — referenced to pull the UID out of the receipt.
  // Signature is the canonical one from eas-contracts (indexed recipient,
  // attester, uid; non-indexed schema).
  const EAS_ATTESTED_EVENT = parseAbiItem(
    "event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)",
  );

  return {
    async getProviderCount() {
      return (await publicClient.readContract({
        address: opts.providerRegistryAddress,
        abi: providerRegistryAbi,
        functionName: "getProviderCount",
      })) as bigint;
    },

    async getProviderIdAt(index: bigint) {
      return (await publicClient.readContract({
        address: opts.providerRegistryAddress,
        abi: providerRegistryAbi,
        functionName: "providerIds",
        args: [index],
      })) as bigint;
    },

    async getProvider(agentId: bigint) {
      return (await publicClient.readContract({
        address: opts.providerRegistryAddress,
        abi: providerRegistryAbi,
        functionName: "getProvider",
        args: [agentId],
      })) as {
        agentId: bigint;
        registrationTime: bigint;
        isActive: boolean;
      };
    },

    async getAgentURI(agentId: bigint) {
      return (await publicClient.readContract({
        address: opts.identityRegistryAddress,
        abi: identityRegistryAbi,
        functionName: "tokenURI",
        args: [agentId],
      })) as string;
    },

    async agentOfWallet(wallet: Hex) {
      return (await publicClient.readContract({
        address: opts.identityRegistryAddress,
        abi: identityRegistryAbi,
        functionName: "agentOfWallet",
        args: [wallet],
      })) as bigint;
    },

    async getAgentWallet(agentId: bigint) {
      return (await publicClient.readContract({
        address: opts.identityRegistryAddress,
        abi: identityRegistryAbi,
        functionName: "getAgentWallet",
        args: [agentId],
      })) as Hex;
    },

    async getPaymentRefundedAmount(paymentId: bigint) {
      return (await publicClient.readContract({
        address: routerAddress,
        abi: paymentRouterAbi,
        functionName: "refundedAmount",
        args: [paymentId],
      })) as bigint;
    },

    async getRegistrationNonce(wallet: Hex) {
      return (await publicClient.readContract({
        address: opts.identityRegistryAddress,
        abi: identityRegistryAbi,
        functionName: "registrationNonce",
        args: [wallet],
      })) as bigint;
    },

    async authorizationUsed(authorizer: Hex, nonce: Hex) {
      return (await publicClient.readContract({
        address: usdcAddress,
        abi: usdcAbi,
        functionName: "authorizationState",
        args: [authorizer, nonce],
      })) as boolean;
    },

    async settlePayment(input: SettlementInput): Promise<SettlementResult> {
      const auth = {
        from: input.from,
        validAfter: input.validAfter,
        validBefore: input.validBefore,
        nonce: input.nonce,
        v: input.v,
        r: input.r,
        s: input.s,
      } as const;

      // Facilitator submits to the X402Adapter. The buyer signed an
      // EIP-3009 authorization with `to = router`, so USDC moves directly
      // from buyer → router; the adapter only orchestrates. `PaymentSettled`
      // is emitted by the ROUTER in the same transaction.
      //
      // Explicit gas: the default viem path runs eth_estimateGas without a
      // ceiling, which asks the RPC with the block gas limit (400M on Base
      // Sepolia). sepolia.base.org caps per-tx gas at ~5M and rejects the
      // estimate with "intrinsic gas too high". settle() burns ~150-250k
      // in practice; 500k leaves headroom without tripping the cap.
      //
      // Simulate first: this is the only place we have a chance to surface
      // the actual Solidity revert string (e.g. "ERC20: transfer amount
      // exceeds balance") to the caller. Once we broadcast, the receipt's
      // status is just success/fail without revert data; the caller would
      // see a generic wrapper and have no idea why it failed. Simulating
      // also avoids burning 500k gas on a guaranteed-revert tx.
      let settleRequest;
      try {
        const sim = await publicClient.simulateContract({
          address: adapterAddress,
          abi: [...x402AdapterAbi, ...knownErrorAbis],
          functionName: "settle",
          args: [
            usdcAddress,
            input.amount,
            input.serviceRef,
            input.providerAgentId,
            input.serviceId,
            auth,
          ],
          account,
          chain,
          gas: 500_000n,
        });
        settleRequest = sim.request;
      } catch (err) {
        throw new Error(`adapter settle reverted: ${decodeRevertReason(err)}`);
      }

      const hash = await walletClient.writeContract(settleRequest);

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        // Rare: simulation passed but on-chain state changed between
        // simulation and broadcast (e.g. the buyer's balance dropped
        // mid-flight). The receipt doesn't carry the revert string, so
        // include the tx hash for follow-up via a block explorer.
        throw new Error(
          `adapter settle reverted on broadcast despite passing simulation (tx ${hash})`,
        );
      }

      // Filter logs to only those emitted by the router — defense in depth
      // against a malicious contract emitting a fake PaymentSettled shape.
      const routerLogs = receipt.logs.filter(
        (l) => l.address.toLowerCase() === routerAddress.toLowerCase(),
      );
      const parsed = parseEventLogs({
        abi: paymentRouterAbi,
        eventName: "PaymentSettled",
        logs: routerLogs as any,
      });

      const match = parsed.find(
        (e: any) =>
          String(e.args.serviceRef).toLowerCase() ===
          input.serviceRef.toLowerCase(),
      );
      if (!match) {
        throw new Error("PaymentSettled event missing after settle");
      }

      const args = (match as any).args as PaymentSettledEvent;
      return {
        transactionHash: hash,
        event: {
          paymentId: args.paymentId,
          serviceRef: args.serviceRef,
          serviceId: args.serviceId,
          buyerAgentId: args.buyerAgentId,
          providerAgentId: args.providerAgentId,
          token: args.token,
          totalAmount: args.totalAmount,
          providerAmount: args.providerAmount,
          commission: args.commission,
        },
      };
    },

    async registerBuyer(input: RegisterBySigInput): Promise<RegisterBySigResult> {
      // Facilitator submits IdentityRegistry.registerBySig. The contract
      // verifies the buyer's signature and mints to input.agentWallet.
      // Same explicit-gas reasoning as settlePayment — sepolia.base.org
      // rejects estimateGas with the block gas limit; registerBySig burns
      // ~150-200k in practice; 500k leaves headroom.
      //
      // Simulate first — see settlePayment. Common reverts here are
      // expired deadline, wrong nonce, and signature mismatch; all worth
      // surfacing to the buyer rather than hiding behind "reverted".
      let registerRequest;
      try {
        const sim = await publicClient.simulateContract({
          address: opts.identityRegistryAddress,
          abi: [...identityRegistryAbi, ...knownErrorAbis],
          functionName: "registerBySig",
          args: [input.agentURI, input.agentWallet, input.deadline, input.signature],
          account,
          chain,
          gas: 500_000n,
        });
        registerRequest = sim.request;
      } catch (err) {
        throw new Error(`registerBySig reverted: ${decodeRevertReason(err)}`);
      }

      const hash = await walletClient.writeContract(registerRequest);

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error(
          `registerBySig reverted on broadcast despite passing simulation (tx ${hash})`,
        );
      }

      // Extract agentId from the Registered event. The event is emitted
      // by IdentityRegistry itself, indexed on (agentId, owner).
      const registryLogs = receipt.logs.filter(
        (l) => l.address.toLowerCase() === opts.identityRegistryAddress.toLowerCase(),
      );
      const parsed = parseEventLogs({
        abi: identityRegistryAbi,
        eventName: "Registered",
        logs: registryLogs as any,
      });
      const match = parsed.find(
        (e: any) =>
          String(e.args.owner).toLowerCase() === input.agentWallet.toLowerCase(),
      );
      if (!match) {
        throw new Error("Registered event missing for agentWallet after registerBySig");
      }
      return {
        agentId: (match as any).args.agentId as bigint,
        transactionHash: hash,
      };
    },

    async settleWithRegistration(
      input: SettleWithRegistrationInput,
    ): Promise<SettleWithRegistrationResult> {
      const auth = {
        from: input.from,
        validAfter: input.validAfter,
        validBefore: input.validBefore,
        nonce: input.nonce,
        v: input.v,
        r: input.r,
        s: input.s,
      } as const;

      // 2M gas budget: real-world atomic register+settle measured at ~713k
      // on Base Sepolia (registerBySig with _safeMint + ERC721URIStorage
      // SSTORE for the agentURI ≈ 380k, EIP-3009 transferWithAuthorization
      // ≈ 100k, router.settle bookkeeping ≈ 230k). The original 600k
      // estimate undercounted ERC-721 minting and the per-byte cost of
      // storing dynamic agentURIs, so simulation aborted mid-execution
      // and surfaced as a bare "execution reverted" with no debuggable
      // data — exactly the silent-revert footgun this comment used to
      // claim was impossible. 2M leaves ~1.3M headroom for longer
      // agentURIs and ERC-1271 contract-wallet signatures (which can
      // be arbitrary length and pull in extra SignatureChecker gas) and
      // still sits comfortably below Base Sepolia's ~5M per-tx cap.
      //
      // Simulate first — see settlePayment for the rationale. Atomic
      // register+settle has *two* sources of revert (registration sig
      // mismatch and adapter settle), so a clean reason is even more
      // valuable here than in plain settle.
      let settleRequest;
      try {
        const sim = await publicClient.simulateContract({
          address: adapterAddress,
          abi: [...x402AdapterAbi, ...knownErrorAbis],
          functionName: "settleWithRegistration",
          args: [
            usdcAddress,
            input.amount,
            input.serviceRef,
            input.providerAgentId,
            input.serviceId,
            auth,
            input.registration.agentURI,
            input.registration.deadline,
            input.registration.signature,
          ],
          account,
          chain,
          gas: 2_000_000n,
        });
        settleRequest = sim.request;
      } catch (err) {
        throw new Error(
          `settleWithRegistration reverted: ${decodeRevertReason(err)}`,
        );
      }

      const hash = await walletClient.writeContract(settleRequest);

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error(
          `settleWithRegistration reverted on broadcast despite passing simulation (tx ${hash})`,
        );
      }

      // Pull PaymentSettled out of router logs (same defensive filter as
      // settlePayment) and the optional Registered event from the registry
      // (only present when the buyer was actually minted in this tx).
      const routerLogs = receipt.logs.filter(
        (l) => l.address.toLowerCase() === routerAddress.toLowerCase(),
      );
      const settled = parseEventLogs({
        abi: paymentRouterAbi,
        eventName: "PaymentSettled",
        logs: routerLogs as any,
      });
      const settledMatch = settled.find(
        (e: any) =>
          String(e.args.serviceRef).toLowerCase() === input.serviceRef.toLowerCase(),
      );
      if (!settledMatch) {
        throw new Error("PaymentSettled event missing after settleWithRegistration");
      }
      const settledArgs = (settledMatch as any).args as PaymentSettledEvent;

      const registryLogs = receipt.logs.filter(
        (l) => l.address.toLowerCase() === opts.identityRegistryAddress.toLowerCase(),
      );
      const registered = parseEventLogs({
        abi: identityRegistryAbi,
        eventName: "Registered",
        logs: registryLogs as any,
      });
      const wasRegistered = registered.some(
        (e: any) => String(e.args.owner).toLowerCase() === input.from.toLowerCase(),
      );

      return {
        transactionHash: hash,
        event: {
          paymentId: settledArgs.paymentId,
          serviceRef: settledArgs.serviceRef,
          serviceId: settledArgs.serviceId,
          buyerAgentId: settledArgs.buyerAgentId,
          providerAgentId: settledArgs.providerAgentId,
          token: settledArgs.token,
          totalAmount: settledArgs.totalAmount,
          providerAmount: settledArgs.providerAmount,
          commission: settledArgs.commission,
        },
        buyerAgentId: settledArgs.buyerAgentId,
        registered: wasRegistered,
      };
    },

    async submitBuyerConfirmation(
      input: ConfirmationDelegationInput,
    ): Promise<ConfirmationResult> {
      const request = {
        schema: input.schema,
        data: {
          recipient: input.recipient,
          expirationTime: input.expirationTime,
          revocable: input.revocable,
          refUID: input.refUID,
          data: input.data,
          value: input.value,
        },
        signature: {
          v: input.signature.v,
          r: input.signature.r,
          s: input.signature.s,
        },
        attester: input.attester,
        deadline: input.deadline,
      } as const;

      // Explicit gas for the same sepolia.base.org RPC reason documented
      // above (see settlePayment). attestByDelegation fits comfortably in
      // 500k; the resolver hop adds at most ~100k on top of the EAS attest.
      //
      // Simulate first — see settlePayment. Common reverts here are
      // resolver-side checks (paymentId not settled, attester != buyer,
      // double-attest) and EAS-side signature/deadline failures; the
      // resolver's revert string is genuinely useful for the caller.
      let attestRequest;
      try {
        const sim = await publicClient.simulateContract({
          address: easAddress,
          abi: [...easAbi, ...knownErrorAbis],
          functionName: "attestByDelegation",
          args: [request],
          account,
          chain,
          gas: 600_000n,
        });
        attestRequest = sim.request;
      } catch (err) {
        throw new Error(
          `EAS.attestByDelegation reverted: ${decodeRevertReason(err)}`,
        );
      }

      const hash = await walletClient.writeContract(attestRequest);

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error(
          `EAS.attestByDelegation reverted on broadcast despite passing simulation (tx ${hash})`,
        );
      }

      // Pull the UID out of the EAS Attested event emitted in the same tx.
      const easLogs = receipt.logs.filter(
        (l) => l.address.toLowerCase() === easAddress.toLowerCase(),
      );
      let uid: Hex | null = null;
      for (const log of easLogs) {
        try {
          const decoded = decodeEventLog({
            abi: [EAS_ATTESTED_EVENT],
            data: log.data,
            topics: log.topics as [Hex, ...Hex[]],
          }) as { args: { uid: Hex; attester: Hex; schemaUID: Hex } };
          if (
            decoded.args.attester.toLowerCase() === input.attester.toLowerCase() &&
            decoded.args.schemaUID.toLowerCase() === input.schema.toLowerCase()
          ) {
            uid = decoded.args.uid;
            break;
          }
        } catch {
          // not an Attested event; keep scanning
        }
      }
      if (!uid) {
        throw new Error("EAS Attested event not found after attestByDelegation");
      }

      return {
        transactionHash: hash,
        attestationUid: uid,
      };
    },

    async getEasAttesterNonce(attester: Hex): Promise<bigint> {
      return (await publicClient.readContract({
        address: easAddress,
        abi: easAbi,
        functionName: "getNonce",
        args: [attester],
      })) as bigint;
    },

    async getBlockNumber(): Promise<bigint> {
      return await publicClient.getBlockNumber();
    },

    async getPaymentSettledEvents(
      fromBlock: bigint,
      toBlock: bigint,
    ): Promise<PaymentSettledEventLog[]> {
      // Server-side log filter: address+topic only, the RPC node returns
      // matching logs across the block window. Decoded event shape pulled
      // out via parseEventLogs (handles type-narrowing better than a manual
      // decode loop). Block timestamps come from a per-unique-block fetch
      // — settled txs cluster in small windows so the dedupe is meaningful.
      const logs = await publicClient.getLogs({
        address: routerAddress,
        event: parseAbiItem(
          "event PaymentSettled(uint256 indexed paymentId, bytes32 indexed serviceRef, bytes32 indexed serviceId, uint256 buyerAgentId, uint256 providerAgentId, address token, uint256 totalAmount, uint256 providerAmount, uint256 commission)",
        ),
        fromBlock,
        toBlock,
      });

      if (logs.length === 0) return [];

      // Dedupe block numbers across the batch and fetch each block's
      // timestamp once. /activity needs settled_at to render "Xs ago"
      // tooltips; block.timestamp is the cheapest accurate signal.
      const uniqueBlocks = Array.from(new Set(logs.map((l) => l.blockNumber)));
      const timestamps = new Map<bigint, bigint>();
      await Promise.all(
        uniqueBlocks.map(async (bn) => {
          const b = await publicClient.getBlock({ blockNumber: bn });
          timestamps.set(bn, b.timestamp);
        }),
      );

      return logs.map((l) => {
        const args = l.args as PaymentSettledEvent;
        return {
          ...args,
          blockNumber: l.blockNumber,
          blockTimestamp: timestamps.get(l.blockNumber) ?? 0n,
          transactionHash: l.transactionHash as Hex,
        };
      });
    },

    async getProviderReputation(
      agentId: bigint,
    ): Promise<ProviderReputation | null> {
      if (!reputationStorageAddress) return null;
      const result = (await publicClient.readContract({
        address: reputationStorageAddress,
        abi: reputationStorageAbi,
        functionName: "getProviderStats",
        args: [agentId],
      })) as readonly [bigint, bigint, bigint, bigint, bigint];
      return {
        completed: result[0],
        failed: result[1],
        canceled: result[2],
        confirmed: result[3],
        notConfirmed: result[4],
      };
    },

    async getBuyerReputation(
      agentId: bigint,
    ): Promise<BuyerReputation | null> {
      if (!reputationStorageAddress) return null;
      const result = (await publicClient.readContract({
        address: reputationStorageAddress,
        abi: reputationStorageAbi,
        functionName: "getBuyerStats",
        args: [agentId],
      })) as readonly [bigint, bigint, bigint];
      return {
        transactions: result[0],
        confirmed: result[1],
        notConfirmed: result[2],
      };
    },

    async getServiceReputation(
      serviceId: Hex,
    ): Promise<ServiceReputation | null> {
      if (!reputationStorageAddress) return null;
      const result = (await publicClient.readContract({
        address: reputationStorageAddress,
        abi: reputationStorageAbi,
        functionName: "getServiceStats",
        args: [serviceId],
      })) as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
      return {
        completed: result[0],
        failed: result[1],
        canceled: result[2],
        confirmed: result[3],
        notConfirmed: result[4],
        totalRefunded: result[5],
      };
    },

    async getReputationRecord(
      paymentId: bigint,
    ): Promise<ReputationRecord | null> {
      if (!reputationStorageAddress) return null;
      const raw = (await publicClient.readContract({
        address: reputationStorageAddress,
        abi: reputationStorageAbi,
        functionName: "getRecord",
        args: [paymentId],
      })) as {
        paymentId: bigint;
        providerAgentId: bigint;
        buyerAgentId: bigint;
        serviceId: Hex;
        outcome: number;
        confirmation: number;
        fulfillmentTime: bigint;
        outcomeTimestamp: bigint;
        confirmationTimestamp: bigint;
        outcomeRecorded: boolean;
      };
      // Contract returns a zero-init struct for unknown paymentIds rather
      // than reverting. Distinguish "no record" from "record exists, no
      // outcome yet" so callers don't have to.
      if (raw.paymentId === 0n) return null;
      return {
        paymentId: raw.paymentId,
        providerAgentId: raw.providerAgentId,
        buyerAgentId: raw.buyerAgentId,
        serviceId: raw.serviceId,
        outcome: raw.outcomeRecorded ? OUTCOME_LABELS[raw.outcome] ?? null : null,
        confirmation: CONFIRMATION_LABELS[raw.confirmation] ?? "Pending",
        fulfillmentSeconds: raw.outcomeRecorded ? raw.fulfillmentTime : null,
        outcomeTimestamp: raw.outcomeTimestamp,
        confirmationTimestamp: raw.confirmationTimestamp,
        outcomeRecorded: raw.outcomeRecorded,
      };
    },
  };
}

// Index aligns with the Solidity enum ordinals in ReputationStorage. Keep in
// lock-step with the contract — reordering the enum without updating these
// is a silent correctness bug.
const OUTCOME_LABELS: Record<number, TransactionOutcome> = {
  0: "Completed",
  1: "Failed",
  2: "Canceled",
};

const CONFIRMATION_LABELS: Record<number, BuyerConfirmationLabel> = {
  0: "Pending",
  1: "Confirmed",
  2: "NotConfirmed",
};
