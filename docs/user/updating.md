# Updating Puff Collab

The app you use and the server running your agents can be on different machines.
When a server is behind your web or desktop app, an update notice appears in the
conversation and **Settings → Connections**. Update the machine named in that
notice.

## Before you update

Server updates restart the connection and can interrupt active agents and
terminal commands. Saved threads, settings, and project files remain.

**Settings → General → Continue threads after restarts** is off by default.
Enable it to resume supported active threads after an update, crash, or machine
restart. Changes are saved to connected environments that support this setting;
update older servers first. If a supported environment was offline or has a
different value, use **Apply to all** in Settings after it connects.
Puff Collab must start again on that machine;
the setting does not enable automatic startup. Terminal commands may still be
interrupted, and threads without saved provider resume state need a new message.
If you previously enabled continuation for updates, enable this setting once
to allow recovery without a connected client.

## Update this source checkout

Puff Collab has no published installer releases yet. Quit the app, open a terminal in this repository, and run:

```sh
git pull --ff-only
vp i
vp run build:desktop
T3CODE_HOME="$HOME/.puffcollab" vp run start:desktop
```

Keep the same data folder when restarting. Do not use `npx t3@latest` to update this fork; it installs the upstream product. Release download settings in this fork point at the Puff Collab repository for future packaged releases.

## Update providers

**Settings → Providers** shows provider updates for the selected environment.
**Update all** updates every outdated provider on every connected environment
at once. Hover it to see which providers it will update. Providers that only
offer a manual update command are not included.

## Mobile builds

Mobile source is included, but upstream App Store and Google Play releases do not contain Puff Collab's fork changes. Update and rebuild the native client from this repository. See [mobile development](../internals/mobile-development.md).
