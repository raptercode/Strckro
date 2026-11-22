# ADR 0035: The owner can turn a project off and on

[ภาษาไทย](../../../th/knowledge/adr/0035-owner-can-turn-a-project-off-and-on.md)

- Status: Accepted
- Date: 2026-11-23

## Context

The only way to stop a deployed application was to delete it, which removes releases, ENV, storage and domains. Owners wanted to switch a project's service off for a while and later on again with nothing lost. The scope is the per-project service of applications and workers; mail, databases and host tools are out of scope.

## Decision

- **Off is persistent.** `stop-project` runs `systemctl disable --now hostmgr-project-<slug>.service`, so the unit is also off after a reboot. A Docker Compose project has no unit; it is brought down with `docker compose down --remove-orphans` (containers and networks only, never `-v` or `--rmi`), which stays down after a reboot whatever restart policy the file declares. A project that was never activated has nothing to stop and is left alone.
- **On means the active release.** `start-project` requires an active release whose directory is the one `current` points at, then enables and starts the unit (or runs `docker compose up --detach` without a rebuild) and applies the same process-stability and HTTP health checks as Restart. It returns `{ state: "active", releaseId }`; `stop-project` returns `{ state: "off" }`.
- **Typed, slug-only requests.** Both operations take only `slug`. The unit or Compose project name is derived from it by `projectIdentity`, as for Restart. Stop never removes files, ENV, storage, the service account, domains or Nginx configuration, and a test asserts the commands it runs.
- **Domains are left alone and answer 502.** No maintenance page: it would need Nginx changes and a second state to undo.
- **State.** The Portal stores `project.service = { enabled: false, stoppedAt }` after the helper confirms a stop, and `{ enabled: true, startedAt }` after a confirmed start; no field means on. The flag is written only after the host confirms, so a failed call keeps the previous state and the failed `runtimeOperation` is visible. Repeating either call is safe: it always asks the host again, so a half-done change converges.
- **Deploys are refused while off.** Manual deploy, rollback and Restart answer *Project is turned off*; automatic deploy records `blocked` with the same reason and builds no release; the helper refuses `activate-project` and `restart-project` as a second guard. The alternative, building and activating without starting, needs a "do not start" mode through the activation transaction and its rollback, and would leave an unverified release live behind a 502. Refusing is simpler and cannot start the service by accident. Delete is unchanged.
- **Status.** The Portal reports runtime state `off` without asking the host, and the helper reports `off` for a flagged project. The UI shows a neutral **Off** badge, an *Off* filter, and *off* for **Serving** on the pipeline track; it is not counted as *Needs attention*.
- **Access.** `POST /api/projects/<slug>/stop` (body `{"confirm": true}`) and `/start` use the session, CSRF token, `deploy.start` permission, in-progress guards and audit entries (`project.stop`, `project.start`) of Restart. They are not in the CLI token allow-list. Portal and helper operations run under the existing maintenance lease. In demo and sandbox mode the Portal simulates both without a helper.

## Consequences

- Turning a project off is reversible and keeps every release and every file.
- A reboot, a Portal update or the installer does not start an off project, because the unit stays disabled.
- Visitors see 502 while it is off. A hostile or mistaken deploy cannot start it.
- While a stop or start runs, other changes to that project are refused; a Portal restart in the middle marks the operation unconfirmed and leaves the flag as it was.
- Turning a Compose project on again recreates its containers from the active release; container-local state that is not in a named volume is lost, as with any `down`.

## Not verified

Nothing was run against real systemd or Docker. To check on a host: `systemctl is-enabled` and `is-active` after off and after a reboot; that `disable --now` on an already disabled unit succeeds; that `enable` plus `start` after `disable --now` restores the unit without `daemon-reload`; Nginx answering 502 and keeping its certificates; the 30-second health window for a slow application; and `docker compose down` then `up --detach` for a project with named volumes.
