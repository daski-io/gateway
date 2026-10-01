import {execFileSync} from "node:child_process";
import {writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {hash} from "./release-image.mjs";
const digestPattern=/^sha256:[a-f0-9]{64}$/;
export function exactBytes(output,digest){
 const bytes=Buffer.from(output);
 if(hash(bytes)===digest)return bytes;
 // buildx may append its display newline; remove it only if exact digest proves it.
 if(bytes.at(-1)===10&&hash(bytes.subarray(0,-1))===digest)return bytes.subarray(0,-1);
 throw new Error("OCI response bytes do not match immutable digest");
}
export function collectOci({repository,digest,read=(reference)=>execFileSync("docker",["buildx","imagetools","inspect","--raw",reference],{maxBuffer:4*1024*1024})}){
 if(!/^ghcr\.io\/[a-z0-9][a-z0-9._/-]+$/.test(repository??"")||!digestPattern.test(digest??""))throw new Error("Exact OCI repository and digest required");
 const index=exactBytes(read(repository+"@"+digest),digest),document=JSON.parse(index);
 if(document.schemaVersion!==2)throw new Error("Unsupported OCI schema");
 const descriptors=document.manifests?.filter(d=>d.platform?.os==="linux"&&d.platform?.architecture==="amd64");
 if(document.manifests&&!descriptors?.length)throw new Error("OCI index has no linux/amd64 runtime image");
 const manifests=(descriptors??[]).map(descriptor=>{
  if(!digestPattern.test(descriptor.digest)||!Number.isSafeInteger(descriptor.size))throw new Error("Invalid OCI child descriptor");
  const bytes=exactBytes(read(repository+"@"+descriptor.digest),descriptor.digest);
  if(bytes.length!==descriptor.size||JSON.parse(bytes).schemaVersion!==2||!Array.isArray(JSON.parse(bytes).layers))throw new Error("OCI child is not an exact image manifest");
  return {digest:descriptor.digest,bytes:bytes.toString("base64")};
 });
 if(!document.manifests&&!Array.isArray(document.layers))throw new Error("OCI object is not an index or image manifest");
 return {index:index.toString("base64"),manifests};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
 writeFileSync("release-oci.json",JSON.stringify(collectOci({repository:process.env.IMAGE,digest:process.env.DIGEST}),null,2)+"\n");
