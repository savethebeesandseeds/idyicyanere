#ifndef IDY_H
#define IDY_H

#define _GNU_SOURCE
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
    char *api_key;
    char *base_url;   // e.g. https://api.openai.com/v1
    char *system_prompt;
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

#endif
