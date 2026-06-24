import httpx
import json
import re
from bs4 import BeautifulSoup
from urllib.parse import urlparse

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}

AUDIO_URL_MAX_AGE_SECONDS = 7200  # re-scrape after 2 hours


def _extract_json_object(text: str, marker: str) -> dict | None:
    """Find marker in text, then extract the complete JSON object that follows."""
    pos = text.find(marker)
    if pos == -1:
        return None
    start = text.find("{", pos + len(marker))
    if start == -1:
        return None

    depth = 0
    in_string = False
    escape_next = False

    for i, ch in enumerate(text[start:], start):
        if escape_next:
            escape_next = False
            continue
        if ch == "\\" and in_string:
            escape_next = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if not in_string:
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start : i + 1])
                    except json.JSONDecodeError:
                        return None
    return None


async def scrape_bandcamp_url(url: str) -> list[dict]:
    """
    Fetch a Bandcamp track or album page and return a list of track dicts.
    Each dict: title, artist, album, artwork_url, audio_url, duration, bandcamp_url
    """
    async with httpx.AsyncClient(follow_redirects=True, timeout=30) as client:
        resp = await client.get(url, headers=HEADERS)
        resp.raise_for_status()

    soup = BeautifulSoup(resp.text, "html.parser")
    page_text = resp.text

    # TralbumData is injected as a JS variable in a <script> tag
    tralbum: dict | None = None
    for script in soup.find_all("script"):
        content = script.string or ""
        if "TralbumData" in content:
            tralbum = _extract_json_object(content, "TralbumData")
            if tralbum:
                break

    # Fallback: data-tralbum attribute (older pages)
    if not tralbum:
        el = soup.find(attrs={"data-tralbum": True})
        if el:
            try:
                tralbum = json.loads(el["data-tralbum"])
            except (json.JSONDecodeError, KeyError):
                pass

    if not tralbum:
        raise ValueError(
            "Could not find track data on this page. "
            "Make sure the URL points to a Bandcamp track or album."
        )

    artist = tralbum.get("artist", "Unknown Artist")
    current = tralbum.get("current", {})
    album_title = current.get("title", "")

    # Artwork: prefer the large image from the page
    artwork_url = ""
    art_el = soup.find("div", class_="tralbumArt") or soup.find("div", id="tralbumArt")
    if art_el:
        img = art_el.find("img")
        if img:
            artwork_url = img.get("src", "")
    if not artwork_url:
        # Try og:image meta tag
        og = soup.find("meta", property="og:image")
        if og:
            artwork_url = og.get("content", "")

    parsed_base = urlparse(url)
    base_origin = f"{parsed_base.scheme}://{parsed_base.netloc}"

    tracks = []
    for info in tralbum.get("trackinfo", []):
        audio_file = info.get("file") or {}
        audio_url = audio_file.get("mp3-128") or audio_file.get("mp3-v0") or audio_file.get("mp3-v2")
        if not audio_url:
            # Track may be pre-order / not streaming
            continue

        title_link = info.get("title_link", "")
        if title_link and not title_link.startswith("http"):
            title_link = base_origin + title_link

        tracks.append(
            {
                "title": info.get("title", "Untitled"),
                "artist": artist,
                "album": album_title,
                "artwork_url": artwork_url,
                "audio_url": audio_url,
                "duration": float(info.get("duration") or 0),
                "bandcamp_url": title_link or url,
            }
        )

    if not tracks:
        raise ValueError(
            "No streamable tracks found. The release may not be available for streaming."
        )

    return tracks


async def scrape_recommendations(bandcamp_url: str) -> list[dict]:
    """
    Scrape the 'If you like X, you may also like:' section from a Bandcamp page.
    Returns a list of dicts with keys: title, artist, artwork_url, url.
    """
    async with httpx.AsyncClient(follow_redirects=True, timeout=30) as client:
        resp = await client.get(bandcamp_url, headers=HEADERS)
        resp.raise_for_status()

    soup = BeautifulSoup(resp.text, "html.parser")
    results = []
    seen_urls = set()

    for item in soup.find_all("li", class_="recommended-album"):
        title = item.get("data-albumtitle", "").strip()
        artist = item.get("data-artist", "").strip()
        if not title:
            continue

        link = item.find("a", href=True)
        if not link:
            continue
        # Strip tracking query params from the URL
        raw_url = link["href"]
        url = raw_url.split("?")[0]
        if url in seen_urls:
            continue
        seen_urls.add(url)

        img = item.find("img")
        artwork_url = img.get("src", "") if img else ""

        audio_url = ""
        raw_audio = item.get("data-audiourl", "")
        if raw_audio:
            try:
                audio_data = json.loads(raw_audio)
                audio_url = audio_data.get("mp3-128") or audio_data.get("mp3-v0") or ""
            except (json.JSONDecodeError, AttributeError):
                pass

        track_id = item.get("data-trackid", "")

        results.append({"title": title, "artist": artist, "artwork_url": artwork_url, "url": url, "audio_url": audio_url, "bandcamp_track_id": track_id})

    return results


async def refresh_audio_url(bandcamp_url: str, track_title: str) -> str | None:
    """Re-scrape a track page and return the fresh audio URL, matched by title."""
    try:
        tracks = await scrape_bandcamp_url(bandcamp_url)
    except Exception:
        return None

    if not tracks:
        return None

    # For single-track pages there's only one result
    if len(tracks) == 1:
        return tracks[0]["audio_url"]

    # For album pages, match by title
    for t in tracks:
        if t["title"].lower() == track_title.lower():
            return t["audio_url"]

    return tracks[0]["audio_url"]
