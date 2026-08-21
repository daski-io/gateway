import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  parseAbi,
  parseAbiItem,
  parseEventLogs,
  publicActions,
  keccak256,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { FacilitatorNonceLock } from "./facilitatorNonceLock.js";
import type { StandardRailConfig } from "./config.js";
import { withRpcFailover } from "../rpc/failover.js";
import { orderedRpcTransport } from "../rpc/orderedTransport.js";
import { logger } from "../util/logger.js";
import { canonicalHash } from "./canonical.js";
import { chainLogsHash } from "./chainLogHash.js";
import { hasRequiredConfirmations } from "./finality.js";
import type { ProviderIdentitySnapshotV1, StandardListing, StandardOrderRecord } from "./types.js";
import { loadLogsPaged } from "./chainLogPagination.js";
import { deriveSplitterProvenance } from "./splitterProvenance.js";
import {
  assertActivationCheckpoint,
  compareEvidencePosition,
  selectBoundDeposit,
  selectBoundRelease,
  verifyReleaseInterval,
  type LogBinding,
  type PositionedEvidence,
  type ReleasedEvidence,
  type TransferEvidence,
} from "./releaseEvidence.js";

const transferAuthorizationAbi = parseAbi([
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes signature)",
  "function authorizationState(address authorizer,bytes32 nonce) view returns (bool)",
  "event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)",
]);
const sanctionsOracleAbi = parseAbi([
  "function isSanctioned(address account) view returns (bool)",
]);
const splitterAbi = parseAbi([
  "function releaseAll() returns (uint256 grossAmount)",
  "function canonicalChainId() view returns (uint256)",
  "function canonicalToken() view returns (address)",
  "function providerPayee() view returns (address)",
  "function daskiCommissionReceiver() view returns (address)",
  "function commissionBps() view returns (uint16)",
  "function policyVersionHash() view returns (bytes32)",
  "function outcomeIdHash() view returns (bytes32)",
  "function listingEpoch() view returns (uint64)",
  "function listingCommitmentHash() view returns (bytes32)",
  "function releaseSequence() view returns (uint64)",
  "event Released(bytes32 indexed outcomeIdHash,uint64 indexed listingEpoch,uint64 indexed releaseSequence,bytes32 policyVersionHash,bytes32 listingCommitmentHash,uint256 grossAmount,uint256 providerNetAmount,uint256 daskiCommissionAmount)",
]);
const splitterFactoryAbi = parseAbi([
  "function deploy(bytes32 salt,uint256 canonicalChainId,address canonicalToken,address providerPayee,address daskiCommissionReceiver,uint16 commissionBps,bytes32 policyVersionHash,bytes32 outcomeIdHash,bytes32 listingCommitmentHash,uint64 listingEpoch) returns (address splitter)",
  "event OutcomeSplitterDeployed(address indexed splitter,bytes32 indexed salt,bytes32 indexed outcomeIdHash,uint64 listingEpoch,bytes32 listingCommitmentHash)",
]);
const transferEvent = parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)");
const authorizationUsedEvent = parseAbiItem("event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)");
const releasedEvent = parseAbiItem("event Released(bytes32 indexed outcomeIdHash,uint64 indexed listingEpoch,uint64 indexed releaseSequence,bytes32 policyVersionHash,bytes32 listingCommitmentHash,uint256 grossAmount,uint256 providerNetAmount,uint256 daskiCommissionAmount)");
const tokenPolicyAbi = parseAbi(["function DOMAIN_SEPARATOR() view returns (bytes32)"]);
const identitySnapshotAbi = parseAbi([
  "function ownerOf(uint256 agentId) view returns (address)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
]);
const providerSnapshotAbi = parseAbi([
  "function getProvider(uint256 agentId) view returns ((uint256 agentId,uint256 registrationTime,bool isActive))",
]);
const serviceSnapshotAbi = parseAbi([
  "function resolveSettlement(bytes32 serviceId) view returns (uint256 providerAgentId,bool active,address providerOwner,address providerWallet,address payee)",
]);

interface SourceObservation {
  source: string;
  blockNumber: string;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
  logsHash: Hex;
}

export interface EvidenceResult {
  transactionHash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  transactionIndex: number;
  logIndex: number;
  evidenceHash: Hex;
  canonicalEvidence: Record<string, unknown>;
  sources: string[];
}

export interface ReleaseEvidenceResult extends EvidenceResult {
  providerNetAmount: bigint;
  daskiCommissionAmount: bigint;
  releaseSequence: bigint;
}

interface ReleaseReference extends LogBinding {
  releaseSequence: bigint;
}

interface DeploymentEvidence extends PositionedEvidence {
  factory: Address;
  splitter: Address;
  salt: Hex;
  outcomeIdHash: Hex;
  listingEpoch: bigint;
  listingCommitmentHash: Hex;
}

function positioned(event: {
  blockNumber: bigint | null;
  blockHash: Hex | null;
  transactionIndex: number | null;
  logIndex: number | null;
  transactionHash: Hex | null;
}): PositionedEvidence {
  if (
    event.blockNumber === null ||
    event.blockHash === null ||
    event.transactionIndex === null ||
    event.logIndex === null ||
    event.transactionHash === null
  ) {
    throw new Error("Chain log position is incomplete");
  }
  return {
    blockNumber: event.blockNumber,
    blockHash: event.blockHash,
    transactionIndex: event.transactionIndex,
    logIndex: event.logIndex,
    transactionHash: event.transactionHash,
  };
}

function normalizeTransfers(logs: readonly unknown[]): TransferEvidence[] {
  return parseEventLogs({
    abi: erc20Abi,
    logs: logs as never,
    eventName: "Transfer",
  }).map((event) => {
    if (
      event.args.from === undefined ||
      event.args.to === undefined ||
      event.args.value === undefined
    ) throw new Error("ERC-20 transfer log is incomplete");
    return {
      ...positioned(event),
      token: getAddress(event.address),
      from: getAddress(event.args.from),
      to: getAddress(event.args.to),
      value: event.args.value,
    };
  });
}

function normalizeReleases(logs: readonly unknown[]): ReleasedEvidence[] {
  return parseEventLogs({
    abi: splitterAbi,
    logs: logs as never,
    eventName: "Released",
  }).map((event) => {
    const value = event.args;
    if (
      value.outcomeIdHash === undefined ||
      value.listingEpoch === undefined ||
      value.releaseSequence === undefined ||
      value.policyVersionHash === undefined ||
      value.listingCommitmentHash === undefined ||
      value.grossAmount === undefined ||
      value.providerNetAmount === undefined ||
      value.daskiCommissionAmount === undefined
    ) throw new Error("Released log is incomplete");
    return {
      ...positioned(event),
      splitter: getAddress(event.address),
      outcomeIdHash: value.outcomeIdHash,
      listingEpoch: value.listingEpoch,
      releaseSequence: value.releaseSequence,
      policyVersionHash: value.policyVersionHash,
      listingCommitmentHash: value.listingCommitmentHash,
      grossAmount: value.grossAmount,
      providerNetAmount: value.providerNetAmount,
      daskiCommissionAmount: value.daskiCommissionAmount,
    };
  });
}

function normalizeDeployments(logs: readonly unknown[]): DeploymentEvidence[] {
  return parseEventLogs({
    abi: splitterFactoryAbi,
    logs: logs as never,
    eventName: "OutcomeSplitterDeployed",
  }).map((event) => {
    const value = event.args;
    if (
      value.splitter === undefined ||
      value.salt === undefined ||
      value.outcomeIdHash === undefined ||
      value.listingEpoch === undefined ||
      value.listingCommitmentHash === undefined
    ) throw new Error("OutcomeSplitterDeployed log is incomplete");
    return {
      ...positioned(event),
      factory: getAddress(event.address),
      splitter: getAddress(value.splitter),
      salt: value.salt,
      outcomeIdHash: value.outcomeIdHash,
      listingEpoch: value.listingEpoch,
      listingCommitmentHash: value.listingCommitmentHash,
    };
  });
}

function sameBoundPosition(value: PositionedEvidence, binding: LogBinding): boolean {
  return (
    compareEvidencePosition(value, binding) === 0 &&
    value.blockHash === binding.blockHash &&
    value.transactionHash === binding.transactionHash
  );
}

export class StandardChainEvidence {
  private readonly clients;
  private readonly wallet;

  constructor(
    private readonly config: StandardRailConfig,
    chain: Chain,
    private readonly nonceLock: FacilitatorNonceLock,
  ) {
    this.clients = config.evidenceRpcUrls.map((url) => ({
      url,
      host: new URL(url).hostname,
      client: createPublicClient({
        chain,
        transport: orderedRpcTransport(http(url, { retryCount: 0, timeout: 20_000 })),
      }),
    }));
    this.wallet = createWalletClient({
      account: privateKeyToAccount(config.releasePrivateKey),
      chain,
      transport: http(config.evidenceRpcUrls[0], { retryCount: 0, timeout: 20_000 }),
    }).extend(publicActions);
  }

  private observe<Result>(
    work: (endpoint: (typeof this.clients)[number]) => Promise<Result>,
  ): Promise<Result> {
    return withRpcFailover(this.clients, work, {
      onFallback: ({ primaryHost, selectedHost }) => {
        logger.warn("standard-rail RPC fallback selected", {
          primaryHost,
          selectedHost,
        });
      },
    });
  }

  private async submitRelease(splitter: Address): Promise<Hex> {
    return this.nonceLock.run(async () => {
      const submitted = await this.wallet.writeContract({
        address: splitter,
        abi: splitterAbi,
        functionName: "releaseAll",
      });
      await this.observe(({ client }) =>
        client.waitForTransactionReceipt({
          hash: submitted,
          confirmations: this.config.finalityConfirmations,
        })
      );
      return submitted;
    });
  }

  async verifyProviderIdentitySnapshot(snapshot: ProviderIdentitySnapshotV1): Promise<void> {
    const blockNumber = BigInt(snapshot.blockNumber);
    const observation = await this.observe(async ({ client }) => {
      const block = await client.getBlock({ blockNumber });
      const owner = await client.readContract({
        address: getAddress(snapshot.identityRegistry), abi: identitySnapshotAbi,
        functionName: "ownerOf", args: [BigInt(snapshot.providerAgentId)], blockNumber,
      });
      const agentWallet = await client.readContract({
        address: getAddress(snapshot.identityRegistry), abi: identitySnapshotAbi,
        functionName: "getAgentWallet", args: [BigInt(snapshot.providerAgentId)], blockNumber,
      });
      const provider = await client.readContract({
        address: getAddress(snapshot.providerRegistry), abi: providerSnapshotAbi,
        functionName: "getProvider", args: [BigInt(snapshot.providerAgentId)], blockNumber,
      });
      const settlement = await client.readContract({
        address: getAddress(snapshot.serviceRegistry), abi: serviceSnapshotAbi,
        functionName: "resolveSettlement", args: [snapshot.serviceId], blockNumber,
      });
      return { block, owner, agentWallet, provider, settlement };
    });
    const [providerAgentId, active, providerOwner, providerWallet, payee] = observation.settlement;
    if (
      observation.block.hash !== snapshot.blockHash ||
      getAddress(observation.owner) !== getAddress(snapshot.providerOwner) ||
      getAddress(observation.agentWallet) !== getAddress(snapshot.providerAgentWallet) ||
      observation.provider.agentId !== BigInt(snapshot.providerAgentId) || !observation.provider.isActive ||
      providerAgentId !== BigInt(snapshot.providerAgentId) || !active ||
      getAddress(providerOwner) !== getAddress(snapshot.providerOwner) ||
      getAddress(providerWallet) !== getAddress(snapshot.providerAgentWallet) ||
      getAddress(payee) !== getAddress(snapshot.providerPayee)
    ) throw new Error("Provider identity snapshot does not match finalized chain state");
  }

  async revalidateProviderIdentitySnapshot(snapshot: ProviderIdentitySnapshotV1): Promise<void> {
    const observation = await this.observe(async ({ client }) => {
      const finalized = await client.getBlock({ blockTag: "finalized" });
      const blockNumber = finalized.number;
      const [owner, agentWallet, provider, settlement] = await Promise.all([
        client.readContract({ address: getAddress(snapshot.identityRegistry), abi: identitySnapshotAbi,
          functionName: "ownerOf", args: [BigInt(snapshot.providerAgentId)], blockNumber }),
        client.readContract({ address: getAddress(snapshot.identityRegistry), abi: identitySnapshotAbi,
          functionName: "getAgentWallet", args: [BigInt(snapshot.providerAgentId)], blockNumber }),
        client.readContract({ address: getAddress(snapshot.providerRegistry), abi: providerSnapshotAbi,
          functionName: "getProvider", args: [BigInt(snapshot.providerAgentId)], blockNumber }),
        client.readContract({ address: getAddress(snapshot.serviceRegistry), abi: serviceSnapshotAbi,
          functionName: "resolveSettlement", args: [snapshot.serviceId], blockNumber }),
      ]);
      return { owner, agentWallet, provider, settlement };
    });
    const [providerAgentId, active, providerOwner, providerWallet, payee] = observation.settlement;
    if (
      getAddress(observation.owner) !== getAddress(snapshot.providerOwner) ||
      getAddress(observation.agentWallet) !== getAddress(snapshot.providerAgentWallet) ||
      observation.provider.agentId !== BigInt(snapshot.providerAgentId) || !observation.provider.isActive ||
      providerAgentId !== BigInt(snapshot.providerAgentId) || !active ||
      getAddress(providerOwner) !== getAddress(snapshot.providerOwner) ||
      getAddress(providerWallet) !== getAddress(snapshot.providerAgentWallet) ||
      getAddress(payee) !== getAddress(snapshot.providerPayee)
    ) throw new Error("Provider identity changed after listing admission");
  }

  async finalizedBlockTimestamp(blockNumber: bigint, expectedHash: Hex): Promise<number> {
    const block = await this.observe(({ client }) => client.getBlock({ blockNumber }));
    if (block.hash !== expectedHash || block.timestamp > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Finalized evidence block timestamp is unavailable");
    }
    return Number(block.timestamp);
  }

  async verifyCanonicalToken(chainId: number): Promise<void> {
    if (
      this.config.manifest.chainEvidencePolicy.chainId !== chainId ||
      this.config.manifest.chainEvidencePolicy.environment !== this.config.environment
    ) throw new Error("Chain evidence policy domain mismatch");
    await this.observe(async ({ client }) => {
      const head = await client.getBlockNumber();
      await this.tokenPolicyFacts(client, head);
    });
  }

  private async tokenPolicyFacts(
    client: (typeof this.clients)[number]["client"],
    blockNumber?: bigint,
  ): Promise<Record<string, unknown>> {
    const policy = this.config.manifest.chainEvidencePolicy.payload;
    const token = getAddress(policy.canonicalToken);
    // Keep per-source archive reads ordered because public RPCs reject large historical bursts.
    const tokenCode = await client.getBytecode({ address: token, blockNumber });
    const implementationStorage = await client.getStorageAt({
      address: token, slot: policy.tokenImplementationSlot, blockNumber,
    });
    const domainSeparator = await client.readContract({
      address: token,
      abi: tokenPolicyAbi,
      functionName: "DOMAIN_SEPARATOR",
      blockNumber,
    });
    if (!tokenCode || !implementationStorage) throw new Error("Canonical-token code or implementation is unavailable");
    const implementation = getAddress(`0x${implementationStorage.slice(-40)}`);
    const implementationCode = await client.getBytecode({ address: implementation, blockNumber });
    if (
      keccak256(tokenCode) !== policy.canonicalTokenRuntimeCodeHash ||
      implementation !== getAddress(policy.tokenImplementationAddress) ||
      !implementationCode || keccak256(implementationCode) !== policy.tokenImplementationRuntimeCodeHash ||
      domainSeparator !== policy.tokenDomainSeparator
    ) throw new Error("Canonical-token code, implementation, or EIP-712 domain changed");
    return {
      token,
      tokenRuntimeCodeHash: keccak256(tokenCode),
      implementation,
      implementationRuntimeCodeHash: keccak256(implementationCode),
      domainSeparator,
    };
  }

  async verifyListingDeployment(listing: StandardListing, chainId: number): Promise<void> {
    const manifest = listing.manifest.payload;
    const splitter = getAddress(manifest.splitterAddress);
    const factory = getAddress(manifest.splitterFactory);
    const expectedCommitmentHash = canonicalHash(listing.commitment);
    const provenance = deriveSplitterProvenance({
      constructor: {
        chainId,
        canonicalToken: getAddress(manifest.canonicalToken),
        providerPayee: getAddress(manifest.providerPayee),
        daskiCommissionReceiver: getAddress(manifest.daskiCommissionReceiver),
        commissionBps: manifest.commissionBps,
        policyVersionHash: manifest.policyVersionHash,
        outcomeIdHash: manifest.outcomeIdHash,
        listingCommitmentHash: manifest.listingCommitmentHash,
        listingEpoch: BigInt(manifest.listingEpoch),
      },
      provenance: {
        splitterAddress: splitter,
        splitterFactory: factory,
        splitterFactoryRuntimeCodeHash: manifest.splitterFactoryRuntimeCodeHash,
        splitterDeploymentSalt: manifest.splitterDeploymentSalt,
        splitterCreationCode: manifest.splitterCreationCode,
        splitterCreationCodeHash: manifest.splitterCreationCodeHash,
        splitterInitCodeHash: manifest.splitterInitCodeHash,
        splitterImmutableHash: manifest.splitterImmutableHash,
      },
      trustedSplitterCreationCodeHash: this.config.splitterCreationCodeHash,
      trustedSplitterFactoryRuntimeCodeHash: this.config.splitterFactoryRuntimeCodeHash,
    });
    const deploymentBlockNumber = BigInt(manifest.splitterDeploymentBlockNumber);
    const activationBlockNumber = BigInt(manifest.splitterActivationBlockNumber);
    const deploymentBinding: LogBinding = {
      blockNumber: deploymentBlockNumber,
      blockHash: manifest.splitterDeploymentBlockHash,
      transactionIndex: manifest.splitterDeploymentTransactionIndex,
      logIndex: manifest.splitterDeploymentLogIndex,
      transactionHash: manifest.splitterDeploymentTransaction,
    };
    await this.observe(async ({ client }) => {
      const receipt = await client.getTransactionReceipt({
        hash: manifest.splitterDeploymentTransaction,
      });
      const deploymentTransaction = await client.getTransaction({
        hash: manifest.splitterDeploymentTransaction,
      });
      // Verify one historical fact at a time so the selected RPC remains usable under load.
      const head = await client.getBlockNumber();
      const deploymentBlock = await client.getBlock({ blockNumber: deploymentBlockNumber });
      const activationBlock = await client.getBlock({ blockNumber: activationBlockNumber });
      const codeAtDeployment = await client.getBytecode({
        address: splitter, blockNumber: deploymentBlockNumber,
      });
      const codeAtActivation = await client.getBytecode({
        address: splitter, blockNumber: activationBlockNumber,
      });
      const factoryCodeAtDeployment = await client.getBytecode({
        address: factory, blockNumber: deploymentBlockNumber,
      });
      const factoryCodeAtActivation = await client.getBytecode({
        address: factory, blockNumber: activationBlockNumber,
      });
      await this.tokenPolicyFacts(client, activationBlockNumber);
      const startingTokenBalance = await client.readContract({
        address: getAddress(manifest.canonicalToken),
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [splitter],
        blockNumber: activationBlockNumber,
      });
      const startingReleaseSequence = await client.readContract({ address: splitter,
        abi: splitterAbi, functionName: "releaseSequence", blockNumber: activationBlockNumber });
      const canonicalChainId = await client.readContract({ address: splitter,
        abi: splitterAbi, functionName: "canonicalChainId", blockNumber: activationBlockNumber });
      const token = await client.readContract({ address: splitter,
        abi: splitterAbi, functionName: "canonicalToken", blockNumber: activationBlockNumber });
      const payee = await client.readContract({ address: splitter,
        abi: splitterAbi, functionName: "providerPayee", blockNumber: activationBlockNumber });
      const receiver = await client.readContract({ address: splitter,
        abi: splitterAbi, functionName: "daskiCommissionReceiver", blockNumber: activationBlockNumber });
      const bps = await client.readContract({ address: splitter,
        abi: splitterAbi, functionName: "commissionBps", blockNumber: activationBlockNumber });
      const policyHash = await client.readContract({ address: splitter,
        abi: splitterAbi, functionName: "policyVersionHash", blockNumber: activationBlockNumber });
      const outcomeHash = await client.readContract({ address: splitter,
        abi: splitterAbi, functionName: "outcomeIdHash", blockNumber: activationBlockNumber });
      const listingEpoch = await client.readContract({ address: splitter,
        abi: splitterAbi, functionName: "listingEpoch", blockNumber: activationBlockNumber });
      const commitmentHash = await client.readContract({ address: splitter,
        abi: splitterAbi, functionName: "listingCommitmentHash", blockNumber: activationBlockNumber });
      assertActivationCheckpoint({
        activationBlockNumber,
        expectedBlockHash: manifest.splitterActivationBlockHash,
        observedBlockHash: activationBlock.hash,
        expectedTokenBalance: BigInt(manifest.splitterStartingTokenBalance),
        observedTokenBalance: startingTokenBalance,
        expectedReleaseSequence: BigInt(manifest.splitterStartingReleaseSequence),
        observedReleaseSequence: startingReleaseSequence,
      });
      if (
        receipt.status !== "success" ||
        receipt.transactionHash !== manifest.splitterDeploymentTransaction ||
        receipt.blockNumber !== deploymentBlockNumber ||
        receipt.blockHash !== manifest.splitterDeploymentBlockHash ||
        receipt.transactionIndex !== manifest.splitterDeploymentTransactionIndex ||
        deploymentBlock.hash !== manifest.splitterDeploymentBlockHash ||
        !hasRequiredConfirmations(head, deploymentBlockNumber, this.config.finalityConfirmations) ||
        !hasRequiredConfirmations(head, activationBlockNumber, this.config.finalityConfirmations)
      ) throw new Error("Splitter deployment transaction is not final or manifest-bound");
      const expectedDeploymentInput = encodeFunctionData({
        abi: splitterFactoryAbi,
        functionName: "deploy",
        args: [
          manifest.splitterDeploymentSalt,
          BigInt(manifest.chainId),
          getAddress(manifest.canonicalToken),
          getAddress(manifest.providerPayee),
          getAddress(manifest.daskiCommissionReceiver),
          manifest.commissionBps,
          manifest.policyVersionHash,
          manifest.outcomeIdHash,
          manifest.listingCommitmentHash,
          BigInt(manifest.listingEpoch),
        ],
      });
      if (
        deploymentTransaction.hash !== manifest.splitterDeploymentTransaction ||
        !deploymentTransaction.to || getAddress(deploymentTransaction.to) !== factory ||
        deploymentTransaction.value !== 0n ||
        deploymentTransaction.input.toLowerCase() !== expectedDeploymentInput.toLowerCase() ||
        deploymentTransaction.blockNumber !== deploymentBlockNumber ||
        deploymentTransaction.blockHash !== manifest.splitterDeploymentBlockHash ||
        deploymentTransaction.transactionIndex !== manifest.splitterDeploymentTransactionIndex
      ) throw new Error("Splitter deployment transaction calldata or position is invalid");
      if (
        !codeAtDeployment || !codeAtActivation ||
        !factoryCodeAtDeployment || !factoryCodeAtActivation ||
        keccak256(codeAtDeployment) !== manifest.splitterRuntimeCodeHash ||
        keccak256(codeAtActivation) !== manifest.splitterRuntimeCodeHash ||
        keccak256(factoryCodeAtDeployment) !== this.config.splitterFactoryRuntimeCodeHash ||
        keccak256(factoryCodeAtActivation) !== this.config.splitterFactoryRuntimeCodeHash ||
        canonicalChainId !== BigInt(chainId) ||
        getAddress(token) !== getAddress(manifest.canonicalToken) ||
        getAddress(payee) !== getAddress(manifest.providerPayee) ||
        getAddress(receiver) !== getAddress(manifest.daskiCommissionReceiver) ||
        bps !== manifest.commissionBps || policyHash !== manifest.policyVersionHash ||
        outcomeHash !== manifest.outcomeIdHash || listingEpoch !== BigInt(manifest.listingEpoch) ||
        commitmentHash !== expectedCommitmentHash ||
        provenance.immutableHash !== manifest.splitterImmutableHash
      ) throw new Error("Splitter immutable values do not match the listing");
      const deployments = normalizeDeployments(receipt.logs)
        .filter((event) => sameBoundPosition(event, deploymentBinding));
      if (deployments.length !== 1) {
        throw new Error("Receipt-bound splitter deployment event is missing or ambiguous");
      }
      const deployment = deployments[0]!;
      if (
        deployment.factory !== factory || deployment.splitter !== splitter ||
        deployment.salt !== manifest.splitterDeploymentSalt ||
        deployment.outcomeIdHash !== manifest.outcomeIdHash ||
        deployment.listingEpoch !== BigInt(manifest.listingEpoch) ||
        deployment.listingCommitmentHash !== expectedCommitmentHash
      ) throw new Error("Receipt-bound splitter deployment event is invalid");
    });
  }

  async verifyScreeningPolicy(listing: StandardListing): Promise<void> {
    const policy = listing.screeningPolicy;
    const oracle = getAddress(policy.sanctionsOracle);
    await this.observe(async ({ client }) => {
      const head = await client.getBlockNumber();
      const code = await client.getBytecode({ address: oracle, blockNumber: head });
      if (!code || keccak256(code) !== policy.sanctionsOracleRuntimeCodeHash) {
        throw new Error("Screening oracle runtime code does not match the signed policy");
      }
    });
  }

  async proveDeposit(args: {
    order: StandardOrderRecord;
    listing: StandardListing;
    transactionHash: Hex;
    paymentNonce: Hex;
  }): Promise<EvidenceResult> {
    const finalityDeadline = args.order.updatedAt.getTime() +
      args.listing.deadlinePolicy.settlementEvidenceSeconds * 1_000;
    const observation = await this.observe(async ({ client, host }) => {
      await client.waitForTransactionReceipt({
        hash: args.transactionHash,
        confirmations: this.config.finalityConfirmations,
        pollingInterval: 2_000,
        timeout: Math.max(1, finalityDeadline - Date.now()),
      });
      const [receipt, head] = await Promise.all([
        client.getTransactionReceipt({ hash: args.transactionHash }),
        client.getBlockNumber(),
      ]);
      if (
        receipt.status !== "success" ||
        !hasRequiredConfirmations(head, receipt.blockNumber, this.config.finalityConfirmations) ||
        receipt.blockNumber <= BigInt(args.listing.manifest.payload.splitterActivationBlockNumber)
      ) {
        throw new Error("Settlement transaction is not finalized after splitter activation");
      }
      await this.tokenPolicyFacts(client, receipt.blockNumber);
      const used = parseEventLogs({ abi: transferAuthorizationAbi, logs: receipt.logs, eventName: "AuthorizationUsed" })
        .filter((event) =>
          event.address.toLowerCase() === args.listing.commitment.payload.canonicalToken.toLowerCase() &&
          event.args.authorizer !== undefined && args.order.payer !== null &&
          getAddress(event.args.authorizer) === getAddress(args.order.payer) &&
          event.args.nonce === args.paymentNonce
        );
      if (used.length !== 1 || args.order.payer === null) {
        throw new Error("AuthorizationUsed evidence is missing or ambiguous");
      }
      const matching = normalizeTransfers(receipt.logs).filter((event) =>
        event.token === getAddress(args.listing.commitment.payload.canonicalToken) &&
        event.from === getAddress(args.order.payer!) &&
        event.to === getAddress(args.listing.manifest.payload.splitterAddress) &&
        event.value === BigInt(args.order.grossAmount)
      );
      if (matching.length !== 1) throw new Error("Transfer evidence is missing or ambiguous");
      const deposit = selectBoundDeposit({
        transfers: matching,
        binding: matching[0]!,
        token: getAddress(args.listing.commitment.payload.canonicalToken),
        payer: getAddress(args.order.payer),
        splitter: getAddress(args.listing.manifest.payload.splitterAddress),
        grossAmount: BigInt(args.order.grossAmount),
      });
      return {
        source: host,
        blockNumber: receipt.blockNumber.toString(),
        blockHash: receipt.blockHash,
        transactionHash: receipt.transactionHash,
        transactionIndex: receipt.transactionIndex,
        logIndex: deposit.logIndex,
        logsHash: chainLogsHash(receipt.logs),
      } satisfies SourceObservation;
    });
    return this.agree([observation], "deposit");
  }

  async assertNotSanctioned(
    oracle: Address,
    expectedRuntimeCodeHash: Hex,
    accounts: readonly Address[],
  ): Promise<void> {
    if (oracle === "0x0000000000000000000000000000000000000000") {
      throw new Error("Standard-rail screening oracle is not configured");
    }
    const unique = [...new Set(accounts.map((account) => getAddress(account).toLowerCase()))]
      .map((account) => getAddress(account));
    const observation = await this.observe(async ({ client }) => {
      const head = await client.getBlockNumber();
      // Aggregate the per-account reads into one pinned eth_call; keyed RPC quota is the constraint.
      const [code, results] = await Promise.all([
        client.getBytecode({ address: oracle, blockNumber: head }),
        client.multicall({
          contracts: unique.map((account) => ({
            address: oracle,
            abi: sanctionsOracleAbi,
            functionName: "isSanctioned",
            args: [account],
          } as const)),
          allowFailure: false,
          blockNumber: head,
        }),
      ]);
      if (!code || keccak256(code) !== expectedRuntimeCodeHash) {
        throw new Error("Screening oracle runtime code changed");
      }
      return results;
    });
    if (observation.some(Boolean)) throw new Error("SANCTIONS_ADDRESS_REJECTED");
  }

  async authorizationUsed(token: Address, payer: Address, nonce: Hex): Promise<boolean> {
    return this.observe(({ client }) =>
      client.readContract({
        address: token,
        abi: transferAuthorizationAbi,
        functionName: "authorizationState",
        args: [payer, nonce],
      })
    );
  }

  async findSettlementTransaction(args: {
    listing: StandardListing;
    payer: Address;
    nonce: Hex;
  }): Promise<Hex | null> {
    return this.observe(async ({ client }) => {
      const head = await client.getBlockNumber();
      const logs = await this.boundedLogs({
        fromBlock: BigInt(args.listing.manifest.payload.splitterActivationBlockNumber) + 1n,
        toBlock: head,
        maxEvents: this.config.manifest.chainEvidencePolicy.payload.maximumLogPageEvents,
        load: (fromBlock, toBlock) => client.getLogs({
          address: getAddress(args.listing.commitment.payload.canonicalToken),
          event: authorizationUsedEvent,
          args: { authorizer: args.payer, nonce: args.nonce },
          fromBlock,
          toBlock,
        }),
      });
      if (logs.length === 0) return null;
      if (logs.length !== 1 || !logs[0]!.transactionHash) {
        throw new Error("Authorization use history is ambiguous");
      }
      return logs[0]!.transactionHash;
    });
  }

  async releaseAndProve(args: {
    order: StandardOrderRecord;
    listing: StandardListing;
    deposit: EvidenceResult;
  }): Promise<ReleaseEvidenceResult> {
    const splitter = getAddress(args.listing.manifest.payload.splitterAddress);
    const findRelease = () =>
      this.observe(({ client }) => this.findCoveringRelease(client, args));
    let releaseReference = await findRelease();
    if (!releaseReference) {
      try {
        await this.submitRelease(splitter);
      } catch (error) {
        releaseReference = await findRelease();
        if (!releaseReference) throw error;
      }
      releaseReference ??= await findRelease();
      if (!releaseReference) throw new Error("Finalized release event was not found after release submission");
    }
    const hash = releaseReference.transactionHash;
    const selected = await this.observe(async ({ client, host }) => {
      await client.waitForTransactionReceipt({
        hash,
        confirmations: this.config.finalityConfirmations,
      });
      const manifest = args.listing.manifest.payload;
      const activationBlockNumber = BigInt(manifest.splitterActivationBlockNumber);
      const maximumPageEvents =
        this.config.manifest.chainEvidencePolicy.payload.maximumLogPageEvents;
      const receipt = await client.getTransactionReceipt({ hash });
      const [head, activationBlock, releaseCode, startingTokenBalance,
        startingReleaseSequence, token, payee, receiver, bps, commitment,
        policyHash, outcomeIdHash, listingEpoch] = await Promise.all([
        client.getBlockNumber(),
        client.getBlock({ blockNumber: activationBlockNumber }),
        client.getBytecode({ address: splitter, blockNumber: receipt.blockNumber }),
        client.readContract({
          address: getAddress(manifest.canonicalToken),
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [splitter],
          blockNumber: activationBlockNumber,
        }),
        client.readContract({ address: splitter, abi: splitterAbi,
          functionName: "releaseSequence", blockNumber: activationBlockNumber }),
        client.readContract({ address: splitter, abi: splitterAbi,
          functionName: "canonicalToken", blockNumber: activationBlockNumber }),
        client.readContract({ address: splitter, abi: splitterAbi,
          functionName: "providerPayee", blockNumber: activationBlockNumber }),
        client.readContract({ address: splitter, abi: splitterAbi,
          functionName: "daskiCommissionReceiver", blockNumber: activationBlockNumber }),
        client.readContract({ address: splitter, abi: splitterAbi,
          functionName: "commissionBps", blockNumber: activationBlockNumber }),
        client.readContract({ address: splitter, abi: splitterAbi,
          functionName: "listingCommitmentHash", blockNumber: activationBlockNumber }),
        client.readContract({ address: splitter, abi: splitterAbi,
          functionName: "policyVersionHash", blockNumber: activationBlockNumber }),
        client.readContract({ address: splitter, abi: splitterAbi,
          functionName: "outcomeIdHash", blockNumber: activationBlockNumber }),
        client.readContract({ address: splitter, abi: splitterAbi,
          functionName: "listingEpoch", blockNumber: activationBlockNumber }),
      ]);
      await this.tokenPolicyFacts(client, receipt.blockNumber);
      if (
        receipt.status !== "success" ||
        receipt.transactionHash !== releaseReference.transactionHash ||
        receipt.blockNumber !== releaseReference.blockNumber ||
        receipt.blockHash !== releaseReference.blockHash ||
        receipt.transactionIndex !== releaseReference.transactionIndex ||
        !hasRequiredConfirmations(head, receipt.blockNumber, this.config.finalityConfirmations)
      ) throw new Error("Release transaction is not finalized or receipt-bound");
      assertActivationCheckpoint({
        activationBlockNumber,
        expectedBlockHash: manifest.splitterActivationBlockHash,
        observedBlockHash: activationBlock.hash,
        expectedTokenBalance: BigInt(manifest.splitterStartingTokenBalance),
        observedTokenBalance: startingTokenBalance,
        expectedReleaseSequence: BigInt(manifest.splitterStartingReleaseSequence),
        observedReleaseSequence: startingReleaseSequence,
        depositBlockNumber: args.deposit.blockNumber,
        releaseBlockNumber: receipt.blockNumber,
      });
      if (!releaseCode || keccak256(releaseCode) !== manifest.splitterRuntimeCodeHash) {
        throw new Error("Splitter runtime code changed before the selected release");
      }
      const release = selectBoundRelease({
        releases: normalizeReleases(receipt.logs),
        binding: releaseReference,
        splitter,
        releaseSequence: releaseReference.releaseSequence,
      });
      const previous = await this.previousRelease(
        client,
        splitter,
        activationBlockNumber,
        BigInt(manifest.splitterStartingReleaseSequence),
        release,
        maximumPageEvents,
      );
      const creditLogs = await this.boundedLogs({
        fromBlock: previous?.blockNumber ?? activationBlockNumber + 1n,
        toBlock: receipt.blockNumber,
        maxEvents: maximumPageEvents,
        load: (fromBlock, toBlock) => client.getLogs({
          address: getAddress(manifest.canonicalToken),
          event: transferEvent,
          args: { to: splitter },
          fromBlock,
          toBlock,
        }),
      });
      if (
        getAddress(token) !== getAddress(manifest.canonicalToken) ||
        getAddress(payee) !== getAddress(manifest.providerPayee) ||
        getAddress(receiver) !== getAddress(manifest.daskiCommissionReceiver) ||
        bps !== manifest.commissionBps || commitment !== canonicalHash(args.listing.commitment) ||
        policyHash !== manifest.policyVersionHash || outcomeIdHash !== manifest.outcomeIdHash ||
        listingEpoch !== BigInt(manifest.listingEpoch) || args.order.payer === null
      ) throw new Error("Splitter immutable evidence changed before release");
      const transfers = normalizeTransfers(creditLogs);
      const deposit = selectBoundDeposit({
        transfers,
        binding: {
          blockNumber: args.deposit.blockNumber,
          blockHash: args.deposit.blockHash,
          transactionIndex: args.deposit.transactionIndex,
          logIndex: args.deposit.logIndex,
          transactionHash: args.deposit.transactionHash,
        },
        token: getAddress(manifest.canonicalToken),
        payer: getAddress(args.order.payer),
        splitter,
        grossAmount: BigInt(args.order.grossAmount),
      });
      const result = verifyReleaseInterval({
        activationBlockNumber,
        startingTokenBalance,
        startingReleaseSequence,
        deposit,
        release,
        previousRelease: previous,
        credits: transfers,
        payoutTransfers: normalizeTransfers(receipt.logs),
        token: getAddress(manifest.canonicalToken),
        splitter,
        providerPayee: getAddress(manifest.providerPayee),
        daskiCommissionReceiver: getAddress(manifest.daskiCommissionReceiver),
        commissionBps: manifest.commissionBps,
        outcomeIdHash: manifest.outcomeIdHash,
        listingEpoch: BigInt(manifest.listingEpoch),
        policyVersionHash: manifest.policyVersionHash,
        listingCommitmentHash: manifest.listingCommitmentHash,
      });
      const observation: SourceObservation = {
        source: host,
        blockNumber: receipt.blockNumber.toString(),
        blockHash: receipt.blockHash,
        transactionHash: receipt.transactionHash,
        transactionIndex: receipt.transactionIndex,
        logIndex: release.logIndex,
        logsHash: chainLogsHash(receipt.logs),
      };
      const allocation = {
        providerNetAmount: result.providerNetAmount.toString(),
        daskiCommissionAmount: result.daskiCommissionAmount.toString(),
        releaseSequence: release.releaseSequence.toString(),
        initialBalance: (previous ? 0n : startingTokenBalance).toString(),
        interval: result.interval.map((credit) => ({
          blockNumber: credit.blockNumber.toString(),
          blockHash: credit.blockHash,
          transactionIndex: credit.transactionIndex,
          logIndex: credit.logIndex,
          transactionHash: credit.transactionHash,
          token: credit.token,
          from: credit.from,
          to: credit.to,
          amount: credit.value.toString(),
          recognizedOrder: compareEvidencePosition(credit, deposit) === 0 &&
            credit.blockHash === deposit.blockHash &&
            credit.transactionHash === deposit.transactionHash,
        })),
      };
      return { observation, allocation };
    });
    const observations = [selected];
    const first = selected;
    const canonicalEvidence = { kind: "release", observations };
    return {
      transactionHash: first.observation.transactionHash,
      blockNumber: BigInt(first.observation.blockNumber),
      blockHash: first.observation.blockHash,
      transactionIndex: first.observation.transactionIndex,
      logIndex: first.observation.logIndex,
      evidenceHash: canonicalHash(canonicalEvidence),
      canonicalEvidence,
      sources: observations.map(({ observation }) => observation.source),
      providerNetAmount: BigInt(first.allocation.providerNetAmount),
      daskiCommissionAmount: BigInt(first.allocation.daskiCommissionAmount),
      releaseSequence: BigInt(first.allocation.releaseSequence),
    };
  }

  private async findCoveringRelease(
    client: (typeof this.clients)[number]["client"],
    args: { order: StandardOrderRecord; listing: StandardListing; deposit: EvidenceResult },
  ): Promise<ReleaseReference | null> {
    const head = await client.getBlockNumber();
    const confirmationDepth = BigInt(this.config.finalityConfirmations - 1);
    if (head < confirmationDepth) return null;
    const finalizedBlock = head - confirmationDepth;
    const activationBlock = BigInt(args.listing.manifest.payload.splitterActivationBlockNumber);
    const fromBlock = args.deposit.blockNumber > activationBlock
      ? args.deposit.blockNumber
      : activationBlock + 1n;
    if (finalizedBlock < fromBlock) return null;
    const raw = await loadLogsPaged({
      fromBlock,
      toBlock: finalizedBlock,
      maximumPageEvents: this.config.manifest.chainEvidencePolicy.payload.maximumLogPageEvents,
      load: (pageFrom, pageTo) => client.getLogs({
        address: getAddress(args.listing.manifest.payload.splitterAddress),
        event: releasedEvent,
        fromBlock: pageFrom,
        toBlock: pageTo,
      }),
    });
    const depositBinding: LogBinding = {
      blockNumber: args.deposit.blockNumber,
      blockHash: args.deposit.blockHash,
      transactionIndex: args.deposit.transactionIndex,
      logIndex: args.deposit.logIndex,
      transactionHash: args.deposit.transactionHash,
    };
    const covering = normalizeReleases(raw)
      .filter((event) =>
        compareEvidencePosition(event, depositBinding) > 0 &&
        event.releaseSequence > BigInt(args.listing.manifest.payload.splitterStartingReleaseSequence)
      )
      .sort(compareEvidencePosition)[0];
    if (!covering) return null;
    return {
      blockNumber: covering.blockNumber,
      blockHash: covering.blockHash,
      transactionIndex: covering.transactionIndex,
      logIndex: covering.logIndex,
      transactionHash: covering.transactionHash,
      releaseSequence: covering.releaseSequence,
    };
  }

  private async previousRelease(
    client: (typeof this.clients)[number]["client"],
    splitter: Address,
    activationBlock: bigint,
    startingReleaseSequence: bigint,
    release: ReleasedEvidence,
    maximumPageEvents: number,
  ): Promise<ReleasedEvidence | null> {
    if (release.releaseSequence === startingReleaseSequence + 1n) return null;
    if (release.releaseSequence <= startingReleaseSequence + 1n) {
      throw new Error("Release sequence is outside the activated history");
    }
    const raw = await loadLogsPaged({
      fromBlock: activationBlock + 1n,
      toBlock: release.blockNumber,
      maximumPageEvents,
      load: (fromBlock, toBlock) => client.getLogs({
        address: splitter,
        event: releasedEvent,
        args: { releaseSequence: release.releaseSequence - 1n },
        fromBlock,
        toBlock,
      }),
    });
    const previous = normalizeReleases(raw).filter((event) =>
      event.releaseSequence === release.releaseSequence - 1n &&
      compareEvidencePosition(event, release) < 0
    );
    if (previous.length !== 1) throw new Error("Previous release event is missing or ambiguous");
    return previous[0]!;
  }

  private async boundedLogs<T>(args: {
    fromBlock: bigint;
    toBlock: bigint;
    maxEvents: number;
    load(fromBlock: bigint, toBlock: bigint): Promise<readonly T[]>;
  }): Promise<T[]> {
    return loadLogsPaged({
      fromBlock: args.fromBlock,
      toBlock: args.toBlock,
      maximumPageEvents: args.maxEvents,
      load: args.load,
    });
  }

  private agree(observations: SourceObservation[], kind: string): EvidenceResult {
    if (observations.length !== 1) {
      throw new Error("Chain evidence requires one selected RPC source");
    }
    const first = observations[0]!;
    const canonicalEvidence = { kind, observations };
    return {
      transactionHash: first.transactionHash,
      blockNumber: BigInt(first.blockNumber),
      blockHash: first.blockHash,
      transactionIndex: first.transactionIndex,
      logIndex: first.logIndex,
      evidenceHash: canonicalHash(canonicalEvidence),
      canonicalEvidence,
      sources: observations.map((item) => item.source),
    };
  }
}
