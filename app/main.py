from pathlib import Path
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from sqlalchemy import text
from .database import engine, Base
from .routers import playlists, tracks

Base.metadata.create_all(bind=engine)

# Add BPM columns to existing databases that predate this feature.
# Existing rows get bpm_status='unanalysed' so they don't show a
# pending spinner — the user can trigger analysis manually.
with engine.connect() as conn:
    existing = {row[1] for row in conn.execute(text("PRAGMA table_info(tracks)"))}
    if "bpm" not in existing:
        conn.execute(text("ALTER TABLE tracks ADD COLUMN bpm REAL"))
    if "bpm_status" not in existing:
        conn.execute(text("ALTER TABLE tracks ADD COLUMN bpm_status TEXT DEFAULT 'unanalysed'"))
    conn.commit()

app = FastAPI(title="Tunino")

app.include_router(playlists.router)
app.include_router(tracks.router)

ROOT = Path(__file__).parent.parent
UPLOADS_DIR = ROOT / "uploads"
STATIC_DIR = ROOT / "static"

UPLOADS_DIR.mkdir(exist_ok=True)

app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/{full_path:path}", include_in_schema=False)
async def spa_fallback(full_path: str):
    return FileResponse(str(STATIC_DIR / "index.html"))
