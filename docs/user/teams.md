# Teams

Each teammate runs Puff Collab on their own computer, with their own agents,
provider sign-ins, and code. A team hub syncs what you choose to share between
those computers. Your Puff Collab server is yours alone: you can pair your own
phone and other devices with it as described in [Remote access](./remote-access.md),
but teammates work with you only through the hub. Private threads never leave
your computer.

## Link your computer

In **Settings → Connections → Team hub** (on mobile, **Settings → Team
hub**), enter your team's hub address and choose
**Link this computer**. The hub opens in your browser: sign in with GitHub and
enter the code Puff Collab shows. **Unlink** disconnects this computer;
teammates' threads disappear from it until you link again.

Teams that do not want to use a hosted hub can run their own on their network;
see [Self-hosting on a LAN](../../infra/hub/README.md#self-hosting-on-a-lan).

## Link a project or join a teammate's

Projects on the hub are matched by their git remote. Choose **Link to team
hub** from the thread menu, project settings, Team overview, or the command
palette (on mobile, from a thread's **Team** screen). If a teammate already
has the same repository on the hub, choose **Join** to work in their hub
project instead of starting your own. **Unlink** stops syncing that project.

## Invite people

In a linked project, open **People** (thread menu, Team overview, project
settings, or the command palette). Invite a teammate by their GitHub login;
they accept from their own Puff Collab, in the sidebar (on mobile, on Home),
once they have signed in to the hub. Pending invitations can be cancelled.

**People** also lists the project's members. The project's creator and other
admins can **Remove** a member, and anyone but the creator can **Leave**.
Leaving or being removed unlinks your local project from that hub project.

## Shared and private threads

New threads are private. In a linked project, choose **Shared with team**
under the composer, or change it later from the thread menu under **Sharing**.
A shared thread syncs to the hub, messages, activity, and diffs included, with
secrets redacted first. A small cloud icon shows whether it is synced, waiting,
or offline; changes made while offline sync when the hub is reachable again.
Making a thread private removes it from the hub.

## Following and comments

Teammates' shared threads appear under the project with their owner's name.
Their agent runs on the owner's computer, so you follow along and comment:
comments reach everyone following and are never sent to an agent. You can
delete your own comments. On a teammate's thread you can pin, snooze, or mark
it unread for yourself; its title, archive state, settling, Git, terminals,
files, and previews belong to its owner.

## Team overview

**Team overview** (thread menu or command palette; on mobile, a thread's
**Team** screen) shows a linked project as a team: a project brief anyone in
it can edit, what each person says they are focused on, a card for every
shared thread with its analysis summary, and recent activity. If someone saved
the brief while you were editing, your save is refused and your draft is kept.
For a project that is not on the hub, Team overview offers to link it.

## Related work

While you write the first message of a new thread in a linked project, Puff
Collab lists shared threads in it that look related, your own and your
teammates', so you can check for overlapping work. When you share a thread,
the related-threads button next to its title opens with any matches. Mark one
**Complementary** or **Alternative** to link it. Links on a shared thread
reach your teammates with it; a linked thread they cannot open shows as
unavailable, and links to private threads stay on your computer. Links are
never sent to an agent.

## Cooperation analysis

Cooperation analysis summarizes shared threads and tells their owners about
related findings in each other's work. It is off until you pick an
**Analysis model** under **Settings → Connections → Cooperation analysis**
(Claude, OpenCode, or Antigravity; it runs as text only, with no tools, on
your own provider sign-in).

On a shared thread you own, open **Cooperation** in the thread header, give it
a feature topic, and turn on analysis. Your thread is analyzed together with
other opted-in threads in the project that have the same topic, yours or a
teammate's. Message text is included only where each owner allowed it, and
secrets are redacted first. Each owner's computer analyzes its own threads, so
your summary appears on your thread's card for the whole team.

Findings for your threads appear under **For you**, including notes from your
teammates' analysis, which reach you through the hub. Admitting a note adds it
to your composer to edit before sending; approving a proposed message sends it
to your agent. Nothing reaches an agent without its owner's decision.

## On mobile

A thread's header has a **Team** button in a linked project. It holds the
thread's sharing, related threads, cooperation analysis, and notes waiting for
you, and leads to Team overview and People. On a teammate's thread the
composer becomes a comment box. Choosing the analysis model stays on web and
desktop.
