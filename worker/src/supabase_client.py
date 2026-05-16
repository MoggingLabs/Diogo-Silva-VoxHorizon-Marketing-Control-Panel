"""Cached service-role Supabase client.

Anything that needs to bypass RLS goes through `get_supabase_admin()`. The
public-anon client lives on the Next.js side — the worker never needs it.
"""

from __future__ import annotations

from functools import lru_cache

from supabase import Client, create_client

from .config import get_settings


@lru_cache(maxsize=1)
def get_supabase_admin() -> Client:
    """Return a singleton service-role Supabase client.

    Raises `RuntimeError` if either env var is missing — the worker can
    still boot without Supabase configured (health endpoint, broll local
    serving), but any caller that needs the admin client gets a loud
    failure.
    """
    settings = get_settings()
    if not settings.supabase_url or not settings.supabase_service_role_key:
        raise RuntimeError(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to use the admin client."
        )
    return create_client(settings.supabase_url, settings.supabase_service_role_key)
