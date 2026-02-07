#include "diff.h"

#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stdarg.h>
#include <ctype.h>

// -------------------- small helpers --------------------
static char* xmalloc(size_t n) {
    char *p = (char*)malloc(n);
    return p;
}
static char* xstrdup(const char *s){
    size_t n = strlen(s);
    char *p = (char*)malloc(n+1);
    if (!p) return NULL;
    memcpy(p, s, n+1);
    return p;
}
static char* xstrndup(const char *s, size_t n){
    char *p = (char*)malloc(n+1);
    if (!p) return NULL;
    memcpy(p, s, n);
    p[n] = '\0';
    return p;
}
static void set_err(char **errmsg, const char *fmt, ...) {
    if (!errmsg) return;
    va_list ap; va_start(ap, fmt);
    int need = vsnprintf(NULL, 0, fmt, ap);
    va_end(ap);
    if (need < 0) return;
    char *buf = (char*)malloc((size_t)need + 1);
    if (!buf) return;
    va_start(ap, fmt);
    vsnprintf(buf, (size_t)need + 1, fmt, ap);
    va_end(ap);
    *errmsg = buf;
}
static size_t linelen_no_eol(const char *s){
    size_t L = strlen(s);
    if (L && s[L-1] == '\n') { L--; }
    if (L && s[L-1] == '\r') { L--; }
    return L;
}

// -------------------- line splitting --------------------
typedef struct { char **v; size_t n, cap; } lines_t;

static void lines_init(lines_t *L) { L->v=NULL; L->n=0; L->cap=0; }
static void lines_push(lines_t *L, char *line){
    if (L->n == L->cap){
        size_t newcap = L->cap ? L->cap*2 : 128;
        char **nv = (char**)realloc(L->v, newcap*sizeof(char*));
        if (!nv) return; // let it crash later if OOM
        L->v = nv; L->cap = newcap;
    }
    L->v[L->n++] = line;
}
static lines_t split_lines(const char *s){
    lines_t L; lines_init(&L);
    const char *p = s, *q = s;
    while (*q){
        if (*q == '\n'){
            size_t len = (size_t)(q - p);
            char *ln = (char*)malloc(len + 2);
            if (!ln) return L;
            memcpy(ln, p, len);
            ln[len] = '\n';
            ln[len+1] = '\0';
            lines_push(&L, ln);
            p = q + 1;
        }
        q++;
    }
    if (q != p){
        size_t len = (size_t)(q - p);
        char *ln = (char*)malloc(len + 1);
        if (!ln) return L;
        memcpy(ln, p, len);
        ln[len] = '\0';
        lines_push(&L, ln);
    }
    return L;
}
static void free_lines(lines_t *L){
    for (size_t i=0;i<L->n;i++) free(L->v[i]);
    free(L->v);
    L->v=NULL; L->n=L->cap=0;
}

// -------------------- unified diff parsing --------------------

// Find next hunk header that starts at the beginning of a line.
static const char* find_next_hunk(const char *start){
    const char *p = start;
    if (!p) return NULL;
    while ((p = strstr(p, "@@"))){
        // must be line-start: beginning or preceded by '\n'
        if (p == start || p[-1] == '\n'){
            return p;
        }
        p += 2;
    }
    return NULL;
}

// Parse a hunk header in either form:
//   @@ -oldStart,oldLen +newStart,newLen @@
//   @@ -oldStart +newStart @@               (implies lengths are 1)
static int parse_hunk_header(const char *hdr_line,
                             long *o_start,long *o_len,long *n_start,long *n_len)
{
    // Extract up to end-of-line into a small buffer
    const char *eol = strchr(hdr_line, '\n');
    size_t hlen = eol ? (size_t)(eol - hdr_line) : strlen(hdr_line);
    char *buf = xstrndup(hdr_line, hlen);

    // Normalize spaces inside the header to ease parsing.
    // We’ll accept the canonical form only (space after "@@").
    int ok = 0;
    if (buf && strncmp(buf, "@@ ", 3) == 0){
        const char *p = buf + 3;
        if (*p == '-') p++; else goto done;

        char *end = NULL;
        long os = strtol(p, &end, 10);
        if (end == p) goto done;

        long ol = 1; // default if short form
        if (*end == ','){
            p = end + 1;
            ol = strtol(p, &end, 10);
            if (end == p) goto done;
        }
        if (*end != ' ') goto done;
        p = end + 1;

        if (*p != '+') goto done;
        p++;

        long ns = strtol(p, &end, 10);
        if (end == p) goto done;

        long nl = 1; // default if short form
        if (*end == ','){
            p = end + 1;
            nl = strtol(p, &end, 10);
            if (end == p) goto done;
        }
        // Allow optional trailing " @@" and any trailing context text
        while (*end == ' ') end++;
        if (strncmp(end, "@@", 2) != 0) goto done;

        *o_start = os; *o_len = ol; *n_start = ns; *n_len = nl;
        ok = 1;
    }
done:
    free(buf);
    return ok;
}

// Compare a patch line's text (no trailing newline in `patch_txt_len`) with
// an original line. Comparison ignores original's trailing '\n' or '\r\n'.
static int patch_matches_orig(const char *patch_txt, size_t patch_txt_len,
                              const char *orig_line)
{
    size_t oln = linelen_no_eol(orig_line);
    if (oln != patch_txt_len) return 0;
    return (memcmp(orig_line, patch_txt, patch_txt_len) == 0);
}

bool apply_unified_diff(const char *orig, const char *diff,
                        char **out, char **errmsg)
{
    if (errmsg) *errmsg = NULL;
    if (!orig || !diff || !out){
        set_err(errmsg, "Invalid arguments");
        return false;
    }

    lines_t O = split_lines(orig);

    // Prepare output line buffer
    size_t cap = (O.n ? O.n : 1) + 16;
    char **OV = (char**)malloc(cap * sizeof(char*));
    size_t on = 0;
    size_t oidx = 0; // current index in original

    // Find the first hunk; ignore any '---/+++' headers above it
    const char *cur = find_next_hunk(diff);
    if (!cur){
        // No hunks → empty diff → output equals input
        *out = xstrdup(orig);
        free_lines(&O);
        free(OV);
        return true;
    }

    while (cur){
        // Header line
        const char *hdr_eol = strchr(cur, '\n');
        const char *after_hdr = hdr_eol ? (hdr_eol + 1) : (cur + strlen(cur));

        long o_start=0, o_len=0, n_start=0, n_len=0;
        if (!parse_hunk_header(cur, &o_start, &o_len, &n_start, &n_len)){
            set_err(errmsg, "Malformed hunk header: %.30s", cur);
            goto fail;
        }

        // Convert 1-based line number to 0-based index
        long target = (o_start > 0) ? (o_start - 1) : 0;

        // Copy unchanged original lines up to the hunk start
        while ((long)oidx < target && oidx < O.n){
            if (on == cap){ cap *= 2; OV = (char**)realloc(OV, cap*sizeof(char*)); }
            OV[on++] = xstrdup(O.v[oidx++]);
        }

        // Hunk body is from after_hdr up to (but not including) the next header
        const char *next_hdr = find_next_hunk(after_hdr);
        const char *bend = next_hdr ? next_hdr : (diff + strlen(diff));

        const char *bp = after_hdr;
        while (bp < bend){
            const char *nl = memchr(bp, '\n', (size_t)(bend - bp));
            size_t linelen = nl ? (size_t)(nl - bp) : (size_t)(bend - bp);
            if (linelen == 0 && bp == bend) break;

            char tag = *bp;
            const char *txt = bp + 1;
            size_t txtlen = (linelen >= 1) ? (linelen - 1) : 0;

            // Detect the special marker on the *next* line:
            //   \ No newline at end of file
            // If present after '+' or '-' we should treat the current line as not ending with '\n'
            int add_newline = 1;
            const char *n2 = nl ? nl + 1 : bend;
            if ((tag == '+' || tag == '-') && n2 < bend){
                const char *n2nl = memchr(n2, '\n', (size_t)(bend - n2));
                size_t n2len = n2nl ? (size_t)(n2nl - n2) : (size_t)(bend - n2);
                if (n2len >= 28 && n2[0] == '\\' && n2[1] == ' '){
                    static const char *MARK = "No newline at end of file";
                    if (n2len >= 2 + strlen(MARK) &&
                        memcmp(n2+2, MARK, strlen(MARK)) == 0){
                        add_newline = 0;
                        // we will also skip this marker line by advancing bp past it
                        // after processing the current '+'/'-' line
                    }
                }
            }

            if (tag == ' '){
                // Context: must match original
                if (oidx >= O.n){
                    set_err(errmsg, "Context beyond EOF at original line %zu", oidx+1);
                    goto fail;
                }
                if (!patch_matches_orig(txt, txtlen, O.v[oidx])){
                    set_err(errmsg, "Context mismatch at original line %zu", oidx+1);
                    goto fail;
                }
                if (on == cap){ cap *= 2; OV = (char**)realloc(OV, cap*sizeof(char*)); }
                OV[on++] = xstrdup(O.v[oidx]);
                oidx++;
            } else if (tag == '-'){
                // Deletion: must match original, but do not emit
                if (oidx >= O.n){
                    set_err(errmsg, "Delete beyond EOF at original line %zu", oidx+1);
                    goto fail;
                }
                if (!patch_matches_orig(txt, txtlen, O.v[oidx])){
                    set_err(errmsg, "Delete mismatch at original line %zu", oidx+1);
                    goto fail;
                }
                oidx++;
            } else if (tag == '+'){
                // Insertion: write new text (+ optional newline)
                size_t outlen = txtlen + (add_newline ? 1 : 0);
                char *ins = (char*)malloc(outlen + 1);
                if (!ins){ set_err(errmsg, "Out of memory"); goto fail; }
                memcpy(ins, txt, txtlen);
                if (add_newline) ins[txtlen] = '\n';
                ins[outlen] = '\0';
                if (on == cap){ cap *= 2; OV = (char**)realloc(OV, cap*sizeof(char*)); }
                OV[on++] = ins;
            } else if (tag == '\\'){
                // "\ No newline at end of file" — already handled via look-ahead; skip
            } else {
                set_err(errmsg, "Unexpected hunk line prefix '%c'", tag);
                goto fail;
            }

            // Advance to next line
            if (!nl){ bp = bend; }
            else {
                bp = nl + 1;
                // If we consumed a '+' or '-' followed by the special marker line, skip marker
                if ((tag == '+' || tag == '-') && bp < bend && *bp == '\\'){
                    const char *nnl = memchr(bp, '\n', (size_t)(bend - bp));
                    bp = nnl ? nnl + 1 : bend;
                }
            }
        }

        cur = next_hdr;
    }

    // Copy any remaining original lines after the last hunk
    while (oidx < O.n){
        if (on == cap){ cap *= 2; OV = (char**)realloc(OV, cap*sizeof(char*)); }
        OV[on++] = xstrdup(O.v[oidx++]);
    }

    // Concatenate output lines
    size_t total = 0;
    for (size_t i=0;i<on;i++) total += strlen(OV[i]);
    char *res = (char*)malloc(total + 1);
    if (!res){ set_err(errmsg, "Out of memory"); goto fail; }
    char *w = res;
    for (size_t i=0;i<on;i++){
        size_t L = strlen(OV[i]);
        memcpy(w, OV[i], L);
        w += L;
    }
    *w = '\0';
    *out = res;

    for (size_t i=0;i<on;i++) free(OV[i]);
    free(OV);
    free_lines(&O);
    return true;

fail:
    if (OV){
        for (size_t i=0;i<on;i++) free(OV[i]);
        free(OV);
    }
    free_lines(&O);
    return false;
}
