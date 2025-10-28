#ifndef FILE_CONTEXT_H
#define FILE_CONTEXT_H

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

// Check membership in a context list
bool ctx_has(char **list, int count, const char *path);

// Mutating helpers (operate on the caller-owned array and count)
void ctx_add(char ***plist, int *pcount, const char *path);
void ctx_remove(char ***plist, int *pcount, const char *path);
void ctx_toggle(char ***plist, int *pcount, const char *path);

#ifdef __cplusplus
}
#endif
#endif
