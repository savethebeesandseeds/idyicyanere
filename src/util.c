#include "idy.h"
void buf_init(buffer_t *b){ b->data=NULL; b->len=0; b->cap=0; }
void buf_free(buffer_t *b){ free(b->data); b->data=NULL; b->len=b->cap=0; }

static bool resize(buffer_t *b, size_t need){
    if(need <= b->cap) return true;
    size_t ncap = (b->cap? b->cap*2:4096);
    while(ncap < need) ncap*=2;
    char *p = realloc(b->data, ncap);
    if(!p) return false;
    b->data = p; b->cap = ncap;
    return true;
}

bool buf_load_file(buffer_t *b, const char *path){
    FILE *f = fopen(path, "rb"); if(!f) return false;
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f,0,SEEK_SET);
    if(n<0) { fclose(f); return false; }
    if(!resize(b, (size_t)n+1)){ fclose(f); return false; }
    size_t r = fread(b->data,1,(size_t)n,f);
    fclose(f);
    b->len=r; b->data[b->len]=0;
    return true;
}

bool buf_save_file(buffer_t *b, const char *path){
    FILE *f = fopen(path, "wb"); if(!f) return false;
    size_t w = fwrite(b->data,1,b->len,f);
    fclose(f);
    return w==b->len;
}
