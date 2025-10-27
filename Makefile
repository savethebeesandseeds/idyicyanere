CC=gcc
CFLAGS=-O2 -Wall -Wextra -std=c11
LDFLAGS=
LIBS=-lncurses -lcurl -ljansson

SRC=src/main.c src/tui.c src/stream.c src/diff_apply.c src/util.c
INC=include

idyicyanere: $(SRC)
	$(CC) $(CFLAGS) -I$(INC) $(SRC) -o $@ $(LIBS) $(LDFLAGS)

clean:
	rm -f idyicyanere
