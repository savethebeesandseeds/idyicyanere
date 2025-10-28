#ifndef TUI_H
#define TUI_H

#include "idy.h"
#include "editor.h"
#include "log.h"
#include "settings.h"

typedef struct {
    WINDOW *left;
    WINDOW *right;
    WINDOW *status;
    int rows, cols;
    int split_col;   // column where panes split
    bool colors_ready;
    int gutter_cols; // width of the left gutter (line numbers + space)

    // Soft-blink overlay for caret
    bool blink_on;
} tui_t;

/* -------- Color pair constants (kept stable across modules) --------
 * 1..9 are used for diff/log severity (existing).
 * 10  : Borders / rules (white)
 * 11  : General text (soft gray)
 * 12  : Gutter / line numbers (softer gray)
 * 13  : Config key (subtle accent)
 * 14  : Config value (softer than text)
 * 15  : Titles/section headers
 */
#define IDY_PAIR_BORDER   10
#define IDY_PAIR_TEXT     11
#define IDY_PAIR_GUTTER   12
#define IDY_PAIR_CFG_KEY  13
#define IDY_PAIR_CFG_VAL  14
#define IDY_PAIR_TITLE    15

typedef enum {
    SCREEN_EDITOR   = 0,
    SCREEN_LOGS     = 1,
    SCREEN_CONTEXT  = 2   // formerly SCREEN_SETTINGS
} screen_t;

void tui_init(tui_t *t);
void tui_end(void);
void tui_resize(tui_t *t);

// Common status bar painter (exported so draw units can reuse consistently)
void tui_draw_status(WINDOW *w, const char *status);

// Whether to use Unicode tree characters in Context (ASCII fallback if false)
bool tui_unicode_tree_enabled(void);

// Top-level draw entry points (split across compilation units)
void tui_draw_editor(tui_t *t,
                     editor_t *ed,
                     const char *rightbuf,
                     const char *status,
                     const char *filepath); // <-- show current file path in title

// Logs: left pane scroll via *scroll_lines (0 = follow tail / newest)
//       right pane (Config) scroll via *rhs_scroll (0 = top of Config)
void tui_draw_logs(tui_t *t,
                   log_level_t filter,
                   const char *status,
                   int *scroll_lines,
                   int *rhs_scroll);

// Context (formerly "Settings"): left shows directory with checkboxes;
// right shows preview (string) scrolled by ctx_scroll.
void tui_draw_context(tui_t *t,
                      const char *cwd,
                      const file_list_t *fl,
                      int selected,
                      const idy_config_t *cfg,
                      char **ctx_files,
                      int ctx_count,
                      const char *ctx_preview,
                      int ctx_scroll,
                      const char *status);

#endif
