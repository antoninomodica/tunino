import asyncio
import logging
import subprocess
import tempfile
from pathlib import Path

import httpx

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

# Download only the first ~30s (mp3-128 ≈ 480 KB/30s)
DOWNLOAD_BYTES = 500_000

# Allow only one analysis at a time to avoid memory spikes on the Pi
_semaphore = asyncio.Semaphore(1)


def _check_ffmpeg() -> bool:
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True)
        return True
    except (FileNotFoundError, subprocess.CalledProcessError):
        return False


async def _download_partial(url: str) -> bytes:
    async with httpx.AsyncClient(follow_redirects=True, timeout=30) as client:
        r = await client.get(url, headers={**HEADERS, "Range": f"bytes=0-{DOWNLOAD_BYTES - 1}"})
        r.raise_for_status()
        return r.content


def _detect_bpm(mp3_bytes: bytes) -> float:
    import librosa
    import numpy as np

    with tempfile.TemporaryDirectory() as tmp_dir:
        mp3_path = Path(tmp_dir) / "audio.mp3"
        mp3_path.write_bytes(mp3_bytes)

        # librosa needs ffmpeg to decode mp3; sr=22050 is faster than native rate
        y, sr = librosa.load(str(mp3_path), sr=22050, mono=True, duration=30)
        tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        bpm = float(np.atleast_1d(tempo)[0])
        return round(bpm, 1)


async def analyse_track_bpm(track_id: int, audio_url: str) -> None:
    """Download a partial audio clip and detect BPM, serialised via semaphore."""
    async with _semaphore:
        db = SessionLocal()
        try:
            audio_bytes = await _download_partial(audio_url)
            loop = asyncio.get_event_loop()
            bpm = await loop.run_in_executor(None, _detect_bpm, audio_bytes)

            track = db.get(Track, track_id)
            if track:
                track.bpm = bpm
                track.bpm_status = "done"
                db.commit()
            logger.info("BPM for track %d: %.1f", track_id, bpm)
        except Exception as exc:
            logger.warning("BPM analysis failed for track %d: %s", track_id, exc)
            track = db.get(Track, track_id)
            if track:
                track.bpm_status = "failed"
                db.commit()
        finally:
            db.close()
