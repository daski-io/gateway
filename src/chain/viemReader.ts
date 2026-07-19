import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbiItem,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import {
  agentIndexAbi,
  directTransferAdapterAbi,
  knownErrorAbis,
  paymentRouterAbi,
  usdcAbi,
  x402AdapterAbi,
} from "./abis.js";
import type {
  ChainReader,
  DirectAttributionInput,
  PaymentRouterRecord,
  PaymentSettledEvent,
  PaymentSettledEventLog,
  RegisterBySigInput,
  RegisterBySigResult,
  SettleWithRegistrationInput,
  SettleWithRegistrationResult,
  SettlementInput,
  SettlementResult,
} from "./reader.js";
import type { ChainId, Hex } from "../types.js";
import { decodeRevertReason } from "./viemErrors.js";
import { createIdentityMethods } from "./viemIdentity.js";
import { createReputationReadMethods } from "./viemReputationRead.js";
import { createFeedbackMethods } from "./viemFeedback.js";
import { createConfirmationMethods } from "./viemConfirmation.js";
export { decodeRevertReason } from "./viemErrors.js";

export interface ViemReaderOptions {
  rpcUrl: string;
  chainId: ChainId;
  // Canonical per-chain ERC-8004 IdentityRegistry (0x8004A…).
  identityRegistryAddress: Hex;
  // Daski AgentIndex proxy — verified wallet→agentId reverse lookup plus
  // gasless registerWithSig, the two gaps the canonical registry leaves.
  agentIndexAddress: Hex;
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
  // DirectTransferAdapter — attribution entry point for the external-
  // facilitator rail. Optional; attributeDirectTransfer throws when unset.
  directAdapterAddress?: Hex;
  // Optional — when unset, the reputation getters return null. The marketing
  // site treats null as "no reputation data" and renders the empty state
  // rather than 5xxing.
  reputationStorageAddress?: Hex;
  // Canonical ERC-8004 ReputationRegistry (0x8004B…). Optional; the
  // feedback methods (giveFeedback / revokeFeedback / getFeedbackLastIndex)
  // throw when unset. The mirror module gates on config before calling.
  reputationRegistryAddress?: Hex;
}

function chainForId(chainId: ChainId) {
  return chainId === 8453 ? base : baseSepolia;
}

/** Compose the contract-specific viem adapters into the ChainReader API. */
export function createViemChainReader(opts: ViemReaderOptions): ChainReader {
  const chain = chainForId(opts.chainId);
  const transport = http(opts.rpcUrl);
  const publicClient = createPublicClient({ chain, transport });

  const account = privateKeyToAccount(opts.facilitatorPrivateKey);
  const walletClient = createWalletClient({ account, chain, transport });

  const routerAddress = opts.paymentRouterAddress;
  const adapterAddress = opts.x402AdapterAddress;
  const usdcAddress = opts.usdcAddress;
  const reputationStorageAddress = opts.reputationStorageAddress;

  return {
    ...createIdentityMethods(publicClient, opts),

    async getPaymentRefundedAmount(paymentId: bigint) {
      return (await publicClient.readContract({
        address: routerAddress,
        abi: paymentRouterAbi,
        functionName: "refundedAmount",
        args: [paymentId],
      })) as bigint;
    },

    async getPaymentRecord(
      paymentId: bigint,
    ): Promise<PaymentRouterRecord | null> {
      const raw = (await publicClient.readContract({
        address: routerAddress,
        abi: paymentRouterAbi,
        functionName: "getPayment",
        args: [paymentId],
      })) as {
        buyerAgentId: bigint;
        providerAgentId: bigint;
        serviceId: Hex;
        token: Hex;
        amount: bigint;
        cachedBuyerWallet: Hex;
        serviceRef: Hex;
        paidAt: bigint;
      };
      // Zero-init struct for unknown paymentIds. Real settles always carry
      // a non-zero providerAgentId (the router validates the service pair),
      // so it doubles as the "no such payment" sentinel.
      if (raw.providerAgentId === 0n) return null;
      return raw;
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

    async attributeDirectTransfer(
      input: DirectAttributionInput,
    ): Promise<SettlementResult> {
      const directAdapter = opts.directAdapterAddress;
      if (!directAdapter) {
        throw new Error(
          "DIRECT_ADAPTER_ADDRESS is not configured — external-rail " +
            "attribution unavailable",
        );
      }

      // Funds already sit on the router (moved by the external
      // facilitator's bare EIP-3009 transfer); this tx only runs the
      // split + bookkeeping. Same explicit-gas + simulate-first reasoning
      // as settlePayment. Common reverts worth surfacing: "authorization
      // not consumed" (attribution raced ahead of the external settle),
      // "router under-funded", "serviceRef used" (double attribution).
      let attributeRequest;
      try {
        const sim = await publicClient.simulateContract({
          address: directAdapter,
          abi: [...directTransferAdapterAbi, ...knownErrorAbis],
          functionName: "attribute",
          args: [
            usdcAddress,
            input.amount,
            input.serviceRef,
            input.providerAgentId,
            input.serviceId,
            input.from,
            input.authNonce,
          ],
          account,
          chain,
          gas: 500_000n,
        });
        attributeRequest = sim.request;
      } catch (err) {
        throw new Error(`attribution reverted: ${decodeRevertReason(err)}`);
      }

      const hash = await walletClient.writeContract(attributeRequest);

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error(
          `attribution reverted on broadcast despite passing simulation (tx ${hash})`,
        );
      }

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
        throw new Error("PaymentSettled event missing after attribution");
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
      // Facilitator submits AgentIndex.registerWithSig. The AgentIndex
      // verifies the buyer's signature, mints on the CANONICAL registry
      // (to itself), transfers the NFT to input.agentWallet, and records
      // the wallet→agentId binding.
      // Same explicit-gas reasoning as settlePayment — sepolia.base.org
      // rejects estimateGas with the block gas limit. The flow is now
      // canonical register (~380k) + safeTransferFrom (~60k) + binding
      // (~50k); 800k leaves headroom without tripping the ~5M per-tx cap.
      //
      // Simulate first — see settlePayment. Common reverts here are
      // expired deadline, wrong nonce, and signature mismatch; all worth
      // surfacing to the buyer rather than hiding behind "reverted".
      let registerRequest;
      try {
        const sim = await publicClient.simulateContract({
          address: opts.agentIndexAddress,
          abi: [...agentIndexAbi, ...knownErrorAbis],
          functionName: "registerWithSig",
          args: [input.agentURI, input.agentWallet, input.deadline, input.signature],
          account,
          chain,
          gas: 800_000n,
        });
        registerRequest = sim.request;
      } catch (err) {
        throw new Error(`registerWithSig reverted: ${decodeRevertReason(err)}`);
      }

      const hash = await walletClient.writeContract(registerRequest);

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error(
          `registerWithSig reverted on broadcast despite passing simulation (tx ${hash})`,
        );
      }

      // Extract agentId from the AgentRegistered event. The event is
      // emitted by the AgentIndex itself, indexed on (agentId, wallet).
      // (The canonical registry's Registered event fires with the
      // AgentIndex as owner — the mint-then-transfer flow — so it cannot
      // be matched against the buyer wallet.)
      const indexLogs = receipt.logs.filter(
        (l) => l.address.toLowerCase() === opts.agentIndexAddress.toLowerCase(),
      );
      const parsed = parseEventLogs({
        abi: agentIndexAbi,
        eventName: "AgentRegistered",
        logs: indexLogs as any,
      });
      const match = parsed.find(
        (e: any) =>
          String(e.args.wallet).toLowerCase() === input.agentWallet.toLowerCase(),
      );
      if (!match) {
        throw new Error("AgentRegistered event missing for wallet after registerWithSig");
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

      // 2M gas budget: the atomic path now runs AgentIndex.registerWithSig
      // inside the adapter — canonical-registry register with _safeMint +
      // ERC721URIStorage SSTORE for the agentURI ≈ 380k, safeTransferFrom
      // of the fresh NFT to the buyer ≈ 60k, binding SSTOREs ≈ 50k — plus
      // the EIP-3009 transferWithAuthorization ≈ 100k and router.settle
      // bookkeeping ≈ 230k. A budget that aborts mid-execution surfaces as
      // a bare "execution reverted" with no debuggable data (the
      // silent-revert footgun an earlier 600k budget hit), so 2M keeps
      // ~1M headroom for longer agentURIs and ERC-1271 contract-wallet
      // signatures (arbitrary length, extra SignatureChecker gas) and
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
      // settlePayment) and the optional AgentRegistered event from the
      // AgentIndex (only present when the buyer was actually minted in
      // this tx).
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

      const indexLogs = receipt.logs.filter(
        (l) => l.address.toLowerCase() === opts.agentIndexAddress.toLowerCase(),
      );
      const registered = parseEventLogs({
        abi: agentIndexAbi,
        eventName: "AgentRegistered",
        logs: indexLogs as any,
      });
      const wasRegistered = registered.some(
        (e: any) => String(e.args.wallet).toLowerCase() === input.from.toLowerCase(),
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

    ...createConfirmationMethods({
      publicClient,
      walletClient,
      account,
      chain,
      easAddress: opts.easAddress,
    }),

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

    ...createReputationReadMethods(publicClient, reputationStorageAddress),
    ...createFeedbackMethods({
      publicClient,
      walletClient,
      account,
      chain,
      reputationRegistryAddress: opts.reputationRegistryAddress,
    }),
  };
}
