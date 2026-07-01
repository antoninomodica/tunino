#!/usr/bin/env python3
"""Create a Tunino user account. Run directly on the server: python3 scripts/create_user.py"""
import argparse
import getpass
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.auth import hash_password
from app.database import SessionLocal
from app.models import User


def main():
    parser = argparse.ArgumentParser(description="Create a Tunino user account")
    parser.add_argument("username")
    parser.add_argument("--display-name", default=None)
    parser.add_argument("--admin", action="store_true")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        if db.query(User).filter(User.username == args.username).first():
            print(f"User '{args.username}' already exists.")
            return

        password = getpass.getpass("Password: ")
        confirm = getpass.getpass("Confirm password: ")
        if password != confirm:
            print("Passwords do not match.")
            return
        if not password:
            print("Password cannot be empty.")
            return

        user = User(
            username=args.username,
            password_hash=hash_password(password),
            display_name=args.display_name,
            is_admin=args.admin,
        )
        db.add(user)
        db.commit()
        print(f"Created user '{args.username}' (id={user.id}).")
    finally:
        db.close()


if __name__ == "__main__":
    main()
