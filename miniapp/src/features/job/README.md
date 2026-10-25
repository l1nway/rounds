# job

## Job states

`useJob` turns the launch into `{job, notice}`: `job` is non-null only when the editor can work (status not `ingesting` and a `proxy_url`), `notice` is what the viewer area shows instead. Order: not in Telegram (`initData` empty) → no `?job=` → load error (with "Try again", disabled offline) → `ingesting` (poll every 2 s) → loading or offline. A settled job (`ready`, `rendering`, `done`, `failed`) is never refetched, also not on reconnect, so nothing the owner already did can be reset by the network. The poll and the retry pause while offline and resume on `online`. Only `ingesting` is polled; `rendering` is shown as read-only, and the bot reports progress in the chat.
