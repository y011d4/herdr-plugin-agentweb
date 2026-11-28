#!/bin/sh
# scripts/check-names.sh: keeps names that must never be public (the user's work names) out of this public
# repository: its tree, its commits, its PRs' text and the PR screenshots' text. The names themselves are never in
# the repo: a denylist of case-insensitive extended regexes, one per line (`#` comments and blank lines skipped), read
# from $DENYLIST (its content: CI, from the NAMES_DENYLIST secret) or else the file $YOICKS_DENYLIST, default
# ${XDG_CONFIG_HOME:-~/.config}/herdr-yoicks/denylist. No denylist, an empty one or a failing grep is an error
# (exit 2): never a pass.
#
#   check-names.sh tree REV           every text file's content and every path in REV's tree
#   check-names.sh text FILE...       the files' text (a PR's title and body, commit messages, a shot's text)
#   check-names.sh pre-commit         the lines and paths the staged change adds (git's pre-commit hook)
#   check-names.sh commit-msg FILE    the commit message (git's commit-msg hook)
#   check-names.sh commits ARGS...    the messages of the commits `git log ARGS` lists and the lines they add
#   check-names.sh pre-push           what a push sends, from git's stdin: each ref's name, its tree, and the
#                                     messages and patches of the commits no remote-tracking ref has yet
#   check-names.sh install            installs the three hooks in this clone (all its worktrees)
#
# Exit 0: none found; 1: found. Where it was found is printed (paths, line numbers; never the text matched), and
# under CI (CI=true, set by GitHub Actions) only how many places, since a public run's log would show a path.
set -eu

die() { echo "check-names: $*" >&2; exit 2; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
pat=$tmp/patterns

load() {
  if [ -n "${DENYLIST:-}" ]; then
    printf '%s\n' "$DENYLIST" > "$tmp/raw"
  else
    f=${YOICKS_DENYLIST:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr-yoicks/denylist}
    [ -r "$f" ] || die "no denylist at $f (one case-insensitive extended regex per line; see scripts/check-names.sh)"
    cat "$f" > "$tmp/raw"
  fi
  sed -e 's/\r$//' -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' "$tmp/raw" > "$pat"
  [ -s "$pat" ] || die "the denylist is empty"
}

# a grep into $tmp/out: its exit 1 is "none", anything above it an error (a bad regex, a bad rev), never "none"
g() {
  r=0
  "$@" > "$tmp/out" || r=$?
  [ "$r" -le 1 ] || die "$1 failed (exit $r)"
}

found=0
# $1: what was checked; $tmp/hits: one place per line
report() {
  sort -u "$tmp/hits" > "$tmp/places"
  n=$(grep -c . "$tmp/places" || true)
  [ "$n" -eq 0 ] && return 0
  found=1
  if [ "${CI:-}" = true ]; then
    echo "check-names: $1: a denylisted name in $n place(s) (not shown here: the log is public; run scripts/check-names.sh locally)" >&2
  else
    echo "check-names: $1: a denylisted name in:" >&2
    sed 's/^/  /' "$tmp/places" >&2
  fi
}

tree() {
  git rev-parse -q --verify "$1^{tree}" > /dev/null || die "no such commit: $1"
  g git grep -I -i -E -c -f "$pat" "$1" -- # REV:path:count
  sed -E 's/^[^:]*:(.*):[0-9]+$/\1/' "$tmp/out" > "$tmp/hits"; report "the tree of $1"
  git -c core.quotePath=false ls-tree -r --name-only "$1" > "$tmp/paths" # a non-ASCII path as itself, not escaped
  g grep -i -E -f "$pat" "$tmp/paths"
  sed 's/$/ (its path)/' "$tmp/out" > "$tmp/hits"; report "the paths of $1"
}

text() {
  for f in "$@"; do [ -r "$f" ] || die "no such file: $f"; done
  g grep -i -E -n -f "$pat" "$@" /dev/null
  sed -E 's/^(.*:[0-9]+):.*/\1/' "$tmp/out" > "$tmp/hits"; report "text"
}

# the lines a patch adds (a removed line was public before, or added by a commit checked too)
added() { sed -n -e '/^[+][+][+] /d' -e 's/^[+]//p'; }

# the messages of the commits `git log ARGS` lists, and the lines their patches add
commits() {
  git log --format='%B' "$@" > "$tmp/msgs"
  g grep -i -E -c -f "$pat" "$tmp/msgs"
  sed -E 's/^([1-9][0-9]*)$/\1 line(s) of their messages/; /^0$/d' "$tmp/out" > "$tmp/hits"; report "the commits of git log $*"
  # a merge too, against its first parent: what its resolution brings in
  git log -p --diff-merges=first-parent --format= --no-color --no-ext-diff --text "$@" | added > "$tmp/added"
  g grep -i -E -c -f "$pat" "$tmp/added"
  sed -E 's/^([1-9][0-9]*)$/\1 line(s) their patches add/; /^0$/d' "$tmp/out" > "$tmp/hits"; report "the commits of git log $*"
}

install() {
  d=$(git rev-parse --path-format=absolute --git-common-dir)/hooks
  mkdir -p "$d"
  cp "$0" "$d/check-names.sh"
  for h in pre-commit commit-msg; do
    if [ -e "$d/$h" ] && ! grep -q 'check-names' "$d/$h"; then die "$d/$h exists and isn't ours: add a call to check-names.sh $h to it by hand"; fi
    printf '#!/bin/sh\nexec sh "$(dirname "$0")/check-names.sh" %s "$@"\n' "$h" > "$d/$h"
    chmod +x "$d/$h"
  done
  # pre-push: our line first, in front of whatever is there (roborev's, say), which then reads the same ref
  # updates from stdin: they are kept in a file, and the rest of the hook reads that (an earlier line of ours goes)
  # (no file, or no copy of the updates: the push stops; it never goes on to the rest unchecked)
  line='{ i=$(mktemp) && cat > "$i"; } || { rm -f "${i:-}"; exit 1; }; sh "$(dirname "$0")/check-names.sh" pre-push "$@" < "$i" || { rm -f "$i"; exit 1; }; exec < "$i"; rm -f "$i" # check-names'
  if [ ! -e "$d/pre-push" ]; then printf '#!/bin/sh\n' > "$d/pre-push"; fi
  { head -n 1 "$d/pre-push"; echo "$line"; tail -n +2 "$d/pre-push" | grep -v '# check-names$' || true; } > "$tmp/pre-push"
  cat "$tmp/pre-push" > "$d/pre-push"
  chmod +x "$d/pre-push"
  load
  echo "check-names: hooks installed in $d ($(grep -c . "$pat") names in the denylist)"
}

cmd=${1:-}
[ $# -gt 0 ] && shift
case $cmd in
  install) install; exit 0 ;;
  tree) [ $# -eq 1 ] || die "usage: check-names.sh tree REV"; load; tree "$1" ;;
  text) [ $# -ge 1 ] || die "usage: check-names.sh text FILE..."; load; text "$@" ;;
  commit-msg) [ $# -ge 1 ] || die "usage: check-names.sh commit-msg FILE"; load; text "$1" ;;
  commits) [ $# -ge 1 ] || die "usage: check-names.sh commits REV-RANGE..."; load; commits "$@" ;;
  pre-commit)
    load
    git diff --cached -U0 --no-color --no-ext-diff --text | added > "$tmp/added"
    g grep -i -E -c -f "$pat" "$tmp/added"
    sed -E 's/^([1-9][0-9]*)$/\1 line(s) it adds/; /^0$/d' "$tmp/out" > "$tmp/hits"; report "the staged change"
    git -c core.quotePath=false diff --cached --name-only --diff-filter=ACR > "$tmp/paths"
    g grep -i -E -f "$pat" "$tmp/paths"
    sed 's/$/ (its path)/' "$tmp/out" > "$tmp/hits"; report "the staged paths"
    ;;
  pre-push)
    load
    z=0000000000000000000000000000000000000000 remote=${1:-}
    while read -r lref lsha rref rsha; do
      [ "$lsha" = "$z" ] && continue # a deletion
      printf '%s\n' "$rref" > "$tmp/ref"
      g grep -i -E -c -f "$pat" "$tmp/ref"
      sed "/^0\$/d; s#.*#the name of the ref it pushes to#" "$tmp/out" > "$tmp/hits"; report "$rref"
      tree "$lsha"
      # what the destination has already: its remote-tracking refs only (a push to a bare URL: none, so all of it)
      if [ -n "$remote" ]; then commits "$lsha" --not --remotes="$remote"; else commits "$lsha"; fi
    done
    ;;
  *) die "usage: check-names.sh tree REV | text FILE... | pre-commit | commit-msg FILE | commits ARGS... | pre-push | install" ;;
esac
exit "$found"
