import { describe, expect, it, vi } from "vitest";
import { encodeErrorResult, keccak256 } from "viem";
import { baseSepolia } from "viem/chains";
import { sanctionsErrorAbi } from "../src/chain/sanctionsErrors.js";
import { createSettlementMethods } from "../src/chain/viemSettlement.js";
import type { SettlementInput } from "../src/chain/reader.js";
import type { Hex } from "../src/types.js";

const ADDRESS = "0x0000000000000000000000000000000000000011" as Hex;
const SERVICE_REF = `0x${"22".repeat(32)}` as Hex;
const SERIALIZED_TRANSACTION = "0x02" as Hex;

const INPUT: SettlementInput = {
  providerAgentId: 2n,
  serviceId: `0x${"33".repeat(32)}` as Hex,
  expectedPayee: "0x0000000000000000000000000000000000000055",
  amount: 100_000n,
  serviceRef: SERVICE_REF,
  from: "0x0000000000000000000000000000000000000044",
  validAfter: 0n,
  validBefore: 4_000_000_000n,
  nonce: `0x${"55".repeat(32)}` as Hex,
  signature: "0x1234",
  nonceSalt: `0x${"66".repeat(32)}` as Hex,
};

function methods(
  simulateContract: ReturnType<typeof vi.fn>,
  publicClientOverrides: Record<string, unknown> = {},
  walletClientOverrides: Record<string, unknown> = {},
) {
  const prepareTransactionRequest = vi.fn(async (request) => ({
    ...request,
    nonce: 7,
  }));
  const account = {
    address: ADDRESS,
    signTransaction: vi.fn().mockResolvedValue(SERIALIZED_TRANSACTION),
  };
  return {
    methods: createSettlementMethods({
      publicClient: {
        simulateContract,
        ...publicClientOverrides,
      } as any,
      walletClient: {
        prepareTransactionRequest,
        ...walletClientOverrides,
      } as any,
      account: account as any,
      chain: baseSepolia,
      adapterAddress: ADDRESS,
      agentIndexAddress: ADDRESS,
      paymentRouterAddress: ADDRESS,
      usdcAddress: ADDRESS,
    }),
    prepareTransactionRequest,
  };
}

describe("prepared settlement transactions", () => {
  it("simulates once and returns the signed transaction hash and nonce", async () => {
    const simulate = vi.fn().mockResolvedValue({
      request: { gas: 2_000_000n },
    });
    const fixture = methods(simulate);

    const prepared = await fixture.methods.prepareSettlement(INPUT, 7n);

    expect(simulate).toHaveBeenCalledTimes(1);
    expect(fixture.prepareTransactionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        account: expect.objectContaining({ address: ADDRESS }),
        chain: baseSepolia,
        to: ADDRESS,
        gas: 2_000_000n,
        data: expect.stringMatching(/^0x[0-9a-f]+$/),
        nonce: 7n,
      }),
    );
    expect(prepared).toEqual({
      kind: "settle",
      transactionHash: keccak256(SERIALIZED_TRANSACTION),
      serializedTransaction: SERIALIZED_TRANSACTION,
      facilitatorNonce: 7n,
    });
  });

  it("preserves typed sanctions failures from simulation", async () => {
    const data = encodeErrorResult({
      abi: sanctionsErrorAbi,
      errorName: "SanctionedAddress",
      args: [INPUT.from],
    });
    const fixture = methods(
      vi.fn().mockRejectedValue({ cause: { cause: { data } } }),
    );

    await expect(
      fixture.methods.prepareSettlement(INPUT, 7n),
    ).rejects.toMatchObject({
      failure: {
        code: "SANCTIONS_ADDRESS_REJECTED",
        retryable: false,
      },
      detectionSource: "simulation",
    });
  });

  it("continues receipt reconciliation when a rebroadcast is already known", async () => {
    const receiptError = new Error("receipt is not available yet");
    const waitForTransactionReceipt = vi.fn().mockRejectedValue(receiptError);
    const fixture = methods(
      vi.fn().mockResolvedValue({ request: { gas: 2_000_000n } }),
      { waitForTransactionReceipt },
      {
        sendRawTransaction: vi
          .fn()
          .mockRejectedValue(new Error("transaction already known")),
      },
    );
    const prepared = await fixture.methods.prepareSettlement(INPUT, 7n);
    const onBroadcast = vi.fn();

    await expect(
      fixture.methods.submitPreparedSettlement(
        prepared,
        SERVICE_REF,
        onBroadcast,
      ),
    ).rejects.toThrow(receiptError);

    expect(onBroadcast).toHaveBeenCalledWith(prepared.transactionHash);
    expect(waitForTransactionReceipt).toHaveBeenCalledWith({
      hash: prepared.transactionHash,
    });
  });
});
