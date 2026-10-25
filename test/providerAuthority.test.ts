import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { zeroAddress, type Address, type Hex } from "viem";
import { canonicalHash } from "../src/standardRail/canonical.js";
import {
  ChainProviderAgentWallets,
  COMMITTED_KEYS_ONLY,
  providerSignatureAccepted,
  type ProviderAgentWallets,
} from "../src/standardRail/providerAuthority.js";
import { StandardProviderDispatch } from "../src/standardRail/providerDispatch.js";
import { StandardRailService } from "../src/standardRail/service.js";
import type { StandardListing, StandardOrderRecord } from "../src/standardRail/types.js";

// A provider authority switch moves the agent wallet on chain (sandbox BTG:
// P1 to P-ID, 2026-10-25). Versions registered before it committed P1; the
// provider now signs every order with P-ID, old versions' orders included.
const committed = privateKeyToAccount(`0x${"12".repeat(32)}`); // P1, in the old version
const current = privateKeyToAccount(`0x${"34".repeat(32)}`); // P-ID, the agent wallet now
const stranger = privateKeyToAccount(`0x${"56".repeat(32)}`);
const hash = (n: string) => `0x${n.repeat(64)}` as Hex;

function wallets(wallet: Address = current.address) {
  const agentWallet = vi.fn(async (_providerAgentId: string) => wallet);
  return { agentWallet } satisfies ProviderAgentWallets;
}

const oldListing = {
  commitment: { payload: {
    providerAgentId: "8327", providerAuthorityKey: committed.address, providerTerminalAttestationKey: committed.address,
  } },
} as unknown as StandardListing;

describe("provider signatures after an authority switch", () => {
  it("accepts the committed key without reading the chain", async () => {
    const reader = wallets();
    await expect(providerSignatureAccepted({
      signer: committed.address, committedKey: committed.address, providerAgentId: "8327", wallets: reader,
    })).resolves.toBe(true);
    expect(reader.agentWallet).not.toHaveBeenCalled();
  });

  it("accepts the provider agent's current agent wallet and refuses every other key", async () => {
    const reader = wallets();
    await expect(providerSignatureAccepted({
      signer: current.address, committedKey: committed.address, providerAgentId: "8327", wallets: reader,
    })).resolves.toBe(true);
    expect(reader.agentWallet).toHaveBeenCalledExactlyOnceWith("8327");
    await expect(providerSignatureAccepted({
      signer: stranger.address, committedKey: committed.address, providerAgentId: "8327", wallets: reader,
    })).resolves.toBe(false);
    await expect(providerSignatureAccepted({
      signer: current.address, committedKey: committed.address, providerAgentId: "8327", wallets: COMMITTED_KEYS_ONLY,
    })).resolves.toBe(false);
  });

  it("never accepts an unset agent wallet and lets a failed read throw", async () => {
    await expect(providerSignatureAccepted({
      signer: current.address, committedKey: committed.address, providerAgentId: "8327", wallets: wallets(zeroAddress),
    })).resolves.toBe(false);
    await expect(providerSignatureAccepted({
      signer: current.address, committedKey: committed.address, providerAgentId: "8327",
      wallets: { agentWallet: async () => { throw new Error("rpc down"); } },
    })).rejects.toThrow("rpc down");
  });
});

describe("chain agent wallet reads", () => {
  function chainReader(finalityTag: "safe" | "latest" = "safe") {
    const reader = new ChainProviderAgentWallets({
      rpcUrls: ["https://rpc.example"], chain: baseSepolia,
      identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e", finalityTag,
    });
    const getBlock = vi.fn(async (_args: { blockTag: string }) => ({ number: 100n }));
    const readContract = vi.fn(async (_args: Record<string, unknown>): Promise<Address> => current.address);
    Object.assign(reader, { clients: [{ host: "rpc.example", client: { getBlock, readContract } }] });
    return { reader, getBlock, readContract };
  }

  it("reads getAgentWallet at the finality tag's block and caches it", async () => {
    const { reader, getBlock, readContract } = chainReader("latest");
    const [first, second] = await Promise.all([reader.agentWallet("8327"), reader.agentWallet("8327")]);
    expect([first, second]).toEqual([current.address, current.address]);
    await reader.agentWallet("8327");
    expect(getBlock).toHaveBeenCalledExactlyOnceWith({ blockTag: "latest" });
    expect(readContract).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      functionName: "getAgentWallet", args: [8327n], blockNumber: 100n,
    }));
  });

  it("reads the wallet again once the minute's cache expires", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-25T20:00:00Z"), toFake: ["Date"] });
    try {
      const { reader, readContract } = chainReader();
      await reader.agentWallet("8327");
      vi.setSystemTime(new Date("2026-10-25T20:00:59Z"));
      await reader.agentWallet("8327");
      expect(readContract).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date("2026-10-25T20:01:01Z"));
      await reader.agentWallet("8327");
      expect(readContract).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it("does not cache a failed read", async () => {
    const { reader, readContract } = chainReader();
    readContract.mockRejectedValue(new Error("rpc down"));
    await expect(reader.agentWallet("8327")).rejects.toThrow();
    const failedReads = readContract.mock.calls.length;
    readContract.mockResolvedValue(current.address);
    await expect(reader.agentWallet("8327")).resolves.toBe(current.address);
    expect(readContract).toHaveBeenCalledTimes(failedReads + 1);
  });
});

describe("old orders' lifecycle after an authority switch", () => {
  function harness(reader: ProviderAgentWallets) {
    const persistOperations = vi.fn(async () => undefined);
    const service = Object.assign(Object.create(StandardRailService.prototype), {
      providerWallets: reader,
      releaseSales: { assertOpen: async () => undefined, isParked: async () => false, parkedStatus: async () => null },
      salesOutage: { assertOpen: async () => undefined, status: async () => ({ salesOpen: true }) }, signerHealth: () => true,
      store: { persistOperations, transition: vi.fn() }, validateResponse: vi.fn(async () => undefined),
      signedReceipt: async () => null, confirmationState: { stored: async () => null }, submissionStatus: async () => null,
    }) as { applyLifecycleResult: (order: StandardOrderRecord, listing: StandardListing, response: unknown,
      action: string, handle: string, request?: Record<string, unknown>, readCapability?: boolean) => Promise<Record<string, unknown>> };
    const order = { orderId: "ord", providerTaskId: "task", state: "FULFILLED", orderKey: hash("1") } as StandardOrderRecord;
    return { service, order, persistOperations };
  }

  async function completedStatus(lifecycleSigner = current, attestationSigner = current, attestedState = "completed") {
    const operations = { schemaVersion: 1, revision: 1, observedAt: 1_790_000_000, fulfillment: null, support: null, recovery: null };
    const attestationPayload = { orderId: "ord", taskId: "task", state: attestedState, resultHash: hash("a"), completedAt: 1_790_000_000 };
    const unsigned = {
      orderId: "ord", taskId: "task", state: "completed", operations,
      terminalAttestation: {
        payload: attestationPayload,
        signature: await attestationSigner.signMessage({ message: { raw: canonicalHash(attestationPayload) } }),
      },
    };
    return { ...unsigned, signature: await lifecycleSigner.signMessage({ message: { raw: canonicalHash(unsigned) } }) };
  }

  it("serves a status read the switched provider signed with its current agent wallet", async () => {
    const reader = wallets();
    const { service, order, persistOperations } = harness(reader);
    await expect(service.applyLifecycleResult(order, oldListing, await completedStatus(), "status", "handle"))
      .resolves.toMatchObject({ orderState: "FULFILLED" });
    expect(persistOperations).toHaveBeenCalledOnce();
    expect(reader.agentWallet).toHaveBeenCalledWith("8327");
  });

  it("still serves the committed key without a chain read", async () => {
    const reader = wallets();
    const { service, order } = harness(reader);
    await expect(service.applyLifecycleResult(order, oldListing, await completedStatus(committed, committed), "status", "handle"))
      .resolves.toMatchObject({ orderState: "FULFILLED" });
    expect(reader.agentWallet).not.toHaveBeenCalled();
  });

  it("refuses a lifecycle signature or a terminal attestation by any other key", async () => {
    const { service, order } = harness(wallets());
    await expect(service.applyLifecycleResult(order, oldListing, await completedStatus(stranger, current), "status", "handle"))
      .rejects.toThrow("PROVIDER_LIFECYCLE_SIGNATURE_INVALID");
    await expect(service.applyLifecycleResult(order, oldListing, await completedStatus(current, stranger), "status", "handle"))
      .rejects.toThrow("PROVIDER_TERMINAL_ATTESTATION_INVALID");
  });

  it("answers a retryable lifecycle outage when the agent wallet cannot be read, keeping a read capability", async () => {
    const { service, order } = harness({ agentWallet: async () => { throw new Error("rpc down"); } });
    await expect(service.applyLifecycleResult(order, oldListing, await completedStatus(), "status", "handle"))
      .rejects.toMatchObject({ code: "PROVIDER_LIFECYCLE_UNAVAILABLE", requiresNewSignature: true });
    await expect(service.applyLifecycleResult(order, oldListing, await completedStatus(), "status", "handle", undefined, true))
      .rejects.toMatchObject({ code: "PROVIDER_LIFECYCLE_UNAVAILABLE", requiresNewSignature: false });
  });

  it("refuses a mis-bound terminal attestation without reading the chain", async () => {
    const reader = wallets();
    const { service, order } = harness(reader);
    // Lifecycle signed by the committed key; the attestation, by another key, attests a different state.
    const response = await completedStatus(committed, current, "failed");
    await expect(service.applyLifecycleResult(order, oldListing, response, "status", "handle"))
      .rejects.toThrow("PROVIDER_TERMINAL_ATTESTATION_INVALID");
    expect(reader.agentWallet).not.toHaveBeenCalled();
  });
});

describe("old orders' dispatch responses after an authority switch", () => {
  function dispatcher(reader: ProviderAgentWallets) {
    return new StandardProviderDispatch(
      { chainId: 84532 }, {} as never, {} as never, {} as never, (async () => new Response(null)) as never, hash("0"), reader,
    ) as unknown as {
      validateDispatchResponse(listing: StandardListing, dispatchHash: Hex, value: unknown): Promise<unknown>;
      terminalEvidence(listing: StandardListing, dispatchHash: Hex, body: unknown): Promise<unknown>;
    };
  }
  const operations = { schemaVersion: 1, revision: 1, observedAt: 1_790_000_000, fulfillment: null, support: null, recovery: null };
  async function response(signer = current) {
    const signed = { taskId: "task", dispatchHash: hash("d"), state: "working", operations };
    return { ...signed, signature: await signer.signMessage({ message: { raw: canonicalHash(signed) } }) };
  }
  async function terminal(signer = current) {
    const payload = { taskId: "task", dispatchHash: hash("d"), state: "completed", resultHash: hash("a"), completedAt: 1_790_000_000 };
    return { taskId: "task", state: "completed",
      terminalAttestation: { payload, signature: await signer.signMessage({ message: { raw: canonicalHash(payload) } }) } };
  }

  it("accepts the current agent wallet's dispatch response and terminal attestation", async () => {
    const subject = dispatcher(wallets());
    await expect(subject.validateDispatchResponse(oldListing, hash("d"), await response())).resolves.toBeTruthy();
    await expect(subject.terminalEvidence(oldListing, hash("d"), await terminal())).resolves.toBeTruthy();
  });

  it("refuses a mis-bound dispatch attestation without reading the chain", async () => {
    const reader = wallets();
    await expect(dispatcher(reader).terminalEvidence(oldListing, hash("e"), await terminal()))
      .rejects.toThrow("provider_terminal_attestation_invalid");
    expect(reader.agentWallet).not.toHaveBeenCalled();
  });

  it("refuses any other signer, and the new wallet where no switch is known", async () => {
    await expect(dispatcher(wallets()).validateDispatchResponse(oldListing, hash("d"), await response(stranger)))
      .rejects.toThrow("provider_dispatch_response_signature_invalid");
    await expect(dispatcher(wallets()).terminalEvidence(oldListing, hash("d"), await terminal(stranger)))
      .rejects.toThrow("provider_terminal_attestation_invalid");
    await expect(dispatcher(COMMITTED_KEYS_ONLY).validateDispatchResponse(oldListing, hash("d"), await response()))
      .rejects.toThrow("provider_dispatch_response_signature_invalid");
  });
});
