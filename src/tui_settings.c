#include "tui.h"
#include <string.h>
#include <stdlib.h>
#include <ctype.h>

/* Helpers kept from before */
static int digits_i(int n){ int d=1; while(n>=10){ n/=10; d++; } return d; }

/* ===================== New helpers for Config rendering ===================== */

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

// return malloc'd, trimmed, with internal newlines/carriage-returns collapsed to single spaces for display
static char* getenv_clean(const char *k){
    const char *raw = getenv_raw(k);
    if(!raw) return NULL;
    char *t = str_trimdup(raw);
    if(!t) return NULL;
    // replace \r or \n by spaces (display)
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
    // keep prefix like "sk-" if present
    size_t keep_head = 4, keep_tail = 4;
    char *out = (char*)malloc(n + 1);
    if(!out) return NULL;
    memcpy(out, v, keep_head);
    memset(out + keep_head, '*', (n > keep_head + keep_tail) ? (n - keep_head - keep_tail) : 0);
    if(n >= keep_tail) memcpy(out + (n - keep_tail), v + (n - keep_tail), keep_tail);
    out[n] = 0;
    return out;
}

static void draw_kv(WINDOW *w, int y, int cols, const char *label, const char *value){
    if(!label) label="";
    if(!value) value="(unset)";
    int label_w = 18; // fixed label column
    if(label_w > cols-1) label_w = cols-1;
    int val_w = cols - 2 - label_w; if(val_w < 1) val_w = 1;
    // Ellipsize value if too long
    int vlen = (int)strlen(value);
    if(vlen > val_w){
        // draw "...tail"
        const char *tail = value + vlen - (val_w - 3);
        mvwprintw(w, y, 1, "%-*s %.*s", label_w, label, val_w, value); // print head first to compute positions
        // overwrite with ellipsis+tail
        mvwprintw(w, y, 1 + label_w + 1, "...%.*s", val_w-3, tail);
    } else {
        mvwprintw(w, y, 1, "%-*s %s", label_w, label, value);
    }
}

/* ===================== Existing code below, with Config section updated ===================== */

void tui_draw_settings(tui_t *t,
                       const char *cwd,
                       const file_list_t *fl,
                       int selected,
                       const idy_config_t *cfg,
                       char **ctx_files,
                       int ctx_count,
                       const char *ctx_preview,
                       int ctx_scroll,
                       const char *status)
{
    werase(t->left); box(t->left,0,0);
    werase(t->right); box(t->right,0,0);

    // ----- Left: Recursive directory listing with checkboxes and tree guides -----
    mvwprintw(t->left, 1, 1, "Folder: %s", cwd);

    // Precompute "is last sibling" flags to render tree guides like `tree`.
    bool *is_last = NULL;
    if(fl->count > 0){
        is_last = (bool*)calloc((size_t)fl->count, sizeof(bool));
        for(int i=0;i<fl->count;i++){
            int d = fl->items[i].depth;
            bool last = true;
            for(int k=i+1;k<fl->count;k++){
                if(fl->items[k].depth < d) break;
                if(fl->items[k].depth == d){ last=false; break; }
            }
            is_last[i] = last;
        }
    }

    // Choose tree segment strings (ASCII fallback by default)
    const bool use_unicode = tui_unicode_tree_enabled();
    const char *seg_vert = use_unicode ? "│   " : "|   ";
    const char *seg_last = use_unicode ? "└──"  : "`--";
    const char *seg_mid  = use_unicode ? "├──"  : "+--";

    int rowsL = getmaxy(t->left)-2;
    int y=3;
    int reserve_lines = 4; // leave room for the instructions block at the bottom
    int list_max_y = rowsL - reserve_lines;

    for(int i=0;i<fl->count && y<list_max_y;i++){
        // Full path for inclusion check
        char *full=NULL; asprintf(&full, "%s/%s", cwd, fl->items[i].name);
        bool included=false;
        for(int k=0;k<ctx_count;k++){
            if(strcmp(ctx_files[k], full)==0){ included=true; break; }
        }
        const char *mark = fl->items[i].is_dir ? "   " : (included ? "[x]" : "[ ]");

        // Build tree prefix like `tree`
        char prefix[256]; prefix[0]='\0';
        int depth = fl->items[i].depth;
        int anc[64]; int anc_cnt=0;
        int search_from = i;
        for(int d=depth-1; d>=0; --d){
            int pj=-1;
            for(int j=search_from-1; j>=0; --j){
                if(fl->items[j].depth == d){ pj=j; break; }
            }
            if(pj>=0){ anc[anc_cnt++]=pj; search_from = pj; }
        }
        for(int a=anc_cnt-1; a>=0; --a){
            strncat(prefix, (is_last && is_last[anc[a]]) ? "    " : seg_vert, sizeof(prefix)-strlen(prefix)-1);
        }
        strncat(prefix, (is_last && is_last[i]) ? seg_last : seg_mid, sizeof(prefix)-strlen(prefix)-1);

        if(i==selected) wattron(t->left, A_REVERSE);
        if(fl->items[i].is_dir){
            wattron(t->left, A_BOLD);
            mvwprintw(t->left, y++, 2, "%s %s %s/", prefix, mark, fl->items[i].name);
            wattroff(t->left, A_BOLD);
        } else {
            mvwprintw(t->left, y++, 2, "%s %s %s", prefix, mark, fl->items[i].name);
        }
        if(i==selected) wattroff(t->left, A_REVERSE);
        free(full);
    }

    // Bottom-left: short instructions
    int inst_y = rowsL - 3;
    if(inst_y >= 3){
        mvwhline(t->left, inst_y - 1, 1, ACS_HLINE, getmaxx(t->left)-2);
        mvwprintw(t->left, inst_y,     2, "Instructions:");
        mvwprintw(t->left, inst_y + 1, 2, "Left-click or Enter: open file / enter folder");
        mvwprintw(t->left, inst_y + 2, 2, "Right-click: add/remove file from model context");
    }

    if(is_last) free(is_last);
    wrefresh(t->left);

    // ----- Right: Config (top ~40%) + Context preview (bottom) -----
    int rowsR = getmaxy(t->right)-2, colsR = getmaxx(t->right)-2;
    int top_rows = rowsR * 4 / 10; if(top_rows < 10) top_rows = 10; // more space for envs
    int bot_start = top_rows + 2;

    // Config (top)
    mvwprintw(t->right, 1, 1, "Config (env + effective)");
    mvwhline(t->right, 2, 1, ACS_HLINE, colsR);

    int cy = 3;

    // Group: API/OpenAI
    mvwprintw(t->right, cy++, 2, "[OpenAI]");
    char *v_base = getenv_clean("OPENAI_BASE_URL");
    char *v_model = getenv_clean("OPENAI_MODEL");
    char *v_key_masked = NULL;
    {
        const char *raw_key = getenv_raw("OPENAI_API_KEY");
        v_key_masked = mask_api_key(raw_key);
    }
    draw_kv(t->right, cy++, colsR, "OPENAI_BASE_URL", v_base?v_base:"(unset/default)");
    draw_kv(t->right, cy++, colsR, "OPENAI_MODEL",    v_model?v_model:"(unset: gpt-4o-mini)");
    draw_kv(t->right, cy++, colsR, "OPENAI_API_KEY",  v_key_masked?v_key_masked:"(unset)");
    free(v_base); free(v_model); free(v_key_masked);

    // Group: TUI/Display
    mvwprintw(t->right, cy++, 2, "[TUI / Display]");
    char *v_tree = getenv_clean("IDY_TREE_UNICODE");
    char *v_tab  = getenv_clean("IDY_LOG_TABSTOP");
    draw_kv(t->right, cy++, colsR, "IDY_TREE_UNICODE", v_tree?v_tree:"(unset: auto)");
    draw_kv(t->right, cy++, colsR, "IDY_LOG_TABSTOP",  v_tab?v_tab:"(unset: 4)");
    // Effective toggle for unicode
    draw_kv(t->right, cy++, colsR, "unicode_tree (effective)", tui_unicode_tree_enabled() ? "enabled" : "disabled");
    free(v_tree); free(v_tab);

    // Group: TLS/Network
    mvwprintw(t->right, cy++, 2, "[Network / TLS]");
    char *v_cainfo = getenv_clean("IDY_CAINFO");
    char *v_capath = getenv_clean("IDY_CAPATH");
    char *v_cabndl = getenv_clean("CURL_CA_BUNDLE");
    char *v_sslfile= getenv_clean("SSL_CERT_FILE");
    char *v_ssldir = getenv_clean("SSL_CERT_DIR");
    int insecure_set=0; int insecure = parse_truthy_env("IDY_CURL_INSECURE", &insecure_set);
    draw_kv(t->right, cy++, colsR, "IDY_CURL_INSECURE", insecure_set ? (insecure ? "1 (true)" : "0 (false)") : "(unset: secure)");
    draw_kv(t->right, cy++, colsR, "IDY_CAINFO", v_cainfo?v_cainfo:"(libcurl default)");
    draw_kv(t->right, cy++, colsR, "IDY_CAPATH", v_capath?v_capath:"(libcurl default)");
    draw_kv(t->right, cy++, colsR, "CURL_CA_BUNDLE", v_cabndl?v_cabndl:"(unset)");
    draw_kv(t->right, cy++, colsR, "SSL_CERT_FILE",  v_sslfile?v_sslfile:"(unset)");
    draw_kv(t->right, cy++, colsR, "SSL_CERT_DIR",   v_ssldir?v_ssldir:"(unset)");
    free(v_cainfo); free(v_capath); free(v_cabndl); free(v_sslfile); free(v_ssldir);

    // Group: Debug/misc
    mvwprintw(t->right, cy++, 2, "[Debug / Misc]");
    char *v_verbose = getenv_clean("IDY_CURL_VERBOSE");
    char *v_saveas  = getenv_clean("IDY_SAVE_AS");
    draw_kv(t->right, cy++, colsR, "IDY_CURL_VERBOSE", v_verbose?v_verbose:"(unset: 0)");
    {
        int verbose_set=0;
        int verbose_eff = parse_truthy_env("IDY_CURL_VERBOSE", &verbose_set);
        draw_kv(t->right, cy++, colsR, "curl_verbose (effective)",
                verbose_set ? (verbose_eff ? "enabled" : "disabled") : "disabled (unset)");
    }
    draw_kv(t->right, cy++, colsR, "IDY_SAVE_AS",      v_saveas?v_saveas:"(unset)");
    free(v_verbose); free(v_saveas);

    // Also useful to show locale/term (often impact rendering)
    char *v_lang = getenv_clean("LANG");
    char *v_term = getenv_clean("TERM");
    draw_kv(t->right, cy++, colsR, "LANG", v_lang?v_lang:"(unset)");
    draw_kv(t->right, cy++, colsR, "TERM", v_term?v_term:"(unset)");
    free(v_lang); free(v_term);

    // Separator before bottom
    if(cy < top_rows) cy = top_rows; // keep the block height
    mvwhline(t->right, cy, 1, ACS_HLINE, colsR);
    mvwprintw(t->right, cy, 3, " Base Context Preview (PgUp/PgDn or wheel to scroll) ");

    // Context preview (bottom) with vertical scroll
    int ybot = cy + 1;
    int bot_rows = rowsR - (ybot - 1);
    if(bot_rows < 1) bot_rows = 1;

    if(ctx_preview){
        int cur_line = 0;
        const char *p = ctx_preview;
        int ydraw = ybot;
        while(*p && ydraw < ybot + bot_rows){
            const char *nl = strchr(p, '\n');
            size_t len = nl ? (size_t)(nl - p) : strlen(p);
            size_t maxw_sz = (size_t)(colsR - 1);
            if(maxw_sz < 1) maxw_sz = 1;
            if(cur_line >= ctx_scroll){
                size_t clamp = (len > maxw_sz) ? maxw_sz : len;
                mvwprintw(t->right, ydraw, 1, "%.*s", (int)clamp, p);
                ydraw++;
            }
            if(!nl) break;
            p = nl + 1;
            cur_line++;
        }
    }

    wrefresh(t->right);
    tui_draw_status(t->status, status);
}
