/* stream.c */
#include "stream.h"
#include "log.h"

#include <ctype.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>

/* ===================== Internal: SSE accumulator ===================== */

typedef struct {
    stream_ctx_t *ctx;
    char *buf; size_t len, cap;
    size_t total_bytes;
    int events;
    int data_chunks;
    bool saw_done;
} sse_accum_t;

/* ===================== Internal: String helpers ===================== */

static char* strdup_trim(const char *s){
    if(!s) return NULL;
    const char *p = s;
    while(*p && isspace((unsigned char)*p)) p++;
    const char *end = p + strlen(p);
    while(end>p && isspace((unsigned char)end[-1])) end--;
    size_t n = (size_t)(end - p);
    char *out = (char*)malloc(n+1);
    if(!out) return NULL;
    memcpy(out, p, n); out[n]=0;
    return out;
}

/* ===================== Internal: cURL verbose routing ===================== */

static int curl_debug_cb(CURL *handle, curl_infotype type, char *data, size_t size, void *userp){
    (void)handle; (void)userp;
    switch(type){
        case CURLINFO_TEXT:          LOG_TRACE("[curl] %.*s", (int)size, data); break;
        case CURLINFO_HEADER_OUT:    LOG_TRACE("[curl] > %.*s", (int)size, data); break;
        case CURLINFO_HEADER_IN:     LOG_TRACE("[curl] < %.*s", (int)size, data); break;
        case CURLINFO_DATA_OUT:      LOG_TRACE("[curl] sent %zu bytes", size); break;
        case CURLINFO_DATA_IN:       LOG_TRACE("[curl] recv %zu bytes", size); break;
        case CURLINFO_SSL_DATA_OUT:  LOG_TRACE("[curl] ssl out %zu bytes", size); break;
        case CURLINFO_SSL_DATA_IN:   LOG_TRACE("[curl] ssl in %zu bytes", size); break;
        default: break;
    }
    return 0;
}

/* ===================== Internal: TLS/CA helpers ===================== */

typedef struct {
    char *cainfo;  // may be NULL if libcurl default used
    char *capath;  // may be NULL if libcurl default used
} ca_refs_t;

static ca_refs_t apply_ca_options(CURL *curl){
    ca_refs_t refs = (ca_refs_t){0};

    char *ca      = idy_getenv_trimdup("IDY_CAINFO");
    char *capath  = idy_getenv_trimdup("IDY_CAPATH");
    char *ca_env  = idy_getenv_trimdup("CURL_CA_BUNDLE");
    char *ssl_file= idy_getenv_trimdup("SSL_CERT_FILE");
    char *ssl_dir = idy_getenv_trimdup("SSL_CERT_DIR");

    const char *chosen_cainfo = NULL;
    const char *chosen_capath = NULL;

    if(ca){ curl_easy_setopt(curl, CURLOPT_CAINFO, ca); refs.cainfo = ca; chosen_cainfo = ca; ca=NULL; }
    else if(ca_env){ curl_easy_setopt(curl, CURLOPT_CAINFO, ca_env); refs.cainfo = ca_env; chosen_cainfo = ca_env; ca_env=NULL; }
    else if(ssl_file){ curl_easy_setopt(curl, CURLOPT_CAINFO, ssl_file); refs.cainfo = ssl_file; chosen_cainfo = ssl_file; ssl_file=NULL; }

    if(capath){ curl_easy_setopt(curl, CURLOPT_CAPATH, capath); refs.capath = capath; chosen_capath = capath; capath=NULL; }
    else if(ssl_dir){ curl_easy_setopt(curl, CURLOPT_CAPATH, ssl_dir); refs.capath = ssl_dir; chosen_capath = ssl_dir; ssl_dir=NULL; }

    const curl_version_info_data *vi = curl_version_info(CURLVERSION_NOW);
    LOG_TRACE("TLS backend: %s", (vi && vi->ssl_version) ? vi->ssl_version : "(unknown)");
    LOG_TRACE("TLS CA settings: CAINFO=%s  CAPATH=%s",
              chosen_cainfo ? chosen_cainfo : "(libcurl default)",
              chosen_capath ? chosen_capath : "(libcurl default)");

    // Debug-only override (strict truthy)
    if(idy_env_truthy("IDY_CURL_INSECURE")){
        curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
        curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);
        LOG_WARN("TLS verification DISABLED via IDY_CURL_INSECURE=1 (debug only)");
    }

    // release any unselected temporary strings
    free(ca); free(capath); free(ca_env); free(ssl_file); free(ssl_dir);
    return refs;
}

/* ===================== Internal: URL & payload builders ===================== */

static char* build_base_url(const idy_config_t *cfg){
    const char *raw = (cfg && cfg->base_url) ? cfg->base_url : "";
    char *trim = strdup_trim(raw);
    if(!trim || !*trim){
        free(trim);
        return strdup("https://api.openai.com/v1");
    }
    return trim; // owned by caller
}

static void build_chat_completions_url(char *dst, size_t dstsz, const char *base){
    size_t blen = strlen(base);
    snprintf(dst, dstsz, "%s%schat/completions", base, (blen>0 && base[blen-1]=='/') ? "" : "/");
}

static char* build_chat_payload(const idy_config_t *cfg,
                                const char *system_prompt,
                                const char *user_content)
{
    const char *model = (cfg && cfg->model && *cfg->model) ? cfg->model : "gpt-4o-mini";
    json_t *root = json_object();
    json_object_set_new(root, "model", json_string(model));
    json_object_set_new(root, "stream", json_true());

    json_t *messages = json_array();
    const char *sys = (system_prompt && *system_prompt) ? system_prompt
                    : "Return ONLY a unified diff patch"; // generic fallback
    json_array_append_new(messages, json_pack("{ssss}", "role","system","content",sys));

    const char *ucont = (user_content && *user_content) ? user_content : "";
    json_array_append_new(messages, json_pack("{ssss}", "role","user","content",ucont));
    json_object_set_new(root, "messages", messages);

    // stream_options for final usage in stream (some stacks support this)
    json_t *stream_opts = json_object();
    json_object_set_new(stream_opts, "include_usage", json_true());
    json_object_set_new(root, "stream_options", stream_opts);

    char *payload = json_dumps(root, 0);
    json_decref(root);
    return payload; // owned by caller
}

/* NEW: build payload with multiple user messages */
static char* build_chat_payload_multi(const idy_config_t *cfg,
                                      const char *system_prompt,
                                      const char **user_msgs,
                                      int user_msgs_count)
{
    const char *model = (cfg && cfg->model && *cfg->model) ? cfg->model : "gpt-4o-mini";
    json_t *root = json_object();
    json_object_set_new(root, "model", json_string(model));
    json_object_set_new(root, "stream", json_true());

    json_t *messages = json_array();
    const char *sys = (system_prompt && *system_prompt) ? system_prompt
                    : "Return ONLY a unified diff patch";
    json_array_append_new(messages, json_pack("{ssss}", "role","system","content",sys));

    for(int i=0;i<user_msgs_count;i++){
        const char *u = (user_msgs && user_msgs[i]) ? user_msgs[i] : "";
        json_array_append_new(messages, json_pack("{ssss}", "role","user","content",u));
    }
    json_object_set_new(root, "messages", messages);

    json_t *stream_opts = json_object();
    json_object_set_new(stream_opts, "include_usage", json_true());
    json_object_set_new(root, "stream_options", stream_opts);

    char *payload = json_dumps(root, 0);
    json_decref(root);
    return payload; // owned by caller
}

/* ===================== Internal: SSE event parsing ===================== */

static void handle_sse_payload_line(sse_accum_t *acc, const char *payload){
    // DONE sentinel
    if(strcmp(payload, "[DONE]")==0){
        acc->saw_done = true;
        if(acc->ctx->on_done) acc->ctx->on_done(NULL, acc->ctx->user);
        return;
    }

    // JSON chunk
    json_error_t jerr;
    json_t *j = json_loads(payload, 0, &jerr);
    if(!j){
        LOG_TRACE("SSE JSON parse error at pos %d: %s", jerr.position, jerr.text);
        return;
    }

    // Streamed token
    json_t *choices = json_object_get(j, "choices");
    if(json_is_array(choices) && json_array_size(choices)>0){
        json_t *c0 = json_array_get(choices, 0);
        json_t *delta = json_object_get(c0, "delta");
        if(json_is_object(delta)){
            json_t *cont = json_object_get(delta, "content");
            if(json_is_string(cont) && acc->ctx->on_delta){
                acc->ctx->on_delta(json_string_value(cont), acc->ctx->user);
            }
        }
    }

    // Optional usage (may arrive at the end or intermixed on some stacks)
    json_t *usage = json_object_get(j, "usage");
    if(usage && acc->ctx->on_done){
        acc->ctx->on_done(usage, acc->ctx->user);
    }

    json_decref(j);
}

/* cURL write callback: accumulate and parse SSE frames. */
static size_t on_write(char *ptr, size_t size, size_t nmemb, void *userdata){
    sse_accum_t *acc = (sse_accum_t*)userdata;
    size_t n = size*nmemb;
    acc->total_bytes += n;
    if(acc->len + n + 1 > acc->cap){
        size_t nc = acc->cap? acc->cap*2:8192; while(nc < acc->len+n+1) nc*=2;
        acc->buf = realloc(acc->buf, nc); acc->cap = nc;
    }
    memcpy(acc->buf+acc->len, ptr, n); acc->len += n; acc->buf[acc->len]=0;

    // Process complete SSE events (accept LF and CRLF delimiters)
    char *start = acc->buf;
    for(;;){
        char *sep_lf   = strstr(start, "\n\n");
        char *sep_crlf = strstr(start, "\r\n\r\n");
        char *sep = NULL; size_t sep_len = 0;
        if(sep_lf && sep_crlf){ sep = (sep_lf < sep_crlf) ? sep_lf : sep_crlf; sep_len = (sep==sep_crlf)?4:2; }
        else if(sep_lf){ sep = sep_lf; sep_len = 2; }
        else if(sep_crlf){ sep = sep_crlf; sep_len = 4; }
        if(!sep) break;
        *sep = 0; acc->events++;

        // Each event may contain multiple "data:" lines
        char *line = start;
        while(line && *line){
            char *eol = strstr(line, "\n");
            if(eol) *eol = 0;
            size_t ll = strlen(line);
            if(ll>0 && line[ll-1]=='\r') line[ll-1] = 0; // trim CR (CRLF)

            if(strncmp(line, "data:", 5)==0){
                const char *payload = line+5; if(*payload==' ') payload++;
                acc->data_chunks++;
                handle_sse_payload_line(acc, payload);
            }
            if(!eol) break;
            line = eol+1;
        }
        start = sep + sep_len; // skip blank line(s)
    }

    // Compact processed data
    size_t consumed = (size_t)(start - acc->buf);
    if(consumed){
        memmove(acc->buf, start, acc->len - consumed + 1);
        acc->len -= consumed;
    }
    return n;
}

/* ===================== Internal: cURL setup & execution ===================== */

typedef struct {
    CURL *curl;
    struct curl_slist *hdrs;
    sse_accum_t acc;
    ca_refs_t ca_refs;
} http_handles_t;

static void http_handles_init(http_handles_t *h, stream_ctx_t *ctx){
    memset(h, 0, sizeof(*h));
    h->curl = curl_easy_init();
    h->acc = (sse_accum_t){ .ctx=ctx };
}

static void http_handles_cleanup(http_handles_t *h, char *payload){
    free(h->acc.buf);
    curl_slist_free_all(h->hdrs);
    free(payload);
    if(h->curl) curl_easy_cleanup(h->curl);
    free(h->ca_refs.cainfo);
    free(h->ca_refs.capath);
}

static void setup_common_headers(http_handles_t *h, const stream_ctx_t *ctx){
    h->hdrs = curl_slist_append(h->hdrs, "Content-Type: application/json");
    h->hdrs = curl_slist_append(h->hdrs, "Accept: text/event-stream");
    char auth[512]; snprintf(auth, sizeof(auth), "Authorization: Bearer %s", ctx->cfg->api_key);
    h->hdrs = curl_slist_append(h->hdrs, auth);
}

static void setup_common_curl_opts(http_handles_t *h, const char *url, const char *payload){
    curl_easy_setopt(h->curl, CURLOPT_URL, url);
    curl_easy_setopt(h->curl, CURLOPT_HTTPHEADER, h->hdrs);
    curl_easy_setopt(h->curl, CURLOPT_POSTFIELDS, payload);
    curl_easy_setopt(h->curl, CURLOPT_WRITEFUNCTION, on_write);
    curl_easy_setopt(h->curl, CURLOPT_WRITEDATA, &h->acc);
    curl_easy_setopt(h->curl, CURLOPT_TCP_KEEPALIVE, 1L);
    curl_easy_setopt(h->curl, CURLOPT_TIMEOUT, 180L);
    curl_easy_setopt(h->curl, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(h->curl, CURLOPT_USERAGENT, "idyicyanere/0.1 (libcurl)");
    curl_easy_setopt(h->curl, CURLOPT_NOPROGRESS, 1L); // don't buffer

    if(idy_env_truthy("IDY_CURL_VERBOSE")){
        curl_easy_setopt(h->curl, CURLOPT_VERBOSE, 1L);
        // Route verbose output into our logger to avoid corrupting ncurses output.
        curl_easy_setopt(h->curl, CURLOPT_DEBUGFUNCTION, curl_debug_cb);
    }
}

static int setup_http_version(CURL *curl){
    int want_h2 = idy_env_truthy("IDY_HTTP2");  // set IDY_HTTP2=1 to try HTTP/2
    if(want_h2){
#ifdef CURL_HTTP_VERSION_2TLS
        curl_easy_setopt(curl, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_2TLS);
#else
        curl_easy_setopt(curl, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_2_0);
#endif
        LOG_TRACE("HTTP version requested: HTTP/2 (via IDY_HTTP2=1)");
    } else {
        curl_easy_setopt(curl, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_1_1);
        LOG_TRACE("HTTP version: HTTP/1.1 (default for SSE)");
    }
    return want_h2;
}

static bool perform_with_h2_fallback(http_handles_t *h, int want_h2, const char *url){
    CURLcode rc = curl_easy_perform(h->curl);
    long http_code = 0; curl_easy_getinfo(h->curl, CURLINFO_RESPONSE_CODE, &http_code);
#ifdef CURLINFO_SSL_VERIFYRESULT
    long vres = 0; curl_easy_getinfo(h->curl, CURLINFO_SSL_VERIFYRESULT, &vres);
    LOG_TRACE("TLS verify result (backend-specific): %ld", vres);
#endif

    if(want_h2 && (rc == CURLE_HTTP2 || rc == CURLE_HTTP2_STREAM || http_code == 0)){
        LOG_WARN("HTTP/2 streaming failed (rc=%d, http=%ld). Retrying with HTTP/1.1…", (int)rc, http_code);
        curl_easy_setopt(h->curl, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_1_1);
        // reset accumulator
        free(h->acc.buf); h->acc.buf=NULL; h->acc.len=0; h->acc.cap=0; h->acc.total_bytes=0; h->acc.events=0; h->acc.data_chunks=0; h->acc.saw_done=false;
        rc = curl_easy_perform(h->curl);
        curl_easy_getinfo(h->curl, CURLINFO_RESPONSE_CODE, &http_code);
    }

    bool ok = (rc == CURLE_OK) && (http_code >= 200 && http_code < 300);
    if(!ok){
        if(rc != CURLE_OK){
            LOG_ERROR("Suggest stream: cURL error on %s: %s", url, curl_easy_strerror(rc));
        }
        if(http_code < 200 || http_code >= 300){
            LOG_ERROR("Suggest stream: HTTP %ld from %s", http_code, url);
            if(h->acc.len > 0 && h->acc.buf){
                json_error_t jerr; json_t *j = json_loads(h->acc.buf, 0, &jerr);
                if(j){
                    json_t *er = json_object_get(j, "error");
                    if(er){
                        const char *etype = json_string_value(json_object_get(er,"type"));
                        const char *emsg  = json_string_value(json_object_get(er,"message"));
                        json_t *ecode = json_object_get(er,"code");
                        if(ecode && json_is_integer(ecode))
                            LOG_ERROR("API error: type=%s code=%lld message=%s",
                                      etype?etype:"(null)", (long long)json_integer_value(ecode), emsg?emsg:"(null)");
                        else
                            LOG_ERROR("API error: type=%s message=%s", etype?etype:"(null)", emsg?emsg:"(null)");
                    } else {
                        LOG_ERROR("HTTP %ld body (truncated): %.400s", http_code, h->acc.buf);
                    }
                    json_decref(j);
                } else {
                    LOG_ERROR("HTTP %ld raw body (truncated): %.400s", http_code, h->acc.buf);
                }
            }
        }
    } else {
        LOG_TRACE("Suggest stream OK: http=%ld bytes=%zu events=%d data_chunks=%d saw_done=%d",
                  http_code, h->acc.total_bytes, h->acc.events, h->acc.data_chunks, h->acc.saw_done?1:0);
    }
    return ok;
}

/* ===================== Public API impls ===================== */

bool openai_stream_chat(stream_ctx_t *ctx,
                        const char *system_prompt,
                        const char *user_content)
{
    if(!ctx || !ctx->cfg || !ctx->cfg->api_key){
        LOG_ERROR("openai_stream_chat: missing ctx/cfg/api_key");
        return false;
    }

    // Build URL pieces & payload
    char *base = build_base_url(ctx->cfg);
    char url[512]; build_chat_completions_url(url, sizeof(url), base);
    char *payload = build_chat_payload(ctx->cfg, system_prompt, user_content);

    LOG_DEBUG("Request body : %s", payload);

    // HTTP handles
    http_handles_t hh; http_handles_init(&hh, ctx);
    if(!hh.curl){ free(base); free(payload); return false; }

    setup_common_headers(&hh, ctx);
    setup_common_curl_opts(&hh, url, payload);

    // TLS/CA settings + diagnostics (returns owned refs for later free)
    hh.ca_refs = apply_ca_options(hh.curl);

    int want_h2 = setup_http_version(hh.curl);
    LOG_TRACE("Suggest stream: POST %s (model=%s)", url,
              (ctx->cfg->model && *ctx->cfg->model) ? ctx->cfg->model : "gpt-4o-mini");

    bool ok = perform_with_h2_fallback(&hh, want_h2, url);

    free(base);
    http_handles_cleanup(&hh, payload);
    return ok;
}

bool openai_stream_chat_multi(stream_ctx_t *ctx,
                              const char *system_prompt,
                              const char **user_msgs,
                              int user_msgs_count)
{
    if(!ctx || !ctx->cfg || !ctx->cfg->api_key){
        LOG_ERROR("openai_stream_chat_multi: missing ctx/cfg/api_key");
        return false;
    }
    if(user_msgs_count < 0) user_msgs_count = 0;

    // Build URL pieces & payload
    char *base = build_base_url(ctx->cfg);
    char url[512]; build_chat_completions_url(url, sizeof(url), base);
    char *payload = build_chat_payload_multi(ctx->cfg, system_prompt, user_msgs, user_msgs_count);

    LOG_DEBUG("Request body : %s", payload);

    // HTTP handles
    http_handles_t hh; http_handles_init(&hh, ctx);
    if(!hh.curl){ free(base); free(payload); return false; }

    setup_common_headers(&hh, ctx);
    setup_common_curl_opts(&hh, url, payload);

    // TLS/CA settings + diagnostics
    hh.ca_refs = apply_ca_options(hh.curl);

    int want_h2 = setup_http_version(hh.curl);
    LOG_TRACE("Suggest stream (multi): POST %s (model=%s)", url,
              (ctx->cfg->model && *ctx->cfg->model) ? ctx->cfg->model : "gpt-4o-mini");

    bool ok = perform_with_h2_fallback(&hh, want_h2, url);

    free(base);
    http_handles_cleanup(&hh, payload);
    return ok;
}

static char *dup_truncated(const char *s, size_t max_bytes){
    if(!s) s = "";
    size_t n = strlen(s);
    if(n <= max_bytes){
        char *out = malloc(n + 1);
        if(out){ memcpy(out, s, n + 1); }
        return out;
    }
    // leave a small marker to signal truncation
    static const char *marker = "\n[...truncated...]";
    size_t mlen = strlen(marker);
    size_t keep = (max_bytes > mlen) ? (max_bytes - mlen) : 0;
    char *out = malloc(keep + mlen + 1);
    if(!out) return NULL;
    if(keep) memcpy(out, s, keep);
    memcpy(out + keep, marker, mlen + 1);
    return out;
}

bool openai_stream_unified_diff(stream_ctx_t *ctx,
                                const char *original,
                                const char *context,
                                const char *section_hint)
{
    if(!ctx){
        LOG_ERROR("openai_stream_unified_diff: ctx is NULL");
        return false;
    }

    const char *sys =
        (ctx->cfg && ctx->cfg->system_prompt_unified_diff &&
         *ctx->cfg->system_prompt_unified_diff)
            ? ctx->cfg->system_prompt_unified_diff
            : "Return ONLY a unified diff patch. No prose, no code fences.";

    // Effective caps: prefer cfg-provided values if nonzero; fall back to defaults
    size_t max_orig = (ctx->cfg && ctx->cfg->prompt_max_orig) ? ctx->cfg->prompt_max_orig : IDY_PROMPT_MAX_ORIG;
    size_t max_ctx  = (ctx->cfg && ctx->cfg->prompt_max_ctx)  ? ctx->cfg->prompt_max_ctx  : IDY_PROMPT_MAX_CTX;
    LOG_TRACE("openai_stream_unified_diff: caps orig=%zu, ctx=%zu", max_orig, max_ctx);

    // Prepare bounded slices
    char *orig_bounded = dup_truncated(original, max_orig);
    char *ctx_bounded  = context ? dup_truncated(context,  max_ctx) : NULL;
    if(!orig_bounded || (context && !ctx_bounded)){
        LOG_ERROR("openai_stream_unified_diff: allocation failed");
        free(orig_bounded);
        free(ctx_bounded);
        return false;
    }

    // Build user message list in order: [SECTION?] [CONTEXT?] [ORIGINAL]
    char *m_section = NULL, *m_context = NULL, *m_original = NULL;
    if(section_hint && *section_hint) {
        if(asprintf(&m_section, "SECTION: %s", section_hint) < 0) m_section = NULL;
    }
    if(ctx_bounded && *ctx_bounded){
        if(asprintf(&m_context, "CONTEXT:\n%s", ctx_bounded) < 0) m_context = NULL;
    }
    if(asprintf(&m_original, "NOTE: The ORIGINAL below is a line-numbered view (\"<N>| \"). Strip that prefix when producing the unified diff.\nORIGINAL:\n%s", orig_bounded) < 0) m_original = NULL;


    free(orig_bounded);
    free(ctx_bounded);

    if(!m_original){
        free(m_section); free(m_context);
        LOG_ERROR("openai_stream_unified_diff: asprintf failed");
        return false;
    }

    const char *msgs[3];
    int n = 0;
    if(m_section) msgs[n++] = m_section;
    if(m_context) msgs[n++] = m_context;
    msgs[n++] = m_original;

    bool ok = openai_stream_chat_multi(ctx, sys, msgs, n);

    free(m_section);
    free(m_context);
    free(m_original);
    return ok;
}
