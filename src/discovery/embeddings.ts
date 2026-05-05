/**
 * Local sentence embeddings for `search_services` intent matching.
 *
 * Uses Xenova's all-MiniLM-L6-v2 (~90MB on disk, 384-dim float32). The
 * model is downloaded once on first use and cached under
 * `node_modules/@xenova/transformers/.cache/` (default Hugging Face cache
 * location). A single pipeline is shared across the process.
 *
 * The `Embedder` interface is small on purpose: tests inject a
 * deterministic stub instead of paying the model-load cost in CI.
 */

export interface Embedder {
  /** Embedding dimension, e.g. 384 for all-MiniLM-L6-v2. */
  readonly dim: number;
  embed(text: string): Promise<Float32Array>;
  embedMany(texts: string[]): Promise<Float32Array[]>;
}

const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
const MODEL_DIM = 384;

let pipelinePromise: Promise<unknown> | null = null;

/** Default embedder: lazy-loads the Xenova pipeline on first use. */
export function xenovaEmbedder(): Embedder {
  async function getPipeline() {
    if (!pipelinePromise) {
      // Dynamic import keeps the heavy dep off the startup path; the
      // pipeline factory itself is also lazy.
      pipelinePromise = (async () => {
        const transformers = await import("@xenova/transformers");
        return transformers.pipeline("feature-extraction", MODEL_NAME);
      })();
    }
    return pipelinePromise;
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
