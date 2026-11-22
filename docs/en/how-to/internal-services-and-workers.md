# Domainless web services and internal workers

[ภาษาไทย](../../th/how-to/internal-services-and-workers.md) · [Index](../README-index.md)

Choose the service purpose on the first **Create project** step, then configure the repository and runtime.

| Purpose | Port | Domain | Deployment readiness |
| --- | --- | --- | --- |
| Web / API | Explicit or automatically selected free port | Optional; can be added later | Configured HTTP candidate health followed by service activation |
| Worker / background process | No Portal-assigned or reserved port | None | Build/source preflight, then process stability after host activation |

## Web without a domain

Create a Web project and leave domains empty. Deployment does not request a certificate or create a project Nginx route. Removing the last domain removes an existing managed route through the Nginx validation/reload transaction while the service continues on its application port.

Access through IP:port depends on the application's bind address and host firewall. Omitting a domain does not automatically expose a public port. A loopback-bound application needs a local consumer or a separately configured access path. Adding a domain later uses the normal Nginx/TLS flow.

## Workers without ports

Workers support **Node.js, Bun, Go and Python scripts** for continuously running processes such as queue consumers. Portal does not inject PORT/HOST or `Environment=PORT` into a worker unit. Explicit application ENV is preserved, including PORT/HOST if required by the application, but Portal does not manage worker domains or HTTP health.

Node/Bun use a named start script, for example:

```json
{ "scripts": { "start": "node worker.mjs" } }
```

Go starts the compiled binary. Python requires script mode and an entry file inside the source. Workers can have no user ENV; Portal still creates a restricted empty environment file.

PHP, Docker Compose and Python ASGI/WSGI workers are unsupported in this round. This is not a cron/one-shot scheduler; a process that finishes and exits does not pass long-running worker readiness.

## Lifecycle and rollback

1. Install dependencies/build and validate source without executing the candidate start process. The old consumer and candidate are not started together. Build/install scripts remain trusted repository code.
2. The helper snapshots the previous unit, environment, release link and service state, then stops the old worker before changing live files.
3. Start the new process and require the same running PID with no crash/restart over five seconds. Exit or restart during this window fails activation.
4. Failed activation must stop the new process before restoring the previous release and verifying its process. Failure to stop or restore is reported as recovery failure requiring host inspection.

Worker cutover includes a short interruption. Applications should handle SIGTERM and their in-flight jobs. Process stability does not prove queue connectivity or successful business jobs; rollback cannot undo job side effects. Inspect runtime logs and the application's queue system.

Web/Worker purpose cannot change after any release exists, including failed releases; worker runtime is also locked. Create a separate project to change those fields. Rollback uses the release's start script and typed Python settings.

Organization grants, independent ENV read/write permissions, deployment queues, audit and maintenance exclusion retain their existing contracts. Local/Docker checks and unit rendering do not replace actual systemd/helper/reboot acceptance; see the [acceptance record](../knowledge/plans/v1-acceptance-record.md) before go live.

## Turn an application off and on

Open the application, **Deploy** tab, and use **Turn off**. The Portal asks you to confirm, then runs `systemctl disable --now` on the project's own unit (a Docker Compose project is brought down with `docker compose down`, without removing volumes or images). The control works for web services and workers and needs the same permission as Restart.

- **Off stays off.** The unit is disabled, so the application does not come back after a reboot. Releases, ENV, persistent storage, the service account and Nginx configuration are not touched.
- **Domains answer 502.** Domains stay configured and Nginx keeps serving them; with nothing listening behind it Nginx returns 502. There is no maintenance page.
- **Status.** The application shows an **Off** badge (neutral, not *Needs attention*) in the list, the overview and the pipeline track, where **Serving** reads *off*.
- **Deploys are refused while off.** Create release, rollback and Restart answer *Project is turned off* and change nothing; automatic deploy records *blocked* as its last result and builds no release. Turn the application on first. Deleting the application still works.
- **Turn on** enables and starts the currently active release and runs the same process and HTTP health checks as Restart. If the check fails the application stays marked off and the error asks you to read the project logs.

API: `POST /api/projects/<slug>/stop` (body `{"confirm": true}`) and `POST /api/projects/<slug>/start` use the session, CSRF token and *deploy.start* permission of Restart; `skctl` tokens cannot call them. A project needs an active release before it can be turned off or on. In demo mode both calls are simulated. See [ADR 0035](../knowledge/adr/0035-owner-can-turn-a-project-off-and-on.md).
