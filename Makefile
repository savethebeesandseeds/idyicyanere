CC=gcc
CFLAGS=-O2 -Wall -Wextra -std=c11
CPPFLAGS+=-D_GNU_SOURCE
LDFLAGS=
LIBS=-lncurses -lcurl -ljansson

SRC=src/main.c src/stream.c src/diff_apply.c src/util.c src/fsutil.c src/env.c \
    src/log.c src/editor.c src/settings.c src/sha256.c src/buffer.c src/file_context.c \
		src/clipboard.c src/preview.c src/tui_editor.c src/tui_logs.c src/tui_context.c
INC=include


idyicyanere: $(SRC)
	$(CC) $(CFLAGS) $(CPPFLAGS) -I$(INC) $(SRC) -o $@ $(LIBS) $(LDFLAGS)

clean:
	rm -f idyicyanere
