#include "tui.h"
#include <limits.h>
#include <time.h>
#include <locale.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <ctype.h>

/* -----------------------------------------------------------------------------
 * Theming (runtime overrides)
 *
 * You can override the calm/soft theme via environment variables:
 *
 *   IDY_COLOR_BORDER  - borders & rules
 *   IDY_COLOR_TEXT    - general text
 *   IDY_COLOR_GUTTER  - editor line numbers
 *   IDY_COLOR_CFG_KEY - Config keys
 *   IDY_COLOR_CFG_VAL - Config values
 *   IDY_COLOR_TITLE   - Titles/section headers
 *
 * Accepted values (case/space-insensitive):
 *   - Named:
 *       base:   black, red, green, yellow, blue, magenta, cyan, white, default
 *       gray:   gray, grey, lightgray, lightgrey, darkgray, darkgrey, silver
 *       bright: brightblack, brightred, brightgreen, brightyellow,
 *               brightblue, brightmagenta, brightcyan, brightwhite
 *       light*: lightred, lightgreen, lightyellow, lightblue, lightmagenta,
 *               lightcyan, lightgray/lightgrey   (aliases to bright/gray)
 *   - Number: "0..COLORS-1" (e.g., 245 ≈ soft gray on 256-color terminals)
 *   - Gray %: "grayNN" or "greyNN" (0..100). If can_change_color() and slot is
 *             available, we synthesize that gray; otherwise we fall back.
 *
 * Background is left as -1 (terminal default) to keep things calm.
 * ---------------------------------------------------------------------------*/

static int parse_int_str(const char *s, int *out){
    if(!s || !*s) return 0;
    char *end=NULL; long v = strtol(s, &end, 10);
    if(end==s || *end!='\0') return 0;
    *out = (int)v; return 1;
}

/* Accept "grayNN"/"greyNN" -> permille in 0..1000 */
static int parse_gray_permille(const char *s, int *out_permille){
    if(!s) return 0;
    char buf[32];
    size_t n = strlen(s); if(n >= sizeof(buf)) n = sizeof(buf)-1;
    for(size_t i=0;i<n;i++) buf[i] = (char)tolower((unsigned char)s[i]);
    buf[n] = 0;

    const char *p = NULL;
    if(!strncmp(buf,"gray",4)) p = buf+4;
    else if(!strncmp(buf,"grey",4)) p = buf+4;
    else return 0;

    int pct=0;
    if(!parse_int_str(p, &pct)) return 0;
    if(pct < 0) pct = 0;
    if(pct > 100) pct = 100;
    *out_permille = pct * 10; // ncurses uses 0..1000
    return 1;
}

/* Map extended/bright names to indices sensibly based on COLORS.
 * Returns SHRT_MIN if not recognized here (caller may try numeric or grayNN).
 */
static short map_extended_color_name(const char *name_lc){
    /* Bright variants (prefer 16-color bright indexes if available) */
    if(!strcmp(name_lc,"brightblack"))   return (COLORS >= 16) ? 8  : COLOR_BLACK;
    if(!strcmp(name_lc,"brightred"))     return (COLORS >= 16) ? 9  : COLOR_RED;
    if(!strcmp(name_lc,"brightgreen"))   return (COLORS >= 16) ? 10 : COLOR_GREEN;
    if(!strcmp(name_lc,"brightyellow"))  return (COLORS >= 16) ? 11 : COLOR_YELLOW;
    if(!strcmp(name_lc,"brightblue"))    return (COLORS >= 16) ? 12 : COLOR_BLUE;
    if(!strcmp(name_lc,"brightmagenta")) return (COLORS >= 16) ? 13 : COLOR_MAGENTA;
    if(!strcmp(name_lc,"brightcyan"))    return (COLORS >= 16) ? 14 : COLOR_CYAN;
    if(!strcmp(name_lc,"brightwhite"))   return (COLORS >= 16) ? 15 : COLOR_WHITE;

    /* "light" aliases → bright in 16-color; otherwise base. Also include lightgray. */
    if(!strcmp(name_lc,"lightred"))      return (COLORS >= 16) ? 9  : COLOR_RED;
    if(!strcmp(name_lc,"lightgreen"))    return (COLORS >= 16) ? 10 : COLOR_GREEN;
    if(!strcmp(name_lc,"lightyellow"))   return (COLORS >= 16) ? 11 : COLOR_YELLOW;
    if(!strcmp(name_lc,"lightblue"))     return (COLORS >= 16) ? 12 : COLOR_BLUE;
    if(!strcmp(name_lc,"lightmagenta"))  return (COLORS >= 16) ? 13 : COLOR_MAGENTA;
    if(!strcmp(name_lc,"lightcyan"))     return (COLORS >= 16) ? 14 : COLOR_CYAN;

    /* Grays: pick nice xterm-256 indices when available; otherwise degrade. */
    if(!strcmp(name_lc,"gray") || !strcmp(name_lc,"grey")){
        if(COLORS >= 256) return 245;              // soft gray
        if(COLORS >= 16)  return 7;                // bright white-ish
        return COLOR_WHITE;
    }
    if(!strcmp(name_lc,"lightgray") || !strcmp(name_lc,"lightgrey") || !strcmp(name_lc,"silver")){
        if(COLORS >= 256) return 252;              // lighter gray
        if(COLORS >= 16)  return 7;
        return COLOR_WHITE;
    }
    if(!strcmp(name_lc,"darkgray") || !strcmp(name_lc,"darkgrey")){
        if(COLORS >= 256) return 238;              // darker gray
        if(COLORS >= 16)  return 8;                // bright black slot
        return COLOR_BLACK;
    }

    return SHRT_MIN;
}

/* Trim + lowercase + strip spaces */
static void normalize_name(const char *s, char out[], size_t out_sz){
    size_t n = s ? strlen(s) : 0;
    size_t w = 0;
    for(size_t i=0; i<n && w+1<out_sz; ++i){
        unsigned char ch = (unsigned char)s[i];
        if(!isspace(ch)){
            out[w++] = (char)tolower(ch);
        }
    }
    out[w] = 0;
}

static short name_to_color(const char *s, short def){
    if(!s) return def;

    char buf[64];
    normalize_name(s, buf, sizeof(buf));

    /* base 8 + default (these are always available) */
    if(!strcmp(buf,"default")) return -1;
    if(!strcmp(buf,"black"))   return COLOR_BLACK;
    if(!strcmp(buf,"red"))     return COLOR_RED;
    if(!strcmp(buf,"green"))   return COLOR_GREEN;
    if(!strcmp(buf,"yellow"))  return COLOR_YELLOW;
    if(!strcmp(buf,"blue"))    return COLOR_BLUE;
    if(!strcmp(buf,"magenta")) return COLOR_MAGENTA;
    if(!strcmp(buf,"cyan"))    return COLOR_CYAN;
    if(!strcmp(buf,"white"))   return COLOR_WHITE;

    /* extended names (bright*, light*, gray family) */
    short ext = map_extended_color_name(buf);
    if(ext != SHRT_MIN) return ext;

    /* numeric index */
    int idx=0;
    if(parse_int_str(buf, &idx)){
        if(idx >= -1 && idx < COLORS) return (short)idx;
        return def; // out of range -> fallback
    }

    return def; // not recognized -> fallback
}

/* Synthesize a gray in a preferred slot if grayNN is requested and supported. */
static short maybe_make_gray(const char *spec, short preferred_slot, short fallback){
    int permille=0;
    if(!parse_gray_permille(spec, &permille)) return fallback;
    if(!can_change_color()) return fallback;
    if(preferred_slot < 0 || preferred_slot >= COLORS) return fallback;
    // define R=G=B=permille (0..1000)
    init_color(preferred_slot, permille, permille, permille);
    return preferred_slot;
}

/* Resolve a color from an env var:
 * 1) named/number/extended name
 * 2) grayNN/greyNN -> synthesize in preferred_slot if possible
 * 3) unset -> def
 */
static short resolve_color_from_env(const char *env_key, short def, short preferred_slot){
    const char *raw = getenv(env_key);
    if(!raw || !*raw) return def;

    // Try named/number/extended
    short named = name_to_color(raw, SHRT_MIN);
    if(named != SHRT_MIN){
        return named;
    }

    // Try "grayNN"/"greyNN"
    return maybe_make_gray(raw, preferred_slot, def);
}

/* ===== Unicode capability detection for tree guides ===== */
static bool g_unicode_tree = false;

static bool str_has_utf8(const char *s){
    return s && (strstr(s, "UTF-8") || strstr(s, "utf8"));
}

static bool locale_supports_utf8(void){
    const char *lc = NULL;
    lc = getenv("LC_ALL");   if(str_has_utf8(lc)) return true;
    lc = getenv("LC_CTYPE"); if(str_has_utf8(lc)) return true;
    lc = getenv("LANG");     if(str_has_utf8(lc)) return true;
    lc = setlocale(LC_CTYPE, NULL); if(str_has_utf8(lc)) return true;
    return false;
}

bool tui_unicode_tree_enabled(void){
    return g_unicode_tree;
}

// Parse common boolean strings; returns 1 if recognized and sets *out.
static int parse_bool_str(const char *s, int *out){
    if(!s){ return 0; }
    while(*s && isspace((unsigned char)*s)) s++;
    const char *e = s + strlen(s);
    while(e > s && isspace((unsigned char)e[-1])) e--;
    size_t n = (size_t)(e - s);
    if(n == 0){ *out = 0; return 1; }
    if(!strncasecmp(s,"1",n)      || !strncasecmp(s,"true",n)  || !strncasecmp(s,"yes",n) ||
       !strncasecmp(s,"on",n)     || !strncasecmp(s,"y",n)){
        *out = 1; return 1;
    }
    if(!strncasecmp(s,"0",n)      || !strncasecmp(s,"false",n) || !strncasecmp(s,"no",n)  ||
       !strncasecmp(s,"off",n)    || !strncasecmp(s,"n",n)){
        *out = 0; return 1;
    }
    return 0;
}

/* ------------------------------ Color init ------------------------------ */

static void init_colors(tui_t *t){
    t->colors_ready = false;
    if(!has_colors()) return;
    start_color();
    use_default_colors();

    /* Existing pairs for diff/log levels:
       1:addition  2:deletion  3:header  4:hunk  5:info  6:warn
       7:error     8:debug     9:trace
    */
    init_pair(1, COLOR_GREEN,  -1);
    init_pair(2, COLOR_RED,    -1);
    init_pair(3, COLOR_YELLOW, -1);
    init_pair(4, COLOR_CYAN,   -1);
    init_pair(5, COLOR_CYAN,   -1);
    init_pair(6, COLOR_YELLOW, -1);
    init_pair(7, COLOR_RED,    -1);
    init_pair(8, COLOR_BLUE,   -1);
    init_pair(9, COLOR_MAGENTA,-1);

    /* Calm/soft defaults:
       Try to create custom 75% and 60% grays if the terminal allows it;
       otherwise fall back to WHITE for both and we'll keep draw styles subtle.
    */
    short default_soft = COLOR_WHITE; // general text
    short default_gut  = COLOR_WHITE; // gutter/line numbers
    if(can_change_color() && COLORS >= 16){
        if(13 < COLORS){ init_color(13, 750, 750, 750); default_soft = 13; } // ~gray75
        if(14 < COLORS){ init_color(14, 600, 600, 600); default_gut  = 14; } // ~gray60
    }

    /* Resolve runtime overrides (names, indices, or grayNN).
       Preferred slots for synthesized grays: TEXT→13, GUTTER→14.
    */
    short c_border = resolve_color_from_env("IDY_COLOR_BORDER", COLOR_WHITE,  -1);
    short c_text   = resolve_color_from_env("IDY_COLOR_TEXT",   default_soft, 13);
    short c_gutter = resolve_color_from_env("IDY_COLOR_GUTTER", default_gut,  14);
    short c_ckey   = resolve_color_from_env("IDY_COLOR_CFG_KEY", COLOR_CYAN,  -1);
    short c_cval   = resolve_color_from_env("IDY_COLOR_CFG_VAL", default_gut, 14);
    short c_title  = resolve_color_from_env("IDY_COLOR_TITLE",   COLOR_WHITE, -1);

    // Pairs used throughout the TUI (exported in tui.h)
    init_pair(IDY_PAIR_BORDER, c_border, -1);
    init_pair(IDY_PAIR_TEXT,   c_text,   -1);
    init_pair(IDY_PAIR_GUTTER, c_gutter, -1);
    init_pair(IDY_PAIR_CFG_KEY,c_ckey,   -1);
    init_pair(IDY_PAIR_CFG_VAL,c_cval,   -1);
    init_pair(IDY_PAIR_TITLE,  c_title,  -1);

    t->colors_ready = true;
}

/* ------------------------------ TUI core ------------------------------ */

void tui_init(tui_t *t){
    // Enable locale so ncurses can handle wide chars if present
    setlocale(LC_ALL, "");
    initscr();
    raw();                // allow Ctrl-C, Ctrl-V, etc. to reach us
    noecho();
    keypad(stdscr, TRUE);
    mousemask(ALL_MOUSE_EVENTS | REPORT_MOUSE_POSITION, NULL);
    timeout(60);          // ~60ms tick for blinking
    curs_set(1);
    getmaxyx(stdscr, t->rows, t->cols);
    t->split_col = t->cols * 0.55;
    t->left  = newwin(t->rows-1, t->split_col, 0, 0);
    t->right = newwin(t->rows-1, t->cols - t->split_col, 0, t->split_col);
    t->status= newwin(1, t->cols, t->rows-1, 0);
    scrollok(t->right, TRUE);
    t->gutter_cols = 0;
    t->blink_on = false;
    init_colors(t);

    // Decide whether to use Unicode tree guides.
    // Default: auto-detect. Override with IDY_TREE_UNICODE=1/0/true/false.
    const char *force = getenv("IDY_TREE_UNICODE");
    if(force){
        int b=0;
        if(parse_bool_str(force, &b)) g_unicode_tree = (b != 0);
        else                          g_unicode_tree = locale_supports_utf8(); // e.g., "auto"
    } else {
        g_unicode_tree = locale_supports_utf8();
    }
}

void tui_end(void){ endwin(); }

void tui_resize(tui_t *t){
    getmaxyx(stdscr, t->rows, t->cols);
    t->split_col = t->cols * 0.55;
    wresize(t->left,  t->rows-1, t->split_col);
    wresize(t->right, t->rows-1, t->cols - t->split_col);
    mvwin(t->right, 0, t->split_col);
    wresize(t->status, 1, t->cols);
    mvwin(t->status, t->rows-1, 0);
    wclear(t->left); wclear(t->right); wclear(t->status);
}

// Common status bar drawing (exported)
void tui_draw_status(WINDOW *w, const char *status){
    werase(w);
    int width = getmaxx(w) - 2;

    if(has_colors()){
        wattron(w, COLOR_PAIR(IDY_PAIR_TEXT));
    }

    // Shortcuts: include Ctrl-G (Suggest) and Ctrl-A (Apply), F9 removed.
    const char *shortcuts =
        "F1:Editor  F2:Context  F3:Logs  "
        "Ctrl-G:Suggest  Ctrl-A:Apply  Ctrl-S:Save  "
        "F5:latexmk  Ctrl-C/V/X  Shift+Arrows  Ctrl-Q:Quit";
    int slen = (int)strlen(shortcuts);
    int left_space = width - slen - 2; // 2 for padding and separator
    if(left_space < 10) left_space = 10;
    const char *msg = status ? status : "";
    char leftbuf[1024];
    snprintf(leftbuf, sizeof(leftbuf), "%.*s", left_space, msg);
    mvwprintw(w, 0, 1, "%s", leftbuf);

    // Separator in border color
    if(has_colors()){
        wattroff(w, COLOR_PAIR(IDY_PAIR_TEXT));
        wattron(w, COLOR_PAIR(IDY_PAIR_BORDER));
    }
    if(slen + 2 < width) mvwaddch(w, 0, 1 + left_space, ACS_VLINE);
    if(has_colors()){
        wattroff(w, COLOR_PAIR(IDY_PAIR_BORDER));
        wattron(w, COLOR_PAIR(IDY_PAIR_TEXT));
    }

    int startx = 1 + width - slen;
    if(startx < 1 + left_space + 2) startx = 1 + left_space + 2;
    mvwprintw(w, 0, startx, "%s", shortcuts);

    if(has_colors()){
        wattroff(w, COLOR_PAIR(IDY_PAIR_TEXT));
    }

    wrefresh(w);
}
