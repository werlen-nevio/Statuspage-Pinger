<p align="center">
  <img src="assets/logo.png" alt="Statuspage Pinger" width="280">
</p>

<p align="center">
  <strong>A self-hosted uptime watchdog that calls your phone when something breaks, and the calls are free.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A518-339933.svg" alt="Node.js ≥ 18">
  <img src="https://img.shields.io/badge/npm%20dependencies-1-informational.svg" alt="Dependencies: 1">
</p>

Statuspage Pinger checks a list of URLs. When one goes down it keeps your
[Atlassian Statuspage](https://www.atlassian.com/software/statuspage) up to date,
posts the details to Discord and, most importantly, **rings your phone and reads
out what broke**. Press `1` to acknowledge. If you don't, it calls back.

A call sounds like this:

> *"Achtung. Datenbank ist nicht erreichbar. Grund: die Verbindung wurde
> abgewiesen. Zum Bestätigen die 1 drücken."*
>
> ("Attention. Database is unreachable. Reason: the connection was refused.
> Press 1 to acknowledge.")

It's all open source and runs on your own server. The call goes over SIP to an app
on your phone, [Asterisk](https://www.asterisk.org/) places it, and
[Piper](https://github.com/rhasspy/piper) generates the voice offline. There's no
Twilio, no per-minute billing, no cloud text-to-speech, and only one npm
dependency (`dotenv`).

**Only set up what you need.** All three outputs are optional, and each one is
turned off when its settings are empty:

| Output | Good for | You need |
| --- | --- | --- |
| Statuspage | Keeping your public status page accurate | A Statuspage API key |
| Discord | Giving the team the details | A webhook URL |
| Phone call | Waking someone up at 3 a.m. | Asterisk, Piper and two free SIP accounts |

To start small, you can use just Discord and skip the phone call setup. You can
add calls later.

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Setup in detail](#setup-in-detail)
- [Configuration](#configuration)
- [Running as a service](#running-as-a-service)
- [Troubleshooting](#troubleshooting)
- [Project layout](#project-layout)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Simple check list.** Write one `name|url|component-id` line per check in
  `CHECKS`. The component id is optional. Without it, the URL is still monitored
  and alerted on, but it never touches Statuspage.
- **Statuspage sync.** A confirmed state change is pushed to the component as
  `operational`, `degraded_performance` or `major_outage`. Checks that haven't
  changed make no API call, so you stay well under the 60 req/min limit.
- **Phone call with a spoken reason.** Raw error codes (`ECONNREFUSED`,
  `CERT_HAS_EXPIRED`, …) are turned into plain spoken German before synthesis.
- **Acknowledge with a keypress.** Pressing `1` (DTMF) ends the alert. If nobody
  acknowledges, it calls again after `CALL_RETRY_DELAY_MS`, up to `CALL_RETRIES`
  times, so a missed call doesn't mean a missed outage.
- **Recovery cancels the callback.** If the service comes back before you
  acknowledge, the pending retries are dropped and nobody gets woken up for
  nothing.
- **Flap protection.** A state has to hold for `FAILURE_THRESHOLD` checks in a row
  before it reaches the public page or your phone. Recovery uses its own lower
  threshold, so "back up" is reported quickly.
- **Details go to Discord.** Each state change gets an embed with the URL, the
  HTTP status or error, and how long it was down. These are the details that
  don't belong in a phone call.
- **Survives restarts.** The last confirmed state is saved to disk, so a redeploy
  during an outage doesn't alert again.
- **Checks its config at startup.** Malformed `CHECKS` entries and component ids
  that don't exist on the page are reported when the pinger starts, not during
  your first outage.

## How it works

1. Every `CHECK_INTERVAL_MS` (default 60 s), all URLs are fetched in parallel with
   a `CHECK_TIMEOUT_MS` timeout. Any `2xx`/`3xx` counts as up. `4xx`, `5xx`, DNS
   failures, TLS errors and timeouts count as down. If `DEGRADED_MS` is set, a
   healthy but slow response becomes `degraded_performance`.
2. A result that differs from the current state is counted, not published. Once
   it has repeated past the threshold, the new state is committed: Statuspage is
   updated and Discord is notified.
3. If the new state is listed in `CALL_ON`, Piper turns the announcement into a
   WAV file. The message is repeated `CALL_REPEATS` times with pauses, followed
   by some silence to leave time for a keypress.
4. The pinger sends Asterisk an `Originate` command over AMI (the Asterisk
   Manager Interface). Asterisk dials `CALL_TARGET` and hands the answered call to
   the `statuspage-alert` dialplan context. That context plays the WAV with
   `Read()`, which can be interrupted, so you can press `1` mid-sentence.
5. The dialplan reports its verdict back in a single `UserEvent`: `ack`, `noack`
   or `playback-error`. The pinger only reads that verdict. It never has to work
   out an acknowledgement from DTMF frames or packet counters.
6. With no acknowledgement, it waits and calls again, until `CALL_RETRIES` runs
   out or the service recovers.

The pinger matches events to the call by the `Uniqueid` it assigns with
`ChannelId`, not by the channel name. Asterisk names the channel itself (for
example `PJSIP/linphone-0000000a`), so a filter on the name would never match and
the acknowledgement would never arrive.

Calls are placed one at a time. If several things go down at once, you get one
call after another, and each one is acknowledged separately.

## Requirements

- **Node.js 18 or newer**
- **Debian or Ubuntu on x86_64** for the phone calls. `setup.sh` installs
  Asterisk and ffmpeg with `apt` and downloads the x86_64 Piper build. On other
  systems it works too, but you install those three yourself.
- **Optional:** an Atlassian Statuspage, a Discord webhook, and two free SIP
  accounts (see [The phone call](#the-phone-call-free)).

## Quick start

This gets HTTP checks and Discord running in a few minutes. Phone calls can be
added afterwards.

```bash
git clone https://github.com/werlen-nevio/Statuspage-Pinger.git /srv/statuspage
cd /srv/statuspage
npm install
cp .env.example .env
```

Open `.env`, put your URLs into `CHECKS`, and add `DISCORD_WEBHOOK_URL` and/or
the Statuspage credentials. Leave `SIP_URI` and `CALL_TARGET` empty for now,
which keeps calls turned off.

Then run a single pass to see whether everything works:

```bash
npm run once
```

When you're happy with it, [run it as a service](#running-as-a-service). When
you're ready for phone calls, continue with [The phone call](#the-phone-call-free).

> **Tip:** the systemd unit expects the project in `/srv/statuspage`. If you
> clone it somewhere else, change the paths in `statuspage-pinger.service`.

## Setup in detail

### Statuspage credentials

- **API key:** Statuspage → *Manage account* → *API info*.
- **Page ID:** Statuspage → *Page settings* → *Page ID*.

The components you reference must already exist on the page. To list them with
their ids:

```bash
npm run components
```

### Discord

Server Settings → Integrations → Webhooks → New Webhook → copy the URL into
`DISCORD_WEBHOOK_URL`. You don't need a bot, a token or intents.

To actually get notified instead of just informed, set `DISCORD_MENTION=@everyone`
(or `@here`, or `<@&roleid>` for a role). Two things decide whether that really
pings:

- **The mention has to be in the message `content`.** Discord doesn't notify
  anyone for a mention inside an embed, and that's where everything else in these
  messages lives. The code puts the mention in `content` and sets
  `allowed_mentions` explicitly, so nothing else can ping by accident.
- **The webhook needs the *Mention @everyone, @here and All Roles* permission in
  that channel.** Without it, the message is still posted but quietly doesn't
  ping. That's easy to miss, so test it once.

The mention only fires on `major_outage`. Pinging on every recovery is how a
channel ends up muted, and a muted channel is no use at three in the morning.

### The phone call (free)

First run the installer. It installs Asterisk and ffmpeg with `apt`, and Piper
with a German voice into `/opt/piper`:

```bash
sudo ./setup.sh
```

Next you need two SIP accounts: one the server calls *from*, and one on your
phone that gets called. The free option is
[sip.linphone.org](https://www.linphone.org/):

1. Install **Linphone** on your phone and choose *Create account*. This is the
   account you'll be called on, so it goes into `CALL_TARGET`.
2. Create a second account the same way for the server. It goes into `SIP_URI`,
   and its password goes into `pjsip.conf` (see [Asterisk](#asterisk)). Please
   create it by hand in the app: linphone.org's terms don't allow automated
   account creation.
3. Allow Linphone to run in the background (Android: Settings → Advanced →
   *Background mode*; iOS: allow notifications). linphone.org runs Flexisip, which
   sends incoming calls to iOS and Android as push notifications, so the phone
   rings even when the app is closed.
4. Configure Asterisk with those credentials ([next section](#asterisk)), then
   run `npm run test-call`. Your phone should ring and read out a test alarm.

```
SIP_URI=sip:pinger-abc123@sip.linphone.org
CALL_TARGET=sip:phone-abc123@sip.linphone.org
```

`SIP_URI` and `CALL_TARGET` only decide *whether* to call and *whom* to call. The
password and the rest of the SIP and media setup live in
`/etc/asterisk/pjsip.conf`.

**What "free" costs you:** this is a VoIP call over the internet, so it only
reaches a phone that has mobile data or Wi-Fi. A real phone-network (PSTN) call
through Twilio and similar services costs roughly 1 cent per alert plus about
$1.15/month for a number, but it also gets through with no data connection. And
the free linphone.org service comes with no uptime guarantee and no support.
Their terms say so explicitly.

Nothing in the code is tied to linphone.org, because both endpoints are plain
environment variables. To use your own Flexisip or a paid SIP trunk instead, you
edit `pjsip.conf` and leave the pinger alone.

### Asterisk

The ready-to-use config files are in [`asterisk/`](asterisk/), with the secrets
replaced by placeholders. [`asterisk/README.md`](asterisk/README.md) explains how
to fill them in and install them.

`setup.sh` installs Asterisk but deliberately **doesn't start it**. The stock
configuration exposes `chan_sip` on `0.0.0.0:5060`, `chan_iax2` on `4569` with an
anonymous `[guest]` account, and a reachable demo dialplan. Configure it first,
then start it.

Two files are edited in place instead of being replaced:

**`/etc/asterisk/modules.conf`:** keep `autoload=yes` and add under `[modules]`:

```
noload => chan_sip.so
noload => chan_iax2.so
noload => chan_unistim.so
noload => chan_console.so
; extensions.ael and extensions.lua compile the same demo dialplan back in
noload => pbx_ael.so
noload => pbx_lua.so
```

**`/etc/asterisk/logger.conf`:** the package logs only to the console. Add
`full => notice,warning,error,verbose,debug,dtmf` so a trace is kept on disk.

The template files already contain everything below. These notes explain the
settings that aren't obvious, so you don't "fix" them by accident.

**`pjsip.conf`** holds the registration and the endpoint the pinger dials
through:

| Setting | Why |
| --- | --- |
| `bind=0.0.0.0` | Forces IPv4. `sip.linphone.org` has an AAAA record, and on a host that prefers IPv6 the registration fails |
| `method=tlsv1_2` | An empty `method` means TLS 1.0 only |
| `server_uri` without a port | With `:5061` in the URI, Asterisk only looks up A records and never finds the second relay. Without a port, NAPTR/SRV lookups return both `sip11` and `sip12` |
| `max_retries=10000` | `0` means "don't retry at all", not "retry forever" |
| `retry_interval=180` | `30` would trip Flexisip's DoS protection |
| `media_encryption_optimistic=no` | `yes` puts the crypto line into a plain `RTP/AVP` offer, which Linphone rejects with `488`. Only `no` produces `RTP/SAVP` |
| `context=nirgendwo` | Incoming calls land in a context that is intentionally empty ("nirgendwo" is German for "nowhere") |
| `rtp_timeout` unset | The announcement is about 42 s long, and any smaller value cuts the call off mid-sentence |

**`extensions.conf`** contains the `statuspage-alert` context. It uses `Read()`
instead of `Playback()` for two reasons. `Read()` can be interrupted during
playback, so the key can be pressed mid-announcement. It also reports
`READSTATUS=ERROR` right away if the file can't be opened. `Playback()` would just
set `PLAYBACKSTATUS=FAILED` and carry on, which looks exactly like "answered,
nobody pressed a key".

**`manager.conf`** defines the AMI user. `read=` must include `system`, otherwise
`Registry` events never arrive and `PJSIPShowRegistrationsOutbound` answers
`Permission denied`. You can check it with
`asterisk -rx 'manager show user statuspage'`.

**`rtp.conf`** sets `rtpstart=20000` and `rtpend=20100`. Check what Asterisk
actually loaded with `asterisk -rx 'rtp show settings'`. If the range is empty or
reversed, Asterisk quietly falls back to 5000–31000, logs only a `LOG_WARNING`,
and the firewall rule below no longer matches.

Finally, set permissions, open the firewall and start Asterisk:

```bash
sudo chown asterisk:asterisk /etc/asterisk/{pjsip,manager,extensions,rtp}.conf
sudo chmod 0640 /etc/asterisk/{pjsip,manager}.conf
sudo ufw allow proto udp to any port 20000:20100 comment 'Asterisk RTP'
sudo systemctl start asterisk
```

Don't skip the RTP rule. Incoming RTP usually gets through on the
`RELATED,ESTABLISHED` rule once Asterisk has sent its first packet. When it
doesn't, you can't see the failure: the announcement is audible and the keypress
is ignored, because with `rfc4733` the keypress *is* incoming RTP. If your cloud
provider has its own firewall in front of the server (for example the Hetzner
Cloud Firewall), open the range there as well. Packets dropped there don't show up
in any log on the machine.

### Test it

```bash
npm run once       # one pass over all checks, then exit
npm run test-call  # ring the phone once, no outage required
```

## Configuration

Everything is configured through `.env`. [`.env.example`](.env.example) contains
all the options with comments.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CHECKS` | – | Checks as `name\|url\|component-id`, separated by newlines or commas. The name is spoken aloud, so keep it easy to pronounce |
| `CHECK_INTERVAL_MS` | `60000` | Time between check rounds |
| `CHECK_TIMEOUT_MS` | `10000` | Timeout per request |
| `FAILURE_THRESHOLD` | `2` | Failed rounds in a row before an outage is published |
| `SUCCESS_THRESHOLD` | `1` | Good rounds in a row before a recovery is published |
| `DEGRADED_MS` | `0` | Response time above which a check counts as degraded; `0` turns this off |
| `STATUSPAGE_API_KEY` / `STATUSPAGE_PAGE_ID` | – | Statuspage credentials; empty turns Statuspage updates off |
| `DISCORD_WEBHOOK_URL` | – | Discord webhook; empty turns Discord off |
| `DISCORD_MENTION` | – | Mention to ping on an outage: `@everyone`, `@here` or `<@&roleid>`. Only fires on `major_outage`, never on recovery or `degraded`. Empty turns it off |
| `SIP_URI` | – | SIP identity the pinger calls from; empty turns calls off. The credentials themselves live in `pjsip.conf` |
| `CALL_TARGET` | – | SIP URI to call; empty turns calls off |
| `AMI_HOST` / `AMI_PORT` | `127.0.0.1` / `5038` | Asterisk Manager Interface |
| `AMI_USER` / `AMI_SECRET` | `statuspage` / – | AMI credentials; must match `/etc/asterisk/manager.conf` |
| `ASTERISK_ENDPOINT` | `linphone` | PJSIP endpoint in `pjsip.conf` to dial through |
| `CALL_ON` | `major_outage` | States that trigger a call, comma separated |
| `CALL_ACK_DIGIT` | `1` | Key that acknowledges the alert |
| `CALL_RETRIES` | `3` | Call attempts before giving up |
| `CALL_RETRY_DELAY_MS` | `180000` | Wait between attempts |
| `CALL_TIMEOUT_MS` | `90000` | How long an answered call may run before it is hung up |
| `CALL_DIAL_TIMEOUT_MS` | `90000` | How long the phone may ring. Don't set it lower: the phone is first woken by a push notification, and Flexisip's fork timeout is about 90 s |
| `CALL_REPEATS` | `3` | How often the announcement repeats within one call |
| `CALL_REPEAT_GAP_SEC` | `2` | Pause between repeats |
| `CALL_TAIL_SILENCE_SEC` | `8` | Silence after the last repeat, to leave time for the keypress |
| `PIPER_BIN` / `PIPER_MODEL` | `/opt/piper/…` | Piper binary and voice model |
| `STATE_PATH` | `data/state.json` | Where the last confirmed state is stored |

**Another voice:** pick one from
[piper-voices](https://huggingface.co/rhasspy/piper-voices/tree/main/de/de_DE),
put the `.onnx` and `.onnx.json` files into `/opt/piper/voices/`, and point
`PIPER_MODEL` at them. You can also pass `VOICE=de_DE-…` to `setup.sh` to fetch a
different one.

## Running as a service

```bash
sudo cp /srv/statuspage/statuspage-pinger.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now statuspage-pinger
journalctl -u statuspage-pinger -f
```

The unit runs from `/srv/statuspage` with `ProtectSystem=strict`, and
`/srv/statuspage/data` is the only path it can write to. It starts after
Asterisk (`After=` and `Wants=asterisk.service`), but it doesn't depend on it.
Without Asterisk, HTTP monitoring, Statuspage sync and Discord keep working, and
only the calls can't be placed.

To check on both services:

```bash
systemctl status asterisk statuspage-pinger
journalctl -u statuspage-pinger -f
```

The pinger itself holds no SIP credentials. Only two secrets are stored on disk:
`AMI_SECRET` in `.env` (mode `600`), and the SIP password in
`/etc/asterisk/pjsip.conf` (mode `0640`, owner `asterisk`).

## Troubleshooting

**Start with `npm run diagnose`.** It places one real call and prints a full
report: the announcement's audio format, the AMI permissions, the registration
and its address family, a timestamped event trace, whether any DTMF arrived, how
many packets the RTP firewall rule matched, and the negotiated media profiles.

**`488 Not acceptable here`**: `media_encryption_optimistic=yes` is set in
`pjsip.conf`. It puts the crypto line into a plain `RTP/AVP` offer, which Linphone
rejects. Only `optimistic=no` produces `RTP/SAVP`.

**The registration gives up permanently after a while**: `max_retries=0` means
"don't retry at all", not "retry forever". Use a large finite value.

**The call cuts off mid-announcement**: `rtp_timeout` is too small. The
announcement takes about 42 s, and a value like `30` cuts into it. Leave it unset
(default `0`).

**The acknowledgement never arrives**: events are being matched on the channel
name instead of the `Uniqueid`. `ChannelId` sets the channel's `Uniqueid`. The
channel's *name* is something like `PJSIP/linphone-0000000a` and contains nothing
the pinger chose.

**`Registry` events missing, "Permission denied"**: `system` is missing from
`read=` in `manager.conf`.

**The announcement plays, but pressing `1` does nothing**: there are two possible
causes. Either incoming RTP is blocked (with `rfc4733` the keypress *is* incoming
RTP, so open `20000:20100/udp`, including in any cloud firewall), or the phone
sends DTMF in-band instead of as RFC 4733 events, which needs `dtmf_mode=auto`.
`npm run diagnose` tells the two apart: it reports the firewall packet counter and
whether any RFC 4733 digit arrived at all.

**The person called hears silence while the call keeps running**: the
announcement file couldn't be opened. `Read()` makes this visible where
`Playback()` wouldn't: `READSTATUS=ERROR` fires immediately, and the dialplan
reports `playback-error` within milliseconds of the call being answered. A
`noack` that arrives suspiciously fast is the same problem.

**TLS handshake fails**: don't remove the `method` line, because empty means
TLS 1.0 only. Try `tlsv1_3` or `sslv23`.

**Only one relay address is tried**: there's a port in `server_uri`. With `:5061`,
Asterisk only looks up A records. Without a port, NAPTR/SRV lookups return both
`sip11` and `sip12`.

**Asterisk can't be reached, or calls fail after "hiding" the transport**: a
PJSIP transport bound to loopback breaks outgoing TLS. The transport belongs on
`0.0.0.0`, and the firewall is what keeps it closed.

**The phone doesn't ring at all, and there's no `110 Push sent`**: this is the
one failure Asterisk can't fix. The free setup depends on Flexisip waking the
Linphone app with a push notification. On the phone, turn off battery
optimisation for Linphone, allow notifications, and on Android enable
*Settings → Advanced → Background mode*. If it's still unreliable, you need a
different transport, not a different PBX: a PSTN call (about 1 cent per alert,
about $1/month) rings over the mobile network and doesn't need push. The notifier
layer is swappable for exactly this reason.

<details>
<summary><strong>Background: why Asterisk and not baresip?</strong></summary>

The first version used baresip, and it never got audio out of a call.

baresip applied the SDP answer and built the audio pipeline correctly
(`aufile ---> aubuf ---> auresamp ---> auconv ---> PCMU`). Then
`call_update_media()` returned `ENOSYS` and tore the call down before a single
RTP packet was sent (`audio: destroyed (started=0)`). This was reproduced with the
Ubuntu package (1.0.0) and a self-built 4.11.0, with and without SRTP, with and
without ICE, and with baresip's own default config. Upstream
[issue #2342](https://github.com/baresip/baresip/issues/2342) reports the same
error against sip.linphone.org and notes that the identical setup works against
Asterisk. It was closed as not planned.

A second, unrelated failure had the same fix. `sip.linphone.org` has an AAAA
record, and on a host that prefers IPv6, baresip tried to reach the registrar
over an address family it had no transport for. It failed with
`Address family not supported`. Asterisk's `bind=0.0.0.0` pins the connection to
IPv4.

</details>

## Project layout

### Scripts

| Command | Purpose |
| --- | --- |
| `npm start` | Run the daemon |
| `npm run once` | Run a single pass, then exit (for cron or debugging) |
| `npm run test-call` | Place one test call |
| `npm run components` | List the Statuspage components with their ids |
| `npm run diagnose` | Place one call and report on every stage of it |
| `npm run dev` | Run the daemon with `--watch` |

### Files

| File | Role |
| --- | --- |
| `src/index.js` | Main loop, debouncing, state transitions, wiring |
| `src/checker.js` | The HTTP check |
| `src/statuspage.js` | Statuspage API |
| `src/discord.js` | Discord webhook |
| `src/tts.js` | Piper + ffmpeg → call audio, written atomically |
| `src/ami.js` | The Asterisk Manager Interface protocol over a raw socket |
| `src/asterisk.js` | AMI connection lifecycle and registration health |
| `src/voicecall.js` | Dialing, acknowledgement, retries, cancellation |
| `src/state.js` | Saved state |
| `src/config.js` | Reading settings from the environment |
| `scripts/diagnose-call.mjs` | The `npm run diagnose` report |
| `asterisk/` | Asterisk configuration templates, with secrets replaced by placeholders |

## Contributing

Contributions are very welcome, whether it's a bug report, a question, a doc fix
or a pull request.

- **Found a bug or got stuck?** [Open an issue](https://github.com/werlen-nevio/Statuspage-Pinger/issues).
  The output of `npm run diagnose` helps a lot for anything call-related.
- **Want to change something bigger?** Please open an issue first so we can agree
  on the approach before you put in the work.
- **Keep it lean.** The project deliberately has a single npm dependency. If a
  change needs a new one, please explain why in the PR.

Some ideas if you're looking for something to work on:

- **Other languages.** The announcement is German for now. The spoken text is
  built in `src/index.js` (`buildAnnouncement`), and error codes are translated in
  `src/tts.js`.
- **More notifiers**, for example a PSTN provider for phones without data, or
  other chat services besides Discord.
- **Setup on other platforms**, such as non-Debian distributions or ARM (Piper
  has ARM builds).

## License

[MIT](LICENSE) © Nevio Werlen
