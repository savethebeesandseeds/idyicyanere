#ifndef IDY_H
#define IDY_H

#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <stdint.h>
#include <errno.h>

#include <curl/curl.h>
#include <jansson.h>
#include <ncurses.h>

#define IDY_VERSION "0.1.0"

typedef struct {
    char *model;
    char *embeddings_model;
    char *api_key;
    char *base_url;   // e.g. https://api.openai.com/v1
    char *system_prompt_unified_diff;

    // Optional caps for prompt slices (0 = use compile defaults from stream.h)
    size_t prompt_max_orig;
    size_t prompt_max_ctx;
} idy_config_t;

typedef struct {
    char *data;      // zero-terminated edit buffer
    size_t len;
    size_t cap;
} buffer_t;

void buf_init(buffer_t *b);
void buf_free(buffer_t *b);
bool buf_load_file(buffer_t *b, const char *path);
bool buf_save_file(buffer_t *b, const char *path);

/* ===== Env helpers (trim whitespace incl. stray \r/\n) ===== */
char* idy_getenv_trimdup(const char *key);  // malloc'd, trimmed; NULL if unset/empty
int   idy_env_truthy(const char *key);      // 1 if {1,true,yes,on,y} (case-insensitive), else 0

#endif
