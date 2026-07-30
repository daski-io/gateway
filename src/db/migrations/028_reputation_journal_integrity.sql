DO $$
BEGIN
  IF EXISTS (
    SELECT transaction.id
      FROM facilitator_transactions AS transaction
      LEFT JOIN reputation_mirrors AS mirror
        ON transaction.id = mirror.revoke_facilitator_transaction_id
        OR transaction.id = mirror.give_facilitator_transaction_id
     WHERE transaction.status IN ('prepared', 'broadcast')
       AND transaction.operation_kind IN ('feedback_revoke', 'feedback_give')
     GROUP BY transaction.id
    HAVING count(mirror.payment_id) <> 1
  ) THEN
    RAISE EXCEPTION
      'active feedback journal rows require exactly one mirror link';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM reputation_mirrors AS mirror
      JOIN facilitator_transactions AS transaction
        ON transaction.id = mirror.revoke_facilitator_transaction_id
        OR transaction.id = mirror.give_facilitator_transaction_id
     WHERE transaction.status IN ('prepared', 'broadcast')
       AND (
         (transaction.id = mirror.revoke_facilitator_transaction_id
          AND transaction.operation_kind <> 'feedback_revoke')
         OR
         (transaction.id = mirror.give_facilitator_transaction_id
          AND transaction.operation_kind <> 'feedback_give')
         OR transaction.operation_data->>'paymentId' IS DISTINCT FROM
              mirror.payment_id::text
         OR lower(transaction.operation_data->>'attestationUid')
              IS DISTINCT FROM
              ('0x' || encode(mirror.attestation_uid, 'hex'))
       )
  ) THEN
    RAISE EXCEPTION
      'active feedback journal owner data disagrees with its mirror';
  END IF;

  IF EXISTS (
    SELECT revoke_facilitator_transaction_id
      FROM reputation_mirrors
     WHERE revoke_facilitator_transaction_id IS NOT NULL
     GROUP BY revoke_facilitator_transaction_id
    HAVING count(*) > 1
  ) OR EXISTS (
    SELECT give_facilitator_transaction_id
      FROM reputation_mirrors
     WHERE give_facilitator_transaction_id IS NOT NULL
     GROUP BY give_facilitator_transaction_id
    HAVING count(*) > 1
  ) OR EXISTS (
    SELECT 1
      FROM reputation_mirrors
     WHERE revoke_facilitator_transaction_id =
           give_facilitator_transaction_id
  ) THEN
    RAISE EXCEPTION
      'reputation journal links require unique operation ownership';
  END IF;
END
$$;

CREATE UNIQUE INDEX reputation_mirrors_revoke_transaction_idx
  ON reputation_mirrors (revoke_facilitator_transaction_id)
  WHERE revoke_facilitator_transaction_id IS NOT NULL;

CREATE UNIQUE INDEX reputation_mirrors_give_transaction_idx
  ON reputation_mirrors (give_facilitator_transaction_id)
  WHERE give_facilitator_transaction_id IS NOT NULL;

ALTER TABLE reputation_mirrors
  ADD CONSTRAINT reputation_mirrors_distinct_transaction_links
  CHECK (
    revoke_facilitator_transaction_id IS NULL
    OR give_facilitator_transaction_id IS NULL
    OR revoke_facilitator_transaction_id <>
       give_facilitator_transaction_id
  );

CREATE INDEX facilitator_transactions_feedback_owner_idx
  ON facilitator_transactions (
    operation_kind,
    (operation_data->>'paymentId'),
    (lower(operation_data->>'attestationUid'))
  )
  WHERE status IN ('prepared', 'broadcast')
    AND operation_kind IN ('feedback_revoke', 'feedback_give');
