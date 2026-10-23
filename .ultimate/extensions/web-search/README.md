Search the public web through your own SearXNG instance with `web_search`. No API key: the instance is on your local network, and the setting lives in user settings, so no repository can point your queries at someone else's server.

Set `webSearch.url` in `~/.ultimate/settings.json` (this machine only; never project settings), for example `{ "webSearch": { "url": "http://192.168.1.102:8389" } }`. It defaults to that LAN instance. The instance must answer JSON: add `json` to `search.formats` in its `settings.yml`; when it does not, the tool says so instead of failing quietly.

`web_search { query, count?, categories?, time_range? }` returns ranked pages — title, URL, domain, snippet, publication date — capped at 25 results (default 10), with a 15-second timeout and cancellation. It is read-only and replay-safe. Text output is capped at 50 KiB / 2000 lines. When upstream engines are unresponsive (rate-limited, CAPTCHA), the tool reports them: the result set may be incomplete. Search only — to read a result page, `curl` it with bash (send a User-Agent; some sites block curl's default).

Privacy: queries go to your instance over the network in plain HTTP unless you set an https URL; the instance then proxies them to upstream engines, so the query text does leave the machine through it. Unreachable or misconfigured instances produce a tool error naming the setting, plus one process-local notice, never an in-chat credential form.

## UI

`web_search` renders from its `details`, collapsed while it succeeds: the query, the top three domains and `n results`; expanded, each result's title as a link, its domain, date and a three-line excerpt. Unresponsive engines show as `n engines down` in the header and one warning line each. A failed call opens itself to show the error. The card requests nothing from the web: links load only when followed.

## Verify

Ask Ultimate to search something, or call it directly: `curl "http://<instance>/search?q=test&format=json"` must return JSON with a `results` array. `ULTIMATE_WEB_SEARCH_TEST_URL` overrides the instance URL only for local fake-server tests (`test/web-search.test.ts`); never set it in production.
