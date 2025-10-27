#include "stream.h"

typedef struct {
    stream_ctx_t *ctx;
    char *buf; size_t len, cap;
} sse_accum_t;

static size_t on_write(char *ptr, size_t size, size_t nmemb, void *userdata){
    sse_accum_t *acc = (sse_accum_t*)userdata;
    size_t n = size*nmemb;
    if(acc->len + n + 1 > acc->cap){
        size_t nc = acc->cap? acc->cap*2:8192; while(nc < acc->len+n+1) nc*=2;
        acc->buf = realloc(acc->buf, nc); acc->cap = nc;
    }
    memcpy(acc->buf+acc->len, ptr, n); acc->len += n; acc->buf[acc->len]=0;

    // Process complete lines (SSE: "data: {...}\r\n")
    char *start = acc->buf;
    for(;;){
        char *nl = strstr(start, "\n\n"); // SSE event delimiter
        if(!nl) break;
        *nl = 0;
        // Each line may contain multiple "data:" lines; handle both CRLF and LF.
        char *line = start;
        while(line && *line){
            char *eol = strstr(line, "\n");
            if(eol) *eol = 0;

            if(strncmp(line, "data: ", 6)==0){
                const char *payload = line+6;
                if(strcmp(payload, "[DONE]")==0){
                    // Stream finished; we don't necessarily have usage unless we asked for it.
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
                        // Some streams include a final chunk with "usage"
                        json_t *usage = json_object_get(j, "usage");
                        if(usage && acc->ctx->on_done){
                            acc->ctx->on_done(usage, acc->ctx->user);
                        }
                        json_decref(j);
                    }
                }
            }
            if(!eol) break;
            line = eol+1;
        }
        start = nl + 2; // skip the blank line
    }

    // Compact processed data
    size_t consumed = start - acc->buf;
    if(consumed){
        memmove(acc->buf, start, acc->len - consumed + 1);
        acc->len -= consumed;
    }
    return n;
}

bool openai_stream_unified_diff(stream_ctx_t *ctx,
                                const char *original,
                                const char *section_hint)
{
    CURL *curl = curl_easy_init();
    if(!curl) return false;

    const char *base = ctx->cfg->base_url ? ctx->cfg->base_url : "https://api.openai.com/v1";
    char url[512]; snprintf(url, sizeof(url), "%s/chat/completions", base);

    // Construct JSON body
    json_t *root = json_object();
    json_object_set_new(root, "model", json_string(ctx->cfg->model ? ctx->cfg->model : "gpt-4o-mini"));
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
    char auth[512]; snprintf(auth, sizeof(auth), "Authorization: Bearer %s", ctx->cfg->api_key);
    hdrs = curl_slist_append(hdrs, auth);

    sse_accum_t acc = { .ctx=ctx, .buf=NULL, .len=0, .cap=0 };

    curl_easy_setopt(curl, CURLOPT_URL, url);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, hdrs);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, payload);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, on_write);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &acc);
    curl_easy_setopt(curl, CURLOPT_TCP_KEEPALIVE, 1L);
    // Don't buffer output; let chunks flow
    curl_easy_setopt(curl, CURLOPT_NOPROGRESS, 1L);

    CURLcode rc = curl_easy_perform(curl);

    free(acc.buf); curl_slist_free_all(hdrs); free(payload); curl_easy_cleanup(curl);
    return rc == CURLE_OK;
}
