#include "editor.h"

static void ensure_cap(buffer_t *b, size_t need){
    if(need <= b->cap) return;
    size_t cap = b->cap ? b->cap*2 : 4096;
    while(cap < need) cap *= 2;
    b->data = (char*)realloc(b->data, cap);
    b->cap = cap;
}

void editor_init(editor_t *e, buffer_t *doc){
    e->doc = doc; e->cursor = 0; e->top_line = 0; e->left_col = 0; e->tabstop = 4;
    e->sel_anchor = e->sel_active = 0;
    e->dirty = false;
}

static int min_i(int a,int b){ return a<b?a:b; }

int editor_total_lines(const buffer_t *doc){
    int lines=1; for(size_t i=0;i<doc->len;i++) if(doc->data[i]=='\n') lines++;
    return lines;
}

size_t editor_line_start_index(const buffer_t *doc, int row){
    size_t idx = 0; int r=0;
    if(row<=0) return 0;
    for(size_t i=0;i<doc->len;i++){
        if(doc->data[i]=='\n'){ r++; if(r==row){ idx=i+1; break; } }
    }
    return idx;
}

void editor_cursor_row_col(const editor_t *e, int *out_row, int *out_col){
    int row=0, col=0;
    for(size_t i=0;i<e->cursor && i<e->doc->len;i++){
        char c = e->doc->data[i];
        if(c=='\n'){ row++; col=0; }
        else col++;
    }
    *out_row=row; *out_col=col;
}

size_t editor_index_from_row_col(const buffer_t *doc, int row, int col){
    size_t idx = editor_line_start_index(doc, row);
    for(int i=0;i<col && idx < doc->len; i++){
        if(doc->data[idx]=='\n') break;
        idx++;
    }
    return idx;
}

void editor_insert_char(editor_t *e, char c){
    buffer_t *b = e->doc;
    ensure_cap(b, b->len + 2);
    memmove(b->data + e->cursor + 1, b->data + e->cursor, b->len - e->cursor + 1);
    b->data[e->cursor] = c;
    e->cursor++; b->len++;
    e->dirty = true;
}

void editor_insert_text(editor_t *e, const char *s){
    if(!s || !*s) return;
    size_t n = strlen(s);
    buffer_t *b = e->doc;
    ensure_cap(b, b->len + n + 1);
    memmove(b->data + e->cursor + n, b->data + e->cursor, b->len - e->cursor + 1);
    memcpy(b->data + e->cursor, s, n);
    e->cursor += n; b->len += n;
    e->dirty = true;
}

void editor_delete_range(editor_t *e, size_t a, size_t b){
    if(a > b) { size_t t=a; a=b; b=t; }
    if(b > e->doc->len) b = e->doc->len;
    if(a >= b) return;
    buffer_t *buf = e->doc;
    memmove(buf->data + a, buf->data + b, buf->len - b + 1);
    buf->len -= (b - a);
    if(e->cursor > a) e->cursor = a;
    e->dirty = true;
}

void editor_delete_selection(editor_t *e){
    size_t a,b; editor_get_selection(e,&a,&b);
    editor_delete_range(e,a,b);
    editor_clear_selection(e);
}

void editor_backspace(editor_t *e){
    if(editor_has_selection(e)){ editor_delete_selection(e); return; }
    if(e->cursor == 0) return;
    buffer_t *b = e->doc;
    memmove(b->data + e->cursor - 1, b->data + e->cursor, b->len - e->cursor + 1);
    e->cursor--; b->len--;
    e->dirty = true;
}

void editor_delete_forward(editor_t *e){
    if(editor_has_selection(e)){ editor_delete_selection(e); return; }
    if(e->cursor >= e->doc->len) return;
    buffer_t *b = e->doc;
    memmove(b->data + e->cursor, b->data + e->cursor + 1, b->len - e->cursor);
    b->len--;
    e->dirty = true;
}

void editor_move_left(editor_t *e){ if(e->cursor>0) e->cursor--; }
void editor_move_right(editor_t *e){ if(e->cursor < e->doc->len) e->cursor++; }

void editor_move_up(editor_t *e){
    int row,col; editor_cursor_row_col(e,&row,&col);
    if(row==0) return;
    int prev_len = (int)(editor_index_from_row_col(e->doc, row, 999999) - editor_line_start_index(e->doc, row));
    int new_col = min_i(col, prev_len);
    e->cursor = editor_index_from_row_col(e->doc, row-1, new_col);
}
void editor_move_down(editor_t *e){
    int rows = editor_total_lines(e->doc);
    int row,col; editor_cursor_row_col(e,&row,&col);
    if(row >= rows-1) return;
    int next_len = (int)(editor_index_from_row_col(e->doc, row+1, 999999) - editor_line_start_index(e->doc, row+1));
    int new_col = min_i(col, next_len);
    e->cursor = editor_index_from_row_col(e->doc, row+1, new_col);
}
void editor_move_home(editor_t *e){
    int row, col; editor_cursor_row_col(e,&row,&col);
    e->cursor = editor_line_start_index(e->doc, row);
}
void editor_move_end(editor_t *e){
    int row, col; editor_cursor_row_col(e,&row,&col);
    e->cursor = editor_index_from_row_col(e->doc, row, 999999);
}

void editor_scroll_lines(editor_t *e, int delta_rows){
    int total = editor_total_lines(e->doc);
    if(total < 1) total = 1;
    int nt = e->top_line + delta_rows;
    if(nt < 0) nt = 0;
    if(nt > total-1) nt = total-1;
    e->top_line = nt;
}

void editor_scroll_cols(editor_t *e, int delta_cols){
    int nl = e->left_col + delta_cols;
    if(nl < 0) nl = 0;
    e->left_col = nl;
}

void editor_click(editor_t *e, int view_y, int view_x, int content_rows, int content_cols){
    (void)content_rows;
    (void)content_cols;
    int target_row = e->top_line + view_y;
    int target_col = e->left_col + view_x;
    e->cursor = editor_index_from_row_col(e->doc, target_row, target_col);
    editor_clear_selection(e);
}

void editor_scroll_into_view(editor_t *e, int cur_row, int cur_col, int rows, int cols){
    if(cur_row < e->top_line) e->top_line = cur_row;
    if(cur_row >= e->top_line + rows) e->top_line = cur_row - rows + 1;
    if(cur_col < e->left_col) e->left_col = cur_col;
    if(cur_col >= e->left_col + cols) e->left_col = cur_col - cols + 1;
}
