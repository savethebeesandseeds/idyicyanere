#include "idy.h"
#include <ctype.h>
#include <string.h>
#include <errno.h>
#include <limits.h>

/* Return a newly-allocated copy of the environment value with
   leading/trailing ASCII whitespace removed. If the variable is
   unset or trims to empty, return NULL. */
char* idy_getenv_trimdup(const char *key){
    const char *v = getenv(key);
    if(!v) return NULL;
    const char *p = v;
    while(*p && isspace((unsigned char)*p)) p++;
    const char *e = p + strlen(p);
    while(e > p && isspace((unsigned char)e[-1])) e--;
    size_t n = (size_t)(e - p);
    if(n == 0) return NULL;
    char *out = (char*)malloc(n + 1);
    if(!out) return NULL;
    memcpy(out, p, n);
    out[n] = 0;
    return out;
}

/* Case-insensitive equality */
static int idy__ieq(const char *a, const char *b){
    if(!a || !b) return 0;
    while(*a && *b){
        if(tolower((unsigned char)*a) != tolower((unsigned char)*b)) return 0;
        ++a; ++b;
    }
    return *a == 0 && *b == 0;
}

/* Return 1 for truthy env (1,true,yes,on,y), 0 otherwise. Trims ws. */
int idy_env_truthy(const char *key){
    char *t = idy_getenv_trimdup(key);
    if(!t) return 0;
    int yes = idy__ieq(t,"1") || idy__ieq(t,"true") || idy__ieq(t,"yes") || idy__ieq(t,"on") || idy__ieq(t,"y");
    free(t);
    return yes;
}

/* Parse size strings like: "65536", "64k", "64K", "1m", "2G", "64KiB", "4 MiB".
   On error or non-positive values returns def_value. */
size_t idy_env_parse_size(const char *key, size_t def_value){
    char *s = idy_getenv_trimdup(key);
    if(!s || !*s){
        free(s);
        return def_value;
    }

    const char *p = s;
    errno = 0;
    char *endp = NULL;
    unsigned long long base = strtoull(p, &endp, 10);

    // Skip spaces after the number
    while(endp && *endp && isspace((unsigned char)*endp)) endp++;

    // Detect unit (first non-space letter is enough; accept KiB/MiB/GiB variants)
    unsigned long long mult = 1;
    if(endp && *endp){
        char u = (char)toupper((unsigned char)*endp);
        if(u == 'K') mult = 1024ULL;
        else if(u == 'M') mult = 1024ULL * 1024ULL;
        else if(u == 'G') mult = 1024ULL * 1024ULL * 1024ULL;
        else mult = 1; // treat unknown suffix as bytes
    }

    // Safety: invalid or non-positive -> default
    if(errno == ERANGE || base == 0ULL){
        free(s);
        return def_value;
    }

    // Multiply with saturation to ULLONG_MAX
    unsigned long long val;
    if(mult != 0 && base > ULLONG_MAX / mult) val = ULLONG_MAX;
    else val = base * mult;

    // Clamp to SIZE_MAX if needed
    if(val > (unsigned long long)SIZE_MAX) val = (unsigned long long)SIZE_MAX;

    free(s);
    return (size_t)val;
}
