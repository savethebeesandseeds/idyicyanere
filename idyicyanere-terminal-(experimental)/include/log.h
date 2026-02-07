#ifndef LOG_H
#define LOG_H

#include <stdarg.h>
#include <stddef.h>
#include <time.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    LOG_TRACE = 0,
    LOG_DEBUG = 1,
    LOG_INFO  = 2,
    LOG_WARN  = 3,
    LOG_ERROR = 4
} log_level_t;

typedef struct {
    log_level_t level;
    struct timespec ts;
    const char *src_file;
    int src_line;
    const char *msg;   // owned by logger
} log_entry_t;

typedef struct {
    size_t cap;        // ring capacity
    size_t count;      // number of valid items (<= cap)
    size_t head;       // next write index
    log_level_t min_level;
    log_entry_t *v;    // ring storage
} logger_t;

void log_init(size_t capacity);
void log_shutdown(void);
void log_set_level(log_level_t lvl);
log_level_t log_get_level(void);
const char* log_level_name(log_level_t lvl);

// Adds a message (printf-style). Message is owned by logger and freed when overwritten.
void log_msg_(log_level_t lvl, const char *file, int line, const char *fmt, ...);

// Snapshot: returns a heap-allocated array (shallow copies) of entries >= filter.
// Return value is count; *out receives pointer; caller frees the array (not strings).
size_t log_snapshot(log_level_t filter, log_entry_t **out);

#define LOG_TRACE(...) log_msg_(LOG_TRACE,__FILE__,__LINE__,__VA_ARGS__)
#define LOG_DEBUG(...) log_msg_(LOG_DEBUG,__FILE__,__LINE__,__VA_ARGS__)
#define LOG_INFO(...)  log_msg_(LOG_INFO, __FILE__,__LINE__,__VA_ARGS__)
#define LOG_WARN(...)  log_msg_(LOG_WARN, __FILE__,__LINE__,__VA_ARGS__)
#define LOG_ERROR(...) log_msg_(LOG_ERROR,__FILE__,__LINE__,__VA_ARGS__)

#ifdef __cplusplus
}
#endif
#endif
