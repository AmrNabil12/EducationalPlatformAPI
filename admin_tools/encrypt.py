import argparse
import base64
import binascii
import json
import math
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi", ".m4v", ".webm"}
DEFAULT_PAGE_SIZE_MB = 1
PAGED_MAGIC = b"EDUPG001"
PAGE_NONCE_SIZE = 12
PAGE_TAG_SIZE = 16


def b64e(data: bytes) -> str:
    return base64.b64encode(data).decode("utf-8")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def infer_month(video_path: Path, default_month: str) -> str:
    for part in reversed(video_path.parts):
        if re.fullmatch(r"M(1[0-2]|[1-9])", part, flags=re.IGNORECASE):
            return part.upper()

    match = re.search(r"\bM(1[0-2]|[1-9])\b", video_path.stem, flags=re.IGNORECASE)
    if match:
        return f"M{match.group(1)}"

    return default_month


def infer_session_folder(video_path: Path, default_session: str = "S1") -> str:
    for part in reversed(video_path.parts):
        if re.fullmatch(r"S([1-5])", part, flags=re.IGNORECASE):
            return part.upper()

    match = re.search(r"\bS([1-5])\b", video_path.stem, flags=re.IGNORECASE)
    if match:
        return f"S{match.group(1)}"

    return default_session.upper()


def relative_from_cwd(target_path: Path) -> str:
    return os.path.relpath(str(target_path), start=str(Path.cwd())).replace("\\", "/")


def encrypted_name_for(video_path: Path) -> str:
    # Keep the original input filename and append .enc
    # e.g. "lesson.mp4" -> "lesson.mp4.enc"
    return f"{video_path.name}.enc"


def encrypted_chunk_name_for(video_id: str, index: int) -> str:
    return f"{video_id}.part{index:05d}.enc"


def aad_for_page(index: int) -> bytes:
    return index.to_bytes(4, "big", signed=False)


def read_env_value(env_path: Path, key: str) -> str | None:
    if not env_path.exists():
        return None

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):]
        if "=" not in line:
            continue

        env_key, env_value = line.split("=", 1)
        if env_key.strip() != key:
            continue

        value = env_value.strip()
        if len(value) >= 2 and ((value[0] == '"' and value[-1] == '"') or (value[0] == "'" and value[-1] == "'")):
            value = value[1:-1]
        return value

    return None


def load_master_key_b64() -> str | None:
    from_env = os.getenv("MASTER_KEY_B64")
    if from_env and from_env.strip():
        return from_env.strip()

    backend_env = (Path.cwd() / "backend" / ".env").resolve()
    from_backend_env = read_env_value(backend_env, "MASTER_KEY_B64")
    if from_backend_env and from_backend_env.strip():
        return from_backend_env.strip()

    return None


def encrypt_file(input_path: Path, output_dir: Path, video_id: str, master_key: bytes, page_size_bytes: int):
    clear_data = input_path.read_bytes()

    data_key = os.urandom(32)
    wrap_nonce = os.urandom(12)
    wrapped_key = AESGCM(master_key).encrypt(wrap_nonce, data_key, None)

    page_size_bytes = max(64 * 1024, page_size_bytes)
    page_count = max(1, math.ceil(len(clear_data) / page_size_bytes))
    output_path = output_dir / encrypted_name_for(input_path)

    with output_path.open("wb") as handle:
        handle.write(PAGED_MAGIC)
        handle.write(page_size_bytes.to_bytes(4, "big", signed=False))
        handle.write(page_count.to_bytes(4, "big", signed=False))
        handle.write(len(clear_data).to_bytes(8, "big", signed=False))

        aesgcm = AESGCM(data_key)
        for index in range(page_count):
            start = index * page_size_bytes
            clear_page = clear_data[start:start + page_size_bytes]
            if len(clear_page) < page_size_bytes:
                clear_page = clear_page + (b"\x00" * (page_size_bytes - len(clear_page)))

            page_nonce = os.urandom(PAGE_NONCE_SIZE)
            encrypted_page = aesgcm.encrypt(page_nonce, clear_page, aad_for_page(index))
            expected_len = page_size_bytes + PAGE_TAG_SIZE
            if len(encrypted_page) != expected_len:
                raise RuntimeError(
                    f"Unexpected paged ciphertext length for page {index}: {len(encrypted_page)} != {expected_len}"
                )

            handle.write(page_nonce)
            handle.write(encrypted_page)

    return {
        "mode": "paged",
        "videoNonceB64": "",
        "keyWrapNonceB64": b64e(wrap_nonce),
        "wrappedDataKeyB64": b64e(wrapped_key),
        "relativePath": relative_from_cwd(output_path),
        "totalPlainSize": len(clear_data),
        "pageSize": page_size_bytes,
        "pageCount": page_count,
    }


def main():
    parser = argparse.ArgumentParser(
        description="Encrypt local videos (AES-256-GCM), store encrypted files in ./encrypted, and generate catalog metadata."
    )
    parser.add_argument("--videos-dir", required=True, help="Directory containing clear videos.")
    parser.add_argument("--catalog", required=True, help="Catalog output JSON path.")
    parser.add_argument("--default-month", default="M1", help="Fallback month when not inferred (default: M1).")
    parser.add_argument(
        "--page-size-mb",
        type=int,
        default=DEFAULT_PAGE_SIZE_MB,
        help=f"Page size in MB for the single-file random-access encrypted container (default: {DEFAULT_PAGE_SIZE_MB}).",
    )
    parser.add_argument(
        "--chunk-size-mb",
        type=int,
        default=None,
        help=argparse.SUPPRESS,
    )

    args = parser.parse_args()

    videos_dir = Path(args.videos_dir).resolve()
    output_dir = (Path.cwd() / "encrypted").resolve()
    catalog_path = Path(args.catalog).resolve()

    if not videos_dir.exists() or not videos_dir.is_dir():
        raise SystemExit(f"videos-dir not found or not a directory: {videos_dir}")

    master_key_b64 = load_master_key_b64()
    if not master_key_b64:
        raise SystemExit(
            "Missing MASTER_KEY_B64. Set it in shell environment or in backend/.env."
        )

    try:
        master_key = base64.b64decode(master_key_b64, validate=True)
    except binascii.Error:
        raise SystemExit("MASTER_KEY_B64 is not valid base64.")

    if len(master_key) != 32:
        raise SystemExit("MASTER_KEY_B64 must decode to exactly 32 bytes.")

    output_dir.mkdir(parents=True, exist_ok=True)
    catalog_path.parent.mkdir(parents=True, exist_ok=True)
    selected_page_size_mb = args.page_size_mb
    if args.chunk_size_mb is not None:
        selected_page_size_mb = args.chunk_size_mb
    page_size_bytes = max(1, selected_page_size_mb) * 1024 * 1024

    video_paths = sorted(
        p for p in videos_dir.rglob("*") if p.is_file() and p.suffix.lower() in VIDEO_EXTENSIONS
    )

    if not video_paths:
        print(f"No videos found in {videos_dir}")
        catalog_path.write_text(json.dumps({"generatedAt": utc_now(), "videos": []}, indent=2), encoding="utf-8")
        return

    records = []
    for video_path in video_paths:
        rel = video_path.relative_to(videos_dir)
        month = infer_month(rel, args.default_month.upper())
        session_folder = infer_session_folder(rel)

        video_id = str(uuid.uuid4())
        record_output_dir = output_dir / month / session_folder
        record_output_dir.mkdir(parents=True, exist_ok=True)
        meta = encrypt_file(video_path, record_output_dir, video_id, master_key, page_size_bytes)

        storage = {
            "mode": "paged",
            "relativePath": meta["relativePath"],
            "totalPlainSize": meta["totalPlainSize"],
            "pageSize": meta["pageSize"],
            "pageCount": meta["pageCount"],
        }

        record = {
            "id": video_id,
            "title": video_path.stem.replace("_", " "),
            "month": month,
            "sourceFile": str(rel).replace("\\", "/"),
            "durationSec": None,
            "encryption": {
                "algorithm": "AES-256-GCM",
                "nonceB64": meta["videoNonceB64"],
                "keyWrap": {
                    "algorithm": "AES-256-GCM",
                    "nonceB64": meta["keyWrapNonceB64"],
                    "wrappedKeyB64": meta["wrappedDataKeyB64"],
                },
            },
            "storage": storage,
            "createdAt": utc_now(),
        }
        records.append(record)
        print(
            f"Encrypted {rel} -> {encrypted_name_for(video_path)} "
            f"({month}, {meta['pageCount']} page(s), pageSize={meta['pageSize']})"
        )

    catalog = {"generatedAt": utc_now(), "videos": records}
    catalog_path.write_text(json.dumps(catalog, indent=2), encoding="utf-8")
    print(f"Catalog updated: {catalog_path}")


if __name__ == "__main__":
    main()
