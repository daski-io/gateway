import type { ReleaseCapabilityManifest } from "./releaseCapabilities.js";
// These are the durable decoders and claim paths actually compiled into this
// runtime. A new journal format must be deliberately added with its decoder;
// a manifest cannot silently opt out of an incumbent queue.
export const REQUIRED_WORKER_FORMATS = Object.freeze([
  "standard-orders-v1", "dispatch-journal-v2", "review-journal-v1", "standard-settlement-parked-v1",
]);
export const SUPPORTED_INTENT_FORMATS = Object.freeze([
  "ProviderServiceRegistrationIntentV1", "ProviderServiceRegistrationIntentV1:targetRevision",
]);
export function assertWorkerCompatibility(manifest: ReleaseCapabilityManifest): void {
  if (new Set(manifest.workerFormats).size !== manifest.workerFormats.length ||
      REQUIRED_WORKER_FORMATS.some(format => !manifest.workerFormats.includes(format)) ||
      manifest.workerFormats.some(format => !REQUIRED_WORKER_FORMATS.includes(format)) ||
      SUPPORTED_INTENT_FORMATS.some(format => !manifest.intentFormats.includes(format)) ||
      manifest.intentFormats.some(format => !SUPPORTED_INTENT_FORMATS.includes(format))) {
    throw new Error("INCOMPATIBLE_DURABLE_WORKER_FORMAT");
  }
}
