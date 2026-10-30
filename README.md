# Volo pickup watcher 🏐

Every ~15 min, asks Volo's public API (the same one volosports.com/discover uses) for open **San Francisco volleyball pickups**. When a new session appears, it pushes to your phone with the session name. Tapping the notification opens the Volo listing.

## Setup (~5 min)

1. **Phone:** install the **ntfy** app (iOS/Android), tap **+**, and subscribe to a long random topic name, e.g. `jackie-volo-8f3k2q9x`. Anyone who knows the name can read it, so make it unguessable.
2. **Repo:** create a new **public** GitHub repo (public = unlimited free Actions minutes; nothing secret is in the code) and push these files.
3. **Settings → Secrets and variables → Actions → New repository secret:** `NTFY_TOPIC` = your topic name.
4. **Actions tab → Volo pickup watcher → Run workflow.** You should get a "watcher is live" push within a minute or two.

That's it. No URL to configure; SF + volleyball + pickups is built in.

## Notes

- The first run records what's already open. Alerts start with the next new session.
- Only **new** sessions alert. Spots filling up or sessions closing don't.
- If Volo can't be reached for ~3 hrs straight, you get one "needs a look" push.
- Want other sports too? Add a repo **variable** `SPORTS` = `volleyball,pickleball` and pass it in the workflow env.
- Local test: `npm i && npm run dry`
