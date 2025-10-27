#include "mcp.h"
#include "idy.h"

// NOTE: This is a sketch: it reads single-line JSON-RPC requests on stdin,
// writes responses on stdout. Tools: compile_latex, ssh_exec, http_get.

static json_t* ok(json_t *id, json_t *result){
    return json_pack("{ssss, so}", "jsonrpc","2.0","id", json_string_value(id), "result", result);
}

static json_t* err(json_t *id, int code, const char *msg){
    return json_pack("{ssss, so}", "jsonrpc","2.0","id", json_string_value(id),
                     "error", json_pack("{sisi}", "code", code, "message", msg));
}

static int run_cmd_capture(const char *cmd, char **out){
    FILE *p = popen(cmd, "r"); if(!p) return -1;
    size_t cap=8192, len=0; char *buf=malloc(cap);
    int c;
    while((c=fgetc(p))!=EOF){
        if(len+1>=cap){ cap*=2; buf=realloc(buf,cap); }
        buf[len++]=(char)c;
    }
    buf[len]=0; int rc = pclose(p);
    *out=buf; return rc;
}

int mcp_loop(void){
    char *line=NULL; size_t n=0;
    while(getline(&line,&n,stdin)>0){
        json_error_t e; json_t *req = json_loads(line,0,&e);
        if(!req) continue;
        json_t *id = json_object_get(req, "id");
        json_t *method = json_object_get(req, "method");

        if(json_is_string(method) && strcmp(json_string_value(method),"tools/list")==0){
            json_t *tools = json_array();
            json_array_append_new(tools, json_pack("{ssss}", "name","compile_latex","description","Run latexmk on a file"));
            json_array_append_new(tools, json_pack("{ssss}", "name","ssh_exec","description","Run command via ssh <host>"));
            json_array_append_new(tools, json_pack("{ssss}", "name","http_get","description","Fetch URL via curl"));
            json_t *res = json_pack("{so}", "tools", tools);
            json_t *resp = ok(id,res); char *s=json_dumps(resp,0); puts(s); fflush(stdout);
            free(s); json_decref(resp);
        } else if(json_is_string(method) && strcmp(json_string_value(method),"tools/call")==0){
            json_t *params = json_object_get(req,"params");
            const char *name = json_string_value(json_object_get(params,"name"));
            json_t *args = json_object_get(params,"arguments");
            char *cmd=NULL, *out=NULL; int rc=0;
            if(strcmp(name,"compile_latex")==0){
                const char *file = json_string_value(json_object_get(args,"file"));
                const char *flags= json_string_value(json_object_get(args,"flags"));
                if(!flags) flags="-pdf -halt-on-error";
                asprintf(&cmd, "latexmk %s '%s'", flags, file);
                rc=run_cmd_capture(cmd,&out);
            } else if(strcmp(name,"ssh_exec")==0){
                const char *host=json_string_value(json_object_get(args,"host"));
                const char *run =json_string_value(json_object_get(args,"cmd"));
                asprintf(&cmd, "ssh %s '%s'", host, run);
                rc=run_cmd_capture(cmd,&out);
            } else if(strcmp(name,"http_get")==0){
                const char *url=json_string_value(json_object_get(args,"url"));
                asprintf(&cmd, "curl -sL '%s'", url);
                rc=run_cmd_capture(cmd,&out);
            } else {
                json_t *resp = err(id,-32601,"Method not found");
                char *s=json_dumps(resp,0); puts(s); fflush(stdout);
                free(s); json_decref(resp); json_decref(req); continue;
            }
            json_t *res = json_pack("{sisi ss}", "exit_code", rc, "stdout", out?out:"");
            json_t *resp = ok(id,res); char *s=json_dumps(resp,0); puts(s); fflush(stdout);
            free(out); free(cmd); free(s); json_decref(resp);
        }
        json_decref(req);
    }
    free(line);
    return 0;
}
