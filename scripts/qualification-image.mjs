import {createHash} from "node:crypto";
import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {resolve,join} from "node:path";
import {fileURLToPath} from "node:url";
const bytesHash=b=>"sha256:"+createHash("sha256").update(b).digest("hex");
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const hash=v=>bytesHash(JSON.stringify(canonical(v)));
export function validateRequest(r) {
 if(r?.schemaVersion!==1||r.service!=="daski-gateway"||!["gateway-after-admission","incompatible-worker-format"].includes(r.faultKind)||
  !/^[a-f0-9]{40}$/.test(r.baseCommit??"")||!/^sha256:[a-f0-9]{64}$/.test(r.baseDigest??"")||
  !r.parameters||Object.keys(r.parameters).length||Object.keys(r).some(k=>!["schemaVersion","service","faultKind","baseCommit","baseDigest","parameters"].includes(k)))
  throw new Error("Only fixed gateway qualification recipes are accepted");
 return r;
}
export function overlaySource(source,kind) {
 const anchor="    await this.store.admitManifest(this.railConfig.manifest);";
 if(source.split(anchor).length!==2)throw new Error("Reviewed admission boundary changed");
 if(kind==="gateway-after-admission")return source.replace(anchor,anchor+
  '\n    console.error("DASKI_QUALIFICATION_GATEWAY_AFTER_ADMISSION");\n    throw new Error("DASKI_QUALIFICATION_GATEWAY_AFTER_ADMISSION");');
 if(kind==="incompatible-worker-format") {
  if(!source.includes("assertWorkerCompatibility(embeddedReleaseCapabilities().artifact)"))throw new Error("The base image lacks the real worker format guard");
  return source;
 }
 throw new Error("Unknown fixed fixture");
}
export function prepareFixture(root,request,{recipeBytes=readFileSync(fileURLToPath(import.meta.url))}={}) {
 validateRequest(request);
 const path=join(root,"src/standardRail/service.ts"),before=readFileSync(path,"utf8"),after=overlaySource(before,request.faultKind);
 const appPath=join(root,"src/standardRail/app.ts"),app=readFileSync(appPath,"utf8"),anchor="  // Verify candidate artifacts before migrations or privilege changes.";
 if(app.split(anchor).length!==2)throw new Error("Reviewed sandbox guard boundary changed");
 writeFileSync(appPath,app.replace(anchor,'  if (options.config.chainId !== 84532) throw new Error("QUALIFICATION_IMAGE_SANDBOX_ONLY");\n'+anchor));
 writeFileSync(path,after);
 if(request.faultKind==="incompatible-worker-format") {
  const inputPath=join(root,"scripts/release-capability-input.json"),input=JSON.parse(readFileSync(inputPath,"utf8"));
  input.workerFormats=["qualification-incompatible-v999"];writeFileSync(inputPath,JSON.stringify(input,null,2)+"\n");
 }
 const description={request,requestHash:hash(request),recipeHash:bytesHash(recipeBytes),
  overlayHash:hash({serviceBefore:bytesHash(before),serviceAfter:bytesHash(after),app:bytesHash(readFileSync(appPath)),
   capabilities:bytesHash(readFileSync(join(root,"scripts/release-capability-input.json")))}),
  details:{stage:request.faultKind==="gateway-after-admission"?"after-admitManifest-before-local-readiness":"embedded-worker-formats",
   marker:request.faultKind==="gateway-after-admission"?"DASKI_QUALIFICATION_GATEWAY_AFTER_ADMISSION":"INCOMPATIBLE_DURABLE_WORKER_FORMAT"}};
 mkdirSync(join(root,".qualification"),{recursive:true});writeFileSync(join(root,".qualification/recipe.json"),JSON.stringify(description,null,2)+"\n");
 return description;
}
export function finishFixture(root,env=process.env) {
 const descriptor=JSON.parse(readFileSync(join(root,".qualification/recipe.json"),"utf8")),bytes=readFileSync(join(root,"release-capabilities.json"));
 if(!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA??"")||!/^sha256:[a-f0-9]{64}$/.test(env.FIXTURE_DIGEST??""))throw new Error("Immutable producer identity missing");
 const oci=JSON.parse(readFileSync(env.DASKI_OCI_METADATA_FILE,"utf8"));
 if(bytesHash(Buffer.from(oci.index,"base64"))!==env.FIXTURE_DIGEST)throw new Error("Fixture OCI index differs");
 const manifest=JSON.parse(bytes);if(manifest.commit!==descriptor.request.baseCommit||manifest.role!=="gateway")throw new Error("Extracted capability identity differs");
 const configurationHash=hash(Object.fromEntries(["Dockerfile","railway.json","package-lock.json"].map(p=>[p,bytesHash(readFileSync(join(root,p)))])));
 const document={schemaVersion:1,kind:"qualification-image",...descriptor,workflowCommit:env.GITHUB_SHA,
  image:"ghcr.io/daski-io/gateway-qualification@"+env.FIXTURE_DIGEST,digest:env.FIXTURE_DIGEST,
  oci,capabilitiesHash:bytesHash(bytes),configurationHash,fixturesHash:descriptor.overlayHash};
 writeFileSync(join(root,"qualification-image.json"),JSON.stringify(document,null,2)+"\n");return document;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const root=resolve(process.argv[3]??".");
 if(process.argv[2]==="prepare") {
  const request=validateRequest(JSON.parse(process.env.REQUEST_JSON??"null"));
  if(hash(request)!==process.env.REQUEST_HASH)throw new Error("Request hash differs");
  prepareFixture(root,request);
 }else if(process.argv[2]==="finish")finishFixture(root);
 else throw new Error("Expected prepare or finish");
}
