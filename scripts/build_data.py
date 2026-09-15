from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import hmac
import json
import re
import secrets
import sqlite3
import tempfile
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


MANIFEST_PREFIX = "window.CARD_REWARD_ROUTE_MANIFEST="
SHARD_PREFIX = "window.CARD_REWARD_ROUTE_SHARD="
HEATMAP_PREFIX = "window.YOUBIKE_HEATMAP_DATA="
DAILY_PREFIX = "window.YOUBIKE_DAILY_V2="
IN_SCOPE_CITIES = {"台北市", "新北市"}


def normalize_card(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).strip().upper()
    return re.sub(r"[\s\-]+", "", text)


def normalize_city(value: Any) -> str:
    return unicodedata.normalize("NFKC", str(value or "")).strip().replace("臺", "台")


def display_name(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).strip()
    return re.sub(r"^YouBike2\.0[_\s]*", "", text, flags=re.I)


def normalize_name(value: Any) -> str:
    return re.sub(r"\s+", "", display_name(value).replace("臺", "台"))


def normalize_code(value: Any) -> str:
    text = str(value or "").strip()
    return text[:-2] if text.endswith(".0") and text[:-2].isdigit() else text


def parse_datetime(value: Any) -> dt.datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y/%m/%d %H:%M"):
        try:
            return dt.datetime.strptime(text, fmt)
        except ValueError:
            continue
    try:
        return dt.datetime.fromisoformat(text.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return None


def load_wrapped_json(path: Path, prefix: str) -> dict[str, Any]:
    raw = path.read_text(encoding="utf-8").strip()
    if not raw.startswith(prefix):
        raise RuntimeError(f"Unexpected data wrapper: {path}")
    body = raw[len(prefix) :]
    if body.endswith(";"):
        body = body[:-1]
    return json.loads(body)


def source_files(source_root: Path) -> list[Path]:
    directories = (
        source_root / "raw_2026-07",
        source_root / "raw_2026-08_09",
        source_root / "v3_2026-09-13" / "reward",
    )
    missing = [str(path) for path in directories if not path.exists()]
    if missing:
        raise RuntimeError("Missing reward directories: " + json.dumps(missing, ensure_ascii=False))
    unique: dict[str, Path] = {}
    for directory in directories:
        for path in sorted(directory.glob("*.csv")):
            unique[str(path.resolve()).lower()] = path
    return list(unique.values())


def date_catalog(heatmap_root: Path) -> tuple[list[list[str]], dict[str, int]]:
    output: list[list[str]] = []
    seen: set[str] = set()
    for month in ("2026-07", "2026-08", "2026-09"):
        payload = load_wrapped_json(heatmap_root / "dist" / "data" / f"daily-{month}.js", DAILY_PREFIX)
        for item in payload["dates"]:
            if item["date"] in seen:
                continue
            seen.add(item["date"])
            output.append([item["date"], item["weekday"], item["dayType"]])
    output.sort(key=lambda row: row[0])
    return output, {row[0]: index for index, row in enumerate(output)}


class StationCatalog:
    def __init__(self) -> None:
        self.records: list[list[Any]] = []
        self.by_code: dict[str, int] = {}
        self.month_aliases: dict[str, defaultdict[tuple[str, str], set[int]]] = defaultdict(lambda: defaultdict(set))
        self.global_aliases: defaultdict[tuple[str, str], set[int]] = defaultdict(set)
        self.name_aliases: defaultdict[str, set[int]] = defaultdict(set)
        self.dynamic: dict[tuple[str, str], int] = {}
        self.audit: Counter[str] = Counter()

    def _add_alias(self, month: str | None, city: str, name: Any, index: int) -> None:
        normalized = normalize_name(name)
        if not normalized:
            return
        key = (city, normalized)
        self.global_aliases[key].add(index)
        self.name_aliases[normalized].add(index)
        if month:
            self.month_aliases[month][key].add(index)

    def add_station(self, month: str, row: list[Any]) -> int:
        name = display_name(row[0] if len(row) > 0 else "")
        city = normalize_city(row[1] if len(row) > 1 else "")
        district = str(row[2] if len(row) > 2 else "").strip()
        latitude = float(row[3]) if len(row) > 3 and row[3] is not None else None
        longitude = float(row[4]) if len(row) > 4 and row[4] is not None else None
        code = normalize_code(row[5] if len(row) > 5 else "")
        index = self.by_code.get(code) if code else None
        if index is None:
            index = len(self.records)
            self.records.append([name, city, district, latitude, longitude, code])
            if code:
                self.by_code[code] = index
        self._add_alias(month, city, name, index)
        return index

    def load(self, heatmap_root: Path, station_metadata: Path) -> None:
        payloads = {
            "2026-07": heatmap_root / "dist" / "data.js",
            "2026-08": heatmap_root / "dist" / "data" / "heatmap-2026-08.js",
            "2026-09": heatmap_root / "dist" / "data" / "heatmap-2026-09.js",
        }
        for month, path in payloads.items():
            payload = load_wrapped_json(path, HEATMAP_PREFIX)
            for row in payload["stations"]:
                self.add_station(month, row)

        metadata = json.loads(station_metadata.read_text(encoding="utf-8"))
        for item in metadata.get("stations", []):
            code = normalize_code(item.get("stationId"))
            target = self.by_code.get(code)
            if target is None:
                continue
            city = normalize_city(item.get("city"))
            for name in [item.get("stationName"), *(item.get("aliases") or [])]:
                for month in payloads:
                    self._add_alias(month, city, name, target)

    def resolve(self, month: str, city_value: Any, name_value: Any) -> int:
        city = normalize_city(city_value)
        normalized = normalize_name(name_value)
        key = (city, normalized)
        candidates = self.month_aliases.get(month, {}).get(key, set())
        if not candidates:
            candidates = self.global_aliases.get(key, set())
        if not candidates and normalized:
            name_candidates = self.name_aliases.get(normalized, set())
            if len(name_candidates) == 1:
                candidates = name_candidates
        if candidates:
            if len(candidates) > 1:
                self.audit["ambiguousStationMatches"] += 1
            return min(candidates)
        dynamic_key = (city, normalized)
        existing = self.dynamic.get(dynamic_key)
        if existing is not None:
            return existing
        index = len(self.records)
        self.records.append([display_name(name_value) or "未辨識場站", city or "未辨識縣市", "", None, None, ""])
        self.dynamic[dynamic_key] = index
        self.audit["unmatchedStations"] += 1
        return index


def load_or_create_key(path: Path) -> bytes:
    if path.exists():
        value = path.read_text(encoding="ascii").strip()
        if not re.fullmatch(r"[0-9a-f]{64}", value):
            raise RuntimeError("Invalid local anonymization key")
        return bytes.fromhex(value)
    value = secrets.token_bytes(32)
    path.write_text(value.hex() + "\n", encoding="ascii")
    return value


def anonymous_id(secret: bytes, card: str) -> str:
    return hmac.new(secret, card.encode("utf-8"), hashlib.sha256).hexdigest()[:24]


ORDER_UPSERT = """
INSERT INTO orders (
  order_id, account, card, category,
  borrow_time, borrow_city, borrow_station,
  return_time, return_city, return_station
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(order_id) DO UPDATE SET
  account = CASE WHEN orders.account = '' THEN excluded.account ELSE orders.account END,
  card = CASE WHEN orders.card = '' THEN excluded.card ELSE orders.card END,
  category = CASE
    WHEN orders.category = '' THEN excluded.category
    WHEN excluded.category = '' OR instr(orders.category, excluded.category) > 0 THEN orders.category
    ELSE orders.category || ' ' || excluded.category
  END,
  borrow_time = CASE WHEN orders.borrow_time = '' THEN excluded.borrow_time ELSE orders.borrow_time END,
  borrow_city = CASE WHEN orders.borrow_city = '' THEN excluded.borrow_city ELSE orders.borrow_city END,
  borrow_station = CASE WHEN orders.borrow_station = '' THEN excluded.borrow_station ELSE orders.borrow_station END,
  return_time = CASE WHEN orders.return_time = '' THEN excluded.return_time ELSE orders.return_time END,
  return_city = CASE WHEN orders.return_city = '' THEN excluded.return_city ELSE orders.return_city END,
  return_station = CASE WHEN orders.return_station = '' THEN excluded.return_station ELSE orders.return_station END
"""


ROUTE_UPSERT = """
INSERT INTO routes (card_id, date_index, origin_index, destination_index, full_count, empty_count)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(card_id, date_index, origin_index, destination_index) DO UPDATE SET
  full_count = routes.full_count + excluded.full_count,
  empty_count = routes.empty_count + excluded.empty_count
"""


def load_orders(connection: sqlite3.Connection, files: list[Path]) -> dict[str, Any]:
    fields = (
        "訂單號", "帳號", "外觀卡號", "分類",
        "借車時間", "借車縣市", "借車場站",
        "還車時間", "還車縣市", "還車場站",
    )
    source_rows = 0
    loaded_files = 0
    cursor = connection.cursor()
    for path in files:
        batch: list[tuple[str, ...]] = []
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if not set(fields).issubset(reader.fieldnames or []):
                continue
            loaded_files += 1
            for row in reader:
                source_rows += 1
                order_id = str(row.get("訂單號") or "").strip()
                if not order_id:
                    continue
                batch.append((
                    order_id,
                    str(row.get("帳號") or "").strip(),
                    normalize_card(row.get("外觀卡號")),
                    str(row.get("分類") or "").strip(),
                    str(row.get("借車時間") or "").strip(),
                    normalize_city(row.get("借車縣市")),
                    str(row.get("借車場站") or "").strip(),
                    str(row.get("還車時間") or "").strip(),
                    normalize_city(row.get("還車縣市")),
                    str(row.get("還車場站") or "").strip(),
                ))
                if len(batch) >= 5000:
                    cursor.executemany(ORDER_UPSERT, batch)
                    batch.clear()
            if batch:
                cursor.executemany(ORDER_UPSERT, batch)
            connection.commit()
    unique_orders = int(connection.execute("SELECT COUNT(*) FROM orders").fetchone()[0])
    return {
        "fileCount": loaded_files,
        "sourceRows": source_rows,
        "uniqueOrders": unique_orders,
        "duplicateRows": source_rows - unique_orders,
    }


def aggregate_routes(
    connection: sqlite3.Connection,
    dates: dict[str, int],
    stations: StationCatalog,
    secret: bytes,
) -> dict[str, int]:
    audit: Counter[str] = Counter()
    card_batch: list[tuple[str, str, str]] = []
    route_batch: list[tuple[str, int, int, int, int, int]] = []
    select = connection.execute(
        "SELECT account, card, category, borrow_time, borrow_city, borrow_station, return_time, return_city, return_station FROM orders"
    )

    def flush() -> None:
        if card_batch:
            connection.executemany("INSERT OR IGNORE INTO cards (full_card, card_id, suffix) VALUES (?, ?, ?)", card_batch)
            card_batch.clear()
        if route_batch:
            connection.executemany(ROUTE_UPSERT, route_batch)
            route_batch.clear()
        connection.commit()

    for row in select:
        account, card, category, borrow_text, borrow_city, borrow_station, return_text, return_city, return_station = row
        if not str(account).startswith("09"):
            audit["excludedNonMobileOrders"] += 1
            continue
        if len(card) < 5:
            audit["excludedMissingOrShortCard"] += 1
            continue
        reward_by_date: defaultdict[str, list[int]] = defaultdict(lambda: [0, 0])
        if "滿借" in category:
            timestamp = parse_datetime(borrow_text)
            if timestamp and borrow_city in IN_SCOPE_CITIES and timestamp.date().isoformat() in dates:
                reward_by_date[timestamp.date().isoformat()][0] = 1
                audit["includedFull"] += 1
            elif not timestamp:
                audit["badBorrowTime"] += 1
        if "空還" in category:
            timestamp = parse_datetime(return_text)
            if timestamp and return_city in IN_SCOPE_CITIES and timestamp.date().isoformat() in dates:
                reward_by_date[timestamp.date().isoformat()][1] = 1
                audit["includedEmpty"] += 1
            elif not timestamp:
                audit["badReturnTime"] += 1
        if not reward_by_date:
            continue
        card_id = anonymous_id(secret, card)
        card_batch.append((card, card_id, card[-5:]))
        for date_text, (full_count, empty_count) in reward_by_date.items():
            month = date_text[:7]
            origin = stations.resolve(month, borrow_city, borrow_station)
            destination = stations.resolve(month, return_city, return_station)
            route_batch.append((card_id, dates[date_text], origin, destination, full_count, empty_count))
        if len(route_batch) >= 8000:
            flush()
    flush()
    audit["cardCount"] = int(connection.execute("SELECT COUNT(*) FROM cards").fetchone()[0])
    audit["routeDayRows"] = int(connection.execute("SELECT COUNT(*) FROM routes").fetchone()[0])
    return dict(audit)


def serialize(
    connection: sqlite3.Connection,
    output_dir: Path,
    date_rows: list[list[str]],
    stations: StationCatalog,
    audit: dict[str, Any],
) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    for old in output_dir.glob("routes-[0-9a-f][0-9a-f].js"):
        old.unlink()

    cards = []
    for row in connection.execute(
        """
        SELECT c.card_id, c.suffix,
               SUM(r.full_count) AS full_total,
               SUM(r.empty_count) AS empty_total,
               COUNT(DISTINCT r.date_index) AS active_days,
               COUNT(DISTINCT CAST(r.origin_index AS TEXT) || ':' || CAST(r.destination_index AS TEXT)) AS route_count
        FROM cards c
        JOIN routes r ON r.card_id = c.card_id
        GROUP BY c.card_id, c.suffix
        ORDER BY (SUM(r.full_count) + SUM(r.empty_count)) DESC, c.suffix, c.card_id
        """
    ):
        cards.append([row[0], row[1], int(row[2]), int(row[3]), int(row[4]), int(row[5])])

    connection.execute("CREATE INDEX IF NOT EXISTS routes_card_id ON routes(card_id)")
    shards = sorted({row[0][:2] for row in cards})
    route_record_count = 0
    for shard in shards:
        grouped: dict[str, list[list[int]]] = {}
        for card_id, date_index, origin_index, destination_index, full_count, empty_count in connection.execute(
            """
            SELECT card_id, date_index, origin_index, destination_index, full_count, empty_count
            FROM routes
            WHERE card_id >= ? AND card_id < ?
            ORDER BY card_id, date_index, origin_index, destination_index
            """,
            (shard, shard + "g"),
        ):
            grouped.setdefault(card_id, []).append([
                int(date_index), int(origin_index), int(destination_index), int(full_count), int(empty_count)
            ])
            route_record_count += 1
        payload = {"version": "v1", "shard": shard, "cards": grouped}
        (output_dir / f"routes-{shard}.js").write_text(
            SHARD_PREFIX + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";",
            encoding="utf-8",
        )

    meta = {
        "periodStart": date_rows[0][0],
        "periodEnd": date_rows[-1][0],
        "excludedDates": ["2026-07-10", "2026-07-11"],
        "cardCount": len(cards),
        "stationCount": len(stations.records),
        "routeDayRows": route_record_count,
        "shardCount": len(shards),
        "privacy": "Website data contains only card suffixes, keyed anonymous IDs and reward-route aggregates. Full cards, accounts and order IDs are excluded.",
    }
    manifest = {
        "version": "v1",
        "dates": date_rows,
        "stations": stations.records,
        "cards": cards,
        "shards": shards,
        "meta": meta,
    }
    (output_dir / "manifest.js").write_text(
        MANIFEST_PREFIX + json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) + ";",
        encoding="utf-8",
    )
    return {"meta": meta, "aggregation": audit, "stationAudit": dict(stations.audit)}


def main() -> None:
    project_root = Path(__file__).resolve().parents[1]
    workspace = project_root.parent
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", type=Path, default=Path.home() / "Documents" / "暫停營運測試" / "cps_reward_log")
    parser.add_argument("--heatmap-root", type=Path, default=workspace / "youbike-friendly-relay-heatmap-v2")
    parser.add_argument(
        "--station-metadata",
        type=Path,
        default=workspace / "outputs" / "01a057bd-84e6-7bd3-995f-1d34ab3e518e" / "hourly_metrics_data" / "stations.json",
    )
    parser.add_argument("--output-dir", type=Path, default=project_root / "dist" / "data")
    parser.add_argument("--key-file", type=Path, default=project_root / ".card-map-key")
    parser.add_argument("--summary", type=Path, default=project_root / "build-audit.json")
    args = parser.parse_args()

    required = [args.heatmap_root, args.station_metadata]
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise RuntimeError("Missing required inputs: " + json.dumps(missing, ensure_ascii=False))

    date_rows, dates = date_catalog(args.heatmap_root)
    stations = StationCatalog()
    stations.load(args.heatmap_root, args.station_metadata)
    secret = load_or_create_key(args.key_file)

    with tempfile.TemporaryDirectory(prefix="youbike-card-routes-") as temp_dir:
        database = Path(temp_dir) / "build.sqlite"
        connection = sqlite3.connect(database)
        connection.executescript(
            """
            PRAGMA journal_mode=OFF;
            PRAGMA synchronous=OFF;
            PRAGMA temp_store=MEMORY;
            CREATE TABLE orders (
              order_id TEXT PRIMARY KEY,
              account TEXT NOT NULL,
              card TEXT NOT NULL,
              category TEXT NOT NULL,
              borrow_time TEXT NOT NULL,
              borrow_city TEXT NOT NULL,
              borrow_station TEXT NOT NULL,
              return_time TEXT NOT NULL,
              return_city TEXT NOT NULL,
              return_station TEXT NOT NULL
            ) WITHOUT ROWID;
            CREATE TABLE cards (
              full_card TEXT PRIMARY KEY,
              card_id TEXT NOT NULL UNIQUE,
              suffix TEXT NOT NULL
            ) WITHOUT ROWID;
            CREATE TABLE routes (
              card_id TEXT NOT NULL,
              date_index INTEGER NOT NULL,
              origin_index INTEGER NOT NULL,
              destination_index INTEGER NOT NULL,
              full_count INTEGER NOT NULL,
              empty_count INTEGER NOT NULL,
              PRIMARY KEY (card_id, date_index, origin_index, destination_index)
            ) WITHOUT ROWID;
            """
        )
        source_audit = load_orders(connection, source_files(args.source_root))
        aggregation_audit = aggregate_routes(connection, dates, stations, secret)
        summary = serialize(
            connection,
            args.output_dir,
            date_rows,
            stations,
            {"source": source_audit, "counts": aggregation_audit},
        )
        connection.close()

    summary["generatedAt"] = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    args.summary.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
