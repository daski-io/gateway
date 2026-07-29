import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../src/util/logger.js";

describe("structured log sanitization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("removes raw transactions and unsafe Error fields at the logger boundary", () => {
    const rawTransaction = `0x02${"ab".repeat(180)}`;
    const privateKey = `0x${"cd".repeat(32)}`;
    const transactionHash = `0x${"ef".repeat(32)}`;
    const error = Object.assign(
      new Error(`RPC failed with body ${rawTransaction}`),
      {
        code: "RPC_REQUEST_ERROR",
        stage: "submission",
        retryable: true,
        body: { rawTransaction },
        params: [rawTransaction],
        headers: { authorization: privateKey },
        cause: new Error(`nested ${rawTransaction}`),
        metaMessages: [rawTransaction],
      },
    );
    error.stack = [
      `RpcRequestError: ${rawTransaction}`,
      `Request Arguments: ${rawTransaction}`,
      "    at submit (/srv/gateway.ts:10:2)",
    ].join("\n");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    logger.error("facilitator submission failed", {
      error,
      privateKey,
      serializedTransaction: rawTransaction,
      transactionHash,
      circular,
      count: 7n,
      rpcUrl: "https://user:pass@rpc.example/path?apiKey=secret",
    });

    const output = String(write.mock.calls[0]?.[0]);
    expect(output).not.toContain(rawTransaction);
    expect(output).not.toContain(privateKey);
    expect(output).not.toContain("Request Arguments");
    expect(output).not.toContain("apiKey");
    expect(output).not.toContain("user:pass");
    expect(output).toContain(transactionHash);
    const entry = JSON.parse(output);
    expect(entry.details.error).toEqual({
      name: "Error",
      code: "RPC_REQUEST_ERROR",
      stage: "submission",
      retryable: true,
      stackFrames: ["at submit (/srv/gateway.ts:10:2)"],
    });
    expect(entry.details.serializedTransaction).toBe("[REDACTED]");
    expect(entry.details.circular.self).toBe("[CIRCULAR]");
    expect(entry.details.count).toBe("7");
    expect(output.trimEnd().split("\n")).toHaveLength(1);
  });

  it("redacts transaction-sized secrets from free-form log messages", () => {
    const signedPayload = `0x02${"11".repeat(100)}`;
    const privateKey = `0x${"22".repeat(32)}`;
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    logger.error(`submission failed: ${signedPayload} key=${privateKey}`);

    const output = String(write.mock.calls[0]?.[0]);
    expect(output).not.toContain(signedPayload);
    expect(output).not.toContain(privateKey);
    expect(JSON.parse(output).message).toContain("[REDACTED]");
  });
});
