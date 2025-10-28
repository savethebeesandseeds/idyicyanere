#include "tui.h"
#include <limits.h>
#include <time.h>
#include <locale.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <ctype.h>

static void init_colors(tui_t *t){
    t->colors_ready = false;
    if(!has_colors()) return;
    start_color();
    use_default_colors();
    // 1:addition  2:deletion  3:header  4:hunk  5:info  6:warn  7:error  8:debug  9:trace
    init_pair(1, COLOR_GREEN,  -1);
    init_pair(2, COLOR_RED,    -1);
    init_pair(3, COLOR_YELLOW, -1);
    init_pair(4, COLOR_CYAN,   -1);
    init_pair(5, COLOR_CYAN,   -1);
    init_pair(6, COLOR_YELLOW, -1);
    init_pair(7, COLOR_RED,    -1);
    init_pair(8, COLOR_BLUE,   -1);
    init_pair(9, COLOR_MAGENTA,-1);
    t->colors_ready = true;
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
// Recognized true:  1, true, yes, on, y
// Recognized false: 0, false, no, off, n, "" (empty/whitespace)
// Returns 0 if unrecognized (caller may fall back to auto).
static int parse_bool_str(const char *s, int *out){
    if(!s){ return 0; }
    // trim
    while(*s && isspace((unsigned char)*s)) s++;
    const char *e = s + strlen(s);
    while(e > s && isspace((unsigned char)e[-1])) e--;
    size_t n = (size_t)(e - s);
    if(n == 0){ *out = 0; return 1; } // empty => false
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
    // Shortcuts: include Ctrl-G (Suggest) and Ctrl-A (Apply), F9 removed.
    const char *shortcuts =
        "F1:Editor  F2:Logs  F3:Settings  "
        "Ctrl-G:Suggest  Ctrl-A:Apply  Ctrl-S:Save  "
        "F5:latexmk  Ctrl-C/V/X  Shift+Arrows  Ctrl-Q:Quit";
    int width = getmaxx(w) - 2;
    int slen = (int)strlen(shortcuts);
    int left_space = width - slen - 2; // 2 for padding and separator
    if(left_space < 10) left_space = 10;
    const char *msg = status ? status : "";
    char leftbuf[1024];
    snprintf(leftbuf, sizeof(leftbuf), "%.*s", left_space, msg);
    mvwprintw(w, 0, 1, "%s", leftbuf);
    if(slen + 2 < width) mvwaddch(w, 0, 1 + left_space, ACS_VLINE);
    int startx = 1 + width - slen;
    if(startx < 1 + left_space + 2) startx = 1 + left_space + 2;
    mvwprintw(w, 0, startx, "%s", shortcuts);
    wrefresh(w);
}
