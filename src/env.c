#include "idy.h"
#include <ctype.h>
#include <string.h>

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
