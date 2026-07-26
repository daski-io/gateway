import { describe, expect, it } from "vitest";
import { buildPrincipalUpdate } from "../src/mcp/principalUpdate.js";
import {
  checkBuyerNameAcknowledgement,
  checkPhoneAcknowledgement,
  mcpJson,
} from "../src/mcp/util.js";

function payload(result: { content: unknown[] } | null) {
  const first = result!.content[0] as { type: string; text: string };
  return JSON.parse(first.type === "text" ? first.text : "{}");
}

// Decision log #1 (260725): expected transitions are SUCCESS results with
// a typed status/action discriminator — isError is for genuine failures.
describe("acknowledgement gates as expected transitions", () => {
  it("phone gate returns action-required success, not isError", () => {
    const result = checkPhoneAcknowledgement(
      { registrantPhone: "+15125550142" },
      undefined,
    );
    expect(result).not.toBeNull();
    expect(result!.isError).toBeUndefined();
    const body = payload(result);
    expect(body.status).toBe("action-required");
    expect(body.action).toBe("acknowledge_phone");
    expect(body.code).toBe("PHONE_ACKNOWLEDGEMENT_REQUIRED");
  });

  it("phone gate passes with a matching acknowledgement object", () => {
    const result = checkPhoneAcknowledgement(
      { registrantPhone: "+15125550142" },
      undefined,
      { values: { registrantPhone: "+15125550142" }, principalConfirmed: true },
    );
    expect(result).toBeNull();
  });

  it("phone gate still fires when the acknowledged value drifts", () => {
    const result = checkPhoneAcknowledgement(
      { registrantPhone: "+15125550142" },
      undefined,
      { values: { registrantPhone: "+15125550199" }, principalConfirmed: true },
    );
    expect(result).not.toBeNull();
  });

  it("name gate accepts useWalletDerivedName as the explicit choice", () => {
    expect(
      checkBuyerNameAcknowledgement("buyer-aa39aa", undefined, true),
    ).toBeNull();
  });

  it("name gate returns action-required success otherwise", () => {
    const result = checkBuyerNameAcknowledgement("buyer-aa39aa", undefined);
    expect(result!.isError).toBeUndefined();
    const body = payload(result);
    expect(body.status).toBe("action-required");
    expect(body.action).toBe("choose_buyer_identity");
  });
});

describe("structured tool output", () => {
  it("mcpJson mirrors the payload into structuredContent", () => {
    const result = mcpJson({ status: "completed", a: 1 });
    expect(result.structuredContent).toEqual({ status: "completed", a: 1 });
  });
});

// principalUpdate: gateway-composed from whitelisted facts — never
// provider prose in an instruction position.
describe("principal update composition", () => {
  it("completed + emailDelivery fact composes the hedged sentence", () => {
    const update = buildPrincipalUpdate({
      taskId: "task-1",
      status: "completed",
      artifacts: [
        {
          type: "data",
          name: "entity_details",
          data: {
            emailDelivery: {
              status: "sent",
              to: "office@example.com",
              attachment: false,
            },
          },
        },
      ],
      replyPolicy: null,
    });
    expect(update.summary).toContain("completed");
    expect(update.summary).toContain("Do NOT assert inbox arrival");
    expect(update.summary).toContain("office@example.com");
    expect(update.facts?.emailDelivery).toMatchObject({ status: "sent" });
    expect(update.monitoring.active).toBe(false);
  });

  it("working status states no estimate and offers only a re-check", () => {
    const update = buildPrincipalUpdate({
      taskId: "task-2",
      status: "working",
      artifacts: [],
      replyPolicy: null,
    });
    expect(update.summary).toContain("No completion estimate");
    expect(update.nextSteps.join(" ")).toContain("daski_get_task_status");
  });

  it("replyPolicy presence defers the wording to the verbatim text", () => {
    const update = buildPrincipalUpdate({
      taskId: "task-3",
      status: "working",
      artifacts: [],
      replyPolicy: {
        mode: "verbatim_only",
        text: "Provider hold copy.",
        flags: { relay_verbatim: true },
        binding: "…",
      },
    });
    expect(update.summary).toContain("relay replyPolicy.text");
    // The provider's copy itself is NOT duplicated into the summary.
    expect(update.summary).not.toContain("Provider hold copy.");
  });

  it("input-required routes to the corrected full-payload resubmit", () => {
    const update = buildPrincipalUpdate({
      taskId: "task-4",
      status: "input-required",
      artifacts: [],
      replyPolicy: null,
    });
    expect(update.nextSteps.join(" ")).toContain('action="input"');
  });

  it("dns registrar-only fact bans live claims", () => {
    const update = buildPrincipalUpdate({
      taskId: "task-5",
      status: "completed",
      artifacts: [
        { type: "data", name: "dns", data: { publicResolutionVerified: false } },
      ],
      replyPolicy: null,
    });
    expect(update.summary).toContain("NOT checked");
  });
});
