import { keccak256 } from "viem";
import type { PoolClient } from "pg";
import { hexToBytea } from "../db/paymentChallengeCodec.js";
import { BAZAAR_CHALLENGE_TTL_SECONDS } from "./lifecycleChallenge.js";
import type {
  BazaarChallengeMacKey,
  BazaarChallengeMacKeyring,
  BazaarRetainedChallengeMacKey,
} from "./types.js";

interface RawChallengeMacEpoch {
  key_epoch: string;
  secret_commitment: Buffer;
  retired_at: Date | null;
  accept_until: string | null;
}

export async function reconcileChallengeMacEpochsInTransaction(input: {
  client: PoolClient;
  keyring: BazaarChallengeMacKeyring;
  now: bigint;
}): Promise<void> {
  const stored = await input.client.query<RawChallengeMacEpoch>(
    `SELECT key_epoch, secret_commitment, retired_at, accept_until
       FROM bazaar_challenge_mac_epochs ORDER BY activated_at FOR UPDATE`,
  );
  const active = stored.rows.filter((row) => row.retired_at === null);
  if (active.length > 1) {
    throw new Error("Bazaar challenge MAC active-epoch invariant violated");
  }
  if (active.length === 0) {
    if (stored.rows.length > 0 || (input.keyring.retained?.length ?? 0) > 0) {
      throw new Error("Bazaar challenge MAC epoch history is incomplete");
    }
    await insertCurrent(input.client, input.keyring.current);
    return;
  }

  const current = active[0]!;
  const currentCommitment = secretCommitment(input.keyring.current);
  if (current.key_epoch === input.keyring.current.epoch) {
    if (!current.secret_commitment.equals(currentCommitment)) {
      throw new Error("Bazaar challenge MAC secret changed within one epoch");
    }
  } else {
    if (stored.rows.some((row) => row.key_epoch === input.keyring.current.epoch)) {
      throw new Error("Bazaar retired challenge MAC epoch cannot reactivate");
    }
    const retained = input.keyring.retained?.find(
      (key) => key.epoch === current.key_epoch,
    );
    if (
      !retained || !current.secret_commitment.equals(secretCommitment(retained)) ||
      retained.acceptUntil < input.now + BAZAAR_CHALLENGE_TTL_SECONDS
    ) {
      throw new Error("Bazaar challenge MAC rotation drops a live epoch");
    }
    await input.client.query(
      `UPDATE bazaar_challenge_mac_epochs
          SET retired_at = now(), accept_until = $2
        WHERE key_epoch = $1 AND retired_at IS NULL`,
      [current.key_epoch, retained.acceptUntil.toString()],
    );
    current.retired_at = new Date();
    current.accept_until = retained.acceptUntil.toString();
    await insertCurrent(input.client, input.keyring.current);
  }
  verifyRetainedEpochs(stored.rows, input.keyring.retained ?? [], input.now);
}

function verifyRetainedEpochs(
  stored: RawChallengeMacEpoch[],
  retained: BazaarRetainedChallengeMacKey[],
  now: bigint,
): void {
  for (const key of retained) {
    const row = stored.find((candidate) => candidate.key_epoch === key.epoch);
    if (
      !row || row.retired_at === null || row.accept_until === null ||
      !row.secret_commitment.equals(secretCommitment(key)) ||
      BigInt(row.accept_until) !== key.acceptUntil
    ) throw new Error("Bazaar retained challenge MAC epoch is not immutable");
  }
  for (const row of stored) {
    if (
      row.retired_at !== null && row.accept_until !== null &&
      BigInt(row.accept_until) > now &&
      !retained.some((key) => key.epoch === row.key_epoch)
    ) throw new Error("Bazaar challenge MAC rotation omits a retained epoch");
  }
}

async function insertCurrent(
  client: PoolClient,
  key: BazaarChallengeMacKey,
): Promise<void> {
  await client.query(
    `INSERT INTO bazaar_challenge_mac_epochs
       (key_epoch, secret_commitment) VALUES ($1, $2)`,
    [key.epoch, secretCommitment(key)],
  );
}

function secretCommitment(key: BazaarChallengeMacKey): Buffer {
  return hexToBytea(keccak256(key.secret));
}
