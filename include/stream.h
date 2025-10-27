#ifndef STREAM_H
#define STREAM_H
#include "idy.h"

typedef void (*stream_on_delta)(const char *token, void *user);
typedef void (*stream_on_done)(json_t *final_usage, void *user);

typedef struct {
    idy_config_t *cfg;
    stream_on_delta on_delta;
    stream_on_done  on_done;
    void *user;
} stream_ctx_t;

// Request a streamed suggestion; `original` is the selected text or full doc.
// The model returns a unified diff (streamed).
bool openai_stream_unified_diff(stream_ctx_t *ctx,
                                const char *original,
                                const char *section_hint); // e.g., "Abstract"
#endif
