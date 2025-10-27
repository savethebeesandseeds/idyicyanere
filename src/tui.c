#include "tui.h"

void tui_init(tui_t *t){
    initscr(); cbreak(); noecho(); keypad(stdscr, TRUE);
    getmaxyx(stdscr, t->rows, t->cols);
    int mid = t->cols * 0.55;
    t->left  = newwin(t->rows-1, mid, 0, 0);
    t->right = newwin(t->rows-1, t->cols-mid, 0, mid);
    t->status= newwin(1, t->cols, t->rows-1, 0);
    scrollok(t->right, TRUE);
    box(t->left, 0,0); box(t->right, 0,0);
}

void tui_draw(tui_t *t, buffer_t *doc, const char *rightbuf, const char *status){
    werase(t->left); box(t->left,0,0);
    werase(t->right); box(t->right,0,0);
    werase(t->status);

    // left: document (first N lines)
    int y=1,x=1;
    for(size_t i=0;i<doc->len && y < t->rows-2;i++){
        char c = doc->data[i];
        if(c=='\n'){ y++; x=1; }
        else { if(x < getmaxx(t->left)-1){ mvwaddch(t->left, y, x++, c); } }
    }

    // right: streamed text/diff
    if(rightbuf){
        int ry=1, rx=1, rmax=getmaxx(t->right)-2;
        for(const char *p=rightbuf; *p && ry < t->rows-2; ++p){
            if(*p=='\n'){ ry++; rx=1; continue; }
            if(rx<rmax) mvwaddch(t->right, ry, rx++, *p);
        }
    }

    // status bar
    if(!status) status = "Ctrl-G:Suggest  Ctrl-A:ApplyDiff  F5:latexmk -pdf  S-F5:-pvc  F9:ssh build  Ctrl-S:save  Ctrl-Q:quit";
    mvwprintw(t->status, 0, 1, "%s", status);

    wrefresh(t->left); wrefresh(t->right); wrefresh(t->status);
}

void tui_end(void){ endwin(); }
