-- Base Sepolia's EAS predeploy moved to 1.4.1-beta.3 (signing domain 1.3.0)
-- at block 48858051 on 2026-10-22, and its signed Attest and Revoke structs
-- now name the attester or revoker. Admit that profile beside the existing
-- two, with a signed deadline as for 1.2.0. Widening only: existing rows keep
-- their profile, and the previous runtime never writes the new identifier.
ALTER TABLE standard_confirmation_preparations_v2
  DROP CONSTRAINT standard_confirmation_preparations_v2_profile_id_check,
  ADD CONSTRAINT standard_confirmation_preparations_v2_profile_id_check
    CHECK (profile_id IN ('eas-native-1.0.1','eas-native-1.2.0','eas-native-1.4.1-beta.3')),
  DROP CONSTRAINT standard_confirmation_preparations_v2_check,
  ADD CONSTRAINT standard_confirmation_preparations_v2_check
    CHECK ((profile_id='eas-native-1.0.1' AND signed_deadline IS NULL) OR
      (profile_id IN ('eas-native-1.2.0','eas-native-1.4.1-beta.3') AND signed_deadline>0));
