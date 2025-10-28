#include "log.h"
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

static logger_t G;

/* Hard bounds to avoid runaway allocations even if misconfigured */
#define LOG_CAP_MIN 128
#define LOG_CAP_MAX 65536

static char* vformat(const char *fmt, va_list ap){
    va_list ap2; va_copy(ap2, ap);
    int n = vsnprintf(NULL, 0, fmt, ap2); va_end(ap2);
    if(n<0) return NULL;
    char *s = (char*)malloc((size_t)n+1);
    vsnprintf(s, (size_t)n+1, fmt, ap);
    return s;
}

void log_init(size_t capacity){
    if(capacity < LOG_CAP_MIN) capacity = LOG_CAP_MIN;
    if(capacity > LOG_CAP_MAX) capacity = LOG_CAP_MAX;
    memset(&G,0,sizeof(G));
    G.cap = capacity;
    G.min_level = LOG_INFO;
    G.v = (log_entry_t*)calloc(G.cap, sizeof(log_entry_t));
}

void log_shutdown(void){
    if(!G.v) return;
    for(size_t i=0;i<G.cap;i++) if(G.v[i].msg) free((void*)G.v[i].msg);
    free(G.v); memset(&G,0,sizeof(G));
}

void log_set_level(log_level_t lvl){ G.min_level = lvl; }
log_level_t log_get_level(void){ return G.min_level; }

const char* log_level_name(log_level_t lvl){
    switch(lvl){
        case LOG_TRACE: return "TRACE";
        case LOG_DEBUG: return "DEBUG";
        case LOG_INFO:  return "INFO";
        case LOG_WARN:  return "WARN";
        case LOG_ERROR: return "ERROR";
        default: return "?";
    }
}

void log_msg_(log_level_t lvl, const char *file, int line, const char *fmt, ...){
    if(!G.v) log_init(LOG_CAP_MIN);
    struct timespec ts;
    timespec_get(&ts, TIME_UTC); // C11; avoids CLOCK_REALTIME portability issues
    va_list ap; va_start(ap, fmt);
    char *s = vformat(fmt, ap);
    va_end(ap);

    size_t i = G.head % G.cap;
    if(G.v[i].msg) free((void*)G.v[i].msg);
    G.v[i].level = lvl; G.v[i].ts = ts;
    G.v[i].src_file = file; G.v[i].src_line = line; G.v[i].msg = s;

    G.head = (G.head + 1) % G.cap;
    if(G.count < G.cap) G.count++;
}

size_t log_snapshot(log_level_t filter, log_entry_t **out){
    if(!G.v){ *out=NULL; return 0; }
    // First compute how many meet the filter
    size_t n_ok=0;
    for(size_t k=0;k<G.count;k++){
        size_t idx = (G.head + G.cap - G.count + k) % G.cap;
        if(G.v[idx].level >= filter) n_ok++;
    }
    *out = (log_entry_t*)malloc(sizeof(log_entry_t)*n_ok);
    size_t w=0;
    for(size_t k=0;k<G.count;k++){
        size_t idx = (G.head + G.cap - G.count + k) % G.cap;
        if(G.v[idx].level >= filter){ (*out)[w++] = G.v[idx]; }
    }
    return n_ok;
}
