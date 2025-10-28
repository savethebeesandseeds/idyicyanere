#include "diff.h"

// Minimal unified-diff applier for a single file. Supports multiple hunks.
// Strategy: split original into lines; parse hunks; rebuild output.
static char* xstrndup(const char *s, size_t n){ char *p = (char*)malloc(n+1); if(!p) return NULL; memcpy(p,s,n); p[n]=0; return p; }
typedef struct { char **v; size_t n; } lines_t;

static lines_t split_lines(const char *s){
    lines_t L={0};
    size_t cap=128; L.v = malloc(sizeof(char*)*cap);
    const char *p=s, *q=s;
    while(*q){
        if(*q=='\n'){ size_t len=q-p; char *ln=malloc(len+2);
            memcpy(ln,p,len); ln[len]='\n'; ln[len+1]=0;
            if(L.n==cap){ cap*=2; L.v=realloc(L.v,sizeof(char*)*cap); }
            L.v[L.n++]=ln; p=q+1;
        }
        q++;
    }
    // last line (maybe no trailing newline)
    if(q!=p){ size_t len=q-p; char *ln=malloc(len+1); memcpy(ln,p,len); ln[len]=0;
        if(L.n==cap){ cap*=2; L.v=realloc(L.v,sizeof(char*)*cap); }
        L.v[L.n++]=ln;
    }
    return L;
}
static void free_lines(lines_t *L){ for(size_t i=0;i<L->n;i++) free(L->v[i]); free(L->v); }

static bool parse_hunk_header(const char *s, long *o_start,long *o_len,long *n_start,long *n_len){
    // @@ -oldStart,oldLen +newStart,newLen @@
    int m=sscanf(s,"@@ -%ld,%ld +%ld,%ld @@", o_start,o_len,n_start,n_len);
    if(m==4) return true;
    // single-line form like @@ -12 +12 @@
    m=sscanf(s,"@@ -%ld +%ld @@", o_start, n_start);
    if(m==2){ *o_len=1; *n_len=1; return true; }
    return false;
}

bool apply_unified_diff(const char *orig, const char *diff,
                        char **out, char **errmsg)
{
    if(errmsg) *errmsg=NULL;
    // Find first hunk header; ignore metadata lines ---/+++
    const char *p = strstr(diff, "@@");
    if(!p){ // empty diff: just clone
        *out = strdup(orig); return true;
    }
    lines_t O = split_lines(orig);

    // Build output lines progressively
    size_t cap = O.n + 1024; size_t on=0;
    char **OV = malloc(sizeof(char*)*cap);

    size_t oidx = 0; // current index in original

    const char *cur = diff;
    while((cur = strstr(cur, "@@"))){
        // Extract header line
        const char *eol = strchr(cur, '\n'); if(!eol) eol = cur + strlen(cur);
        size_t hlen = (size_t)(eol - cur);
        char *hdr = strndup(cur, hlen); // keep until after parse for error context

        long o_start=0,o_len=0,n_start=0,n_len=0;
        bool ok = parse_hunk_header(hdr, &o_start,&o_len,&n_start,&n_len);
        if(!ok){ if(errmsg){ asprintf(errmsg, "Malformed hunk header: %.*s", (int)hlen, cur); } free(hdr); goto fail; }
        free(hdr);

        // Convert to 0-based
        long oidx_target = o_start - 1;

        // Copy unchanged lines up to hunk start
        while(oidx < (size_t)oidx_target && oidx < O.n){
            OV[on++] = strdup(O.v[oidx++]);
            if(on==cap){ cap*=2; OV = realloc(OV, sizeof(char*)*cap); }
        }

        // Now parse hunk body
        const char *body = eol + ((*eol)=='\n'?1:0);
        const char *next = strstr(body, "@@");
        const char *bend = next ? next : diff + strlen(diff);

        // Apply +/-/ space
        const char *bp=body;
        while(bp < bend){
            const char *nl = memchr(bp, '\n', (size_t)(bend-bp));
            size_t len = nl ? (size_t)(nl-bp) : (size_t)(bend-bp);
            if(len==0 && bp==bend) break;
            char tag = *bp;
            const char *txt = bp+1;
            if(tag==' '){
                // context: must match original
                if(oidx >= O.n){
                    if(errmsg) asprintf(errmsg, "Context beyond EOF (orig_idx=%zu, orig_lines=%zu, hunk -%ld,%ld +%ld,%ld)",
                                        (size_t)oidx, O.n, o_start,o_len,n_start,n_len);
                    goto fail;
                }
                // Optionally verify match—skip for brevity
                OV[on++] = strdup(O.v[oidx++]);
            }else if(tag=='-'){
                // deletion: skip a line of original
                if(oidx >= O.n){ if(errmsg) asprintf(errmsg, "Delete beyond EOF (orig_idx=%zu, orig_lines=%zu, hunk -%ld,%ld +%ld,%ld)", (size_t)oidx, O.n, o_start,o_len,n_start,n_len); goto fail; }
                oidx++;
            }else if(tag=='+'){
                size_t tlen = (len>0)? (len-1) : 0; // exclude '+' prefix
                char *ins = xstrndup(txt, tlen);
                // Re-add newline to keep line semantics
                char *ins2 = NULL; asprintf(&ins2, "%s\n", ins?ins:"");
                free(ins);
                OV[on++] = ins2;
            }else if(tag=='\\'){
                // e.g., "\ No newline at end of file" → ignore
            }
            if(on==cap){ cap*=2; OV=realloc(OV,sizeof(char*)*cap); }
            if(!nl) break;
            bp = nl+1;
        }
        cur = bend;
    }
    // Copy remaining original
    while(oidx < O.n){ OV[on++] = strdup(O.v[oidx++]); if(on==cap){cap*=2; OV=realloc(OV,sizeof(char*)*cap);} }

    // Stitch result
    size_t total=0; for(size_t i=0;i<on;i++) total += strlen(OV[i]);
    char *res = malloc(total+1), *w=res;
    for(size_t i=0;i<on;i++){ size_t L=strlen(OV[i]); memcpy(w,OV[i],L); w+=L; }
    *w=0; *out=res;

    for(size_t i=0;i<on;i++){ free(OV[i]); }
    free(OV);
    free_lines(&O);
    return true;

fail:
    for(size_t i=0;i<on;i++){ free(OV[i]); }
    free(OV);
    free_lines(&O);
    return false;
}
