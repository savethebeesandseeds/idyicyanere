/* requests.h */
#ifndef REQUESTS_H
#define REQUESTS_H

#include "idy.h"        // idy_config_t, env helpers, etc.
#include <jansson.h>
#include <stdbool.h>
#include <stddef.h>

/* ============================================================
 * Requests Core (non-streaming)
 * ============================================================ */

typedef struct {
    idy_config_t *cfg;   // expects: base_url, api_key, model (used for embeddings if non-null)
} requests_ctx_t;

/* ============================================================
 * Embeddings (OpenAI-compatible)
 * ============================================================ */

/* Result container for a batch of embeddings */
typedef struct {
    float  **vecs;   // vecs[i] is a heap-allocated float[dims[i]]
    size_t  *dims;   // per-item dims (usually equal across rows)
    int      count;  // number of vectors
    json_t  *raw;    // optional: raw JSON response; decref via emb_batch_free()
} emb_batch_t;

/* Create embeddings for N inputs.
 *
 * Params:
 *   - ctx           : requests context (holds API base + key)
 *   - inputs        : array of N UTF-8 strings (required, N>0)
 *   - n_inputs      : number of inputs
 *   - model_opt     : NULL => use ctx->cfg->model, else override (e.g., "text-embedding-3-small")
 *   - dims_opt      : 0 to omit, else supply "dimensions" to API (if model supports it)
 *   - out           : result batch; caller must call emb_batch_free()
 *   - err_msg_out   : optional; if non-NULL, filled with heap string on error; caller free()
 *
 * Returns: true on success, false on error (see err_msg_out).
 */
bool openai_embeddings_batch(requests_ctx_t          *ctx,
                             const char * const      *inputs,
                             int                      n_inputs,
                             const char              *model_opt,
                             int                      dims_opt,
                             emb_batch_t             *out,
                             char                   **err_msg_out);

/* Convenience: single-input wrapper.
 * On success, transfers a heap-allocated vector to *out_vec, dimension to *out_dim.
 * If out_raw is non-NULL, the raw JSON is returned (caller must json_decref()).
 */
bool openai_embeddings_one(requests_ctx_t  *ctx,
                           const char      *input,
                           const char      *model_opt,
                           int              dims_opt,
                           float          **out_vec,
                           size_t         *out_dim,
                           json_t        **out_raw,
                           char          **err_msg_out);

/* Free result of openai_embeddings_batch() */
void emb_batch_free(emb_batch_t *res);

#endif /* REQUESTS_H */
