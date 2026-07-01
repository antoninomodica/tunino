import hashlib
import hmac
import secrets
from datetime import datetime, timedelta

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session as DBSession

from .database import get_db
from .models import Session as SessionModel, User

SESSION_COOKIE_NAME = "tunino_session"
SESSION_TTL = timedelta(days=30)

_PBKDF2_ITERATIONS = 260_000
_PBKDF2_ALGO = "pbkdf2_sha256"


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), _PBKDF2_ITERATIONS)
    return f"{_PBKDF2_ALGO}${_PBKDF2_ITERATIONS}${salt}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algo, iterations, salt, hash_hex = encoded.split("$")
        if algo != _PBKDF2_ALGO:
            return False
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iterations))
        return hmac.compare_digest(digest.hex(), hash_hex)
    except (ValueError, AttributeError):
        return False


def create_session(db: DBSession, user: User) -> str:
    token = secrets.token_urlsafe(32)
    db.add(SessionModel(token=token, user_id=user.id, expires_at=datetime.utcnow() + SESSION_TTL))
    db.commit()
    return token


def delete_session(db: DBSession, token: str) -> None:
    db.query(SessionModel).filter(SessionModel.token == token).delete()
    db.commit()


def get_current_user(request: Request, db: DBSession = Depends(get_db)) -> User:
    token = request.cookies.get(SESSION_COOKIE_NAME)
    if not token:
        raise HTTPException(401, "Not authenticated")

    session = db.get(SessionModel, token)
    if not session or session.expires_at < datetime.utcnow():
        raise HTTPException(401, "Not authenticated")

    session.expires_at = datetime.utcnow() + SESSION_TTL
    db.commit()
    return session.user
