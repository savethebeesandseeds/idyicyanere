#include "stream.h"
#include "log.h"
#include <ctype.h>
#include <string.h>

/* ===================== Streaming client (SSE) ===================== */

typedef struct {
    stream_ctx_t *ctx;
    char *buf; size_t len, cap;
    size_t total_bytes;
    int events;
    int data_chunks;
    bool saw_done;
} sse_accum_t;

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
                if(strcmp(payload, "[DONE]")==0){
                    acc->saw_done = true;
                    if(acc->ctx->on_done) acc->ctx->on_done(NULL, acc->ctx->user);
                } else {
                    json_error_t jerr;
                    json_t *j = json_loads(payload, 0, &jerr);
                    if(j){
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
                        json_t *usage = json_object_get(j, "usage");
                        if(usage && acc->ctx->on_done){
                            acc->ctx->on_done(usage, acc->ctx->user);
                        }
                        json_decref(j);
                    } else {
                        LOG_DEBUG("SSE JSON parse error at pos %d: %s", jerr.position, jerr.text);
                    }
                }
            }
            if(!eol) break;
            line = eol+1;
        }
        start = sep + sep_len; // skip blank line(s)
    }

    // Compact processed data
    size_t consumed = start - acc->buf;
    if(consumed){
        memmove(acc->buf, start, acc->len - consumed + 1);
        acc->len -= consumed;
    }
    return n;
}

/* ---------------------- String helpers ---------------------- */

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

/* ---------------------- cURL debug routing ---------------------- */
static int curl_debug_cb(CURL *handle, curl_infotype type, char *data, size_t size, void *userp){
    (void)handle; (void)userp;
    switch(type){
        case CURLINFO_TEXT:
            // Informational line from cURL internals
            LOG_DEBUG("[curl] %.*s", (int)size, data);
            break;
        case CURLINFO_HEADER_OUT:
            LOG_TRACE("[curl] > %.*s", (int)size, data);
            break;
        case CURLINFO_HEADER_IN:
            LOG_TRACE("[curl] < %.*s", (int)size, data);
            break;
        case CURLINFO_DATA_OUT:
            LOG_TRACE("[curl] sent %zu bytes", size);
            break;
        case CURLINFO_DATA_IN:
            LOG_TRACE("[curl] recv %zu bytes", size);
            break;
        case CURLINFO_SSL_DATA_OUT:
            LOG_TRACE("[curl] ssl out %zu bytes", size);
            break;
        case CURLINFO_SSL_DATA_IN:
            LOG_TRACE("[curl] ssl in %zu bytes", size);
            break;
        default:
            break;
    }
    return 0;
}

/* ---------------------- TLS/CA helpers ---------------------- */
/* We keep allocated copies of any chosen CA strings and return them
   so they can be freed AFTER the request finishes. */
typedef struct {
    char *cainfo;  // may be NULL if libcurl default used
    char *capath;  // may be NULL if libcurl default used
} ca_refs_t;

static ca_refs_t apply_ca_options(CURL *curl){
    ca_refs_t refs = {0};

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
    LOG_DEBUG("TLS backend: %s", (vi && vi->ssl_version) ? vi->ssl_version : "(unknown)");
    LOG_DEBUG("TLS CA settings: CAINFO=%s  CAPATH=%s",
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

/* ---------------------- Main entry ---------------------- */

bool openai_stream_unified_diff(stream_ctx_t *ctx,
                                const char *original,
                                const char *section_hint)
{
    CURL *curl = curl_easy_init();
    if(!curl) return false;

    // Base URL (default if unset/blank). Trim whitespace/newlines.
    char *base_trim = strdup_trim(ctx->cfg->base_url ? ctx->cfg->base_url : "");
    const char *base = (!base_trim || !*base_trim) ? "https://api.openai.com/v1" : base_trim;

    char url[512];
    size_t blen = strlen(base);
    snprintf(url, sizeof(url), "%s%schat/completions", base, (blen>0 && base[blen-1]=='/') ? "" : "/");

    // Construct JSON body
    json_t *root = json_object();
    const char *model = (ctx->cfg->model && *ctx->cfg->model) ? ctx->cfg->model : "gpt-4o-mini";
    json_object_set_new(root, "model", json_string(model));
    json_object_set_new(root, "stream", json_true());

    json_t *messages = json_array();
    const char *sys = ctx->cfg->system_prompt ? ctx->cfg->system_prompt :
        "You are a scientific writing copilot. Return ONLY a unified diff patch "
        "(---/+++ headers and @@ hunks) for the ORIGINAL text I provide. Keep LaTeX valid.";
    json_array_append_new(messages, json_pack("{ssss}", "role","system","content",sys));

    char *user;
    if(section_hint && *section_hint)
        asprintf(&user, "SECTION: %s\nORIGINAL:\n%s", section_hint, original);
    else
        asprintf(&user, "ORIGINAL:\n%s", original);
    json_array_append_new(messages, json_pack("{ssss}", "role","user","content",user));
    free(user);
    json_object_set_new(root, "messages", messages);

    // stream_options for final usage in stream (some stacks support this)
    json_t *stream_opts = json_object(); json_object_set_new(stream_opts, "include_usage", json_true());
    json_object_set_new(root, "stream_options", stream_opts);

    char *payload = json_dumps(root, 0);
    json_decref(root);

    struct curl_slist *hdrs=NULL;
    hdrs = curl_slist_append(hdrs, "Content-Type: application/json");
    hdrs = curl_slist_append(hdrs, "Accept: text/event-stream");
    char auth[512]; snprintf(auth, sizeof(auth), "Authorization: Bearer %s", ctx->cfg->api_key);
    hdrs = curl_slist_append(hdrs, auth);

    sse_accum_t acc = { .ctx=ctx, .buf=NULL, .len=0, .cap=0, .total_bytes=0, .events=0, .data_chunks=0, .saw_done=false };

    curl_easy_setopt(curl, CURLOPT_URL, url);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, hdrs);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, payload);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, on_write);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &acc);
    curl_easy_setopt(curl, CURLOPT_TCP_KEEPALIVE, 1L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 180L);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl, CURLOPT_USERAGENT, "idyicyanere/0.1 (libcurl)");
    if(idy_env_truthy("IDY_CURL_VERBOSE")){
        curl_easy_setopt(curl, CURLOPT_VERBOSE, 1L);
        // Route verbose output into our logger to avoid corrupting ncurses output.
        curl_easy_setopt(curl, CURLOPT_DEBUGFUNCTION, curl_debug_cb);
    }
    curl_easy_setopt(curl, CURLOPT_NOPROGRESS, 1L); // don't buffer

    // ---- Prefer HTTP/1.1 for SSE; allow opt-in to HTTP/2 and fallback on errors ----
    int want_h2 = idy_env_truthy("IDY_HTTP2");  // set IDY_HTTP2=1 to try HTTP/2
    if(want_h2){
#ifdef CURL_HTTP_VERSION_2TLS
        curl_easy_setopt(curl, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_2TLS);
#else
        curl_easy_setopt(curl, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_2_0);
#endif
        LOG_DEBUG("HTTP version requested: HTTP/2 (via IDY_HTTP2=1)");
    } else {
        curl_easy_setopt(curl, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_1_1);
        LOG_DEBUG("HTTP version: HTTP/1.1 (default for SSE)");
    }

    // TLS/CA settings + diagnostics (returns owned refs for later free)
    ca_refs_t ca_refs = apply_ca_options(curl);

    LOG_DEBUG("Suggest stream: POST %s (model=%s)", url, model);

    CURLcode rc = curl_easy_perform(curl);
    long http_code = 0; curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);
#ifdef CURLINFO_SSL_VERIFYRESULT
    long vres = 0; curl_easy_getinfo(curl, CURLINFO_SSL_VERIFYRESULT, &vres);
    LOG_DEBUG("TLS verify result (backend-specific): %ld", vres);
#endif

    // Auto-fallback: if HTTP/2 framing failed, retry once with HTTP/1.1
    if(want_h2 && (rc == CURLE_HTTP2 || rc == CURLE_HTTP2_STREAM || http_code == 0)){
        LOG_WARN("HTTP/2 streaming failed (rc=%d, http=%ld). Retrying with HTTP/1.1…", (int)rc, http_code);
        curl_easy_setopt(curl, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_1_1);
        // reset accumulator
        free(acc.buf); acc.buf=NULL; acc.len=0; acc.cap=0; acc.total_bytes=0; acc.events=0; acc.data_chunks=0; acc.saw_done=false;
        rc = curl_easy_perform(curl);
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);
    }

    bool ok = (rc == CURLE_OK) && (http_code >= 200 && http_code < 300);
    if(!ok){
        if(rc != CURLE_OK){
            LOG_ERROR("Suggest stream: cURL error on %s: %s", url, curl_easy_strerror(rc));
        }
        if(http_code < 200 || http_code >= 300){
            LOG_ERROR("Suggest stream: HTTP %ld from %s", http_code, url);
            if(acc.len > 0 && acc.buf){
                json_error_t jerr; json_t *j = json_loads(acc.buf, 0, &jerr);
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
                        LOG_ERROR("HTTP %ld body (truncated): %.400s", http_code, acc.buf);
                    }
                    json_decref(j);
                } else {
                    LOG_ERROR("HTTP %ld raw body (truncated): %.400s", http_code, acc.buf);
                }
            }
        }
    } else {
        LOG_DEBUG("Suggest stream OK: http=%ld bytes=%zu events=%d data_chunks=%d saw_done=%d",
                  http_code, acc.total_bytes, acc.events, acc.data_chunks, acc.saw_done?1:0);
    }

    free(base_trim);
    free(acc.buf); curl_slist_free_all(hdrs); free(payload);
    curl_easy_cleanup(curl);

    // free any CA strings we set (after cURL is done using them)
    free(ca_refs.cainfo);
    free(ca_refs.capath);

    return ok;
}
