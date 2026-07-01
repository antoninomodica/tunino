from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..database import get_db
from ..models import Playlist, PlaylistItem, Track, User
from ..scraper import refresh_audio_url, AUDIO_URL_MAX_AGE_SECONDS

router = APIRouter(prefix="/api/tracks", tags=["tracks"])


@router.get("/{track_id}/stream-url")
async def get_stream_url(track_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """
    Return the track's audio URL, refreshing it if it's stale.
    The client calls this just before playback to get a fresh URL.
    """
    track = (
        db.query(Track)
        .join(PlaylistItem)
        .join(Playlist)
        .filter(Track.id == track_id, Playlist.owner_id == user.id)
        .first()
    )
    if not track:
        raise HTTPException(404, "Track not found")

    age = (datetime.utcnow() - track.audio_url_fetched_at).total_seconds()
    if age > AUDIO_URL_MAX_AGE_SECONDS:
        fresh_url = await refresh_audio_url(track.bandcamp_url, track.title)
        if fresh_url:
            track.audio_url = fresh_url
            track.audio_url_fetched_at = datetime.utcnow()
            db.commit()

    return {"url": track.audio_url, "track_id": track_id}
