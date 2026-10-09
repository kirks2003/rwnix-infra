Hier ist eine detaillierte Aufschlüsselung der drei selbst-gehosteten Optionen, einschließlich VRAM-Anforderungen:

---

## 1️⃣ StockSense — `upamanyu92/stocksense`

**Was es ist:** Komplette KI-gestützte Aktienvorhersage-Plattform mit Flask-Weboberfläche, Echtzeit-WebSocket-Updates, automatischen Benachrichtigungen und einem Ensemble aus ML-Modellen + LLM.

**LLM:** **phi-mini** (Microsoft Phi-4 Mini, 3,8 Mrd. Parameter) via Ollama

**VRAM:**
| Quantisierung | Größe | Min. GPU |
|---|---|---|
| Q4_K_M (Standard) | ~2,3–3 GB | **Jede 4-GB-GPU** (GTX 1650, etc.) |
| Q8_0 | ~4 GB | 6-GB-GPU |

→ Läuft sogar auf einem Raspberry Pi mit 8 GB RAM (CPU-only, langsam)

**Features:**
- Fertiges Dashboard (localhost:5005)
- Ensemble-ML-Modelle + LLM-Kommentar
- Selbstlernend (Fehlerkorrektur)
- Docker-Compose fertig (`docker-compose up`)
- Bewertungs-Agenten für Vorhersagequalität

**Am besten für:** Du willst eine **fertige Lösung** mit UI, die sofort läuft.

---

## 2️⃣ AI Stock Advisor — `sarkarj/AI_StockAdvisor_ollama_llama3.2`

**Was es ist:** Streamlit-App, die Echtzeit-Aktiendaten via yfinance holt, technische Indikatoren (EMA, Bollinger Bänder) berechnet und via Ollama/llama3.2 natürlichsprachliche Analysen generiert.

**LLM:** **llama3.2** (1B, 3B oder 8B) via Ollama

**VRAM:**
| Modell | Quantisierung | Größe | Min. GPU |
|---|---|---|---|
| llama3.2 1B | Q8_0 | ~1,5 GB | **Jede 4-GB-GPU** |
| llama3.2 3B | Q4_K_M | ~2,5 GB | **Jede 4-GB-GPU** |
| llama3.2 8B | Q4_K_M | ~4,9 GB | **8-GB-GPU** (z. B. RTX 3060) |

**Features:**
- Streamlit-UI (Port 8501)
- Einfacher, überschaubarer Code (~5 Python-Dateien)
- Docker-Container
- Technische Indikatoren + LLM-Kommentar

**Am besten für:** Du willst etwas **Einfaches, Leichtes** und kannst selbst anpassen.

---

## 3️⃣ Time Series Forecast Agents — `vikrambhat2/timeseries_forecast_agents`

**Was es ist:** Multi-Agenten-Pipeline mit LangGraph, die traditionelle Prognose (Prophet) mit LLM-basierter Vorhersage vergleicht und bewertet (RMSE, MAE, SMAPE). Eher ein Framework/Experiment als eine fertige App.

**LLM:** **LLaMA 3.2** (3B/8B) oder **LLaMA 3.3 70B** via Ollama

**VRAM:**
| Modell | Quantisierung | Größe | Min. GPU |
|---|---|---|---|
| llama3.2 3B | Q4_K_M | ~2,5 GB | **4-GB-GPU** |
| llama3.2 8B | Q4_K_M | ~4,9 GB | **8-GB-GPU** |
| **llama3.3 70B** | Q4_K_M | **~40 GB** | **48 GB oder 2× 24 GB** (z. B. 2× RTX 3090/4090) |
| llama3.3 70B | Q3_K_S | ~31 GB | 32-GB-GPU (RTX 5090) |

**Features:**
- LangGraph-Pipeline (modular, erweiterbar)
- Prophet (traditionell) vs. LLM-Vorhersage
- Metriken: RMSE, MAE, SMAPE
- LLM erklärt, welches Modell besser war und warum
- Keine UI (Kommandozeile)

**Am besten für:** Du willst **traditionelle vs. KI-Prognosen vergleichen** oder ein **Forschungsexperiment** aufsetzen.

---

## 📊 Zusammenfassung VRAM-Vergleich

| Projekt | LLM | Min. VRAM | Empfohlen | Ideal für |
|---|---|---|---|---|
| **StockSense** | phi-mini (3,8B) | **4 GB** | 8 GB | Fertige Plattform |
| **AI Stock Advisor** | llama3.2 (1B–8B) | **4 GB** | 8–12 GB | Einfach & anpassbar |
| **Time Series Agents** | llama3.2/3.3 (3B–70B) | **4 GB** (3B) – **48 GB** (70B) | 12–24 GB | Forschung/Vergleich |

---

**Meine Empfehlung für dich, Roman:** Da du ASML.AS und Aktien verfolgst, starte mit **StockSense** (phi-mini, nur ~3 GB VRAM, Docker, fertiges Dashboard) oder dem **AI Stock Advisor** (llama3.2 3B, ~2,5 GB, einfacher Code). Beide laufen auf so gut wie jeder GPU mit 4+ GB.

Soll ich eines der GitHub-Repos für dich öffnen oder ein Vikunja-Task zum Ausprobieren anlegen?

---

## Deployment results — StockSense live (2026-10-09)

> **Hinweis:** Die ganze StockSense-Stack wurde am 2026-10-09 wieder
> entfernt (hat nicht wie erwartet funktioniert). Alles unten ist der
> Mess-/Findings-Record. Details: `stocksense.md`.

StockSense ist deployed: App auf **vm104** (`http://192.168.54.111:5005` LAN-only,
plus `stocksense.gw-1-nbg-1-de-netcup.rwnix.net` / `stocksense.gw-1-vie-1-at-netcup.rwnix.net`
hinter Authelia 2FA + Basic Auth), LLM auf **gpu-1** (Ollama,
`phi4-mini:3.8b-q8_0` — der korrekte Ollama-Bibliotheksname; `phi-mini` in
OLLAMA.md ist falsch). Voller Deployment-Record, Topologie, Secret-Orte und Rollback:
**`stocksense.md`**.

Messwerte und Stolpersteine aus dem Live-Deployment:

| | Doc-Schätzung | gemessen |
|---|---|---|
| VRAM (phi4-mini) | Q4 ~2,3–3 GB / Q8 ~4 GB | **~5,7 GB** resident (q8_0, `KEEP_ALIVE=24h`) |
| Host-Freigabe | "4-GB-GPU reicht" | gpu-1: 26,5 GB frei beim Deploy → ~22 GB Rest danach |
| LLM-Latenz | "10-30 sec" | **~12 s** pro kompletter agentischer Vorhersage (2 LLM-Submodelle + Ensemble) |
| Host-Entscheidung | — | **gpu-1**, nicht gpu-2: beide 96-GB-GPUs von gpu-2 sind zu 100 % VRAM-reserviert durch den `ds4-flash`-vLLM (Jarvis-Brain) |

Stolpersteine (alle in `stocksense.md` dokumentiert):

- **Ollama vram-based default context**: ohne `OLLAMA_CONTEXT_LENGTH` dimensioniert
  Ollama den Default-Context aus der *gesamten* GPU-VRAM (hier 128K) und hat für
  das 4,1-GB-Modell eine **~16-GB-KV-Cache** allozierte. `OLLAMA_CONTEXT_LENGTH=8192`
  behebt es. Auf jeder großen GPU immer setzen.
- **Upstream-Import-Crash**: `gemini_config.py` parst sechs `GEMINI_*`-Zahlen bei
  Class-Definition und der Legacy-Pfad wird immer noch importiert — ohne diese
  Env-Vars crash-loopt der Container, obwohl Gemini ungenutzt ist.
- **Phantom `model_monitor`-Service**: `scripts/model_monitor_scheduler.py` existiert
  upstream nicht, und der Dockerfile-Entrypoint läuft `app.main` bedingungslos —
  der "Monitor"-Container lief einfach eine doppelte Flask-App. Aus unserem Compose entfernt.
- **Cert-Renewal-Lücke gpu-1 (gefixt)**: das manuelle `npm-voice`-LE-Zertifikat wurde
  nie erneuert (außerhalb der NPM-DB); ein täglicher `certbot renew`-Cron deckt es jetzt ab.
- **Selbstabhängigkeits-Vorsicht**: der Qwen-27B-llama.cpp-Server auf gpu-1 betreibt
  auch die kandev-Agent-Sessions — alles, was diesen Container oder seinen NPM-Host
  antippt, bricht die Agenten mitten in der Aufgabe ab (Guardrail-Hinweis im ollama-Compose).