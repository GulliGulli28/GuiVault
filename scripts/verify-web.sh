#!/usr/bin/env bash
# La page que sert ce serveur est-elle celle du code publié ?
#
#   scripts/verify-web.sh https://vault.example.com [commit]
#
# Reconstruit l'interface web du commit (celui que le serveur annonce dans
# /api/v1/health, à défaut le second argument) dans un arbre à part, puis
# compare chaque fichier de web/dist, octet par octet (SHA-256), à ce que le
# serveur sert. Le build est reproductible : mêmes sources et même
# package-lock.json, mêmes octets, quel que soit le poste (Node 20 ou 22).
#
# Ce que ça prouve : la page servie à CE poste, maintenant, est celle de ce
# commit. Pas qu'elle l'est pour tout le monde — un serveur malveillant peut
# servir une autre page à quelqu'un d'autre (docs/SECURITY.md, « Interface
# web »).
set -euo pipefail

url=${1:?"usage : scripts/verify-web.sh https://vault.example.com [commit]"}
url=${url%/}
commit=${2:-}
if [ -z "$commit" ]; then
  commit=$(curl -fsS "$url/api/v1/health" | sed -n 's/.*"build_commit":"\([0-9a-f]\{7,40\}\)".*/\1/p')
  [ -n "$commit" ] || { echo "Le serveur n'annonce pas son commit : passez-le en second argument." >&2; exit 2; }
fi

repo=$(git rev-parse --show-toplevel)
work=$(mktemp -d)
cleanup() {
  git -C "$repo" worktree remove --force "$work/src" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

git -C "$repo" cat-file -e "$commit^{commit}" 2>/dev/null || git -C "$repo" fetch -q origin "$commit"
git -C "$repo" worktree add -q --detach "$work/src" "$commit"
echo "Construction de l'interface de ${commit:0:12}…" >&2
if ! (cd "$work/src/web" && npm ci --no-audit --no-fund --loglevel=error && npm run build) >"$work/build.log" 2>&1; then
  cat "$work/build.log" >&2
  exit 1
fi

cd "$work/src/web/dist"
n=0
bad=0
check() { # $1 : chemin servi, $2 : fichier attendu
  local want got
  want=$(sha256sum "$2" | cut -c1-64)
  got=$(curl -fsS "$url/$1" | sha256sum | cut -c1-64) || got=absent
  if [ "$want" != "$got" ]; then
    bad=$((bad + 1))
    echo "DIFFÉRENT  /$1"
  fi
  n=$((n + 1))
}
while IFS= read -r f; do
  check "$f" "$f"
done < <(find . -type f | sed 's|^\./||' | sort)
check "" index.html # la racine sert index.html

if [ "$bad" -eq 0 ]; then
  echo "OK : les $n fichiers servis par $url sont ceux du commit ${commit:0:12}."
else
  echo "ÉCHEC : $bad fichier(s) sur $n diffèrent du commit ${commit:0:12}." >&2
  exit 1
fi
