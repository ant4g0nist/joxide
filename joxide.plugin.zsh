# joxide: semantic directory navigation over zoxide's real path index.
[[ -o interactive ]] || return 0

typeset -g _JOXIDE_ROOT=${${(%):-%x}:A:h}
: ${JOXIDE_NODE:=node}
: ${JOXIDE_ZOXIDE:=zoxide}
: ${JOXIDE_DATA_DIR:=${XDG_DATA_HOME:-$HOME/.local/share}/joxide}

zmodload zsh/datetime
autoload -Uz add-zsh-hook

_joxide_cli() {
  JOXIDE_DATA_DIR="$JOXIDE_DATA_DIR" JOXIDE_ZOXIDE="$JOXIDE_ZOXIDE" \
    command "$JOXIDE_NODE" "$_JOXIDE_ROOT/src/jump/cli.ts" "$@"
}

_joxide_record() {
  emulate -L zsh
  local pattern current=${PWD:A}
  for pattern in "${(@s.:.)${_ZO_EXCLUDE_DIRS-$HOME}}"; do
    [[ -n $pattern && ( $PWD == ${~pattern} || $current == ${~pattern} ) ]] && return 0
  done
  [[ $PWD == *[[:cntrl:]]* ]] && return 0
  # Reuse an existing zoxide hook if the user has one; otherwise maintain its index.
  if (( ! ${chpwd_functions[(Ie)__zoxide_hook]:-0} && ! ${precmd_functions[(Ie)__zoxide_hook]:-0} )); then
    command "$JOXIDE_ZOXIDE" add -- "$current" 2>/dev/null || return 0
  fi
  (
    umask 077
    [[ -d $JOXIDE_DATA_DIR ]] || command mkdir -p -- "$JOXIDE_DATA_DIR" || return
    print -r -- "$EPOCHSECONDS"$'\t'"$current" >> "$JOXIDE_DATA_DIR/visits.tsv"
  )
}

jctl() { _joxide_cli control "$@" }

j() {
  emulate -L zsh
  if (( $# == 0 )); then builtin cd -- "$HOME"; return; fi
  if (( $# == 1 )) && [[ $1 == - ]]; then builtin cd -; return; fi
  local arg
  for arg in "$@"; do
    if [[ $arg == --json || $arg == --list || $arg == --dry-run || $arg == --help || $arg == -h ]]; then
      _joxide_cli "$@"
      return
    fi
  done
  if (( $# == 1 )) && [[ -d $1 ]]; then builtin cd -- "$1"; return; fi
  local result
  result=$(_joxide_cli --shell "$@") || return $?
  local -a lines=("${(@f)result}")
  local target selection
  case ${lines[1]} in
    selected) target=${lines[2]} ;;
    choose)
      local count=$(( $#lines - 1 ))
      [[ -t 0 ]] || { print -u2 -- 'joxide: Ambiguous match. Use --list or an interactive terminal.'; return 2; }
      read -r "selection?Jump [1-$count, Enter to cancel]: " || return 2
      [[ -n $selection && $#selection -le 3 && $selection != *[^0-9]* ]] || return 2
      (( selection = 10#$selection ))
      (( selection >= 1 && selection <= count )) || return 2
      target=${lines[$(( selection + 1 ))]}
      ;;
    *) return 2 ;;
  esac
  [[ $target == /* && $target != *[[:cntrl:]]* && -d $target ]] || { print -u2 -- 'joxide: Destination no longer exists.'; return 2; }
  builtin cd -- "$target" || return
  print -u2 -r -- "→ $PWD"
}

# Avoid duplicate recording when loading the renamed plugin in an existing shell.
add-zsh-hook -d chpwd _jev_jump_record 2>/dev/null
add-zsh-hook -d chpwd _joxide_record 2>/dev/null
add-zsh-hook chpwd _joxide_record
if (( ! ${+_JOXIDE_LOADED} )); then
  typeset -g _JOXIDE_LOADED=1
  _joxide_record
fi
