from pathlib import Path
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from .database import engine, Base
from .routers import playlists, tracks

Base.metadata.create_all(bind=engine)

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
