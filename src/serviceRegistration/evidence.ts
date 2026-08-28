import {
  createPublicClient,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  parseAbi,
  stringToHex,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import type { Config } from "../config.js";
import type {
  MarketplaceChainReader,
  MarketplaceServiceRecord,
} from "../marketplace/reader.js";
import { withRpcFailover } from "../rpc/failover.js";
import { orderedRpcTransport } from "../rpc/orderedTransport.js";
import { canonicalHash } from "../standardRail/canonical.js";
import type { StandardRailConfig } from "../standardRail/config.js";
import type {
  ProviderServiceRegistrationEvidenceEnvelope,
} from "./types.js";
import type { StoredRegistration } from "./store.js";
import {
  dynamicRegistrationPolicy,
  type DynamicRegistrationPolicy,
} from "./preparation.js";

const splitterReadAbi = parseAbi([
  "function canonicalChainId() view returns (uint256)",
  "function canonicalToken() view returns (address)",
  "function providerPayee() view returns (address)",
  "function daskiCommissionReceiver() view returns (address)",
  "function commissionBps() view returns (uint16)",
  "function policyVersionHash() view returns (bytes32)",
  "function outcomeIdHash() view returns (bytes32)",
  "function listingCommitmentHash() view returns (bytes32)",
  "function listingEpoch() view returns (uint64)",
  "function releaseSequence() view returns (uint64)",
]);

const tokenReadAbi = parseAbi([
  "function balanceOf(address holder) view returns (uint256)",
]);

const splitterDeployedTopic = keccak256(stringToHex(
  "OutcomeSplitterDeployed(address,bytes32,bytes32,uint64,bytes32)",
));

interface ObservedTransaction {
  hash: Hex;
  from: Address;
  to: Address | null;
  input: Hex;
  value: bigint;
  blockHash: Hex | null;
  blockNumber: bigint | null;
}

interface ObservedLog {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
  blockHash: Hex | null;
  blockNumber: bigint | null;
  transactionHash: Hex | null;
  removed?: boolean;
}

interface ObservedReceipt {
  transactionHash: Hex;
  from: Address;
  to: Address | null;
  status: "success" | "reverted";
  blockHash: Hex;
  blockNumber: bigint;
  logs: readonly ObservedLog[];
}

function sameHex(left: Hex, right: Hex): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function assertSplitterDeploymentTransaction(args: {
  transactionHash: Hex;
  providerSigner: Address;
  factory: Address;
  transactionData: Hex;
  splitterAddress: Address;
  salt: Hex;
  listingKey: Hex;
  listingEpoch: bigint;
  listingCommitmentHash: Hex;
  transaction: ObservedTransaction;
  receipt: ObservedReceipt;
}): void {
  const { transaction, receipt } = args;
  if (
    !sameHex(transaction.hash, args.transactionHash) ||
    !sameHex(receipt.transactionHash, args.transactionHash) ||
    transaction.blockHash === null ||
    transaction.blockNumber === null ||
    transaction.blockNumber !== receipt.blockNumber ||
    !sameHex(transaction.blockHash, receipt.blockHash) ||
    receipt.status !== "success" ||
    transaction.to === null ||
    receipt.to === null ||
    getAddress(transaction.from) !== getAddress(args.providerSigner) ||
    getAddress(receipt.from) !== getAddress(args.providerSigner) ||
    getAddress(transaction.to) !== getAddress(args.factory) ||
    getAddress(receipt.to) !== getAddress(args.factory) ||
    transaction.value !== 0n ||
    !sameHex(transaction.input, args.transactionData)
  ) throw new Error("registration transaction does not match preparation");

  const expectedTopics = [
    splitterDeployedTopic,
    encodeAbiParameters([{ type: "address" }], [args.splitterAddress]),
    args.salt,
    args.listingKey,
  ];
  const expectedData = encodeAbiParameters(
    [{ type: "uint64" }, { type: "bytes32" }],
    [args.listingEpoch, args.listingCommitmentHash],
  );
  const matchingLogs = receipt.logs.filter((log) =>
    log.removed !== true &&
    log.blockHash !== null &&
    log.blockNumber === receipt.blockNumber &&
    log.transactionHash !== null &&
    sameHex(log.blockHash, receipt.blockHash) &&
    sameHex(log.transactionHash, args.transactionHash) &&
    getAddress(log.address) === getAddress(args.factory) &&
    log.topics.length === expectedTopics.length &&
    log.topics.every((topic, index) =>
      sameHex(topic, expectedTopics[index]!)) &&
    sameHex(log.data, expectedData)
  );
  if (matchingLogs.length !== 1) {
    throw new Error("splitter deployment event does not match preparation");
  }
}

/**
 * Chain facts captured at the deployment block of a freshly verified
 * splitter. Settlement evidence later relies on these exact values; a reused
 * listing keeps the checkpoint recorded at its original activation.
 */
export interface SplitterActivationCheckpoint {
  splitterDeploymentTransactionHash: Hex;
  splitterDeploymentBlockNumber: string;
  splitterDeploymentBlockHash: Hex;
  splitterRuntimeCodeHash: Hex;
  splitterActivationBlockNumber: string;
  splitterActivationBlockHash: Hex;
  splitterActivationPosition: "END_OF_BLOCK";
  splitterStartingTokenBalance: string;
  splitterStartingReleaseSequence: string;
}

export interface RegistrationEvidenceVerifier {
  verify(
    registration: StoredRegistration,
    evidence: ProviderServiceRegistrationEvidenceEnvelope,
  ): Promise<Map<string, SplitterActivationCheckpoint>>;
}

interface RpcEndpoint {
  host: string;
  client: ReturnType<typeof createPublicClient>;
}

export class ViemRegistrationEvidenceVerifier
implements RegistrationEvidenceVerifier {
  private readonly clients: RpcEndpoint[];
  private readonly policy: DynamicRegistrationPolicy;

  constructor(
    private readonly config: Pick<
      Config,
      "chainId" | "usdc" | "marketplaceContracts"
    >,
    railConfig: StandardRailConfig,
    chain: Chain,
    private readonly marketplace: MarketplaceChainReader,
  ) {
    this.policy = dynamicRegistrationPolicy(config, railConfig);
    this.clients = railConfig.evidenceRpcUrls.map((url) => ({
      host: new URL(url).hostname,
      client: createPublicClient({
        chain,
        transport: orderedRpcTransport(http(url, {
          retryCount: 0,
          timeout: 20_000,
        })),
      }),
    }));
  }

  private observe<Result>(
    work: (endpoint: RpcEndpoint) => Promise<Result>,
  ): Promise<Result> {
    return withRpcFailover(this.clients, work);
  }

  private async verifyFinalTransaction(
    args: {
      transactionHash: Hex;
      providerSigner: Address;
      transactionData: Hex;
      splitterAddress: Address;
      salt: Hex;
      listingKey: Hex;
      listingEpoch: bigint;
      listingCommitmentHash: Hex;
    },
  ): Promise<{ blockNumber: bigint; blockHash: Hex }> {
    return this.observe(async ({ client }) => {
      const [transaction, receipt, finalized] = await Promise.all([
        client.getTransaction({ hash: args.transactionHash }),
        client.getTransactionReceipt({ hash: args.transactionHash }),
        client.getBlock({ blockTag: "finalized" }),
      ]);
      assertSplitterDeploymentTransaction({
        ...args,
        factory: this.policy.splitterFactory,
        transaction,
        receipt,
      });
      if (receipt.blockNumber > finalized.number) {
        throw new Error("registration transaction is not finalized");
      }
      const [canonicalBlock, factoryCode] = await Promise.all([
        client.getBlock({ blockNumber: receipt.blockNumber }),
        client.getCode({
          address: this.policy.splitterFactory,
          blockNumber: receipt.blockNumber,
        }),
      ]);
      if (canonicalBlock.hash !== receipt.blockHash) {
        throw new Error("registration transaction is not canonical");
      }
      if (
        !factoryCode ||
        keccak256(factoryCode) !== this.policy.splitterFactoryRuntimeCodeHash
      ) throw new Error("splitter factory runtime bytecode is not trusted");
      return { blockNumber: receipt.blockNumber, blockHash: receipt.blockHash };
    });
  }

  private async verifyRegisteredService(
    registration: StoredRegistration,
  ): Promise<void> {
    let service: MarketplaceServiceRecord;
    try {
      service = await this.marketplace.getService(registration.serviceId);
    } catch {
      throw new Error("service is not registered at finalized chain state");
    }
    if (
      !service.active ||
      service.providerAgentId !== registration.providerAgentId ||
      service.serviceId.toLowerCase() !== registration.serviceId.toLowerCase() ||
      service.serviceSlug !== registration.serviceSlug ||
      service.version !== registration.serviceVersion ||
      service.serviceUri !== registration.agentCardUrl ||
      getAddress(service.serviceWallet) !== getAddress(registration.serviceWallet)
    ) throw new Error("finalized ServiceRegistry record does not match the registration");
  }

  private async verifySplitter(args: {
    registration: StoredRegistration;
    listing: StoredRegistration["prepared"]["listings"][number];
    transactionHash: Hex;
  }): Promise<SplitterActivationCheckpoint> {
    if (
      !args.listing.splitterAddress ||
      !args.listing.preparation ||
      !args.listing.transaction
    ) {
      throw new Error("paid listing preparation is incomplete");
    }
    const expected = args.listing.preparation.payload;
    const listingCommitmentHash = canonicalHash(args.listing.preparation);
    const listingKey = args.listing.listingKey;
    const deployment = await this.verifyFinalTransaction({
      transactionHash: args.transactionHash,
      providerSigner: getAddress(args.registration.providerSigner),
      transactionData: args.listing.transaction.data,
      splitterAddress: args.listing.splitterAddress,
      salt: expected.splitterDeploymentSalt,
      listingKey,
      listingEpoch: BigInt(expected.listingEpoch),
      listingCommitmentHash,
    });
    const blockNumber = deployment.blockNumber;
    return this.observe(async ({ client }) => {
      const code = await client.getCode({
        address: args.listing.splitterAddress!,
        blockNumber,
      });
      // Immutables live in runtime code, so every splitter hashes differently;
      // authenticity comes from the verified chain: trusted factory runtime,
      // exact deployment calldata over the pinned creation code, and the
      // CREATE2 address match. The observed hash is recorded, not pinned.
      if (!code) {
        throw new Error("splitter has no runtime bytecode at its deployment block");
      }
      const read = <T>(functionName: string) => client.readContract({
        address: args.listing.splitterAddress!,
        abi: splitterReadAbi,
        functionName: functionName as never,
        blockNumber,
      }) as Promise<T>;
      const [
        chainId, token, providerPayee, commissionReceiver, commissionBps,
        policyVersionHash, actualOutcomeIdHash, actualCommitmentHash, listingEpoch,
        releaseSequence, startingBalance,
      ] = await Promise.all([
        read<bigint>("canonicalChainId"),
        read<Address>("canonicalToken"),
        read<Address>("providerPayee"),
        read<Address>("daskiCommissionReceiver"),
        read<number>("commissionBps"),
        read<Hex>("policyVersionHash"),
        read<Hex>("outcomeIdHash"),
        read<Hex>("listingCommitmentHash"),
        read<bigint>("listingEpoch"),
        read<bigint>("releaseSequence"),
        client.readContract({
          address: this.policy.canonicalToken,
          abi: tokenReadAbi,
          functionName: "balanceOf",
          args: [args.listing.splitterAddress!],
          blockNumber,
        }) as Promise<bigint>,
      ]);
      if (
        chainId !== BigInt(this.config.chainId) ||
        getAddress(token) !== this.policy.canonicalToken ||
        getAddress(providerPayee) !== getAddress(expected.providerPayee) ||
        getAddress(commissionReceiver) !== this.policy.daskiCommissionReceiver ||
        Number(commissionBps) !== this.policy.commissionBps ||
        policyVersionHash !== this.policy.policyVersionHash ||
        actualOutcomeIdHash !== listingKey ||
        actualCommitmentHash !== listingCommitmentHash ||
        listingEpoch !== BigInt(expected.listingEpoch)
      ) throw new Error("splitter immutable bindings do not match preparation");
      return {
        splitterDeploymentTransactionHash: args.transactionHash,
        splitterDeploymentBlockNumber: blockNumber.toString(),
        splitterDeploymentBlockHash: deployment.blockHash,
        splitterRuntimeCodeHash: keccak256(code),
        splitterActivationBlockNumber: blockNumber.toString(),
        splitterActivationBlockHash: deployment.blockHash,
        splitterActivationPosition: "END_OF_BLOCK" as const,
        splitterStartingTokenBalance: startingBalance.toString(),
        splitterStartingReleaseSequence: releaseSequence.toString(),
      };
    });
  }

  async verify(
    registration: StoredRegistration,
    evidence: ProviderServiceRegistrationEvidenceEnvelope,
  ): Promise<Map<string, SplitterActivationCheckpoint>> {
    await this.verifyRegisteredService(registration);
    const provider = await this.marketplace.getProvider(
      BigInt(registration.providerAgentId),
    ) as unknown as {
      agentId?: unknown;
      active?: unknown;
      identity?: { owner?: unknown; agentWallet?: unknown };
    };
    let owner: Address;
    let agentWallet: Address;
    try {
      owner = getAddress(provider.identity?.owner as string);
      agentWallet = getAddress(provider.identity?.agentWallet as string);
    } catch {
      throw new Error("provider authority is invalid at evidence finalization");
    }
    if (
      provider.agentId !== registration.providerAgentId ||
      provider.active !== true ||
      ![owner, agentWallet].includes(getAddress(registration.providerSigner))
    ) throw new Error("provider signer is no longer finalized authority");
    const paid = registration.prepared.listings
      .filter((listing) => listing.deploymentRequired);
    const provided = new Map(evidence.payload.splitterTransactionHashes.map((item) => [
      item.listingId,
      item.transactionHash,
    ]));
    if (
      provided.size !== paid.length ||
      paid.some((listing) => !provided.has(listing.listingId))
    ) throw new Error("splitter evidence must exactly cover paid skills");
    const checkpoints = new Map<string, SplitterActivationCheckpoint>();
    for (const listing of paid) {
      checkpoints.set(listing.listingId, await this.verifySplitter({
        registration,
        listing,
        transactionHash: provided.get(listing.listingId)!,
      }));
    }
    return checkpoints;
  }
}
