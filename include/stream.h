#ifndef STREAM_H
#define STREAM_H
#include "idy.h"

// keep this near the top of the file or in a shared header if you prefer
#ifndef IDY_PROMPT_MAX_ORIG
#define IDY_PROMPT_MAX_ORIG   (64 * 1024)   // cap ORIGINAL bytes sent
#endif
#ifndef IDY_PROMPT_MAX_CTX
#define IDY_PROMPT_MAX_CTX    (32 * 1024)   // cap CONTEXT bytes sent
#endif

/* ============================================================
 * Streaming Core
 * ============================================================ */

typedef void (*stream_on_delta)(const char *token, void *user);
typedef void (*stream_on_done)(json_t *final_usage, void *user);

typedef struct {
    idy_config_t *cfg;     // contains base_url, model, prompts, api_key, etc.
    stream_on_delta on_delta;
    stream_on_done  on_done;
    void *user;
} stream_ctx_t;

/* ============================================================
 * Public API
 * ============================================================ */

/* Generic chat streaming entry-point:
 *   - system_prompt: text for the system role
 *   - user_content : text for the user role
 * The function will stream assistant "delta.content" tokens via ctx->on_delta
 * and emit usage (when provided) or a final [DONE] via ctx->on_done.
 */
bool openai_stream_chat(stream_ctx_t *ctx,
                        const char *system_prompt,
                        const char *user_content);

/* NEW: Multiple user messages variant.
 * Sends one system message followed by `user_msgs_count` user messages (in order).
 * This is helpful to keep CONTEXT separate from ORIGINAL, etc.
 */
bool openai_stream_chat_multi(stream_ctx_t *ctx,
                              const char *system_prompt,
                              const char **user_msgs,
                              int user_msgs_count);

/* Convenience wrapper for unified diff flow.
 * Builds a message list:
 *   [system]: ctx->cfg->system_prompt_unified_diff (or a default)
 *   [user]  : "SECTION: <section_hint>"               (if provided)
 *   [user]  : "CONTEXT:\n<bounded-context>"           (if provided)
 *   [user]  : "ORIGINAL:\n<bounded-original>"
 */
bool openai_stream_unified_diff(stream_ctx_t *ctx,
                                const char *original,
                                const char *context,
                                const char *section_hint); // e.g., "Abstract"

#endif /* STREAM_H */
