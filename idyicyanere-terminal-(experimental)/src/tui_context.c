#include "tui.h"
#include <string.h>
#include <stdlib.h>
#include <ctype.h>

/* ===================== Context panel (formerly "Settings") ===================== */

void tui_draw_context(tui_t *t,
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
    (void)cfg; // currently unused in Context panel

    werase(t->left);
    if(t->colors_ready) wattron(t->left, COLOR_PAIR(IDY_PAIR_BORDER));
    box(t->left,0,0);
    if(t->colors_ready) wattroff(t->left, COLOR_PAIR(IDY_PAIR_BORDER));

    werase(t->right);
    if(t->colors_ready) wattron(t->right, COLOR_PAIR(IDY_PAIR_BORDER));
    box(t->right,0,0);
    if(t->colors_ready) wattroff(t->right, COLOR_PAIR(IDY_PAIR_BORDER));

    // ----- Left: Recursive directory listing with checkboxes and tree guides -----
    if(t->colors_ready) wattron(t->left, COLOR_PAIR(IDY_PAIR_TITLE));
    mvwprintw(t->left, 1, 1, "Folder: %s", cwd);
    if(t->colors_ready) wattroff(t->left, COLOR_PAIR(IDY_PAIR_TITLE));

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

    if(t->colors_ready) wattron(t->left, COLOR_PAIR(IDY_PAIR_TEXT));
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
    if(t->colors_ready) wattroff(t->left, COLOR_PAIR(IDY_PAIR_TEXT));

    // Bottom-left: short instructions
    int inst_y = rowsL - 3;
    if(inst_y >= 3){
        if(t->colors_ready) wattron(t->left, COLOR_PAIR(IDY_PAIR_BORDER));
        mvwhline(t->left, inst_y - 1, 1, ACS_HLINE, getmaxx(t->left)-2);
        if(t->colors_ready) wattroff(t->left, COLOR_PAIR(IDY_PAIR_BORDER));

        if(t->colors_ready) wattron(t->left, COLOR_PAIR(IDY_PAIR_TEXT));
        mvwprintw(t->left, inst_y,     2, "Instructions:");
        mvwprintw(t->left, inst_y + 1, 2, "Left-click or Enter: open file / enter folder");
        mvwprintw(t->left, inst_y + 2, 2, "Right-click: add/remove file from model context");
        if(t->colors_ready) wattroff(t->left, COLOR_PAIR(IDY_PAIR_TEXT));
    }

    if(is_last) free(is_last);
    wrefresh(t->left);

    // ----- Right: Context preview (full height) -----
    int rowsR = getmaxy(t->right)-2, colsR = getmaxx(t->right)-2;
    int cy = 1;

    if(t->colors_ready) wattron(t->right, COLOR_PAIR(IDY_PAIR_TITLE));
    mvwprintw(t->right, cy++, 2, "Context Preview (PgUp/PgDn or wheel to scroll)");
    if(t->colors_ready) wattroff(t->right, COLOR_PAIR(IDY_PAIR_TITLE));

    if(t->colors_ready) wattron(t->right, COLOR_PAIR(IDY_PAIR_BORDER));
    mvwhline(t->right, cy++, 1, ACS_HLINE, colsR);
    if(t->colors_ready) wattroff(t->right, COLOR_PAIR(IDY_PAIR_BORDER));

    int ybot = cy;
    int bot_rows = rowsR - (ybot - 1);
    if(bot_rows < 1) bot_rows = 1;

    if(t->colors_ready) wattron(t->right, COLOR_PAIR(IDY_PAIR_TEXT));
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
    if(t->colors_ready) wattroff(t->right, COLOR_PAIR(IDY_PAIR_TEXT));

    wrefresh(t->right);
    tui_draw_status(t->status, status);
}
