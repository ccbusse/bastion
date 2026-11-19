#!/usr/bin/env bash
# Neue Bastion-Version vorbereiten: Versionsnummer überall setzen, Changelog-Abschnitt anlegen, committen, taggen.
#   scripts/release.sh 2.3.0
# Danach pushen (Befehl wird ausgegeben). Der Workflow "Release" veröffentlicht Images und GitHub-Release,
# sobald die CI für den Commit grün ist (bei Fehler: CI abwarten, dann Workflow "Release" mit dem Tag erneut starten).
set -euo pipefail

cd "$(dirname "$0")/.."              # Hauptverzeichnis des Repos
VERSION=${1:-}
[[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Aufruf: scripts/release.sh X.Y.Z" >&2; exit 2; }
TAG="v$VERSION"
OLD=$(cat VERSION)

[ "$(git rev-parse --abbrev-ref HEAD)" = "master" ] || { echo "Nur auf master veröffentlichen." >&2; exit 1; }
git diff --cached --quiet || { echo "Es sind bereits Änderungen vorgemerkt (git add). Erst committen oder zurücknehmen." >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "Tag $TAG gibt es schon." >&2; exit 1; }
grep -q '^## \[Unveröffentlicht\]' CHANGELOG.md || { echo "CHANGELOG.md: Abschnitt [Unveröffentlicht] fehlt." >&2; exit 1; }

# Changelog: Inhalt von [Unveröffentlicht] wird zur neuen Version, darüber ein leerer Abschnitt [Unveröffentlicht]
if ! grep -q "^## \[$VERSION\]" CHANGELOG.md; then
  body=$(awk '/^## \[Unveröffentlicht\]/{on=1; next} /^## \[/{on=0} on' CHANGELOG.md | grep -v '^\s*$' || true)
  [ -n "$body" ] || { echo "CHANGELOG.md: Unter [Unveröffentlicht] steht nichts. Erst die Änderungen eintragen." >&2; exit 1; }
  sed -i "s/^## \[Unveröffentlicht\]$/## [Unveröffentlicht]\n\n## [$VERSION] – $(date +%F)/" CHANGELOG.md
fi

echo "$VERSION" > VERSION
(cd web && npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null)
(cd extension && npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null)
sed -i -E "s/BASTION_VERSION:-[0-9]+\.[0-9]+\.[0-9]+\}/BASTION_VERSION:-$VERSION}/g" compose.yml
[ "$(grep -c "BASTION_VERSION:-$VERSION}" compose.yml)" -eq 4 ] || { echo "compose.yml: Version nicht in allen 4 Diensten gesetzt." >&2; exit 1; }

git add VERSION CHANGELOG.md compose.yml web/package.json web/package-lock.json extension/package.json extension/package-lock.json
if git diff --cached --quiet; then
  echo "Version $VERSION ist bereits eingetragen (z. B. im Feature-Commit); lege nur den Tag an."
else
  git commit -q -m "Bastion $VERSION"
fi
git tag -a "$TAG" -m "Bastion $VERSION"

echo "Version $OLD → $VERSION vorbereitet, Tag $TAG angelegt."
echo "Veröffentlichen:  git push origin master && git push origin $TAG"
