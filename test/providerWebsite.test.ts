import { describe, expect, it, vi } from "vitest";
import { providerWebsite, ProviderWebsites } from "../src/serviceRegistration/providerWebsite.js";

const FILE_URI = "https://provider.example/.well-known/agent.json";

function chainWith(agentUri: unknown) {
  return { getProvider: vi.fn(async () => ({ identity: { agentUri } })) };
}

describe("provider website from the registration file", () => {
  it("shows only a credential-free HTTPS external_url without a fragment", () => {
    expect(providerWebsite({ external_url: "https://bluetgroup.com/" })).toBe("https://bluetgroup.com/");
    expect(providerWebsite({ external_url: "https://example.com" })).toBe("https://example.com/");
    for (const bad of [
      "http://example.com/", "https://user:pass@example.com/", "https://example.com/#about",
      "https://example.com/#", "javascript:alert(1)", "ftp://example.com/", "", " https://example.com/",
      "https://exa mple.com/", `https://example.com/${"a".repeat(2_048)}`, "not a url", 42, null,
    ]) {
      expect(providerWebsite({ external_url: bad }), String(bad)).toBeNull();
    }
    for (const file of [null, [], "text", {}]) expect(providerWebsite(file)).toBeNull();
  });
});

describe("ProviderWebsites", () => {
  it("reads the file the identity registry names and answers from memory for an hour", async () => {
    let now = 1_000_000;
    const chain = chainWith(FILE_URI);
    const load = vi.fn(async () => ({ external_url: "https://provider.example/" }));
    const websites = new ProviderWebsites(chain, load, () => now);

    await expect(websites.websites(["41", "41"])).resolves.toEqual(new Map([["41", "https://provider.example/"]]));
    expect(chain.getProvider).toHaveBeenCalledWith(41n);
    expect(load).toHaveBeenCalledWith(FILE_URI);

    now += 59 * 60_000;
    await websites.websites(["41"]);
    expect(load).toHaveBeenCalledTimes(1);

    now += 2 * 60_000;
    let release!: () => void;
    const moved = new Promise<void>((resolve) => { release = resolve; });
    load.mockImplementationOnce(async () => {
      await moved;
      return { external_url: "https://moved.example/" };
    });
    // The refresh runs behind the answer already known.
    await expect(websites.websites(["41"])).resolves.toEqual(new Map([["41", "https://provider.example/"]]));
    release();
    await vi.waitFor(async () =>
      expect(await websites.websites(["41"])).toEqual(new Map([["41", "https://moved.example/"]])));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("reads an inline data: file in place and fetches nothing it cannot", async () => {
    const inline = `data:application/json;base64,${Buffer.from(JSON.stringify({ external_url: "https://inline.example/" })).toString("base64")}`;
    const load = vi.fn();
    const forInline = new ProviderWebsites(chainWith(inline), load);
    await expect(forInline.websites(["7"])).resolves.toEqual(new Map([["7", "https://inline.example/"]]));

    for (const uri of ["ipfs://bafy/agent.json", "http://provider.example/agent.json", "", null]) {
      const websites = new ProviderWebsites(chainWith(uri), load);
      await expect(websites.websites(["7"])).resolves.toEqual(new Map([["7", null]]));
    }
    expect(load).not.toHaveBeenCalled();
  });

  it("keeps the last answer through failed reads for a day, retrying after five minutes", async () => {
    let now = 1_000_000;
    const load = vi.fn(async () => ({ external_url: "https://provider.example/" }));
    const websites = new ProviderWebsites(chainWith(FILE_URI), load, () => now);
    await websites.websites(["41"]);

    load.mockRejectedValue(new Error("offline"));
    now += 61 * 60_000;
    await websites.websites(["41"]);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await expect(websites.websites(["41"])).resolves.toEqual(new Map([["41", "https://provider.example/"]]));
    // Not tried again within five minutes of the failure.
    now += 4 * 60_000;
    await websites.websites(["41"]);
    expect(load).toHaveBeenCalledTimes(2);

    now += 24 * 60 * 60_000;
    await expect(websites.websites(["41"])).resolves.toEqual(new Map([["41", null]]));
  });

  it("never fails a view, and waits only briefly for a provider never read", async () => {
    const failing = new ProviderWebsites({ getProvider: vi.fn(async () => { throw new Error("rpc offline"); }) });
    await expect(failing.websites(["41"])).resolves.toEqual(new Map([["41", null]]));

    let release!: (value: unknown) => void;
    const slow = new ProviderWebsites(
      chainWith(FILE_URI),
      () => new Promise((resolve) => { release = resolve; }),
      Date.now,
      20,
    );
    await expect(slow.websites(["41"])).resolves.toEqual(new Map([["41", null]]));
    release({ external_url: "https://provider.example/" });
    await vi.waitFor(async () =>
      expect(await slow.websites(["41"])).toEqual(new Map([["41", "https://provider.example/"]])));
  });

  it("reads at most two providers at once", async () => {
    let running = 0;
    let most = 0;
    const load = vi.fn(async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return { external_url: "https://provider.example/" };
    });
    const websites = new ProviderWebsites(chainWith(FILE_URI), load, Date.now, 1_000);
    const answer = await websites.websites(["1", "2", "3", "4", "5"]);
    expect([...answer.values()]).toEqual(Array(5).fill("https://provider.example/"));
    expect(load).toHaveBeenCalledTimes(5);
    expect(most).toBe(2);
  });
});
