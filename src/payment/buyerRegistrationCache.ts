import type { Config } from "../config.js";
import type { Queries } from "../db/queries.js";
import {
  AgentCardFetchError,
  fetchAgentCard,
} from "../identity/fetch-agent-card.js";
import { sanitizeBuyerName } from "../identity/name.js";
import type { Hex } from "../types.js";
import { logErrorWithId } from "../util/errorWrap.js";
import type {
  RegistrationDelegation,
  VerifyAndSettleWithRegistrationOptions,
} from "./verifyTypes.js";

export async function cacheRegisteredBuyer(
  registration: RegistrationDelegation,
  options: VerifyAndSettleWithRegistrationOptions,
  config: Config,
  queries: Queries,
  agentId: bigint,
  walletAddress: Hex,
): Promise<void> {
  try {
    const card = await fetchAgentCard(registration.agentURI, {
      ipfsGatewayUrl: config.ipfsGatewayUrl,
      fetchFn: options.fetchAgentCardFn,
    });
    const name = sanitizeBuyerName(card.name);
    if (!name.ok) {
      throw new Error(`buyer Agent Card name is invalid: ${name.error}`);
    }
    await queries.upsertBuyerIdentity({
      agentId,
      walletAddress,
      resolvedName: name.name,
      agentURI: registration.agentURI,
    });
  } catch (error) {
    logErrorWithId(
      error instanceof AgentCardFetchError
        ? "upsertBuyerIdentityOnAtomic.fetch"
        : "upsertBuyerIdentityOnAtomic",
      error,
    );
  }
}
