import { describe, expect, it } from "vitest";
import { retryTransientRead } from "../src/db/transientRead.js";

const pgError = (code: string) => Object.assign(new Error("postgres " + code), { code });

describe("retryTransientRead", () => {
  it("repeats a read Postgres chose as a deadlock victim", async () => {
    const pauses: number[] = [];
    let calls = 0;
    const value = await retryTransientRead(async () => {
      calls++;
      if (calls === 1) throw pgError("40P01");
      return "capabilities";
    }, { pause: async ms => { pauses.push(ms); } });
    expect(value).toBe("capabilities");
    expect(calls).toBe(2);
    expect(pauses).toEqual([100]);
  });

  it("gives up after its bound and never repeats another error", async () => {
    let calls = 0;
    await expect(retryTransientRead(async () => { calls++; throw pgError("40001"); },
      { pause: async () => {} })).rejects.toThrow("40001");
    expect(calls).toBe(3);
    calls = 0;
    await expect(retryTransientRead(async () => { calls++; throw pgError("23505"); },
      { pause: async () => {} })).rejects.toThrow("23505");
    expect(calls).toBe(1);
  });
});
