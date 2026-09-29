import { describe, expect, it, vi, beforeEach } from "vitest";
import { base } from "viem/chains";
import { StandardReputationWorker } from "../src/standardRail/reputationWorker.js";
import { observeEasProfile } from "../src/standardRail/easProfiles.js";
import { unlockedFacilitatorNonceLock } from "../src/standardRail/facilitatorNonceLock.js";
vi.mock("../src/standardRail/easProfiles.js",async importOriginal => ({...await importOriginal<object>(),observeEasProfile:vi.fn()}));
const address = `0x${"11".repeat(20)}` as const;
const now = Math.floor(Date.now()/1000);
const operation = {operation_id:"op",kind:"confirmation-v2",state:"pending",review_relay_until:new Date((now+300)*1000),
  canonical_intent:{operation:"revoke-confirmation",profileId:"eas-native-1.0.1",request:{deadline:null}},attempts:0};
const encoded={data:"0x12",destination:address,gas:500000n};
function setup(opts:{paused?:boolean;candidate?:boolean;count?:number;simulationError?:Error}={}) {
  const query=vi.fn(async (sql:string) => ({rows:sql.includes("SELECT paused") ? [{paused:opts.paused??false}]
    :sql.includes("SELECT p.relay_candidate") ? [{relay_candidate:opts.candidate??true,authorization_group:"group"}]
    :sql.includes("count(*)") ? [{count:String(opts.count??0)}] : [],rowCount:1}));
  const call=opts.simulationError ? vi.fn().mockRejectedValue(opts.simulationError) : vi.fn().mockResolvedValue({data:"0x"});
  const worker=new StandardReputationWorker({query} as never,{reputationRelayerPrivateKey:`0x${"22".repeat(32)}`,
    evidenceRpcUrls:["https://rpc.example"],easAddress:address} as never,base,unlockedFacilitatorNonceLock);
  Object.assign(worker,{evidenceClients:[{host:"rpc.example",client:{call}}]});
  return {query,call,worker:worker as unknown as {reviewCanSend(o:unknown,e:unknown,preparing:boolean):Promise<boolean>;fail(o:unknown,r:string,id:string):Promise<void>}};
}
beforeEach(() => vi.mocked(observeEasProfile).mockResolvedValue({profileId:"eas-native-1.0.1",timestamp:String(now)} as never));
describe("review relayer send gates",() => {
  it("simulates the exact zero-value relayer call before signing",async () => {
    const {worker,call}=setup();expect(await worker.reviewCanSend(operation,encoded,true)).toBe(true);
    expect(call).toHaveBeenCalledWith(expect.objectContaining({to:address,data:"0x12",value:0n,gas:500000n,account:expect.stringMatching(/^0x/)}));
  });
  for(const [name,opts] of [["paused",{paused:true}],["superseded",{candidate:false}],["group gas budget",{count:5}]] as const) {
    it(`does not simulate or send ${name}`,async () => {const {worker,call}=setup(opts);expect(await worker.reviewCanSend(operation,encoded,true)).toBe(false);expect(call).not.toHaveBeenCalled();});
  }
  it("local legacy relay expiry parks a still-live authorization without releasing transactions",async () => {
    const {worker,query,call}=setup();expect(await worker.reviewCanSend({...operation,review_relay_until:new Date(0)},encoded,false)).toBe(false);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE standard_reputation_operations"),["op","authorization_live","relay_window_expired"]);
    expect(query.mock.calls.some(([sql])=>sql.includes("UPDATE standard_reputation_transactions"))).toBe(false);expect(call).not.toHaveBeenCalled();
  });
  it("a live profile change fences both new transactions and persisted sends",async () => {
    vi.mocked(observeEasProfile).mockResolvedValue({profileId:"eas-native-1.2.0",timestamp:String(now)} as never);
    const {worker,call}=setup();for(const preparing of [true,false])expect(await worker.reviewCanSend(operation,encoded,preparing)).toBe(false);expect(call).not.toHaveBeenCalled();
  });
  it("a deterministic simulation revert parks the review without spending or retiring its authorization",async () => {
    const {worker,query}=setup({simulationError:new Error("execution reverted")});expect(await worker.reviewCanSend(operation,encoded,true)).toBe(false);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE standard_reputation_operations"),["op","operator_attention","simulation_rejected"]);
  });
  it("retry exhaustion retains an ambiguous prepared review transaction",async () => {
    const {worker,query}=setup();await worker.fail({...operation,attempts:4},"rpc_finality","tx");
    expect(query.mock.calls.some(([sql])=>sql.includes("UPDATE standard_reputation_transactions"))).toBe(false);
  });
});
