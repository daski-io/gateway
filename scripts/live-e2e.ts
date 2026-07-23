/* eslint-disable no-console */
//
// Live end-to-end runner — exercises a real Daski gateway against a real
// EIP-712-capable wallet (Coinbase CDP SDK, by default, since that's our
// test wallet). Phased so each phase can be run alone:
//
//   PHASE=0   ──  CDP sanity (just connect + resolve address)
//   PHASE=1   ──  Live MCP discovery + identity lookup
//   PHASE=2   ──  Paid purchase end-to-end (USDC moves on-chain!)
//   PHASE=3   ──  Buyer confirmation EAS attestation
//
// Defaults: PHASE=all (runs 0→3 in order, stopping on the first failure).
//
// Prerequisites (run once):
//   - Provision CDP API credentials at portal.cdp.coinbase.com.
//   - export CDP_API_KEY_ID=...
//     export CDP_API_KEY_SECRET=...
//     export CDP_WALLET_SECRET=...
//   - Fund the resulting wallet with ~$15 USDC on Base Sepolia.
//   - Mint a Daski identity for that wallet (out of band).
//   - Have a Daski gateway running with at least one whitelisted provider
//     offering `register-domain`. Set:
//       export DASKI_GATEWAY_URL=https://sandbox-gateway.daski.io
//       export DASKI_SKILL_ID=register-domain    (optional; default below)
//       export DASKI_DOMAIN=smoke-<unix>.xyz     (optional; default below)
//
// Run with:  npx tsx scripts/live-e2e.ts
//
// This script is intentionally a single file so it can be copied to a
// fresh machine, env vars pasted, and run.  Nothing it does is destructive
// other than spending USDC at PHASE=2.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Hex } from "../src/types.js";

interface EnvBundle {
  cdpApiKeyId: string;
  cdpApiKeySecret: string;
  cdpWalletSecret: string;
  gatewayUrl: string;
  cdpAccountName: string;
  skillId: string;
  domain: string;
}

function loadEnv(): EnvBundle {
  const required = [
    "CDP_API_KEY_ID",
    "CDP_API_KEY_SECRET",
    "CDP_WALLET_SECRET",
    "DASKI_GATEWAY_URL",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Missing required env vars: ${missing.join(", ")}`);
    console.error("See the header of this file for the full prereq list.");
    process.exit(2);
  }
  return {
    cdpApiKeyId: process.env.CDP_API_KEY_ID!,
    cdpApiKeySecret: process.env.CDP_API_KEY_SECRET!,
    cdpWalletSecret: process.env.CDP_WALLET_SECRET!,
    gatewayUrl: process.env.DASKI_GATEWAY_URL!.replace(/\/$/, ""),
    cdpAccountName: process.env.DASKI_CDP_ACCOUNT_NAME ?? "daski-e2e",
    skillId: process.env.DASKI_SKILL_ID ?? "register-domain",
    domain:
      process.env.DASKI_DOMAIN ??
      `smoke-${Math.floor(Date.now() / 1000)}.xyz`,
  };
}

interface CdpSigner {
  address: Hex;
  signTypedData: (input: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }) => Promise<Hex>;
}

async function buildCdpSigner(env: EnvBundle): Promise<CdpSigner> {
  const { CdpClient } = await import("@coinbase/cdp-sdk");
  const cdp = new CdpClient();
  const account = await cdp.evm.getOrCreateAccount({ name: env.cdpAccountName });
  const address = account.address as Hex;
  return {
    address,
    async signTypedData(input) {
      const result = await cdp.evm.signTypedData({
        address,
        domain: input.domain as never,
        types: input.types as never,
        primaryType: input.primaryType,
        message: input.message as never,
      });
      const sig = (result as { signature?: unknown }).signature;
      if (typeof sig !== "string") {
        throw new Error(
          "cdp.evm.signTypedData returned unexpected shape: " +
            JSON.stringify(result),
        );
      }
      return sig as Hex;
    },
  };
}

async function connectMcp(gatewayUrl: string) {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${gatewayUrl}/mcp`),
  );
  const client = new Client({ name: "daski-live-e2e", version: "0.1.0" });
  await client.connect(transport);
  return { client, transport };
}

interface ToolResultContent {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function unwrap<T>(label: string, result: unknown): T {
  const r = result as ToolResultContent;
  if (!r.content?.[0]) throw new Error(`${label}: empty content`);
  const parsed = JSON.parse(r.content[0].text);
  if (r.isError) {
    console.error(`${label} returned error:`, parsed);
    throw new Error(`${label} returned error: ${JSON.stringify(parsed)}`);
  }
  return parsed as T;
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

// ── Phases ────────────────────────────────────────────────────────────────

async function phase0_cdp(env: EnvBundle): Promise<CdpSigner> {
  console.log("\n── PHASE 0: CDP sanity ──────────────────────────────");
  const signer = await buildCdpSigner(env);
  console.log(`  ✔ CDP account name: ${env.cdpAccountName}`);
  console.log(`  ✔ wallet address:    ${signer.address}`);
  return signer;
}

async function phase1_discover(
  env: EnvBundle,
  signer: CdpSigner,
): Promise<{ buyerTokenId: string; providerTokenId: string }> {
  console.log("\n── PHASE 1: live MCP discover + identity ────────────");

  // Identity lookup via REST (no MCP needed)
  const idLookup = (await fetchJson(
    `${env.gatewayUrl}/identity/by-wallet/${signer.address}`,
  )) as { agentId: string | null; address: Hex };
  console.log(`  ✔ identity lookup → agentId: ${idLookup.agentId}`);
  if (!idLookup.agentId) {
    throw new Error(
      `Wallet ${signer.address} has no minted Daski identity. Mint one ` +
        "before running PHASE >= 2.",
    );
  }

  // MCP discover
  const { client, transport } = await connectMcp(env.gatewayUrl);
  try {
    const tools = await client.listTools();
    console.log(`  ✔ MCP tools advertised: ${tools.tools.length}`);
    const toolNames = tools.tools.map((t) => t.name);
    for (const required of [
      "daski_search_services",
      "daski_buy_service",
      "daski_settle_payment",
      "daski_submit_task",
      "daski_get_task_status",
      "daski_confirm_delivery",
    ]) {
      if (!toolNames.includes(required)) {
        throw new Error(`Gateway MCP missing required tool: ${required}`);
      }
    }

    const discover = unwrap<{
      providers: Array<{
        tokenId: string;
        skills?: Array<{ id: string; paymentRequired?: boolean }>;
      }>;
    }>(
      "daski_search_services",
      await client.callTool({
        name: "daski_search_services",
        arguments: {},
      }),
    );
    console.log(`  ✔ providers in catalog: ${discover.providers.length}`);
    const provider = discover.providers.find((p) =>
      p.skills?.some((s) => s.id === env.skillId),
    );
    if (!provider) {
      throw new Error(
        `No whitelisted provider offers skill '${env.skillId}'. ` +
          `Available: ${discover.providers
            .flatMap((p) => p.skills?.map((s) => s.id) ?? [])
            .join(", ")}`,
      );
    }
    console.log(
      `  ✔ matched provider tokenId=${provider.tokenId} for skill '${env.skillId}'`,
    );
    return {
      buyerTokenId: idLookup.agentId,
      providerTokenId: provider.tokenId,
    };
  } finally {
    await transport.close();
  }
}

async function phase2_paid_purchase(
  env: EnvBundle,
  signer: CdpSigner,
  ids: { buyerTokenId: string; providerTokenId: string },
): Promise<{ paymentId: string }> {
  console.log("\n── PHASE 2: paid purchase end-to-end ────────────────");
  console.log(`  → spending USDC for skill='${env.skillId}', domain='${env.domain}'`);

  const { client, transport } = await connectMcp(env.gatewayUrl);
  try {
    // 1. Open challenge via daski_buy_service (validates required fields)
    const buy = unwrap<{
      kind: string;
      paymentRequirements: {
        extra: { daski: { eip712TypedData: any; serviceRef: string } };
      };
    }>(
      "daski_buy_service",
      await client.callTool({
        name: "daski_buy_service",
        arguments: {
          skillId: env.skillId,
          buyerTokenId: ids.buyerTokenId,
          walletAddress: signer.address,
          providerTokenId: ids.providerTokenId,
          serviceArgs: { domain: env.domain },
        },
      }),
    );
    if (buy.kind !== "paid") {
      throw new Error(`expected kind=paid, got ${buy.kind}`);
    }
    const td = buy.paymentRequirements.extra.daski.eip712TypedData;
    console.log(`  ✔ paymentRequirements opened (serviceRef=${buy.paymentRequirements.extra.daski.serviceRef})`);

    // 2. Sign with the CDP wallet (the wallet-agnostic step)
    const signature = await signer.signTypedData({
      domain: td.domain,
      types: td.types,
      primaryType: td.primaryType,
      message: td.message,
    });
    console.log(`  ✔ wallet signed typed-data (sig prefix: ${signature.slice(0, 18)}…)`);

    // 3. Settle on-chain
    const settled = unwrap<{
      success: boolean;
      paymentId: string;
      transaction: string;
      providerA2AUrl: string;
      serviceRef: string;
    }>(
      "daski_settle_payment",
      await client.callTool({
        name: "daski_settle_payment",
        arguments: {
          paymentPayload: {
            x402Version: 1,
            scheme: "exact",
            network: td.domain.chainId === 8453 ? "base" : "base-sepolia",
            payload: {
              signature,
              authorization: td.message,
            },
          },
          paymentRequirements: buy.paymentRequirements,
        },
      }),
    );
    console.log(`  ✔ settled on-chain: paymentId=${settled.paymentId} tx=${settled.transaction}`);

    // 4. Submit task to provider over A2A — two-call pattern.
    //    First call (no envelopeAuth) returns the EIP-712 typed-data the
    //    buyer wallet signs, plus the matching messageId. Second call
    //    passes envelopeAuth + the SAME messageId; gateway forwards to A2A.
    const envelope = unwrap<{
      messageId: string;
      authorization: Record<string, unknown>;
      eip712TypedData: {
        domain: any;
        types: any;
        primaryType: string;
        message: Record<string, unknown>;
      };
    }>(
      "daski_submit_task (first call)",
      await client.callTool({
        name: "daski_submit_task",
        arguments: {
          providerA2AUrl: settled.providerA2AUrl,
          skillId: env.skillId,
          serviceRef: settled.serviceRef,
          paymentId: settled.paymentId,
          transactionHash: settled.transaction,
          chainId: td.domain.chainId,
          buyerTokenId: ids.buyerTokenId,
          serviceArgs: { domain: env.domain },
        },
      }),
    );
    const envelopeSig = await signer.signTypedData({
      domain: envelope.eip712TypedData.domain,
      types: envelope.eip712TypedData.types,
      primaryType: envelope.eip712TypedData.primaryType,
      message: envelope.eip712TypedData.message,
    });
    const submit = unwrap<{ taskId: string; state: string }>(
      "daski_submit_task (second call)",
      await client.callTool({
        name: "daski_submit_task",
        arguments: {
          providerA2AUrl: settled.providerA2AUrl,
          skillId: env.skillId,
          serviceRef: settled.serviceRef,
          paymentId: settled.paymentId,
          transactionHash: settled.transaction,
          chainId: td.domain.chainId,
          serviceArgs: { domain: env.domain },
          messageId: envelope.messageId,
          envelopeAuth: {
            signature: envelopeSig,
            authorization: envelope.authorization,
          },
        },
      }),
    );
    console.log(`  ✔ provider accepted task: taskId=${submit.taskId} state=${submit.state}`);

    // 5. Poll until completed
    const POLL_INTERVAL_MS = 3_000;
    const MAX_POLLS = 60; // 3 minutes
    let lastState = submit.state;
    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const check = unwrap<{
        status: string;
        artifacts: Array<Record<string, unknown>>;
        messages: Array<Record<string, unknown>>;
      }>(
        "daski_get_task_status",
        await client.callTool({
          name: "daski_get_task_status",
          arguments: {
            providerA2AUrl: settled.providerA2AUrl,
            taskId: submit.taskId,
          },
        }),
      );
      if (check.status !== lastState) {
        console.log(`  · status: ${check.status}`);
        lastState = check.status;
      }
      if (check.status === "completed") {
        console.log(`  ✔ task completed`);
        if (check.artifacts.length > 0) {
          console.log(`    artifacts:`, JSON.stringify(check.artifacts, null, 2));
        }
        return { paymentId: settled.paymentId };
      }
      if (check.status === "failed" || check.status === "canceled") {
        throw new Error(
          `provider task ${check.status}: ${JSON.stringify(check.messages)}`,
        );
      }
    }
    throw new Error("provider task did not complete within poll window");
  } finally {
    await transport.close();
  }
}

async function phase3_confirm(
  env: EnvBundle,
  signer: CdpSigner,
  paymentId: string,
): Promise<void> {
  console.log("\n── PHASE 3: buyer confirmation attestation ───────────");

  const { client, transport } = await connectMcp(env.gatewayUrl);
  try {
    // Two-call daski_confirm_delivery: first call (no signature) returns
    // the EAS Attest typed-data; second call (with v/r/s + the echoed
    // deadline) submits via the facilitator.
    const prep = unwrap<{
      eip712TypedData: any;
      deadline: string;
      submitTemplate?: {
        confirmation: string;
        attester: string;
        deadline: string;
        refUid?: string;
      };
    }>(
      "daski_confirm_delivery (first call)",
      await client.callTool({
        name: "daski_confirm_delivery",
        arguments: {
          paymentId,
          confirmation: "Confirmed",
          attester: signer.address,
        },
      }),
    );
    console.log("  ✔ prepared EAS Attest typed-data");

    const td = prep.eip712TypedData;
    const signature = await signer.signTypedData({
      domain: td.domain,
      types: td.types,
      primaryType: td.primaryType,
      message: td.message,
    });
    // Split into v/r/s as the on-chain EAS expects
    const r = `0x${signature.slice(2, 66)}` as Hex;
    const s = `0x${signature.slice(66, 130)}` as Hex;
    const v = parseInt(signature.slice(130, 132), 16);

    const result = unwrap<{
      attestationUid: string;
      transactionHash: string;
    }>(
      "daski_confirm_delivery (second call)",
      await client.callTool({
        name: "daski_confirm_delivery",
        arguments: {
          paymentId,
          confirmation: "Confirmed",
          attester: signer.address,
          deadline: prep.deadline,
          refUid: prep.submitTemplate?.refUid,
          signature: { v, r, s },
        },
      }),
    );
    console.log(
      `  ✔ EAS attestation submitted: uid=${result.attestationUid} tx=${result.transactionHash}`,
    );
  } finally {
    await transport.close();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const env = loadEnv();
  const phase = (process.env.PHASE ?? "all").toLowerCase();
  console.log(`Running PHASE=${phase} against ${env.gatewayUrl}`);

  const phase0Only = phase === "0" || phase === "cdp";

  // Phase 0 always runs (everything else needs the signer).
  const signer = await phase0_cdp(env);
  if (phase0Only) {
    console.log("\nPHASE=0 done.");
    return;
  }

  if (phase === "1" || phase === "discover") {
    await phase1_discover(env, signer);
    console.log("\nPHASE=1 done.");
    return;
  }

  // For phase 2 and "all", we always need phase 1's output
  const ids = await phase1_discover(env, signer);

  if (phase === "2" || phase === "purchase") {
    await phase2_paid_purchase(env, signer, ids);
    console.log("\nPHASE=2 done.");
    return;
  }

  if (phase === "3" || phase === "confirm") {
    if (!process.env.DASKI_PAYMENT_ID) {
      console.error(
        "PHASE=3 needs DASKI_PAYMENT_ID env var (output of a prior PHASE=2 run).",
      );
      process.exit(2);
    }
    await phase3_confirm(env, signer, process.env.DASKI_PAYMENT_ID);
    console.log("\nPHASE=3 done.");
    return;
  }

  // Default: run everything in sequence
  const { paymentId } = await phase2_paid_purchase(env, signer, ids);
  await phase3_confirm(env, signer, paymentId);
  console.log("\nAll phases passed.");
}

main().catch((err) => {
  console.error("\nLive E2E failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
