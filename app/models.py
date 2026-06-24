from sqlalchemy import Column, Integer, String, Float, ForeignKey, DateTime
from sqlalchemy.orm import relationship
from datetime import datetime
from .database import Base


class Playlist(Base):
    __tablename__ = "playlists"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    bg_color = Column(String, default="#1a1a2e")
    cover_image = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    items = relationship(
        "PlaylistItem",
        back_populates="playlist",
        order_by="PlaylistItem.position",
        cascade="all, delete-orphan",
    )


class Track(Base):
    __tablename__ = "tracks"

    id = Column(Integer, primary_key=True, index=True)
    bandcamp_url = Column(String, nullable=False)
    title = Column(String, nullable=False)
    artist = Column(String, nullable=False)
    album = Column(String, default="")
    artwork_url = Column(String, default="")
    audio_url = Column(String, nullable=False)
    audio_url_fetched_at = Column(DateTime, default=datetime.utcnow)
    duration = Column(Float, default=0)
    bpm = Column(Float, nullable=True)
    bpm_status = Column(String, default="pending")  # pending | done | failed

    playlist_items = relationship("PlaylistItem", back_populates="track")


class PlaylistItem(Base):
    __tablename__ = "playlist_items"

    id = Column(Integer, primary_key=True, index=True)
    playlist_id = Column(Integer, ForeignKey("playlists.id"), nullable=False)
    track_id = Column(Integer, ForeignKey("tracks.id"), nullable=False)
    position = Column(Integer, nullable=False, default=0)

    playlist = relationship("Playlist", back_populates="items")
    track = relationship("Track", back_populates="playlist_items")
