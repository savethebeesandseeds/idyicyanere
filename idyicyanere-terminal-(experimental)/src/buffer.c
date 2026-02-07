#include "idy.h"

/* ========= Buffer implementation (moved from util.c) ========= */

void buf_init(buffer_t *b){
    b->cap = 4096;
    b->len = 0;
    b->data = (char*)malloc(b->cap);
    if(!b->data){
        b->cap = 0; b->len = 0;
        return;
    }
    b->data[0] = '\0';
}

void buf_free(buffer_t *b){
    if(!b) return;
    free(b->data);
    b->data = NULL;
    b->len = 0;
    b->cap = 0;
}

bool buf_load_file(buffer_t *b, const char *path){
    FILE *f = fopen(path, "rb");
    if(!f) return false;
    if(fseek(f, 0, SEEK_END) != 0){ fclose(f); return false; }
    long szl = ftell(f);
    if(szl < 0){ fclose(f); return false; }
    size_t sz = (size_t)szl;
    if(fseek(f, 0, SEEK_SET) != 0){ fclose(f); return false; }

    char *data = (char*)malloc(sz + 1);
    if(!data){ fclose(f); errno = ENOMEM; return false; }
    size_t n = fread(data, 1, sz, f);
    fclose(f);
    if(n != sz){ free(data); return false; }
    data[sz] = '\0';

    // Replace existing buffer
    free(b->data);
    b->data = data;
    b->len  = sz;
    b->cap  = sz + 1;
    return true;
}

bool buf_save_file(buffer_t *b, const char *path){
    FILE *f = fopen(path, "wb");
    if(!f) return false;
    size_t n = fwrite(b->data, 1, b->len, f);
    int err = ferror(f);
    fclose(f);
    return (err == 0 && n == b->len);
}
