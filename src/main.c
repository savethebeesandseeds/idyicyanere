#include "idy.h"
#include "tui.h"
#include "stream.h"
#include "diff.h"

static char *RIGHTBUF=NULL, *STATUS=NULL;

static void on_delta_cb(const char *token, void *user){
    (void)user;
    size_t cur = RIGHTBUF? strlen(RIGHTBUF):0;
    RIGHTBUF = realloc(RIGHTBUF, cur + strlen(token) + 1);
    memcpy(RIGHTBUF+cur, token, strlen(token)+1);
}

static void on_done_cb(json_t *usage, void *user){
    (void)user;
    if(usage){
        json_t *tot = json_object_get(usage,"total_tokens");
        if(json_is_integer(tot)){
            char *s; asprintf(&s, "Done. total_tokens=%lld", (long long)json_integer_value(tot));
            free(STATUS); STATUS=s;
        }
    }
}

static char *read_file(const char *p){ FILE*f=fopen(p,"rb"); if(!f) return NULL;
    fseek(f,0,SEEK_END); long n=ftell(f); fseek(f,0,SEEK_SET);
    char *s=malloc(n+1); fread(s,1,n,f); s[n]=0; fclose(f); return s; }

int main(int argc, char **argv){
    if(argc<2){ fprintf(stderr,"usage: %s <file.tex>\n", argv[0]); return 1; }
    const char *path = argv[1];

    idy_config_t cfg = {
        .model = getenv("OPENAI_MODEL"),
        .api_key = getenv("OPENAI_API_KEY"),
        .base_url = getenv("OPENAI_BASE_URL"),
        .system_prompt = NULL
    };
    if(!cfg.api_key){ fprintf(stderr,"OPENAI_API_KEY is required\n"); return 1; }

    buffer_t doc; buf_init(&doc);
    if(!buf_load_file(&doc, path)){ fprintf(stderr,"failed to read %s\n",path); return 1; }

    tui_t T; tui_init(&T);
    tui_draw(&T, &doc, RIGHTBUF, STATUS);

    int ch;
    bool running=true;
    while(running && (ch = getch())){
        if((ch==17)) { // Ctrl-Q
            running=false; break;
        } else if(ch==19){ // Ctrl-S
            buf_save_file(&doc, path);
            free(STATUS); STATUS=strdup("Saved.");
        } else if(ch==7){ // Ctrl-G => Suggest
            free(RIGHTBUF); RIGHTBUF=strdup(""); free(STATUS); STATUS=strdup("Requesting suggestions...");
            stream_ctx_t sctx = { .cfg=&cfg, .on_delta=on_delta_cb, .on_done=on_done_cb, .user=NULL };
            openai_stream_unified_diff(&sctx, doc.data, NULL);
        } else if(ch==1){ // Ctrl-A => Apply diff
            if(!RIGHTBUF || !*RIGHTBUF){ free(STATUS); STATUS=strdup("No diff to apply."); }
            else {
                char *out=NULL,*err=NULL;
                if(apply_unified_diff(doc.data, RIGHTBUF, &out, &err)){
                    free(doc.data); doc.data=out; doc.len=strlen(out);
                    free(STATUS); STATUS=strdup("Patch applied.");
                } else {
                    char *m; asprintf(&m,"Patch failed: %s", err?err:"(unknown)");
                    free(STATUS); STATUS=m; free(err);
                }
            }
        } else if(ch==KEY_F(5)){ // F5 -> latexmk -pdf
            free(STATUS); STATUS=strdup("Running latexmk -pdf ...");
            char cmd[1024]; snprintf(cmd,sizeof(cmd),"latexmk -pdf -halt-on-error '%s' 2>&1 | tail -n 5", path);
            FILE *p=popen(cmd,"r"); char line[512]; free(RIGHTBUF); RIGHTBUF=strdup("");
            while(fgets(line,sizeof(line),p)){ size_t cur=strlen(RIGHTBUF); RIGHTBUF=realloc(RIGHTBUF,cur+strlen(line)+1); strcpy(RIGHTBUF+cur,line); }
            pclose(p);
        } else if(ch==KEY_F(9)){ // F9 -> ssh build
            free(STATUS); STATUS=strdup("ssh build: set IDY_SSH_HOST env var");
            const char *host = getenv("IDY_SSH_HOST"); if(host){
                char cmd[1024]; snprintf(cmd,sizeof(cmd),"ssh %s 'latexmk -pdf -halt-on-error %s' 2>&1 | tail -n 10", host, path);
                FILE *p=popen(cmd,"r"); char line[512]; free(RIGHTBUF); RIGHTBUF=strdup("");
                while(fgets(line,sizeof(line),p)){ size_t cur=strlen(RIGHTBUF); RIGHTBUF=realloc(RIGHTBUF,cur+strlen(line)+1); strcpy(RIGHTBUF+cur,line); }
                pclose(p);
            }
        }
        tui_draw(&T, &doc, RIGHTBUF, STATUS);
    }

    tui_end(); buf_free(&doc); free(RIGHTBUF); free(STATUS);
    return 0;
}
