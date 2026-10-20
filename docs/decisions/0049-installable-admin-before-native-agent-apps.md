# 0049 An installable admin (PWA) before native agent apps, and no push relay

Status: proposed
Date: 2026-10-20

## Context

Agents ask for Helpdock as "an app" on their desktop and phone, with
notifications and an unread badge. The admin already registers a service worker
and sends web push with VAPID ([ADR 0002](0002-web-push-via-vapid.md)). Native
iOS and Android apps need push keys (APNs, FCM) that belong to the app's
publisher. For a self-hosted product that means either every operator builds
and publishes their own app, or the project runs a relay that every install
sends its notifications through: a hosted service, against the self-hosted
principle.

Planned in [M17 Apps and languages](../in-development/M17-apps-and-languages.md)
(M17-06 to M17-08).

## Decision

1. Helpdock becomes an **installable web app**: a manifest served per install, a
   service worker that caches the app shell only, the Badging API driven by the
   bell's unread count, notification clicks that open the ticket, a per-device
   push list, and install instructions per platform. It installs on Chrome and
   Edge (desktop and Android) and on Safari (macOS "Add to Dock", iOS home
   screen with push from 16.4).
2. **Mobile agent layouts** below 600 px make the installed app usable on a
   phone.
3. **No native iOS or Android agent app in 1.x**, and the project runs **no push
   relay**.
4. A desktop shell, if built, wraps the instance's own admin and is planned
   separately ([M20](../in-development/M20-native-clients-and-sdks.md),
   [ADR 0057](0057-desktop-shell-on-electron.md)).

## Consequences

- Most of what a native app would give an agent arrives for a fraction of the
  work, with no service for the project to host.
- API responses and attachments are never cached, so nothing is left on shared
  devices; caches and the push subscription are dropped on sign-out and on "log
  out everywhere".
- iOS web push depends on the home-screen install and has regional limits
  (noted in ADR 0002); email and in-app notifications remain the fallback.

## Alternatives considered

- **Native apps with a project-run push relay:** a hosted service every install
  would depend on.
- **Native apps that each operator publishes:** app-store accounts and push
  keys per operator; not realistic for most self-hosters.
- **A desktop shell first:** heavier, and covers fewer platforms than the PWA.
