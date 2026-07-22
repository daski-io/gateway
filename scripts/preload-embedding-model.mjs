import { env, pipeline } from "@xenova/transformers";

env.allowRemoteModels = true;
await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
