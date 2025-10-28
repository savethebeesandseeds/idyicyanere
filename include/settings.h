#ifndef SETTINGS_H
#define SETTINGS_H

#include <stdbool.h>

typedef struct {
    char *name;   // relative path from the current CWD root (e.g., "src/main.c")
    bool is_dir;
    int  depth;   // 0 for top-level; increases for subfolders
} file_item_t;

typedef struct {
    file_item_t *items;
    int count;
    int cap;
} file_list_t;

// Recursively lists a directory into a flattened tree (dirs first per level).
// Fills out->items with relative paths and depth for pretty rendering.
bool list_dir(const char *path, file_list_t *out);
void free_file_list(file_list_t *fl);

#endif
