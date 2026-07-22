/**
 * Local sentence embeddings for `search_services` intent matching.
 *
 * Uses Xenova's all-MiniLM-L6-v2 (~90MB on disk, 384-dim float32). The
 * Production images preload the model under the transformers cache during
 * the Docker build and disable remote model access at runtime. Local
 * development downloads it on first use. A single pipeline is shared
 * across the process.
 *
 * The `Embedder` interface is small on purpose: tests inject a
 * deterministic stub instead of paying the model-load cost in CI.
 */

export interface Embedder {
  /** Embedding dimension, e.g. 384 for all-MiniLM-L6-v2. */
  readonly dim: number;
  embed(text: string): Promise<Float32Array>;
  embedMany(texts: string[]): Promise<Float32Array[]>;
  warmup?(): Promise<void>;
  getStatus?(): EmbedderStatus;
}

export interface EmbedderStatus {
  state: "idle" | "loading" | "ok" | "degraded";
  reason?: string;
  retryAt?: string;
}

const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
const MODEL_DIM = 384;
const LOAD_RETRY_BACKOFF_MS = 30_000;

let pipelinePromise: Promise<unknown> | null = null;
let retryAfter = 0;
let status: EmbedderStatus = { state: "idle" };

/** Default embedder: lazy-loads the Xenova pipeline on first use. */
export function xenovaEmbedder(): Embedder {
  async function getPipeline() {
    if (Date.now() < retryAfter) {
      throw new Error("embedding model is temporarily unavailable");
    }
    if (!pipelinePromise) {
      // Dynamic import keeps the heavy dep off the startup path; the
      // pipeline factory itself is also lazy.
      status = { state: "loading" };
      pipelinePromise = (async () => {
        const transformers = await import("@xenova/transformers");
        if (process.env.NODE_ENV === "production") {
          transformers.env.allowRemoteModels = false;
        }
        return transformers.pipeline("feature-extraction", MODEL_NAME);
      })();
    }
    try {
      const pipeline = await pipelinePromise;
      status = { state: "ok" };
      return pipeline;
    } catch {
      pipelinePromise = null;
      retryAfter = Date.now() + LOAD_RETRY_BACKOFF_MS;
      status = {
        state: "degraded",
        reason: "model_load_failed",
        retryAt: new Date(retryAfter).toISOString(),
      };
      throw new Error("embedding model is unavailable");
    }
  }

  async function run(text: string): Promise<Float32Array> {
    const pipe = (await getPipeline()) as (
      input: string,
      opts: { pooling: "mean"; normalize: boolean },
    ) => Promise<{ data: Float32Array | number[] }>;
    const out = await pipe(text, { pooling: "mean", normalize: true });
    const data =
      out.data instanceof Float32Array
        ? out.data
        : Float32Array.from(out.data as number[]);
    if (data.length !== MODEL_DIM) {
      throw new Error(
        `embedder: expected dim ${MODEL_DIM}, got ${data.length}`,
      );
    }
    return data;
  }

  return {
    dim: MODEL_DIM,
    embed: run,
    async embedMany(texts: string[]) {
      const out: Float32Array[] = [];
      for (const t of texts) out.push(await run(t));
      return out;
    },
    async warmup() {
      await run("gateway embedding readiness");
    },
    getStatus() {
      return { ...status };
    },
  };
}

/**
 * Format a vector for pgvector input. pgvector accepts a string literal
 * `[v1,v2,...]` for any text-coercible parameter — saves us from
 * registering a custom type oid.
 */
export function vectorLiteral(v: Float32Array | number[]): string {
  const arr = v instanceof Float32Array ? Array.from(v) : v;
  return `[${arr.join(",")}]`;
}
