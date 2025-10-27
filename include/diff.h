#ifndef DIFF_H
#define DIFF_H
#include "idy.h"

// Apply a unified diff to `orig` -> `out`. Supports single-file diff.
// Returns true on success; on failure, `errmsg` (optional) is set.
bool apply_unified_diff(const char *orig, const char *diff,
                        char **out, char **errmsg);
#endif
