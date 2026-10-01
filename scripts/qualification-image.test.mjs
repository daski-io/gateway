import test from "node:test";
import assert from "node:assert/strict";
import {overlaySource,validateRequest,hash} from "./qualification-image.mjs";
test("qualification failure is after real admission, before readiness, with no runtime flag",()=>{
 const source="assertWorkerCompatibility(embeddedReleaseCapabilities().artifact);\n    await this.store.admitManifest(this.railConfig.manifest);\n    this.locallyReady = true;";
 const changed=overlaySource(source,"gateway-after-admission");
 assert.ok(changed.indexOf("admitManifest")<changed.indexOf("throw new Error"));
 assert.ok(changed.indexOf("throw new Error")<changed.indexOf("locallyReady"));
 assert.throws(()=>overlaySource(source+source,"gateway-after-admission"),/boundary/);
 assert.equal(overlaySource(source,"incompatible-worker-format"),source);
 assert.throws(()=>overlaySource("    await this.store.admitManifest(this.railConfig.manifest);","incompatible-worker-format"),/real worker/);
});
test("fixture request forbids supplied code and unbound recipe arguments",()=>{
 const request={schemaVersion:1,service:"daski-gateway",baseCommit:"a".repeat(40),baseDigest:"sha256:"+"b".repeat(64),faultKind:"gateway-after-admission",parameters:{}};
 assert.equal(validateRequest(request),request);
 assert.throws(()=>validateRequest({...request,patch:"evil"}));
 assert.throws(()=>validateRequest({...request,parameters:{path:"../index.ts"}}));
 assert.equal(hash(request),hash(Object.fromEntries(Object.entries(request).reverse())));
});
