#ifndef PREVIEW_H
#define PREVIEW_H

#ifdef __cplusplus
extern "C" {
#endif

// Build the context preview string for the Settings panel.
//  - cwd: header root displayed at the top
//  - paths: absolute file paths to include
//  - count: number of paths
// Returns a newly allocated string (caller frees).
// If out_lines != NULL, it receives the number of newline characters (for scrolling).
char* preview_build(const char *cwd, char **paths, int count, int *out_lines);

#ifdef __cplusplus
}
#endif
#endif
