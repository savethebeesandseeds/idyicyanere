#include "tui.h"

// Helpers
static int digits_i(int n){ int d=1; while(n>=10){ n/=10; d++; } return d; }

static void draw_title_filepath(WINDOW *w, const char *filepath, bool dirty){
    int cols = getmaxx(w);
    if(cols <= 4) return; // too narrow to render nicely
    int avail = cols - 4; // leave margins inside the box border

    const char *path = filepath ? filepath : "(untitled)";
    // Compose "* " prefix if dirty
    char *full = NULL;
    if(dirty) asprintf(&full, "* %s", path); else asprintf(&full, "%s", path);
    if(!full) return;

    if(has_colors()) wattron(w, COLOR_PAIR(IDY_PAIR_TITLE));
    int len = (int)strlen(full);
    if(len <= avail){
        mvwprintw(w, 0, 2, "%s", full);
    } else {
        // Left-truncate with ellipsis to fit
        int keep = avail - 3; if(keep < 1) keep = 1;
        const char *tail = full + (len - keep);
        mvwprintw(w, 0, 2, "...%s", tail);
    }
    if(has_colors()) wattroff(w, COLOR_PAIR(IDY_PAIR_TITLE));
    free(full);
}

// Render left editor pane with gutter (line numbers), selection highlight, and soft-blink caret
static void draw_editor_left(tui_t *t, editor_t *ed, const char *filepath){
    WINDOW *w = t->left;
    werase(w);
    if(t->colors_ready) wattron(w, COLOR_PAIR(IDY_PAIR_BORDER));
    box(w,0,0);
    if(t->colors_ready) wattroff(w, COLOR_PAIR(IDY_PAIR_BORDER));

    int rows = getmaxy(w)-2, cols = getmaxx(w)-2;

    // Title bar: file path (Ln/Col are shown in the status bar)
    draw_title_filepath(w, filepath, ed->dirty);

    // Compute gutter width (min 3 digits) + one space
    int total_lines = editor_total_lines(ed->doc);
    int lnw = digits_i(total_lines < 1 ? 1 : total_lines);
    if(lnw < 3) lnw = 3;
    int gutter = lnw + 1;
    t->gutter_cols = gutter;

    // Selection range (absolute byte indexes)
    bool has_sel = editor_has_selection(ed);
    size_t sel_lo=0, sel_hi=0; if(has_sel) editor_get_selection(ed,&sel_lo,&sel_hi);

    if(t->colors_ready) wattron(w, COLOR_PAIR(IDY_PAIR_TEXT));
    // find start index of top line
    size_t idx = editor_line_start_index(ed->doc, ed->top_line);
    int y=1, x=1+gutter, col=0;
    bool attr_sel=false;
    for(size_t i=idx; i<=ed->doc->len && y<=rows; i++){
        char c = (i<ed->doc->len) ? ed->doc->data[i] : '\0';
        if(c=='\n' || c=='\0'){
            int lineno = ed->top_line + (y-1) + 1;
            if(t->colors_ready) wattron(w, COLOR_PAIR(IDY_PAIR_GUTTER));
            wattron(w, A_DIM);
            mvwprintw(w, y, 1, "%*d ", lnw, lineno);
            wattroff(w, A_DIM);
            if(t->colors_ready) wattroff(w, COLOR_PAIR(IDY_PAIR_GUTTER));
            if(attr_sel){ wattroff(w, A_REVERSE); attr_sel=false; }
            y++; x=1+gutter; col=0;
            if(c=='\0') break;
            continue;
        } else {
            if(col >= ed->left_col){
                bool in_sel = has_sel && (i>=sel_lo && i<sel_hi);
                if(in_sel && !attr_sel){ wattron(w, A_REVERSE); attr_sel=true; }
                if(!in_sel && attr_sel){ wattroff(w, A_REVERSE); attr_sel=false; }
                if(x <= cols){ mvwaddch(w, y, x, c); }
                x++;
            }
            col++;
        }
    }
    if(attr_sel){ wattroff(w, A_REVERSE); }
    if(t->colors_ready) wattroff(w, COLOR_PAIR(IDY_PAIR_TEXT));

    // draw caret + soft blink overlay
    int crow, ccol; editor_cursor_row_col(ed, &crow, &ccol);
    editor_scroll_into_view(ed, crow, ccol, rows, cols - gutter);
    int cy = 1 + (crow - ed->top_line);
    int cx = 1 + gutter + (ccol - ed->left_col);
    if(cy>=1 && cy<=rows && cx>=1 && cx<=cols){
        wmove(w, cy, cx);
        if(t->blink_on) mvwchgat(w, cy, cx, 1, A_REVERSE, 0, NULL);
    }
    wrefresh(w);
}

// Colorize unified diff in right pane
static void draw_diff_right(WINDOW *w, const char *diff, bool colors_ready){
    werase(w);
    if(colors_ready) wattron(w, COLOR_PAIR(IDY_PAIR_BORDER));
    box(w,0,0);
    if(colors_ready) wattroff(w, COLOR_PAIR(IDY_PAIR_BORDER));

    int rows = getmaxy(w)-2, cols = getmaxx(w)-2;
    int y=1;
    if(!diff){ wrefresh(w); return; }
    const char *p=diff;
    while(*p && y<=rows){
        const char *nl = strchr(p, '\n');
        size_t len = nl ? (size_t)(nl - p) : strlen(p);
        int pair = 0;
        if(colors_ready){
            if(len>=3 && (strncmp(p,"---",3)==0 || strncmp(p,"+++",3)==0)) pair=3;
            else if(len>=2 && strncmp(p,"@@",2)==0) pair=4;
            else if(len>=1 && p[0]=='+') pair=1;
            else if(len>=1 && p[0]=='-') pair=2;
            else pair=IDY_PAIR_TEXT;
        }
        int x=1;
        if(pair) wattron(w, COLOR_PAIR(pair));
        for(size_t i=0;i<len && x<=cols;i++){
            mvwaddch(w, y, x++, p[i]);
        }
        if(pair) wattroff(w, COLOR_PAIR(pair));
        y++;
        p = nl ? nl+1 : p+len;
    }
    wrefresh(w);
}

void tui_draw_editor(tui_t *t, editor_t *ed, const char *rightbuf, const char *status, const char *filepath){
    draw_editor_left(t, ed, filepath);
    draw_diff_right(t->right, rightbuf, t->colors_ready);
    int r=0,c=0; editor_cursor_row_col(ed,&r,&c);
    char sbuf[512];
    if(status && *status)
        snprintf(sbuf, sizeof(sbuf), "%sLn %d, Col %d  |  %s", ed->dirty?"*":"", r+1, c+1, status);
    else
        snprintf(sbuf, sizeof(sbuf), "%sLn %d, Col %d", ed->dirty?"*":"", r+1, c+1);
    tui_draw_status(t->status, sbuf);
}
