import test from "node:test";
import assert from "node:assert/strict";
import {hash} from "./release-image.mjs";
import {collectOci,exactBytes} from "./release-oci.mjs";
test("authenticates exact index and amd64 child bytes, excluding attestation descriptors",()=>{
 const child=Buffer.from(JSON.stringify({schemaVersion:2,config:{digest:"sha256:"+"a".repeat(64)},layers:[]}));
 const index=Buffer.from(JSON.stringify({schemaVersion:2,manifests:[
  {digest:hash(child),size:child.length,platform:{os:"linux",architecture:"amd64"}},
  {digest:"sha256:"+"b".repeat(64),size:999,platform:{os:"unknown",architecture:"unknown"}}]}));
 const queried=[],read=reference=>{queried.push(reference);return reference.endsWith(hash(index))?Buffer.concat([index,Buffer.from("\n")]):child;};
 const value=collectOci({repository:"ghcr.io/example/provider",digest:hash(index),read});
 assert.equal(hash(Buffer.from(value.index,"base64")),hash(index));
 assert.deepEqual(value.manifests,[{digest:hash(child),bytes:child.toString("base64")}]);assert.equal(queried.length,2);
});
test("rejects mutated bytes, wrong child length and mutable repository input",()=>{
 assert.throws(()=>exactBytes(Buffer.from("{}"),"sha256:"+"a".repeat(64)));
 assert.throws(()=>collectOci({repository:"ghcr.io/example/provider:latest",digest:"sha256:"+"a".repeat(64)}));
 const child=Buffer.from(JSON.stringify({schemaVersion:2,layers:[]}));
 const index=Buffer.from(JSON.stringify({schemaVersion:2,manifests:[{digest:hash(child),size:1,platform:{os:"linux",architecture:"amd64"}}]}));
 assert.throws(()=>collectOci({repository:"ghcr.io/example/provider",digest:hash(index),read:ref=>ref.endsWith(hash(index))?index:child}));
});
