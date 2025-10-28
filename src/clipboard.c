#include "idy.h"
#include "clipboard.h"
#include <string.h>
#include <stdlib.h>
#include <stdio.h>

/* ==== Local helpers: OSC-52 encoder ==== */

static char* b64_encode(const unsigned char *in, size_t len){
    static const char t[]="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t outlen = 4*((len+2)/3);
    char *out = (char*)malloc(outlen+1); if(!out) return NULL;
    size_t i=0, j=0;
    while(i<len){
        unsigned a = in[i++];
        unsigned b = (i<len) ? in[i++] : 0;
        unsigned c = (i<len) ? in[i++] : 0;
        unsigned triple = (a<<16) | (b<<8) | c;
        out[j++] = t[(triple>>18)&0x3F];
        out[j++] = t[(triple>>12)&0x3F];
        out[j++] = (i-1>len) ? '=' : t[(triple>>6)&0x3F];
        out[j++] = (i>len)   ? '=' : t[triple&0x3F];
    }
    size_t mod = len % 3;
    if(mod==1){ out[outlen-2]='='; out[outlen-1]='='; }
    else if(mod==2){ out[outlen-1]='='; }
    out[outlen]=0; return out;
}

static void osc52_set_clipboard(const char *s){
    if(!s) s="";
    size_t n = strlen(s);
    if(n > 64*1024) n = 64*1024; // spec-ish: keep payload reasonable
    char *b64 = b64_encode((const unsigned char*)s, n);
    if(!b64) return;
    fprintf(stdout, "\033]52;c;%s\007", b64);
    fflush(stdout);
    free(b64);
}

/* ==== Internal storage ==== */

static char *g_clipboard = NULL;

void clipboard_set(const char *s){
    free(g_clipboard);
    g_clipboard = s ? strdup(s) : NULL;
    osc52_set_clipboard(g_clipboard ? g_clipboard : "");
}

const char* clipboard_get(void){
    return g_clipboard;
}

void clipboard_free(void){
    free(g_clipboard);
    g_clipboard = NULL;
}
