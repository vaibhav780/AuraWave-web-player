# How to publish this to GitHub (private repo, a different account)

Follow these on the machine where you'll push. You only need **git**; the GitHub
CLI (`gh`) is optional but makes it easiest. Commands are shown for Windows
(PowerShell or Git Bash); they're the same on macOS/Linux.

> This repo is meant to be **private**. Steps below create a private repo.

---

## 0. Prerequisites

- Install **Git**: https://git-scm.com/downloads  → check with `git --version`
- (Recommended) Install the **GitHub CLI**: https://cli.github.com/  → `gh --version`
- Have the **target GitHub account** ready (the "other" account).

---

## 1. Extract and open a terminal in the folder

Extract the zip, then `cd` into the extracted `AuraWave` folder (the one that
contains this `PUBLISH.md`):

```bash
cd path/to/AuraWave
```

---

## 2. Set the git identity for THIS repo (so it commits as the other account)

Use `--local` so it only affects this repo and doesn't touch your global git setup:

```bash
git init
git config --local user.name  "Your Name"
git config --local user.email "other-account-email@example.com"
```

> Tip: use the email tied to the **other** GitHub account (or its GitHub
> `noreply` email) so commits are attributed correctly.

---

## 3. First commit

```bash
git add .
git commit -m "Initial commit: AuraWave web player + desktop server"
git branch -M main
```

The `.gitignore` already excludes virtualenvs, `library.db`, caches and any media
files, so nothing private ships.

---

## 4. Create the repo and push — pick ONE option

### Option A — GitHub CLI (easiest)

```bash
# Log in to the OTHER account (opens a browser; choose HTTPS, authenticate):
gh auth login

# Create a PRIVATE repo from this folder and push in one step:
gh repo create AuraWave --private --source=. --remote=origin --push
```

Done. The CLI handles credentials cleanly even if another account is already
logged in elsewhere.

### Option B — Web + Personal Access Token (no installs beyond git)

1. Log into **github.com with the other account** → **New repository**:
   - Name: `AuraWave`, Visibility: **Private**
   - **Do NOT** add a README/.gitignore/license (this repo already has them).
2. Create a token: GitHub → *Settings → Developer settings → Personal access
   tokens → Fine-grained tokens* → grant **Contents: Read and write** on the repo.
   Copy the token.
3. Add the remote and push (replace `OTHER_USERNAME`):

```bash
git remote add origin https://github.com/OTHER_USERNAME/AuraWave.git
git push -u origin main
```

When prompted:
- **Username:** `OTHER_USERNAME`
- **Password:** paste the **token** (not your account password)

> If the machine has another GitHub account cached and it keeps using it, force a
> prompt for this repo only:
> ```bash
> git config --local credential.helper ""
> git push -u origin main
> ```

### Option C — SSH key (good for frequent pushes)

```bash
# Generate a dedicated key for the other account:
ssh-keygen -t ed25519 -C "other-account-email@example.com" -f ~/.ssh/aurawave_key
# Add the PUBLIC key (~/.ssh/aurawave_key.pub) under the other account:
#   GitHub → Settings → SSH and GPG keys → New SSH key
# Create the PRIVATE repo on github.com first (as in Option B, step 1), then:
git remote add origin git@github.com:OTHER_USERNAME/AuraWave.git
GIT_SSH_COMMAND="ssh -i ~/.ssh/aurawave_key -o IdentitiesOnly=yes" git push -u origin main
```

---

## 5. Verify

Open `https://github.com/OTHER_USERNAME/AuraWave` — you should see both
`web-player/` and `desktop-server/` and the README rendered on the landing page.

---

## Pushing updates later

```bash
git add .
git commit -m "Describe your change"
git push
```

## Troubleshooting

- **"Permission denied" / pushes to the wrong account:** the machine cached a
  different account. Remove the saved credential (Windows: *Credential Manager →
  Windows Credentials → github.com*) and push again, or use Option A (`gh`).
- **Large/unwanted files showed up:** check `git status` before committing; the
  `.gitignore` here already covers `.venv/`, `library.db`, `art_cache/`,
  `lyrics_cache/`, `__pycache__/` and media files.
- **Want a license:** add a `LICENSE` file (e.g. MIT) before pushing.
