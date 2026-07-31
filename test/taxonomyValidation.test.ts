import { describe, expect, it } from "vitest";
import { DASKI_A2A_EXTENSION_URI } from "../src/config.js";
import {
  assertValidServiceTaxonomy,
  MAX_AGENT_CARD_SKILLS,
  ServiceTaxonomyValidationError,
} from "../src/discovery/taxonomyValidation.js";

function cardWithSkills(skills: Array<Record<string, unknown>>) {
  return {
    skills,
    extensions: {
      [DASKI_A2A_EXTENSION_URI]: {
        categoryFamily: "domains-web",
        serviceType: "domain-management",
        jurisdictions: ["global"],
        fulfillmentMode: "automated",
      },
    },
  };
}

describe("service taxonomy resource limits", () => {
  it("rejects agent cards whose skill count exceeds the admission budget", () => {
    const skills = Array.from(
      { length: MAX_AGENT_CARD_SKILLS + 1 },
      (_, index) => ({ id: `skill-${index}` }),
    );

    expect(() => assertValidServiceTaxonomy(cardWithSkills(skills))).toThrow(
      new RegExp(`at most ${MAX_AGENT_CARD_SKILLS}`),
    );
  });

  it("rejects duplicate skill ids before catalog admission", () => {
    expect(() =>
      assertValidServiceTaxonomy(
        cardWithSkills([{ id: "duplicate" }, { id: "duplicate" }]),
      ),
    ).toThrow(ServiceTaxonomyValidationError);
  });
});
