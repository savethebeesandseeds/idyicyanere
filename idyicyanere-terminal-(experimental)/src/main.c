#include "idy.h"
#include "tui.h"
#include "stream.h"
#include "diff.h"
#include "editor.h"
#include "settings.h"
#include "log.h"
#include "sha256.h"
#include "clipboard.h"
#include "preview.h"
#include "file_context.h"
#include "fsutil.h"
#include <libgen.h>
#include <limits.h>
#include <time.h>

static char *RIGHTBUF=NULL, *STATUS=NULL;
static screen_t g_screen = SCREEN_EDITOR;
static log_level_t LOG_FILTER = LOG_INFO;

static char CWD[PATH_MAX];         // current directory in Context view
static int  SEL_INDEX = 0;         // selection in Context list
static file_list_t FL = {0};

// Current open file path (for editor buffer)
static char CURRENT_FILE[PATH_MAX]; // empty string if unnamed
static bool HAS_CURRENT_FILE = false;

// Context selection (absolute paths)
static char **CTX_FILES = NULL;
static int    CTX_COUNT = 0;

// Context preview (rendered text) + scroll
static char *CTX_PREVIEW = NULL;
static int   CTX_PREVIEW_LINES = 0;
static int   CTX_SCROLL = 0;

// Logs view scroll offset (in visual rows from bottom; 0 = follow tail)
static int   LOG_SCROLL = 0;

// Logs right-pane (Config block) vertical scroll (0 = top of Config)
static int   LOG_RHS_SCROLL = 0;

// Blink timer
static bool BLINK_STATE=false;
static struct timespec BLINK_LAST;

/* === stream callbacks === */
static void on_delta_cb(const char *token, void *user){
    (void)user;
    size_t cur = RIGHTBUF ? strlen(RIGHTBUF) : 0;
    size_t add = strlen(token);
    RIGHTBUF = (char*)realloc(RIGHTBUF, cur + add + 1);
    if(!RIGHTBUF) return;
    memcpy(RIGHTBUF + cur, token, add + 1);
}

static void on_done_cb(json_t *usage, void *user){
    if(usage){
        json_t *tot = json_object_get(usage,"total_tokens");
        long long t = json_is_integer(tot) ? (long long)json_integer_value(tot) : -1;
        free(STATUS); asprintf(&STATUS, "Done. total_tokens=%lld", t);
    }
    // Optional debug stats on the diff we just received
    editor_t *ed = (editor_t*)user;
    if(ed && ed->doc && RIGHTBUF){
        int add=0, del=0, hunks=0;
        for(const char *p=RIGHTBUF; p && *p; ){
            const char *nl = strchr(p, '\n');
            size_t len = nl ? (size_t)(nl-p) : strlen(p);
            if(len>=2 && p[0]=='@' && p[1]=='@') hunks++;
            else if(len>=1 && p[0]=='+') add++;
            else if(len>=1 && p[0]=='-') del++;
            if(!nl) break;
            p = nl+1;
        }
        int orig_lines = editor_total_lines(ed->doc);
        double ratio = (orig_lines>0) ? ((double)(add + del) / (double)orig_lines) : 0.0;
        LOG_TRACE("Streaming suggestions finished. diff_stats: hunks=%d, +%d, -%d, orig_lines=%d, change_ratio=%.3f",
                  hunks, add, del, orig_lines, ratio);
    } else {
        LOG_DEBUG("Streaming suggestions finished.");
    }
}

/* ==== small helpers ==== */
static void start_blink_timer(void){
    timespec_get(&BLINK_LAST, TIME_UTC);
    BLINK_STATE=false;
}

/* ===== Editor selection helpers for CTRL-C/V and SHIFT+arrows ===== */
static void extend_selection_move(editor_t *ed, void (*move_fn)(editor_t*)){
    size_t anchor = editor_has_selection(ed) ? ed->sel_anchor : ed->cursor;
    move_fn(ed);
    editor_set_selection(ed, anchor, ed->cursor);
}

// Save utility: save current buffer to CURRENT_FILE (or untitled.tex if none)
static bool save_current_buffer(editor_t *ed, const char *cwd){
    char outpath[PATH_MAX];
    const char *save_as_env = getenv("IDY_SAVE_AS");
    if(save_as_env && *save_as_env){
        snprintf(outpath, sizeof(outpath), "%s", save_as_env);
    } else if(HAS_CURRENT_FILE){
        snprintf(outpath, sizeof(outpath), "%s", CURRENT_FILE);
    } else {
        snprintf(outpath, sizeof(outpath), "%s/%s", cwd, "untitled.tex");
    }
    if(buf_save_file(ed->doc, outpath)){
        ed->dirty = false;
        free(STATUS); asprintf(&STATUS, "Saved: %s", outpath);
        LOG_INFO("Saved file: %s", outpath);
        // if this was an unnamed buffer, adopt the path
        if(!HAS_CURRENT_FILE){
            snprintf(CURRENT_FILE, sizeof(CURRENT_FILE), "%s", outpath);
            HAS_CURRENT_FILE = true;
        }
        return true;
    } else {
        free(STATUS); asprintf(&STATUS, "Save failed: %s", outpath);
        LOG_ERROR("Save failed: %s", outpath);
        return false;
    }
}

// Helper: short hex of SHA-256 for logs
static void hex8_of_doc(const buffer_t *b, char out[9]){
    char h[65]; sha256_hex((const unsigned char*)b->data, b->len, h);
    memcpy(out, h, 8); out[8]=0;
}

// Render doc as a line-numbered view: each line starts with
// "<N>| " where N is 1-based and right-aligned to the max digit width.
// Returns malloc'ed string (caller frees). For empty docs, returns strdup("").
static int dec_digits_(int n){ int d=1; while(n>=10){ n/=10; d++; } return d; }

static char* build_numbered_original(const buffer_t *b){
    if(!b || !b->data || b->len == 0) return strdup("");
    int total_lines = editor_total_lines(b);
    int digits = dec_digits_(total_lines);

    // Worst-case extra per line: digits + 2 (for "| ")
    size_t extra = (size_t)total_lines * (size_t)(digits + 2);
    char *out = (char*)malloc(b->len + extra + 1);
    if(!out) return NULL;

    char *w = out;
    int line = 1;
    w += sprintf(w, "%*d| ", digits, line);

    for(size_t i=0; i<b->len; ++i){
        char c = b->data[i];
        *w++ = c;
        if(c == '\n' && i + 1 < b->len){
            line++;
            w += sprintf(w, "%*d| ", digits, line);
        }
    }
    *w = '\0';
    return out;
}


/* Open the item at `selpath` exactly like pressing Enter in Context.
   - Dir: cd into it (rebuild listing + keep on Context, rebuild preview)
   - File: open into editor (switch screen) */
static void open_item_by_path(const char *selpath, editor_t *ed, bool *need_preview_rebuild){
    if(!selpath) return;
    if(fs_is_dir(selpath)){
        free_file_list(&FL);
        realpath(selpath, CWD);
        list_dir(CWD,&FL);
        SEL_INDEX = 0;
        if(need_preview_rebuild) *need_preview_rebuild = true;
        LOG_DEBUG("cd %s", CWD);
    } else if(fs_is_file(selpath)){
        buffer_t newdoc; buf_init(&newdoc);
        if(buf_load_file(&newdoc, selpath)){
            free(ed->doc->data);
            *ed->doc = newdoc;
            ed->cursor = 0; ed->top_line=0; ed->left_col=0;
            ed->sel_anchor=ed->sel_active=0; ed->dirty=false;
            snprintf(CURRENT_FILE, sizeof(CURRENT_FILE), "%s", selpath);
            HAS_CURRENT_FILE = true;
            g_screen = SCREEN_EDITOR;
            LOG_INFO("Opened file: %s", selpath);
            free(STATUS); STATUS=strdup("File opened.");
        } else {
            LOG_ERROR("Failed to open file: %s", selpath);
            free(STATUS); STATUS=strdup("Open failed.");
        }
    }
}

int main(int argc, char **argv){
    if(argc<2){ fprintf(stderr,"usage: %s <file.tex|folder>\n", argv[0]); return 1; }
    const char *arg = argv[1];

    /* Use trimmed env vars so stray newlines/whitespace don't break headers/paths. */
    idy_config_t cfg = {
        .model = idy_getenv_trimdup("OPENAI_MODEL"),
        .embeddings_model = idy_getenv_trimdup("OPENAI_EMBEDDINGS_MODEL"),
        .api_key = idy_getenv_trimdup("OPENAI_API_KEY"),
        .base_url = idy_getenv_trimdup("OPENAI_BASE_URL"),
        .prompt_max_orig = 0,
        .prompt_max_ctx  = 0,
        .system_prompt_unified_diff =
            "You are a scientific writing copilot. Return ONLY a valid unified diff patch (single file) for the ORIGINAL text I provide. Keep LaTeX valid."
            "LINE-NUMBERED VIEW (IMPORTANT): The ORIGINAL is shown with fixed-width line numbers at the start of each line, in the form \"<N>| <content>\", where N is the 1-based line number."
            "These prefixes are METADATA only. When constructing the unified diff:"
            " - Read the actual document text as the substring after the first \"| \" on each line."
            " - NEVER include the numeric prefixes in any context (' '), deletion ('-'), or insertion ('+') lines."
            " - Use the visible numbers to compute @@ header starts (oldStart). Lengths are counts of lines as usual."
            " - If the true line begins with '+', '-' or a space, keep it; only strip the \"<N>| \" prefix."
            "RULE 0 — NO CHANGES: If, after stripping \"<N>| \", you determine there is NOTHING to change, output EXACTLY:"
            "--- original.tex"
            "+++ original.tex"
            "…and nothing else (no @@ hunks)."
            "Strict output format (no prose, no code fences):"
            "1) First two lines must be exactly:"
            "--- original.tex"
            "+++ original.tex"
            "2) Each hunk header MUST be one of:"
            "@@ -<oldStart>,<oldLen> +<newStart>,<newLen> @@"
            "@@ -<oldStart> +<newStart> @@   (shorthand: lengths are 1)"
            "3) Hunk body line prefixes:"
            "   space = unchanged context"
            "   '-'   = line removed from the original"
            "   '+'   = line added in the new version"
            "   Include at least ONE context line (a ' ' line) before and/or after changes when available."
            "4) Use \\n newlines. If a changed line has no trailing newline, add the marker line:"
            "\\ No newline at end of file"
            "5) Compute line numbers from the ORIGINAL (the numbered view). For full rewrites, use:"
            "@@ -1,<oldLen> +1,<newLen> @@"
            "6) Do NOT include any extra metadata (no 'diff --git', 'index' lines, comments, or explanations)."
            "7) Identity edits are FORBIDDEN: never produce a hunk where the sequence of '-' lines is byte-identical to the sequence of '+' lines."
            "8) The patch must apply cleanly to the ORIGINAL text without fuzzy matching. Preserve LaTeX correctness."
    };
    if(!cfg.api_key){ fprintf(stderr,"OPENAI_API_KEY is required\n"); return 1; }

    // Resolve prompt caps from env (bytes). Defaults come from stream.h.
    cfg.prompt_max_orig = idy_env_parse_size("IDY_PROMPT_MAX_ORIG", IDY_PROMPT_MAX_ORIG);
    cfg.prompt_max_ctx  = idy_env_parse_size("IDY_PROMPT_MAX_CTX",  IDY_PROMPT_MAX_CTX);

    /* Bounded log ring: allow IDY_LOG_CAP (clamped), default 1024 */
    int cap = 1024;
    char *cap_s = idy_getenv_trimdup("IDY_LOG_CAP");
    if(cap_s){
        char *endp = NULL; long v = strtol(cap_s, &endp, 10);
        if(endp != cap_s){
            if(v < 128) v = 128;
            if(v > 65536) v = 65536;
            cap = (int)v;
        }
        free(cap_s);
    }
    log_init((size_t)cap);
    LOG_INFO("idyicyanere starting (v%s)", IDY_VERSION);
    LOG_DEBUG("Prompt caps (effective): orig=%zu bytes, ctx=%zu bytes",
              (size_t)cfg.prompt_max_orig, (size_t)cfg.prompt_max_ctx);

    buffer_t doc; buf_init(&doc);
    editor_t ed; editor_init(&ed, &doc);
    CURRENT_FILE[0] = '\0'; HAS_CURRENT_FILE = false;

    // Decide start mode (file vs folder)
    char startpath[PATH_MAX];
    char *rp = realpath(arg, startpath);
    if(!rp){
        strncpy(startpath, arg, sizeof(startpath)-1); startpath[sizeof(startpath)-1]='\0';
    }
    if(fs_is_dir(startpath)){
        snprintf(CWD, sizeof(CWD), "%s", startpath);
        g_screen = SCREEN_CONTEXT;
        list_dir(CWD, &FL);
        LOG_INFO("Started in directory mode (Context): %s", CWD);
    } else if(fs_is_file(startpath)){
        if(!buf_load_file(&doc, startpath)){ fprintf(stderr,"failed to read %s\n",startpath); return 1; }
        editor_init(&ed, &doc);
        snprintf(CURRENT_FILE, sizeof(CURRENT_FILE), "%s", startpath);
        HAS_CURRENT_FILE = true;
        snprintf(CWD, sizeof(CWD), "%s", startpath);
        char *dir = dirname(CWD); snprintf(CWD, sizeof(CWD), "%s", dir);
        LOG_INFO("Opened file: %s", startpath);
    } else {
        fprintf(stderr,"Path not found: %s\n", arg); return 1;
    }

    tui_t T; tui_init(&T);
    start_blink_timer();

    // First draw
    if(g_screen == SCREEN_EDITOR){
        const char *fp = HAS_CURRENT_FILE ? CURRENT_FILE : "(untitled)";
        tui_draw_editor(&T, &ed, RIGHTBUF, STATUS, fp);
    } else {
        free(CTX_PREVIEW);
        CTX_PREVIEW = preview_build(CWD, CTX_FILES, CTX_COUNT, &CTX_PREVIEW_LINES);
        if(CTX_SCROLL > CTX_PREVIEW_LINES) CTX_SCROLL = CTX_PREVIEW_LINES;
        tui_draw_context(&T, CWD, &FL, SEL_INDEX, &cfg, CTX_FILES, CTX_COUNT, CTX_PREVIEW, CTX_SCROLL, STATUS);
    }

    int ch; bool running=true;
    while(running){
        // Blink timer
        struct timespec now; timespec_get(&now, TIME_UTC);
        long ms = (now.tv_sec - BLINK_LAST.tv_sec)*1000L + (now.tv_nsec - BLINK_LAST.tv_nsec)/1000000L;
        bool need_redraw = false;
        if(ms >= 500){
            BLINK_STATE = !BLINK_STATE; T.blink_on = BLINK_STATE; BLINK_LAST = now;
            if(g_screen==SCREEN_EDITOR) need_redraw = true;
        }

        ch = getch();
        if(ch==ERR){
            if(need_redraw){
                if(g_screen==SCREEN_EDITOR){
                    const char *fp = HAS_CURRENT_FILE ? CURRENT_FILE : "(untitled)";
                    tui_draw_editor(&T, &ed, RIGHTBUF, STATUS, fp);
                }
            }
            continue;
        }

        if(ch==KEY_RESIZE){ tui_resize(&T); }
        else if((ch==17)){ running=false; break; } // Ctrl-Q

        // Global screen switching
        else if(ch==KEY_F(1)){ g_screen=SCREEN_EDITOR; LOG_TRACE("Switch to Editor"); }
        else if(ch==KEY_F(2)){
            g_screen=SCREEN_CONTEXT; LOG_TRACE("Switch to Context");
            if(!FL.items){ list_dir(CWD, &FL); }
            free(CTX_PREVIEW);
            CTX_PREVIEW = preview_build(CWD, CTX_FILES, CTX_COUNT, &CTX_PREVIEW_LINES);
            if(CTX_SCROLL > CTX_PREVIEW_LINES) CTX_SCROLL = CTX_PREVIEW_LINES;
        }
        else if(ch==KEY_F(3)){ g_screen=SCREEN_LOGS; LOG_TRACE("Switch to Logs"); }
 
        if(g_screen==SCREEN_EDITOR){
            // Editing controls
            if(ch==19){ // Ctrl-S -> Save current buffer (to its filename)
                save_current_buffer(&ed, CWD);
            } else if(ch==7){ // Ctrl-G => Suggest
                free(RIGHTBUF); RIGHTBUF=strdup(""); free(STATUS); STATUS=strdup("Requesting suggestions...");
                // Log starting context
                int lines0 = editor_total_lines(&doc);
                char hx[9]; hex8_of_doc(&doc, hx);
                const char *base = cfg.base_url ? cfg.base_url : "(auto https://api.openai.com/v1)";
                const char *model = (cfg.model && *cfg.model) ? cfg.model : "gpt-4o-mini";
                LOG_DEBUG("Suggest request started (model=%s base=%s, orig_bytes=%zu, orig_lines=%d, sha256=%s…)",
                    model, base, doc.len, lines0, hx);
                LOG_TRACE("Suggest: Context content: %s", CTX_PREVIEW);
                stream_ctx_t sctx = { .cfg=&cfg, .on_delta=on_delta_cb, .on_done=on_done_cb, .user=&ed };
                char *orig_numbered = build_numbered_original(&doc);  // malloc'ed
                const char *orig_for_model = orig_numbered ? orig_numbered : doc.data;
                if(!openai_stream_unified_diff(&sctx, orig_for_model, CTX_PREVIEW, NULL)){
                    free(STATUS); STATUS=strdup("Suggestion request failed.");
                    LOG_ERROR("Streaming suggestions failed."); // detailed cause logged in stream.c
                } else {
                    int lines0 = editor_total_lines(&doc);
                    LOG_TRACE("Suggest: sent line-numbered ORIGINAL (lines=%d).", lines0);
                }
                free(orig_numbered);
            } else if(ch==1){ // Ctrl-A => Apply
                if(!RIGHTBUF || !*RIGHTBUF){ free(STATUS); STATUS=strdup("No diff to apply."); LOG_WARN("Apply requested with no diff."); }
                else {
                    // Diff stats before applying
                    int add=0, del=0, hunks=0;
                    for(const char *p=RIGHTBUF; p && *p; ){
                        const char *nl=strchr(p,'\n'); size_t len = nl ? (size_t)(nl-p) : strlen(p);
                        if(len>=2 && p[0]=='@' && p[1]=='@') hunks++;
                        else if(len>=1 && p[0]=='+') add++;
                        else if(len>=1 && p[0]=='-') del++;
                        if(!nl) break;
                        p=nl+1;
                    }
                    int lines_before = editor_total_lines(&doc);
                    char hx_before[9]; hex8_of_doc(&doc, hx_before);
                    char *out=NULL,*err=NULL;
                    if(apply_unified_diff(doc.data, RIGHTBUF, &out, &err)){
                        free(doc.data); doc.data=out; doc.len=strlen(out);
                        ed.dirty = true;
                        int lines_after = editor_total_lines(&doc);
                        char hx_after[9]; hex8_of_doc(&doc, hx_after);
                        LOG_INFO("Patch applied successfully. hunks=%d, +%d, -%d, lines: %d->%d, sha: %s→%s",
                                 hunks, add, del, lines_before, lines_after, hx_before, hx_after);
                        free(STATUS); STATUS=strdup("Patch applied.");
                    } else {
                        LOG_ERROR("Patch failed: %s", err?err:"(unknown)");
                        char *m; asprintf(&m,"Patch failed: %s", err?err:"(unknown)");
                        free(STATUS); STATUS=m; free(err);
                    }
                }
            } else if(ch==3){ // Ctrl-C (copy)
                char *copy_buf=NULL;
                if(editor_has_selection(&ed)){
                    size_t a,b; editor_get_selection(&ed,&a,&b);
                    size_t n = b - a; copy_buf = (char*)malloc(n+1);
                    memcpy(copy_buf, doc.data + a, n); copy_buf[n]=0;
                } else {
                    // No selection -> copy entire line
                    int row,col; editor_cursor_row_col(&ed,&row,&col);
                    size_t a = editor_line_start_index(&doc, row);
                    size_t b = editor_index_from_row_col(&doc, row, 999999);
                    size_t n = (b>a)? (b-a) : 0;
                    copy_buf = (char*)malloc(n+1); memcpy(copy_buf, doc.data + a, n); copy_buf[n]=0;
                }
                clipboard_set(copy_buf);
                free(copy_buf);
                free(STATUS); STATUS=strdup("Copied.");
            } else if(ch==22){ // Ctrl-V (paste)
                const char *clip = clipboard_get();
                if(clip && *clip){
                    if(editor_has_selection(&ed)) editor_delete_selection(&ed);
                    editor_insert_text(&ed, clip);
                    free(STATUS); STATUS=strdup("Pasted.");
                }
            } else if(ch==24){ // Ctrl-X (cut)
                if(editor_has_selection(&ed)){
                    size_t a,b; editor_get_selection(&ed,&a,&b);
                    size_t n = b - a; char *copy=(char*)malloc(n+1);
                    memcpy(copy, doc.data+a, n); copy[n]=0; clipboard_set(copy); free(copy);
                    editor_delete_selection(&ed);
                    free(STATUS); STATUS=strdup("Cut.");
                }
            }
            // Motion + selection
            if(ch==KEY_SLEFT){ extend_selection_move(&ed, editor_move_left); }
            else if(ch==KEY_SRIGHT){ extend_selection_move(&ed, editor_move_right); }
            else if(ch==KEY_SR){ extend_selection_move(&ed, editor_move_up); }
            else if(ch==KEY_SF){ extend_selection_move(&ed, editor_move_down); }

            // Basic editor motions (clear selection)
            else if(ch==KEY_LEFT){ editor_move_left(&ed); editor_clear_selection(&ed); }
            else if(ch==KEY_RIGHT){ editor_move_right(&ed); editor_clear_selection(&ed); }
            else if(ch==KEY_UP){ editor_move_up(&ed); editor_clear_selection(&ed); }
            else if(ch==KEY_DOWN){ editor_move_down(&ed); editor_clear_selection(&ed); }
            else if(ch==KEY_HOME){ editor_move_home(&ed); editor_clear_selection(&ed); }
            else if(ch==KEY_END){ editor_move_end(&ed); editor_clear_selection(&ed); }
            else if(ch==KEY_BACKSPACE || ch==127) editor_backspace(&ed);
            else if(ch==KEY_DC) editor_delete_forward(&ed); // Supr/Delete
            else if(ch=='\t'){ for(int i=0;i<ed.tabstop;i++) editor_insert_char(&ed,' '); editor_clear_selection(&ed); }
            else if(ch=='\n'){ editor_insert_char(&ed,'\n'); editor_clear_selection(&ed); }
            else if(ch==KEY_MOUSE){
                MEVENT ev; if(getmouse(&ev)==OK){
                    // editor pane
                    if(ev.x < T.split_col){
                        int ly = ev.y - 1; // inside box
                        int lx = ev.x - 1;
                        int content_rows = getmaxy(T.left)-2;
                        int content_cols = getmaxx(T.left)-2 - T.gutter_cols; if(content_cols<0) content_cols=0;
                        int adjx = lx - T.gutter_cols; if(adjx<0) adjx=0;

                        if(ev.bstate & (BUTTON1_CLICKED|BUTTON1_RELEASED|BUTTON1_DOUBLE_CLICKED|BUTTON1_PRESSED)){
                            editor_click(&ed, ly, adjx, content_rows, content_cols);
                            editor_clear_selection(&ed);
                        }
#ifdef BUTTON1_PRESSED
                        if(ev.bstate & BUTTON1_PRESSED){
                            // start drag selection
                            editor_click(&ed, ly, adjx, content_rows, content_cols);
                            ed.sel_anchor = ed.cursor; ed.sel_active = ed.cursor;
                        }
#endif
#ifdef REPORT_MOUSE_POSITION
                        if((ev.bstate & REPORT_MOUSE_POSITION) && (ev.bstate & BUTTON1_PRESSED)){
                            // extend selection during drag
                            editor_click(&ed, ly, adjx, content_rows, content_cols);
                            ed.sel_active = ed.cursor;
                        }
#endif
#ifdef BUTTON1_RELEASED
                        if(ev.bstate & BUTTON1_RELEASED){
                            ed.sel_active = ed.cursor;
                        }
#endif
                        // wheel vertical (scroll view)
#ifdef BUTTON4_PRESSED
                        if(ev.bstate & (BUTTON4_PRESSED|BUTTON4_CLICKED)){ editor_scroll_lines(&ed, -3); }
#endif
#ifdef BUTTON5_PRESSED
                        if(ev.bstate & (BUTTON5_PRESSED|BUTTON5_CLICKED)){ editor_scroll_lines(&ed, +3); }
#endif
                    }
                }
            } else if(ch==27){ /* ESC ignored */ }
            else if(ch>=32 && ch<=126){ editor_insert_char(&ed, (char)ch); editor_clear_selection(&ed); }

            // Page scroll
            if(ch==KEY_PPAGE){
                int content_rows = getmaxy(T.left)-2;
                int delta = (content_rows>1)? (-(content_rows-1)) : -1;
                editor_scroll_lines(&ed, delta);
            } else if(ch==KEY_NPAGE){
                int content_rows = getmaxy(T.left)-2;
                int delta = (content_rows>1)? (+(content_rows-1)) : +1;
                editor_scroll_lines(&ed, delta);
            }

            const char *fp = HAS_CURRENT_FILE ? CURRENT_FILE : "(untitled)";
            tui_draw_editor(&T, &ed, RIGHTBUF, STATUS, fp);
        }
        else if(g_screen==SCREEN_LOGS){
            // Logs: filtering + scrolling
            int pane_rows = getmaxy(T.left)-2; if(pane_rows < 1) pane_rows = 1;

            if(ch>='1' && ch<='5'){
                int n = ch - '1';
                LOG_FILTER = (log_level_t)n;
                LOG_SCROLL = 0; // jump to newest when changing filter
                // keep right-pane scroll as-is
                char *s; asprintf(&s,"Log filter -> %s", log_level_name(LOG_FILTER));
                free(STATUS); STATUS=s;
                LOG_TRACE("Log filter set to %s", log_level_name(LOG_FILTER));
            } else if(ch==KEY_UP){ LOG_SCROLL += 1; }
            else if(ch==KEY_DOWN){ if(LOG_SCROLL>0) LOG_SCROLL -= 1; }
            else if(ch==KEY_PPAGE){ LOG_SCROLL += pane_rows - 1; }
            else if(ch==KEY_NPAGE){ LOG_SCROLL -= pane_rows - 1; if(LOG_SCROLL<0) LOG_SCROLL=0; }
            else if(ch==KEY_HOME){ LOG_SCROLL = INT_MAX; }  // will clamp inside draw
            else if(ch==KEY_END){ LOG_SCROLL = 0; }
            else if(ch==KEY_MOUSE){
                MEVENT ev; if(getmouse(&ev)==OK){
                    if(ev.x < T.split_col){
                        // wheel over LEFT pane scrolls logs
#ifdef BUTTON4_PRESSED
                        if(ev.bstate & (BUTTON4_PRESSED|BUTTON4_CLICKED)){ LOG_SCROLL += 3; }
#endif
#ifdef BUTTON5_PRESSED
                        if(ev.bstate & (BUTTON5_PRESSED|BUTTON5_CLICKED)){
                            if(LOG_SCROLL>0){
                                int d = LOG_SCROLL>=3 ? 3 : LOG_SCROLL;
                                LOG_SCROLL -= d;
                            }
                        }
#endif
                    } else {
                        // wheel over RIGHT pane scrolls Config block
#ifdef BUTTON4_PRESSED
                        if(ev.bstate & (BUTTON4_PRESSED|BUTTON4_CLICKED)){
                            if(LOG_RHS_SCROLL>0){
                                int d = LOG_RHS_SCROLL>=3 ? 3 : LOG_RHS_SCROLL;
                                LOG_RHS_SCROLL -= d;
                            }
                        }
#endif
#ifdef BUTTON5_PRESSED
                        if(ev.bstate & (BUTTON5_PRESSED|BUTTON5_CLICKED)){ LOG_RHS_SCROLL += 3; }
#endif
                    }
                }
            }
            tui_draw_logs(&T, LOG_FILTER, STATUS, &LOG_SCROLL, &LOG_RHS_SCROLL);
        }
        else if(g_screen==SCREEN_CONTEXT){
            bool need_preview_rebuild = false;

            if(ch==KEY_UP && SEL_INDEX>0) SEL_INDEX--;
            else if(ch==KEY_DOWN && SEL_INDEX<FL.count-1) SEL_INDEX++;
            else if(ch=='\n' && FL.count>0){
                char *selpath=NULL; asprintf(&selpath, "%s/%s", CWD, FL.items[SEL_INDEX].name);
                // Open -> switch to editor; keep logs scroll as-is
                if(selpath){ 
                    if(fs_is_dir(selpath)) LOG_SCROLL = 0; // not strictly necessary
                }
                open_item_by_path(selpath, &ed, &need_preview_rebuild);
                free(selpath);
            } else if(ch==KEY_MOUSE){
                MEVENT ev; if(getmouse(&ev)==OK){
                    if(ev.x < T.split_col){
                        // Left pane clicks: update SEL_INDEX; left-click opens; right-click toggles context
                        int wy = ev.y - getbegy(T.left);   // window-relative Y
                        int idx = wy - 3;                  // items start at row 3

                        if(idx>=0 && idx<FL.count){
                            if(ev.bstate & (BUTTON1_CLICKED | BUTTON1_RELEASED | BUTTON1_DOUBLE_CLICKED)){
                                SEL_INDEX = idx;
                                char *p=NULL; asprintf(&p, "%s/%s", CWD, FL.items[idx].name);
                                if(p){ open_item_by_path(p, &ed, &need_preview_rebuild); }
                                free(p);
                            }
                            if((ev.bstate & (BUTTON3_CLICKED|BUTTON3_PRESSED)) && !FL.items[idx].is_dir){
                                char *p=NULL; asprintf(&p, "%s/%s", CWD, FL.items[idx].name);
                                if(p){
                                    ctx_toggle(&CTX_FILES, &CTX_COUNT, p);
                                    need_preview_rebuild = true;
                                    char *msg=NULL;
                                    if(ctx_has(CTX_FILES, CTX_COUNT, p)) asprintf(&msg, "Context: included %s", FL.items[idx].name);
                                    else                                   asprintf(&msg, "Context: removed %s",  FL.items[idx].name);
                                    free(STATUS); STATUS=msg;
                                }
                                free(p);
                            }
                        }
                    } else {
                        // Right pane: mouse wheel scrolls context preview
#ifdef BUTTON4_PRESSED
                        if(ev.bstate & (BUTTON4_PRESSED|BUTTON4_CLICKED)){ if(CTX_SCROLL>0) CTX_SCROLL -= 3; if(CTX_SCROLL<0) CTX_SCROLL=0; }
#endif
#ifdef BUTTON5_PRESSED
                        if(ev.bstate & (BUTTON5_PRESSED|BUTTON5_CLICKED)){ CTX_SCROLL += 3; if(CTX_SCROLL>CTX_PREVIEW_LINES) CTX_SCROLL=CTX_PREVIEW_LINES; }
#endif
                    }
                }
            } else if(ch==KEY_PPAGE){ if(CTX_SCROLL>0){ int jump=10; if(CTX_SCROLL<jump) CTX_SCROLL=0; else CTX_SCROLL-=jump; } }
            else if(ch==KEY_NPAGE){ CTX_SCROLL += 10; if(CTX_SCROLL>CTX_PREVIEW_LINES) CTX_SCROLL=CTX_PREVIEW_LINES; }
            else if(ch==KEY_F(1) || ch==27){ g_screen = SCREEN_EDITOR; }

            if(need_preview_rebuild){
                free(CTX_PREVIEW);
                CTX_PREVIEW = preview_build(CWD, CTX_FILES, CTX_COUNT, &CTX_PREVIEW_LINES);
                if(CTX_SCROLL > CTX_PREVIEW_LINES) CTX_SCROLL = CTX_PREVIEW_LINES;
            }

            // Draw the appropriate screen after possible state change
            if(g_screen==SCREEN_CONTEXT){
                tui_draw_context(&T, CWD, &FL, SEL_INDEX, &cfg, CTX_FILES, CTX_COUNT, CTX_PREVIEW, CTX_SCROLL, STATUS);
            } else if(g_screen==SCREEN_EDITOR){
                const char *fp = HAS_CURRENT_FILE ? CURRENT_FILE : "(untitled)";
                tui_draw_editor(&T, &ed, RIGHTBUF, STATUS, fp);
            }
        }

        // Extra function keys
        if(ch==KEY_F(5)){ // latexmk -pdf
            free(STATUS); STATUS=strdup("Running latexmk -pdf ...");
            LOG_DEBUG("latexmk -pdf started");
            char cmd[1024]; snprintf(cmd,sizeof(cmd),"latexmk -pdf -halt-on-error 2>&1 | tail -n 8");
            FILE *p=popen(cmd,"r"); char line[512]; free(RIGHTBUF); RIGHTBUF=strdup("");
            int lines=0;
            while(p && fgets(line,sizeof(line),p)){
                size_t cur=strlen(RIGHTBUF);
                RIGHTBUF=realloc(RIGHTBUF,cur+strlen(line)+1);
                strcpy(RIGHTBUF+cur,line); lines++;
            }
            int rc = p ? pclose(p) : -1;
            LOG_DEBUG("latexmk finished rc=%d, captured_lines=%d", rc, lines);
        }
    }

    tui_end();
    free_file_list(&FL);
    for(int i=0;i<CTX_COUNT;i++) free(CTX_FILES[i]);
    free(CTX_FILES);
    free(CTX_PREVIEW);
    clipboard_free();
    log_shutdown();
    buf_free(&doc); free(RIGHTBUF); free(STATUS);

    /* free trimmed env copies */
    free(cfg.model);
    free(cfg.api_key);
    free(cfg.base_url);

    return 0;
}
