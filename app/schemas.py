from pydantic import BaseModel
from datetime import datetime
from typing import Optional


class TrackOut(BaseModel):
    id: int
    bandcamp_url: str
    title: str
    artist: str
    album: str
    artwork_url: str
    duration: float
    audio_url_fetched_at: datetime

    model_config = {"from_attributes": True}


class PlaylistItemOut(BaseModel):
    id: int
    position: int
    track: TrackOut

    model_config = {"from_attributes": True}


class PlaylistOut(BaseModel):
    id: int
    name: str
    bg_color: str
    cover_image: Optional[str]
    created_at: datetime
    items: list[PlaylistItemOut] = []

    model_config = {"from_attributes": True}


class PlaylistCreate(BaseModel):
    name: str
    bg_color: str = "#1a1a2e"


class PlaylistUpdate(BaseModel):
    name: Optional[str] = None
    bg_color: Optional[str] = None


class AddTrackRequest(BaseModel):
    url: str

class AddSingleTrackRequest(BaseModel):
    url: str
    bandcamp_track_id: str


class ReorderRequest(BaseModel):
    item_ids: list[int]
