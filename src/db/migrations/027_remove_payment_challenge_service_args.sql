UPDATE payment_challenges
   SET payment_required =
         payment_required #- ARRAY[
           'extensions',
           'https://daski.xyz/x402/v2',
           'info',
           'warnings'
         ],
       daski_extension =
         daski_extension #- ARRAY['info', 'warnings'];

ALTER TABLE payment_challenges
  DROP COLUMN service_args;
