#ifndef DIFF_H
#define DIFF_H

#include <stdbool.h>

// Apply a unified diff to `orig` -> `out`. Supports single-file diff with multiple hunks.
// On success, returns true and stores malloc'ed result in `*out` (caller frees).
// On failure, returns false; if `errmsg` is non-NULL, it will point to a malloc'ed
// explanation string (caller frees).
bool apply_unified_diff(const char *orig, const char *diff,
                        char **out, char **errmsg);

#endif /* DIFF_H */
