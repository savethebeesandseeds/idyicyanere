#include "tui.h"
#include "stream.h"  // for IDY_PROMPT_MAX_ORIG / IDY_PROMPT_MAX_CTX
#include <string.h>
#include <stdlib.h>
#include <ctype.h>

/* ===================== LOG VIEW (Left: logs, Right: scrollable Config) =====================

   Left:
   - Sanitized + wrapped log lines with tail-follow (scroll_lines == 0).
   - Scrollable via ↑/↓ (1 line), PgUp/PgDn (page), Home (oldest), End (newest).
   - Mouse wheel over the LEFT pane scrolls too.

   Right:
   - Static controls at the top (filter keys, instructions, shortcuts).
   - Config section moved BELOW; it is independently scrollable
     via mouse wheel over the RIGHT pane (rhs_scroll).

   Env knobs affecting rendering:
   - IDY_LOG_TABSTOP (default 4) : expand tabs in logs to N spaces.
*/

/* ---------- Helpers for Config rendering ---------- */

static char* str_trimdup(const char *s){
    if(!s) return NULL;
    const char *p = s;
    while(*p && isspace((unsigned char)*p)) p++;
    const char *e = p + strlen(p);
    while(e>p && isspace((unsigned char)e[-1])) e--;
    size_t n=(size_t)(e-p);
    char *out=(char*)malloc(n+1); if(!out) return NULL;
    memcpy(out,p,n); out[n]=0; return out;
}

static const char* getenv_raw(const char *k){
    const char *v = getenv(k);
    return v && *v ? v : NULL;
}

static char* getenv_clean(const char *k){
    const char *raw = getenv_raw(k);
    if(!raw) return NULL;
    char *t = str_trimdup(raw);
    if(!t) return NULL;
    for(char *p=t; *p; ++p){
        if(*p=='\r' || *p=='\n') *p=' ';
    }
    return t;
}

static int str_ieq(const char *a, const char *b){
    if(!a||!b) return 0;
    while(*a && *b){
        if(tolower((unsigned char)*a) != tolower((unsigned char)*b)) return 0;
        ++a; ++b;
    }
    return *a==0 && *b==0;
}

static int parse_truthy_env(const char *k, int *out_is_set){
    const char *v = getenv_raw(k);
    if(out_is_set) *out_is_set = (v && *v) ? 1 : 0;
    if(!v) return 0;
    char *t = str_trimdup(v);
    if(!t || !*t){ free(t); return 0; }
    int yes = str_ieq(t,"1") || str_ieq(t,"true") || str_ieq(t,"yes") || str_ieq(t,"on") || str_ieq(t,"y");
    free(t);
    return yes;
}

static char* mask_api_key(const char *v){
    if(!v || !*v) return NULL;
    size_t n = strlen(v);
    if(n <= 8){
        char *out = strdup("***"); return out?out:NULL;
    }
    size_t keep_head = 4, keep_tail = 4;
    char *out = (char*)malloc(n + 1);
    if(!out) return NULL;
    memcpy(out, v, keep_head);
    memset(out + keep_head, '*', (n > keep_head + keep_tail) ? (n - keep_head - keep_tail) : 0);
    if(n >= keep_tail) memcpy(out + (n - keep_tail), v + (n - keep_tail), keep_tail);
    out[n] = 0;
    return out;
}

/* Pretty-print bytes with IEC units, e.g., "64.0 KiB (65536 B)". */
static void fmt_bytes_iec(size_t v, char *out, size_t outsz){
    const char *u[] = {"B","KiB","MiB","GiB","TiB"};
    int idx = 0;
    double dv = (double)v;
    while(dv >= 1024.0 && idx < 4){ dv /= 1024.0; idx++; }
    if(idx == 0){
        snprintf(out, outsz, "%zu B", v);
    } else {
        snprintf(out, outsz, "%.1f %s (%zu B)", dv, u[idx], v);
    }
}

/* ---------- Sanitization for LEFT logs ---------- */

static int env_tabstop(void){
    const char *s = getenv("IDY_LOG_TABSTOP");
    if(!s || !*s) return 4;
    int v = atoi(s);
    if(v < 1) v = 1;
    if(v > 16) v = 16;
    return v;
}

/* Strip ANSI CSI sequences and normalize CR/TAB/control chars. */
static char* sanitize_log_copy(const char *s){
    if(!s) return strdup("");
    size_t n = strlen(s);
    int tabstop = env_tabstop();
    size_t cap = n * (size_t)tabstop + 1;
    char *out = (char*)malloc(cap);
    if(!out) return strdup("");

    const unsigned char *p = (const unsigned char*)s;
    char *w = out;
    int in_esc = 0, in_csi = 0;

    for(size_t i=0;i<n;i++){
        unsigned char ch = p[i];

        if(ch == 0x1B){ in_esc = 1; in_csi = 0; continue; }
        if(in_esc){
            if(ch == '['){ in_csi = 1; continue; }
            in_esc = 0; in_csi = 0; continue;
        }
        if(in_csi){
            if(ch >= '@' && ch <= '~'){ in_esc = 0; in_csi = 0; }
            continue;
        }

        if(ch == '\r'){
            if(!(i+1 < n && p[i+1] == '\n')) *w++ = '\n';
            continue;
        }
        if(ch == '\n'){ *w++ = '\n'; continue; }
        if(ch == '\t'){ for(int k=0;k<tabstop;k++) *w++ = ' '; continue; }
        if(ch < 32){ continue; }
        *w++ = (char)ch;
    }
    *w = 0;
    return out;
}

/* ---------- Wrapping & Drawing for LEFT logs ---------- */

static int wrapped_rows_count(const char *san, int cols, int eff_prefix){
    if(cols < 1) cols = 1;
    if(eff_prefix < 0) eff_prefix = 0;
    int first_w = cols - eff_prefix; if(first_w < 1) first_w = 1;
    int cont_w  = cols;

    int rows = 0;
    const char *p = san ? san : "";
    int is_first_visual = 1;

    for(;;){
        const char *nl = strchr(p, '\n');
        size_t len = nl ? (size_t)(nl - p) : strlen(p);
        size_t rem = len;

        int cur_w = is_first_visual ? first_w : cont_w;

        if(rem == 0){
            rows++;
            is_first_visual = 0;
        } else {
            while(rem > 0){
                size_t take = rem > (size_t)cur_w ? (size_t)cur_w : rem;
                rows++;
                rem -= take;
                cur_w = cont_w;
                is_first_visual = 0;
            }
        }
        if(!nl) break;
        p = nl + 1;
    }
    return rows;
}

static int draw_wrapped_entry(WINDOW *w, int y, int x, int cols,
                              const char *prefix, int eff_prefix, int color_pair,
                              const char *san, int skip_rows, int max_rows)
{
    if(max_rows <= 0) return 0;

    if(cols < 1) cols = 1;
    if(eff_prefix < 0) eff_prefix = 0;
    if(eff_prefix > cols - 1) eff_prefix = cols - 1;

    int first_w = cols - eff_prefix; if(first_w < 1) first_w = 1;
    int cont_w  = cols;

    const char *p = san ? san : "";
    int drawn = 0;
    int is_first_visual = 1;

    for(;;){
        const char *nl = strchr(p, '\n');
        size_t len = nl ? (size_t)(nl - p) : strlen(p);
        size_t rem = len;
        size_t off = 0;

        if(rem == 0){
            if(skip_rows > 0){ skip_rows--; }
            else if(drawn < max_rows){
                if(color_pair) wattron(w, COLOR_PAIR(color_pair));
                if(is_first_visual){
                    if(eff_prefix > 0) mvwaddnstr(w, y + drawn, x, prefix, eff_prefix);
                }
                if(color_pair) wattroff(w, COLOR_PAIR(color_pair));
                drawn++;
            }
            is_first_visual = 0;
        } else {
            int cur_w = is_first_visual ? first_w : cont_w;
            while(rem > 0){
                size_t take = rem > (size_t)cur_w ? (size_t)cur_w : rem;
                if(skip_rows > 0){
                    skip_rows--;
                } else if(drawn < max_rows){
                    if(color_pair) wattron(w, COLOR_PAIR(color_pair));
                    if(is_first_visual){
                        if(eff_prefix > 0) mvwaddnstr(w, y + drawn, x, prefix, eff_prefix);
                        mvwaddnstr(w, y + drawn, x + eff_prefix, p + off, (int)take);
                    } else {
                        mvwaddnstr(w, y + drawn, x, p + off, (int)take);
                    }
                    if(color_pair) wattroff(w, COLOR_PAIR(color_pair));
                    drawn++;
                }
                off += take; rem -= take;
                cur_w = cont_w;
                is_first_visual = 0;
                if(drawn >= max_rows) break;
            }
            while(rem > 0 && skip_rows > 0){
                size_t take = rem > (size_t)cur_w ? (size_t)cur_w : rem;
                skip_rows--; rem -= take;
                cur_w = cont_w;
                is_first_visual = 0;
            }
        }
        if(drawn >= max_rows) break;
        if(!nl) break;
        p = nl + 1;
    }
    return drawn;
}

/* ---------- Helpers for RIGHT Config: richer line buffer ---------- */

typedef enum { LB_PLAIN, LB_RULE, LB_KV } lb_type_t;

typedef struct {
    lb_type_t type;
    char *text;     // for PLAIN/RULE
    char *key;      // for KV
    char *value;    // for KV
} lb_line_t;

typedef struct {
    lb_line_t *v;
    int n, cap;
} linebuf_t;

static void lb_init(linebuf_t *lb){ lb->v=NULL; lb->n=0; lb->cap=0; }
static void lb_free(linebuf_t *lb){
    for(int i=0;i<lb->n;i++){
        free(lb->v[i].text);
        free(lb->v[i].key);
        free(lb->v[i].value);
    }
    free(lb->v); lb->v=NULL; lb->n=lb->cap=0;
}

static void lb_push_plain(linebuf_t *lb, const char *text){
    if(lb->n == lb->cap){ lb->cap = lb->cap ? lb->cap*2 : 64; lb->v = (lb_line_t*)realloc(lb->v, sizeof(lb_line_t)*lb->cap); }
    lb->v[lb->n++] = (lb_line_t){ .type=LB_PLAIN, .text=text?strdup(text):strdup("") };
}

static void lb_push_rule(linebuf_t *lb){
    if(lb->n == lb->cap){ lb->cap = lb->cap ? lb->cap*2 : 64; lb->v = (lb_line_t*)realloc(lb->v, sizeof(lb_line_t)*lb->cap); }
    lb->v[lb->n++] = (lb_line_t){ .type=LB_RULE };
}

static void lb_push_kv(linebuf_t *lb, const char *k, const char *v){
    if(lb->n == lb->cap){ lb->cap = lb->cap ? lb->cap*2 : 64; lb->v = (lb_line_t*)realloc(lb->v, sizeof(lb_line_t)*lb->cap); }
    lb->v[lb->n++] = (lb_line_t){ .type=LB_KV, .key=k?strdup(k):strdup(""), .value=v?strdup(v):strdup("(unset)") };
}

/* Build Config entries; rendering (colors & clipping) happens later. */
static void build_config_lines(linebuf_t *out){
    lb_init(out);

    // [OpenAI]
    lb_push_plain(out, "[OpenAI]");
    char *v_base  = getenv_clean("OPENAI_BASE_URL");
    char *v_model = getenv_clean("OPENAI_MODEL");
    char *v_key_masked = NULL; { const char *raw = getenv_raw("OPENAI_API_KEY"); v_key_masked = mask_api_key(raw); }
    lb_push_kv(out, "OPENAI_BASE_URL", v_base?v_base:"(unset/default)");
    lb_push_kv(out, "OPENAI_MODEL",    v_model?v_model:"(unset: gpt-4o-mini)");
    lb_push_kv(out, "OPENAI_API_KEY",  v_key_masked?v_key_masked:"(unset)");
    free(v_base); free(v_model); free(v_key_masked);

    // [Prompt limits]
    lb_push_plain(out, "");
    lb_push_plain(out, "[Prompt limits]");
    char *v_pmo = getenv_clean("IDY_PROMPT_MAX_ORIG");
    char *v_pmc = getenv_clean("IDY_PROMPT_MAX_CTX");
    lb_push_kv(out, "IDY_PROMPT_MAX_ORIG", v_pmo ? v_pmo : "(unset)");
    lb_push_kv(out, "IDY_PROMPT_MAX_CTX",  v_pmc ? v_pmc : "(unset)");
    {
        size_t eff_orig = idy_env_parse_size("IDY_PROMPT_MAX_ORIG", IDY_PROMPT_MAX_ORIG);
        size_t eff_ctx  = idy_env_parse_size("IDY_PROMPT_MAX_CTX",  IDY_PROMPT_MAX_CTX);
        char buf1[96], buf2[96];
        fmt_bytes_iec(eff_orig, buf1, sizeof(buf1));
        fmt_bytes_iec(eff_ctx,  buf2, sizeof(buf2));
        lb_push_kv(out, "prompt_max_orig (effective)", buf1);
        lb_push_kv(out, "prompt_max_ctx  (effective)", buf2);
    }
    free(v_pmo); free(v_pmc);

    // [TUI / Display]
    lb_push_plain(out, "");
    lb_push_plain(out, "[TUI / Display]");
    char *v_tree = getenv_clean("IDY_TREE_UNICODE");
    char *v_tab  = getenv_clean("IDY_LOG_TABSTOP");
    lb_push_kv(out, "IDY_TREE_UNICODE", v_tree?v_tree:"(unset: auto)");
    lb_push_kv(out, "IDY_LOG_TABSTOP",  v_tab?v_tab:"(unset: 4)");
    lb_push_kv(out, "unicode_tree (effective)", tui_unicode_tree_enabled() ? "enabled" : "disabled");
    free(v_tree); free(v_tab);

    // [Network / TLS]
    lb_push_plain(out, "");
    lb_push_plain(out, "[Network / TLS]");
    char *v_cainfo = getenv_clean("IDY_CAINFO");
    char *v_capath = getenv_clean("IDY_CAPATH");
    char *v_cabndl = getenv_clean("CURL_CA_BUNDLE");
    char *v_sslfile= getenv_clean("SSL_CERT_FILE");
    char *v_ssldir = getenv_clean("SSL_CERT_DIR");
    int insecure_set=0; int insecure = parse_truthy_env("IDY_CURL_INSECURE", &insecure_set);
    lb_push_kv(out, "IDY_CURL_INSECURE", insecure_set ? (insecure ? "1 (true)" : "0 (false)") : "(unset: secure)");
    lb_push_kv(out, "IDY_CAINFO", v_cainfo?v_cainfo:"(libcurl default)");
    lb_push_kv(out, "IDY_CAPATH", v_capath?v_capath:"(libcurl default)");
    lb_push_kv(out, "CURL_CA_BUNDLE", v_cabndl?v_cabndl:"(unset)");
    lb_push_kv(out, "SSL_CERT_FILE",  v_sslfile?v_sslfile:"(unset)");
    lb_push_kv(out, "SSL_CERT_DIR",   v_ssldir?v_ssldir:"(unset)");
    free(v_cainfo); free(v_capath); free(v_cabndl); free(v_sslfile); free(v_ssldir);

    // [Debug / Misc]
    lb_push_plain(out, "");
    lb_push_plain(out, "[Debug / Misc]");
    char *v_verbose = getenv_clean("IDY_CURL_VERBOSE");
    char *v_saveas  = getenv_clean("IDY_SAVE_AS");
    lb_push_kv(out, "IDY_CURL_VERBOSE", v_verbose?v_verbose:"(unset: 0)");
    {
        int verbose_set=0;
        int verbose_eff = parse_truthy_env("IDY_CURL_VERBOSE", &verbose_set);
        lb_push_kv(out, "curl_verbose (effective)",
                   verbose_set ? (verbose_eff ? "enabled" : "disabled") : "disabled (unset)");
    }
    lb_push_kv(out, "IDY_SAVE_AS", v_saveas?v_saveas:"(unset)");
    free(v_verbose); free(v_saveas);

    // Locale / TERM
    lb_push_plain(out, "");
    lb_push_plain(out, "[Environment]");
    char *v_lang = getenv_clean("LANG");
    char *v_term = getenv_clean("TERM");
    lb_push_kv(out, "LANG", v_lang?v_lang:"(unset)");
    lb_push_kv(out, "TERM", v_term?v_term:"(unset)");
    free(v_lang); free(v_term);
}

/* ---------- Main draw (left logs + right static + scrollable config) ---------- */

void tui_draw_logs(tui_t *t, log_level_t filter, const char *status, int *scroll_lines, int *rhs_scroll){
    // Left: logs
    werase(t->left);
    if(t->colors_ready) wattron(t->left, COLOR_PAIR(IDY_PAIR_BORDER));
    box(t->left,0,0);
    if(t->colors_ready) wattroff(t->left, COLOR_PAIR(IDY_PAIR_BORDER));

    // Right: static controls + scrollable Config
    werase(t->right);
    if(t->colors_ready) wattron(t->right, COLOR_PAIR(IDY_PAIR_BORDER));
    box(t->right,0,0);
    if(t->colors_ready) wattroff(t->right, COLOR_PAIR(IDY_PAIR_BORDER));

    log_entry_t *snap=NULL; size_t n=log_snapshot(filter, &snap);
    const int rowsL = getmaxy(t->left)-2;
    const int colsL = getmaxx(t->left)-2;
    const int x0 = 1;
    int y = 1;

    /* Total wrapped rows for scroll clamp (left) */
    size_t total_rows = 0;
    for(size_t i=0; i<n; ++i){
        const log_entry_t *e = &snap[i];
        struct tm tm; time_t sec = e->ts.tv_sec; localtime_r(&sec, &tm);
        char tsbuf[32]; strftime(tsbuf,sizeof(tsbuf),"%H:%M:%S",&tm);
        char prefix[64]; snprintf(prefix, sizeof(prefix), "[%s] %-5s ", tsbuf, log_level_name(e->level));
        int eff_prefix = (int)strlen(prefix);
        if(eff_prefix > colsL - 1) eff_prefix = colsL - 1;
        char *san = sanitize_log_copy(e->msg);
        total_rows += (size_t)wrapped_rows_count(san, colsL, eff_prefix);
        free(san);
    }
    int max_scroll = 0;
    if((int)total_rows > rowsL) max_scroll = (int)total_rows - rowsL;
    if(scroll_lines){
        if(*scroll_lines < 0) *scroll_lines = 0;
        if(*scroll_lines > max_scroll) *scroll_lines = max_scroll;
    }
    int scroll = scroll_lines ? *scroll_lines : 0;

    /* Determine starting index + intra-entry skip (left) */
    size_t start_idx = 0;
    int start_skip_rows = 0;
    int remaining = rowsL + scroll;
    if(remaining < 0) remaining = 0;

    for(ssize_t i=(ssize_t)n-1; i>=0; --i){
        const log_entry_t *e = &snap[i];
        struct tm tm; time_t sec = e->ts.tv_sec; localtime_r(&sec, &tm);
        char tsbuf[32]; strftime(tsbuf,sizeof(tsbuf),"%H:%M:%S",&tm);
        char prefix[64]; snprintf(prefix, sizeof(prefix), "[%s] %-5s ", tsbuf, log_level_name(e->level));
        int eff_prefix = (int)strlen(prefix);
        if(eff_prefix > colsL - 1) eff_prefix = colsL - 1;

        char *san = sanitize_log_copy(e->msg);
        int rows_for_e = wrapped_rows_count(san, colsL, eff_prefix);
        free(san);

        if(rows_for_e >= remaining){
            start_idx = (size_t)i;
            start_skip_rows = rows_for_e - remaining;
            break;
        } else {
            remaining -= rows_for_e;
            if(i==0){ start_idx = 0; start_skip_rows = 0; }
        }
    }

    if(t->colors_ready) wattron(t->left, COLOR_PAIR(IDY_PAIR_TEXT));
    // Draw forward from start_idx (left)
    for(size_t i=start_idx; i<n && y<=rowsL; ++i){
        const log_entry_t *e = &snap[i];
        struct tm tm; time_t sec = e->ts.tv_sec; localtime_r(&sec, &tm);
        char tsbuf[32]; strftime(tsbuf,sizeof(tsbuf),"%H:%M:%S",&tm);

        int pair=IDY_PAIR_TEXT;
        if(t->colors_ready){
            if(e->level==LOG_ERROR) pair=7;
            else if(e->level==LOG_WARN) pair=6;
            else if(e->level==LOG_INFO) pair=5;
            else if(e->level==LOG_DEBUG) pair=8;
            else if(e->level==LOG_TRACE) pair=9;
        }

        char prefix[64];
        snprintf(prefix, sizeof(prefix), "[%s] %-5s ", tsbuf, log_level_name(e->level));
        int eff_prefix = (int)strlen(prefix);
        if(eff_prefix > colsL - 1) eff_prefix = colsL - 1;

        char *san = sanitize_log_copy(e->msg);
        int avail = rowsL - (y - 1);
        int drawn = draw_wrapped_entry(t->left, y, x0, colsL,
                                       prefix, eff_prefix, pair,
                                       san,
                                       (i==start_idx)?start_skip_rows:0,
                                       avail);
        free(san);
        y += drawn;
        if(y > rowsL) break;
    }
    if(t->colors_ready) wattroff(t->left, COLOR_PAIR(IDY_PAIR_TEXT));
    wrefresh(t->left);

    /* -------- RIGHT PANE -------- */
    int rowsR = getmaxy(t->right)-2, colsR = getmaxx(t->right)-2;
    int cy = 1;

    // Static controls (titles and rules)
    if(t->colors_ready) wattron(t->right, COLOR_PAIR(IDY_PAIR_TITLE));
    mvwprintw(t->right, cy++, 2, "Log Options");
    if(t->colors_ready) wattroff(t->right, COLOR_PAIR(IDY_PAIR_TITLE));

    if(t->colors_ready) wattron(t->right, COLOR_PAIR(IDY_PAIR_BORDER));
    mvwhline(t->right, cy++, 1, ACS_HLINE, colsR);
    if(t->colors_ready) wattroff(t->right, COLOR_PAIR(IDY_PAIR_BORDER));

    if(t->colors_ready) wattron(t->right, COLOR_PAIR(IDY_PAIR_TEXT));
    mvwprintw(t->right, cy++, 2, "Current filter: %s", log_level_name(filter));
    mvwprintw(t->right, cy++, 2, "Press 1..5 to filter:");
    mvwprintw(t->right, cy++, 4, "[1] TRACE   [2] DEBUG   [3] INFO   [4] WARN   [5] ERROR");
    if(t->colors_ready) wattroff(t->right, COLOR_PAIR(IDY_PAIR_TEXT));

    if(t->colors_ready) wattron(t->right, COLOR_PAIR(IDY_PAIR_BORDER));
    mvwhline(t->right, cy++, 1, ACS_HLINE, colsR);
    if(t->colors_ready) wattroff(t->right, COLOR_PAIR(IDY_PAIR_BORDER));

    if(t->colors_ready) wattron(t->right, COLOR_PAIR(IDY_PAIR_TITLE));
    mvwprintw(t->right, cy++, 2, "Scrolling (Left logs)");
    if(t->colors_ready) wattroff(t->right, COLOR_PAIR(IDY_PAIR_TITLE));

    if(t->colors_ready) wattron(t->right, COLOR_PAIR(IDY_PAIR_TEXT));
    mvwprintw(t->right, cy++, 2, "Up/Down: line   PgUp/PgDn: page   Home/End: oldest/newest");
    mvwprintw(t->right, cy++, 2, "Mouse wheel over left pane");
    if(t->colors_ready) wattroff(t->right, COLOR_PAIR(IDY_PAIR_TEXT));

    if(t->colors_ready) wattron(t->right, COLOR_PAIR(IDY_PAIR_BORDER));
    mvwhline(t->right, cy++, 1, ACS_HLINE, colsR);
    if(t->colors_ready) wattroff(t->right, COLOR_PAIR(IDY_PAIR_BORDER));

    if(t->colors_ready) wattron(t->right, COLOR_PAIR(IDY_PAIR_TITLE));
    mvwprintw(t->right, cy++, 2, "Shortcuts ");
    if(t->colors_ready) wattroff(t->right, COLOR_PAIR(IDY_PAIR_TITLE));

    if(t->colors_ready) wattron(t->right, COLOR_PAIR(IDY_PAIR_BORDER));
    mvwhline(t->right, cy++, 1, ACS_HLINE, colsR);
    if(t->colors_ready) wattroff(t->right, COLOR_PAIR(IDY_PAIR_BORDER));

    if(t->colors_ready) wattron(t->right, COLOR_PAIR(IDY_PAIR_TEXT));
    mvwprintw(t->right, cy++, 2, "F1: Editor        F2: Context        F3: Logs");
    mvwprintw(t->right, cy++, 2, "Ctrl-G: Suggest (generate diff)");
    mvwprintw(t->right, cy++, 2, "Ctrl-A: Apply diff");
    mvwprintw(t->right, cy++, 2, "F5: latexmk build (local)");
    mvwprintw(t->right, cy++, 2, "Ctrl-S: Save      Ctrl-Q: Quit");
    mvwprintw(t->right, cy++, 2, "Ctrl-C/V/X: Copy / Paste / Cut");
    mvwprintw(t->right, cy++, 2, "Shift+Arrows: Select text");
    mvwprintw(t->right, cy++, 2, "Backspace/Delete: Delete char");
    if(t->colors_ready) wattroff(t->right, COLOR_PAIR(IDY_PAIR_TEXT));

    // Build config entries
    linebuf_t cfg; build_config_lines(&cfg);

    if(t->colors_ready) wattron(t->right, COLOR_PAIR(IDY_PAIR_BORDER));
    mvwhline(t->right, cy++, 1, ACS_HLINE, colsR);
    if(t->colors_ready) wattroff(t->right, COLOR_PAIR(IDY_PAIR_BORDER));

    // Compute available rows and clamp rhs scroll
    int header_y = cy;
    int avail_cfg_rows = rowsR - (header_y + 1); // +1 for the second rule below header line
    if(avail_cfg_rows < 1) avail_cfg_rows = 1;

    int max_rhs = (cfg.n > avail_cfg_rows) ? (cfg.n - avail_cfg_rows) : 0;
    if(rhs_scroll){
        if(*rhs_scroll < 0) *rhs_scroll = 0;
        if(*rhs_scroll > max_rhs) *rhs_scroll = max_rhs;
    }
    int rhs_off = rhs_scroll ? *rhs_scroll : 0;

    if(t->colors_ready) wattron(t->right, COLOR_PAIR(IDY_PAIR_TITLE));
    mvwprintw(t->right, cy++, 2, "Config (scroll with mouse on right) %d / %d", rhs_off, max_rhs);
    if(t->colors_ready) wattroff(t->right, COLOR_PAIR(IDY_PAIR_TEXT));

    if(t->colors_ready) wattron(t->right, COLOR_PAIR(IDY_PAIR_BORDER));
    mvwhline(t->right, cy++, 1, ACS_HLINE, colsR);
    if(t->colors_ready) wattroff(t->right, COLOR_PAIR(IDY_PAIR_BORDER));

    // Draw scrolled Config block, with key/value coloring
    int start = rhs_off;
    int end   = start + avail_cfg_rows;
    if(end > cfg.n) end = cfg.n;
    int yy = cy;

    for(int i=start; i<end; ++i, ++yy){
        lb_line_t *ln = &cfg.v[i];
        switch(ln->type){
            case LB_RULE: {
                if(t->colors_ready) wattron(t->right, COLOR_PAIR(IDY_PAIR_BORDER));
                mvwhline(t->right, yy, 1, ACS_HLINE, colsR);
                if(t->colors_ready) wattroff(t->right, COLOR_PAIR(IDY_PAIR_BORDER));
            } break;
            case LB_PLAIN: {
                if(t->colors_ready) wattron(t->right, (ln->text && ln->text[0]=='[') ? COLOR_PAIR(IDY_PAIR_TITLE) : COLOR_PAIR(IDY_PAIR_TEXT));
                mvwprintw(t->right, yy, 1, "%.*s", colsR, ln->text ? ln->text : "");
                if(t->colors_ready) wattroff(t->right, (ln->text && ln->text[0]=='[') ? COLOR_PAIR(IDY_PAIR_TITLE) : COLOR_PAIR(IDY_PAIR_TEXT));
            } break;
            case LB_KV: {
                const int label_w = 32;
                // Key
                if(t->colors_ready) wattron(t->right, COLOR_PAIR(IDY_PAIR_CFG_KEY));
                mvwprintw(t->right, yy, 1, "%-*s ", label_w, ln->key ? ln->key : "");
                if(t->colors_ready) wattroff(t->right, COLOR_PAIR(IDY_PAIR_CFG_KEY));
                // Value clipped to remaining width
                if(t->colors_ready) wattron(t->right, COLOR_PAIR(IDY_PAIR_CFG_VAL));
                int remain = colsR - (label_w + 1);
                if(remain < 1) remain = 1;
                const char *val = ln->value ? ln->value : "(unset)";
                int vlen = (int)strlen(val);
                if(vlen <= remain){
                    mvwprintw(t->right, yy, 1 + label_w + 1, "%s", val);
                } else if(remain >= 3){
                    // left ellipsis on overflow
                    mvwprintw(t->right, yy, 1 + label_w + 1, "...%.*s", remain-3, val + vlen - (remain-3));
                }
                if(t->colors_ready) wattroff(t->right, COLOR_PAIR(IDY_PAIR_CFG_VAL));
            } break;
        }
    }

    wrefresh(t->right);
    tui_draw_status(t->status, status);

    lb_free(&cfg);
    free(snap);
}
