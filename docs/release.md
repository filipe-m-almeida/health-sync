# Release Process

Use these steps whenever the user asks for a release.

## Default version bump rule

- Default to a **patch** bump.
- Only use `minor`, `major`, or pre-release bumps if the user explicitly asks.

## 0) Preflight checks

```bash
git status --short
gh auth status
npm whoami
clawhub whoami
npm run check
npm test
```

Release only from a clean working tree, unless the user explicitly asks otherwise.

## 1) Bump version and create tag

```bash
BUMP=${BUMP:-patch}   # default behavior
npm version "$BUMP" -m "release: v%s"
VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"
```

`npm version` updates `package.json` and `package-lock.json`, creates the release commit, and creates the Git tag.

## 2) Create release notes from diff vs previous tag

Release notes must be based on the code diff between the previous tag and the new tag.

```bash
mkdir -p release-notes
NOTES_FILE="release-notes/$TAG.md"
PREV_TAG=$(git describe --tags --abbrev=0 "$TAG^" 2>/dev/null || true)
if [ -n "$PREV_TAG" ]; then
  RANGE="$PREV_TAG..$TAG"
  DIFF_STAT=$(git diff --stat "$RANGE")
  CHANGED_FILES=$(git diff --name-only "$RANGE")
else
  # First release fallback when no prior tag exists.
  RANGE="$TAG"
  DIFF_STAT=$(git diff-tree --no-commit-id --stat -r "$TAG")
  CHANGED_FILES=$(git diff-tree --no-commit-id --name-only -r "$TAG")
fi

cat > "$NOTES_FILE" <<EOF
# $TAG

## Compare Range
- $RANGE

## Highlights
- Summarize user-visible changes based on the diff above.

## Diff Summary
$DIFF_STAT

## Changed Files
$(printf '%s\n' "$CHANGED_FILES" | sed 's/^/- /')

## Full Changes
$(git log --pretty=format:'- %s (%h)' "$RANGE")
EOF
```

## 3) Confirm version number and release notes (required)

Before any push or publish action, always show the resolved version number and release notes to the user, then wait for explicit confirmation.

```bash
echo "Version: $VERSION"
cat "$NOTES_FILE"
```

Do not continue until the user confirms both the version number and the release notes, and says to proceed.

## 4) Push commit and tag

```bash
git push origin HEAD --follow-tags
```

## 5) Publish GitHub release

```bash
gh release create "$TAG" --title "$TAG" --notes-file "$NOTES_FILE"
```

## 6) Publish to npmjs

```bash
npm publish
```

## 7) Publish to Clawhub

```bash
clawhub publish clawhub/skills/health-sync \
  --slug health-sync \
  --name health-sync \
  --version "$VERSION" \
  --changelog "$(cat "$NOTES_FILE")"
```

## 8) Post-release verification

```bash
npm view health-sync version
gh release view "$TAG"
```

Confirm the GitHub release, npm version, and Clawhub publish output all match `$TAG`.
