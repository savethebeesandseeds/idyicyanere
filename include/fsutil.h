#ifndef FSUTIL_H
#define FSUTIL_H

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

bool fs_is_dir(const char *p);
bool fs_is_file(const char *p);

#ifdef __cplusplus
}
#endif
#endif
