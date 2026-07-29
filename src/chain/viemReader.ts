import {
  createPublicClient,
  createWalletClient,
  http,
  nonceManager,
  parseAbiItem,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { SettlementTransactionRevertedError } from "./reader.js";
import {
  classifySettlementScreeningFailure,
  sanctionsGuardAbi,
  sanctionsOracleAbi,
  SettlementScreeningError,
} from "./sanctionsErrors.js";
import {
  agentIndexAbi,
  knownErrorAbis,
  paymentRouterAbi,
  usdcAbi,
  x402AdapterAbi,
} from "./abis.js";
import type {
  ChainReader,
  BroadcastObserver,
  PaymentRouterRecord,
  PaymentSettledEvent,
  PaymentSettledEventLog,
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
  // delegated registerWithSig, the two gaps the canonical registry leaves.
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
  // Optional — when unset, the reputation getters return null. The marketing
  // site treats null as "no reputation data" and renders the empty state
  // rather than 5xxing.
  reputationStorageAddress?: Hex;
  // Canonical ERC-8004 ReputationRegistry (0x8004B…). Optional; the
  // feedback preparation, submission, recovery, and revocation methods
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

  const account = privateKeyToAccount(opts.facilitatorPrivateKey, {
    nonceManager,
  });
  const walletClient = createWalletClient({ account, chain, transport });

  const routerAddress = opts.paymentRouterAddress;
  const adapterAddress = opts.x402AdapterAddress;
  const usdcAddress = opts.usdcAddress;
  const reputationStorageAddress = opts.reputationStorageAddress;

  async function settlementFromTransaction(
    transactionHash: Hex,
    serviceRef: Hex,
  ): Promise<SettlementResult> {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: transactionHash,
    });
    if (receipt.status !== "success") {
      throw await classifyRevertedSettlement(
        transactionHash,
        receipt.blockNumber,
      );
    }
    const routerLogs = receipt.logs.filter(
      (log) => log.address.toLowerCase() === routerAddress.toLowerCase(),
    );
    const parsed = parseEventLogs({
      abi: paymentRouterAbi,
      eventName: "PaymentSettled",
      logs: routerLogs as any,
    });
    const match = parsed.find(
      (event: any) =>
        String(event.args.serviceRef).toLowerCase() ===
        serviceRef.toLowerCase(),
    );
    if (!match) {
      throw new Error("PaymentSettled event missing from transaction");
    }
    const args = (match as any).args as PaymentSettledEvent;
    return {
      transactionHash,
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
  }

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
        cachedProviderOwner: Hex;
        cachedProviderWallet: Hex;
        serviceRef: Hex;
        paidAt: bigint;
        reputationEligible: boolean;
      };
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

    async verifyReceiveAuthorization(input) {
      return publicClient.verifyTypedData({
        address: input.signer,
        domain: input.domain,
        types: input.types as any,
        primaryType: input.primaryType,
        message: input.message,
        signature: input.signature,
      });
    },

    async simulatePayment(input, registration) {
      const auth = {
        from: input.from,
        validAfter: input.validAfter,
        validBefore: input.validBefore,
        nonce: input.nonce,
        signature: input.signature,
      } as const;
      if (registration) {
        await publicClient.simulateContract({
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
            input.nonceSalt,
            registration.agentURI,
            registration.deadline,
            registration.signature,
          ],
          account,
          chain,
          gas: 2_000_000n,
        });
        return;
      }
      await publicClient.simulateContract({
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
          input.nonceSalt,
        ],
        account,
        chain,
        gas: 2_000_000n,
      });
    },

    async settlePayment(
      input: SettlementInput,
      onBroadcast?: BroadcastObserver,
    ): Promise<SettlementResult> {
      const auth = {
        from: input.from,
        validAfter: input.validAfter,
        validBefore: input.validBefore,
        nonce: input.nonce,
        signature: input.signature,
      } as const;

      // Facilitator submits to the X402Adapter. The buyer signed an
      // EIP-3009 receive authorization with `to = adapter`. USDC moves
      // buyer → adapter → router atomically, and PaymentSettled is emitted
      // by the router in the same transaction.
      //
      // Explicit gas: the default viem path runs eth_estimateGas without a
      // ceiling, which asks the RPC with the block gas limit (400M on Base
      // Sepolia). sepolia.base.org caps per-tx gas at ~5M and rejects the
      // estimate with "intrinsic gas too high". The v0.6.0 settle path
      // (per-party sanctions staticcalls + reputation accounting) exceeds
      // the old 500k ceiling — verified live: 500k reverts bare, 2M
      // settles. Matches settleWithRegistration below.
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
            input.nonceSalt,
          ],
          account,
          chain,
          gas: 2_000_000n,
        });
        settleRequest = sim.request;
      } catch (err) {
        const screening = classifySettlementScreeningFailure(err);
        if (screening) {
          throw new SettlementScreeningError(screening, "simulation");
        }
        throw new Error(`adapter settle reverted: ${decodeRevertReason(err)}`);
      }

      let hash: Hex;
      try {
        hash = await walletClient.writeContract(settleRequest);
      } catch (error) {
        const screening = classifySettlementScreeningFailure(error);
        if (screening) {
          throw new SettlementScreeningError(screening, "submission");
        }
        throw error;
      }
      await onBroadcast?.(hash);
      return settlementFromTransaction(hash, input.serviceRef);
    },

    async settleWithRegistration(
      input: SettleWithRegistrationInput,
      onBroadcast?: BroadcastObserver,
    ): Promise<SettleWithRegistrationResult> {
      const auth = {
        from: input.from,
        validAfter: input.validAfter,
        validBefore: input.validBefore,
        nonce: input.nonce,
        signature: input.signature,
      } as const;

      // 2M gas budget: the atomic path now runs AgentIndex.registerWithSig
      // inside the adapter — canonical-registry register with _safeMint +
      // ERC721URIStorage SSTORE for the agentURI ≈ 380k, safeTransferFrom
      // of the fresh NFT to the buyer ≈ 60k, binding SSTOREs ≈ 50k — plus
      // the EIP-3009 receiveWithAuthorization ≈ 100k and router.settle
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
            input.nonceSalt,
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
        const screening = classifySettlementScreeningFailure(err);
        if (screening) {
          throw new SettlementScreeningError(screening, "simulation");
        }
        throw new Error(
          `settleWithRegistration reverted: ${decodeRevertReason(err)}`,
        );
      }

      let hash: Hex;
      try {
        hash = await walletClient.writeContract(settleRequest);
      } catch (error) {
        const screening = classifySettlementScreeningFailure(error);
        if (screening) {
          throw new SettlementScreeningError(screening, "submission");
        }
        throw error;
      }
      await onBroadcast?.(hash);

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw await classifyRevertedSettlement(hash, receipt.blockNumber);
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

    getSettlementByTransaction: settlementFromTransaction,

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

    async verifySanctionsReadiness(input): Promise<boolean> {
      if ((await publicClient.getChainId()) !== input.chainId) return false;
      const bytecode = await publicClient.getBytecode({
        address: input.oracleAddress,
      });
      if (!bytecode || bytecode === "0x") return false;
      const probe = await publicClient.readContract({
        address: input.oracleAddress,
        abi: sanctionsOracleAbi,
        functionName: "isSanctioned",
        args: [input.probeAccount],
      });
      if (typeof probe !== "boolean") return false;
      const configured = await Promise.all(
        input.guardedContracts.map((address) =>
          publicClient.readContract({
            address,
            abi: sanctionsGuardAbi,
            functionName: "sanctionsOracle",
          }),
        ),
      );
      return configured.every(
        (address) =>
          String(address).toLowerCase() === input.oracleAddress.toLowerCase(),
      );
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

  async function classifyRevertedSettlement(
    transactionHash: Hex,
    blockNumber: bigint,
  ): Promise<Error> {
    try {
      const transaction = await publicClient.getTransaction({
        hash: transactionHash,
      });
      if (!transaction.to) {
        return new SettlementTransactionRevertedError(transactionHash);
      }
      await publicClient.call({
        account: transaction.from,
        to: transaction.to,
        data: transaction.input,
        value: transaction.value,
        blockNumber,
      });
    } catch (error) {
      const screening = classifySettlementScreeningFailure(error);
      if (screening) {
        return new SettlementScreeningError(
          screening,
          "receipt_replay",
          transactionHash,
        );
      }
    }
    return new SettlementTransactionRevertedError(transactionHash);
  }
}
