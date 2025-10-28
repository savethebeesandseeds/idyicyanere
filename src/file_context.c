#include "file_context.h"
#include <string.h>
#include <stdlib.h>

static char* xstrdup_local(const char *s){
    if(!s) return NULL;
    size_t n = strlen(s) + 1;
    char *p = (char*)malloc(n);
    if(p) memcpy(p, s, n);
    return p;
}

bool ctx_has(char **list, int count, const char *path){
    if(!list || !path) return false;
    for(int i=0;i<count;i++){
        if(list[i] && strcmp(list[i], path)==0) return true;
    }
    return false;
}

void ctx_add(char ***plist, int *pcount, const char *path){
    if(!plist || !pcount || !path) return;
    if(ctx_has(*plist, *pcount, path)) return;
    int n = *pcount;
    char **nv = (char**)realloc(*plist, sizeof(char*) * (n + 1));
    if(!nv) return;
    nv[n] = xstrdup_local(path);
    *plist = nv;
    *pcount = n + 1;
}

void ctx_remove(char ***plist, int *pcount, const char *path){
    if(!plist || !pcount || !*plist || *pcount<=0 || !path) return;
    char **v = *plist; int n = *pcount;
    for(int i=0;i<n;i++){
        if(v[i] && strcmp(v[i], path)==0){
            free(v[i]);
            for(int k=i+1;k<n;k++) v[k-1] = v[k];
            n--;
            if(n==0){ free(v); v=NULL; }
            else {
                char **nv = (char**)realloc(v, sizeof(char*)*n);
                if(nv) v = nv;
            }
            *plist = v; *pcount = n;
            return;
        }
    }
}

void ctx_toggle(char ***plist, int *pcount, const char *path){
    if(ctx_has(*plist, *pcount, path)) ctx_remove(plist, pcount, path);
    else ctx_add(plist, pcount, path);
}
