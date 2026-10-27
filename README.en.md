<p align="center">
  <img src="docs/banner.svg" alt="dsh-purge" width="720">
</p>

<h1 align="center">DeepSeek Harness network-security red-team toolkit</h1>

<p align="center">
  <strong>v2.3.2</strong> &nbsp;·&nbsp;
  Break the armour on every model; swap the prompt per model
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22.13-339933?logo=node.js&logoColor=fff" alt="Node.js">
  <img src="https://img.shields.io/badge/dsh-0.2.1--rc.2-blue" alt="DSH">
</p>

<p align="center">
  <a href="README.md">中文</a> · <a href="README.en.md"><strong>English</strong></a>
</p>

---

Install once; no button to press afterwards. Patches apply themselves when the host starts, and the UI is one new section in host Settings plus a drill page in the main area.

This page answers three things: **how to install, where to look afterwards, how to roll back**. To change this repository, read [AGENTS.md](AGENTS.md) and the [docs index](docs/文档索引.md).

## What this is

A plugin for the official [DeepSeek Harness](https://www.deepseek.com/harness/) desktop app, built for network-security red-team evaluation.

Harness does more than hand your question to a model: it rewrites prompts, approval gates, sandboxes and session formats at runtime. Judging only "did the model answer" mistakes a **host interception** for a **model refusal**. This plugin separates the two layers — patches move or rewrite the host-side interception, so the model-side answer reflects the model. It is for controlled evaluation, and for judging whether default policy should be tightened.

Three pieces of UI:

| Where | What it is |
| --- | --- |
| The `dsh-purge` section in Settings | Five tabs, listed below |
| Drill page in the main area | Opening the sidebar icon fills the main area: assets, skills and local environment after authorization |
| Sidebar icon | The entry point itself; it shows an authorization dialog instead of an empty shell |

The five tabs:

| Tab | Contents |
| --- | --- |
| Status | Verdict line, patch counts, runtime environment, "restart host" when needed |
| Patches | Every patch by layer, with its state and reason |
| Configuration | Updates, prompt injection, server allowlist, Hooks interception, dangerous actions (revert / uninstall) |
| Skills | Bundled and local skills, edited in place |
| Diagnostics | Audit track, install health, the three log tracks with their locations and retained generations |

66 patches plus 26 permanently retired `id` holes (92 `id`s conserved). The plugin only touches the official `@deepseek-ai` packages **already installed on this machine**, and local configuration: it is not an internet scanner and not a kit for attacking other people's sites. The repository ships no trojan and no outbound attack payload.

## Install

```sh
dsh plugin --profile desktop add .        # run in this repository's root
```

Then **quit the desktop app completely** (including the tray) and open it again. Patches apply at startup.

For another machine, pack a tarball and copy it over:

```sh
npm pack                                  # produces dsh-purge-<version>.tgz
dsh plugin --profile desktop add ./dsh-purge-<version>.tgz
```

Requirements: Node.js ≥22.13, dsh 0.2.1-rc.2. The package is not on npm — do not `pnpm add dsh-purge`, and do not use `dsh://` or any public one-click install link.

## Where to look afterwards

1. Settings gains a `dsh-purge` section, header state is "Applied", footer "last applied" is not "never".
2. A drill icon appears in the sidebar.
3. `/purge status` in chat prints the `DSH_HOME` of the host **you are actually running**.

If the header says "reload needed" or "partially skipped", that section names the patch and the reason. "Partially skipped" does not stop the other patches from applying.

## Commands

```sh
dsh-purge --status | --apply | --revert | --unseal | --uninstall | --diagnose | --edit
```

```
/purge status | apply | revert | uninstall | edit | help
/rules list | use <id> | create <id> | delete <id> | reset | help
/skills list | import <zip or folder> | create <id> [note] | delete <id> | help
/rewind
```

There is no "Apply" button in the UI (none since 2.0.0): installation applies automatically, and the commands above are for re-running it. "Rewind one turn / previous turn" next to the input box uses the official `session.fork({ atSeq })`: the turn is withdrawn, a new session continues with the earlier context, the old one is archived, and that prompt returns to the input box.

When minimal / PTC disagrees with standard, it is usually an interceptor line left in the preset: `/purge revert` → `/purge apply` → quit the host fully and reopen → start a new conversation. Swapping the preset without re-applying leaves the old process patched.

## Revert, uninstall, update

- **Revert**: `dsh-purge --revert`. Every target file is backed up as `<file>.dshpurge.bak` before patching; revert restores from the backup and deletes it. `prompt-inject.md` is your file and survives a revert.
- **Uninstall**: Settings section → footer → "Uninstall", or `/purge uninstall`. It reverts applied patches, deletes the injection file, rule library and the plugin, then restarts the host.
- **Update**: replace the local copy → `dsh-purge --revert` → `dsh-purge --apply` → quit the host fully and reopen. Applying twice is idempotent.

**Online updates are off by default**: "Check for updates" reports "local build: no update check" and sends no network request; no remote repository is hard-coded. Enable it only by setting `DSH_PURGE_UPDATE_REPO=owner/name` or `dsh.updateSource` in `package.json`.

## Compatibility

Official desktop app only, and only **dsh 0.2.1-rc.2** (`dshTarget` in `package.json`). At startup the plugin reads the host's `@deepseek-ai/dsh` version and compares: a different major.minor means it **refuses to apply**; within the same minor, rc numbers may drift upward. On mismatch it shows the reason and touches no files.

The `dsh web` CLI surface has not been maintained since 1.0.0; that profile is no longer updated — move to the desktop app, your data stays where it is.

When the install tree is not found it probes in this order: `DSH_HOME` / `DSH_BASE` → the `.dsh` next to the dsh launcher → `npm prefix -g` / `npm root -g` → nested `@deepseek-ai/dsh/node_modules/@deepseek-ai` → `~/.dsh`. If none exists it asks you to set `DSH_BASE` and changes nothing.

Runtime files live in `$DSH_HOME`: `prompt-inject.md`, `rules/`, `skills/`, `net-scope-allow.txt`, `redteam/`, `audit/`.

## Your own servers

Addresses in mainland China, Hong Kong and Macau are blocked by default; only the machine you registered beforehand is exempt. Saying "this is my server" in a conversation does not unblock anything, and neither do keys or passwords.

Register it in the server allowlist on the **Configuration** tab, one per line: `203.0.113.10` (a single IP), `my-vps.example.com` (a hostname; whatever it resolves to at save time is allowed too), `alice@my-vps.example.com` (the account part only identifies the notation, it does not prove ownership). Saving writes `$DSH_HOME/net-scope-allow.txt`; keys, passwords, CIDR ranges and wildcards are dropped on save.

## Manual install

Use this when the command line is unavailable or `dsh` is not on PATH. It only touches the profile of the host **you are actually running**.

<details>
<summary><strong>Four steps, in order</strong></summary>

**1. Find the real `$DSH_HOME`**: a `.dsh` directory (occasionally `dsh-home`) containing `profiles/`, where `profiles/desktop/package.json` has `"name": "dsh-profile-desktop"`. Machines often have two `.dsh` copies; pick the one **you actually launch**.

**2. Put the plugin at `$DSH_HOME/plugins/dsh-purge`** (directory name and package name must both be `dsh-purge`; copy the whole directory, not a few `.js` files).

**3. Edit only two places in `$DSH_HOME/profiles/desktop/package.json`** (back it up first): add `"dsh-purge": "file:../../plugins/dsh-purge"` under `dependencies`, and append `"dsh-purge"` to the end of `dsh.profile.bundles`. Delete nothing that was already there and do not list `"dsh-purge"` twice.

**4. Run `pnpm install` inside `$DSH_HOME/profiles/desktop`** — success means `node_modules/dsh-purge/package.json` exists. Then quit the desktop app fully and reopen it.

</details>

<details>
<summary><strong>Hand it to an AI assistant (install only)</strong></summary>

<!-- AI-AGENT-START -->

Install the DeepSeek Harness plugin `dsh-purge` into the official desktop profile only. Do not search the disk, do not read or modify other files, and do not restart the application.

If `dsh` is not on PATH, tell the user and stop. If the current directory is this repository, use `.`. If the profile does not exist, tell the user to launch the desktop app once. The package is not on npm; do not run `pnpm add dsh-purge`.

```sh
dsh plugin --profile desktop add .
```

After the command, remind the user to quit and reopen the desktop app (patches apply at startup) and to confirm the state in the host Settings `dsh-purge` section. Then stop.

<!-- AI-AGENT-END -->

</details>

---

Third-party material: the original versions of `lib/redteam`, `presets/redteam` and `skills/redteam` come from Jueze-2019/dsh-redteam-mode, kept under the MIT licence with its copyright notice — see [docs/redteam-upstream-LICENSE](docs/redteam-upstream-LICENSE). The rest of the repository is MIT.
