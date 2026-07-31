import { describe, expect, it, vi } from "vitest";
import {
  assertFacilitatorTransactionFee,
  FacilitatorTransactionFeeError,
} from "../src/chain/facilitatorFee.js";
import {
  FacilitatorBalanceError,
  requireFacilitatorBalance,
} from "../src/payment/facilitatorBalance.js";

describe("facilitator transaction spend limits", () => {
  it("accepts a prepared transaction at the configured total-cost ceiling", () => {
    expect(() =>
      assertFacilitatorTransactionFee(
        {
          gas: 2_000_000n,
          maxFeePerGas: 5_000_000_000n,
          maxPriorityFeePerGas: 1_000_000n,
        },
        10_000_000_000_000_000n,
      ),
    ).not.toThrow();
  });

  it("rejects an RPC fee response above the signing ceiling", () => {
    expect(() =>
      assertFacilitatorTransactionFee(
        { gas: 2_000_000n, maxFeePerGas: 5_000_000_001n },
        10_000_000_000_000_000n,
      ),
    ).toThrow(FacilitatorTransactionFeeError);
  });

  it("preserves the configured wallet reserve after worst-case fees", async () => {
    const reader = {
      getFacilitatorBalance: vi.fn().mockResolvedValue(14n),
    };

    await expect(
      requireFacilitatorBalance(reader as never, 10n, 5n),
    ).rejects.toBeInstanceOf(FacilitatorBalanceError);
    reader.getFacilitatorBalance.mockResolvedValue(15n);
    await expect(
      requireFacilitatorBalance(reader as never, 10n, 5n),
    ).resolves.toBeUndefined();
  });
});
