# Remote access

Connect a phone, browser, or another desktop app to T3 Code running on a different
machine. That machine must stay running and reachable while you work.

## T3 Connect

T3 Connect makes an environment available to your other devices without setting
up router forwarding. In the desktop app on the host, open **Settings →
Connections**, sign in, and enable **T3 Connect** for that environment.

For a command-line host, run:

```bash
t3 connect
```

Follow the sign-in instructions. Setup offers a
[background service](./background-service.md); if you decline it, start the
server with `t3 serve`. Saving your sign-in alone does not make the machine
reachable.

On your other device, sign in to the same T3 Connect account and choose the
environment. Over SSH, the CLI prints a browser link and a short code. Open the
link on any device, confirm the code matches, and approve. The CLI continues on
its own, so you do not need to forward an OAuth callback port.

T3 Connect renews access credentials when needed without disconnecting a healthy
connection. Pull request diffs and provider settings keep working after the
previous credential expires. A failed renewal affects that request; it does not
disconnect an otherwise healthy conversation.

## Pair over a LAN or private network

Use direct pairing when the other device can reach the host's network address.

On a desktop host, open **Settings → Connections**, enable **Network access**,
then create a pairing link using an address the other device can reach. Changing
network access restarts the desktop app. You can turn it off in the same place.

For a command-line host, replace `<private-ip>` with the host's LAN or tailnet
address:

```bash
t3 serve --host <private-ip>
```

If a server is already running, generate a fresh link without restarting it:

```bash
t3 pair
```

Scan the QR code on your phone or paste the pairing URL into **Add environment**
in the receiving app. Connection settings are under **Settings → Connections**
on web and desktop and **Settings → Environments** on mobile. A loopback address
such as `127.0.0.1` reaches only the device opening the link.

Pairing authorizes that device for future connections. Use a fresh one-time link
for each new device; you do not need the original token to reconnect. Links
created in Settings can only be copied from the client that created them while
its Connections page stays open. If you leave or reload that page, create
another link to share.

### Balance new threads across machines

Auto balance is off by default. On web and desktop, enable it in
**Settings → Connections → Load balancing** to automatically choose a machine for
new threads in projects grouped across connected environments. The section
appears once two or more machines are switched on.
Each machine starts at **Normal**. Choose **Prefer** to favor it when it has CPU and
memory available, **Less often** to reduce its share, or **Manual only** to exclude
it from automatic selection. These are preferences, not fixed traffic percentages.
Preferences are saved separately in each client.

The composer checks eligible machines when choosing a draft's environment, then keeps
that choice stable. Choose **Auto balance** again to check current resources, or choose
a specific machine to override it. Choosing a branch or worktree also keeps the draft
on that machine. Existing threads stay where they started. If resource checks are
unavailable or all eligible machines are full, choose a machine manually to continue.
Mobile keeps its manual environment selection.

### Tailscale HTTPS

Join both devices to the same tailnet. In the desktop app, enable **Tailscale
HTTPS** in **Settings → Connections**. Turn it off there to remove that route.

To start a command-line server with Tailscale HTTPS:

```bash
t3 serve --tailscale-serve
```

For an already-running server:

```bash
t3 pair --tailscale
```

The pairing link uses an address such as `https://machine.tailnet.ts.net/`.
The mapping created by `pair --tailscale` persists across restarts. Remove its
default-port mapping with:

```bash
tailscale serve --https=443 off
```

If that port is already in use, choose another with
`--tailscale-serve-port`. See `t3 pair --help` for other pairing options.

### Hosted web app

[app.t3.codes](https://app.t3.codes) needs an HTTPS endpoint. It connects directly
to your server; a hosted pairing link does not make an unreachable backend
reachable or convert HTTP to HTTPS.

For a plain HTTP LAN endpoint, use the direct pairing URL in a browser that can
open it, or pair from the desktop app. On mobile, an IP address entered without a
scheme uses HTTP, so include `https://` when your server uses HTTPS.

## Desktop-managed SSH

In the desktop app, open **Settings → Connections → Add environment**, choose
**SSH**, and enter a host or SSH alias such as `user@example.com`. T3 Code starts
or reuses a server there and opens the port forward for you. Projects, provider
credentials, and agent work stay on the remote machine.

The remote host must be Linux or an Apple Silicon Mac with `curl` or `wget`,
`tar`, `sha256sum` or `shasum`, and [provider setup](./install.md#providers).
The first launch downloads T3 Code's server to `~/.t3/runtime` on the host, so
it takes longer than later ones.
Provider CLIs must be on the `PATH` of a non-interactive login shell there;
check with:

```bash
ssh user@example.com 'sh -lc "command -v claude codex"'
```

If SSH reconnecting fails after an app update, retry the launch once. Removing
the connection stops a server that T3 Code launched; a server that was already
running is left alone.

For Antigravity's Google callback on a remote host, see
[remote sign-in](./providers-antigravity.md#sign-in-from-a-remote-device).

## Manage or revoke access

On the host, **Settings → Connections** lets authorized administrators create
pairing links and revoke client sessions. Revoking an unused link prevents new
pairings; revoke a device's session to remove its existing access. Command-line
management is available through `t3 auth --help`.

A session with an open connection stays listed after its access credential
expires.

To remove an environment from T3 Connect, open your account menu's **T3 Connect**
page, or **Settings → T3 Connect** on mobile, and choose **Deregister**. This
revokes its cloud access and frees its host space even when the environment is
offline or has been wiped. Removing an environment from a device's connection
settings only forgets it on that device; it stays registered to your account.

When idle tunnel cleanup is enabled, T3 Connect removes a linked environment's
tunnel after it stays offline for several minutes. The environment stays linked
and keeps the same address. When the host starts again or wakes, T3 Connect
creates a replacement tunnel on its own. You do not need to pair again. Cleanup
usually runs five to ten minutes after the tunnel goes down.

On a command-line host, `t3 connect unlink` disables exposure while retaining
your login; `t3 connect logout` also clears that login. Background-service
[removal](./background-service.md#manage-the-service) is separate.

Treat pairing URLs and authorization codes as passwords. Do not include them in
screenshots, logs, or bug reports.

## T3 Connect troubleshooting

Run `t3 connect status` on the host to inspect saved authorization and link
configuration. It is not a live reachability check. If the environment appears
offline, run `t3 service status` and read the displayed log. If it disappears
when SSH closes, see [background-service troubleshooting](./background-service.md#troubleshooting).

| Error                                                     | Recovery                                                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment_link_limit_exceeded` or managed tunnel limit | Deregister an unused environment, then restart T3 Code on the host.                                                                         |
| `auth_invalid` or `invalid_bearer`                        | Run `t3 connect login`. If credentials were revoked, run `t3 connect logout`, then `t3 connect` again. Restart the server after signing in. |
| Expired or invalid link proof                             | Check the host's date and time, update T3 Code, then restart it.                                                                            |
| HTTP 403 without a recognized error                       | Check relay access, proxies, and firewall rules. Keep any Cloudflare Ray ID for a bug report.                                               |
| HTTP 408, 429, or 5xx                                     | Check network and relay availability. Startup retries temporary failures for up to ten minutes.                                             |

After fixing a permanent rejection, restart the host's server. On Linux, use
`systemctl --user restart t3code.service` for the background service. For a
foreground server, stop it and run `t3 serve` again with your usual options.
Include the diagnostic message and trace ID when reporting a persistent failure.

For a connection that still fails after linking, check the date and time on both
devices. For server version warnings, follow [Updating T3 Code](./updating.md).

## Teams

Several people can share one environment, each signing in as themselves.

### Members

An admin opens **Settings → Connections → Team members**, adds a member, and
sends them the one-time **Sign-in link** (it expires after 24 hours). The
environment owner is always an admin.

The link works like a device pairing link, so the host must be reachable from
the teammate's machine or phone first: turn on **Network access** or
**Tailscale HTTPS** as described above, or use T3 Connect. The link uses the
address you chose for pairing links; an HTTPS address (Tailscale or T3 Connect)
opens in the [hosted web app](https://app.t3.codes) with no install. When the
environment is linked to T3 Connect, **Copy T3 Connect link** gives a link that
works from anywhere. The teammate opens the link in a browser, or pastes it
into **Add environment** in the desktop or mobile app (on mobile, scan or paste
it under **Settings → Environments**). If only a code is shown, they enter the
host's address and that code there instead. Each link signs in one device; send
a new one for each phone or computer. Teammates do not sign in to T3 Connect
themselves; that account stays the owner's.
Adding and removing members stays on web and desktop; mobile lists them in
Team overview.

Members see only the projects they created or joined. Any member can add a
folder on the host as a project, and anyone in a project can invite people to
it with **Invite people** (in the thread menu, Team overview, project settings,
or the command palette; on mobile, from Team overview or a thread's **Team**
screen). An invitation waits until the invitee accepts it from the banner in
the sidebar (on mobile, at the top of Home); they can also decline. You can
invite a teammate, or someone new by name: they get a member account and a
one-time sign-in link to send them, and the account goes away if the link is
cancelled or expires unused. Anyone in the project can cancel a pending
invitation, and each person can have at most 20 waiting. Leave a project from
the same **People** view; its creator and admins can remove members. Admins
see every project, invite members from **Projects** on their row in Team
members, and can see who invited whom. Files, Git actions,
previews, and pull requests follow the same rule: a member works in the
checkouts of their projects and can look at, but not change, a teammate's
shared worktree. Only admins open files or run Git outside the team's
projects, and only admins change host-wide settings: provider sign-ins and
installs, environment settings, keybindings, and server updates. Members use the
providers and models an admin has set up. These rules organize the team; they are not a sandbox. Every agent
runs as the host's user account, so only invite people you would trust with
that account. Messages written by someone else show their name above the
message.

**Sign out** ends a member's sessions and unused links; **Remove** also stops
them from signing in again. Their past messages keep their name.

### Shared threads

Threads are private to the member who started them (and admins) unless shared.
Choose **Shared with project** under the composer when starting a thread, or
change it later from the thread menu under **Sharing**. Project members then
see the thread in their sidebar with your name and can follow it live.

Only a thread's owner can instruct the agent, answer its approvals and
questions, interrupt, rewind, link related threads, or otherwise change the
thread. Teammates comment instead; comments appear in the timeline for everyone
following and are never sent to the agent. Admins can also stop, archive, or
delete any thread, and only admins can delete a project.

### Related work

While you write the first message of a new thread, T3 Code lists teammates'
shared threads in the same project that look related, so you can check for
overlapping work before starting. When you share an existing thread, the
related-threads button next to its title opens with any matches. Mark one
**Complementary** or **Alternative** to link it. Anyone who can see your
thread sees its links, and a linked thread they cannot open shows as
unavailable. Links are never sent to the agent.

### Team overview

Open **Team overview** from a thread's menu or the command palette to see one
project as a team: a shared project brief anyone in the project can edit (with
history), what each member says they are focused on, a card for every shared
thread and your own, and recent team activity.

### Cooperation analysis

Cooperation analysis summarizes shared threads and tells their owners about
related findings in each other's work. It is off until you pick an
**Analysis model** under **Settings → Connections → Cooperation analysis**
(Claude, OpenCode, or Antigravity; it runs as text only, with no tools).

On a shared thread you own, open **Cooperation** in the thread header, give the
thread a feature topic, and turn on analysis. Two opted-in threads in the same
project with the same topic are analyzed together; the result is shown in the
same panel and on the thread's team overview card. Message text is only
included if you also allow it, and secrets are redacted first. Links between
the two threads tell the analyst whether they are complementary or deliberate
alternatives.

Findings for your thread appear under **For you**. Admitting a note adds it to
your composer, where you can edit it before sending; approving a proposed
message sends it to your agent. Nothing reaches an agent without its owner's
decision.

### On mobile

In a team environment, a thread's header has a **Team** button. It holds the
thread's sharing, related threads, cooperation analysis, and notes waiting for
you, and leads to the project's team overview. The toggle above the new-thread
composer chooses **Private** or **Shared with project**. On a teammate's thread
the composer becomes a comment box. Choosing the analysis model stays on web
and desktop.

## Using the Desktop App as a Remote Only

If a computer should only drive work running elsewhere, turn off its local environment. In the
desktop app, open **Settings → Connections** and switch off **Local
environment**. T3 Code restarts without a local server: no local agents or terminals run, WSL
backends stay off, and other devices can no longer connect to this computer. Your projects,
history, and saved connections are kept, and you keep working through pairing, T3 Connect, or SSH.

Switch **Local environment** back on in the same place to restart with your previous local
settings.
