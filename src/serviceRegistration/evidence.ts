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

export interface RegistrationEvidenceVerifier {
  verify(
    registration: StoredRegistration,
    evidence: ProviderServiceRegistrationEvidenceEnvelope,
  ): Promise<void>;
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
  ): Promise<bigint> {
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
      return receipt.blockNumber;
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
  }): Promise<void> {
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
    const blockNumber = await this.verifyFinalTransaction({
      transactionHash: args.transactionHash,
      providerSigner: getAddress(args.registration.providerSigner),
      transactionData: args.listing.transaction.data,
      splitterAddress: args.listing.splitterAddress,
      salt: expected.splitterDeploymentSalt,
      listingKey,
      listingEpoch: BigInt(expected.listingEpoch),
      listingCommitmentHash,
    });
    await this.observe(async ({ client }) => {
      const code = await client.getCode({
        address: args.listing.splitterAddress!,
        blockNumber,
      });
      if (!code || keccak256(code) !== this.policy.splitterRuntimeCodeHash) {
        throw new Error("splitter runtime bytecode is not trusted");
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
    });
  }

  async verify(
    registration: StoredRegistration,
    evidence: ProviderServiceRegistrationEvidenceEnvelope,
  ): Promise<void> {
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
    for (const listing of paid) {
      await this.verifySplitter({
        registration,
        listing,
        transactionHash: provided.get(listing.listingId)!,
      });
    }
  }
}
