#!/usr/bin/env bash
# parse_context.sh — export one or more project folders into a single bundle
#
# Usage:
#   ./parse_context.sh [options] /path/to/project1 [/path/to/project2 ...]
#
# Options:
#   -o, --out FILE           Output file (default: parse_temp.txt)
#       --no-fences          Do not wrap content in ``` fences
#       --list-only          Only list files (no contents)
#       --git                Use `git ls-files` (tracked files only)
#       --git-plus-untracked Include untracked files (respects .gitignore)
#   -x, --exclude GLOB       Extra exclude glob (repeatable)
#   -i, --include GLOB       Only include paths matching GLOB (repeatable)
#       --parseignore PATH   Read extra globs (one per line) from PATH
#       --max-file BYTES     Truncate any file above this size (0 = unlimited)
#       --max-total BYTES    Stop after writing this many bytes across ALL roots (0 = unlimited)
#   -v, --verbose            Print include/skip reasons to stderr
#   -h, --help               Show help
#
# Notes:
# - Groups output per root; prioritizes README/manifests.
# - Skips non-text files; language-aware code fences.
# - Excludes the output file if it falls under any root.
# 
# Examples:
# - Basic usage: ./parse_context.sh /path/to/project /path/to/project2
# - Only Makefiles: ./parse_context.sh -i '**/Makefile' /path/to/project

set -Euo pipefail
IFS=$'\n\t'

VERSION="2.4"

usage() {
  cat <<'USAGE'
parse_context.sh — export one or more project folders into a single bundle

Usage:
  ./parse_context.sh [options] /path/to/project1 [/path/to/project2 ...]

Options:
  -o, --out FILE           Output file (default: parse_temp.txt)
      --no-fences          Do not wrap content in ``` fences
      --list-only          Only list files (no contents)
      --git                Use `git ls-files` (tracked files only)
      --git-plus-untracked Include untracked files (respects .gitignore)
  -x, --exclude GLOB       Extra exclude glob (repeatable)
  -i, --include GLOB       Only include paths matching GLOB (repeatable)
      --parseignore PATH   Read extra globs (one per line) from PATH
      --max-file BYTES     Truncate any file above this size (0 = unlimited)
      --max-total BYTES    Stop after writing this many bytes across ALL roots (0 = unlimited)
  -v, --verbose            Print include/skip reasons to stderr
  -h, --help               Show help
USAGE
  exit "${1:-0}"
}

# ---------- defaults ----------
outfile="parse_temp.txt"
use_git=false
git_plus_untracked=false
no_fences=false
list_only=false
max_file_bytes=0
max_total_bytes=0
parseignore_file=""
verbose=0
declare -a extra_excludes=()
declare -a include_only=()
declare -a roots=()

# ---------- traps (only print real errors) ----------
trap 'code=$?; echo "❌ Error (exit $code) at line $LINENO: $BASH_COMMAND" >&2' ERR

# ---------- parse args ----------
if [[ $# -eq 0 ]]; then usage 1; fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--out)             outfile="${2:-}"; shift 2;;
    --no-fences)          no_fences=true; shift;;
    --list-only)          list_only=true; shift;;
    --git)                use_git=true; shift;;
    --git-plus-untracked) use_git=true; git_plus_untracked=true; shift;;
    -x|--exclude)         extra_excludes+=("$2"); shift 2;;
    -i|--include)         include_only+=("$2"); shift 2;;
    --parseignore)        parseignore_file="${2:-}"; shift 2;;
    --max-file)           max_file_bytes="${2:-0}"; shift 2;;
    --max-total)          max_total_bytes="${2:-0}"; shift 2;;
    -v|--verbose)         verbose=1; shift;;
    -h|--help)            usage 0;;
    --)                   shift; break;;
    -*)                   echo "Unknown option: $1" >&2; usage 1;;
    *)                    roots+=("$1"); shift;;
  esac
done
while [[ $# -gt 0 ]]; do roots+=("$1"); shift; done

# Validate roots -> absolute paths
valid_roots=()
for r in "${roots[@]:-}"; do
  if [[ -d "$r" ]]; then
    abs="$(cd "$r" && pwd)"
    valid_roots+=("$abs")
  else
    echo "Warning: '$r' is not a directory, skipping." >&2
  fi
done
if [[ ${#valid_roots[@]} -eq 0 ]]; then
  echo "Error: no valid project folders provided." >&2
  exit 1
fi

# Resolve absolute outfile and exclude it if it is inside any root
if command -v realpath >/dev/null 2>&1; then
  outfile_abs="$(realpath -m "$outfile")"
else
  outdir="$(cd "$(dirname "$outfile")" && pwd)"
  outfile_abs="$outdir/$(basename "$outfile")"
fi

# ---------- helpers ----------
vlog() { if (( verbose )); then printf '%s\n' "$*" >&2; fi; }

file_size() {
  local f="$1"
  if stat -c%s "$f" >/dev/null 2>&1; then stat -c%s "$f"; else stat -f%z "$f"; fi
}
sha256_of() {
  local f="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$f" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$f" | awk '{print $1}'
  else
    echo "n/a"
  fi
}
is_text_file() {
  local f="$1" mt
  if mt=$(file -bi "$f" 2>/dev/null); then
    mt="${mt%%;*}"
    case "$mt" in
      text/*|application/json|application/xml|application/javascript|application/x-sh|application/x-yaml|application/toml|inode/x-empty) return 0 ;;
      *) return 1 ;;
    esac
  else
    grep -qI . "$f"
  fi
}
lower_ext() {
  local p="$1" ext="${p##*.}"
  printf '%s' "$ext" | tr '[:upper:]' '[:lower:]'
}
lang_for_path() {
  local p="$1" ext; ext="$(lower_ext "$p")"
  case "$ext" in
    c|h) echo "c" ;;
    cc|cpp|cxx|hpp|hh|hxx) echo "cpp" ;;
    rs) echo "rust" ;;
    py) echo "python" ;;
    js|mjs|cjs) echo "javascript" ;;
    ts) echo "typescript" ;;
    tsx) echo "tsx" ;;
    jsx) echo "jsx" ;;
    go) echo "go" ;;
    java) echo "java" ;;
    cs) echo "csharp" ;;
    rb) echo "ruby" ;;
    php) echo "php" ;;
    sh|bash|zsh) echo "bash" ;;
    toml) echo "toml" ;;
    yaml|yml) echo "yaml" ;;
    json) echo "json" ;;
    html|htm) echo "html" ;;
    css|scss) echo "css" ;;
    sql) echo "sql" ;;
    xml) echo "xml" ;;
    md) echo "markdown" ;;
    *) echo "" ;;
  esac
}
first_matching_glob() {
  local path="$1"; shift
  local pat
  for pat in "$@"; do
    if [[ "$path" == $pat ]]; then
      echo "$pat"
      return 0
    fi
  done
  return 1
}
matches_any_glob() {
  local path="$1"; shift
  first_matching_glob "$path" "$@" >/dev/null
}
append_line() { printf "%s\n" "$1" >> "$outfile"; }
append_blank() { printf "\n" >> "$outfile"; }

# ---------- ignore lists ----------
ignore_list=(
  "*/.git/*" "*/.github/*" "*/node_modules/*" "*/target/*" "*/dist/*" "*/build/*"
  "*/venv/*" "*/__pycache__/*" "*/.idea/*" "*/.vscode/*" "*/.DS_Store"
  "*.lock" "*.log" "*.png" "*.jpg" "*.jpeg" "*.gif" "*.ico" "*.svg" "*.pdf"
  "*.zip" "*.tar" "*.gz" "*.bz2" "*.xz" "*.7z" "*.rar" "*.wasm" "*.exe" "*.dll"
  "*.bin" "*.so" "*.dylib" "*.class" "*.o" "*.a" "*.pyc"
  ".env" "*/.env" ".env.*" "*/.env.*" "*.pem" "*.key" "*id_rsa*" "*id_ed25519*" "*.p12" "*.pfx"
  "*.keystore" "*.jks" "*secrets*" "*credentials*" "*private*"
)
if [[ -n "$parseignore_file" ]]; then
  if [[ -f "$parseignore_file" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ -z "$line" || "$line" =~ ^# ]] && continue
      ignore_list+=("$line")
    done < "$parseignore_file"
  else
    echo "Warning: --parseignore '$parseignore_file' not found." >&2
  fi
fi
if [[ ${#extra_excludes[@]} -gt 0 ]]; then
  ignore_list+=("${extra_excludes[@]}")
fi

# ---------- prioritized names within each root ----------
prioritize_first=(
  "README.md" "README" "readme.md" "LICENSE" "LICENSE.md"
  "package.json" "pnpm-lock.yaml" "yarn.lock"
  "Cargo.toml" "Cargo.lock"
  "pyproject.toml" "requirements.txt" "Pipfile" "Pipfile.lock"
  "go.mod" "go.sum"
  ".env.example" ".env.sample" "docker-compose.yml" "Dockerfile"
)

# ---------- header ----------
: > "$outfile"
append_line "# Multi-project export"
append_line "# Roots:"
for r in "${valid_roots[@]}"; do append_line "#   - $r"; done
append_line "# Date: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
append_line "# Script: parse_context.sh v$VERSION"
append_blank

total_written=0
total_files=0
total_skipped=0
stop_now=0   # 0=false, 1=true

emit_file_block() {
  # args: root abs_file relpath
  local root="$1" file="$2" relpath="$3"

  # include-only filter
  if [[ ${#include_only[@]} -gt 0 ]]; then
    if ! matches_any_glob "$relpath" "${include_only[@]}"; then
      vlog "[skip include] $relpath — not in include filters"
      return 0
    fi
  fi
  # defensive ignore check
  local ignore_pat
  if ignore_pat="$(first_matching_glob "$relpath" "${ignore_list[@]}")"; then
    vlog "[skip ignore:$ignore_pat] $relpath"
    return 0
  fi

  local size sha lines
  size=$(file_size "$file" || echo 0)
  sha=$(sha256_of "$file")
  lines=$(wc -l < "$file" || echo 0)

  # Respect global max-total
  if (( max_total_bytes > 0 )) && (( total_written >= max_total_bytes )); then
    if (( stop_now == 0 )); then
      append_line "### Reached --max-total=$max_total_bytes bytes. Stopping."
      vlog "[stop max-total] reached $total_written / $max_total_bytes"
    end_if=true
    fi
    stop_now=1
    return 1
  fi

  if ! is_text_file "$file"; then
    append_line "===== FILE (skipped non-text): $relpath (bytes=$size, sha256=$sha) ====="
    append_blank
    vlog "[skip non-text] $relpath"
    (( total_skipped += 1 ))
    return 0
  fi

  append_line "===== FILE: $relpath (bytes=$size, lines=$lines, sha256=$sha) ====="
  vlog "[include] $relpath ($size bytes)"

  if [[ "$list_only" == true ]]; then
    (( total_files += 1 ))
    return 0
  fi

  # Open fence if enabled
  local opened_fence=0
  if [[ "$no_fences" == false ]]; then
    local lang; lang="$(lang_for_path "$relpath")"
    if [[ -n "$lang" ]]; then
      append_line "$(printf '```%s' "$lang")"
    else
      append_line '```'
    fi
    opened_fence=1
  fi

  if (( max_file_bytes > 0 )) && (( size > max_file_bytes )); then
    head -c "$max_file_bytes" "$file" >> "$outfile"
    if (( opened_fence == 1 )); then
      append_line ""
      append_line '```'
    fi
    append_line "<<< TRUNCATED to ${max_file_bytes} bytes (original: ${size} bytes) >>>"
    append_blank
    vlog "[truncate] $relpath -> ${max_file_bytes} bytes (orig ${size})"
    (( total_written += max_file_bytes ))
  else
    cat "$file" >> "$outfile"
    if (( opened_fence == 1 )); then
      append_line ""
      append_line '```'
    fi
    append_blank
    (( total_written += size ))
  fi

  (( total_files += 1 ))

  if (( max_total_bytes > 0 )) && (( total_written >= max_total_bytes )); then
    append_line "### Reached --max-total=$max_total_bytes bytes. Stopping."
    vlog "[stop max-total] reached $total_written / $max_total_bytes"
    stop_now=1
    return 1
  fi
  return 0
}

process_root() {
  local root="$1"
  append_line "## Root: $root"
  if git -C "$root" rev-parse --short HEAD >/dev/null 2>&1; then
    append_line "### Git: $(git -C "$root" rev-parse --short HEAD) (branch: $(git -C "$root" rev-parse --abbrev-ref HEAD))"
  fi
  append_blank
  vlog "[root] $root"

  # Build file list
  declare -a files_local=()

  if [[ "$use_git" == true ]] && git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    while IFS= read -r -d '' f; do files_local+=("$root/$f"); done < <(git -C "$root" ls-files -z)
    if [[ "$git_plus_untracked" == true ]]; then
      while IFS= read -r -d '' f; do files_local+=("$root/$f"); done < <(git -C "$root" ls-files -z --others --exclude-standard)
    fi
  else
    exclude_args=()
    for pattern in "${ignore_list[@]}"; do
      exclude_args+=( ! -path "$pattern" )
    done
    case "$outfile_abs" in
      "$root"/*) exclude_args+=( ! -path "$outfile_abs" );;
    esac
    while IFS= read -r -d '' f; do files_local+=("$f"); done < <(find "$root" -type f "${exclude_args[@]}" -print0 2>/dev/null)
  fi

  # Prioritize key files within this root
  declare -a ordered=()
  declare -A seen=()
  for pf in "${prioritize_first[@]}"; do
    for f in "${files_local[@]}"; do
      rel="${f#$root/}"
      if [[ "$rel" == "$pf" ]]; then
        ordered+=("$f"); seen["$f"]=1
      fi
    done
  done
  for f in "${files_local[@]}"; do
    if [[ -n "${seen[$f]:-}" ]]; then
      continue
    fi
    ordered+=("$f")
  done

  # Emit files
  local root_files=0 root_skipped_before=$total_skipped
  for f in "${ordered[@]}"; do
    rel="${f#$root/}"
    emit_file_block "$root" "$f" "$rel" || true
    if (( stop_now == 1 )); then
      break
    fi
    (( root_files += 1 ))
  done
  local root_skipped=$(( total_skipped - root_skipped_before ))

  append_line "### Root summary: files_included=$root_files, skipped_non_text=$root_skipped"
  append_blank
  vlog "[root summary] included=$root_files skipped_non_text=$root_skipped"
}

# ---------- process all roots ----------
for r in "${valid_roots[@]}"; do
  if (( stop_now == 1 )); then
    break
  fi
  process_root "$r"
done

append_line "---"
append_line "Included files (total): $total_files"
append_line "Skipped non-text (total): $total_skipped"
append_line "Total bytes written: $total_written"
append_line "Done."

echo "✅ Wrote $outfile"
echo "   Roots: ${#valid_roots[@]}, Included: $total_files, Skipped(non-text): $total_skipped, Bytes: $total_written"
