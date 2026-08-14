import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  parseAbi,
  parseAbiItem,
  parseEventLogs,
  publicActions,
  keccak256,
  stringToHex,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { StandardRailConfig } from "./config.js";
import type { PaymentPayload } from "@x402/core/types";
import { canonicalHash } from "./canonical.js";
import type { ProviderIdentitySnapshotV1, StandardListing, StandardOrderRecord } from "./types.js";

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
  "event Released(bytes32 indexed outcomeIdHash,uint64 indexed listingEpoch,uint64 indexed releaseSequence,bytes32 policyVersionHash,bytes32 listingCommitmentHash,uint256 grossAmount,uint256 providerNetAmount,uint256 daskiCommissionAmount)",
]);
const splitterFactoryAbi = parseAbi([
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
  transactionTo: Address;
  transactionFrom: Address;
  transactionIndex: number;
  logIndex: number;
  input: Hex;
  logsHash: Hex;
  traceHash: Hex;
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

function position(value: { blockNumber: bigint | null; transactionIndex: number | null; logIndex: number | null }) {
  if (value.blockNumber === null || value.transactionIndex === null || value.logIndex === null) {
    throw new Error("Chain log position is incomplete");
  }
  return [value.blockNumber, BigInt(value.transactionIndex), BigInt(value.logIndex)] as const;
}

function comparePosition(
  left: readonly [bigint, bigint, bigint],
  right: readonly [bigint, bigint, bigint],
): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]! < right[index]!) return -1;
    if (left[index]! > right[index]!) return 1;
  }
  return 0;
}

export function assertRefundNetworkFee(args: {
  gas: bigint | undefined;
  maxFeePerGas: bigint | undefined;
  maxPriorityFeePerGas: bigint | undefined;
  maximumNetworkFee: bigint;
}): void {
  if (
    args.gas === undefined || args.maxFeePerGas === undefined ||
    args.maxPriorityFeePerGas === undefined || args.gas <= 0n ||
    args.maxFeePerGas <= 0n || args.maxPriorityFeePerGas < 0n ||
    args.maxPriorityFeePerGas > args.maxFeePerGas ||
    args.gas * args.maxFeePerGas > args.maximumNetworkFee
  ) throw new Error("Refund transaction exceeds the signed runtime network-fee ceiling");
}

export class StandardChainEvidence {
  private readonly clients;
  private readonly wallet;
  private readonly refundWallet;

  constructor(private readonly config: StandardRailConfig, chain: Chain) {
    this.clients = config.evidenceRpcUrls.map((url) => ({
      url,
      host: new URL(url).hostname,
      client: createPublicClient({ chain, transport: http(url, { retryCount: 0, timeout: 20_000 }) }),
    }));
    this.wallet = createWalletClient({
      account: privateKeyToAccount(config.releasePrivateKey),
      chain,
      transport: http(config.evidenceRpcUrls[0], { retryCount: 0, timeout: 20_000 }),
    }).extend(publicActions);
    this.refundWallet = createWalletClient({
      account: privateKeyToAccount(config.refundPrivateKey),
      chain,
      transport: http(config.evidenceRpcUrls[0], { retryCount: 0, timeout: 20_000 }),
    }).extend(publicActions);
  }

  async verifyProviderIdentitySnapshot(snapshot: ProviderIdentitySnapshotV1): Promise<void> {
    const blockNumber = BigInt(snapshot.blockNumber);
    const observations = await Promise.all(this.clients.map(async ({ client }) => {
      const [block, owner, agentWallet, provider, settlement] = await Promise.all([
        client.getBlock({ blockNumber }),
        client.readContract({ address: getAddress(snapshot.identityRegistry), abi: identitySnapshotAbi,
          functionName: "ownerOf", args: [BigInt(snapshot.providerAgentId)], blockNumber }),
        client.readContract({ address: getAddress(snapshot.identityRegistry), abi: identitySnapshotAbi,
          functionName: "getAgentWallet", args: [BigInt(snapshot.providerAgentId)], blockNumber }),
        client.readContract({ address: getAddress(snapshot.providerRegistry), abi: providerSnapshotAbi,
          functionName: "getProvider", args: [BigInt(snapshot.providerAgentId)], blockNumber }),
        client.readContract({ address: getAddress(snapshot.serviceRegistry), abi: serviceSnapshotAbi,
          functionName: "resolveSettlement", args: [snapshot.serviceId], blockNumber }),
      ]);
      return { block, owner, agentWallet, provider, settlement };
    }));
    for (const observation of observations) {
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
  }

  async revalidateProviderIdentitySnapshot(snapshot: ProviderIdentitySnapshotV1): Promise<void> {
    const observations = await Promise.all(this.clients.map(async ({ client }) => {
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
    }));
    for (const observation of observations) {
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
  }

  async finalizedBlockTimestamp(blockNumber: bigint, expectedHash: Hex): Promise<number> {
    const blocks = await Promise.all(this.clients.map(({ client }) =>
      client.getBlock({ blockNumber })
    ));
    if (blocks.some((block) => block.hash !== expectedHash || block.timestamp > BigInt(Number.MAX_SAFE_INTEGER))) {
      throw new Error("Finalized evidence block timestamp is unavailable");
    }
    const timestamps = new Set(blocks.map((block) => block.timestamp.toString()));
    if (timestamps.size !== 1) throw new Error("Finalized evidence sources disagree on timestamp");
    return Number(blocks[0]!.timestamp);
  }

  async verifyCanonicalToken(chainId: number): Promise<void> {
    const policy = this.config.manifest.chainEvidencePolicy.payload;
    if (
      this.config.manifest.chainEvidencePolicy.chainId !== chainId ||
      this.config.manifest.chainEvidencePolicy.environment !== this.config.environment
    ) throw new Error("Chain evidence policy domain mismatch");
    const observations = await Promise.all(this.clients.map(async ({ client, host }) => ({
      host,
      head: await client.getBlockNumber(),
      facts: await this.tokenPolicyFacts(client),
    })));
    const heads = observations.map(({ head }) => head);
    const lag = heads.reduce((max, value) => value > max ? value : max) -
      heads.reduce((min, value) => value < min ? value : min);
    if (lag > BigInt(policy.maximumSourceLagBlocks)) {
      throw new Error("Canonical-token evidence sources exceed the approved lag");
    }
    if (
      new Set(observations.map(({ host }) => host)).size < 2 ||
      new Set(observations.map(({ facts }) => canonicalHash(facts))).size !== 1
    ) throw new Error("Canonical-token evidence sources disagree");
  }

  private async tokenPolicyFacts(
    client: (typeof this.clients)[number]["client"],
    blockNumber?: bigint,
  ): Promise<Record<string, unknown>> {
    const policy = this.config.manifest.chainEvidencePolicy.payload;
    const token = getAddress(policy.canonicalToken);
    const [tokenCode, implementationStorage, domainSeparator] = await Promise.all([
      client.getBytecode({ address: token, blockNumber }),
      client.getStorageAt({ address: token, slot: policy.tokenImplementationSlot, blockNumber }),
      client.readContract({
        address: token,
        abi: tokenPolicyAbi,
        functionName: "DOMAIN_SEPARATOR",
        blockNumber,
      }),
    ]);
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
    const splitter = getAddress(listing.manifest.payload.splitterAddress);
    const expectedCommitmentHash = canonicalHash(listing.commitment);
    const observations = await Promise.all(this.clients.map(async ({ client, host }) => {
      const [code, receipt, head, canonicalChainId, token, payee, receiver, bps, policyHash,
        outcomeHash, listingEpoch, commitmentHash] = await Promise.all([
        client.getBytecode({ address: splitter }),
        client.getTransactionReceipt({ hash: listing.manifest.payload.splitterDeploymentTransaction }),
        client.getBlockNumber(),
        client.readContract({ address: splitter, abi: splitterAbi, functionName: "canonicalChainId" }),
        client.readContract({ address: splitter, abi: splitterAbi, functionName: "canonicalToken" }),
        client.readContract({ address: splitter, abi: splitterAbi, functionName: "providerPayee" }),
        client.readContract({ address: splitter, abi: splitterAbi, functionName: "daskiCommissionReceiver" }),
        client.readContract({ address: splitter, abi: splitterAbi, functionName: "commissionBps" }),
        client.readContract({ address: splitter, abi: splitterAbi, functionName: "policyVersionHash" }),
        client.readContract({ address: splitter, abi: splitterAbi, functionName: "outcomeIdHash" }),
        client.readContract({ address: splitter, abi: splitterAbi, functionName: "listingEpoch" }),
        client.readContract({ address: splitter, abi: splitterAbi, functionName: "listingCommitmentHash" }),
      ]);
      if (!code || keccak256(code) !== listing.manifest.payload.splitterRuntimeCodeHash) {
        throw new Error("Splitter runtime code does not match its listing manifest");
      }
      if (
        receipt.status !== "success" ||
        receipt.blockNumber !== BigInt(listing.manifest.payload.splitterDeploymentBlockNumber) ||
        receipt.blockHash !== listing.manifest.payload.splitterDeploymentBlockHash ||
        head - receipt.blockNumber < BigInt(this.config.finalityConfirmations)
      ) throw new Error("Splitter deployment transaction is not final or manifest-bound");
      const immutableHash = keccak256(encodeAbiParameters(
        [
          { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "address" },
          { type: "uint16" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
          { type: "uint64" },
        ],
        [canonicalChainId, token, payee, receiver, bps, policyHash, outcomeHash, commitmentHash, listingEpoch],
      ));
      if (
        canonicalChainId !== BigInt(chainId) || getAddress(token) !== getAddress(listing.commitment.payload.canonicalToken) ||
        getAddress(payee) !== getAddress(listing.commitment.payload.providerPayee) ||
        getAddress(receiver) !== getAddress(listing.commitment.payload.daskiCommissionReceiver) ||
        bps !== listing.commitment.payload.commissionBps || commitmentHash !== expectedCommitmentHash ||
        listingEpoch !== BigInt(listing.commitment.payload.listingEpoch) ||
        outcomeHash !== keccak256(stringToHex(listing.commitment.payload.outcomeId)) ||
        immutableHash !== listing.manifest.payload.splitterImmutableHash
      ) throw new Error("Splitter immutable values do not match the listing");
      const deployments = parseEventLogs({
        abi: splitterFactoryAbi,
        logs: receipt.logs,
        eventName: "OutcomeSplitterDeployed",
      }).filter((event) =>
        event.address.toLowerCase() === listing.commitment.payload.splitterFactory.toLowerCase() &&
        event.args.splitter === splitter && event.args.salt === listing.commitment.payload.splitterDeploymentSalt &&
        event.args.outcomeIdHash === outcomeHash && event.args.listingEpoch === listingEpoch &&
        event.args.listingCommitmentHash === commitmentHash,
      );
      if (deployments.length !== 1) throw new Error("Splitter factory deployment event is missing or ambiguous");
      return { source: host, hash: canonicalHash({
        codeHash: keccak256(code),
        transactionHash: receipt.transactionHash,
        blockHash: receipt.blockHash,
        immutableHash,
      }) };
    }));
    if (
      new Set(observations.map(({ source }) => source)).size < 2 ||
      new Set(observations.map(({ hash }) => hash)).size !== 1
    ) {
      throw new Error("Splitter deployment evidence sources disagree");
    }
  }

  async verifyScreeningPolicy(listing: StandardListing): Promise<void> {
    const policy = listing.screeningPolicy;
    const oracle = getAddress(policy.sanctionsOracle);
    const observations = await Promise.all(this.clients.map(async ({ client, host }) => {
      const [head, code] = await Promise.all([
        client.getBlockNumber(),
        client.getBytecode({ address: oracle }),
      ]);
      if (!code || keccak256(code) !== policy.sanctionsOracleRuntimeCodeHash) {
        throw new Error("Screening oracle runtime code does not match the signed policy");
      }
      return { host, head, codeHash: keccak256(code) };
    }));
    const heads = observations.map(({ head }) => head);
    const lag = heads.reduce((max, value) => value > max ? value : max) -
      heads.reduce((min, value) => value < min ? value : min);
    if (
      lag > BigInt(this.config.manifest.chainEvidencePolicy.payload.maximumSourceLagBlocks) ||
      new Set(observations.map(({ host }) => host)).size < 2 ||
      new Set(observations.map(({ codeHash }) => codeHash)).size !== 1
    ) throw new Error("Screening oracle evidence is unavailable or inconsistent");
  }

  async proveDeposit(args: {
    order: StandardOrderRecord;
    listing: StandardListing;
    transactionHash: Hex;
    paymentNonce: Hex;
    payment: PaymentPayload;
  }): Promise<EvidenceResult> {
    await this.assertSourceLag();
    const observations = await Promise.all(this.clients.map(async ({ client, host }) => {
      const [receipt, transaction, head, trace] = await Promise.all([
        client.getTransactionReceipt({ hash: args.transactionHash }),
        client.getTransaction({ hash: args.transactionHash }),
        client.getBlockNumber(),
        this.trace(client, args.transactionHash),
      ]);
      if (receipt.status !== "success" || head - receipt.blockNumber < BigInt(this.config.finalityConfirmations)) {
        throw new Error("Settlement transaction is not finalized");
      }
      await this.tokenPolicyFacts(client, receipt.blockNumber);
      if (!transaction.to || getAddress(transaction.to) !== getAddress(args.listing.commitment.payload.canonicalToken)) {
        throw new Error("Settlement transaction target is not canonical USDC");
      }
      const call = decodeFunctionData({ abi: transferAuthorizationAbi, data: transaction.input });
      if (call.functionName !== "transferWithAuthorization") throw new Error("Unexpected settlement calldata");
      const [from, to, value, validAfter, validBefore, nonce, signature] = call.args;
      const exactInput = encodeFunctionData({
        abi: transferAuthorizationAbi,
        functionName: "transferWithAuthorization",
        args: [from, to, value, validAfter, validBefore, nonce, signature],
      });
      const expectedAuthorization = args.payment.payload.authorization as Record<string, unknown>;
      const expectedSignature = args.payment.payload.signature;
      if (
        getAddress(from) !== getAddress(args.order.payer!) ||
        getAddress(to) !== getAddress(args.listing.manifest.payload.splitterAddress) ||
        value !== BigInt(args.order.grossAmount) || nonce !== args.paymentNonce ||
        validAfter !== BigInt(String(expectedAuthorization.validAfter)) ||
        validBefore !== BigInt(String(expectedAuthorization.validBefore)) ||
        typeof expectedSignature !== "string" || signature.toLowerCase() !== expectedSignature.toLowerCase() ||
        transaction.value !== 0n || transaction.input.toLowerCase() !== exactInput.toLowerCase()
      ) throw new Error("Settlement calldata does not match the order");
      const used = parseEventLogs({ abi: transferAuthorizationAbi, logs: receipt.logs, eventName: "AuthorizationUsed" })
        .filter((event) => event.address.toLowerCase() === args.listing.commitment.payload.canonicalToken.toLowerCase());
      const transfers = parseEventLogs({ abi: erc20Abi, logs: receipt.logs, eventName: "Transfer" });
      if (used.length !== 1 || used[0]!.args.authorizer !== from || used[0]!.args.nonce !== nonce) {
        throw new Error("AuthorizationUsed evidence is missing or ambiguous");
      }
      const matching = transfers.filter((event) =>
        event.address.toLowerCase() === args.listing.commitment.payload.canonicalToken.toLowerCase() &&
        event.args.from === from && event.args.to === to && event.args.value === value,
      );
      if (matching.length !== 1) throw new Error("Transfer evidence is missing or ambiguous");
      return {
        source: host,
        blockNumber: receipt.blockNumber.toString(),
        blockHash: receipt.blockHash,
        transactionHash: receipt.transactionHash,
        transactionTo: transaction.to,
        transactionFrom: transaction.from,
        transactionIndex: receipt.transactionIndex,
        logIndex: Number(matching[0]!.logIndex),
        input: transaction.input,
        logsHash: canonicalHash(receipt.logs),
        traceHash: canonicalHash(trace),
      } satisfies SourceObservation;
    }));
    return this.agree(observations, "deposit");
  }

  async tokenBalance(token: Address, account: Address): Promise<bigint> {
    const policy = this.config.manifest.chainEvidencePolicy.payload;
    if (getAddress(token) !== getAddress(policy.canonicalToken)) {
      throw new Error("Reserve token is not the admitted canonical token");
    }
    const observations = await Promise.all(this.clients.map(async ({ client, host }) => {
      const head = await client.getBlockNumber();
      const [balance, facts] = await Promise.all([
        client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [account],
          blockNumber: head,
        }),
        this.tokenPolicyFacts(client, head),
      ]);
      return { host, head, balance, facts };
    }));
    const heads = observations.map(({ head }) => head);
    const lag = heads.reduce((max, value) => value > max ? value : max) -
      heads.reduce((min, value) => value < min ? value : min);
    if (
      lag > BigInt(policy.maximumSourceLagBlocks) ||
      new Set(observations.map(({ host }) => host)).size !== observations.length ||
      new Set(observations.map(({ balance }) => String(balance))).size !== 1 ||
      new Set(observations.map(({ facts }) => canonicalHash(facts))).size !== 1
    ) throw new Error("Reserve balance sources disagree or exceed the approved lag");
    return observations[0]!.balance;
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
    const observations = await Promise.all(this.clients.map(async ({ client }) => {
      const head = await client.getBlockNumber();
      const [code, results] = await Promise.all([
        client.getBytecode({ address: oracle, blockNumber: head }),
        Promise.all(unique.map((account) => client.readContract({
          address: oracle,
          abi: sanctionsOracleAbi,
          functionName: "isSanctioned",
          args: [account],
          blockNumber: head,
        }))),
      ]);
      if (!code || keccak256(code) !== expectedRuntimeCodeHash) {
        throw new Error("Screening oracle runtime code changed");
      }
      return { head, results };
    }));
    const heads = observations.map(({ head }) => head);
    const lag = heads.reduce((max, value) => value > max ? value : max) -
      heads.reduce((min, value) => value < min ? value : min);
    if (
      lag > BigInt(this.config.manifest.chainEvidencePolicy.payload.maximumSourceLagBlocks) ||
      new Set(observations.map(({ results }) => canonicalHash(results))).size !== 1
    ) {
      throw new Error("Screening evidence sources disagree");
    }
    if (observations[0]!.results.some(Boolean)) throw new Error("SANCTIONS_ADDRESS_REJECTED");
  }

  async authorizationUsed(token: Address, payer: Address, nonce: Hex): Promise<boolean> {
    const states = await Promise.all(this.clients.map(({ client }) =>
      client.readContract({
        address: token,
        abi: transferAuthorizationAbi,
        functionName: "authorizationState",
        args: [payer, nonce],
      }),
    ));
    if (new Set(states.map(String)).size !== 1) {
      throw new Error("Authorization-state evidence sources disagree");
    }
    return states[0]!;
  }

  async findSettlementTransaction(args: {
    listing: StandardListing;
    payer: Address;
    nonce: Hex;
  }): Promise<Hex | null> {
    const hashes = await Promise.all(this.clients.map(async ({ client }) => {
      const deployment = await client.getTransactionReceipt({
        hash: args.listing.manifest.payload.splitterDeploymentTransaction,
      });
      const head = await client.getBlockNumber();
      const logs = await this.boundedLogs({
        fromBlock: deployment.blockNumber,
        toBlock: head,
        maxEvents: 2,
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
    }));
    if (new Set(hashes).size !== 1) throw new Error("Authorization history sources disagree");
    return hashes[0];
  }

  async prepareRefund(token: Address, payer: Address, amount: bigint): Promise<{
    rawTransaction: Hex;
    transactionHash: Hex;
  }> {
    const request = await this.refundWallet.prepareTransactionRequest({
      account: this.refundWallet.account!,
      to: token,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [payer, amount] }),
      value: 0n,
    });
    assertRefundNetworkFee({
      gas: request.gas,
      maxFeePerGas: request.maxFeePerGas,
      maxPriorityFeePerGas: request.maxPriorityFeePerGas,
      maximumNetworkFee: BigInt(this.config.refundMaxNetworkFeeWei),
    });
    const rawTransaction = await this.refundWallet.signTransaction(request);
    return { rawTransaction, transactionHash: keccak256(rawTransaction) };
  }

  async broadcastRefund(rawTransaction: Hex, expectedHash: Hex): Promise<Hex> {
    if (keccak256(rawTransaction) !== expectedHash) throw new Error("Refund transaction hash mismatch");
    try {
      const transactionHash = await this.refundWallet.sendRawTransaction({
        serializedTransaction: rawTransaction,
      });
      if (transactionHash !== expectedHash) throw new Error("Refund broadcast hash changed");
      return transactionHash;
    } catch (error) {
      const transaction = await this.clients[0]!.client.getTransaction({ hash: expectedHash }).catch(() => null);
      if (!transaction) throw error;
      return expectedHash;
    }
  }

  async proveRefund(args: {
    transactionHash: Hex;
    token: Address;
    from: Address;
    payer: Address;
    amount: bigint;
  }): Promise<EvidenceResult> {
    await this.assertSourceLag();
    const observations = await Promise.all(this.clients.map(async ({ client, host }) => {
      const [receipt, transaction, head, trace] = await Promise.all([
        client.waitForTransactionReceipt({ hash: args.transactionHash, confirmations: this.config.finalityConfirmations }),
        client.getTransaction({ hash: args.transactionHash }),
        client.getBlockNumber(),
        this.trace(client, args.transactionHash),
      ]);
      if (
        receipt.status !== "success" || head - receipt.blockNumber < BigInt(this.config.finalityConfirmations) ||
        !transaction.to || getAddress(transaction.to) !== args.token || getAddress(transaction.from) !== args.from ||
        transaction.value !== 0n || transaction.input.toLowerCase() !== encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [args.payer, args.amount],
        }).toLowerCase()
      ) throw new Error("Refund transaction is not finalized or has the wrong source");
      await this.tokenPolicyFacts(client, receipt.blockNumber);
      const transfers = parseEventLogs({ abi: erc20Abi, logs: receipt.logs, eventName: "Transfer" }).filter(
        (event) => event.address.toLowerCase() === args.token.toLowerCase() &&
          event.args.from === args.from && event.args.to === args.payer && event.args.value === args.amount,
      );
      if (transfers.length !== 1) throw new Error("Refund credit evidence is missing or ambiguous");
      return {
        source: host,
        blockNumber: receipt.blockNumber.toString(),
        blockHash: receipt.blockHash,
        transactionHash: receipt.transactionHash,
        transactionTo: transaction.to,
        transactionFrom: transaction.from,
        transactionIndex: receipt.transactionIndex,
        logIndex: Number(transfers[0]!.logIndex),
        input: transaction.input,
        logsHash: canonicalHash(receipt.logs),
        traceHash: canonicalHash(trace),
      } satisfies SourceObservation;
    }));
    return this.agree(observations, "refund");
  }

  async releaseAndProve(args: {
    order: StandardOrderRecord;
    listing: StandardListing;
    deposit: EvidenceResult;
  }): Promise<ReleaseEvidenceResult> {
    await this.assertSourceLag();
    const splitter = getAddress(args.listing.manifest.payload.splitterAddress);
    let hash = await this.findCoveringRelease(this.clients[0]!.client, args);
    if (!hash) {
      try {
        hash = await this.wallet.writeContract({ address: splitter, abi: splitterAbi, functionName: "releaseAll" });
      } catch (error) {
        hash = await this.findCoveringRelease(this.clients[0]!.client, args);
        if (!hash) throw error;
      }
    }
    const observations = await Promise.all(this.clients.map(async ({ client, host }) => {
      const receipt = await client.waitForTransactionReceipt({
        hash,
        confirmations: this.config.finalityConfirmations,
      });
      const deployment = await client.getTransactionReceipt({
        hash: args.listing.manifest.payload.splitterDeploymentTransaction,
      });
      const maximumIntervalEvents = this.config.manifest.chainEvidencePolicy.payload.maximumIntervalEvents;
      const [transaction, head, token, payee, receiver, bps, commitment, policyHash, trace,
        releaseHistory, credits, endingBalance] = await Promise.all([
        client.getTransaction({ hash }),
        client.getBlockNumber(),
        client.readContract({ address: splitter, abi: splitterAbi, functionName: "canonicalToken" }),
        client.readContract({ address: splitter, abi: splitterAbi, functionName: "providerPayee" }),
        client.readContract({ address: splitter, abi: splitterAbi, functionName: "daskiCommissionReceiver" }),
        client.readContract({ address: splitter, abi: splitterAbi, functionName: "commissionBps" }),
        client.readContract({ address: splitter, abi: splitterAbi, functionName: "listingCommitmentHash" }),
        client.readContract({ address: splitter, abi: splitterAbi, functionName: "policyVersionHash" }),
        this.trace(client, hash),
        this.boundedLogs({
          fromBlock: deployment.blockNumber,
          toBlock: receipt.blockNumber,
          maxEvents: maximumIntervalEvents,
          load: (fromBlock, toBlock) => client.getLogs({
            address: splitter,
            event: releasedEvent,
            fromBlock,
            toBlock,
          }),
        }),
        this.boundedLogs({
          fromBlock: deployment.blockNumber,
          toBlock: receipt.blockNumber,
          maxEvents: maximumIntervalEvents,
          load: (fromBlock, toBlock) => client.getLogs({
            address: getAddress(args.listing.commitment.payload.canonicalToken),
            event: transferEvent,
            args: { to: splitter },
            fromBlock,
            toBlock,
          }),
        }),
        client.readContract({
          address: getAddress(args.listing.commitment.payload.canonicalToken),
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [splitter],
          blockNumber: receipt.blockNumber,
        }),
      ]);
      await this.tokenPolicyFacts(client, receipt.blockNumber);
      if (
        receipt.status !== "success" || head - receipt.blockNumber < BigInt(this.config.finalityConfirmations) ||
        !transaction.to || getAddress(transaction.to) !== splitter ||
        transaction.input !== encodeFunctionData({ abi: splitterAbi, functionName: "releaseAll" })
      ) throw new Error("Release transaction is not finalized or has unexpected calldata");
      const releases = parseEventLogs({ abi: splitterAbi, logs: receipt.logs, eventName: "Released" })
        .filter((event) => event.address.toLowerCase() === splitter.toLowerCase());
      if (releases.length !== 1) throw new Error("Release event is missing or ambiguous");
      const release = releases[0]!;
      const releasePosition = position(release);
      const previous = releaseHistory
        .filter((event) => comparePosition(position(event), releasePosition) < 0)
        .sort((left, right) => comparePosition(position(left), position(right)))
        .at(-1);
      const previousPosition = previous ? position(previous) : null;
      const interval = credits
        .filter((credit) =>
          (!previousPosition || comparePosition(position(credit), previousPosition) > 0) &&
          comparePosition(position(credit), releasePosition) < 0,
        )
        .sort((left, right) => comparePosition(position(left), position(right)));
      const targetIndex = interval.findIndex((credit) =>
        credit.transactionHash === args.deposit.transactionHash &&
        credit.args.from !== undefined && getAddress(credit.args.from) === getAddress(args.order.payer!) &&
        credit.args.value !== undefined && credit.args.value === BigInt(args.order.grossAmount) &&
        Number(credit.logIndex) === args.deposit.logIndex,
      );
      if (targetIndex < 0) throw new Error("Release interval does not contain the order deposit");
      const intervalGross = interval.reduce((total, credit) => total + credit.args.value!, 0n);
      const cumulativeBefore = interval.slice(0, targetIndex).reduce((total, credit) => total + credit.args.value!, 0n);
      const cumulativeAfter = cumulativeBefore + BigInt(args.order.grossAmount);
      const commissionBefore = cumulativeBefore * BigInt(bps) / 10_000n;
      const commissionAfter = cumulativeAfter * BigInt(bps) / 10_000n;
      const daskiCommissionAmount = commissionAfter - commissionBefore;
      const providerNetAmount = BigInt(args.order.grossAmount) - daskiCommissionAmount;
      const totalCommission = intervalGross * BigInt(bps) / 10_000n;
      const payoutTransfers = parseEventLogs({ abi: erc20Abi, logs: receipt.logs, eventName: "Transfer" })
        .filter((event) => event.address.toLowerCase() === getAddress(token).toLowerCase());
      const providerTransfers = payoutTransfers.filter((event) =>
        event.args.from === splitter && event.args.to === getAddress(payee) &&
        event.args.value === intervalGross - totalCommission,
      );
      const daskiTransfers = payoutTransfers.filter((event) =>
        event.args.from === splitter && event.args.to === getAddress(receiver) &&
        event.args.value === totalCommission,
      );
      if (
        getAddress(token) !== getAddress(args.listing.commitment.payload.canonicalToken) ||
        getAddress(payee) !== getAddress(args.listing.commitment.payload.providerPayee) ||
        getAddress(receiver) !== getAddress(args.listing.commitment.payload.daskiCommissionReceiver) ||
        bps !== args.listing.commitment.payload.commissionBps || commitment !== canonicalHash(args.listing.commitment) ||
        release.args.outcomeIdHash !== keccak256(stringToHex(args.listing.commitment.payload.outcomeId)) ||
        release.args.listingEpoch !== BigInt(args.listing.commitment.payload.listingEpoch) ||
        release.args.policyVersionHash !== policyHash || release.args.listingCommitmentHash !== commitment ||
        release.args.grossAmount !== intervalGross || release.args.providerNetAmount !== intervalGross - totalCommission ||
        release.args.daskiCommissionAmount !== totalCommission || providerTransfers.length !== 1 || daskiTransfers.length !== 1 ||
        providerNetAmount <= 0n || daskiCommissionAmount <= 0n || endingBalance !== 0n
      ) throw new Error("Release interval, payout, or immutable evidence mismatch");
      const observation: SourceObservation = {
        source: host,
        blockNumber: receipt.blockNumber.toString(),
        blockHash: receipt.blockHash,
        transactionHash: receipt.transactionHash,
        transactionTo: transaction.to,
        transactionFrom: transaction.from,
        transactionIndex: receipt.transactionIndex,
        logIndex: Number(release.logIndex),
        input: transaction.input,
        logsHash: canonicalHash(receipt.logs),
        traceHash: canonicalHash(trace),
      };
      const allocation = {
        providerNetAmount: providerNetAmount.toString(),
        daskiCommissionAmount: daskiCommissionAmount.toString(),
        releaseSequence: release.args.releaseSequence.toString(),
        interval: interval.map((credit) => ({
          blockNumber: credit.blockNumber!.toString(),
          transactionIndex: credit.transactionIndex,
          logIndex: credit.logIndex,
          transactionHash: credit.transactionHash,
          from: credit.args.from,
          amount: credit.args.value!.toString(),
          recognizedOrder: credit.transactionHash === args.deposit.transactionHash && Number(credit.logIndex) === args.deposit.logIndex,
        })),
      };
      return { observation, allocation };
    }));
    const comparable = observations.map(({ observation, allocation }) => {
      const { source: _source, ...withoutSource } = observation;
      return canonicalHash({ ...withoutSource, allocation });
    });
    if (new Set(comparable).size !== 1) throw new Error("release evidence sources disagree");
    const first = observations[0]!;
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
  ): Promise<Hex | null> {
    const depositPosition = [
      args.deposit.blockNumber,
      BigInt(args.deposit.transactionIndex),
      BigInt(args.deposit.logIndex),
    ] as const;
    const head = await client.getBlockNumber();
    const releases = await this.boundedLogs({
      fromBlock: args.deposit.blockNumber,
      toBlock: head,
      maxEvents: this.config.manifest.chainEvidencePolicy.payload.maximumIntervalEvents,
      load: (fromBlock, toBlock) => client.getLogs({
        address: getAddress(args.listing.manifest.payload.splitterAddress),
        event: releasedEvent,
        fromBlock,
        toBlock,
      }),
    });
    const covering = releases
      .filter((event) => comparePosition(position(event), depositPosition) > 0)
      .sort((left, right) => comparePosition(position(left), position(right)))[0];
    return covering?.transactionHash ?? null;
  }

  private async boundedLogs<T>(args: {
    fromBlock: bigint;
    toBlock: bigint;
    maxEvents: number;
    load(fromBlock: bigint, toBlock: bigint): Promise<readonly T[]>;
  }): Promise<T[]> {
    if (args.toBlock < args.fromBlock) return [];
    const logs: T[] = [];
    const blockWindow = 10_000n;
    for (let fromBlock = args.fromBlock; fromBlock <= args.toBlock; fromBlock += blockWindow) {
      const toBlock = fromBlock + blockWindow - 1n > args.toBlock
        ? args.toBlock
        : fromBlock + blockWindow - 1n;
      logs.push(...await args.load(fromBlock, toBlock));
      if (logs.length > args.maxEvents) {
        throw new Error("Chain history exceeds the approved evidence event budget");
      }
    }
    return logs;
  }

  private async trace(client: (typeof this.clients)[number]["client"], hash: Hex): Promise<unknown> {
    return (client.request as (request: { method: string; params: unknown[] }) => Promise<unknown>)({
      method: "debug_traceTransaction",
      params: [hash, { tracer: "prestateTracer", tracerConfig: { diffMode: true } }],
    });
  }

  private async assertSourceLag(): Promise<void> {
    const heads = await Promise.all(this.clients.map(({ client }) => client.getBlockNumber()));
    const lag = heads.reduce((max, value) => value > max ? value : max) -
      heads.reduce((min, value) => value < min ? value : min);
    if (lag > BigInt(this.config.manifest.chainEvidencePolicy.payload.maximumSourceLagBlocks)) {
      throw new Error("Chain evidence sources exceed the approved lag");
    }
  }

  private agree(observations: SourceObservation[], kind: string): EvidenceResult {
    if (observations.length < 2 || new Set(observations.map((item) => item.source)).size < 2) {
      throw new Error("Two independent evidence sources are required");
    }
    const comparable = observations.map(({ source: _source, ...value }) => canonicalHash(value));
    if (new Set(comparable).size !== 1) throw new Error(`${kind} evidence sources disagree`);
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
