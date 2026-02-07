#include "idy.h"
#include "preview.h"
#include "sha256.h"
#include <time.h>
#include <stdarg.h>

// --- small helpers (local) ---

static char* xstrdup(const char *s){ if(!s) return NULL; size_t n=strlen(s)+1; char *p=(char*)malloc(n); if(p) memcpy(p,s,n); return p; }

static char* xstrndup(const char *s, size_t n){
    char *p = (char*)malloc(n+1);
    if(!p) return NULL;
    memcpy(p,s,n); p[n]=0; return p;
}

static void appendf(char **dst, const char *fmt, ...){
    va_list ap; va_start(ap, fmt);
    char *add=NULL; vasprintf(&add, fmt, ap); va_end(ap);
    if(!add) return;
    if(!*dst){ *dst = add; }
    else {
        size_t a=strlen(*dst), b=strlen(add);
        *dst = (char*)realloc(*dst, a+b+1);
        memcpy(*dst + a, add, b+1);
        free(add);
    }
}

static char *read_entire_file(const char *path, size_t *out_bytes, int *out_lines){
    FILE *f = fopen(path,"rb");
    if(!f) return NULL;
    if(fseek(f,0,SEEK_END)!=0){ fclose(f); return NULL; }
    long szl = ftell(f);
    if(szl < 0){ fclose(f); return NULL; }
    size_t sz = (size_t)szl;
    if(fseek(f,0,SEEK_SET)!=0){ fclose(f); return NULL; }
    char *buf = (char*)malloc(sz+1);
    if(!buf){ fclose(f); return NULL; }
    size_t n = fread(buf,1,sz,f); fclose(f);
    if(n != sz){ free(buf); return NULL; }
    buf[sz]=0;
    if(out_bytes) *out_bytes = sz;
    if(out_lines){
        int lines = 0;
        for(size_t i=0;i<sz;i++) if(buf[i]=='\n') lines++;
        if(sz==0 || buf[sz-1] != '\n') lines++; // last partial line
        *out_lines = lines;
    }
    return buf;
}

static const char* fence_lang_for(const char *filename){
    const char *dot = strrchr(filename,'.');
    if(!dot) return "";
    if(!strcmp(dot,".c")||!strcmp(dot,".h")) return "c";
    if(!strcmp(dot,".cpp")||!strcmp(dot,".hpp")||!strcmp(dot,".cc")) return "cpp";
    if(!strcmp(dot,".py")) return "python";
    if(!strcmp(dot,".json")) return "json";
    if(!strcmp(dot,".md")) return "md";
    if(!strcmp(dot,".sh")) return "bash";
    if(!strcmp(dot,".tex")) return "tex";
    return "";
}

// --- public API ---

char* preview_build(const char *cwd, char **paths, int count, int *out_lines){
    char *out=NULL;

    // Header
    time_t now = time(NULL); struct tm tm; localtime_r(&now,&tm);
    char tbuf[64]; strftime(tbuf,sizeof(tbuf), "%Y-%m-%d %H:%M:%S %Z", &tm);
    appendf(&out, "# Multi-project export\n");
    appendf(&out, "# Roots:\n#   - %s\n", cwd ? cwd : "(unknown)");
    appendf(&out, "# Date: %s\n", tbuf);
    appendf(&out, "# Script: idyicyanere ctx-preview v0.1\n\n");
    appendf(&out, "## Root: %s\n\n", cwd ? cwd : "(unknown)");

    for(int i=0;i<count;i++){
        const char *path = paths[i];
        size_t bytes=0; int lines=0;
        char *buf = read_entire_file(path, &bytes, &lines);
        if(!buf){
            appendf(&out, "===== FILE: %s (unreadable) =====\n\n", path?path:"(null)");
            continue;
        }
        char shahex[65]; sha256_hex((const unsigned char*)buf, bytes, shahex);
        const char *lang = fence_lang_for(path);
        appendf(&out, "===== FILE: %s (bytes=%zu, lines=%d, sha256=%s) =====\n", path, bytes, lines, shahex);
        appendf(&out, "```%s\n", lang);
        appendf(&out, "%s", buf);
        if(bytes==0 || buf[bytes-1] != '\n') appendf(&out, "\n");
        appendf(&out, "```\n\n");
        free(buf);
    }

    // Count lines for scrolling
    if(out_lines){
        int c=0; for(const char *p=out; p && *p; ++p) if(*p=='\n') c++;
        *out_lines = c;
    }
    return out ? out : xstrdup("");
}
