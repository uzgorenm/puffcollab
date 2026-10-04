<img src="assets/prod/logo.svg" alt="Puff Collab puffin" width="80" />

# Puff Collab

Puff Collab is a desktop app for working on code with coding agents and sharing that work with teammates. Your app runs a local server, opens your project folders, and uses your own provider account. An optional hub connects separate computers so teammates can follow shared threads, comment, review diffs, and coordinate work.

Puff Collab is a fork of [T3 Code](https://github.com/pingdotgg/t3code). This repository contains the Puff Collab application and hub. The upstream app-store listings, installers, and `npx t3` package install the upstream product; use the source instructions below to run this fork.

## Start the desktop app

These instructions run the native application on your computer. You do not need a browser pairing token to use it.

### First-time setup

Install Git, Node.js **24.13.1 or a compatible Node 24 release**, and the [Vite+ `vp` tool](https://viteplus.dev/guide/). Then run:

```bash
git clone https://github.com/uzgorenm/puffcollab.git
cd puffcollab
vp i
vp run build:desktop
```

On macOS or Linux, launch it with a separate Puff Collab data folder:

```bash
T3CODE_HOME="$HOME/.puffcollab" vp run start:desktop
```

On Windows, use PowerShell:

```powershell
$env:T3CODE_HOME = "$HOME/.puffcollab"
vp run start:desktop
```

The native window opens and starts its local server automatically. Keep that terminal running while using the app. Quit the app and stop the launcher with Ctrl+C when finished. Your projects, threads, and settings persist in the data folder. The `T3CODE_HOME` name is retained for compatibility with the underlying server.

### Starting again on this Mac

For the checkout at `~/Desktop/Side Projects/puffcollab`, use:

```bash
cd "$HOME/Desktop/Side Projects/puffcollab"
T3CODE_HOME="$HOME/.puffcollab" ./node_modules/.bin/vp run start:desktop
```

You only need to install dependencies and build again when the source or dependencies change. To update, quit the running app, pull the latest code, then rebuild:

```bash
git pull --ff-only
vp i
vp run build:desktop
```

Launch it again with the same data folder. There is no packaged Puff Collab installer published by this repository yet.

## Connect a coding provider

Authenticate at least one provider on the computer running Puff Collab. A GitHub hub login does not sign you into a coding provider.

| Provider    | Local sign-in                                                                        |
| ----------- | ------------------------------------------------------------------------------------ |
| Codex       | Install Codex CLI, then run `codex login`.                                           |
| Claude Code | Install Claude Code, then run `claude auth login`.                                   |
| Cursor      | Install Cursor CLI, then run `agent login`.                                          |
| Grok Build  | Install Grok Build CLI, then run `grok login`.                                       |
| OpenCode    | Install OpenCode, then run `opencode auth login`.                                    |
| Antigravity | Enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. |

Open **Settings → Providers** to check availability, select models, or configure additional accounts. Provider subscriptions and API charges remain with your provider. An expired login must be renewed through that provider before the app can run its agents.

## Work on code

1. Add a project by selecting a **local folder**. Clone a Git repository first if you do not already have a checkout. Adding a project does not download its files from GitHub.
2. Create a thread in that project. Pick the provider and model, and choose the permission mode appropriate for the task. [Permission modes](docs/user/permission-modes.md) explains approval requirements and file access.
3. Send a task in the composer. The agent works in the project folder or the thread's selected worktree. Review requests for permissions before approving them.
4. Follow the conversation and work log. Inspect changed files and diffs, run the project's checks, and use the terminal when needed.
5. Review the result before committing. Use the app's source control tools or your usual Git commands to commit, push, and open a pull request.

A thread keeps its conversation and work history, so you can return to it later. Separate threads help keep tasks independent; worktrees provide separate checkouts when tasks should not edit the same files.

## Link your computer to a hub

Hub linking connects your local app to a team account. It is optional for solo coding. The current hosted hub is:

**https://puffcollab-hub.mehmetuzgoren.workers.dev**

1. In the desktop app, open **Settings → Connections** and enter the hub URL under **Team hub**.
2. Choose **Link this computer**. The app creates a short-lived code and opens the hub's link page. Keep the app running during this step.
3. Sign into GitHub on that page. If the code is not already filled in, enter the fresh code shown in your app, then continue and approve the link.
4. Return to Puff Collab and wait for the connection to show as linked. If the code expires, cancel the old attempt and start a new one in the app.

The hub uses GitHub to identify teammates. It does not need a coding-provider login, and it does not give the hub control of your local agent.

### Hub code versus browser pairing token

| Credential                                | Where it belongs                          | What it does                                           |
| ----------------------------------------- | ----------------------------------------- | ------------------------------------------------------ |
| Hub code, such as `ABCD-EFGH`             | The hub's `/link` page                    | Associates your local server with your GitHub account. |
| Browser pairing token or full pairing URL | A web client connecting to a local server | Lets that browser access an environment.               |

These credentials are separate. An eight-character hub code will fail on the **Pair with this environment** screen. The native desktop app connects to its own server without browser pairing.

## Share a project with teammates

Each teammate runs their own Puff Collab app, authenticates their own coding provider, and checks out the project locally.

1. Link your computer to the hub.
2. Open the project's menu and choose **Team hub**, then **Link to team hub**. Project settings also exposes this control. A new hub project is created if needed. Use matching Git remotes for checkouts of the same repository.
3. Invite the teammate's GitHub account to the hub project.
4. The teammate links their own computer to the same hub, accepts the invitation, and joins that hub project from their local checkout.
5. Share a thread when you want the team to see it. New threads start private; linking a project does not publish every conversation.

A shared thread shows its owner's messages, work history, and available diffs on other linked computers. Teammates can leave comments without taking over the agent. Comments are discussion, and are never automatically sent as provider instructions. The thread owner drives the coding session.

The hub synchronizes collaboration records. It does **not** copy repository files into other checkouts or merge code. Commit and push your changes, then have teammates pull or review the pull request. Remote diffs show the owner's patches; they do not represent uncommitted changes on the viewer's computer.

To stop sharing, change the thread's visibility back to private. You can also disconnect a project or unlink a computer through its hub controls. Access depends on project membership and the current link.

## Coordinate parallel work

The team overview helps you see shared work and identify overlap. Keep thread descriptions focused so teammates can tell which task each person owns. Related threads can be marked as complementary or alternative approaches.

Cooperation analysis is optional. Configure it in the collaboration settings, select an available supported provider, and give consent for the shared content that analysis will use. The current analysis path supports Claude, OpenCode, and Antigravity; the chosen provider must be installed and authenticated locally. Analysis requires a working local provider login and permission to process the selected shared content.

Review findings before acting on them. Applying a finding prepares a message for the relevant thread; sending it still requires the owner's action. Analysis does not silently redirect another teammate's agent.

## Other ways to run the app

For application development, `vp run dev:desktop --home-dir "$HOME/.puffcollab"` starts the desktop with a live development renderer. The compiled desktop launch above is the more reliable everyday path for this checkout.

The web client is optional. To develop it, quit the desktop app first and run:

```bash
vp run dev --home-dir "$HOME/.puffcollab"
```

Use the URL printed by the launcher. If it prints a pairing URL, open the full URL in the browser you want to connect; one-time tokens cannot be reused. Do not run two local servers against the same data folder simultaneously.

Mobile source is included, but the upstream App Store and Play Store apps are not Puff Collab releases. See [mobile development](docs/internals/mobile-development.md) for the repository's native build workflow.

## Troubleshooting

- **The terminal says `vp` is missing:** install Vite+, or use `./node_modules/.bin/vp` inside an already installed checkout.
- **The desktop window fails to load in development:** stop the development launcher, build with `vp run build:desktop`, then use `start:desktop`.
- **Hub says the code is unknown or expired:** start a fresh linking attempt in Settings → Connections. An old browser tab cannot renew a code.
- **The project is missing on another computer:** accept the invitation, join the hub project, and link the correct local checkout. Confirm both computers use the same hub.
- **A teammate cannot see a thread:** confirm project membership, the connection status, and that the thread is shared.
- **The agent cannot start:** check Settings → Providers and renew the provider's local login. GitHub sign-in alone is insufficient.
- **A remote diff cannot open a file:** the teammate may not have that file or commit locally yet. Push and pull the code through Git.
- **The hub is offline:** local coding still works. Shared updates resume when the connection recovers.

## Further reading

The [documentation index](docs/README.md) covers the full set of user guides.

- [Project settings](docs/user/project-settings.md)
- [Keyboard shortcuts](docs/user/keybindings.md)
- [Permission modes](docs/user/permission-modes.md)
- [Source control](docs/user/source-control.md)
- [Remote access](docs/user/remote-access.md)
- Multiple provider accounts: [Codex](docs/user/providers-codex.md) · [Claude](docs/user/providers-claude.md)
- [Hub operations and deployment](infra/hub/README.md)
- [Architecture](docs/internals/overview.md) and [contributing](CONTRIBUTING.md)

Track Puff Collab work in this repository's [issues](https://github.com/uzgorenm/puffcollab/issues). The original T3 Code contributors retain their attribution and license notices; see [LICENSE](LICENSE).
