"""Supabase Storage helpers.

Stub for M0. The real implementation in M2/M3 will provide async uploads
of generated images / final cuts, returning the storage path and a
signed URL for the Vercel app to render.
"""

from __future__ import annotations

from pathlib import Path


async def upload_to_supabase(bucket: str, path: str, local_file: Path) -> str:
    raise NotImplementedError("upload_to_supabase lands in M2/M3.")


async def get_supabase_signed_url(bucket: str, path: str, ttl_s: int = 3600) -> str:
    raise NotImplementedError("get_supabase_signed_url lands in M2/M3.")
