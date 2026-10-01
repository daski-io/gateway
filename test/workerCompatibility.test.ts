import { describe, it, expect } from "vitest";
import { assertWorkerCompatibility, REQUIRED_WORKER_FORMATS, SUPPORTED_INTENT_FORMATS } from "../src/standardRail/workerCompatibility.js";
import type { ReleaseCapabilityManifest } from "../src/standardRail/releaseCapabilities.js";
const artifact = (): ReleaseCapabilityManifest => ({schemaVersion:1,role:"gateway",commit:"a".repeat(40),paidContracts:[],assetActions:[],
 workerFormats:[...REQUIRED_WORKER_FORMATS],intentFormats:[...SUPPORTED_INTENT_FORMATS]});
describe("durable worker compatibility before admission or background claims",()=>{
 it("preserves every incumbent order, dispatch and review decoder",()=>expect(()=>assertWorkerCompatibility(artifact())).not.toThrow());
 it("rejects an image with an unknown replacement journal format",()=>{
  const value=artifact();value.workerFormats=["qualification-incompatible-v999"];
  expect(()=>assertWorkerCompatibility(value)).toThrow("INCOMPATIBLE_DURABLE_WORKER_FORMAT");
 });
 it("rejects dropping only the legacy review decoder or legacy registration intent",()=>{
  const value=artifact();value.workerFormats=value.workerFormats.filter(x=>x!=="review-journal-v1");
  expect(()=>assertWorkerCompatibility(value)).toThrow();
  const intent=artifact();intent.intentFormats=intent.intentFormats.filter(x=>!x.endsWith("V1"));
  expect(()=>assertWorkerCompatibility(intent)).toThrow();
 });
});
