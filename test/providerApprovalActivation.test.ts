import { describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import type { MarketplaceChainReader } from "../src/marketplace/reader.js";
import type { RegistrationEvidenceVerifier } from "../src/serviceRegistration/evidence.js";
import { ServiceRegistrationService } from "../src/serviceRegistration/service.js";
import type { ServiceRegistrationStore, StoredRegistration } from "../src/serviceRegistration/store.js";
import type { ProviderServiceRegistrationEvidenceEnvelope } from "../src/serviceRegistration/types.js";
import type { StandardRailConfig } from "../src/standardRail/config.js";

// A registration this process activates is handed to the activation listener
// once it is ACTIVE (the gateway approves a hosted provider by invite there,
// docs/provider-approvals.md). The listener never changes the activation's
// outcome: it is not called for a failed activation, and its failure is not
// reported as one.

const REGISTRATION_ID = "00000000-0000-4000-8000-0000000000a1";
const pending = { registrationId: REGISTRATION_ID, providerAgentId: "9501", state: "EVIDENCE_PENDING",
  prepared: { listings: [] } } as unknown as StoredRegistration;
const active = { ...pending, state: "ACTIVE" } as StoredRegistration;
const evidence = {} as ProviderServiceRegistrationEvidenceEnvelope;

function activating(store: Partial<ServiceRegistrationStore>) {
  const service = new ServiceRegistrationService(
    {} as Config, {} as StandardRailConfig, store as ServiceRegistrationStore, {} as MarketplaceChainReader,
    { verify: async () => new Map() } as unknown as RegistrationEvidenceVerifier,
  );
  // Chain and card revalidation are covered elsewhere; here they pass.
  Object.assign(service, {
    requirePreparedRegistrationCurrent: async () => undefined,
    runtimeCommitmentsFor: async () => [],
  });
  const kick = (service as unknown as {
    kickEvidenceVerification(id: string, record: StoredRegistration, envelope: unknown): void;
  }).kickEvidenceVerification.bind(service);
  return { service, kick };
}

describe("the activation listener", () => {
  it("receives the registration once it is ACTIVE", async () => {
    const activate = vi.fn(async () => active);
    const { service, kick } = activating({ activate, get: async () => active });
    const listener = vi.fn();
    service.onActivated(listener);
    kick(REGISTRATION_ID, pending, evidence);
    await service.settleEvidenceVerification(REGISTRATION_ID);
    expect(activate).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledExactlyOnceWith(active);
  });

  it("is not called when the activation fails or the registration is not ACTIVE", async () => {
    const failing = activating({ activate: async () => { throw new Error("activation failed"); }, get: async () => active });
    const listener = vi.fn();
    failing.service.onActivated(listener);
    failing.kick(REGISTRATION_ID, pending, evidence);
    await failing.service.settleEvidenceVerification(REGISTRATION_ID);

    const superseded = activating({ activate: async () => active, get: async () => ({ ...active, state: "SUPERSEDED" }) });
    superseded.service.onActivated(listener);
    superseded.kick(REGISTRATION_ID, pending, evidence);
    await superseded.service.settleEvidenceVerification(REGISTRATION_ID);
    expect(listener).not.toHaveBeenCalled();
  });

  it("never turns a completed activation into a reported failure", async () => {
    const { logger } = await import("../src/util/logger.js");
    const warn = vi.spyOn(logger, "warn");
    try {
      const throwing = activating({ activate: async () => active, get: async () => active });
      throwing.service.onActivated(() => { throw new Error("listener failed"); });
      throwing.kick(REGISTRATION_ID, pending, evidence);
      await throwing.service.settleEvidenceVerification(REGISTRATION_ID);
      const unreadable = activating({ activate: async () => active, get: async () => { throw new Error("read failed"); } });
      const listener = vi.fn();
      unreadable.service.onActivated(listener);
      unreadable.kick(REGISTRATION_ID, pending, evidence);
      await unreadable.service.settleEvidenceVerification(REGISTRATION_ID);
      expect(listener).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalledWith("registration evidence verification failed; awaiting resubmission", expect.anything());
    } finally {
      warn.mockRestore();
    }
  });

  it("is not needed: without one the activation reads nothing more", async () => {
    const get = vi.fn(async () => active);
    const { service, kick } = activating({ activate: async () => active, get });
    kick(REGISTRATION_ID, pending, evidence);
    await service.settleEvidenceVerification(REGISTRATION_ID);
    expect(get).not.toHaveBeenCalled();
  });
});
