#ifndef CLIPBOARD_H
#define CLIPBOARD_H

#ifdef __cplusplus
extern "C" {
#endif

// Set the internal clipboard and export via OSC-52 to the terminal.
// Accepts NULL to clear. Copies the input; caller retains ownership.
void clipboard_set(const char *s);

// Borrowed pointer to the current clipboard contents (may be NULL).
// Do not free the returned pointer.
const char* clipboard_get(void);

// Free any internal clipboard storage. Call at shutdown.
void clipboard_free(void);

#ifdef __cplusplus
}
#endif
#endif
