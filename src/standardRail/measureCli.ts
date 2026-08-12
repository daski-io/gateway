import { loadConfig } from "../config.js";
import { loadStandardRailConfig } from "./config.js";
import { measureRuntimeIntegrity } from "./runtimeIntegrity.js";

const app = loadConfig();
const rail = loadStandardRailConfig();
if (!rail) throw new Error("PAYMENT_RAIL=standard is required to measure the standard runtime");
const measured = await measureRuntimeIntegrity(app, rail);
process.stdout.write(`${JSON.stringify(measured, null, 2)}\n`);
