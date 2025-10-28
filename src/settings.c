#include "settings.h"
#include <dirent.h>
#include <sys/stat.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <strings.h> // for strcasecmp
#include <limits.h>

static char* xstrdup(const char *s){ size_t n=strlen(s)+1; char *p=(char*)malloc(n); if(p) memcpy(p,s,n); return p; }

static void add_item(file_list_t *out, const char *relpath, bool is_dir, int depth){
    if(out->count == out->cap){
        out->cap = out->cap ? out->cap * 2 : 128;
        out->items = (file_item_t*)realloc(out->items, sizeof(file_item_t)*out->cap);
    }
    file_item_t *it = &out->items[out->count++];
    it->name = xstrdup(relpath);
    it->is_dir = is_dir;
    it->depth = depth;
}

typedef struct { char *name; bool is_dir; } entry_t;

static int cmp_entry(const void *a, const void *b){
    const entry_t *A=(const entry_t*)a, *B=(const entry_t*)b;
    if(A->is_dir != B->is_dir) return B->is_dir - A->is_dir; // dirs first
    return strcasecmp(A->name, B->name);
}

static void free_entries(entry_t *v, int n){
    for(int i=0;i<n;i++) free(v[i].name);
    free(v);
}

static int join_path(char *dst, size_t n, const char *base, const char *rel){
    if(!rel || !*rel) return snprintf(dst, n, "%s", base);
    return snprintf(dst, n, "%s/%s", base, rel);
}

static void walk(const char *root, const char *rel, int depth, file_list_t *out){
    char dirpath[PATH_MAX];
    join_path(dirpath, sizeof(dirpath), root, rel);

    DIR *d = opendir(dirpath);
    if(!d) return;

    // collect entries
    int cap=64, cnt=0;
    entry_t *vec = (entry_t*)malloc(sizeof(entry_t)*cap);

    struct dirent *ent;
    while((ent=readdir(d))){
        if(strcmp(ent->d_name,".")==0 || strcmp(ent->d_name,"..")==0) continue;
        // full path for stat
        char full[PATH_MAX]; snprintf(full,sizeof(full), "%s/%s", dirpath, ent->d_name);
        struct stat st;
        if(lstat(full, &st) != 0) continue;
        bool is_dir = S_ISDIR(st.st_mode);
        // don't recurse into symlinked directories to avoid loops
        if(S_ISLNK(st.st_mode)) is_dir = false;

        if(cnt==cap){ cap*=2; vec=(entry_t*)realloc(vec, sizeof(entry_t)*cap); }
        vec[cnt].name = xstrdup(ent->d_name);
        vec[cnt].is_dir = is_dir;
        cnt++;
    }
    closedir(d);

    qsort(vec, cnt, sizeof(entry_t), cmp_entry);

    // add entries and recurse
    for(int i=0;i<cnt;i++){
        char rel2[PATH_MAX];
        if(!rel || !*rel) snprintf(rel2,sizeof(rel2), "%s", vec[i].name);
        else snprintf(rel2,sizeof(rel2), "%s/%s", rel, vec[i].name);

        add_item(out, rel2, vec[i].is_dir, depth);
        if(vec[i].is_dir){
            walk(root, rel2, depth+1, out);
        }
    }

    free_entries(vec, cnt);
}

bool list_dir(const char *path, file_list_t *out){
    out->items=NULL; out->count=0; out->cap=0;
    walk(path, "", 0, out);
    return true;
}

void free_file_list(file_list_t *fl){
    for(int i=0;i<fl->count;i++) free(fl->items[i].name);
    free(fl->items);
    fl->items=NULL; fl->count=fl->cap=0;
}
