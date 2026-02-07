/* requests.c */
#include "requests.h"
#include "log.h"

#include <curl/curl.h>
#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ============================================================
 * Internal: string/memory helpers
 * ============================================================ */

static char* strdup_trim(const char *s){
    if(!s) return NULL;
    while(*s && isspace((unsigned char)*s)) s++;
    const char *end = s + strlen(s);
    while(end>s && isspace((unsigned char)end[-1])) end--;
    size_t n = (size_t)(end - s);
    char *out = (char*)malloc(n+1);
    if(!out) return NULL;
    memcpy(out, s, n); out[n] = 0;
    return out;
}

typedef struct {
    char  *ptr;
    size_t len;
    size_t cap;
} mem_buf_t;

static void mem_buf_init(mem_buf_t *m){ memset(m, 0, sizeof(*m)); }
static void mem_buf_free(mem_buf_t *m){ free(m->ptr); m->ptr=NULL; m->len=m->cap=0; }

static size_t write_mem(void *ptr, size_t size, size_t nmemb, void *userdata){
    mem_buf_t *m = (mem_buf_t*)userdata;
    size_t n = size*nmemb;
    if(m->len + n + 1 > m->cap){
        size_t nc = m->cap ? m->cap*2 : 8192;
        while(nc < m->len + n + 1) nc *= 2;
        char *p = (char*)realloc(m->ptr, nc);
        if(!p) return 0;
        m->ptr = p; m->cap = nc;
    }
    memcpy(m->ptr + m->len, ptr, n);
    m->len += n;
    m->ptr[m->len] = 0;
    return n;
}

/* ============================================================
 * Internal: TLS/CA + verbose (mirrors stream.c idioms)
 * ============================================================ */

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

typedef struct {
    char *cainfo;
    char *capath;
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

    if(idy_env_truthy("IDY_CURL_INSECURE")){
        curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
        curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);
        LOG_WARN("TLS verification DISABLED via IDY_CURL_INSECURE=1 (debug only)");
    }

    free(ca); free(capath); free(ca_env); free(ssl_file); free(ssl_dir);
    return refs;
}

/* ============================================================
 * Internal: URL builders
 * ============================================================ */

static char* build_base_url_openai(const idy_config_t *cfg){
    const char *raw = (cfg && cfg->base_url) ? cfg->base_url : "";
    char *trim = strdup_trim(raw);
    if(!trim || !*trim){
        free(trim);
        return strdup("https://api.openai.com/v1");
    }
    return trim;
}

static void build_embeddings_url(char *dst, size_t dstsz, const char *base){
    size_t blen = strlen(base);
    snprintf(dst, dstsz, "%s%sembeddings", base, (blen>0 && base[blen-1]=='/') ? "" : "/");
}

/* ============================================================
 * Internal: single-shot JSON HTTP
 * ============================================================ */

static bool http_json(const char *method,
                      const char *url,
                      struct curl_slist *headers,
                      const char *payload,         // may be NULL for GET/DELETE
                      long *out_http,
                      char **out_body,
                      char **err_out)
{
    if(err_out) *err_out = NULL;
    if(out_body) *out_body = NULL;
    if(out_http) *out_http = 0;

    CURL *curl = curl_easy_init();
    if(!curl){
        if(err_out) *err_out = strdup("curl_easy_init failed");
        return false;
    }

    mem_buf_t buf; mem_buf_init(&buf);
    ca_refs_t ca = apply_ca_options(curl);

    curl_easy_setopt(curl, CURLOPT_URL, url);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, write_mem);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &buf);
    curl_easy_setopt(curl, CURLOPT_TCP_KEEPALIVE, 1L);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl, CURLOPT_USERAGENT, "idyicyanere/0.1 (libcurl)");

    long timeout = 120;
    const char *t = getenv("IDY_CURL_TIMEOUT");
    if(t && *t){ long v = strtol(t, NULL, 10); if(v>0) timeout = v; }
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, timeout);

    if(idy_env_truthy("IDY_HTTP2")){
#ifdef CURL_HTTP_VERSION_2TLS
        curl_easy_setopt(curl, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_2TLS);
#else
        curl_easy_setopt(curl, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_2_0);
#endif
    } else {
        curl_easy_setopt(curl, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_1_1);
    }

    if(idy_env_truthy("IDY_CURL_VERBOSE")){
        curl_easy_setopt(curl, CURLOPT_VERBOSE, 1L);
        curl_easy_setopt(curl, CURLOPT_DEBUGFUNCTION, curl_debug_cb);
    }

    if(strcmp(method, "POST")==0){
        curl_easy_setopt(curl, CURLOPT_POST, 1L);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, payload ? payload : "");
    } else if(strcmp(method, "PUT")==0){
        curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "PUT");
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, payload ? payload : "");
    } else if(strcmp(method, "DELETE")==0){
        curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, "DELETE");
    } else if(strcmp(method, "GET")==0){
        // nothing special
    } else {
        curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, method);
        if(payload) curl_easy_setopt(curl, CURLOPT_POSTFIELDS, payload);
    }

    CURLcode rc = curl_easy_perform(curl);
    long http_code = 0; curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);

    if(out_http) *out_http = http_code;

    bool ok = (rc == CURLE_OK) && (http_code >= 200 && http_code < 300);
    if(!ok){
        if(rc != CURLE_OK){
            LOG_ERROR("HTTP error: %s %s => cURL: %s", method, url, curl_easy_strerror(rc));
        } else {
            LOG_ERROR("HTTP error: %s %s => code=%ld body=%.400s", method, url, http_code, buf.ptr?buf.ptr:"(null)");
        }
        if(err_out){
            if(buf.ptr && buf.len>0){
                // Try to glean error.message
                json_error_t jerr;
                json_t *j = json_loads(buf.ptr, 0, &jerr);
                if(j){
                    json_t *er = json_object_get(j, "error");
                    const char *msg = er ? json_string_value(json_object_get(er,"message")) : NULL;
                    if(msg) *err_out = strdup(msg);
                    json_decref(j);
                }
            }
            if(!*err_out){
                size_t l = 256 + (buf.len>0?buf.len:0);
                *err_out = (char*)malloc(l);
                if(*err_out){
                    snprintf(*err_out, l, "HTTP %ld from %s %s", http_code, method, url);
                }
            }
        }
    }

    if(out_body && buf.ptr){
        *out_body = buf.ptr;        // transfer ownership
        buf.ptr=NULL; buf.len=buf.cap=0;
    }
    mem_buf_free(&buf);
    curl_easy_cleanup(curl);
    free(ca.cainfo);
    free(ca.capath);
    return ok;
}

/* common header builders */

static struct curl_slist* headers_json(){
    struct curl_slist *h = NULL;
    h = curl_slist_append(h, "Content-Type: application/json");
    h = curl_slist_append(h, "Accept: application/json");
    return h;
}

static struct curl_slist* headers_with_bearer(struct curl_slist *h, const char *api_key){
    if(!api_key) return h;
    char auth[512]; snprintf(auth, sizeof(auth), "Authorization: Bearer %s", api_key);
    return curl_slist_append(h, auth);
}

/* ============================================================
 * Embeddings (OpenAI-compatible)
 * ============================================================ */

bool openai_embeddings_batch(requests_ctx_t          *ctx,
                             const char * const      *inputs,
                             int                      n_inputs,
                             const char              *model_opt,
                             int                      dims_opt,
                             emb_batch_t             *out,
                             char                   **err_msg_out)
{
    if(err_msg_out) *err_msg_out = NULL;
    if(!ctx || !ctx->cfg || !ctx->cfg->api_key || !inputs || n_inputs<=0 || !out){
        if(err_msg_out) *err_msg_out = strdup("invalid args for openai_embeddings_batch");
        return false;
    }
    memset(out, 0, sizeof(*out));

    // URL
    char *base = build_base_url_openai(ctx->cfg);
    char url[512]; build_embeddings_url(url, sizeof(url), base);

    // Payload
    const char *model = model_opt && *model_opt ? model_opt
                       : (ctx->cfg->embeddings_model && *ctx->cfg->embeddings_model ? ctx->cfg->embeddings_model
                                                              : "text-embedding-3-small");

    json_t *root = json_object();
    json_object_set_new(root, "model", json_string(model));

    // Always send array input (keeps shape consistent)
    json_t *arr = json_array();
    for(int i=0;i<n_inputs;i++){
        const char *s = inputs[i] ? inputs[i] : "";
        json_array_append_new(arr, json_string(s));
    }
    json_object_set_new(root, "input", arr);

    if(dims_opt > 0){
        json_object_set_new(root, "dimensions", json_integer(dims_opt));
    }

    char *payload = json_dumps(root, 0);
    json_decref(root);

    // Headers
    struct curl_slist *hdr = headers_json();
    hdr = headers_with_bearer(hdr, ctx->cfg->api_key);

    // POST
    long http=0;
    char *body=NULL,*err=NULL;
    bool ok = http_json("POST", url, hdr, payload, &http, &body, &err);

    curl_slist_free_all(hdr);
    free(payload);
    free(base);

    if(!ok){
        if(err_msg_out) *err_msg_out = err ? err : strdup("embeddings call failed");
        free(body);
        return false;
    }

    // Parse JSON
    json_error_t jerr;
    json_t *j = json_loads(body, 0, &jerr);
    if(!j){
        if(err_msg_out) *err_msg_out = strdup("embeddings: invalid JSON");
        free(body);
        return false;
    }

    json_t *data = json_object_get(j, "data");
    if(!json_is_array(data)){
        if(err_msg_out) *err_msg_out = strdup("embeddings: missing 'data' array");
        json_decref(j); free(body);
        return false;
    }

    int M = (int)json_array_size(data);
    float **vecs = (float**)calloc((size_t)M, sizeof(float*));
    size_t *dims = (size_t*)calloc((size_t)M, sizeof(size_t));
    if(!vecs || !dims){
        if(err_msg_out) *err_msg_out = strdup("embeddings: OOM");
        free(vecs); free(dims); json_decref(j); free(body);
        return false;
    }

    for(int i=0;i<M;i++){
        json_t *it = json_array_get(data, i);
        json_t *emb = it ? json_object_get(it, "embedding") : NULL;
        if(!json_is_array(emb)){
            if(err_msg_out) *err_msg_out = strdup("embeddings: no 'embedding' array");
            for(int k=0;k<i;k++) free(vecs[k]);
            free(vecs); free(dims); json_decref(j); free(body);
            return false;
        }
        size_t d = json_array_size(emb);
        dims[i] = d;
        vecs[i] = (float*)malloc(d * sizeof(float));
        if(!vecs[i]){
            if(err_msg_out) *err_msg_out = strdup("embeddings: OOM row");
            for(int k=0;k<i;k++) free(vecs[k]);
            free(vecs); free(dims); json_decref(j); free(body);
            return false;
        }
        for(size_t k=0;k<d;k++){
            json_t *v = json_array_get(emb, k);
            double x = json_is_real(v) ? json_real_value(v)
                       : (json_is_integer(v) ? (double)json_integer_value(v) : 0.0);
            vecs[i][k] = (float)x;
        }
    }

    out->vecs = vecs;
    out->dims = dims;
    out->count= M;
    out->raw  = j;        // keep raw JSON (optional)
    free(body);
    return true;
}

void emb_batch_free(emb_batch_t *res){
    if(!res) return;
    if(res->vecs){
        for(int i=0;i<res->count;i++) free(res->vecs[i]);
        free(res->vecs);
    }
    free(res->dims);
    if(res->raw) json_decref(res->raw);
    memset(res, 0, sizeof(*res));
}

bool openai_embeddings_one(requests_ctx_t  *ctx,
                           const char      *input,
                           const char      *model_opt,
                           int              dims_opt,
                           float          **out_vec,
                           size_t         *out_dim,
                           json_t        **out_raw,
                           char          **err_msg_out)
{
    if(out_vec) *out_vec = NULL;
    if(out_dim) *out_dim = 0;
    if(out_raw) *out_raw = NULL;

    const char *arr[1] = { input ? input : "" };
    emb_batch_t batch;
    if(!openai_embeddings_batch(ctx, arr, 1, model_opt, dims_opt, &batch, err_msg_out)){
        return false;
    }
    // Transfer ownership of the single vector to caller
    if(out_vec){
        *out_vec = batch.vecs[0];
        batch.vecs[0] = NULL;
    } else {
        free(batch.vecs[0]);
    }
    if(out_dim) *out_dim = batch.dims[0];
    if(out_raw){
        *out_raw = batch.raw;     // hand over raw JSON
        batch.raw = NULL;
    }
    // Free the container + remaining arrays
    free(batch.vecs);
    free(batch.dims);
    if(batch.raw) json_decref(batch.raw);
    return true;
}
