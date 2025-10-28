#ifndef EDITOR_H
#define EDITOR_H

#include "idy.h"
#include <stdbool.h>

typedef struct {
    buffer_t *doc;
    size_t cursor;     // byte index in doc->data
    int top_line;      // first visible line index (0-based)
    int left_col;      // first visible column
    int tabstop;       // spaces per TAB

    // Selection
    size_t sel_anchor; // fixed end of selection
    size_t sel_active; // moving end of selection

    // Dirty flag (modified since last save)
    bool dirty;
} editor_t;

void editor_init(editor_t *e, buffer_t *doc);
void editor_insert_char(editor_t *e, char c);
void editor_insert_text(editor_t *e, const char *s);
void editor_delete_range(editor_t *e, size_t a, size_t b);
void editor_delete_selection(editor_t *e);
void editor_backspace(editor_t *e);
void editor_delete_forward(editor_t *e);
void editor_move_left(editor_t *e);
void editor_move_right(editor_t *e);
void editor_move_up(editor_t *e);
void editor_move_down(editor_t *e);
void editor_move_home(editor_t *e);
void editor_move_end(editor_t *e);
void editor_click(editor_t *e, int view_y, int view_x, int content_rows, int content_cols);
void editor_scroll_into_view(editor_t *e, int cur_row, int cur_col, int rows, int cols);

// Helpers to compute cursor's (row,col) in characters, and to fetch line text for drawing.
void editor_cursor_row_col(const editor_t *e, int *out_row, int *out_col);
size_t editor_index_from_row_col(const buffer_t *doc, int row, int col);
size_t editor_line_start_index(const buffer_t *doc, int row);
int editor_total_lines(const buffer_t *doc);

// Viewport panning utilities (do not modify document)
void editor_scroll_lines(editor_t *e, int delta_rows);
void editor_scroll_cols(editor_t *e, int delta_cols);

// Selection helpers
static inline bool editor_has_selection(const editor_t *e){
    return e->sel_anchor != e->sel_active;
}
static inline void editor_clear_selection(editor_t *e){
    e->sel_anchor = e->sel_active = e->cursor;
}
static inline void editor_set_selection(editor_t *e, size_t anchor, size_t active){
    e->sel_anchor = anchor; e->sel_active = active;
}
static inline void editor_get_selection(const editor_t *e, size_t *a, size_t *b){
    size_t x = e->sel_anchor, y = e->sel_active;
    if(x <= y){ *a = x; *b = y; } else { *a = y; *b = x; }
}

#endif
