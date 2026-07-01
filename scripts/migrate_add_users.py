#!/usr/bin/env python3
"""
One-off migration: add the users/sessions tables and an owner_id column on
playlists, then assign all existing playlists to a chosen owner account.

Back up tunino.db before running (e.g. `cp tunino.db tunino.db.bak`).
Safe to re-run — every step is a no-op if already applied.
"""
import getpass
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from sqlalchemy import text

from app.auth import hash_password
from app.database import Base, SessionLocal, engine
from app.models import Playlist, User  # noqa: F401 (registers models with Base)


def ensure_owner_id_column():
    with engine.begin() as conn:
        cols = [row[1] for row in conn.execute(text("PRAGMA table_info(playlists)"))]
        if "owner_id" not in cols:
            conn.execute(text("ALTER TABLE playlists ADD COLUMN owner_id INTEGER REFERENCES users(id)"))
            print("Added playlists.owner_id column.")
        else:
            print("playlists.owner_id already exists, skipping.")


def get_or_create_owner(db) -> User:
    existing = db.query(User).filter(User.is_admin == True).first()  # noqa: E712
    if existing:
        print(f"Using existing admin user '{existing.username}' as owner.")
        return existing

    print("No admin user found — create the owner account.")
    username = input("Username: ").strip()
    display_name = input("Display name (optional): ").strip() or None
    password = getpass.getpass("Password: ")
    confirm = getpass.getpass("Confirm password: ")
    if password != confirm or not password:
        print("Passwords did not match or were empty. Aborting.")
        sys.exit(1)

    user = User(
        username=username,
        password_hash=hash_password(password),
        display_name=display_name,
        is_admin=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    print(f"Created owner '{username}' (id={user.id}).")
    return user


def backfill_playlists(db, owner: User):
    unowned = db.query(Playlist).filter(Playlist.owner_id.is_(None)).all()
    for pl in unowned:
        pl.owner_id = owner.id
    db.commit()
    print(f"Assigned {len(unowned)} playlist(s) to '{owner.username}'.")


def main():
    Base.metadata.create_all(bind=engine)
    ensure_owner_id_column()

    db = SessionLocal()
    try:
        owner = get_or_create_owner(db)
        backfill_playlists(db, owner)
    finally:
        db.close()

    print("Migration complete.")


if __name__ == "__main__":
    main()
