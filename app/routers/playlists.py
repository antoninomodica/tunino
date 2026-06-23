import os
import uuid
import aiofiles
from pathlib import Path
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Playlist, Track, PlaylistItem
from ..schemas import PlaylistOut, PlaylistCreate, PlaylistUpdate, AddTrackRequest, ReorderRequest
from ..scraper import scrape_bandcamp_url

router = APIRouter(prefix="/api/playlists", tags=["playlists"])

UPLOADS_DIR = Path(__file__).parent.parent.parent / "uploads"


@router.get("", response_model=list[PlaylistOut])
def list_playlists(db: Session = Depends(get_db)):
    return db.query(Playlist).order_by(Playlist.created_at.desc()).all()


@router.post("", response_model=PlaylistOut, status_code=201)
def create_playlist(body: PlaylistCreate, db: Session = Depends(get_db)):
    pl = Playlist(name=body.name, bg_color=body.bg_color)
    db.add(pl)
    db.commit()
    db.refresh(pl)
    return pl


@router.get("/{playlist_id}", response_model=PlaylistOut)
def get_playlist(playlist_id: int, db: Session = Depends(get_db)):
    pl = db.get(Playlist, playlist_id)
    if not pl:
        raise HTTPException(404, "Playlist not found")
    return pl


@router.patch("/{playlist_id}", response_model=PlaylistOut)
def update_playlist(playlist_id: int, body: PlaylistUpdate, db: Session = Depends(get_db)):
    pl = db.get(Playlist, playlist_id)
    if not pl:
        raise HTTPException(404, "Playlist not found")
    if body.name is not None:
        pl.name = body.name
    if body.bg_color is not None:
        pl.bg_color = body.bg_color
    db.commit()
    db.refresh(pl)
    return pl


@router.post("/{playlist_id}/cover", response_model=PlaylistOut)
async def upload_cover(
    playlist_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    pl = db.get(Playlist, playlist_id)
    if not pl:
        raise HTTPException(404, "Playlist not found")

    ext = os.path.splitext(file.filename or "")[1].lower() or ".jpg"
    if ext not in {".jpg", ".jpeg", ".png", ".webp", ".gif"}:
        raise HTTPException(400, "Unsupported image type")

    filename = f"{uuid.uuid4().hex}{ext}"
    path = UPLOADS_DIR / filename
    UPLOADS_DIR.mkdir(exist_ok=True)

    async with aiofiles.open(path, "wb") as f:
        content = await file.read()
        await f.write(content)

    # Remove old cover file if it exists
    if pl.cover_image:
        old_path = UPLOADS_DIR / pl.cover_image
        if old_path.exists():
            old_path.unlink()

    pl.cover_image = filename
    db.commit()
    db.refresh(pl)
    return pl


@router.delete("/{playlist_id}", status_code=204)
def delete_playlist(playlist_id: int, db: Session = Depends(get_db)):
    pl = db.get(Playlist, playlist_id)
    if not pl:
        raise HTTPException(404, "Playlist not found")
    db.delete(pl)
    db.commit()


@router.post("/{playlist_id}/tracks", response_model=PlaylistOut)
async def add_tracks(playlist_id: int, body: AddTrackRequest, db: Session = Depends(get_db)):
    pl = db.get(Playlist, playlist_id)
    if not pl:
        raise HTTPException(404, "Playlist not found")

    try:
        scraped = await scrape_bandcamp_url(body.url)
    except Exception as e:
        raise HTTPException(400, str(e))

    next_pos = max((item.position for item in pl.items), default=-1) + 1

    for t_data in scraped:
        track = Track(
            bandcamp_url=t_data["bandcamp_url"],
            title=t_data["title"],
            artist=t_data["artist"],
            album=t_data["album"],
            artwork_url=t_data["artwork_url"],
            audio_url=t_data["audio_url"],
            audio_url_fetched_at=datetime.utcnow(),
            duration=t_data["duration"],
        )
        db.add(track)
        db.flush()
        item = PlaylistItem(playlist_id=playlist_id, track_id=track.id, position=next_pos)
        db.add(item)
        next_pos += 1

    db.commit()
    db.refresh(pl)
    return pl


@router.delete("/{playlist_id}/tracks/{item_id}", response_model=PlaylistOut)
def remove_track(playlist_id: int, item_id: int, db: Session = Depends(get_db)):
    item = db.query(PlaylistItem).filter_by(id=item_id, playlist_id=playlist_id).first()
    if not item:
        raise HTTPException(404, "Item not found")
    db.delete(item)
    db.commit()
    pl = db.get(Playlist, playlist_id)
    db.refresh(pl)
    return pl


@router.put("/{playlist_id}/reorder", response_model=PlaylistOut)
def reorder_tracks(playlist_id: int, body: ReorderRequest, db: Session = Depends(get_db)):
    pl = db.get(Playlist, playlist_id)
    if not pl:
        raise HTTPException(404, "Playlist not found")

    items_by_id = {item.id: item for item in pl.items}
    for pos, item_id in enumerate(body.item_ids):
        if item_id in items_by_id:
            items_by_id[item_id].position = pos

    db.commit()
    db.refresh(pl)
    return pl
