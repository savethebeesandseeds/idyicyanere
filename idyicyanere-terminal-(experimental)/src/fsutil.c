#include "fsutil.h"
#include <sys/stat.h>

bool fs_is_dir(const char *p){
    struct stat st;
    return (p && stat(p, &st) == 0 && S_ISDIR(st.st_mode));
}

bool fs_is_file(const char *p){
    struct stat st;
    return (p && stat(p, &st) == 0 && S_ISREG(st.st_mode));
}
