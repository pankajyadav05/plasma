# Product analytics

The main process owns analytics delivery, opt-out and identity. The renderer loads
no PostHog SDK and its CSP stays closed. User-facing wording lives on the site's
"Safety and privacy" page; keep the two in step.

## Turning it on

Set `POSTHOG_PROJECT_KEY` (and `POSTHOG_HOST` for an EU project) in
`src/main/telemetry/config.ts`. With an empty key nothing is ever sent, and no id
is created. A `phc_` key can only write events, so it ships in the build. In the
PostHog project settings, turn on **Discard client IP data**: events come straight
from users' machines, so PostHog sees their addresses.

## Who can be off

Analytics runs when all of these allow it:

- the build has a key;
- the environment allows it: a packaged build, not `CI`, no `PLASMA_USER_DATA`
  (E2E and the release smoke launch would each count as a new install), no
  `DO_NOT_TRACK`. `PLASMA_TELEMETRY_ENABLED` overrides this either way, so set it
  to `true` to test from `pnpm dev`;
- the user's setting, Settings → Advanced → Usage data (`usageDataEnabled`, on
  unless set to false). Turning it off also drops whatever had not been sent. Old
  builds saved `telemetryEnabled` as false by default, so that key is ignored and
  must not be read again; a `telemetryEnabled` row left in the database is harmless.

## Identity

`distinct_id` and `installId` are the same value: the hash of a random id kept in
`telemetry-id` in userData. It is created on the first event, never for an install
with analytics off. Unlike T3 Code, which this design follows, Plasma reads no
account or other tool's credentials to link installs: one person on two computers
counts twice. Person profiles are off and geo lookup is disabled on every event.

## Collection boundary

`src/main/telemetry/events.ts` is the whole list of events and properties, typed
so that a new one has to be added there. Values are booleans, closed enums and
buckets. Never add SQL, row data, hosts, ports, database, schema, table or
connection names, usernames, paths, server versions, model names (users type
custom ones), or error messages: database errors quote values.

`feature.used` counts IPC requests that start a feature, recorded after the handler
succeeds. `FEATURE_BY_CHANNEL` allowlists the channels and only the channel is
read, so a payload cannot reach analytics. Leave out plumbing the app calls by
itself; it would count as use. That is why `plasma:redis:command` is not listed:
the Redis health and server views poll through it.

## Interpreting events

`query.executed` counts statements people ran from the editor or approved from the
assistant; Plasma's own queries (`internal`) and read-only agent or monitor queries
on the aux connection are not included. `connection.recovered` is a silent
reconnect, so it is not a second `connection.opened`. A cancelled file dialog can
still count as `feature.used` for channels that resolve with nothing.

## Delivery

`src/main/telemetry/analytics.ts` posts to PostHog's `/batch/` every 10 seconds, 20
events a send. Each event gets a uuid when recorded because a send can fail after
PostHog stored it, so every retry is a copy. A failed batch backs off (2 seconds up
to 5 minutes) and is dropped after 30 minutes; 400, 401 and 413 drop it at once.
The buffer holds 1,000 events in memory and nothing is written to disk. Quitting
waits up to 1.5 seconds for a last send.
