import type { Embedder } from "../../src/discovery/embeddings.js";

const DIM = 384;

/**
 * Deterministic in-process embedder for tests. Tokenizes on
 * non-alphanumeric characters, hashes each token into one of `DIM`
 * buckets, and L2-normalizes. Two texts sharing tokens get a high
 * cosine similarity; tests can rely on the ranking without paying the
 * Xenova model-download cost.
 *
 * NOT a real semantic embedder — never use in production. We trade
 * meaningful proximity for "good enough to verify the wiring."
 */
export function stubEmbedder(): Embedder {
  function hash(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h = (h ^ s.charCodeAt(i)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function build(text: string): Float32Array {
    const v = new Float32Array(DIM);
    const tokens = text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0);
    for (const t of tokens) {
      v[hash(t) % DIM] += 1;
    }
    let norm = 0;
    for (let i = 0; i < DIM; i++) norm += v[i]! * v[i]!;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < DIM; i++) v[i] = v[i]! / norm;
    return v;
  }

  return {
    dim: DIM,
    async embed(text: string) {
      return build(text);
    },
    async embedMany(texts: string[]) {
      return texts.map(build);
    },
  };
}
