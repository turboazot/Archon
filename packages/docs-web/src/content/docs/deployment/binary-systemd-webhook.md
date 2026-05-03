---
title: Binary systemd and ngrok webhooks
description: Run the Archon binary with systemd and expose only webhook endpoints through ngrok.
category: deployment
area: infra
audience: [operator]
status: current
sidebar:
  order: 4
---

This guide covers a production-like setup without Docker:

- `archon.service` runs the compiled Archon binary as a user-level systemd service.
- `archon-webhook.service` runs ngrok as a companion tunnel.
- `archon-tailscale.service` optionally exposes Archon inside the private tailnet.
- `archon-orchestrator.service` optionally runs the backlog orchestrator loop.
- An ngrok Traffic Policy exposes only the GitHub webhook endpoint, not the Web UI or API.

## Prerequisites

- A compiled Archon binary, for example `dist/binaries/archon-linux-x64`.
- `ngrok` installed and authenticated with `ngrok config add-authtoken ...`.
- Archon environment variables in an Archon-owned env file:
  - User scope: `~/.archon/.env`
  - Repo scope: `<repo>/.archon/.env`

For binary builds, configure assistant binaries explicitly when needed:

```bash
CLAUDE_USE_GLOBAL_AUTH=true
CLAUDE_BIN_PATH=/home/ubuntu/.local/bin/claude
CODEX_ID_TOKEN=...
CODEX_ACCESS_TOKEN=...
CODEX_REFRESH_TOKEN=...
CODEX_ACCOUNT_ID=...
GH_TOKEN=...
GITHUB_TOKEN=...
WEBHOOK_SECRET=...
```

## Archon server service

Create `~/.config/systemd/user/archon.service`:

```ini
[Unit]
Description=Archon binary server
Documentation=https://archon.diy/
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/ubuntu/projects/misc/Archon
Environment=HOME=/home/ubuntu
Environment=ARCHON_HOME=/home/ubuntu/.archon
Environment=PORT=3090
EnvironmentFile=-/home/ubuntu/.archon/.env
EnvironmentFile=-/home/ubuntu/projects/misc/Archon/.archon/.env
ExecStart=/home/ubuntu/projects/misc/Archon/dist/binaries/archon-linux-x64 serve --port 3090
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=default.target
```

Then enable and start it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now archon.service
systemctl --user status archon.service
```

Verify locally:

```bash
curl http://127.0.0.1:3090/api/health
```

Enable linger so the user service can survive logout and start on boot:

```bash
loginctl enable-linger "$USER"
loginctl show-user "$USER" -p Linger
```

## ngrok webhook tunnel

Do not expose the whole Archon server unless you intentionally want the Web UI and API public.
Use an ngrok Traffic Policy to allow only GitHub webhook requests.

Create `~/.config/ngrok/archon-webhook-policy.yml`:

```yaml
on_http_request:
  - name: Allow only GitHub webhook POSTs
    expressions:
      - "!(req.url.path == '/webhooks/github' && req.method == 'POST')"
    actions:
      - type: deny
        config:
          status_code: 404
```

Create `~/.config/systemd/user/archon-webhook.service`:

```ini
[Unit]
Description=Archon public webhook tunnel via ngrok
Documentation=https://ngrok.com/docs/
After=network-online.target archon.service
Wants=network-online.target archon.service

[Service]
Type=simple
WorkingDirectory=/home/ubuntu/projects/misc/Archon
Environment=HOME=/home/ubuntu
ExecStart=/usr/local/bin/ngrok http 127.0.0.1:3090 --traffic-policy-file /home/ubuntu/.config/ngrok/archon-webhook-policy.yml --log=stdout --log-format=logfmt --log-level=info
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=default.target
```

Then enable and start it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now archon-webhook.service
systemctl --user status archon-webhook.service
```

Find the public URL:

```bash
curl -fsS http://127.0.0.1:4040/api/tunnels
```

The GitHub webhook URL is:

```text
https://<your-ngrok-host>/webhooks/github
```

Use the same secret in GitHub that you configured as `WEBHOOK_SECRET`.

## Verify path restriction

The public tunnel should block normal UI/API paths:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://<your-ngrok-host>/
# 404

curl -sS -o /dev/null -w "%{http_code}\n" https://<your-ngrok-host>/api/health
# 404
```

The webhook route should reach Archon. A request without a GitHub signature should return `400`,
which confirms that ngrok allowed the path and Archon rejected the unsigned request:

```bash
curl -sS -X POST -o /dev/null -w "%{http_code}\n" https://<your-ngrok-host>/webhooks/github
# 400
```

## Operations

```bash
systemctl --user status archon.service
systemctl --user restart archon.service
systemctl --user stop archon.service
journalctl --user -u archon.service -f

systemctl --user status archon-webhook.service
systemctl --user restart archon-webhook.service
systemctl --user stop archon-webhook.service
journalctl --user -u archon-webhook.service -f
```

If you use a free/random ngrok URL, the hostname may change after restart. Use an ngrok reserved
domain and add `--url https://<reserved-domain>` to `archon-webhook.service` if webhook URLs need
to remain stable.

## Tailscale tailnet access

Use Tailscale Serve when Archon should be reachable only inside your private tailnet. This is
separate from the ngrok webhook tunnel and does not make Archon public on the internet.

Create `~/.config/systemd/user/archon-tailscale.service`:

```ini
[Unit]
Description=Archon tailnet access via Tailscale Serve
Documentation=https://tailscale.com/kb/1247/funnel-serve-use-cases
After=network-online.target archon.service
Wants=network-online.target archon.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/home/ubuntu/projects/misc/Archon
Environment=HOME=/home/ubuntu
ExecStart=/usr/bin/tailscale serve --yes --bg --https 9443 127.0.0.1:3090
ExecStop=/usr/bin/tailscale serve --https=9443 off

[Install]
WantedBy=default.target
```

Then enable and start it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now archon-tailscale.service
systemctl --user status archon-tailscale.service
tailscale serve status
```

The tailnet URL is:

```text
https://<your-device>.<your-tailnet>.ts.net:9443
```

For this machine, that is currently:

```text
https://personal.tail267447.ts.net:9443
```

## Backlog orchestrator service

The message orchestrator runs inside `archon.service`. The optional backlog orchestrator is separate:
it polls GitHub issues and can start workflows automatically, so enable it only when the repository
labels and workflow mappings are ready.

Configure the projects it should watch explicitly in `.archon/config.yaml`:

```yaml
backlog:
  projects:
    - name: Archon
      repo: turboazot/Archon
      cwd: /home/ubuntu/projects/misc/Archon
      baseBranch: dev
    - name: X15
      repo: podlodka-ai-club/X15
      cwd: /home/ubuntu/.archon/workspaces/podlodka-ai-club/X15/source
```

Each project requires a GitHub `owner/repo` value. `cwd` is optional; when omitted, Archon runs
workflows from the service working directory. Use `cwd` when each project should run workflows from
its own checkout.

Create `~/.config/systemd/user/archon-orchestrator.service`:

```ini
[Unit]
Description=Archon backlog orchestrator
Documentation=https://archon.diy/
After=network-online.target archon.service
Wants=network-online.target archon.service

[Service]
Type=simple
WorkingDirectory=/home/ubuntu/projects/misc/Archon
Environment=HOME=/home/ubuntu
Environment=ARCHON_HOME=/home/ubuntu/.archon
EnvironmentFile=-/home/ubuntu/.archon/.env
EnvironmentFile=-/home/ubuntu/projects/misc/Archon/.archon/.env
ExecStart=/home/ubuntu/projects/misc/Archon/dist/binaries/archon-linux-x64 backlog run --poll-interval 60
Restart=on-failure
RestartSec=10
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=default.target
```

Verify the command can read repository state:

```bash
/home/ubuntu/projects/misc/Archon/dist/binaries/archon-linux-x64 backlog status
```

Set up backlog labels if needed:

```bash
/home/ubuntu/projects/misc/Archon/dist/binaries/archon-linux-x64 backlog setup
```

Enable the orchestrator only when live automation should begin:

```bash
systemctl --user daemon-reload
systemctl --user enable --now archon-orchestrator.service
systemctl --user status archon-orchestrator.service
journalctl --user -u archon-orchestrator.service -f
```
