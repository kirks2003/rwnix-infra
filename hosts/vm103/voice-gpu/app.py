import io, subprocess, tempfile, os
from fastapi import FastAPI, UploadFile, Form
import httpx

app = FastAPI()
WS = "http://host.docker.internal:8002/inference"

@app.post("/v1/audio/transcriptions")
async def transcribe(file: UploadFile, model: str = Form(""), language: str = Form("")):
    data = await file.read()
    # Whisper.cpp server decodes wav/ogg/mp3/flac reliably, but NOT webm/opus
    # (what the browser's MediaRecorder produces). Transcode everything to
    # 16k mono WAV with ffmpeg before forwarding.
    wav = None
    tmppath = None
    try:
        tmppath = "/tmp/in_" + os.path.splitext(file.filename or "a")[1]
        with open(tmppath, "wb") as f:
            f.write(data)
        p = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", tmppath, "-ar", "16000", "-ac", "1",
             "-f", "wav", "pipe:1"],
            capture_output=True)
        if p.returncode != 0:
            return {"text": ""}
        wav = p.stdout
    finally:
        if tmppath and os.path.exists(tmppath):
            os.remove(tmppath)
    params = {}
    if language and language != "auto":
        params["language"] = language
    async with httpx.AsyncClient(timeout=120) as c:
        r = await c.post(WS, files={"file": ("recording.wav", wav, "audio/wav")}, params=params)
    try:
        return r.json()
    except Exception:
        return {"text": ""}

@app.get("/health")
async def health():
    return {"ok": True}
