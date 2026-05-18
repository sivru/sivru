import os

DEFAULT_LIMIT = 10


def fetch_user(user_id):
    """Fetch a user record by id."""
    return _db.get(user_id)


class UserCache:
    def __init__(self):
        self._store = {}

    def get(self, user_id):
        return self._store.get(user_id)


if __name__ == "__main__":
    fetch_user("1")
