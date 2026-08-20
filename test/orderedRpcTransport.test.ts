import { custom } from "viem";
import { describe, expect, it } from "vitest";
import { orderedRpcTransport } from "../src/rpc/orderedTransport.js";

interface Request {
  method: string;
}

function transportHarness() {
  let active = 0;
  let maximumActive = 0;
  const calls: string[] = [];
  const transport = orderedRpcTransport(custom({
    async request({ method }: Request) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      calls.push(method);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      if (method === "fail") throw new Error("planned failure");
      return method;
    },
  }))({ retryCount: 0 });
  const request = transport.request as (
    args: Request,
  ) => Promise<unknown>;
  return {
    calls,
    maximumActive: () => maximumActive,
    request,
  };
}

describe("orderedRpcTransport", () => {
  it("runs concurrent caller requests one at a time", async () => {
    const harness = transportHarness();

    await expect(Promise.all([
      harness.request({ method: "first" }),
      harness.request({ method: "second" }),
      harness.request({ method: "third" }),
    ])).resolves.toEqual(["first", "second", "third"]);

    expect(harness.calls).toEqual(["first", "second", "third"]);
    expect(harness.maximumActive()).toBe(1);
  });

  it("continues the queue after a request fails", async () => {
    const harness = transportHarness();
    const failed = harness.request({ method: "fail" });
    const recovered = harness.request({ method: "after" });

    await expect(failed).rejects.toThrow("planned failure");
    await expect(recovered).resolves.toBe("after");
    expect(harness.calls).toEqual(["fail", "after"]);
    expect(harness.maximumActive()).toBe(1);
  });
});
