#include "tui.h"
#include <string.h>
#include <stdlib.h>
#include <ctype.h>

/* ===================== LOG VIEW (Sanitized + Smart Wrap + SCROLL) =====================

   New:
   - Scrollable via ↑/↓ (1 line), PgUp/PgDn (page), Home (oldest), End (newest).
   - Mouse wheel over the LEFT pane scrolls too.
   - Scroll is clamped (0 .. max_scroll) where 0 = follow tail/newest.

   Env knobs:
   - IDY_LOG_TABSTOP (default 4) : expand tabs in logs to N spaces.
*/

/* ---------- Sanitization ---------- */

static int env_tabstop(void){
    const char *s = getenv("IDY_LOG_TABSTOP");
    if(!s || !*s) return 4;
    int v = atoi(s);
    if(v < 1) v = 1;
    if(v > 16) v = 16;
    return v;
}

/* Strip ANSI CSI sequences and normalize CR/TAB/control chars.
   - ESC [ ... <final (ASCII @..~)>  is removed entirely.
   - \r\n -> \n ; lone \r -> \n
   - \t -> spaces (tabstop)
   - drop other ASCII control chars except '\n'
*/
static char* sanitize_log_copy(const char *s){
    if(!s) return strdup("");
    size_t n = strlen(s);
    int tabstop = env_tabstop();

    /* Rough upper bound: expand tabs to up to tabstop spaces;
       strip ANSI and most controls, so out <= n*tabstop + 1 is safe. */
    size_t cap = n * (size_t)tabstop + 1;
    char *out = (char*)malloc(cap);
    if(!out) return strdup("");

    const unsigned char *p = (const unsigned char*)s;
    char *w = out;
    int in_esc = 0, in_csi = 0;

    for(size_t i=0;i<n;i++){
        unsigned char ch = p[i];

        if(ch == 0x1B){ // ESC
            in_esc = 1; in_csi = 0;
            continue;
        }
        if(in_esc){
            if(ch == '['){
                in_csi = 1;   // start CSI parameters
                continue;
            }
            // Non-[ escape, drop this one char and finish
            in_esc = 0; in_csi = 0;
            continue;
        }
        if(in_csi){
            // End CSI when we hit a final byte in @..~
            if(ch >= '@' && ch <= '~'){
                in_esc = 0; in_csi = 0;
            }
            continue; // skip all CSI chars
        }

        if(ch == '\r'){
            if(i+1 < n && p[i+1] == '\n'){
                // swallow this CR; the next loop sees '\n'
            } else {
                *w++ = '\n'; // lone CR treated as newline
            }
            continue;
        }
        if(ch == '\n'){
            *w++ = '\n';
            continue;
        }
        if(ch == '\t'){
            for(int k=0;k<tabstop;k++) *w++ = ' ';
            continue;
        }
        if(ch < 32){ // other control chars -> drop
            continue;
        }
        *w++ = (char)ch;
    }
    *w = 0;
    return out;
}

/* ---------- Wrapping & Drawing ----------

   We show a window of L rows with bottom offset = scroll_lines.
   scroll_lines == 0 => last (newest) rows; increases go older.

   Only the FIRST wrapped row of an entry shows the "[HH:MM:SS] LEVEL " prefix.
   Continuations get full width.
*/

static int wrapped_rows_count(const char *san, int cols, int eff_prefix){
    if(cols < 1) cols = 1;
    if(eff_prefix < 0) eff_prefix = 0;
    int first_w = cols - eff_prefix;
    if(first_w < 1) first_w = 1;
    int cont_w  = cols; // continuations use full width

    int rows = 0;
    const char *p = san ? san : "";
    int is_first_visual = 1;

    for(;;){
        const char *nl = strchr(p, '\n');
        size_t len = nl ? (size_t)(nl - p) : strlen(p);
        size_t rem = len;

        int cur_w = is_first_visual ? first_w : cont_w;

        if(rem == 0){
            rows++;                      // empty logical line still consumes one row
            is_first_visual = 0;         // subsequent rows use continuation width
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
        p = nl + 1; // next logical line (still continuation visuals)
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
    if(eff_prefix > cols - 1) eff_prefix = cols - 1; // always leave at least 1 col for content

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
            // draw (or skip) a blank row
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
            // one or more segments for this logical line
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

            // If we ran out of rows but still have content to skip
            while(rem > 0 && skip_rows > 0){
                size_t take = rem > (size_t)cur_w ? (size_t)cur_w : rem;
                skip_rows--; rem -= take;
                cur_w = cont_w;
                is_first_visual = 0;
            }
        }
        if(drawn >= max_rows) break;
        if(!nl) break;
        p = nl + 1; // next logical line (still continuation visuals)
    }
    return drawn;
}

/* ---------- Main draw (now scroll-aware) ---------- */

void tui_draw_logs(tui_t *t, log_level_t filter, const char *status, int *scroll_lines){
    // Left: logs
    werase(t->left); box(t->left,0,0);
    // Right: options + shortcuts
    werase(t->right); box(t->right,0,0);

    log_entry_t *snap=NULL; size_t n=log_snapshot(filter, &snap);
    const int rowsL = getmaxy(t->left)-2;
    const int colsL = getmaxx(t->left)-2;
    const int x0 = 1;
    int y = 1;

    /* First, compute total wrapped rows to clamp scroll */
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

    /* Find start index + intra-entry row skip using backward accumulation
       remaining = rowsL + scroll (counting from the bottom). */
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

    // Draw forward from start_idx
    for(size_t i=start_idx; i<n && y<=rowsL; ++i){
        const log_entry_t *e = &snap[i];
        struct tm tm; time_t sec = e->ts.tv_sec; localtime_r(&sec, &tm);
        char tsbuf[32]; strftime(tsbuf,sizeof(tsbuf),"%H:%M:%S",&tm);

        int pair=0;
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
    wrefresh(t->left);

    // Right pane: options + shortcuts + scroll status
    int rowsR = getmaxy(t->right)-2, colsR = getmaxx(t->right)-2;
    mvwprintw(t->right, 1, 1, "Log Options");
    mvwhline(t->right, 2, 1, ACS_HLINE, colsR);
    mvwprintw(t->right, 3, 2, "Current filter: %s", log_level_name(filter));
    mvwprintw(t->right, 4, 2, "Press 1..5 to filter:");
    mvwprintw(t->right, 5, 4, "[1] TRACE   [2] DEBUG   [3] INFO   [4] WARN   [5] ERROR");

    mvwhline(t->right, 7, 1, ACS_HLINE, colsR);
    mvwprintw(t->right, 7, 3, " Scrolling ");
    mvwprintw(t->right, 8, 2, "↑/↓ : line   PgUp/PgDn : page");
    mvwprintw(t->right, 9, 2, "Home : oldest   End : newest");
    mvwprintw(t->right,10, 2, "Mouse wheel over logs pane");
    mvwprintw(t->right,11, 2, "Offset from newest: %d / %d lines",
              scroll, max_scroll);

    mvwhline(t->right, 13, 1, ACS_HLINE, colsR);
    mvwprintw(t->right, 13, 3, " Shortcuts ");
    int yR = 14;
    mvwprintw(t->right, yR++, 2, "F1: Editor        F2: Logs        F3: Settings");
    mvwprintw(t->right, yR++, 2, "Ctrl-G: Suggest (generate diff)");
    mvwprintw(t->right, yR++, 2, "Ctrl-A: Apply diff");
    mvwprintw(t->right, yR++, 2, "F5: latexmk build (local)");
    mvwprintw(t->right, yR++, 2, "Ctrl-S: Save      Ctrl-Q: Quit");
    mvwprintw(t->right, yR++, 2, "Ctrl-C/V/X: Copy / Paste / Cut");
    mvwprintw(t->right, yR++, 2, "Shift+Arrows: Select text");
    mvwprintw(t->right, yR++, 2, "Backspace/Delete: Delete char");
    wrefresh(t->right);

    tui_draw_status(t->status, status);
    free(snap);
}
