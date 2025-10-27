#ifndef TUI_H
#define TUI_H
#include "idy.h"
#include "stream.h"

typedef struct {
    WINDOW *left;   // document
    WINDOW *right;  // stream/diff
    WINDOW *status;
    int rows, cols;
} tui_t;

void tui_init(tui_t *t);
void tui_draw(tui_t *t, buffer_t *doc, const char *rightbuf, const char *status);
void tui_end(void);

#endif
