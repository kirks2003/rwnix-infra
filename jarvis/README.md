# Jarvis web assistant

Multi-user browser Jarvis for Chrome desktop and Android Chrome.

## What it does

- Shows every stage in the web UI: boot, wake listening, wake detected, recording, 1.5 s silence stop, Whisper upload, LLM prompt, TTS speaking, errors, and backend request details.
- **Animation preview** buttons switch the core and waveform between every pipeline animation (Standby, Wake, Recording, Transcribing, Thinking, Speaking, Error) without arming; they are disabled while a session runs, so the live pipeline always owns the core.
- Uses self-hosted Whisper wake probes for the phrase `Hey Rocky`; browser speech recognition is not used for wake or prompt STT.
- Captures mono PCM continuously with an `AudioWorklet` while armed. Overlapping voice probes are encoded as complete WAV files, without gaps while Whisper responds.
- Probes fire on the trailing edge of speech, about 350 ms after the talker stops, rather than on a fixed interval. A window that ends mid-word comes back from Whisper empty, which used to cost a whole probe cycle before the wake phrase was heard. Settled probes overlap the previous window by 2 s so a phrase crossing the boundary is not lost. If speech runs on without pausing, a probe is sent anyway once the burst reaches 3 s; that cap counts speech, not wall time, so leading silence cannot trip it mid-word. A forced probe covers everything since the last probe, so on a microphone that never settles a short wake phrase cannot fall into the gap between probes.
- After wake detection, waits for the utterance to finish and sends its complete audio to Whisper. This preserves commands spoken immediately after "Hey Rocky". A wake word alone opens a separate command window with an audible beep. If the completed utterance or the post-beep window comes back empty (the command was spoken but transcription lost it), Jarvis logs it and returns to wake listening without a dead-end error, so the next attempt retries.
- **Silence stop slider.** The **Silence stop** slider in the Mic level panel sets how long the microphone must stay quiet before a recorded command is sent to Whisper: 100 ms to 5 s in 50 ms steps. The server default (`SILENCE_MS`) is only the initial value; the slider applies live — even mid-recording, because the VAD reads the current value on every 100 ms tick — and is saved per browser (local storage), like the wake word. The green silence bar's scale, the pipeline's vad step name ("Stop after 1.5 s silence") and the status-line countdown all follow the slider.
- **Bounded step retries.** If a pipeline step that can be repeated without new input fails — a wake probe or command transcription (the audio is still in the capture buffer), the brain request (the prompt is captured), or the speech output (the answer text is known) — it is retried up to 3 times, 1 s apart, with the already-captured material. The Live log records every attempt (`wake probe failed (attempt 1/3): …; retrying in 1000 ms`) and the pipeline status line shows the next retry. Only after all 3 attempts fail does the pipeline show the usual red error stage and return to wake listening; aborts (Stop, tab hidden) are never retried. This is what keeps a transient Whisper/brain/TTS blip from making the user speak the input again.
- **Audible pipeline beeps** (all from the capture microphone's audio context): the 880→1320 Hz sweep says "wake word heard / speak now"; a soft 660 Hz tick (`probeBeep`) sounds the moment a wake-probe window is sent to Whisper; a higher 1760 Hz ping (`sentBeep`) sounds the moment the command audio is sent and transcription starts — so every upload is audible even on a muted-looking UI.
- Sends audio to one or more self-hosted Whisper endpoints through the backend, so the browser never needs cross-origin access to Whisper.
- Sends the recognized prompt to an OpenAI-compatible self-hosted brain through the backend, so API keys never reach the browser.
- Speaks the answer with the selected voice and writes both prompt and answer on the page. **Browser voice** uses `speechSynthesis`; **HAL 9000** uses a self-hosted neural TTS backend through the server proxy.
- Shows a live circular waveform ring around the core: 60 spectrum bars read from a tap on the existing Web Audio graphs (microphone while listening, the shaped HAL output while speaking) with fast-attack/slow-release smoothing and a white flash on hot bars. Stages without a tappable source (browser `speechSynthesis`, Whisper/brain waiting) show deterministic synthetic motion, and the reactor's glow and size follow the overall level.
- **One switch per MCP server** in the controls row (per browser, like the wake word): the backend advertises its MCP servers in `/api/config` (`mcpServers`), the UI builds one on/off switch for each, and every `/api/chat` request carries the enabled set as `mcp: { id: true }`. Today that is the **Web search** switch: when on, the backend runs the `mcp/websearch.mjs` Model Context Protocol server (stdio, `web_search` tool, no API key) and hands the results to the brain as context for that one prompt. The search queries every free keyless engine **in parallel** and merges the results round-robin, deduplicated by URL, each tagged with its source engine: **DuckDuckGo** (HTML endpoint, ad and redirect links unwrapped), **Bing** (HTML endpoint, `bing.com/ck/a` redirects unwrapped to the real target), **Wikipedia** (search API) and the **DuckDuckGo Instant Answer API** (abstract/definition/direct answer plus related topics, prepended as an "instant answer" block — the closest free thing to an AI answer). A walled or down engine degrades to zero results without failing the search; measured per-engine availability from server IPs is in `DEPLOYMENT.md`. A fully failed search degrades to a normal answer and is reported in the backend logs (`websearch_success` / `websearch_failure` / `websearch_skipped`). Needs outbound internet from the backend container. The brain's system prompt also carries each server's state per request, so it knows when web search is on or off and answers capability questions ("can you search the web?", "is the MCP server available?") about the feature instead of denying it — and while it is off, it is told that live data (the weather now, news, prices, scores) needs the **MCP web search** toggle enabled, so it answers a weather question honestly instead of guessing.
- **Stop the answer by voice.** While an answer is being spoken, a parallel wake watch probes the microphone with the same trailing-edge trigger as the wake probes (350 ms of silence, plus a forced probe after 3 s of unbroken voice, because the speaker echo keeps the mic active) — so a stop command cuts the speech within at most 3 seconds of being said, for every voice profile. Saying the wake word plus a stop word ("stop", "stopp", "stop it", "halt", "still", "quiet", "enough", "genug", "genugsam", "das reicht", "reicht", "schweig", "schweigen", "hör auf", "lass es", "lass das", "genug schon") cuts the speech: the Live log says so, the pipeline beeps and returns to wake listening without a brain round trip. Saying **just the stop word, without the wake word**, also cuts the speech — that is the escape hatch for answers that run too long. With speaker echo the probe window transcribes as the answer's own words plus the stop word, so the match is echo-aware: it fires when the whole window is the stop word, or when the stop word stands alone (word boundary, anywhere in the window) **and** the window's audio carries a loud user burst — a contiguous ≥200 ms run of mic blocks at least 1.5× the window's voice-block median, i.e. the user's own voice standing out against the quieter echo. A pure-echo window (no user burst) can never self-trigger on an answer that merely ends on a stop word, and a stop word buried in the echo's text without the user's voice is ignored. The same echo-aware rule applies to the wake pipeline's fallback: the same stop word heard up to 10 s after the speech already finished is treated identically, wake word or not (the fallback's permissive match additionally requires the stop word to end the utterance). Every watch probe's transcript lands in the Live log ("Speech watch probe: …"), so a stop that does not trigger is debuggable from the page alone. Any other command heard while speaking ("Rocky, what time is it?") cuts the speech and starts a new brain round trip with it.
- **Text-only mode.** The **Speak / Text only** switch in the voice settings turns spoken answers off: the answer is written to the Answer panel and the TTS step is marked skipped. The wake pipeline itself keeps running; the setting is saved per browser.
- Spoken output is plain language only: before any TTS request or `speechSynthesis` utterance, markdown, links, code markers, URLs and special signs are stripped (`textForSpeech` in `public/voice.js`). The printed Answer panel keeps the brain's text verbatim.
- **Knowledge graph (MCP + panel).** Next to web search there is a second MCP server, **Knowledge graph** (`id: "graph"`), giving the brain read-only access to the Neo4j knowledge graph through the official `neo4j-mcp` server (stdio, spawned by the backend exactly like the web-search server). With the toggle on, the brain's system prompt carries the user's stored entities plus the shared knowledge (a bounded context block), and the brain can call two tools — `get-schema` and `read-cypher` — over up to five tool rounds within the request deadline; the tool results go back to the brain as regular tool messages. The brain's system prompt also carries a short data-model cheat-sheet (accounts are `:User` nodes, everything else is `:Entity`, and a user's stored facts are the *outgoing relations* of their `:User` node, with an example query), so "what does X like?" is answered by querying the relations instead of just the node. The graph is populated automatically: after every answered turn the backend (never the brain) makes one structured extraction call over the prompt, the web search results and the answer, and upserts the entities and relations — the app's only write path, run fire-and-forget so the spoken reply is never blocked. Chat turns can never write to the graph: the MCP server is spawned with writes disabled (the write tool does not exist in its tool list), `read-cypher` rejects write Cypher via Neo4j's query classification, and the only write path is the backend's own ingestion, which issues only `MERGE`/`SET` upserts (see "Knowledge graph (Neo4j)"). The **Knowledge graph panel** below the Prompt/Answer panels is a read-only view — node/link counts, a live 3D force layout of the newest (or a clicked node's) neighbourhood (three.js, animated, drag-to-orbit and wheel zoom, link labels with the relation type in plain words; a static 2D SVG toggle is available, and browsers without WebGL 2 fall back to it automatically), the schema, and recent activity (the brain's read queries plus ingested turns); it refreshes every 15 s and after each answered turn. Without the `NEO4J_*` environment variables everything degrades to "not configured" (panel status line, no tools, the brain is told the feature is unavailable) and nothing else changes.
- **Multi-user login**: the shell opens on a sign-in form (users from `USERS`, default `Mila,Roman`; each user's password is their own name). A successful login sets an HttpOnly session cookie; every `/api/*` route (except login/logout/health) requires it and answers 403 otherwise, which the UI turns back into the login screen. (403, deliberately not 401: the app sits behind the gateway's Basic Auth layer, and a 401 arriving on a request that carried those credentials makes the browser clear its cached Basic credentials and prompt again — see `DEPLOYMENT.md`, "Double Basic Auth prompt".) Each user's prompt history is kept on the server **per account**, so Mila and Roman have completely separate prompt caches (shared across that user's own tabs) with no connection between users. Sign out from the hero or just close the tab (sessions live 7 days, in memory only).

## Browser limitations

**Arm Jarvis sends voice-containing wake probes to your configured Whisper server even before a wake phrase is detected.** It is server-side wake detection, not a local/private wake-word model. Silent windows are not uploaded. A bounded 45-second PCM buffer stays in browser memory; the backend does not save recordings.

Keep the HTTPS page in the foreground. Hiding it explicitly stops the microphone, speech output and pending requests; return and click **Arm Jarvis** again. Microphone denial or interrupted capture is shown as an error. Wake response time includes a roughly two-second probe interval plus Whisper latency. This consumes server inference capacity while armed; an on-device wake engine would be a future alternative, not a feature of this build.

The reactor and active pipeline step follow the actual operation, not independent display timers. The hero heading next to the animation shows the stage name and a short caption about what is running — never endpoint URLs, host names, payload sizes or request IDs. Those appear **in the Live log and the Pipeline panel's status line only**; an error's detail (for example the failing Whisper host) stays there too, and the hero just says "Something went wrong. See the Live log for details." Only one pipeline runs per tab. **Stop** invalidates all callbacks, aborts requests, releases tracks and cancels TTS; **typing a prompt directly in the Prompt panel** (Send) is available only when disarmed. Disarming resets every pipeline step to waiting, so a finished or interrupted run — including the direct-prompt flow, whose brain and speech-output steps complete while disarmed — never leaves green done, gray skipped or red error icons behind.

Layout: the **Prompt/Answer** panels sit at the top (each tall enough to hold a full answer, and the Prompt panel carries the direct prompt input). A **Panels off/on** switch below them hides or shows everything underneath — refused while a session runs, because the Stop button lives in the hidden area. Under the switch: the **Mic level** panel holds both meters — the live mic bar and the green **Silence** bar, each with its own value readout (the silence bar fills live during wake listening, so speaking the wake word is visible) — both bars run on a dedicated 100 ms timer independent of the pipeline loop, so they keep filling in real time while audio is in flight to Whisper or the brain instead of freezing and jumping when the round trip returns — plus the **Silence stop** slider (100 ms-5 s) that sets the command's silence stop point, live and per browser — the **Pipeline** panel sits directly below it, and the main controls row (Arm Jarvis, Stop, language switch and the per-server **MCP** switches, all in one row) comes after them. The **Live log** is a full-width panel at the very bottom of the page.

Set **Your wake word** and click **Apply wake word** to override the server default (`Hey Rocky`) for your browser. Applying stops any active session; click **Arm Jarvis** again. The setting is saved in local storage per browser profile and website origin (the NBG and VIE URLs have separate settings), not shared with other users. Use 1-60 characters: words/numbers, spaces, hyphens or apostrophes. If storage is blocked, the UI explicitly reports that the change applies only until reload.

The **Live log** prints `Wake probe recognized: "..."` and `Command recognized: "..."` for Whisper responses, including non-wake speech. Empty responses show `(no speech recognized)`. Endpoint, request ID and attempt metadata follow separately. These readable transcripts are displayed in this tab, not added to persistent Docker logs; Clear removes the visible log.

Commands end after the silence stop (server default `SILENCE_MS`, overridden per browser by the Silence stop slider, 100 ms-5 s) of silence, with a 10-second wait for initial speech and a 15-second command limit. Whisper upstream requests time out after 20 seconds per endpoint and brain requests after 45 seconds. TTS has a bounded watchdog that cancels speech and reports an error rather than pretending playback finished.

## Answer voice

Pick **Answer voice** in the UI; the choice is saved in local storage per browser profile and origin, like the wake word, and applies to the next answer. An answer that is already being spoken finishes in the old voice.

**Speaking speed** is a slider from 0.60x to 1.60x, also saved per browser. It is a multiplier on the chosen voice's own pace, so 1.00x is the voice as designed; it scales the `speed` sent to the TTS engine and the `speechSynthesis` rate alike, clamped to the 0.5-2.0 both accept.

**Speak / Text only** (in the same settings block) turns spoken answers off: the answer is written to the Answer panel as text only and the pipeline's TTS step is marked skipped. The microphone and wake listening keep running. Saved per browser; while off, the voice select and speed slider are disabled.

- **Browser voice** — unchanged `speechSynthesis` behaviour, one utterance per answer, no backend needed.
- **HAL 9000** — the answer is split into clauses on sentence punctuation. Each clause is synthesized by the TTS endpoints in `TTS_ENDPOINTS` (requested at `speed` 0.8), then played through a Web Audio chain that band-limits it to roughly 95-3800 Hz, lifts 220 Hz, compresses it flat and adds a short room tail, with a 420 ms pause between clauses. The next clause is fetched while the current one plays.
- **Character profiles** (Commander, Android, Wizard, Newscaster) — delivery styles rather than clones of specific people. Each is a distinct pace/pitch/clause-pause shape (see `voiceProfiles` in `public/voice.js`), and the backend maps each profile to its own Kokoro voice (`profileVoices` in `server.js`: Commander `bm_daniel`, Android `bm_lewis`, Wizard `bm_fable`, Newscaster `am_michael`; HAL 9000 stays `bm_george`). The timbre comes from the self-hosted Kokoro model, so these are "in the style of" an archetype, not recordings of any real actor. Without a TTS backend they fall back to `speechSynthesis` at their delivery shape.
- **Named male/female voices** — Heart, Bella, Nicole and Sarah (female; Kokoro `af_heart`, `af_bella`, `af_nicole`, `af_sarah`) and Adam, Eric and Liam (male; Kokoro `am_adam`, `am_eric`, `am_liam`). The Answer-voice select is grouped Basic / Character voices / Female voices / Male voices, so switching gender is a two-level choice and the stored value is still the flat profile id. Each named voice carries its own delivery shape and a browser-voice fallback that matches its gender (the `speechSynthesis` picker boosts voices of the profile's gender and penalizes the other; German mode picks a female German voice for female profiles and a male one by default).

`TTS_ENDPOINTS` must speak the OpenAI `/v1/audio/speech` protocol. The deployed backend is the `speaches` container on gpu-1, which serves both `/v1/audio/speech` (Kokoro) and `/v1/audio/transcriptions` (Whisper large-v3) behind one API key — see `DEPLOYMENT.md`. Kokoro-FastAPI and openedai-speech (which can front Piper) are drop-in alternatives. The browser only talks to `/api/speak` on this backend, so `TTS_API_KEY` stays on the host.

Multiple endpoints are comma-separated and tried round-robin with failover, like Whisper. Each clause request times out after 20 seconds. Measured against gpu-1 over HTTPS: about 0.5 s per clause for synthesis and 1.0 s for a short command transcription.

**Answer text is sent to the configured TTS endpoints.** `/api/speak` truncates at 2000 characters and clamps speed to 0.5-2.

With `TTS_ENDPOINTS` empty, HAL 9000 is still selectable but degrades to `speechSynthesis` at rate 0.68 and pitch 0.5, preferring a deep English voice if the browser has one: the cadence survives, the filtering and reverb do not. The same fallback finishes the remaining clauses if the TTS backend fails part-way through an answer, and the live log says so rather than dropping the rest of the answer.

## Language switch (English / Deutsch)

The **Language** toggle in the controls row (a single sliding switch next to Arm Jarvis / Stop) sets the spoken language for the whole pipeline at once, per browser (saved in local storage, like the wake word). **English is the default** when a browser has not saved a choice, regardless of the server's `WHISPER_LANGUAGE`:

- **Whisper** — each probe and command request sends the language to the STT endpoint (`/api/transcribe?language=de`); the server default is `WHISPER_LANGUAGE`.
- **Brain** — each `/api/chat` request carries the language and the backend appends a `Language override: answer in …` directive to the system prompt, which wins over a hardcoded language in `BRAIN_SYSTEM_PROMPT`.
- **Spoken output** — English keeps the selected profile's behaviour (neural TTS first). **German uses the browser voice with a German voice** (male preferred when the browser has one), because the self-hosted Kokoro engine on gpu-1 ships English voices only. The live log says so when it kicks in.

The switch applies live from the next request and does not stop a running session; an answer already being spoken finishes in its original language.

## Login (multi-user)

The app opens on a sign-in form. Users come from the `USERS` environment variable (comma-separated, default `Mila,Roman`); **each user's password is their own name** — Mila signs in with username `Mila` and password `Mila`, Roman with `Roman`/`Roman`. User names are matched case-insensitively; the password must equal the name.

- A successful login creates an in-memory server session (random 256-bit token) and sets it as an `HttpOnly; SameSite=Lax` cookie (`Secure` when the request arrives through an HTTPS front). Sessions live 7 days and die with a server restart, like all prompt history.
- **Every `/api/*` route requires the cookie** (except `/api/login`, `/api/logout` and the public `/api/health` used by the container healthcheck) and answers `403` otherwise. The UI treats the 403 on `/api/config` as "show the login screen", so no API data ever reaches a signed-out tab. A wrong username or password also gets 403 (the 429 lockout is unchanged). The app never answers 401: behind the gateway's Basic Auth layer a 401 makes the browser drop the cached mesh credentials and re-prompt Basic Auth on the next request.
- **Per-user prompt caches**: the conversation history behind the brain is keyed by the authenticated account, not by a browser tab. Every tab signed in as Mila shares Mila's last-10-messages cache; Roman's cache is a different entry the server never mixes with it. There is no route or payload by which one user can read or influence the other's session — the client-sent session id is ignored.
- **Jarvis knows who is signed in.** The brain's system prompt carries the authenticated user's name and is told it is their first name, so answers address the user by name (Mila gets "Mila, …", Roman gets "Roman, …").
- **The brain answers as the wake word's name.** Every brain request carries the active wake phrase (the server default, or the personal per-browser override), and the server derives the name from it — the phrase without a leading "Hey/Hi/Hallo" filler, capitalized: "Hey Rocky" → Rocky, "Kaya" → Kaya. The system prompt tells the brain its name is that word, so "Who are you?" gets "My name is Rocky, Mila." Browsers that send no phrase fall back to Jarvis.
- Five failed logins from one address lock it out for 15 minutes (429).
- **Sign out** (hero, next to "Signed in as …") stops any running session and deletes the server session; the cookie is cleared in the browser.

## Knowledge graph (Neo4j)

The knowledge graph is a Neo4j Community database on the compose network that stores what the assistant learns from conversations and web searches. **Every `:Entity` is private to its owner:** entities are keyed by `(name, type, owner)` with `owner` = the signed-in user of the turn that mentioned them, so the same thing mentioned by two users is two separate nodes ("Lego" mentioned by Mila and by Roman is `Lego(owner: Mila)` and `Lego(owner: Roman)`). There is no shared or public tier — no `common` flag, no `(:User)-[:KNOWS]->(:Entity)` bookkeeping edge: ownership *is* the provenance, and every read path (panel, brain context, brain tools) is pinned to `owner = $user`, so a user's world is bounded by construction. Facts are the relation edges from a fixed allowlist (`WORKS_AT`, `LIVES_IN`, `STUDIES_AT`, `BORN_IN`, `FRIEND_OF`, `FAMILY_OF`, `PART_OF`, `LOCATED_IN`, `RELATED_TO`, `MENTIONED_IN`, `LIKES`, `WENT_TO`, `OWNS`, `USES`); every relation can carry a `negative` flag — negation is a property of the relation, never a separate type ("I don't like X" is `LIKES` + `negative`) — and since ingestion upserts with `SET`, a later statement flips the same edge instead of adding a second one. Every registered user is a single node: the `:User` account *is* the person — the extractor lists people as person entities, but ingestion never stores an entity named after a registered user (that would be a second, same-named `:Entity`, i.e. a proxy for that user's personal data), and relations named after any registered user (`Mila -LIKES-> Lego`, stated by or about Mila) attach to that user's `:User` node. The only exception to per-user visibility is the administrator: with direct database access (`neo4j-admin` / `cypher-shell` on the `neo4j` volume) an admin can query across all owners (`MATCH (e:Entity {name: "Lego"})` returns every owner's copy) — the per-user guarantee is enforced by the application layer, not by the database (Community Edition has no RBAC), so treat the database credentials as full access to every user's data.

**Per-user data isolation.** Everything the graph stores is private to its owner: an `:Entity` belongs to exactly one user (`owner`), and a fact edge is visible to a user only when every `:Entity` endpoint of the edge is theirs. `:User` nodes are account markers (name only, no personal data) and may appear as fact-edge endpoints in the owner's panel — e.g. a fact Roman states *about* Mila (`Mila -LIKES-> Pizza`, where Pizza is Roman's copy) shows in Roman's panel with Mila's type-less account node, and a pure user-to-user edge is visible only to its two parties. Nothing else crosses the boundary: the panel, the activity feed, the brain's context and the brain's tools are all scoped to the signed-in session user:

- The panel (`/api/graph/status`, `/api/graph/subgraph`) shows the signed-in user's drawn world only — their `:User` node, the entities they own, and the fact edges between them (ownership bounds the world; there is no neighbour expansion to leak through). An *isolated mention* — an entity the user owns but no visible fact edge touches — is neither drawn nor counted: it stays in the database (the brain's context and `list-my-knowledge` still see it), but it does not float in the 3D view. With a `center`: a *visible* centre (the user's own node or an entity they own) plus its neighbours (their own entities and `:User` account markers; a centre the user cannot see comes back empty). Another user's entity or fact edge never appears, no matter which `center` elementId the client sends. The activity feed lists only the session user's own brain reads and ingested turns.
- The brain gets four **parameterized** read tools — `get-schema`, `get-entity(name)`, `list-my-knowledge`, `list-my-facts(about?, relation?)` — and no Cypher at all. The backend injects the session `user` into every call (the tool schema the brain sees has no `user` parameter), and every query is built server-side inside `mcp/graph.mjs`, pinned to `owner = $user` (entity lookups) or the user's `:User` node (facts). A foreign or unknown entity name returns exactly the same "no entity" answer as a nonexistent one — there is nothing to enumerate. The brain is told in its prompt that the graph is this user's private world with no shared tier, so "what does Mila like?" asked by Roman gets "no stored information", and the queries make it impossible to answer otherwise. The prompt also requires the brain to phrase anything it says about the graph from the signed-in user's private view ("I have no record of you liking X", "I have no access to other users' facts") — never as a global claim about the whole graph ("no one likes X") — so a scoped answer is never misread as a statement about everyone's data.
- Ingestion keeps the invariant: entities are written `MERGE (e:Entity {name, type, owner: $user})` — one node per owner per entity — entities named after a registered user are dropped, and relation endpoints named after a registered user resolve to that user's `:User` node (the node is `MERGE`d if it does not exist yet), while entity endpoints resolve to the turn user's own copies (`owner: $user`) — so a fact about a user is stored *on* that user, and a fact between two of a user's entities stays inside their world.

**Chat turns can never write to the graph, and can never read another user's data.** Neo4j Community Edition has no roles or grants — RBAC (`CREATE ROLE`, `GRANT`) is Enterprise-only, and every Community user has implied admin privileges (verified on `5.26.31`: the server rejects `CREATE ROLE` with `UnsupportedAdministrationCommand`). So the guarantees are enforced by the MCP server and the application layer, not by the database:

1. The brain's graph MCP server is our own (`mcp/graph.mjs`, Node, stdio, spawned by the backend with the read-only `jarvis_read` credentials). It exposes the four parameterized read tools above and **no Cypher at all** — not even a read-Cypher tool. With no free-form query on the surface, a prompt-injected brain cannot run `CREATE`/`MERGE`/`DELETE` and cannot construct a query that reaches outside the injected user's scope: every query string lives in `mcp/graph.mjs`, is `MATCH`/`RETURN` only, and is pinned to the `user` argument the backend injects (a call without it fails, defense in depth).
2. The only write path is the backend's own turn ingestion, after the answer is already delivered: one cheap structured LLM call extracts entities and relations from the prompt, the web search results (if any) and the answer, and the result is sanitised (allowlisted entity types and relation types, capped counts, validated property keys, boolean negation flag) and upserted with `MERGE`/`SET` using the `jarvis_write` user — there is no `DELETE` anywhere in the ingestion code. A failed extraction is skipped, never a crash and never a partial write.

The `jarvis_read` and `jarvis_write` database users exist for credential separation (MCP/panel vs ingestion); Community Edition does not restrict what either user can do at the database level, so treat both passwords as write access to the graph.

**Panel.** The Knowledge graph panel below the Prompt/Answer panels (always visible, like the transcript) is display-only and scoped to the signed-in user: node/link counts, a live 3D view of the newest subgraph (the default — a continuously animating three.js force layout with drag-to-orbit, wheel zoom, click-to-re-centre, and labels projected over the canvas), plus a static 2D SVG toggle with the same click-to-re-centre behaviour. Every link carries its relation as a plain-word label in both views, with the negative form where the fact is negated (`LIKES` → likes, `LIKES` + negative → doesn't like, `LIVES_IN` → lives in — the label map is `public/relLabel.js`), so the graph reads like sentences together with the node labels (Mila —likes→ Lego); parallel edges on the same pair stack their labels. Only real facts are drawn, and the only nodes that can appear are the user's own `:User` node, the entities they own, and `:User` account markers at the endpoints of those edges — another user's entity is unreachable by construction (the panel queries match on `owner`). And only entities a visible fact edge touches are drawn at all — an entity the user merely owns (no fact links it in their world) is an isolated mention: kept in the database and in the brain's context, absent from the panel and the node/link counts, so a mention does not float in the 3D view. three.js is vendored locally (`public/vendor/three.module.min.js`, pinned `0.164.1`, no CDN at runtime) and the 3D view needs WebGL 2 — browsers without it fall back to the 2D view automatically (the 3D toggle is disabled). The schema and recent activity — the signed-in user's own brain reads and ingested turns, with a short tool/argument summary instead of raw Cypher (there is none on the brain's surface) — double as the audit trail that only reads ever come from the brain. The `:User` node is drawn larger, in the accent colour and labelled `(you)` — it is the only node of the signed-in user that can appear, so the account is never confused with anyone else's data. Endpoints: `GET /api/graph/status`, `/api/graph/subgraph?limit=&center=`, `/api/graph/schema`, `/api/graph/activity`, all read-only, session-gated like the other `/api` routes, and scoped to the session user.

**Running without a graph.** Leave the `NEO4J_*` variables in `.env` empty: the endpoints answer `503 graph_not_configured`, the panel shows "Not configured on this server", the brain is told the feature is off, and chat behaves exactly as before.

## Troubleshooting

**"I say the wake word and nothing happens."** Three causes have actually been observed, in
descending order of likelihood:

1. **The microphone never goes quiet.** A command is only submitted after the silence
   stop (default `SILENCE_MS`, 1.5 s; adjustable 100 ms-5 s with the Silence stop
   slider) of silence; if the room noise floor stays above the capture threshold
   (`0.012` in `public/audio.js`), recording runs to the 15-second cap instead, then
   uploads a window that is mostly noise and comes back empty. The **Listening for
   command** stage counts elapsed time and shows the live mic level while it waits, so
   watch those: if the level never falls near zero, lower the input gain or raise the
   threshold. (A longer silence stop helps only if the noise is bursty; a steady noise
   floor needs gain/threshold work.)
2. **Language mismatch.** `WHISPER_LANGUAGE` is `en`. German speech forced through the
   English model is mangled badly enough that the wake phrase no longer matches:
   *"Rocky, wie viel Uhr ist es?"* came back from the live service as
   *"Roki waivil ua ist iz."*, so the pipeline never starts. Speak the configured
    language, flip the **Language** switch (it sends the language with every probe),
    or change `WHISPER_LANGUAGE`.
3. **Saying the wake phrase alone** opens the two-step flow: a beep, then up to 10 s
   waiting for a separate command. Saying phrase and command in one breath
   ("Rocky, what time is it?") skips it.

**Phantom answers.** `large-v3` emits `"Thank you."`, `"Okay."` or `"You"` for
near-silence even with the VAD filter on, so those exact strings are filtered as
hallucinations alongside the ZDF/Amara subtitle artefacts. Without the filter, a silent
command window would send a phantom prompt to the brain.

Keep `WHISPER_VAD_FILTER=true`. It is what suppresses those hallucinations: with the
filter off, pure digital silence transcribes as `"Thank you."` every time. It does not
cost sensitivity, as speech 3% of full scale still transcribed correctly in testing.

## Runtime configuration

Copy `.env.example` to `.env` on the Docker host and set:

```env
PORT=8094
PUBLIC_BASE_PATH=/
USERS=Mila,Roman
WAKE_PHRASE=Hey Rocky
SILENCE_MS=1500
WHISPER_ENDPOINTS=https://voice.gpu-1-ch-dk-2.nwfp-nwt-cdc-it.csdc-nm.at/v1/audio/transcriptions
WHISPER_MODEL=Systran/faster-whisper-large-v3
WHISPER_LANGUAGE=en
WHISPER_VAD_FILTER=true
WHISPER_API_KEY=
BRAIN_BASE_URL=https://ds4-flash.gpu-2-de-fra-1-exo.csdc-nm.at/v1
BRAIN_MODEL=deepseek-v4-flash
BRAIN_API_KEY=
TTS_ENDPOINTS=https://voice.gpu-1-ch-dk-2.nwfp-nwt-cdc-it.csdc-nm.at/v1/audio/speech
TTS_MODEL=speaches-ai/Kokoro-82M-v1.0-ONNX
TTS_VOICE=bm_george
TTS_API_KEY=
# Knowledge graph (optional; leave empty to run without the graph — see
# "Knowledge graph (Neo4j)"):
NEO4J_URI=bolt://neo4j:7687
NEO4J_DATABASE=neo4j
NEO4J_READ_USER=jarvis_read
NEO4J_READ_PASSWORD=
NEO4J_WRITE_USER=jarvis_write
NEO4J_WRITE_PASSWORD=
NEO4J_ADMIN_PASSWORD=
NEO4J_MCP_URI=bolt://neo4j:7687
NEO4J_MCP_DATABASE=neo4j
NEO4J_MCP_USERNAME=jarvis_read
NEO4J_MCP_PASSWORD=
```

`USERS` lists the login accounts (comma-separated); each one signs in with its own name as the password (see Login (multi-user)).

Multiple Whisper endpoints are comma-separated and are tried round-robin with failover.
`WHISPER_API_KEY` and `TTS_API_KEY` are sent as bearer tokens to the voice services and never reach the browser; leave them empty for a no-auth endpoint.
Leave `BRAIN_API_KEY` empty for a no-auth self-hosted OpenAI-compatible endpoint, or set it on the host if the brain requires bearer auth.

## Local run

```bash
node server.js
```

Open <http://127.0.0.1:8094>.

## Docker run

```bash
docker compose up -d --build
```

The compose file binds `192.168.54.111:8094` for vm104. Live STT and TTS use the gpu-1 voice service configured in `WHISPER_ENDPOINTS` and `TTS_ENDPOINTS` (see `DEPLOYMENT.md`). It also starts the `neo4j` knowledge-graph database (pinned `neo4j:5.26.31-community`, APOC plugin, capped heap, no published ports) — see "Knowledge graph (Neo4j)"; leave the `NEO4J_*` variables empty to run without a graph.

## Regression tests

Requires Node 20+ (20.3+ for `AbortSignal.any`) and Chromium's system libraries.
The browser builds themselves download for any user, but on a minimal Debian 12
container Chromium fails to launch with `libglib-2.0.so.0: cannot open shared
object file` — the ~20 shared libraries it links against (glib, nss, atk, cairo,
cups, gbm, alsa, pango, the X11/xcb set, xkbcommon) must be installed **as
root**:

```bash
npm ci
npm test
sudo npx playwright install --with-deps --no-shell chromium
npm run test:browser
```

If `--with-deps` is unavailable, the Debian 12 (bookworm) package list is:
`libglib2.0-0 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libgbm1 libasound2 libpango-1.0-0 libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libxcb1 libxkbcommon0`.
Verify with `ldd ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome | grep "not found"` — it must print nothing.

Browser tests use actual Chromium microphone capture and the production AudioWorklet/WAV encoder with synthetic audio. STT/brain responses and TTS callbacks are controlled for lifecycle tests; they are not proof of physical microphone or speaker quality. Because the fixture microphone keeps playing a tone, tests that let the answer speak for real (self-hosted TTS or the TTS watchdog) cap the wake phrase at the first two transcribe calls — the speech wake-watch probes the mic while speaking and would otherwise interrupt the speech under test. `tests/voice.test.mjs` covers clause splitting, character-profile delivery, HAL playback sequencing, the German browser-voice picker, the voice stop-command matcher, the post-speech stop window and the plain-language TTS sanitizer against Web Audio stubs; `tests/visualizer.test.mjs` covers the waveform ring geometry, spectrum mapping and smoothing; `tests/mcp.test.mjs` covers the MCP web-search server's protocol (initialize, tools/list, tools/call) and the pure search-engine helpers (redirect unwrapping, ad filtering, dedupe merging, result formatting) without touching the network; actual playback is covered by the Chromium tests. `tests/mcp-graph.test.mjs` pins that every MCP graph query is owner-scoped (entity lookups match `owner: $user`, links only to `:User` markers or the user's own entities, no unscoped match) plus the pure result formatting; `tests/graph.test.mjs` covers the knowledge-graph pipeline: extraction parsing and sanitising (including the negation flag), the owner-only brain context (no shared tier), the in-memory store (including the single-user-node behaviour: the signed-in user is one node, relations named after it target the `:User` node, no self-edges; the negation flag flipping an existing edge in place; and owner-keyed isolation: two users mentioning the same entity get two separate nodes, a fact one user states about the other lands on the other's type-less account marker and never on a person entity, and no other user's entity ever crosses into the panel), mock-driver pins for valid Cypher relationship patterns, integer `LIMIT` parameters, the owner-keyed entity `MERGE` (no `KNOWS`, no `common`), the owner-scoped relation endpoints, the `SET r.negative` upsert and the owner-scoped panel subgraph (centre must be own node or owned entity, neighbours are owned entities or `:User` markers, user-to-user edges limited to their parties), the unconfigured 503s, and — against a real HTTP backend with the stdio MCP server mocked (`tests/mock-graph-mcp.mjs`) — the full configured brain tool loop (context injection, the data-model cheat-sheet in the system prompt, `get-schema`/`read-cypher` calls, the five-round tool budget with forced final answer, write-Cypher rejection) plus post-turn ingestion; `tests/graph.browser.mjs` covers the Knowledge graph panel: the 3D view as default (animated scene, the signed-in user's `:User` node labelled `(you)`, link labels with the relation in plain words including the negative form, no `KNOWS` edge, live data updates on refresh, label click-to-re-centre), the 2D SVG render and click-to-re-centre (link labels included, parallel edges on one pair both labelled, negated edges read as "doesn't use"), the automatic 2D fallback when WebGL is unavailable, and the unconfigured status line.

`wake probes end in silence rather than cutting a word in half` is a property test: it
asserts every uploaded probe window has a near-silent tail, which is what keeps the
trailing-edge trigger from regressing into mid-word cuts.

Three wake-word tests (`personal wake word is saved...`, `invalid personal wake
words...`, `blocked local storage...`) fail in containers without Chromium's system
libraries, where `page.fill` on `#wakeWordInput` does not take effect and the renderer is
unstable. They fail identically on unmodified `main`, so treat a failure there as an
environment signal, not a regression; verify on a host where
`npx playwright install --with-deps` has run.

Optional live vm103 speech test (supply a WAV saying "Rocky, what time is it?" followed by five seconds of silence; Chromium loops the fixture):

```bash
JARVIS_LIVE_STT_ENDPOINT=http://192.168.53.111:8003/v1/audio/transcriptions \
JARVIS_TEST_LANGUAGE=en JARVIS_SPEECH_FIXTURE=/absolute/path/speech.wav \
node --test --test-name-pattern='actual vm103' tests/pipeline.browser.mjs
```

To exercise an isolated deployment through its actual backend, Whisper and brain (only headless TTS playback is simulated):

```bash
JARVIS_LIVE_BACKEND=http://127.0.0.1:18095 \
JARVIS_SPEECH_FIXTURE=/absolute/path/speech.wav \
node --test --test-name-pattern='candidate backend' tests/pipeline.browser.mjs
```

Use a localhost tunnel or HTTPS origin for microphone access. These opt-in checks send the fixture audio and prompt to the configured services.
