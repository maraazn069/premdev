// Singleton text-embedding pipeline used by the semantic-search feature.
//
// Why a singleton?
//   - The model weights (~470 MB for paraphrase-multilingual-MiniLM-L12-v2)
//     should be loaded into RAM ONCE per process, not per workspace and not
//     per request. Every workspace shares the same model instance.
//
// Why lazy?
//   - If the operator never enables semantic search (or no user ever opens
//     a chat), we don't want to pay 600 MB of RAM at boot for nothing. The
//     model is loaded on the FIRST call to `embed()` and stays resident
//     thereafter.
//
// Why `paraphrase-multilingual-MiniLM-L12-v2`?
//   - Multilingual (50+ languages incl. Indonesian, English) which matches
//     PremDev's user base.
//   - Small enough (~470 MB on disk, ~600 MB RAM working set) to coexist
//     with the rest of the API on a 4 GB+ VPS.
//   - 384-dimension output — small vectors mean tiny SQLite rows and fast
//     in-process cosine similarity over thousands of chunks.
//
// First-run cost: the model is downloaded from HuggingFace on first use
// (~470 MB). Cached to `TRANSFORMERS_CACHE` (default ~/.cache/huggingface)
// for all subsequent runs. In Docker, this lives inside the container
// filesystem and is rebuilt on every `docker compose pull` — mount a
// volume on `/root/.cache/huggingface` if you want to skip the re-download.

const MODEL_NAME = process.env.EMBEDDING_MODEL || "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
export const EMBEDDING_DIM = 384;

type Status = "idle" | "loading" | "ready" | "error";

interface State {
  status: Status;
  error: string | null;
  loadedAt: number | null;
  // Pipeline is `any` because @xenova/transformers types are awkward to
  // import statically when the package is loaded dynamically below.
  pipeline: any | null;
  loadingPromise: Promise<any> | null;
}

const state: State = {
  status: "idle",
  error: null,
  loadedAt: null,
  pipeline: null,
  loadingPromise: null,
};

function isEnabled(): boolean {
  // Default ON. Set SEMANTIC_SEARCH_ENABLED=false in .env to disable
  // (e.g. on a tiny VPS where the 600 MB RAM is unaffordable).
  return (process.env.SEMANTIC_SEARCH_ENABLED || "true").toLowerCase() !== "false";
}

async function loadPipeline(): Promise<any> {
  if (state.pipeline) return state.pipeline;
  if (state.loadingPromise) return state.loadingPromise;

  state.status = "loading";
  state.error = null;

  state.loadingPromise = (async () => {
    try {
      // Dynamic import: keeps the (large) transformers package out of the
      // boot path when semantic search is disabled.
      const transformers: any = await import("@xenova/transformers");
      // Disable noisy progress bars in production logs.
      if (transformers.env) {
        transformers.env.allowLocalModels = false;
        transformers.env.useBrowserCache = false;
      }
      const pipe = await transformers.pipeline("feature-extraction", MODEL_NAME, {
        quantized: true, // 8-bit weights — half the RAM, ~5% accuracy hit.
      });
      state.pipeline = pipe;
      state.status = "ready";
      state.loadedAt = Date.now();
      return pipe;
    } catch (e: any) {
      state.status = "error";
      state.error = e?.message || String(e);
      state.pipeline = null;
      throw e;
    } finally {
      state.loadingPromise = null;
    }
  })();

  return state.loadingPromise;
}

/**
 * Embed a single string into a 384-dim Float32Array.
 *
 * Caller MUST ensure the input is reasonably small — the model has a
 * 512-token window. Anything longer is silently truncated by the
 * tokenizer, which is fine for our chunked use case.
 */
export async function embed(text: string): Promise<Float32Array> {
  if (!isEnabled()) throw new Error("Semantic search is disabled (SEMANTIC_SEARCH_ENABLED=false)");
  const pipe = await loadPipeline();
  // pooling=mean + normalize=true gives a normalized 1×384 vector ready
  // for plain dot-product similarity.
  const out: any = await pipe(text, { pooling: "mean", normalize: true });
  // out.data is a Float32Array of length 384.
  return out.data as Float32Array;
}

/**
 * Embed many strings in one go. Marginally faster than N serial calls
 * because the tokenizer + ONNX runtime can batch them.
 */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  if (!isEnabled()) throw new Error("Semantic search is disabled (SEMANTIC_SEARCH_ENABLED=false)");
  if (texts.length === 0) return [];
  const pipe = await loadPipeline();
  const out: any = await pipe(texts, { pooling: "mean", normalize: true });
  // Batched output is a 2D tensor; out.data is a flat Float32Array of
  // length texts.length * 384. Slice it back into per-text vectors.
  const flat = out.data as Float32Array;
  const result: Float32Array[] = [];
  for (let i = 0; i < texts.length; i++) {
    result.push(flat.subarray(i * EMBEDDING_DIM, (i + 1) * EMBEDDING_DIM));
  }
  return result;
}

/**
 * Cosine similarity for two unit-length vectors == dot product.
 * Both vectors MUST be the output of `embed()` (already normalized).
 */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/**
 * Snapshot of the embedding pipeline state for the admin UI.
 * Cheap — does NOT trigger model load.
 */
export function embeddingStatus(): {
  enabled: boolean;
  status: Status;
  model: string;
  dim: number;
  loadedAt: number | null;
  error: string | null;
  rssBytes: number | null;
} {
  return {
    enabled: isEnabled(),
    status: state.status,
    model: MODEL_NAME,
    dim: EMBEDDING_DIM,
    loadedAt: state.loadedAt,
    error: state.error,
    // Process-wide RSS, not just the model — useful as a rough indicator
    // of whether loading the model blew up memory.
    rssBytes: typeof process.memoryUsage === "function" ? process.memoryUsage().rss : null,
  };
}

/**
 * Eagerly load the model. Called by the admin "preload" button so the
 * first user chat doesn't pay the ~30 s download/load cost.
 */
export async function preloadModel(): Promise<void> {
  await loadPipeline();
}
