import io
import logging
import tempfile
import asyncio
from pathlib import Path

import httpx
import numpy as np

from .database import SessionLocal
from .models import Track

logger = logging.getLogger(__name__)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
}

# Download only the first N bytes (~30s of mp3-128 ≈ 480 KB)
DOWNLOAD_BYTES = 500_000


async def _download_partial(url: str) -> bytes:
    async with httpx.AsyncClient(follow_redirects=True, timeout=30) as client:
        headers = {**HEADERS, "Range": f"bytes=0-{DOWNLOAD_BYTES - 1}"}
        r = await client.get(url, headers=headers)
        # 206 Partial Content or 200 OK both fine
        r.raise_for_status()
        return r.content


def _detect_bpm(audio_bytes: bytes) -> float:
    import librosa

    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
        f.write(audio_bytes)
        tmp_path = f.name

    try:
        y, sr = librosa.load(tmp_path, sr=None, mono=True, duration=30)
        tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        # librosa may return an array; take the scalar
        bpm = float(np.atleast_1d(tempo)[0])
        return round(bpm, 1)
    finally:
        Path(tmp_path).unlink(missing_ok=True)


async def analyse_track_bpm(track_id: int, audio_url: str) -> None:
    """Download a partial audio clip and store BPM on the track record."""
    db = SessionLocal()
    try:
        audio_bytes = await _download_partial(audio_url)
        # Run the CPU-bound librosa work in a thread so we don't block the event loop
        bpm = await asyncio.get_event_loop().run_in_executor(None, _detect_bpm, audio_bytes)

        track = db.get(Track, track_id)
        if track:
            track.bpm = bpm
            track.bpm_status = "done"
            db.commit()
        logger.info("BPM analysis done for track %d: %.1f BPM", track_id, bpm)
    except Exception as exc:
        logger.warning("BPM analysis failed for track %d: %s", track_id, exc)
        track = db.get(Track, track_id)
        if track:
            track.bpm_status = "failed"
            db.commit()
    finally:
        db.close()
