import { validateProviderLegalReachability } from "../src/legal/onboarding.js";

const registrationUrl = process.argv[2];
if (!registrationUrl) {
  process.stderr.write(
    "Usage: npm run validate-provider-legal -- https://provider.example/.well-known/agent.json\n",
  );
  process.exitCode = 1;
} else {
  try {
    const legal = await validateProviderLegalReachability(registrationUrl);
    process.stdout.write(
      `Provider legal metadata is valid and reachable: ${legal.legalName}\n`,
    );
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
