import { ReviewRecoveryConflict, type StandardReviewRecovery } from "../src/standardRail/reviewRecovery.js";
import express from "express";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createStandardOperatorRouter, OperatorConflict, type StandardRailOperator } from "../src/standardRail/operator.js";

const orderId = "ord_12345678-1234-4123-8123-123456789abc";
const operationId = "12345678-1234-4123-8123-123456789abc";
describe("operator recovery HTTP authentication", () => {
  it("requires the shared bearer guard, validates IDs and returns audited action results/conflicts", async () => {
    const redispatch = vi.fn<StandardRailOperator["redispatch"]>(async () => ({ orderId, state: "RELEASE_FINAL", claimId: operationId }));
    const retryReputation = vi.fn(async () => { throw new OperatorConflict("operation_not_retryable:broadcast"); });
    const app = express();
    app.use(createStandardOperatorRouter({ redispatch, retryReputation } as unknown as StandardRailOperator, "operator-test-token"));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      for (const path of [`/operator/v1/orders/${orderId}/redispatch`, `/operator/v1/reputation/${operationId}/retry`]) {
        for (const authorization of ["", "Bearer wrong", "Basic operator-test-token"]) {
          expect((await fetch(base + path, { method: "POST", headers: { authorization } })).status).toBe(401);
        }
      }
      expect(redispatch).not.toHaveBeenCalled(); expect(retryReputation).not.toHaveBeenCalled();
      const headers = { authorization: "Bearer operator-test-token" };
      expect((await fetch(base + "/operator/v1/reputation/invalid/retry", { method: "POST", headers })).status).toBe(400);
      const accepted = await fetch(base + `/operator/v1/orders/${orderId}/redispatch`, { method: "POST", headers });
      expect(accepted.status).toBe(200); expect(accepted.headers.get("cache-control")).toBe("no-store");
      expect(await accepted.json()).toEqual({ orderId, state: "RELEASE_FINAL", claimId: operationId });
      expect(redispatch).toHaveBeenCalledExactlyOnceWith(orderId);
      redispatch.mockResolvedValueOnce({ orderId, state: "DISPATCHED" });
      const revived = await fetch(base + `/operator/v1/orders/${orderId}/redispatch`, { method: "POST", headers });
      expect(revived.status).toBe(200);
      expect(await revived.json()).toEqual({ orderId, state: "DISPATCHED" });
      for (const reason of ["provider_task_not_active:completed", "provider_task_not_active:failed", "provider_task_missing", "order_not_failed_by_deadline"]) {
        redispatch.mockRejectedValueOnce(new OperatorConflict(reason));
        const conflict = await fetch(base + `/operator/v1/orders/${orderId}/redispatch`, { method: "POST", headers });
        expect(conflict.status).toBe(409);
        expect(await conflict.json()).toEqual({ error: { code: "OPERATOR_ACTION_CONFLICT", reason } });
      }
      const refused = await fetch(base + `/operator/v1/reputation/${operationId}/retry`, { method: "POST", headers });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ error: { code: "OPERATOR_ACTION_CONFLICT", reason: "operation_not_retryable:broadcast" } });
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
});


it("requires authentication and exact proof-bound review recovery bodies",async () => {
  const inventory=vi.fn(async()=>({items:[]})); const preview=vi.fn(async()=>({items:[]}));
  const apply=vi.fn(async()=>({operationId,disposition:"retired",safeRetired:true}));
  const app=express(); app.use(express.json());
  app.use(createStandardOperatorRouter({} as StandardRailOperator,"review-operator",{inventory,preview,apply} as unknown as StandardReviewRecovery));
  const server=app.listen(0,"127.0.0.1"); await new Promise<void>(resolve=>server.once("listening",resolve));
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/operator/v1/reviews/recovery`;
  const headers={authorization:"Bearer review-operator","content-type":"application/json"};
  try {
    for (const suffix of ["","/preview","/apply"]) {
      expect((await fetch(base+suffix,{method:suffix ? "POST":"GET"})).status).toBe(401);
    }
    expect(apply).not.toHaveBeenCalled();expect(preview).not.toHaveBeenCalled();expect(inventory).not.toHaveBeenCalled();
    expect((await fetch(base+"?limit=101",{headers})).status).toBe(400);
    const listed=await fetch(base+"?limit=25",{headers});expect(listed.status).toBe(200);expect(listed.headers.get("cache-control")).toBe("no-store");
    expect(inventory).toHaveBeenCalledWith(25,undefined);
    expect((await fetch(base+"/preview",{method:"POST",headers,body:JSON.stringify({operationIds:[operationId],force:true})})).status).toBe(400);
    expect((await fetch(base+"/preview",{method:"POST",headers,body:JSON.stringify({operationIds:[operationId]})})).status).toBe(200);
    const body={operationId,proofHash:`0x${"a".repeat(64)}`,idempotencyKey:"release-5-review-1",releaseId:"release-5"};
    expect((await fetch(base+"/apply",{method:"POST",headers,body:JSON.stringify({...body,force:true})})).status).toBe(400);
    expect((await fetch(base+"/apply",{method:"POST",headers,body:JSON.stringify(body)})).status).toBe(200);
    expect(apply).toHaveBeenCalledExactlyOnceWith(body);
    apply.mockRejectedValueOnce(new ReviewRecoveryConflict("preview_changed"));
    const rejected=await fetch(base+"/apply",{method:"POST",headers,body:JSON.stringify(body)});
    expect(rejected.status).toBe(409);expect(await rejected.json()).toMatchObject({error:{code:"REVIEW_RECOVERY_CONFLICT",reason:"preview_changed"}});
  } finally { await new Promise<void>((resolve,reject)=>server.close(error=>error ? reject(error):resolve())); }
});
